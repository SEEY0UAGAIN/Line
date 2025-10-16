const { startRegistration, replyMessage, checkUserRights } = require('./messageHandler');
const { queryDB2 } = require('../db');
const { formatRightsMessage } = require('../utils/rightsMapper'); // ← เพิ่มบรรทัดนี้

async function handlePostback(event) {
  const userId = event.source.userId;
  const data = event.postback.data;
  const replyToken = event.replyToken;

  if (data === 'action=register') {
    await startRegistration(userId, replyToken);
  } else if (data === 'action=check_status') {
    const rows = await queryDB2('SELECT * FROM line_registered_users WHERE line_user_id = ?', [userId]);
    if (rows.length > 0) {
      const idCard = rows[0].id_card;
      const userRights = await checkUserRights(idCard);
      const rightsMessage = formatRightsMessage(userRights); // ← ใช้ฟังก์ชัน formatRightsMessage

      await replyMessage(replyToken, [
        { type: 'text', text: rightsMessage }
      ]);
    } else {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ คุณยังไม่ได้ลงทะเบียน' }]);
    }
  }
}

module.exports = { handlePostback };