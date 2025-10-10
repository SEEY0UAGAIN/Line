const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const https = require('https');
const { startRegistration, processIdCardInput, replyMessage } = require('./handlers/messageHandler');
const redisClient = require('./redisClient');
const { handlePostback } = require('./handlers/postbackHandler');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

app.get('/webhook', (req, res) => res.send('LINE OA Webhook running'));

app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events;
    for (const event of events) {
      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        const sessionStr = await redisClient.get(`session:${userId}`);
        const session = sessionStr ? JSON.parse(sessionStr) : null;

        if (session && session.step === 'awaiting_id_card') {
          await processIdCardInput(userId, event.message.text.trim(), event.replyToken);
        } else {
          const msg = event.message.text.trim().toLowerCase();
          if (msg === 'ลงทะเบียน' || msg === 'register') {
            await startRegistration(userId, event.replyToken);
          } else {
            await replyMessage(event.replyToken, [{ type: 'text', text: 'กรุณาพิมพ์ "ลงทะเบียน" เพื่อเริ่มต้น' }]);
          }
        }
      } else if (event.type === 'postback') {
        await handlePostback(event);
      }
    }
    res.status(200).send('OK');
  } catch (error) {
    console.error(error);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
const options = {
  key: fs.readFileSync(process.env.HTTPS_KEY),
  cert: fs.readFileSync(process.env.HTTPS_CERT)
};

https.createServer(options, app).listen(PORT, () => console.log(`LINE OA Webhook running on https://localhost:${PORT}`));
