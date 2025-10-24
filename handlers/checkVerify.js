const redisClient = require('../redisClient');
const { logEvent } = require('../auditLog');
const { verifyToken } = require('../jwtHelper');

async function checkVerify(req, res) {
  const token = req.query.token;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    // ✅ ตรวจลายเซ็น JWT ก่อน
    const decoded = verifyToken(token);
    if (!decoded || !decoded.jti) {
      logEvent('verify.failed', { token, reason: 'invalid token' });
      return res.status(401).json({ error: 'Invalid token signature' });
    }

    const key = `preverify:${decoded.jti}`;
    const data = await redisClient.get(key);
    if (!data) {
      logEvent('verify.failed', { jti: decoded.jti, reason: 'not found' });
      return res.status(404).json({ error: 'Token not found or expired' });
    }

    const profile = JSON.parse(data);

    if (profile.used) {
      logEvent('verify.failed', { jti: decoded.jti, reason: 'used already' });
      return res.status(409).json({ error: 'Token already used' });
    }

    // ✅ Mark token as used (grace period 5 นาที)
    profile.used = true;
    await redisClient.set(key, JSON.stringify(profile), { EX: 300 });

    logEvent('verify.success', { jti: decoded.jti, cid: profile.cid });

    res.json({ success: true, profile });
  } catch (err) {
    logEvent('verify.error', { reason: err.message });
    res.status(500).json({ error: err.message });
  }
}

module.exports = { checkVerify };
