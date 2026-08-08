const express = require('express');
const { login, logout, getCurrentAdmin, changePassword } = require('../controllers/authController');
const { verifyToken } = require('../middlewares/auth');

const router = express.Router();

router.post('/login', login);
router.post('/logout', logout);
router.get('/me', verifyToken, getCurrentAdmin);
router.patch('/change-password', verifyToken, changePassword);

module.exports = router;
