function requireAdmin(req, res, next) {
  if (req.admin.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireReseller(req, res, next) {
  if (req.admin.role !== 'reseller') {
    return res.status(403).json({ error: 'Reseller access required' });
  }
  next();
}

function applyOwnershipFilter(req, res, next) {
  req.scopeFilter = req.admin.role === 'admin' ? {} : { creator_id: req.admin.id };
  next();
}

module.exports = { requireAdmin, requireReseller, applyOwnershipFilter };
