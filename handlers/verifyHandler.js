const { createToken } = require('../jwtHelper');
const redisClient = require('../redisClient');
const { logEvent } = require('../auditLog');
const crypto = require('crypto');

async function issueVerifyToken(profile) {
  const jti = crypto.randomUUID();
  const payload = {
    jti,
    cid: profile.cid,
    dob: profile.dob,
    name: profile.name,
    right_name: profile.right_name,
    phone_mask: profile.phone_mask,
    line_user_id: profile.line_user_id,
    scope: 'preverify',
  };

  const token = createToken(payload, '24h');

  await redisClient.setEx(`preverify:${jti}`, 86400, JSON.stringify({
    ...payload,
    used: false,
  }));

  await logEvent('verify.issued', { jti, cid: profile.cid });
  return { token, jti, exp: 86400 };
}

module.exports = { issueVerifyToken };
