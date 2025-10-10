// messageHandler.js
const { queryDB1, queryDB2 } = require('../db');
const redisClient = require('../redisClient');
const { logEvent } = require('../auditLog');
const { isValidIdCard } = require('../utils/validation');
const axios = require('axios');
const { createToken } = require('../jwtHelper'); // Step 3: JWT
require('dotenv').config();

const LINE_MESSAGING_API = process.env.LINE_MESSAGING_API;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ส่งข้อความ Reply
async function replyMessage(replyToken, messages) {
  try {
    await axios.post(
      `${LINE_MESSAGING_API}/reply`,
      { replyToken, messages },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
  } catch (error) {
    console.error('Error sending reply:', error.response?.data || error.message);
  }
}

// ส่งข้อความ Push
async function pushMessage(lineUserId, messages) {
  try {
    await axios.post(
      `${LINE_MESSAGING_API}/push`,
      { to: lineUserId, messages },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
  } catch (error) {
    console.error('Error sending push message:', error.response?.data || error.message);
  }
}

// เริ่ม registration
async function startRegistration(userId, replyToken) {
  const rows = await queryDB2('SELECT * FROM line_registered_users WHERE line_user_id = ?', [userId]);
  if (rows.length > 0) {
    await replyMessage(replyToken, [{ type: 'text', text: '❌ คุณได้ลงทะเบียนไว้แล้ว' }]);
    return;
  }

  // สร้าง Session ใน Redis
  await redisClient.set(
    `session:${userId}`,
    JSON.stringify({ step: 'awaiting_id_card', timestamp: Date.now() }),
    { EX: 600 } // หมดอายุ session 10 นาที
  );

  await replyMessage(replyToken, [{ type: 'text', text: '📝 กรุณากรอกเลขบัตรประชาชน 13 หลัก' }]);
  await logEvent('register.request', { userId, id_card: null });
}

// ประมวลผลเลขบัตร
async function processIdCardInput(userId, idCard, replyToken) {
  if (!isValidIdCard(idCard)) {
    await replyMessage(replyToken, [{ type: 'text', text: '❌ กรุณากรอกเลขบัตรประชาชน 13 หลักให้ถูกต้อง' }]);
    return;
  }

  const userInfoRows = await queryDB1('SELECT * FROM users WHERE id_card = ?', [idCard]);
  const userInfo = userInfoRows[0];
  if (!userInfo) {
    await replyMessage(replyToken, [{ type: 'text', text: '❌ ไม่พบข้อมูลเลขบัตรนี้ในระบบ' }]);
    await logEvent('register.failed', { userId, id_card: idCard, reason: 'Not found in DB1' });
    return;
  }

  // บันทึก DB2
  try {
    await queryDB2(
      'INSERT INTO line_registered_users (line_user_id, id_card, registered_at) VALUES (?, ?, NOW())',
      [userId, idCard]
    );

    // ลบ session ใน Redis
    await redisClient.del(`session:${userId}`);

    // Step 3: สร้าง JWT token หลังลงทะเบียน
    const tokenPayload = {
      lineUserId: userId,
      id_card: idCard,
      first_name: userInfo.first_name,
      last_name: userInfo.last_name
    };
    const jwtToken = createToken(tokenPayload, '24h'); // หมดอายุ 24 ชั่วโมง

    // ส่งข้อความยืนยัน + Token
    await replyMessage(replyToken, [
      {
        type: 'text',
        text: `✅ ลงทะเบียนสำเร็จ!\nยินดีต้อนรับคุณ ${userInfo.first_name} ${userInfo.last_name}`
      },
      {
        type: 'text',
        text: `🛡️ Token สำหรับยืนยันตัวตนที่คีออสก์:\n${jwtToken}`
      }
    ]);

    // push message แจ้งเตือนเพิ่มเติม
    setTimeout(async () => {
      await pushMessage(userId, [
        {
          type: 'text',
          text: '🎉 ขอบคุณที่ลงทะเบียนกับเรา\nคุณจะได้รับข้อความแจ้งเตือนสำคัญผ่าน LINE OA นี้'
        }
      ]);
    }, 2000);

    await logEvent('register.success', { userId, id_card: idCard, jwtToken });

  } catch (error) {
    console.error(error);
    await replyMessage(replyToken, [{ type: 'text', text: '❌ เกิดข้อผิดพลาดในการลงทะเบียน\nกรุณาลองใหม่อีกครั้ง' }]);
    await logEvent('register.failed', { userId, id_card: idCard, reason: 'DB2 insert error' });
  }
}

module.exports = { startRegistration, processIdCardInput, replyMessage, pushMessage };
