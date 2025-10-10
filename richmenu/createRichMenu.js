const axios = require('axios');
require('dotenv').config();
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const fs = require('fs');

const richMenuData = {
  size: { width: 1200, height: 810 },
  selected: true,
  name: 'Main Menu',
  chatBarText: 'Tap here',
  areas: [
    { bounds: { x: 0, y: 0, width: 400, height: 810 }, action: { type: 'message', label: 'ลงทะเบียน', text: 'ลงทะเบียน' } },
    { bounds: { x: 400, y: 0, width: 400, height: 810 }, action: { type: 'message', label: 'ตรวจสอบสถานะ', text: 'ตรวจสอบสถานะ' } },
    { bounds: { x: 800, y: 0, width: 400, height: 810 }, action: { type: 'message', label: 'ติดต่อเรา', text: 'ติดต่อเรา' } }
  ]
};

async function createRichMenu() {
  const res = await axios.post('https://api.line.me/v2/bot/richmenu', richMenuData, {
    headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
  });
  return res.data.richMenuId;
}

async function uploadRichMenuImage(richMenuId, imagePath) {
  const image = fs.createReadStream(imagePath);
  await axios.post(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, image, {
    headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, 'Content-Type': 'image/jpeg' }
  });
}

async function setDefaultRichMenu(richMenuId) {
  await axios.post(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {}, {
    headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
  });
}

module.exports = { createRichMenu, uploadRichMenuImage, setDefaultRichMenu };
