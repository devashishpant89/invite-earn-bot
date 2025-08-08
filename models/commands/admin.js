const { SlashCommandBuilder } = require('discord.js');
const User = require('../models/User');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('user-stats')
    .setDescription('Show user stats')
    .addUserOption(option => option.setName('target').setDescription('Target user').setRequired(true)),

  async execute(interaction) {
    if (!interaction.member.roles.cache.has(interaction.client.config.adminRoleId)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const targetUser = interaction.options.getUser('target');
    let userData = await User.findOne({ userId: targetUser.id });
    if (!userData) {
      userData = new User({ userId: targetUser.id });
      await userData.save();
    }
    userData.calculateTotalEarnings();

    return interaction.reply({
      content: `Stats for ${targetUser.tag}:\n- Invites: ${userData.invites}\n- Bonus: $${userData.bonus.toFixed(2)}\n- Total Earnings: $${userData.totalEarnings.toFixed(2)}`,
      ephemeral: true
    });
  }
};
