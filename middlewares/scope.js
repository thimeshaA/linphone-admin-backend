function requireAdmin(req, res, next) {
  if (req.admin.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function applyOwnershipFilter(req, res, next) {
  req.scopeFilter = req.admin.role === 'admin' ? {} : { creator_id: req.admin.id };
  next();
}

function forceCreatorId(req, res, next) {
  if (req.admin.role === 'reseller') {
    req.body.creator_id = req.admin.id;
  } else if (req.body.creator_id === undefined || req.body.creator_id === null) {
    req.body.creator_id = req.admin.id;
  }
  next();
}

module.exports = { requireAdmin, applyOwnershipFilter, forceCreatorId };
