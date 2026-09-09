const express = require('express');
const { getWallet, topup } = require('../controllers/walletController');
const { verifyToken } = require('../middlewares/auth');
const { applyOwnershipFilter, requireAdmin } = require('../middlewares/scope');

const router = express.Router();

router.use(verifyToken);

router.get('/:id/wallet', applyOwnershipFilter, getWallet);
router.post('/:id/wallet/topup', requireAdmin, topup);

module.exports = router;
