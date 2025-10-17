/**
 * ไฟล์ทดสอบระบบ Pharmacy Queue Monitor
 * รัน: node testPharmacyMonitor.js
 */
const TARGET_DATE = process.env.TEST_DATE || null;
const sqlServer = require('mssql');
const { queryDB1, queryDB2 } = require('./db');
require('dotenv').config();

// สีสำหรับ console
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// ===== TEST 1: ทดสอบการเชื่อมต่อฐานข้อมูล =====
async function test1_DatabaseConnection() {
  log('cyan', '\n========== TEST 1: ทดสอบการเชื่อมต่อฐานข้อมูล ==========');
  
  try {
    // ทดสอบ MySQL
    const mysqlResult = await queryDB2('SELECT 1 as test');
    if (mysqlResult[0].test === 1) {
      log('green', '✅ MySQL connection: OK');
    }

    // ทดสอบ SQL Server
    const ssbResult = await queryDB1('SELECT 1 as test');
    if (ssbResult[0].test === 1) {
      log('green', '✅ SQL Server (SSB) connection: OK');
    }

    return true;
  } catch (error) {
    log('red', '❌ Database connection failed:');
    console.error(error);
    return false;
  }
}

// ===== TEST 2: ทดสอบดึงข้อมูลคิวจาก SSB =====
async function test2_FetchSpecificVN(vn, testDate = null) {
  log('cyan', `\n========== TEST 2: ทดสอบดึงข้อมูล VN: ${vn} ==========`);
  
  // กำหนดวันที่ทดสอบ
  let dateCondition = 'CONVERT(DATE, OM.VisitDate) = CONVERT(DATE, GETDATE())';
  if (testDate) {
    dateCondition = `CONVERT(DATE, OM.VisitDate) = '${testDate}'`;
    log('yellow', `🗓️  ค้นหาข้อมูลวันที่: ${testDate}`);
  } else {
    log('blue', '🗓️  ค้นหาข้อมูลวันนี้');
  }
  
  try {
    const sql = `
      SELECT 
        OM.VN,
        OM.HN,
        OM.VisitDate,
        OP.DrugAcknowledge,
        OP.DrugReady,
        SUBSTRING(N.FirstName, 2, 100) + ' ' + SUBSTRING(N.LastName, 2, 100) AS PatientName,
        N.ID AS IDCard,
        (SELECT ISNULL(SUBSTRING(LocalName, 2, 1000), SUBSTRING(EnglishName, 2, 1000))
         FROM DNSYSCONFIG 
         WHERE CtrlCode = '42203' AND code = OP.Clinic) AS ClinicName,
        (SELECT COUNT(*) FROM HNOPD_PRESCRIP_MEDICINE PM 
         WHERE PM.VisitDate = OP.VisitDate 
         AND PM.VN = OP.VN 
         AND PM.PrescriptionNo = OP.PrescriptionNo
         AND PM.CxlDateTime IS NULL
         AND PM.StockCode = 'NODRUG') AS NoDrugCount,
        (SELECT COUNT(*) FROM HNOPD_PRESCRIP_MEDICINE PM 
         WHERE PM.VisitDate = OP.VisitDate 
         AND PM.VN = OP.VN 
         AND PM.PrescriptionNo = OP.PrescriptionNo
         AND PM.CxlDateTime IS NULL) AS TotalDrugs,
        CASE 
          WHEN OP.DrugAcknowledge=1 AND OP.DrugReady=0 THEN 'รอจัดยา'
          WHEN OP.DrugAcknowledge=1 AND OP.DrugReady=1 THEN 'จัดยาเรียบร้อย'
          ELSE 'รอ Acknowledge'
        END AS MedicineStatus,
        OP.CloseVisitCode,
        RH.ReceiptNo,
        OM.OutDateTime
      FROM HNOPD_MASTER OM WITH (NOLOCK)
      LEFT JOIN HNOPD_PRESCRIP OP 
        ON OM.VisitDate = OP.VisitDate AND OM.VN = OP.VN
      LEFT JOIN HNName N ON OM.HN = N.HN
      LEFT JOIN HNOPD_RECEIVE_HEADER RH 
        ON OM.VisitDate = RH.VisitDate AND OM.VN = RH.VN
      WHERE OM.VN = '${vn}'
        AND ${dateCondition}
    `;

    const rows = await queryDB1(sql);
    
    if (rows.length > 0) {
      const row = rows[0];
      log('green', `✅ พบข้อมูล VN: ${vn}`);
      
      console.log('\n📋 รายละเอียด:');
      console.log(`   VN: ${row.VN}`);
      console.log(`   HN: ${row.HN}`);
      console.log(`   เลขบัตร: ${row.IDCard || '-'}`);
      console.log(`   ชื่อ: ${row.PatientName || '-'}`);
      console.log(`   คลินิก: ${row.ClinicName || '-'}`);
      console.log(`   วันที่: ${new Date(row.VisitDate).toLocaleDateString('th-TH')}`);
      console.log(`\n💊 สถานะยา:`);
      console.log(`   สถานะ: ${row.MedicineStatus}`);
      console.log(`   DrugAcknowledge: ${row.DrugAcknowledge}`);
      console.log(`   DrugReady: ${row.DrugReady}`);
      console.log(`   จำนวนยา: ${row.TotalDrugs || 0} รายการ`);
      console.log(`   ไม่มียา (NODRUG): ${row.NoDrugCount || 0} รายการ`);
      console.log(`\n📊 สถานะอื่นๆ:`);
      console.log(`   CloseVisitCode: ${row.CloseVisitCode || '-'}`);
      console.log(`   ReceiptNo: ${row.ReceiptNo || 'ยังไม่ได้จ่าย'}`);
      console.log(`   OutDateTime: ${row.OutDateTime || 'ยังไม่ออกจากระบบ'}`);
      
      // ตรวจสอบว่าผ่านเงื่อนไขคิวยาหรือไม่
      console.log(`\n✅ ตรวจสอบเงื่อนไข:`);
      const checks = {
        'DrugAcknowledge = 1': row.DrugAcknowledge === 1,
        'OutDateTime IS NULL': !row.OutDateTime,
        'CloseVisitCode IS NOT NULL': !!row.CloseVisitCode,
        'CloseVisitCode ไม่อยู่ในรายการแบน': !['ADM','C01','C02','C03','C04','C05','C06','C07','C08','C09','C10','C11','C12','C13','C14','C15'].includes(row.CloseVisitCode),
        'ReceiptNo IS NULL': !row.ReceiptNo
      };
      
      let passAll = true;
      for (const [condition, pass] of Object.entries(checks)) {
        const icon = pass ? '✅' : '❌';
        console.log(`   ${icon} ${condition}`);
        if (!pass) passAll = false;
      }
      
      if (passAll) {
        log('green', '\n🎉 VN นี้ผ่านเงื่อนไขทั้งหมด! สามารถเข้าคิวยาได้');
      } else {
        log('yellow', '\n⚠️  VN นี้ไม่ผ่านบางเงื่อนไข อาจไม่ปรากฏในคิวยา');
      }
      
      return [row];
    } else {
      log('red', `❌ ไม่พบข้อมูล VN: ${vn} ในวันที่ ${testDate || 'วันนี้'}`);
      log('yellow', '   กรุณาตรวจสอบ:');
      console.log('   1. VN ถูกต้องหรือไม่');
      console.log('   2. วันที่ถูกต้องหรือไม่');
      console.log('   3. มีข้อมูลในตาราง HNOPD_MASTER หรือไม่');
      return [];
    }
  } catch (error) {
    log('red', '❌ ดึงข้อมูลจาก SSB ไม่สำเร็จ:');
    console.error(error);
    return [];
  }
}

