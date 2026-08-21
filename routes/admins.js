const express = require('express');
const { list, getOne, create, updateStatus, resetPassword, remove } = require('../controllers/adminsController');
const { verifyToken } = require('../middlewares/auth');
const { requireAdmin } = require('../middlewares/scope');

const router = express.Router();

router.use(verifyToken, requireAdmin);

router.get('/', list);
router.get('/:id', getOne);
router.post('/', create);
router.patch('/:id', updateStatus);
router.patch('/:id/reset-password', resetPassword);
router.delete('/:id', remove);

module.exports = router;
