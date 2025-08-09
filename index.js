require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const User = require('./models/User');

const token = config.token || process.env.TOKEN;
const mongoUri = config.mongoUri || process.env.MONGO_URI;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Load commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
fs.readdirSync(commandsPath).forEach(file => {
  if (file.endsWith('.js')) {
    const command = require(path.join(commandsPath, file));
    if (command.data) {
      client.commands.set(command.data.name, command);
    }
  }
});

// Connect DB
mongoose.connect(mongoUri)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB Error:', err));

// Invite cache
client.inviteCache = new Map();

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  for (const g of client.guilds.cache.values()) {
    const allInv = await g.invites.fetch().catch(() => null);
    if (allInv) {
      client.inviteCache.set(g.id, new Map(allInv.map(i => [i.code, i.uses])));
    }
  }
  console.log('Invite cache primed.');
});


// ─── Track member join ─────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  try {
    const cached = client.inviteCache.get(member.guild.id) || new Map();
    const newState = await member.guild.invites.fetch();
    const used = newState.find(i => (cached.get(i.code) || 0) < i.uses);

    // refresh cache
    client.inviteCache.set(member.guild.id, new Map(newState.map(i => [i.code, i.uses])));

    if (!used?.inviter) return;
    const inviterId = used.inviter.id;

    // Update inviter's stats
    const inviterDoc = await User.findOneAndUpdate(
      { userId: inviterId },
      {
        $inc: { invites: 1 },
        $set: { username: used.inviter.tag }
      },
      { upsert: true, new: true }
    );

    // Store inviter info for the new member
    await User.findOneAndUpdate(
      { userId: member.id },
      { $set: { invitedBy: inviterId } },
      { upsert: true }
    );

    if (inviterDoc) {
      inviterDoc.calculateTotalEarnings();
      await inviterDoc.save();
      console.log(`+1 invite for ${used.inviter.tag}`);
    }
  } catch (e) {
    console.error('Invite track error (join):', e);
  }
});


// ─── Track member leave ─────────────────────────────────────────
client.on('guildMemberRemove', async member => {
  try {
    // Get the leaving member's data
    const leftUser = await User.findOne({ userId: member.id });
    if (!leftUser || !leftUser.invitedBy) return;

    // Get inviter's data
    const inviterData = await User.findOne({ userId: leftUser.invitedBy });
    if (!inviterData) return;

    inviterData.invites = Math.max(inviterData.invites - 1, 0);
    inviterData.calculateTotalEarnings();
    await inviterData.save();

    console.log(`-1 invite for inviter ${inviterData.userId} (member left)`);
  } catch (e) {
    console.error('Error handling member leave:', e);
  }
});


// ─── Interaction handler ───────────────────────────────────────
client.on('interactionCreate', async int => {
  if (int.isChatInputCommand()) {
    const cmd = client.commands.get(int.commandName);
    if (!cmd) return;
    try {
      await cmd.execute(int);
    } catch (e) {
      console.error(e);
      await int.reply({ content: 'Command error.', ephemeral: true });
    }
  } else if (int.isButton()) {
    try {
      const referral = require('./commands/referral');
      await referral.execute(int, client);
    } catch (e) {
      console.error(e);
      if (!int.replied) await int.reply({ content: 'Button error.', ephemeral: true });
    }
  }
});

client.login(token);
