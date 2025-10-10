const axios = require('axios');
require('dotenv').config();

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const TEST_USER_ID = process.env.TEST_USER_ID || 'Udc23cd2351bf610b189e17a73a3c722c'; // ใส่ userId ของคุณถ้าต้องการตรวจสอบเฉพาะ user

const headers = {
  Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`
};

// ตรวจสอบ Rich Menu ทั้งหมด
async function listRichMenus() {
  try {
    const res = await axios.get('https://api.line.me/v2/bot/richmenu/list', { headers });
    console.log('===== All Rich Menus =====');
    res.data.richmenus.forEach((menu, i) => {
      console.log(`${i + 1}. ID: ${menu.richMenuId}`);
      console.log(`   Name: ${menu.name}`);
      console.log(`   Selected (Default): ${menu.selected}`);
      console.log(`   Size: ${menu.size.width}x${menu.size.height}`);
      console.log('------------------------');
    });
    return res.data.richmenus;
  } catch (err) {
    console.error('Error listing rich menus:', err.response?.data || err.message);
  }
}

// ตรวจสอบว่า Default Rich Menu คืออะไร
async function getDefaultRichMenu() {
  try {
    const res = await axios.get('https://api.line.me/v2/bot/user/all/richmenu', { headers });
    console.log('Default Rich Menu ID for all users:', res.data.richMenuId);
  } catch (err) {
    console.error('Error getting default rich menu:', err.response?.data || err.message);
  }
}

// ตรวจสอบว่า user เฉพาะถูก link กับ Rich Menu หรือไม่
async function checkUserRichMenu(userId) {
  try {
    const res = await axios.get(`https://api.line.me/v2/bot/user/${userId}/richmenu`, { headers });
    console.log(`User ${userId} is linked to Rich Menu: ${res.data.richMenuId}`);
  } catch (err) {
    console.error(`Error checking user ${userId}:`, err.response?.data || err.message);
  }
}

// ประมวลผลทั้งหมด
async function main() {
  await listRichMenus();
  await getDefaultRichMenu();
  if (TEST_USER_ID) {
    await checkUserRichMenu(TEST_USER_ID);
  }
}

main();
