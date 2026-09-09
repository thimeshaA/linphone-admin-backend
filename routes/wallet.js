const express = require('express');
const { getWallet, topup } = require('../controllers/walletController');
const { getUninvoiced } = require('../controllers/invoicesController');
const { verifyToken } = require('../middlewares/auth');
const { applyOwnershipFilter, requireAdmin } = require('../middlewares/scope');

const router = express.Router();

router.use(verifyToken);

router.get('/:id/wallet', applyOwnershipFilter, getWallet);
router.post('/:id/wallet/topup', requireAdmin, topup);
router.get('/:id/wallet/uninvoiced', requireAdmin, getUninvoiced);

module.exports = router;
