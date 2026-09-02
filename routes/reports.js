const express = require('express');
const { accountsReport, resellersReport } = require('../controllers/reportsController');
const { verifyToken } = require('../middlewares/auth');
const { applyOwnershipFilter, requireAdmin } = require('../middlewares/scope');

const router = express.Router();

router.get('/accounts', verifyToken, applyOwnershipFilter, accountsReport);
router.get('/resellers', verifyToken, requireAdmin, resellersReport);

module.exports = router;
