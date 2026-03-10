const jwt = require('jsonwebtoken');
const User = require("../models/User");

// Web OAuth callback
exports.googleCallback = async (req, res) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "No user data found from Google"
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      success: true,
      message: "Google signup/login successful",
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email
        }
      }
    });

  } catch (error) {
    console.error("Google Callback Error:", error);

    return res.status(500).json({
      success: false,
      message: "Google login failed"
    });
  }
};


// Flutter mobile login
exports.googleMobileLogin = async (req, res) => {
  try {
    const { token, name, email } = req.body;

    if (!token || !email) {
      return res.status(400).json({
        success: false,
        message: "Token or email missing"
      });
    }

    let user = await User.findOne({ where: { email } });

    if (!user) {
      user = await User.create({
        name,
        email,
        provider: "google",
        isVerified: true
      });
    }

    const jwtToken = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      success: true,
      message: "Google mobile login successful",
      data: {
        token: jwtToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email
        }
      }
    });

  } catch (error) {
    console.error("Google Mobile Login Error:", error);

    return res.status(500).json({
      success: false,
      message: "Google mobile login failed"
    });
  }
};