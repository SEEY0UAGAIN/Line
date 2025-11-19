const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const TEST_USER_ID = process.env.TEST_USER_ID; // ใส่ userId ของคุณ
const RICH_MENU_IMAGE_PATH = 'main_menuV1.2.jpg'; // ภาพเมนู
const RICH_MENU_NAME = 'Main Menu V2.1';

const headers = { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` };

// ข้อมูล Rich Menu
const richMenu = {
  size: { width: 1200, height: 810 },
  selected: true,
  name: RICH_MENU_NAME,
  chatBarText: 'Tap here',
  areas: [
    // 🔹 ปุ่มบนสุด ตรวจสิทธิ์ล่วงหน้า
    {
      bounds: { x: 0, y: 0, width: 1200, height: 250 },
      action: { type: 'message', label: 'ตรวจสิทธิ์ล่วงหน้า', text: 'ตรวจสิทธิ์ล่วงหน้า' }
    },
    // 🔹 แถวล่าง 3 ปุ่ม
    {
      bounds: { x: 0, y: 250, width: 400, height: 560 },
      action: { type: 'message', label: 'ลงทะเบียน', text: 'ลงทะเบียน' }
    },
    {
      bounds: { x: 400, y: 250, width: 400, height: 560 },
      action: { type: 'message', label: 'สถานะของฉัน', text: 'สถานะของฉัน' }
    },
    {
      bounds: { x: 800, y: 250, width: 400, height: 560 },
      action: { type: 'message', label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' }
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
  const menus = await listRichMenus();

  // 🔥 1) ลบเมนูทั้งหมดที่ชื่อเหมือนกัน
  for (const m of menus) {
    if (m.name === RICH_MENU_NAME) {
      await axios.delete(
        `https://api.line.me/v2/bot/richmenu/${m.richMenuId}`,
        { headers }
      );
      console.log(`Deleted old rich menu: ${m.richMenuId}`);
    }
  }

  // 🆕 2) สร้าง Rich Menu ใหม่เสมอ (ไม่ใช้เมนูเก่าอีก)
  console.log("Creating new Rich Menu...");
  const newMenuId = await createRichMenu();

  // 🖼 3) อัปโหลดรูป
  console.log("Uploading image...");
  await uploadRichMenuImage(newMenuId);

  // ⭐ 4) ตั้ง default Rich Menu
  await setDefaultRichMenu(newMenuId);

  // 👤 5) ผูกเมนูกับ TEST USER (ถ้ามี)
  if (TEST_USER_ID) {
    await linkRichMenuToUser(TEST_USER_ID, newMenuId);
  }

  console.log("✅ Rich Menu setup completed");
}


main();
