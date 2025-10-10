const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const TEST_USER_ID = process.env.TEST_USER_ID || 'Udc23cd2351bf610b189e17a73a3c722c'; // ใส่ userId ของคุณ
const RICH_MENU_IMAGE_PATH = 'main_menu.jpg'; // ภาพเมนู
const RICH_MENU_NAME = 'Main Menu';

const headers = { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` };

// ข้อมูล Rich Menu
const richMenu = {
  size: { width: 1200, height: 810 },
  selected: true,
  name: RICH_MENU_NAME,
  chatBarText: 'Tap here',
  areas: [
    {
      bounds: { x: 0, y: 0, width: 400, height: 810 },
      action: { type: 'message', label: 'Register', text: 'ลงทะเบียน' }
    },
    {
      bounds: { x: 400, y: 0, width: 400, height: 810 },
      action: { type: 'message', label: 'Status', text: 'ตรวจสอบสถานะ' }
    },
    {
      bounds: { x: 800, y: 0, width: 400, height: 810 },
      action: { type: 'message', label: 'Contact', text: 'ติดต่อเจ้าหน้าที่' }
    }
  ]
};

// สร้าง Rich Menu
async function createRichMenu() {
  try {
    const res = await axios.post('https://api.line.me/v2/bot/richmenu', richMenu, {
      headers: { ...headers, 'Content-Type': 'application/json' }
    });
    console.log('Created Rich Menu ID:', res.data.richMenuId);
    return res.data.richMenuId;
  } catch (err) {
    console.error('Error creating rich menu:', err.response?.data || err.message);
  }
}

// อัปโหลดภาพ
async function uploadRichMenuImage(richMenuId) {
  try {
    const image = fs.createReadStream(RICH_MENU_IMAGE_PATH);
    await axios.post(
      `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
      image,
      { headers: { ...headers, 'Content-Type': 'image/jpeg' } }
    );
    console.log('Image uploaded successfully');
  } catch (err) {
    console.error('Error uploading image:', err.response?.data || err.message);
  }
}

// ตั้ง Default Rich Menu
async function setDefaultRichMenu(richMenuId) {
  try {
    await axios.post(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {}, { headers });
    console.log('Default rich menu set successfully');
  } catch (err) {
    console.error('Error setting default rich menu:', err.response?.data || err.message);
  }
}

// ลิงก์ Rich Menu ให้ user
async function linkRichMenuToUser(userId, richMenuId) {
  try {
    await axios.post(`https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`, {}, { headers });
    console.log(`Linked Rich Menu to user ${userId}`);
  } catch (err) {
    console.error(`Error linking Rich Menu to user ${userId}:`, err.response?.data || err.message);
  }
}

// ตรวจสอบ Rich Menu ปัจจุบัน
async function listRichMenus() {
  try {
    const res = await axios.get('https://api.line.me/v2/bot/richmenu/list', { headers });
    console.log('===== All Rich Menus =====');
    res.data.richmenus.forEach((menu, i) => {
      console.log(`${i + 1}. ID: ${menu.richMenuId} | Name: ${menu.name} | Selected: ${menu.selected}`);
    });
    return res.data.richmenus;
  } catch (err) {
    console.error('Error listing rich menus:', err.response?.data || err.message);
  }
}

// รันทั้งหมด
async function main() {
  let richMenuId;
  const menus = await listRichMenus();

  // ถ้ามีชื่อเดียวกันให้ใช้ของเก่า ไม่สร้างซ้ำ
  const existing = menus.find(m => m.name === RICH_MENU_NAME);
  if (existing) {
    richMenuId = existing.richMenuId;
    console.log('Using existing Rich Menu:', richMenuId);
    await uploadRichMenuImage(richMenuId);
  } else {
    richMenuId = await createRichMenu();
    await uploadRichMenuImage(richMenuId);
  }

  await setDefaultRichMenu(richMenuId);

  if (TEST_USER_ID) {
    await linkRichMenuToUser(TEST_USER_ID, richMenuId);
  }

  console.log('✅ Rich Menu setup completed');
}

main();
