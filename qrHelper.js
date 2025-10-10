const QRCode = require('qrcode');

async function generateQRCode(text) {
  try {
    return await QRCode.toDataURL(text);
  } catch (error) {
    console.error('QR generation error:', error);
    return null;
  }
}

module.exports = { generateQRCode };
