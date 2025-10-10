const express = require('express');
const bodyParser = require('body-parser');
const { verifyToken } = require('./jwtHelper');
const redisClient = require('./redisClient');

const app = express();
app.use(bodyParser.json());

app.post('/verify-token', async (req, res) => {
  const { token } = req.body;
  const payload = verifyToken(token);

  if (!payload) return res.status(401).json({ success: false, message: 'Token invalid or expired' });

  const used = await redisClient.get(`used:${payload.lineUserId}`);
  if (used) return res.status(409).json({ success: false, message: 'Token already used' });

  await redisClient.set(`used:${payload.lineUserId}`, true, { EX: 600 });

  res.json({ success: true, payload });
});

const PORT = 4000;
app.listen(PORT, () => console.log(`Counter verification server running on port ${PORT}`));
