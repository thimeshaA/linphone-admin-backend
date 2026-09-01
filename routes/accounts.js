const express = require('express');
const {
  list,
  getOne,
  create,
  reassign,
  renew,
  disable,
  updatePassword,
  remove,
  requestAccounts,
} = require('../controllers/accountsController');
const { verifyToken } = require('../middlewares/auth');
const { applyOwnershipFilter, requireAdmin, requireReseller } = require('../middlewares/scope');

const router = express.Router();

router.post('/request', verifyToken, requireReseller, requestAccounts);

router.get('/', verifyToken, applyOwnershipFilter, list);
router.get('/:id', verifyToken, applyOwnershipFilter, getOne);
router.post('/', verifyToken, requireAdmin, create);
router.patch('/:id/reassign', verifyToken, requireAdmin, reassign);
router.patch('/:id/renew', verifyToken, applyOwnershipFilter, renew);
router.patch('/:id/disable', verifyToken, applyOwnershipFilter, disable);
router.patch('/:id/password', verifyToken, applyOwnershipFilter, updatePassword);
router.delete('/:id', verifyToken, requireAdmin, remove);

module.exports = router;
