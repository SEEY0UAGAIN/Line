const axios = require('axios');
require('dotenv').config();

const LINE_API = 'https://api.line.me/v2/bot/message/reply';
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

async function sendQuickReply(replyToken) {
  const message = {
    replyToken,
    messages: [
      {
        type: 'text',
        text: 'เลือกเมนูที่ต้องการ',
        quickReply: {
          items: [
            {
              type: 'action',
              action: {
                type: 'message',
                label: 'ลงทะเบียน',
                text: 'ลงทะเบียน'
              }
            },
            {
              type: 'action',
              action: {
                type: 'message',
                label: 'ตรวจสอบสิทธิ์',
                text: 'ตรวจสอบสิทธิ์'
              }
            },
            {
              type: 'action',
              action: {
                type: 'message',
                label: 'ติดต่อเจ้าหน้าที่',
                text: 'ติดต่อเจ้าหน้าที่'
              }
            }
          ]
        }
      }
    ]
  };

  await axios.post(LINE_API, message, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    }
  });
}

module.exports = sendQuickReply;
