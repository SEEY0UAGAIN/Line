// utils/validation.js

/**
 * ตรวจสอบเลขบัตรประชาชน 13 หลัก พร้อม Checksum
 */
function isValidIdCard(idCard) {
  if (!idCard || typeof idCard !== 'string') return false;
  
  const cleaned = idCard.replace(/[^0-9]/g, '');
  if (cleaned.length !== 13) return false;

  // ตรวจสอบ Checksum ตามมาตรฐานบัตรประชาชนไทย
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += parseInt(cleaned.charAt(i)) * (13 - i);
  }
  const checkDigit = (11 - (sum % 11)) % 10;
  
  return checkDigit === parseInt(cleaned.charAt(12));
}

/**
 * ตรวจสอบเบอร์โทรศัพท์ (10 หลัก เริ่มต้นด้วย 0)
 */
function isValidPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return false;
  
  const cleaned = phone.replace(/[^0-9]/g, '');
  return /^0[0-9]{9}$/.test(cleaned);
}

/**
 * ตรวจสอบวันเกิด (รูปแบบ YYYY-MM-DD หรือ DD/MM/YYYY)
 */
function isValidBirthDate(dateStr) {
  if (!dateStr) return false;

  let date;
  
  // รองรับหลายรูปแบบ
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    date = new Date(dateStr);
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    const [day, month, year] = dateStr.split('/');
    date = new Date(`${year}-${month}-${day}`);
  } else {
    return false;
  }

  // ตรวจสอบว่าเป็นวันที่ที่ถูกต้อง
  if (isNaN(date.getTime())) return false;

  // ตรวจสอบว่าไม่ใช่อนาคต และอายุไม่เกิน 150 ปี
  const today = new Date();
  const age = today.getFullYear() - date.getFullYear();
  
  return date <= today && age >= 0 && age <= 150;
}

/**
 * ตรวจสอบชื่อ-นามสกุล (ต้องมีอักขระ 2 ตัวขึ้นไป)
 */
function isValidName(name) {
  if (!name || typeof name !== 'string') return false;
  
  const cleaned = name.trim();
  return cleaned.length >= 2;
}

/**
 * แปลงวันเกิดเป็นรูปแบบ YYYY-MM-DD สำหรับ SQL
 */
function formatBirthDateForDB(dateStr) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    const [day, month, year] = dateStr.split('/');
    return `${year}-${month}-${day}`;
  }
  return null;
}

/**
 * คำนวณอายุจากวันเกิด
 */
function calculateAge(birthDate) {
  const birth = new Date(birthDate);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  
  return age;
}

/**
 * ตรวจสอบความสมบูรณ์ของข้อมูลทั้งหมด
 */
function validateRegistrationData(data) {
  const errors = [];
  
  if (!isValidName(data.firstName)) {
    errors.push('ชื่อไม่ถูกต้อง');
  }
  
  if (!isValidName(data.lastName)) {
    errors.push('นามสกุลไม่ถูกต้อง');
  }
  
  if (!isValidIdCard(data.idCard)) {
    errors.push('เลขบัตรประชาชนไม่ถูกต้อง');
  }
  
  if (!isValidBirthDate(data.birthDate)) {
    errors.push('วันเกิดไม่ถูกต้อง');
  }
  
  if (!isValidPhoneNumber(data.phone)) {
    errors.push('เบอร์โทรศัพท์ไม่ถูกต้อง');
  }
  
  if (!data.pdpaConsent) {
    errors.push('กรุณายอมรับเงื่อนไข PDPA');
  }
  
  return {
    isValid: errors.length === 0,
    errors: errors
  };
}

module.exports = {
  isValidIdCard,
  isValidPhoneNumber,
  isValidBirthDate,
  isValidName,
  formatBirthDateForDB,
  calculateAge,
  validateRegistrationData
};