const axios = require('axios');
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN; // ใส่ LINE OA Channel Access Token

async function sendLineMessage(to, message) {
    try {
        const payload = {
            to,
            messages: [
                {
                    type: 'text',
                    text: message
                }
            ]
        };

        const res = await axios.post('https://api.line.me/v2/bot/message/push', payload, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${LINE_TOKEN}`
            }
        });

        console.log('LINE Push success', res.data);
    } catch (err) {
        console.error('LINE Push Error:', err.response?.data || err.message);
    }
}

module.exports = { sendLineMessage };


