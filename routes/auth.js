const express = require('express');
const {
  login,
  logout,
  getCurrentAdmin,
  changePassword,
  forgotPassword,
  resetPassword,
} = require('../controllers/authController');
const { verifyToken } = require('../middlewares/auth');
const { forgotPasswordLimiter } = require('../middlewares/rateLimit');

const router = express.Router();

router.post('/login', login);
router.post('/logout', logout);
router.get('/me', verifyToken, getCurrentAdmin);
router.patch('/change-password', verifyToken, changePassword);
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);
router.post('/reset-password', resetPassword);

module.exports = router;
