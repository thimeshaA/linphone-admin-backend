const express = require('express');
const {
  list,
  getOne,
  create,
  renew,
  disable,
  updatePassword,
  remove,
} = require('../controllers/accountsController');
const { verifyToken } = require('../middlewares/auth');
const { applyOwnershipFilter, forceCreatorId, requireAdmin } = require('../middlewares/scope');

const router = express.Router();

router.get('/', verifyToken, applyOwnershipFilter, list);
router.get('/:id', verifyToken, applyOwnershipFilter, getOne);
router.post('/', verifyToken, applyOwnershipFilter, forceCreatorId, create);
router.patch('/:id/renew', verifyToken, applyOwnershipFilter, renew);
router.patch('/:id/disable', verifyToken, applyOwnershipFilter, disable);
router.patch('/:id/password', verifyToken, applyOwnershipFilter, updatePassword);
router.delete('/:id', verifyToken, requireAdmin, remove);

module.exports = router;