// ===== TEST 3: ทดสอบค้นหา LINE User ID =====
async function test3_FindLineUserId(vn, hn) {
  log('cyan', `\n========== TEST 3: ทดสอบค้นหา LINE User ID (VN: ${vn}) ==========`);
  
  try {
    // ลองหาจาก HN
    let result = await queryDB2(
      'SELECT line_user_id, full_name FROM line_registered_users WHERE hn = ? LIMIT 1',
      [hn]
    );

    if (result.length > 0) {
      log('green', `✅ พบ LINE User ID จาก HN: ${hn}`);
      console.log(`   User ID: ${result[0].line_user_id}`);
      console.log(`   ชื่อ: ${result[0].full_name}`);
      return result[0].line_user_id;
    }

    // ลองหาจาก ID Card
    const ssbQuery = `
      SELECT N.ID 
      FROM HNOPD_MASTER OM
      LEFT JOIN HNName N ON OM.HN = N.HN
      WHERE OM.VN = @vn
    `;
    const ssbRows = await queryDB1(ssbQuery, {
      vn: { type: sqlServer.VarChar, value: vn }
    });

    if (ssbRows.length > 0) {
      const idCard = ssbRows[0].ID;
      result = await queryDB2(
        'SELECT line_user_id, full_name FROM line_registered_users WHERE id_card = ? LIMIT 1',
        [idCard]
      );
      
      if (result.length > 0) {
        log('green', `✅ พบ LINE User ID จาก ID Card: ${idCard}`);
        console.log(`   User ID: ${result[0].line_user_id}`);
        console.log(`   ชื่อ: ${result[0].full_name}`);
        return result[0].line_user_id;
      }
    }

    log('yellow', `⚠️  ไม่พบ LINE User ID สำหรับ VN: ${vn}`);
    log('yellow', '   (ผู้ป่วยอาจจะยังไม่ได้ลงทะเบียน LINE OA)');
    return null;
  } catch (error) {
    log('red', '❌ ค้นหา LINE User ID ไม่สำเร็จ:');
    console.error(error);
    return null;
  }
}

