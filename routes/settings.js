const express = require('express');
const { getRenewalCostSetting, updateRenewalCostSetting } = require('../controllers/settingsController');
const { verifyToken } = require('../middlewares/auth');
const { requireAdmin } = require('../middlewares/scope');

const router = express.Router();

router.use(verifyToken);

router.get('/renewal-cost', getRenewalCostSetting);
router.put('/renewal-cost', requireAdmin, updateRenewalCostSetting);

module.exports = router;
