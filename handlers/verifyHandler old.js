const redisClient = require('../redisClient');
const { logEvent } = require('../utils/auditLog');

async function checkVerify(req, res) {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const key = `preverify:${token}`;
    const data = await redisClient.get(key);
    if (!data) {
        logEvent('verify.failed', { token, reason: 'token not found' });
        return res.status(404).json({ error: 'Token not found or expired' });
    }

    const profile = JSON.parse(data);

    if (profile.used) {
        logEvent('verify.failed', { token, reason: 'token used' });
        return res.status(409).json({ error: 'Token already used' });
    }

    // Mark token as used
    profile.used = true;
    await redisClient.set(key, JSON.stringify(profile), { EX: 300 }); // grace period 5 นาที

    logEvent('verify.success', { token, cid: profile.cid });

    res.json({ success: true, profile });
}

module.exports = { checkVerify };
