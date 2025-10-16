const sqlServer = require('mssql');
const { queryDB1, queryDB2 } = require('../db');
const redisClient = require('../redisClient');
const { logEvent } = require('../auditLog');
const { isValidIdCard } = require('../utils/validation');
const axios = require('axios');
const { createToken } = require('../jwtHelper'); 
require('dotenv').config();

const LINE_MESSAGING_API = process.env.LINE_MESSAGING_API;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ส่งข้อความ Reply พร้อม Quick Reply
async function replyMessage(replyToken, messages, quickReplyItems = []) {
  try {
    const messagePayload = { replyToken, messages };
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

// ตรวจสอบสิทธิ์ผู้ใช้งาน
async function checkUserRights(idCard) {
  const sqlQuery = `
    SELECT OM.DefaultRightCode
    FROM HNOPD_MASTER OM
    LEFT JOIN HNName N ON OM.HN = N.HN
    WHERE N.ID = @id_card
  `;
  const rows = await queryDB1(sqlQuery, { id_card: { type: sqlServer.VarChar, value: idCard } });
  if (!rows.length) return [];

  // ดึง DefaultRightCode ของผู้ใช้ทั้งหมด
  const rights = rows.map(r => r.DefaultRightCode);
  return rights;
}

// เริ่ม registration → ส่ง LIFF template ให้กรอกเลขบัตร
async function startRegistration(userId, replyToken) {
  const existing = await queryDB2(
    'SELECT id_card FROM line_registered_users WHERE line_user_id = ?',
    [userId]
  );

  let nameWithoutTitle = 'ผู้ใช้งาน';
  let lastName = '';

  if (existing.length > 0) {
    const idCard = existing[0].id_card;

    const sqlQuery = `
      SELECT N.FirstName, N.LastName
      FROM HNOPD_MASTER OM
      LEFT JOIN HNName N ON OM.HN = N.HN
      WHERE N.ID = @id_card
      ORDER BY OM.VN ASC
    `;
    const userInfoRows = await queryDB1(sqlQuery, {
      id_card: { type: sqlServer.VarChar, value: idCard }
    });

    if (userInfoRows.length > 0) {
      nameWithoutTitle = (userInfoRows[0].FirstName || '').replace(/^(นาย|นาง|นางสาว)/, '').trim();
      lastName = (userInfoRows[0].LastName || '').trim();
    }

    const welcomeMessage = `✅ คุณได้ลงทะเบียนไว้แล้ว\nยินดีต้อนรับคุณ ${nameWithoutTitle} ${lastName}`;

    // ตรวจสอบสิทธิ์ผู้ใช้
    const userRights = await checkUserRights(idCard);
    const rightsMessage = userRights.length > 0 
      ? `🔑 สิทธิ์ของคุณ: ${userRights.join(', ')}` 
      : '⚠️ คุณยังไม่มีสิทธิ์ใช้งาน';

    if (replyToken) {
      await replyMessage(replyToken, [
        { type: 'text', text: welcomeMessage },
        { type: 'text', text: rightsMessage }
      ]);
    } else {
      await pushMessage(userId, [
        { type: 'text', text: welcomeMessage },
        { type: 'text', text: rightsMessage }
      ]);
    }
    return;
  }

  const liffUrl = "https://liff.line.me/2008268424-1GqpgeO5";
  const message = [
    {
      type: "template",
      altText: "ลงทะเบียน",
      template: {
        type: "buttons",
        thumbnailImageUrl: "https://cdn-icons-png.flaticon.com/512/747/747376.png",
        title: "ลงทะเบียนผู้ใช้งาน",
        text: "กรุณากดปุ่มด้านล่างเพื่อกรอกเลขบัตรประชาชน",
        actions: [
          { type: "uri", label: "กรอกข้อมูล", uri: liffUrl }
        ]
      }
    }
  ];

  if (replyToken) {
    await replyMessage(replyToken, message);
  } else {
    await pushMessage(userId, [
      { type: 'text', text: '✅ กรุณากดปุ่มด้านล่างเพื่อกรอกเลขบัตรประชาชน' }
    ]);
  }
}

// ประมวลผลเลขบัตรและลงทะเบียน
async function processIdCardInput(userId, idCard, replyToken) {
  if (!isValidIdCard(idCard)) {
    await replyMessage(replyToken, [
      { type: 'text', text: '❌ กรุณากรอกเลขบัตรประชาชน 13 หลักให้ถูกต้อง' }
    ]);
    return;
  }

  const sqlQuery = `
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
    WHERE N.ID = @id_card
    ORDER BY OM.VN ASC
  `;

  const userInfoRows = await queryDB1(sqlQuery, {
    id_card: { type: sqlServer.VarChar, value: idCard }
  });
  const userInfo = userInfoRows[0];

  if (!userInfo) {
    await replyMessage(replyToken, [
      { type: 'text', text: '❌ ไม่พบข้อมูลเลขบัตรนี้ในระบบวันนี้' }
    ]);
    await logEvent('register.failed', { userId, id_card: idCard, reason: 'Not found in HNOPD_MASTER' });
    return;
  }

  const nameWithoutTitle = (userInfo.FirstName || '').replace(/^(นาย|นาง|นางสาว)/, '').trim();
  const lastName = (userInfo.LastName || '').trim();

  try {
    await queryDB2(
      'INSERT INTO line_registered_users (line_user_id, id_card, full_name, registered_at) VALUES (?, ?, ?, NOW())',
      [userId, idCard, `${nameWithoutTitle} ${lastName}`]
    );

    await redisClient.del(`session:${userId}`);

    const tokenPayload = {
      lineUserId: userId,
      id_card: idCard,
      full_name: `${nameWithoutTitle} ${lastName}`
    };
    const jwtToken = createToken(tokenPayload, '24h');

    // ส่งข้อความยินดีต้อนรับ
    if (replyToken) {
      await replyMessage(replyToken, [
        { type: 'text', text: `✅ ลงทะเบียนสำเร็จ!\nยินดีต้อนรับคุณ ${nameWithoutTitle} ${lastName}` }
      ]);
    } else {
      await pushMessage(userId, [
        { type: 'text', text: `✅ ลงทะเบียนสำเร็จ!\nยินดีต้อนรับคุณ ${nameWithoutTitle} ${lastName}` }
      ]);
    }

    // แจ้งสิทธิ์ผู้ใช้
    const userRights = await checkUserRights(idCard);
    const rightsMessage = userRights.length > 0 
      ? `🔑 สิทธิ์ของคุณ: ${userRights.join(', ')}` 
      : '⚠️ คุณยังไม่มีสิทธิ์ใช้งาน';

    await pushMessage(userId, [{ type: 'text', text: rightsMessage }]);

    // แจ้งเตือนเพิ่มเติมหลัง 2 วินาที
    setTimeout(async () => {
      await pushMessage(userId, [
        { type: 'text', text: '🎉 ขอบคุณที่ลงทะเบียนกับเรา\nคุณจะได้รับข้อความแจ้งเตือนสำคัญผ่าน LINE OA นี้' }
      ]);
    }, 2000);

    await logEvent('register.success', { userId, id_card: idCard, jwtToken });

  } catch (error) {
    console.error(error);
    if (error.code === 'ER_DUP_ENTRY') {
      const welcomeMessage = `✅ คุณได้ลงทะเบียนไว้แล้ว\nยินดีต้อนรับคุณ ${nameWithoutTitle} ${lastName}`;
      if (replyToken) {
        await replyMessage(replyToken, [{ type: 'text', text: welcomeMessage }]);
      } else {
        await pushMessage(userId, [{ type: 'text', text: welcomeMessage }]);
      }
      await logEvent('register.failed', { userId, id_card: idCard, reason: 'Duplicate entry' });
      return;
    }

    await replyMessage(replyToken, [
      { type: 'text', text: '❌ เกิดข้อผิดพลาดในการลงทะเบียน\nกรุณาลองใหม่อีกครั้ง' }
    ]);
    await logEvent('register.failed', { userId, id_card: idCard, reason: 'DB2 insert error' });
  }
}

module.exports = { startRegistration, processIdCardInput, replyMessage, pushMessage, checkUserRights };
