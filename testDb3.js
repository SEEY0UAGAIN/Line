const { queryDB3 } = require('./db'); // import queryDB3 จากไฟล์ db ของคุณ

async function testDB3() {
  try {
    // ตัวอย่าง query เบื้องต้น
    const rows = await queryDB3('SELECT * FROM paymentq LIMIT 5');
    console.log('✅ DB3 connected successfully!');
    console.log('Sample data:', rows);
  } catch (error) {
    console.error('❌ DB3 connection failed:', error.message);
  }
}

testDB3();