// ===== TEST 4: ทดสอบบันทึกข้อมูลคิว =====
async function test4_InsertQueueTracking(vn, lineUserId, status) {
  log('cyan', `\n========== TEST 4: ทดสอบบันทึกข้อมูลคิว ==========`);
  
  try {
    // ลบข้อมูลเก่าถ้ามี (สำหรับทดสอบ)
    await queryDB2('DELETE FROM pharmacy_queue_tracking WHERE vn = ?', [vn]);

    // Insert ข้อมูลใหม่
    await queryDB2(
      `INSERT INTO pharmacy_queue_tracking 
       (vn, line_user_id, status, notified_waiting) 
       VALUES (?, ?, ?, 1)`,
      [vn, lineUserId, status]
    );

    log('green', `✅ บันทึกข้อมูลคิวสำเร็จ`);
    console.log(`   VN: ${vn}`);
    console.log(`   Status: ${status}`);

    // ดึงข้อมูลกลับมาตรวจสอบ
    const result = await queryDB2(
      'SELECT * FROM pharmacy_queue_tracking WHERE vn = ?',
      [vn]
    );

    if (result.length > 0) {
      console.log('\nข้อมูลที่บันทึก:');
      console.log(result[0]);
      return true;
    }
  } catch (error) {
    log('red', '❌ บันทึกข้อมูลคิวไม่สำเร็จ:');
    console.error(error);
    return false;
  }
}

// ===== TEST 5: ทดสอบส่งข้อความ LINE (Dry Run) =====
async function test5_TestLineMessage(lineUserId, vn) {
  log('cyan', '\n========== TEST 5: ทดสอบส่งข้อความ LINE ==========');
  
  try {
    const { sendLineMessage } = require('./utils/lineNotify');
    
    const testMessage = `🧪 ทดสอบระบบแจ้งเตือนคิวยา

📋 VN: ${vn}
⏰ เวลา: ${new Date().toLocaleString('th-TH')}

นี่คือข้อความทดสอบจากระบบ
ถ้าคุณเห็นข้อความนี้แสดงว่าระบบทำงานปกติ ✅`;

    await sendLineMessage(lineUserId, testMessage);
    
    log('green', '✅ ส่งข้อความทดสอบไปยัง LINE แล้ว');
    log('yellow', '   กรุณาตรวจสอบที่ LINE OA ว่าได้รับข้อความหรือไม่');
    return true;
  } catch (error) {
    log('red', '❌ ส่งข้อความ LINE ไม่สำเร็จ:');
    console.error(error);
    return false;
  }
}

