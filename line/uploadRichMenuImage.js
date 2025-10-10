const fs = require('fs');
const axios = require('axios');
require('dotenv').config();

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const richMenuId ='richmenu-e8b0e9ecc69a8e89e5ef25d071958132';
const imagePath = './line/menu.png'; // รูปเมนู

async function uploadImage() {
  try {
    const image = fs.readFileSync(imagePath);
    const response = await axios.post(
      `https://api.line.me/v2/bot/richmenu/${richMenuId}/content`,
      image,
      {
        headers: {
          'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          'Content-Type': 'image/png'
        }
      }
    );
    console.log('Rich Menu image uploaded:', response.data);
  } catch (err) {
    console.error('Error uploading image:', err.response?.data || err.message);
  }
}

uploadImage();
