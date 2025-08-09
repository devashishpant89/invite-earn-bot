require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');

// ─── Discord client ────────────────────────────────────────────────────────────
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

// ─── Models, cache & helpers ───────────────────────────────────────────────────
const User = require('./models/User');
const invites = new Map();

client.config = config;
client.commands = new Collection();

// ─── Load slash / context commands ─────────────────────────────────────────────
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const cmd = require(path.join(commandsPath, file));
  if (cmd.data) client.commands.set(cmd.data.name, cmd);
}

// ─── Get token & Mongo URI from ENV or fallback to config.json ─────────────────
const token = process.env.BOT_TOKEN || config.token;
const mongoUri = process.env.MONGO_URI || config.mongoUri;

// ─── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('Connected to MongoDB'))
  .catch(console.error);

// ─── Ready: cache invites ──────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // cache all invites as Map<code, uses>
  client.inviteCache = new Map();
  for (const g of client.guilds.cache.values()) {
    const allInv = await g.invites.fetch().catch(() => null);
    if (allInv)
      client.inviteCache.set(g.id, new Map(allInv.map(i => [i.code, i.uses])));
  }
  console.log('Invite cache primed.');
});

// ─── Track invite usage on member join ─────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  try {
    const cached = client.inviteCache.get(member.guild.id) || new Map();
    const newState = await member.guild.invites.fetch();
    const used = newState.find(i => (cached.get(i.code) || 0) < i.uses);

    // refresh cache
    client.inviteCache.set(member.guild.id, new Map(newState.map(i => [i.code, i.uses])));

    if (!used?.inviter) return;

    const inviterId = used.inviter.id;
    const doc = await User.findOneAndUpdate(
      { userId: inviterId },
      {
        $inc: { invites: 1 },
        $set: { username: used.inviter.tag }
      },
      { upsert: true, new: true }
    );

    if (doc) {
      doc.calculateTotalEarnings();
      await doc.save();
    }
    console.log(`+1 invite for ${used.inviter.tag}`);
  } catch (e) { console.error('Invite track error:', e); }
});

// ─── Remove user data on member leave ──────────────────────────────────────────
client.on('guildMemberRemove', async member => {
  try {
    const res = await User.deleteOne({ userId: member.id });
    if (res.deletedCount > 0) {
      console.log(`Removed data for ${member.user.tag} from the database (left server).`);
    }
  } catch (e) {
    console.error('Error removing user data on leave:', e);
  }
});

// ─── Interaction handler ───────────────────────────────────────────────────────
client.on('interactionCreate', async int => {
  if (int.isChatInputCommand()) {
    const cmd = client.commands.get(int.commandName);
    if (!cmd) return;
    try { await cmd.execute(int); }
    catch (e) {
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

// ─── Login ─────────────────────────────────────────────────────────────────────
client.login(token);
