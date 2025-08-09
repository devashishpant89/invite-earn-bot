require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

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

const User = require('./models/User');

// Load commands
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if (command.data) {
    client.commands.set(command.data.name, command);
  }
}

mongoose.connect(config.mongoUri)
  .then(() => console.log('Connected to MongoDB'))
  .catch(console.error);

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Cache invites per guild
  client.inviteCache = new Map();
  for (const guild of client.guilds.cache.values()) {
    const invites = await guild.invites.fetch();
    client.inviteCache.set(guild.id, invites);
  }

  // Setup static referral panel
  const referralChannel = client.channels.cache.get(config.channels.referralPanel);
  if (referralChannel) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

    let fetched = await referralChannel.messages.fetch({ limit: 10 });
    let botMessage = fetched.find(m => m.author.id === client.user.id && m.embeds.length > 0);

    const referralEmbed = new EmbedBuilder()
      .setTitle('Referral Panel')
      .setDescription('Use the buttons below to get your invite link or view your referrals.')
      .setColor('Blue');

    const buttons = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('invite_link')
          .setLabel('🎟️ Invite Link')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('referrals')
          .setLabel('📊 Referrals')
          .setStyle(ButtonStyle.Secondary),
      );

    if (!botMessage) {
      await referralChannel.send({ embeds: [referralEmbed], components: [buttons] });
    } else {
      await botMessage.edit({ embeds: [referralEmbed], components: [buttons] });
    }
  }

  // Setup leaderboard panel
  const leaderboardChannel = client.channels.cache.get(config.channels.leaderboard);
  if (leaderboardChannel) {
    let fetched = await leaderboardChannel.messages.fetch({ limit: 10 });
    let boardMessage = fetched.find(m => m.author.id === client.user.id && m.embeds.length > 0);

    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

    const users = await User.find({}).sort({ invites: -1 });
    users.forEach(u => u.totalEarnings = u.invites * 0.5 + u.bonus);

    function createLeaderboardEmbed(users, page = 1) {
      const ITEMS_PER_PAGE = 10;
      let description = '';
      const totalPages = Math.ceil(users.length / ITEMS_PER_PAGE);
      const start = (page - 1) * ITEMS_PER_PAGE;
      const end = start + ITEMS_PER_PAGE;
      const pageUsers = users.slice(start, end);

      const medals = ['🥇', '🥈', '🥉'];

      pageUsers.forEach((userData, index) => {
        const rank = start + index + 1;
        const medal = medals[index] || rank + '.';
        description += `${medal} ${userData.username || 'Unknown#0000'}\nInvites: ${userData.invites}\nBonus: $${userData.bonus.toFixed(2)}\n💰 Total Earnings: $${userData.totalEarnings.toFixed(2)}\n\n`;
      });

      if (!description || description.trim().length === 0) {
        description = 'No leaderboard data available.';
      }

      return new EmbedBuilder()
        .setTitle('REWARD NETWORK | INVITE LEADERBOARD')
        .setColor('Green')
        .setDescription(description)
        .setFooter({ text: `Page: ${page} / ${totalPages}` });
    }

    const buttons = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('leaderboard_prev')
          .setLabel('⬅️ Previous')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('leaderboard_next')
          .setLabel('➡️ Next')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('leaderboard_refresh')
          .setLabel('🔄 Refresh')
          .setStyle(ButtonStyle.Secondary),
      );

    const embed = createLeaderboardEmbed(users, 1);

    if (!boardMessage) {
      await leaderboardChannel.send({ embeds: [embed], components: [buttons] });
    } else {
      await boardMessage.edit({ embeds: [embed], components: [buttons] });
    }
  }
});

// Invite tracking on member join
client.on('guildMemberAdd', async member => {
  try {
    const cachedInvites = client.inviteCache.get(member.guild.id);
    const newInvites = await member.guild.invites.fetch();

    const usedInvite = newInvites.find(i => {
      const oldUses = cachedInvites.get(i.code)?.uses ?? 0;
      return i.uses > oldUses;
    });

    if (!usedInvite) return;

    client.inviteCache.set(member.guild.id, newInvites);
    const inviterId = usedInvite.inviter?.id;

    if (!inviterId) return;

    let userData = await User.findOne({ userId: inviterId });
    if (!userData) {
      userData = new User({ userId: inviterId });
    }

    userData.invites++;
    userData.calculateTotalEarnings();
    await userData.save();
  } catch (error) {
    console.error('Error processing guildMemberAdd:', error);
  }
});

// Interaction handling for commands and buttons
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

// --- Express Server for Admin Panel ---

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve static admin panel frontend files from 'public'
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint to get user stats by userId
app.get('/api/user/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const userData = await User.findOne({ userId });
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

// Additional API routes for updating invites, bonuses, resetting users etc. can be added here

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Admin panel web server running on port ${PORT}`);
});

client.login(config.token);
