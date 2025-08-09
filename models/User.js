require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const User = require('./models/User'); // ← your posted user.js

// ─── Discord Client ─────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

client.config = config;
client.commands = new Collection();

// ─── Load Commands ─────────────────────────────────────────────
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const cmd = require(path.join(commandsPath, file));
  if (cmd.data) client.commands.set(cmd.data.name, cmd);
}

// ─── ENV vars or config fallback ───────────────────────────────
const token = process.env.BOT_TOKEN || config.token;
const mongoUri = process.env.MONGO_URI || config.mongoUri;

// ─── Connect MongoDB ───────────────────────────────────────────
mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('Connected to MongoDB'))
  .catch(console.error);

// ─── Bot Ready Event ───────────────────────────────────────────
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.inviteCache = new Map();
  for (const g of client.guilds.cache.values()) {
    const allInv = await g.invites.fetch().catch(() => null);
    if (allInv)
      client.inviteCache.set(g.id, new Map(allInv.map(i => [i.code, i.uses])));
  }
  console.log('Invite cache primed.');
});

// ─── Member Join Event ─────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  try {
    // Get used invite
    const cached = client.inviteCache.get(member.guild.id) || new Map();
    const newState = await member.guild.invites.fetch();
    const used = newState.find(i => (cached.get(i.code) || 0) < i.uses);

    // Refresh cache
    client.inviteCache.set(member.guild.id, new Map(newState.map(i => [i.code, i.uses])));

    if (!used?.inviter) return;

    const inviterId = used.inviter.id;

    // Save invited member record (so we know who invited them later)
    await User.findOneAndUpdate(
      { userId: member.id },
      { userId: member.id, inviterId, bonus: 0 }, 
      { upsert: true }
    );

    // Increment inviter's invites & recalc earnings
    const inviterDoc = await User.findOneAndUpdate(
      { userId: inviterId },
      { $inc: { invites: 1 } },
      { upsert: true, new: true }
    );

    if (inviterDoc) {
      inviterDoc.totalEarnings = inviterDoc.calculateTotalEarnings();
      await inviterDoc.save();
    }

    console.log(`+1 invite for ${used.inviter.tag} (invited ${member.user.tag})`);
  } catch (err) {
    console.error('Invite track error:', err);
  }
});

// ─── Member Leave Event ────────────────────────────────────────
client.on('guildMemberRemove', async member => {
  try {
    const leavingUser = await User.findOne({ userId: member.id });
    if (!leavingUser) return;

    const inviterId = leavingUser.inviterId;
    if (inviterId) {
      const inviterDoc = await User.findOneAndUpdate(
        { userId: inviterId },
        { $inc: { invites: -1 } },
        { new: true }
      );

      if (inviterDoc) {
        inviterDoc.totalEarnings = inviterDoc.calculateTotalEarnings();
        await inviterDoc.save();
        console.log(`-1 invite (-$0.50) for inviter ${inviterDoc.userId} due to ${member.user.tag} leaving`);
      }
    }

    await User.deleteOne({ userId: member.id });
    console.log(`Removed ${member.user.tag} from DB.`);
  } catch (err) {
    console.error('Error handling member leave:', err);
  }
});

// ─── Interaction Handler ───────────────────────────────────────
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

// ─── Login ─────────────────────────────────────────────────────
client.login(token);
