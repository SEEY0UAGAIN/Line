const jwt = require('jsonwebtoken');
require('dotenv').config();

// ควรใช้ secret ยาวและซับซ้อนใน production
const SECRET_KEY = process.env.JWT_SECRET;

function createToken(payload, expiresIn = '12h') {
  return jwt.sign(payload, SECRET_KEY, { expiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET_KEY);
  } catch (error) {
    return null;
  }
}

module.exports = { createToken, verifyToken };
