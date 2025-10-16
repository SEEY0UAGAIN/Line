const { startRegistration, replyMessage, checkUserRights } = require('./messageHandler');
const { queryDB2 } = require('../db');

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
      const rightsMessage = userRights.length > 0 
        ? `🔑 สิทธิ์ของคุณ: ${userRights.join(', ')}` 
        : '⚠️ คุณยังไม่มีสิทธิ์ใช้งาน';

      await replyMessage(replyToken, [
        { type: 'text', text: '✅ คุณได้ลงทะเบียนแล้ว' },
        { type: 'text', text: rightsMessage }
      ]);
    } else {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ คุณยังไม่ได้ลงทะเบียน' }]);
    }
  }
}

module.exports = { handlePostback };
