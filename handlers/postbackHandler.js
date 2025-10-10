const { startRegistration } = require('./messageHandler');
const { replyMessage } = require('./messageHandler');
const redisClient = require('../redisClient');
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
      await replyMessage(replyToken, [{ type: 'text', text: '✅ คุณได้ลงทะเบียนแล้ว' }]);
    } else {
      await replyMessage(replyToken, [{ type: 'text', text: '❌ คุณยังไม่ได้ลงทะเบียน' }]);
    }
  }
}

module.exports = { handlePostback };
