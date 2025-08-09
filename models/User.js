const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String }, // optional for tracking name
  invites: { type: Number, default: 0 },
  bonus: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  invitedBy: { type: String } // NEW: who invited this user
});

userSchema.methods.calculateTotalEarnings = function () {
  this.totalEarnings = this.invites * 0.5 + this.bonus;
  return this.totalEarnings;
};

module.exports = mongoose.model('User', userSchema);

