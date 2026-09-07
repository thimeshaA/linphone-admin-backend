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
const {
  forgotPasswordLimiter,
  loginLimiter,
  changePasswordLimiter,
  resetPasswordLimiter,
} = require('../middlewares/rateLimit');

const router = express.Router();

router.post('/login', loginLimiter, login);
router.post('/logout', logout);
router.get('/me', verifyToken, getCurrentAdmin);
router.patch('/change-password', verifyToken, changePasswordLimiter, changePassword);
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);
router.post('/reset-password', resetPasswordLimiter, resetPassword);

module.exports = router;
