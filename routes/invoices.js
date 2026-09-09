const express = require('express');
const { create, getPdf, send, list } = require('../controllers/invoicesController');
const { verifyToken } = require('../middlewares/auth');
const { applyOwnershipFilter, requireAdmin } = require('../middlewares/scope');

const router = express.Router();

router.use(verifyToken);

router.get('/', applyOwnershipFilter, list);
router.post('/', requireAdmin, create);
router.get('/:id/pdf', applyOwnershipFilter, getPdf);
router.post('/:id/send', requireAdmin, send);

module.exports = router;
