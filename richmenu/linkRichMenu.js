const axios = require('axios');
require('dotenv').config();
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

async function linkRichMenuToUser(userId, richMenuId) {
  try {
    await axios.post(
      `https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`,
      {},
      { headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    console.log(`Linked Rich Menu to user ${userId}`);
  } catch (err) {
    console.error(err.response?.data || err.message);
  }
}

module.exports = { linkRichMenuToUser };