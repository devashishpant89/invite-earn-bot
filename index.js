require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

// ---- Discord Client ----
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

// Invite cache & DB model
const invites = new Map();
const User = require('./models/User');

// Attach config & commands to client
client.config = config;
client.commands = new Collection();

// ---- Load Commands ----
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if (command.data) {
    client.commands.set(command.data.name, command);
  }
}

// ---- Connect MongoDB ----
mongoose.connect(config.mongoUri)
  .then(() => console.log('Connected to MongoDB'))
  .catch(console.error);

// ---- On Ready ----
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Cache invites per guild as Map<code, uses>
  client.inviteCache = new Map();
  for (const guild of client.guilds.cache.values()) {
    try {
      const guildInvites = await guild.invites.fetch();
      client.inviteCache.set(guild.id, new Map(guildInvites.map(inv => [inv.code, inv.uses])));
    } catch (err) {
      console.error(`Could not fetch invites for guild ${guild.name}:`, err);
    }
  }
  console.log('Initial invites cached.');

  // --- Referral Panel Setup ---
  const referralChannel = client.channels.cache.get(config.channels.referralPanel);
  if (referralChannel) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
    let fetched = await referralChannel.messages.fetch({ limit: 10 });
    let botMessage = fetched.find(m => m.author.id === client.user.id && m.embeds.length > 0);

    const referralEmbed = new EmbedBuilder()
      .setTitle('Referral Panel')
      .setDescription('Use the buttons below to get your invite link or view your referrals.')
      .setColor('Blue');

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('invite_link').setLabel('🎟️ Invite Link').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('referrals').setLabel('📊 Referrals').setStyle(ButtonStyle.Secondary)
    );

    if (!botMessage) {
      await referralChannel.send({ embeds: [referralEmbed], components: [buttons] });
    } else {
      await botMessage.edit({ embeds: [referralEmbed], components: [buttons] });
    }
  }

  // --- Leaderboard Panel Setup ---
  const leaderboardChannel = client.channels.cache.get(config.channels.leaderboard);
  if (leaderboardChannel) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
    let fetched = await leaderboardChannel.messages.fetch({ limit: 10 });
    let boardMessage = fetched.find(m => m.author.id === client.user.id && m.embeds.length > 0);

    const users = await User.find({}).sort({ invites: -1 });
    users.forEach(u => u.totalEarnings = u.invites * 0.5 + u.bonus);

    async function createLeaderboardEmbed(users, page = 1) {
      const ITEMS_PER_PAGE = 10;
      const totalPages = Math.max(1, Math.ceil(users.length / ITEMS_PER_PAGE));
      const start = (page - 1) * ITEMS_PER_PAGE;
      const end = start + ITEMS_PER_PAGE;
      const pageUsers = users.slice(start, end);

      const medals = ['🥇', '🥈', '🥉'];
      let description = '';

      for (let index = 0; index < pageUsers.length; index++) {
        const userData = pageUsers[index];
        const rank = start + index + 1;
        const medal = medals[index] || `${rank}.`;

        // Fetch username from API or fallback to stored
        const fetchedUser = await client.users.fetch(userData.userId).catch(() => null);
        const username = fetchedUser ? fetchedUser.tag : (userData.username || 'Unknown#0000');

        description += `${medal} ${username}\nInvites: ${userData.invites}\nBonus: $${userData.bonus.toFixed(2)}\n💰 Total Earnings: $${userData.totalEarnings.toFixed(2)}\n\n`;
      }

      if (!description.trim()) {
        description = 'No leaderboard data available.';
      }

      return new EmbedBuilder()
        .setTitle('REWARD NETWORK | INVITE LEADERBOARD')
        .setColor('Green')
        .setDescription(description)
        .setFooter({ text: `Page: ${page} / ${totalPages}` });
    }

    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('leaderboard_prev').setLabel('⬅️ Previous').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('leaderboard_next').setLabel('➡️ Next').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('leaderboard_refresh').setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary)
    );

    const embed = await createLeaderboardEmbed(users, 1);
    if (!boardMessage) {
      await leaderboardChannel.send({ embeds: [embed], components: [buttons] });
    } else {
      await boardMessage.edit({ embeds: [embed], components: [buttons] });
    }
  }
});

// ---- Invite Tracking ----
client.on('guildMemberAdd', async member => {
  try {
    const cachedInvites = client.inviteCache.get(member.guild.id) || new Map();
    const newInvites = await member.guild.invites.fetch();

    const usedInvite = newInvites.find(inv => (cachedInvites.get(inv.code) || 0) < inv.uses);
    client.inviteCache.set(member.guild.id, new Map(newInvites.map(inv => [inv.code, inv.uses])));

    if (!usedInvite?.inviter) return;
    const inviterId = usedInvite.inviter.id;

    let userData = await User.findOne({ userId: inviterId });
    if (!userData) {
      userData = new User({ userId: inviterId });
    }

    // Update and save username in DB
    userData.username = usedInvite.inviter.tag;
    userData.invites++;
    userData.calculateTotalEarnings();
    await userData.save();

    console.log(`+1 invite for ${usedInvite.inviter.tag}`);
  } catch (error) {
    console.error('Error processing guildMemberAdd:', error);
  }
});

// ---- Interaction Handling ----
client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const command = client.commands.get(interaction.commandName);
    if (!command) return;
    try {
      await command.execute(interaction);
    } catch (error) {
      console.error('Command error:', error);
      await interaction.reply({ content: 'Error executing command.', ephemeral: true });
    }
  } else if (interaction.isButton()) {
    try {
      const referralHandler = require('./commands/referral');
      await referralHandler.execute(interaction, client);
    } catch (error) {
      console.error('Button interaction error:', error);
      if (!interaction.replied) {
        await interaction.reply({ content: 'Error handling interaction.', ephemeral: true });
      }
    }
  }
});

// ---- Express Admin Panel ----
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/user/:userId', async (req, res) => {
  try {
    const userData = await User.findOne({ userId: req.params.userId });
    if (!userData) return res.status(404).json({ error: 'User not found' });
    userData.calculateTotalEarnings();
    res.json({
      userId: userData.userId,
      invites: userData.invites,
      bonus: userData.bonus,
      totalEarnings: userData.totalEarnings
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Admin panel web server running on port ${PORT}`));

// ---- Login ----
client.login(config.token);
