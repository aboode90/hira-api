const express = require('express');
const router = express.Router();

const { parseAssistantUtterance } = require('../services/home_assistant_nlu');

/**
 * POST /app/assistant/parse
 * Body: { text, session?, choiceId? }
 */
router.post('/parse', (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    const choiceId = String(req.body?.choiceId || '').trim() || null;
    const session =
      req.body?.session && typeof req.body.session === 'object'
        ? req.body.session
        : {};

    const result = parseAssistantUtterance(text, session, { choiceId });
    return res.json(result);
  } catch (error) {
    console.error('assistant parse error:', error);
    return res.status(500).json({
      message: error?.message || 'Failed to parse assistant request.',
    });
  }
});

module.exports = router;
