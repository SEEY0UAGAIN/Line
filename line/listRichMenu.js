const axios = require('axios');
require('dotenv').config();

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

async function listRichMenu() {
  try {
    const res = await axios.get('https://api.line.me/v2/bot/richmenu/list', {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    console.log(res.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
  }
}

listRichMenu();
