const express = require('express');
const { list, markRead, markAllRead } = require('../controllers/notificationsController');
const { verifyToken } = require('../middlewares/auth');

const router = express.Router();

router.use(verifyToken);

router.get('/', list);
router.patch('/read-all', markAllRead);
router.patch('/:id/read', markRead);

module.exports = router;
