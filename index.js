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

      // 🔹 Event follow: เมื่อผู้ใช้เพิ่ม OA
      if (event.type === 'follow') {
        const { linkRichMenuToUser } = require('./richmenu/linkRichMenu');
        const RICH_MENU_ID = 'richmenu-e8b0e9ecc69a8e89e5ef25d071958132'; // ใส่ ID ของ Rich Menu ที่สร้างไว้
        await linkRichMenuToUser(event.source.userId, RICH_MENU_ID);

        // ส่งข้อความต้อนรับพร้อม Quick Reply (ถ้าต้องการ)
        const quickReplyItems = [
          { type: 'action', action: { type: 'message', label: 'ลงทะเบียน', text: 'ลงทะเบียน' } },
          { type: 'action', action: { type: 'message', label: 'ตรวจสอบสถานะ', text: 'ตรวจสอบสถานะ' } },
          { type: 'action', action: { type: 'message', label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' } }
        ];
        await replyMessage(event.replyToken, [
          { type: 'text', text: '🎉 ยินดีต้อนรับ! กรุณาเลือกเมนูด้านล่าง', quickReply: { items: quickReplyItems } }
        ]);
      }

      // 🔹 Event message: ข้อความจากผู้ใช้
      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        const sessionStr = await redisClient.get(`session:${userId}`);
        const session = sessionStr ? JSON.parse(sessionStr) : null;
        const msg = event.message.text.trim().toLowerCase();

        if (session && session.step === 'awaiting_id_card') {
          await processIdCardInput(userId, event.message.text.trim(), event.replyToken);
        } else {
          const quickReplyItems = [
            { type: 'action', action: { type: 'message', label: 'ลงทะเบียน', text: 'ลงทะเบียน' } },
            { type: 'action', action: { type: 'message', label: 'ตรวจสอบสถานะ', text: 'ตรวจสอบสถานะ' } },
            { type: 'action', action: { type: 'message', label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' } },
            { type: 'action', action: { type: 'message', label: 'รับ Token', text: 'รับ token' } }
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
          } else if (msg === 'ติดต่อเจ้าหน้าที่') {
            await replyMessage(event.replyToken, [{ type: 'text', text: '☎️ ติดต่อเราได้ที่ 1218 กด 8' }], quickReplyItems);
          }else if (msg === 'รับ token') {
            const rows = await require('./db').queryDB2(
              'SELECT * FROM line_registered_users WHERE line_user_id = ?',
              [userId]
            );

            if (rows.length === 0) {
              await replyMessage(event.replyToken, [{ type: 'text', text: '❌ คุณยังไม่ได้ลงทะเบียน' }]);
              return;
            }

            const userInfo = rows[0];
            const jwtToken = require('./handlers/messageHandler').createToken({
              lineUserId: userId,
              id_card: userInfo.id_card,
              full_name: userInfo.full_name
            }, '24h');

            await replyMessage(event.replyToken, [
              { type: 'text', text: `🛡️ Token สำหรับยืนยันตัวตนที่คีออสก์:\n${jwtToken}` }
            ]);
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