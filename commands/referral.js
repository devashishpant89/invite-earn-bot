const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const User = require('../models/User');

const ITEMS_PER_PAGE = 10;

function createReferralEmbed(userData) {
  return new EmbedBuilder()
    .setTitle('Your Referral Stats')
    .setColor('Blue')
    .setDescription(`Total Valid Invites: ${userData.invites}\nBonus: $${userData.bonus.toFixed(2)}\n💰 Total Earnings: $${userData.totalEarnings.toFixed(2)}`);
}

function createLeaderboardEmbed(users, page, totalPages) {
  let description = '';
  const start = (page - 1) * ITEMS_PER_PAGE;
  const end = start + ITEMS_PER_PAGE;
  const pageUsers = users.slice(start, end);

  const medals = ['🥇', '🥈', '🥉'];

  pageUsers.forEach((userData, index) => {
    const rank = start + index + 1;
    const medal = medals[index] || rank + '.';
    description += `${medal} ${userData.username}\nInvites: ${userData.invites}\nBonus: $${userData.bonus.toFixed(2)}\n💰 Total Earnings: $${userData.totalEarnings.toFixed(2)}\n\n`;
  });

  if (!description || description.trim().length === 0) {
    description = 'No leaderboard data available.'; // or a custom, helpful message
  }

  return new EmbedBuilder()
    .setTitle('REWARD NETWORK | INVITE LEADERBOARD')
    .setColor('Green')
    .setDescription(description)
    .setFooter({ text: `Page: ${page} / ${totalPages}` });
}

function createReferralButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('invite_link')
      .setLabel('🎟️ Invite Link')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('referrals')
      .setLabel('📊 Referrals')
      .setStyle(ButtonStyle.Secondary),
  );
}

function createLeaderboardButtons() {
  return new ActionRowBuilder().addComponents(
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
}

module.exports = {
  data: null, // No slash command here; this module handles button interactions

  async execute(interaction, client) {
    if (!interaction.isButton()) return;

    const userId = interaction.user.id;

    if (interaction.customId === 'invite_link') {
      try {
        const guild = interaction.guild;
        let invites = await guild.invites.fetch();

        let userInvite = invites.find(i => i.inviter?.id === userId);
        if (!userInvite) {
          userInvite = await interaction.channel.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: `Invite link for ${interaction.user.tag}` });
        }

        await interaction.reply({ content: `Your unique invite link:\n${userInvite.url}`, ephemeral: true });

        setTimeout(() => {
          interaction.deleteReply().catch(() => { });
        }, 20000);

      } catch (error) {
        console.error('Error sending invite link:', error);
        interaction.reply({ content: 'Failed to get invite link. Please try again later.', ephemeral: true });
      }

    } else if (interaction.customId === 'referrals') {
      let userData = await User.findOne({ userId });
      if (!userData) {
        userData = new User({ userId });
        await userData.save();
      }
      userData.calculateTotalEarnings();

      const embed = createReferralEmbed(userData);

      await interaction.reply({ embeds: [embed], ephemeral: true });
      setTimeout(() => {
        interaction.deleteReply().catch(() => { });
      }, 20000);

    } else if (['leaderboard_prev', 'leaderboard_next', 'leaderboard_refresh'].includes(interaction.customId)) {
      const allUsers = await User.find({}).sort({ invites: -1 }).limit(1000).lean();
      allUsers.forEach(u => {
        u.totalEarnings = u.invites * 0.5 + u.bonus;
      });
      const totalPages = Math.ceil(allUsers.length / ITEMS_PER_PAGE);

      let page = parseInt(interaction.message.embeds[0]?.footer?.text?.match(/Page: (\d+) \/ \d+/)?.[1]) || 1;
      if (interaction.customId === 'leaderboard_prev') {
        page = page > 1 ? page - 1 : totalPages;
      } else if (interaction.customId === 'leaderboard_next') {
        page = page < totalPages ? page + 1 : 1;
      } else if (interaction.customId === 'leaderboard_refresh') {
        page = 1;
      }

      const embed = createLeaderboardEmbed(allUsers, page, totalPages);
      const buttons = createLeaderboardButtons();

      await interaction.update({ embeds: [embed], components: [buttons] });

      setTimeout(async () => {
        const messages = await interaction.channel.messages.fetch({ limit: 10 });
        const msg = messages.find(m => m.id === interaction.message.id);
        if (msg) {
          const currentPage = parseInt(msg.embeds[0]?.footer?.text?.match(/Page: (\d+) \/ \d+/)?.[1]);
          if (currentPage !== 1) {
            const resetEmbed = createLeaderboardEmbed(allUsers, 1, totalPages);
            const buttonsReset = createLeaderboardButtons();
            try {
              await msg.edit({ embeds: [resetEmbed], components: [buttonsReset] });
            } catch { }
          }
        }
      }, 20000);

    }
  }
};
