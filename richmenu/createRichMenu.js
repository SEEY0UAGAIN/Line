const axios = require('axios');

const channelAccessToken = 'YOUR_CHANNEL_ACCESS_TOKEN';
const richMenuImagePath = 'path_to_your_image.jpg';

const richMenu = {
  size: { width: 800, height: 270 },
  selected: true,
  name: 'Main Menu',
  chatBarText: 'Tap here',
  areas: [
    {
      bounds: { x: 0, y: 0, width: 400, height: 270 },
      action: { type: 'message', label: 'Register', text: 'ลงทะเบียน' }
    },
    {
      bounds: { x: 400, y: 0, width: 400, height: 270 },
      action: { type: 'message', label: 'Status', text: 'ตรวจสอบสถานะ' }
    },
    {
      bounds: { x: 400, y: 0, width: 400, height: 270 },
      action: { type: 'message', label: 'Status', text: 'ติดต่อเรา' }
    }
  ]
};

// สร้าง Rich Menu
const createRichMenu = async () => {
  try {
    const response = await axios.post(
      'https://api.line.me/v2/bot/richmenu',
      richMenu,
      {
        headers: {
          'Authorization': `Bearer ${channelAccessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const richMenuId = response.data.richMenuId;
    console.log('Rich Menu ID:', richMenuId);
    return richMenuId;
  } catch (error) {
    console.error('Error creating rich menu:', error);
  }
};

// อัปโหลดภาพสำหรับ Rich Menu
const uploadRichMenuImage = async (richMenuId) => {
  try {
    const image = require('fs').createReadStream(richMenuImagePath);
    const response = await axios.post(
      `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
      image,
      {
        headers: {
          'Authorization': `Bearer ${channelAccessToken}`,
          'Content-Type': 'image/jpeg'
        }
      }
    );
    console.log('Image uploaded successfully');
  } catch (error) {
    console.error('Error uploading image:', error);
  }
};

// ตั้งค่า Rich Menu เป็น Default
const setDefaultRichMenu = async (richMenuId) => {
  try {
    await axios.post(
      `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`,
      {},
      {
        headers: {
          'Authorization': `Bearer ${channelAccessToken}`
        }
      }
    );
    console.log('Default rich menu set successfully');
  } catch (error) {
    console.error('Error setting default rich menu:', error);
  }
};

// ประมวลผลทั้งหมด
const setupRichMenu = async () => {
  const richMenuId = await createRichMenu();
  if (richMenuId) {
    await uploadRichMenuImage(richMenuId);
    await setDefaultRichMenu(richMenuId);
  }
};

setupRichMenu();
