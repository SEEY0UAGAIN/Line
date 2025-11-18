// handlers/verifyLineHandler.js
const { issueVerifyToken } = require('./verifyHandler');
const { replyMessage } = require('./messageHandler');
const QRCode = require('qrcode');
const Jimp = require('jimp').Jimp;
const path = require('path');
const fs = require('fs');

function cleanupOldQRs() {
  const dir = path.join(__dirname, '../frontend/qr');
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  fs.readdirSync(dir).forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs > oneDay) {
      fs.unlinkSync(filePath);
    }
  });
}

// เรียกทุก 6 ชั่วโมง
setInterval(cleanupOldQRs, 6 * 60 * 60 * 1000);

async function sendVerifyQR(userId, replyToken, patientInfo) {
  try {
    // ✅ 1) สร้าง token + jti สำหรับระบุไฟล์
    const { token, jti } = await issueVerifyToken({
      cid: patientInfo.id_card,
      dob: patientInfo.birth_date,
      name: patientInfo.full_name || `${patientInfo.first_name || ''} ${patientInfo.last_name || ''}`.trim(),
      right_name: patientInfo.right_name || 'ยังไม่ตรวจสอบ',
      phone_mask: patientInfo.phone || '',
      line_user_id: userId
    });

    // ✅ 2) สร้าง QR พื้นฐานเป็น buffer
    const qrBuffer = await QRCode.toBuffer(token, {
      width: 600,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });

    // ✅ 3) โหลดภาพ QR และโลโก้ด้วย Jimp
    const qrImage = await Jimp.read(qrBuffer);
    const logoPath = path.join(__dirname, '../frontend/logo.png'); // โลโก้ของคุณ
    const logo = await Jimp.read(logoPath);

    // ✅ 4) ปรับขนาดโลโก้ให้เหมาะสม (เช่น 1/5 ของ QR)
    const logoSize = qrImage.bitmap.width / 5;
    await logo.resize({ w: logoSize, h: logoSize });

    // ✅ 5) วางโลโก้ตรงกลาง
    const x = (qrImage.bitmap.width - logo.bitmap.width) / 2;
    const y = (qrImage.bitmap.height - logo.bitmap.height) / 2;
    qrImage.composite(logo, x, y);

    // ✅ 6) บันทึกเป็นไฟล์ PNG
    const qrDir = path.join(__dirname, '../frontend/qr');
    if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

    const filePath = path.join(qrDir, `${jti}.png`);
    await qrImage.write(filePath);

    // ✅ 7) สร้าง URL ที่ LINE โหลดได้
    const baseUrl = process.env.BASE_URL;
    const qrUrl = `${baseUrl}/frontend/qr/${jti}.png`;

    // ✅ 8) ส่งกลับให้ผู้ใช้ใน LINE
    await replyMessage(replyToken, [
      {
        type: 'image',
        originalContentUrl: qrUrl,
        previewImageUrl: qrUrl
      },
      {
        type: 'text',
        text: `✅ ตรวจสิทธิ์ล่วงหน้าสำเร็จ!\n\nกรุณาแสดง QR นี้ที่คีออสก์หรือเคาน์เตอร์เมื่อตรวจจริง\n⏰ QR มีอายุ 24 ชั่วโมง`
      }
    ]);

  } catch (err) {
    console.error('❌ sendVerifyQR error:', err);
    await replyMessage(replyToken, [
      { type: 'text', text: '❌ ไม่สามารถสร้าง QR ได้ กรุณาลองใหม่ภายหลัง' }
    ]);
  }
}

module.exports = { sendVerifyQR };
