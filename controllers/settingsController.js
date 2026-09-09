const { getRenewalCost, setRenewalCost } = require('../models/settingsModel');

async function getRenewalCostSetting(req, res) {
  const renewalCost = await getRenewalCost();
  return res.json({ renewalCost });
}

async function updateRenewalCostSetting(req, res) {
  const { renewalCost } = req.body;

  if (typeof renewalCost !== 'number' || !Number.isFinite(renewalCost) || renewalCost < 0) {
    return res.status(400).json({ error: 'renewalCost must be a non-negative number' });
  }

  await setRenewalCost(renewalCost);
  return res.json({ renewalCost });
}

module.exports = { getRenewalCostSetting, updateRenewalCostSetting };