// ===== TEST 6: ทดสอบ Full Flow =====
async function test6_FullFlow(testDate = null, specificVN = null) {
  log('cyan', '\n========== TEST 6: ทดสอบ Full Flow ==========');
  
  try {
    // 1. ดึงข้อมูลคิวจาก SSB
    log('blue', '\n1. กำลังดึงข้อมูลคิวจาก SSB...');
    let queueData;
    
    if (specificVN) {
      queueData = await test2_FetchSpecificVN(specificVN, testDate);
    } else {
      queueData = await test2_FetchQueueFromSSB(testDate);
    }
    
    if (queueData.length === 0) {
      log('yellow', '⚠️  ไม่มีข้อมูลคิวให้ทดสอบ');
      return;
    }

    // เลือก VN แรก
    const testItem = queueData[0];
    log('blue', `\n2. ใช้ VN: ${testItem.VN} สำหรับทดสอบ`);

    // 2. หา LINE User ID
    log('blue', '\n3. กำลังค้นหา LINE User ID...');
    const lineUserId = await test3_FindLineUserId(testItem.VN, testItem.HN);
    
    if (!lineUserId) {
      log('yellow', '⚠️  ไม่พบ LINE User ID');
      log('yellow', `   HN: ${testItem.HN}`);
      log('yellow', `   เลขบัตร: ${testItem.IDCard || '-'}`);
      log('yellow', '\n💡 วิธีแก้:');
      console.log('   1. ให้ผู้ป่วยลงทะเบียน LINE OA ด้วย HN หรือเลขบัตรนี้');
      console.log('   2. หรือจะข้ามไปทดสอบแค่บันทึกข้อมูลโดยไม่ส่ง LINE');
      
      log('blue', '\n4. ทดสอบบันทึกข้อมูลโดยไม่ส่ง LINE...');
      
      // ใช้ LINE User ID ปลอมสำหรับทดสอบ
      const dummyUserId = 'TEST_USER_' + testItem.VN;
      
      let status = 'waiting_medicine';
      if (testItem.DrugReady === 1) {
        status = 'medicine_ready';
      }
      
      await test4_InsertQueueTracking(testItem.VN, dummyUserId, status);
      
      log('yellow', '\n⚠️  ข้ามการส่งข้อความ LINE เพราะไม่พบ LINE User ID');
      log('green', '\n✅ ทดสอบบันทึกข้อมูลสำเร็จ (แต่ไม่ส่ง LINE)');
      return;
    }

    // 3. กำหนดสถานะ
    log('blue', '\n4. กำหนดสถานะตามข้อมูลจาก SSB...');
    let status = 'waiting_medicine';
    if (testItem.DrugReady === 1) {
      status = 'medicine_ready';
    }
    console.log(`   สถานะที่กำหนด: ${status}`);

    // 4. บันทึกข้อมูลคิว
    log('blue', '\n5. กำลังบันทึกข้อมูลคิว...');
    await test4_InsertQueueTracking(testItem.VN, lineUserId, status);

    // 5. ส่งข้อความแจ้งเตือน
    log('blue', '\n6. กำลังส่งข้อความแจ้งเตือน...');
    await test5_TestLineMessage(lineUserId, testItem.VN);

    log('green', '\n✅ ทดสอบ Full Flow สำเร็จ!');
    log('yellow', '\n📱 กรุณาตรวจสอบที่ LINE OA ว่าได้รับข้อความหรือไม่');
  } catch (error) {
    log('red', '\n❌ ทดสอบ Full Flow ไม่สำเร็จ:');
    console.error(error);
  }
}

