const express = require('express');
const router = express.Router();

const { getPublicFeatureFlags } = require('../services/feature_flags_service');

router.get('/features', async (_req, res) => {
  try {
    const data = await getPublicFeatureFlags();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

module.exports = router;
