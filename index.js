const express = require('express');
const bodyParser = require('body-parser');
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
        const msg = event.message.text.trim().toLowerCase();

        if (session && session.step === 'awaiting_id_card') {
          await processIdCardInput(userId, event.message.text.trim(), event.replyToken);
        } else {
          // Quick Reply Menu
          const quickReplyItems = [
            {
              type: 'action',
              action: { type: 'message', label: 'ลงทะเบียน', text: 'ลงทะเบียน' }
            },
            {
              type: 'action',
              action: { type: 'message', label: 'ตรวจสอบสถานะ', text: 'ตรวจสอบสถานะ' }
            },
            {
              type: 'action',
              action: { type: 'message', label: 'ติดต่อเรา', text: 'ติดต่อเรา' }
            }
          ];

          if (msg === 'ลงทะเบียน' || msg === 'register') {
            const rows = await require('./db').queryDB2(
                'SELECT * FROM line_registered_users WHERE line_user_id = ?',
                [userId]
            );

            if (rows.length > 0) {
                await replyMessage(event.replyToken, [{ type: 'text', text: '❌ คุณได้ลงทะเบียนไว้แล้ว' }]);
            } else {
                await startRegistration(userId, event.replyToken);
            }
            } else if (msg === 'ตรวจสอบสถานะ') {
            await replyMessage(event.replyToken, [{ type: 'text', text: '📄 กำลังตรวจสอบสถานะ...' }], quickReplyItems);
            } else if (msg === 'ติดต่อเรา') {
            await replyMessage(event.replyToken, [{ type: 'text', text: '☎️ ติดต่อเราได้ที่ support@example.com' }], quickReplyItems);
            } else {
            await replyMessage(event.replyToken, [{ type: 'text', text: 'กรุณาเลือกเมนูด้านล่าง' }], quickReplyItems);
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
app.listen(PORT, () => console.log(`LINE OA Webhook running on http://localhost:${PORT}`));