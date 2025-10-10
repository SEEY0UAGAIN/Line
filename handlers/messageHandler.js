const sqlServer = require('mssql');
const { queryDB1, queryDB2 } = require('../db');
const redisClient = require('../redisClient');
const { logEvent } = require('../auditLog');
const { isValidIdCard } = require('../utils/validation');
const axios = require('axios');
const { createToken } = require('../jwtHelper'); // Step 3: JWT
require('dotenv').config();

const LINE_MESSAGING_API = process.env.LINE_MESSAGING_API;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ส่งข้อความ Reply พร้อม Quick Reply
async function replyMessage(replyToken, messages, quickReplyItems = []) {
  try {
    const messagePayload = { replyToken, messages };

    // เพิ่ม Quick Reply หากมี
    if (quickReplyItems.length > 0) {
      messagePayload.messages[0].quickReply = { items: quickReplyItems };
    }

    await axios.post(
      `${LINE_MESSAGING_API}/reply`,
      messagePayload,
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
    await replyMessage(replyToken, [
      { type: 'text', text: '❌ กรุณากรอกเลขบัตรประชาชน 13 หลักให้ถูกต้อง' }
    ]);
    return;
  }

  // 🔹 Query ตรวจสอบเลขบัตรจาก HNOPD_MASTER + HNName (SQL Server)
  const sqlQuery = `
      DECLARE @date DATE = CAST(GETDATE() AS DATE);
      SELECT 
          N.HN,
          N.ID AS CID,
          N.InitialName,
          N.FirstName,
          N.LastName,
          N.BirthDateTime AS DOB,
          OM.DefaultRightCode AS DefaultRight,
          OM.VN
      FROM HNOPD_MASTER OM
      LEFT JOIN HNName N ON OM.HN = N.HN
      WHERE OM.VisitDate >= @date
        AND OM.VisitDate < DATEADD(DAY, 1, @date)
        AND N.ID = @id_card
      ORDER BY OM.VN ASC
  `;

  // เรียก queryDB1 แบบ named parameter
  const userInfoRows = await queryDB1(sqlQuery, {
    id_card: { type: sqlServer.VarChar, value: idCard }
  });
  const userInfo = userInfoRows[0];
  const nameWithoutTitle = (userInfo.FirstName || '').replace(/^(นาย|นาง|นางสาว)/, '').trim();
  const lastName = (userInfo.LastName || '').trim();

  if (!userInfo) {
    await replyMessage(replyToken, [
      { type: 'text', text: '❌ ไม่พบข้อมูลเลขบัตรนี้ในระบบวันนี้' }
    ]);
    await logEvent('register.failed', { userId, id_card: idCard, reason: 'Not found in HNOPD_MASTER' });
    return;
  }

  // 🔹 บันทึกลง DB2 (MySQL)
  try {
    await queryDB2(
      'INSERT INTO line_registered_users (line_user_id, id_card, registered_at) VALUES (?, ?, NOW())',
      [userId, idCard]
    );

    await redisClient.del(`session:${userId}`);

    const tokenPayload = {
      lineUserId: userId,
      id_card: idCard,
      full_name: userInfo.FullName
    };
    const jwtToken = createToken(tokenPayload, '24h');

    await replyMessage(replyToken, [
      { 
        type: 'text', 
        text: `✅ ลงทะเบียนสำเร็จ!\nยินดีต้อนรับคุณ ${nameWithoutTitle} ${lastName}`
      }

      // { type: 'text', text: `🛡️ Token สำหรับยืนยันตัวตนที่คีออสก์:\n${jwtToken}` }
    ]);

    setTimeout(async () => {
      await pushMessage(userId, [
        { type: 'text', text: '🎉 ขอบคุณที่ลงทะเบียนกับเรา\nคุณจะได้รับข้อความแจ้งเตือนสำคัญผ่าน LINE OA นี้' }
      ]);
    }, 2000);

    await logEvent('register.success', { userId, id_card: idCard, jwtToken });

  } catch (error) {
    console.error(error);
    await replyMessage(replyToken, [
      { type: 'text', text: '❌ เกิดข้อผิดพลาดในการลงทะเบียน\nกรุณาลองใหม่อีกครั้ง' }
    ]);
    await logEvent('register.failed', { userId, id_card: idCard, reason: 'DB2 insert error' });
  }
}


module.exports = { startRegistration, processIdCardInput, replyMessage, pushMessage };
