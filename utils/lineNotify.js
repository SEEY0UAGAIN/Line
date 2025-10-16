const axios = require('axios');
const LINE_TOKEN = process.env.LINE_TOKEN; // ใส่ LINE OA Channel Access Token

async function sendLineMessage(to, message) {
    try {
        await axios.post('https://api.line.me/v2/bot/message/push', {
            to,
            messages: [{ type: 'text', text: message }]
        }, {
            headers: { Authorization: `Bearer ${LINE_TOKEN}` }
        });
    } catch (err) {
        console.error('LINE Notify Error:', err.message);
    }
}

module.exports = { sendLineMessage };
