const express = require('express');
const router = express.Router();
const { issueVerifyToken } = require('../handlers/verifyHandler');
const { checkVerify } = require('../handlers/checkVerify');

router.post('/verify', async (req, res) => {
  try {
    const result = await issueVerifyToken(req.body);
    res.json({ success: true, token: result.token, exp: result.exp });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/verify/check', checkVerify);

module.exports = router;