// ===== TEST 7: ทดสอบ API Call Queue =====
async function test7_TestCallQueueAPI() {
  log('cyan', '\n========== TEST 7: ทดสอบ API Call Queue ==========');
  
  try {
    const axios = require('axios');
    const PORT = process.env.PORT || 3000;
    
    // หา VN ที่มีสถานะ medicine_ready
    const result = await queryDB2(
      'SELECT vn FROM pharmacy_queue_tracking WHERE status = "medicine_ready" LIMIT 1'
    );

    if (result.length === 0) {
      log('yellow', '⚠️  ไม่พบคิวที่มีสถานะ medicine_ready');
      log('yellow', '   กรุณาสร้างข้อมูลทดสอบก่อน (รัน test6_FullFlow)');
      return;
    }

    const testVN = result[0].vn;
    log('blue', `\nทดสอบเรียกคิว VN: ${testVN}`);

    const response = await axios.post(`http://localhost:${PORT}/api/call-pharmacy-queue`, {
      vn: testVN
    });

    if (response.data.success) {
      log('green', '✅ API Call Queue ทำงานสำเร็จ');
      log('yellow', '📱 กรุณาตรวจสอบที่ LINE OA ว่าได้รับข้อความ "ถึงคิว" หรือไม่');
    } else {
      log('red', `❌ API ตอบกลับ: ${response.data.message}`);
    }
  } catch (error) {
    log('red', '❌ ทดสอบ API ไม่สำเร็จ:');
    if (error.response) {
      console.error('Response error:', error.response.data);
    } else if (error.code === 'ECONNREFUSED') {
      log('red', '   Server ยังไม่ได้เปิด กรุณารัน: npm start');
    } else {
      console.error(error.message);
    }
  }
}

// ===== เมนูหลัก =====
async function runTests() {
  console.log('\n' + '='.repeat(60));
  log('cyan', '🧪 ระบบทดสอบ Pharmacy Queue Monitor');
  console.log('='.repeat(60));

  const args = process.argv.slice(2);
  
  // ดึงวันที่จาก argument
  let testDate = null;
  const dateArg = args.find(arg => arg.startsWith('--date='));
  if (dateArg) {
    testDate = dateArg.split('=')[1];
    log('yellow', `\n📅 ทดสอบด้วยวันที่: ${testDate}`);
  }
  
  // ดึง VN จาก argument
  let specificVN = null;
  const vnArg = args.find(arg => arg.startsWith('--vn='));
  if (vnArg) {
    specificVN = vnArg.split('=')[1];
    log('yellow', `\n🎯 ทดสอบด้วย VN: ${specificVN}`);
  }
  
  if (args.includes('--all')) {
    // รันทุก test
    await test1_DatabaseConnection();
    if (specificVN) {
      await test2_FetchSpecificVN(specificVN, testDate);
    } else {
      await test2_FetchQueueFromSSB(testDate);
    }
    await test6_FullFlow(testDate, specificVN);
  } else if (args.includes('--quick')) {
    // รัน quick test
    await test1_DatabaseConnection();
    if (specificVN) {
      await test2_FetchSpecificVN(specificVN, testDate);
    } else {
      const queueData = await test2_FetchQueueFromSSB(testDate);
      if (queueData.length > 0) {
        await test3_FindLineUserId(queueData[0].VN, queueData[0].HN);
      }
    }
  } else if (args.includes('--api')) {
    // ทดสอบ API
    await test7_TestCallQueueAPI();
  } else {
    // แสดงเมนู
    console.log('\nเลือกรูปแบบการทดสอบ:');
    console.log('  node testPharmacyMonitor.js --quick                      # ทดสอบเบื้องต้น');
    console.log('  node testPharmacyMonitor.js --all                        # ทดสอบทั้งหมด');
    console.log('  node testPharmacyMonitor.js --all --vn=265               # ทดสอบด้วย VN 265');
    console.log('  node testPharmacyMonitor.js --all --vn=265 --date=2025-01-10');
    console.log('  node testPharmacyMonitor.js --quick --vn=265             # ดูข้อมูล VN 265');
    console.log('  node testPharmacyMonitor.js --api                        # ทดสอบ API');
    
    // รัน quick test โดยอัตโนมัติ
    log('blue', '\n💡 รัน Quick Test โดยอัตโนมัติ...\n');
    await test1_DatabaseConnection();
    if (specificVN) {
      await test2_FetchSpecificVN(specificVN, testDate);
    } else {
      await test2_FetchQueueFromSSB(testDate);
    }
  }

  console.log('\n' + '='.repeat(60));
  log('cyan', '✅ การทดสอบเสร็จสิ้น');
  console.log('='.repeat(60) + '\n');
  
  process.exit(0);
}

// Run
runTests().catch(error => {
  log('red', '\n❌ เกิดข้อผิดพลาดร้ายแรง:');
  console.error(error);
  process.exit(1);
});