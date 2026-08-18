const express = require('express');
const { create, list, getOne, approve, reject } = require('../controllers/requestController');
const { verifyToken } = require('../middlewares/auth');
const { requireAdmin } = require('../middlewares/scope');

const router = express.Router();

router.post('/', create);

router.use(verifyToken, requireAdmin);

router.get('/', list);
router.get('/:id', getOne);
router.patch('/:id/approve', approve);
router.patch('/:id/reject', reject);

module.exports = router;
