const jwt = require('jsonwebtoken');
const User = require("../models/User");

exports.googleCallback = async (req, res) => {
  try {
    // Passport ne user object req.user me inject kiya hai
    const user = req.user;

    if (!user) {
      return res.status(400).json({ success: false, message: 'No user data found from Google' });
    }

    // JWT token generate
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Response send
    return res.status(200).json({
      success: true,
      message: 'Google signup/login successful',
      token,
      user,
    });
  } catch (error) {
    console.error('Google Callback Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Google login failed',
      error: error.message,
    });
  }
};