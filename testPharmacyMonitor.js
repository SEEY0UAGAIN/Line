/**
 * ไฟล์ทดสอบระบบ Pharmacy Queue Monitor (ปรับให้ตรงกับ code ที่อัพเดท)
 * รัน: node testPharmacyMonitor.js
 */
const sqlServer = require('mssql');
const { queryDB1, queryDB2, queryDB3 } = require('./db');
const { sendLineMessage } = require('./utils/lineNotify');
const { logEvent } = require('./auditLog');
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

// ===== ฟังก์ชันจาก code.txt (นำมาใช้ในการทดสอบ) =====

/**
 * ดึงข้อมูลคิวยาจาก SSB (ตรงกับ code ที่อัพเดท - drug.txt conditions)
 */
async function fetchPharmacyQueueFromSSB() {
  try {
    const sql = `
      SELECT DISTINCT 
        HNOPD_MASTER.VN,
        HNOPD_MASTER.HN,
        HNOPD_PRESCRIP.DrugAcknowledge,
        HNOPD_PRESCRIP.DrugReady,
        HNOPD_PRESCRIP_MEDICINE.StockCode,
        HNOPD_PRESCRIP_MEDICINE.FacilityRequestMethod,
        HNOPD_PRESCRIP.CloseVisitCode,
        HNOPD_PRESCRIP.ApprovedByUserCode,
        HNOPD_RECEIVE_HEADER.ReceiptNo,
        HNOPD_MASTER.OutDateTime,
        SUBSTRING(dbo.HNPAT_NAME.FirstName, 2, 100) + ' ' + SUBSTRING(dbo.HNPAT_NAME.LastName, 2, 100) AS PatientName,
        HNOPD_PRESCRIP.Clinic,
        (SELECT ISNULL(SUBSTRING(LocalName, 2, 1000), SUBSTRING(EnglishName, 2, 1000))
         FROM DNSYSCONFIG 
         WHERE CtrlCode = '42203' AND code = HNOPD_PRESCRIP.Clinic) AS ClinicName,
        CASE 
          WHEN HNOPD_PRESCRIP.DrugAcknowledge=1 AND HNOPD_PRESCRIP.DrugReady=0 AND HNOPD_PRESCRIP_MEDICINE.StockCode != 'NODRUG' AND HNOPD_PRESCRIP_MEDICINE.FacilityRequestMethod IS NULL THEN 'รอจัดยา'
          WHEN HNOPD_PRESCRIP.DrugAcknowledge=1 AND HNOPD_PRESCRIP.DrugReady=1 AND HNOPD_PRESCRIP_MEDICINE.StockCode != 'NODRUG' AND HNOPD_PRESCRIP_MEDICINE.FacilityRequestMethod IS NULL THEN 'จัดยาเรียบร้อย'
          ELSE 'ไม่มียา'
        END AS MedicineStatus
      FROM HNOPD_MASTER WITH (NOLOCK)
      LEFT OUTER JOIN HNOPD_PRESCRIP 
        ON HNOPD_MASTER.VisitDate=HNOPD_PRESCRIP.VisitDate 
        AND HNOPD_MASTER.VN=HNOPD_PRESCRIP.VN
      LEFT OUTER JOIN HNOPD_RECEIVE_HEADER 
        ON HNOPD_MASTER.VisitDate=HNOPD_RECEIVE_HEADER.VisitDate 
        AND HNOPD_MASTER.VN=HNOPD_RECEIVE_HEADER.VN
      LEFT OUTER JOIN HNOPD_PRESCRIP_MEDICINE 
        ON HNOPD_PRESCRIP.VisitDate=HNOPD_PRESCRIP_MEDICINE.VisitDate 
        AND HNOPD_PRESCRIP.VN=HNOPD_PRESCRIP_MEDICINE.VN 
        AND HNOPD_PRESCRIP.PrescriptionNo=HNOPD_PRESCRIP_MEDICINE.PrescriptionNo
      LEFT OUTER JOIN HNPAT_NAME 
        ON HNOPD_MASTER.HN=HNPAT_NAME.HN
      WHERE HNOPD_MASTER.Cxl=0
        AND CONVERT(DATE, HNOPD_MASTER.VisitDate) = CONVERT(DATE, GETDATE())
        AND (SELECT ISNULL(SUBSTRING(LocalName, 2, 1000), SUBSTRING(EnglishName, 2, 1000))
             FROM DNSYSCONFIG 
             WHERE CtrlCode = '42203' AND code = HNOPD_PRESCRIP.Clinic) NOT LIKE '%SC%'
        AND HNOPD_PRESCRIP.Clinic NOT IN ('99994','150043','SCKTB','999911','14009','150042','99999')
        AND HNOPD_MASTER.OutDateTime IS NULL
        AND HNOPD_PRESCRIP.CloseVisitCode IS NOT NULL
        AND HNOPD_PRESCRIP.CloseVisitCode NOT IN ('ADM','C01','C02','C03','C04','C05','C06','C07','C08','C09','C10','C11','C12','C13','C14','C15')
        AND HNOPD_RECEIVE_HEADER.ReceiptNo IS NULL
        AND HNOPD_PRESCRIP_MEDICINE.CxlDateTime IS NULL
        AND HNPAT_NAME.SuffixSmall=0
        AND HNOPD_PRESCRIP.ApprovedByUserCode IS NOT NULL
        AND HNOPD_PRESCRIP.DrugAcknowledge=1
    `;

    const rows = await queryDB1(sql);
    return rows;
  } catch (error) {
    console.error('Error fetching pharmacy queue from SSB:', error);
    return [];
  }
}

/**
 * ดึงข้อมูล LINE User ID จาก VN (เหมือน code.txt)
 */
async function getLineUserIdByVN(vn, hn) {
  try {
    // ลองหา LINE User ID จาก HN ก่อน
    const result = await queryDB2(
      `SELECT line_user_id, id_card 
       FROM line_registered_users 
       WHERE hn = ? 
       LIMIT 1`,
      [hn]
    );

    if (result.length > 0) {
      return result[0].line_user_id;
    }

    // ถ้าไม่เจอ ลองหาจาก ID Card ใน SSB
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
      const lineUserResult = await queryDB2(
        'SELECT line_user_id FROM line_registered_users WHERE id_card = ? LIMIT 1',
        [idCard]
      );
      
      if (lineUserResult.length > 0) {
        return lineUserResult[0].line_user_id;
      }
    }

    return null;
  } catch (error) {
    console.error(`Error getting LINE User ID for VN ${vn}:`, error);
    return null;
  }
}

/**
 * กำหนดสถานะของคิวตามข้อมูลจาก SSB (เหมือน code.txt)
 */
function determineStatus(item) {
  const { DrugAcknowledge, DrugReady, StockCode, FacilityRequestMethod, ReceiptNo, OutDateTime } = item;
  
  // ไม่มียา
  if (StockCode === 'NODRUG' || FacilityRequestMethod !== null) {
    return 'completed';
  }
  
  // ยาพร้อม
  if (DrugAcknowledge === 1 && DrugReady === 1 && StockCode !== 'NODRUG' && !FacilityRequestMethod && !ReceiptNo && !OutDateTime) {
    return 'medicine_ready';
  }
  
  // รอจัดยา
  if (DrugAcknowledge === 1 && DrugReady === 0 && StockCode !== 'NODRUG' && !FacilityRequestMethod) {
    return 'waiting_medicine';
  }
  
  // ชำระเงินแล้วหรือออกจากระบบ
  if (ReceiptNo || OutDateTime) {
    return 'completed';
  }
  
  return 'waiting_medicine'; // default
}

/**
 * ดึงข้อมูลจาก paymentq ใน DB3 (เหมือน code.txt)
 */
async function fetchPaymentQueueFromDB3() {
  try {
    const sql = `
      SELECT id, vn, payment_slot, name, medicine, clinic_name, sub, created_at
      FROM paymentq
      WHERE DATE(created_at) = CURDATE()
      ORDER BY created_at DESC
      LIMIT 200
    `;
    const rows = await queryDB3(sql);
    return rows;
  } catch (err) {
    console.error('Error fetching payment queue from DB3:', err);
    return [];
  }
}

// ===== TEST CASES =====

/**
 * TEST 1: ทดสอบการเชื่อมต่อฐานข้อมูล
 */
async function test1_DatabaseConnection() {
  log('cyan', '\n========== TEST 1: ทดสอบการเชื่อมต่อฐานข้อมูล ==========');
  
  try {
    // ทดสอบ MySQL (DB2)
    const mysqlResult = await queryDB2('SELECT 1 as test');
    if (mysqlResult[0].test === 1) {
      log('green', '✅ MySQL (DB2) connection: OK');
    }

    // ทดสอบ SQL Server (SSB/DB1)
    const ssbResult = await queryDB1('SELECT 1 as test');
    if (ssbResult[0].test === 1) {
      log('green', '✅ SQL Server (SSB/DB1) connection: OK');
    }

    // ทดสอบ MySQL (DB3)
    try {
      const db3Result = await queryDB3('SELECT 1 as test');
      if (db3Result[0].test === 1) {
        log('green', '✅ MySQL (DB3 - qfinancialtest) connection: OK');
      }
    } catch (e) {
      log('yellow', '⚠️  DB3 connection failed (จะข้าม Payment Queue test)');
    }

    return true;
  } catch (error) {
    log('red', '❌ Database connection failed:');
    console.error(error);
    return false;
  }
}

/**
 * TEST 2: ทดสอบดึงข้อมูลคิวยาจาก SSB (ตามเงื่อนไขใหม่)
 */
async function test2_FetchPharmacyQueue() {
  log('cyan', '\n========== TEST 2: ทดสอบดึงข้อมูลคิวยา (เงื่อนไข drug.txt) ==========');
  
  try {
    const queueData = await fetchPharmacyQueueFromSSB();
    
    if (queueData.length > 0) {
      log('green', `✅ พบข้อมูลคิว: ${queueData.length} รายการ`);
      
      // แสดง 5 รายการแรก
      console.log('\n📋 ตัวอย่างข้อมูล (5 รายการแรก):');
      queueData.slice(0, 5).forEach((item, idx) => {
        console.log(`\n--- รายการที่ ${idx + 1} ---`);
        console.log(`VN: ${item.VN}`);
        console.log(`HN: ${item.HN}`);
        console.log(`ชื่อ: ${item.PatientName || '-'}`);
        console.log(`คลินิก: ${item.ClinicName || '-'} (${item.Clinic})`);
        console.log(`สถานะ: ${item.MedicineStatus}`);
        console.log(`DrugAcknowledge: ${item.DrugAcknowledge}`);
        console.log(`DrugReady: ${item.DrugReady}`);
        console.log(`StockCode: ${item.StockCode || '-'}`);
        console.log(`FacilityRequestMethod: ${item.FacilityRequestMethod || 'NULL'}`);
        console.log(`ApprovedByUserCode: ${item.ApprovedByUserCode || '-'}`);
        
        // แสดงสถานะที่จะถูกกำหนด
        const determinedStatus = determineStatus(item);
        console.log(`➡️  สถานะที่กำหนด: ${determinedStatus}`);
      });
      
      // สรุปเงื่อนไข
      console.log('\n📊 สรุปการกรอง:');
      console.log(`   ✓ Clinic NOT LIKE '%SC%'`);
      console.log(`   ✓ Clinic NOT IN ('99994','150043','SCKTB','999911','14009','150042','99999')`);
      console.log(`   ✓ ApprovedByUserCode IS NOT NULL`);
      console.log(`   ✓ DrugAcknowledge = 1`);
      console.log(`   ✓ ยกเว้น FacilityRequestMethod และ NODRUG`);
      
      return queueData;
    } else {
      log('yellow', '⚠️  ไม่พบข้อมูลคิวในขณะนี้');
      log('yellow', '   เหตุผลที่เป็นไปได้:');
      console.log('   - ไม่มีผู้ป่วยที่ตรงเงื่อนไข');
      console.log('   - คลินิกเป็น SC หรือในรายการยกเว้น');
      console.log('   - ยังไม่ได้ ApprovedByUserCode');
      console.log('   - ยังไม่ได้ DrugAcknowledge');
      return [];
    }
  } catch (error) {
    log('red', '❌ ดึงข้อมูลจาก SSB ไม่สำเร็จ:');
    console.error(error);
    return [];
  }
}

/**
 * TEST 3: ทดสอบส่งข้อความแจ้งเตือน "รอจัดยา"
 */
async function test3_SendWaitingMedicineMessage(item, lineUserId, dryRun = false) {
  log('cyan', '\n========== TEST 3: ทดสอบส่งข้อความ "รอจัดยา" ==========');
  
  try {
    const { VN, PatientName, ClinicName } = item;
    
    const message = `⏳ รอจัดยา

📋 VN: ${VN}
👤 ชื่อ: ${PatientName || '-'}
🏥 คลินิก: ${ClinicName || '-'}

กรุณารอสักครู่ ระบบกำลังจัดเตรียมยาให้คุณ`;

    if (dryRun) {
      log('blue', '\n📱 ข้อความที่จะส่ง (DRY RUN):');
      console.log(message);
      log('yellow', '\n⚠️  ไม่ได้ส่งจริง (DRY RUN MODE)');
      return true;
    }

    await sendLineMessage(lineUserId, message);
    
    // บันทึกสถานะ
    const tracking = await queryDB2(
      'SELECT * FROM pharmacy_queue_tracking WHERE vn = ?',
      [VN]
    );

    if (tracking.length === 0) {
      await queryDB2(
        `INSERT INTO pharmacy_queue_tracking 
         (vn, line_user_id, status, notified_waiting) 
         VALUES (?, ?, ?, 1)`,
        [VN, lineUserId, 'waiting_medicine']
      );
    } else {
      await queryDB2(
        'UPDATE pharmacy_queue_tracking SET status = ?, notified_waiting = 1, updated_at = NOW() WHERE vn = ?',
        ['waiting_medicine', VN]
      );
    }

    await logEvent('pharmacy.queue.waiting', { vn: VN, line_user_id: lineUserId });

    log('green', '✅ ส่งข้อความ "รอจัดยา" สำเร็จ');
    return true;
  } catch (error) {
    log('red', '❌ ส่งข้อความไม่สำเร็จ:');
    console.error(error);
    return false;
  }
}

/**
 * TEST 4: ทดสอบส่งข้อความแจ้งเตือน "ยาพร้อม"
 */
async function test4_SendMedicineReadyMessage(item, lineUserId, dryRun = false) {
  log('cyan', '\n========== TEST 4: ทดสอบส่งข้อความ "ยาพร้อม" ==========');
  
  try {
    const { VN, PatientName, ClinicName } = item;
    
    const message = `✅ ยาของคุณพร้อมแล้ว!

📋 VN: ${VN}
👤 ชื่อ: ${PatientName || '-'}
🏥 คลินิก: ${ClinicName || '-'}

กรุณารอเรียกคิวที่หน้าช่องจ่ายยา
ระบบจะแจ้งเตือนเมื่อถึงคิวของคุณ 🔔`;

    if (dryRun) {
      log('blue', '\n📱 ข้อความที่จะส่ง (DRY RUN):');
      console.log(message);
      log('yellow', '\n⚠️  ไม่ได้ส่งจริง (DRY RUN MODE)');
      return true;
    }

    await sendLineMessage(lineUserId, message);
    
    // อัพเดทสถานะ
    await queryDB2(
      'UPDATE pharmacy_queue_tracking SET status = ?, notified_ready = 1, updated_at = NOW() WHERE vn = ?',
      ['medicine_ready', VN]
    );

    await logEvent('pharmacy.queue.ready', { vn: VN, line_user_id: lineUserId });

    log('green', '✅ ส่งข้อความ "ยาพร้อม" สำเร็จ');
    return true;
  } catch (error) {
    log('red', '❌ ส่งข้อความไม่สำเร็จ:');
    console.error(error);
    return false;
  }
}

/**
 * TEST 5: ทดสอบส่งข้อความแจ้งเตือน "ไม่มียา"
 */
async function test5_SendNoDrugMessage(item, lineUserId, dryRun = false) {
  log('cyan', '\n========== TEST 5: ทดสอบส่งข้อความ "ไม่มียา" ==========');
  
  try {
    const { VN, PatientName } = item;
    
    const message = `ℹ️ แจ้งเตือน

📋 VN: ${VN}
👤 ชื่อ: ${PatientName || '-'}

คุณไม่มียาที่ต้องรับในครั้งนี้
กรุณาติดต่อเจ้าหน้าที่หากมีข้อสงสัย`;

    if (dryRun) {
      log('blue', '\n📱 ข้อความที่จะส่ง (DRY RUN):');
      console.log(message);
      log('yellow', '\n⚠️  ไม่ได้ส่งจริง (DRY RUN MODE)');
      return true;
    }

    await sendLineMessage(lineUserId, message);
    
    // บันทึกสถานะ
    const tracking = await queryDB2(
      'SELECT * FROM pharmacy_queue_tracking WHERE vn = ?',
      [VN]
    );

    if (tracking.length === 0) {
      await queryDB2(
        `INSERT INTO pharmacy_queue_tracking 
         (vn, line_user_id, status, notified_waiting, notified_ready) 
         VALUES (?, ?, ?, 1, 1)`,
        [VN, lineUserId, 'completed']
      );
    } else {
      await queryDB2(
        'UPDATE pharmacy_queue_tracking SET status = ?, updated_at = NOW() WHERE vn = ?',
        ['completed', VN]
      );
    }

    await logEvent('pharmacy.queue.no_drug', { vn: VN, line_user_id: lineUserId });

    log('green', '✅ ส่งข้อความ "ไม่มียา" สำเร็จ');
    return true;
  } catch (error) {
    log('red', '❌ ส่งข้อความไม่สำเร็จ:');
    console.error(error);
    return false;
  }
}

/**
 * TEST 6: ทดสอบส่งข้อความแจ้งเตือน "ถึงคิว" (จากหน้าจอ)
 */
async function test6_SendQueueCalledMessage(vn, dryRun = false) {
  log('cyan', '\n========== TEST 6: ทดสอบส่งข้อความ "ถึงคิว" ==========');
  
  try {
    // ดึง LINE User ID
    const tracking = await queryDB2(
      'SELECT line_user_id FROM pharmacy_queue_tracking WHERE vn = ? AND status = "medicine_ready"',
      [vn]
    );

    if (tracking.length === 0) {
      log('red', '❌ ไม่พบคิวหรือสถานะไม่ใช่ medicine_ready');
      return false;
    }

    const lineUserId = tracking[0].line_user_id;

    const message = `🔔 ถึงคิวของคุณแล้ว!

📋 VN: ${vn}

กรุณามารับยาที่ช่องจ่ายยาด้วยค่ะ`;

    if (dryRun) {
      log('blue', '\n📱 ข้อความที่จะส่ง (DRY RUN):');
      console.log(message);
      log('yellow', '\n⚠️  ไม่ได้ส่งจริง (DRY RUN MODE)');
      return true;
    }

    await sendLineMessage(lineUserId, message);

    // อัพเดทสถานะเป็น called
    await queryDB2(
      'UPDATE pharmacy_queue_tracking SET status = "called", updated_at = NOW() WHERE vn = ?',
      [vn]
    );

    await logEvent('pharmacy.queue.called', { vn, line_user_id: lineUserId });

    log('green', '✅ ส่งข้อความ "ถึงคิว" สำเร็จ');
    return true;
  } catch (error) {
    log('red', '❌ ส่งข้อความไม่สำเร็จ:');
    console.error(error);
    return false;
  }
}

/**
 * TEST 7: ทดสอบ Payment Queue
 */
async function test7_PaymentQueue(dryRun = false) {
  log('cyan', '\n========== TEST 7: ทดสอบ Payment Queue ==========');
  
  try {
    const paymentRows = await fetchPaymentQueueFromDB3();
    
    if (paymentRows.length === 0) {
      log('yellow', '⚠️  ไม่พบข้อมูล Payment Queue');
      return;
    }

    log('green', `✅ พบข้อมูล Payment Queue: ${paymentRows.length} รายการ`);
    
    // แสดง 3 รายการแรก
    console.log('\n💰 ตัวอย่างข้อมูล (3 รายการแรก):');
    for (const row of paymentRows.slice(0, 3)) {
      console.log(`\n--- VN: ${row.vn} ---`);
      console.log(`ช่องชำระเงิน: ${row.payment_slot || '-'}`);
      console.log(`ชื่อ: ${row.name || '-'}`);
      
      // ตรวจสอบว่าเคยส่งแล้วหรือยัง
      const tracking = await queryDB2(
        'SELECT * FROM payment_queue_tracking WHERE vn = ? AND payment_slot = ?',
        [row.vn, row.payment_slot]
      );

      if (tracking.length > 0) {
        log('yellow', '⚠️  เคยส่งแจ้งเตือนแล้ว (ข้าม)');
        continue;
      }

      const lineUserId = await getLineUserIdByVN(row.vn, null);
      if (!lineUserId) {
        log('yellow', '⚠️  ไม่พบ LINE User ID (ข้าม)');
        continue;
      }

      const message = `💰 ถึงคิวชำระเงินของคุณแล้ว

📋 VN: ${row.vn}
🧮 ช่องชำระเงิน: ${row.payment_slot}

กรุณาไปที่ช่องชำระเงินหมายเลข ${row.payment_slot} เพื่อทำการชำระเงินค่ะ`;

      if (dryRun) {
        log('blue', '\n📱 ข้อความที่จะส่ง (DRY RUN):');
        console.log(message);
        log('yellow', '⚠️  ไม่ได้ส่งจริง (DRY RUN MODE)');
      } else {
        await sendLineMessage(lineUserId, message);

        // บันทึกสถานะ
        await queryDB2(
          `INSERT INTO payment_queue_tracking (vn, line_user_id, payment_slot, notified_payment)
           VALUES (?, ?, ?, 1)`,
          [row.vn, lineUserId, row.payment_slot]
        );

        await logEvent('payment.queue.called', {
          vn: row.vn,
          line_user_id: lineUserId,
          payment_slot: row.payment_slot
        });

        log('green', `✅ ส่งแจ้งเตือนการชำระเงิน VN: ${row.vn} สำเร็จ`);
      }
    }
  } catch (error) {
    log('red', '❌ ทดสอบ Payment Queue ไม่สำเร็จ:');
    console.error(error);
  }
}

/**
 * TEST 8: Full Flow - จำลองการทำงานจริง (ตาม code ที่อัพเดท)
 */
async function test8_FullFlow(dryRun = false) {
  log('cyan', '\n========== TEST 8: Full Flow (ตาม code ที่อัพเดท) ==========');
  
  try {
    // 1. ดึงข้อมูลคิวยา
    log('blue', '\n[1/4] กำลังดึงข้อมูลคิวยาจาก SSB (เงื่อนไข drug.txt)...');
    const queueData = await fetchPharmacyQueueFromSSB();
    
    if (queueData.length === 0) {
      log('yellow', '⚠️  ไม่มีข้อมูลคิวให้ทดสอบ');
      return;
    }

    log('green', `✅ พบข้อมูลคิว: ${queueData.length} รายการ`);

    // 2. ประมวลผลแต่ละคิว
    log('blue', '\n[2/4] กำลังประมวลผลข้อมูลคิว...');
    
    let processedCount = 0;
    for (const item of queueData.slice(0, 5)) { // ทดสอบ 5 รายการแรก
      const { VN, HN, DrugAcknowledge, DrugReady, StockCode, FacilityRequestMethod } = item;

      // หา LINE User ID
      const lineUserId = await getLineUserIdByVN(VN, HN);
      if (!lineUserId) {
        log('yellow', `⚠️  VN: ${VN} - ไม่พบ LINE User ID (ข้าม)`);
        continue;
      }

      // ตรวจสอบสถานะปัจจุบัน
      const trackingResult = await queryDB2(
        'SELECT * FROM pharmacy_queue_tracking WHERE vn = ?',
        [VN]
      );

      let currentStatus = 'waiting_medicine';
      let notifiedWaiting = false;
      let notifiedReady = false;

      if (trackingResult.length > 0) {
        currentStatus = trackingResult[0].status;
        notifiedWaiting = trackingResult[0].notified_waiting;
        notifiedReady = trackingResult[0].notified_ready;
      }

      // กำหนดสถานะใหม่ตาม determineStatus()
      const newStatus = determineStatus(item);

      console.log(`\n📋 VN: ${VN}`);
      console.log(`   สถานะเดิม: ${currentStatus}`);
      console.log(`   สถานะใหม่: ${newStatus}`);
      console.log(`   StockCode: ${StockCode || '-'}`);
      console.log(`   FacilityRequestMethod: ${FacilityRequestMethod || 'NULL'}`);
      console.log(`   DrugReady: ${DrugReady}`);

      // ส่งการแจ้งเตือนตามสถานะ
      if (newStatus === 'waiting_medicine' && !notifiedWaiting) {
        await test3_SendWaitingMedicineMessage(item, lineUserId, dryRun);
        processedCount++;
      } 
      else if (newStatus === 'medicine_ready' && !notifiedReady) {
        await test4_SendMedicineReadyMessage(item, lineUserId, dryRun);
        processedCount++;
      }
      else if (newStatus === 'completed' && (StockCode === 'NODRUG' || FacilityRequestMethod !== null)) {
        await test5_SendNoDrugMessage(item, lineUserId, dryRun);
        processedCount++;
      }
      else {
        log('blue', '   ℹ️  ไม่ต้องส่งการแจ้งเตือน (เคยส่งแล้วหรือสถานะไม่เปลี่ยน)');
      }
    }

    // 3. ทดสอบ Payment Queue
    log('blue', '\n[3/4] กำลังตรวจสอบ Payment Queue...');
    await test7_PaymentQueue(dryRun);

    // 4. สรุปผล
    log('green', `\n[4/4] ✅ ประมวลผลสำเร็จ: ${processedCount} รายการ`);
    
  } catch (error) {
    log('red', '\n❌ Full Flow ไม่สำเร็จ:');
    console.error(error);
  }
}

/**
 * TEST 9: ทดสอบกับ VN เฉพาะเจาะจง
 */
async function test9_SpecificVN(vn, dryRun = false) {
  log('cyan', `\n========== TEST 9: ทดสอบกับ VN: ${vn} ==========`);
  
  try {
    // ดึงข้อมูลจาก SSB (ใช้ query เดียวกับ code)
    const sql = `
      SELECT DISTINCT 
        HNOPD_MASTER.VN,
        HNOPD_MASTER.HN,
        HNOPD_PRESCRIP.DrugAcknowledge,
        HNOPD_PRESCRIP.DrugReady,
        HNOPD_PRESCRIP_MEDICINE.StockCode,
        HNOPD_PRESCRIP_MEDICINE.FacilityRequestMethod,
        HNOPD_PRESCRIP.CloseVisitCode,
        HNOPD_PRESCRIP.ApprovedByUserCode,
        HNOPD_RECEIVE_HEADER.ReceiptNo,
        HNOPD_MASTER.OutDateTime,
        SUBSTRING(dbo.HNPAT_NAME.FirstName, 2, 100) + ' ' + SUBSTRING(dbo.HNPAT_NAME.LastName, 2, 100) AS PatientName,
        HNOPD_PRESCRIP.Clinic,
        (SELECT ISNULL(SUBSTRING(LocalName, 2, 1000), SUBSTRING(EnglishName, 2, 1000))
         FROM DNSYSCONFIG 
         WHERE CtrlCode = '42203' AND code = HNOPD_PRESCRIP.Clinic) AS ClinicName
      FROM HNOPD_MASTER WITH (NOLOCK)
      LEFT OUTER JOIN HNOPD_PRESCRIP 
        ON HNOPD_MASTER.VisitDate=HNOPD_PRESCRIP.VisitDate 
        AND HNOPD_MASTER.VN=HNOPD_PRESCRIP.VN
      LEFT OUTER JOIN HNOPD_RECEIVE_HEADER 
        ON HNOPD_MASTER.VisitDate=HNOPD_RECEIVE_HEADER.VisitDate 
        AND HNOPD_MASTER.VN=HNOPD_RECEIVE_HEADER.VN
      LEFT OUTER JOIN HNOPD_PRESCRIP_MEDICINE 
        ON HNOPD_PRESCRIP.VisitDate=HNOPD_PRESCRIP_MEDICINE.VisitDate 
        AND HNOPD_PRESCRIP.VN=HNOPD_PRESCRIP_MEDICINE.VN 
        AND HNOPD_PRESCRIP.PrescriptionNo=HNOPD_PRESCRIP_MEDICINE.PrescriptionNo
      LEFT OUTER JOIN HNPAT_NAME 
        ON HNOPD_MASTER.HN=HNPAT_NAME.HN
      WHERE HNOPD_MASTER.VN = '${vn}'
        AND CONVERT(DATE, HNOPD_MASTER.VisitDate) = CONVERT(DATE, GETDATE())
    `;

    const rows = await queryDB1(sql);
    
    if (rows.length === 0) {
      log('red', `❌ ไม่พบข้อมูล VN: ${vn}`);
      return;
    }

    const item = rows[0];
    log('green', `✅ พบข้อมูล VN: ${vn}`);
    
    console.log('\n📋 รายละเอียดเต็ม:');
    console.log(`   VN: ${item.VN}`);
    console.log(`   HN: ${item.HN}`);
    console.log(`   ชื่อ: ${item.PatientName || '-'}`);
    console.log(`   คลินิก: ${item.ClinicName || '-'} (${item.Clinic})`);
    console.log(`   DrugAcknowledge: ${item.DrugAcknowledge}`);
    console.log(`   DrugReady: ${item.DrugReady}`);
    console.log(`   StockCode: ${item.StockCode || '-'}`);
    console.log(`   FacilityRequestMethod: ${item.FacilityRequestMethod || 'NULL'}`);
    console.log(`   ApprovedByUserCode: ${item.ApprovedByUserCode || '-'}`);
    console.log(`   CloseVisitCode: ${item.CloseVisitCode || '-'}`);
    console.log(`   ReceiptNo: ${item.ReceiptNo || 'NULL'}`);
    console.log(`   OutDateTime: ${item.OutDateTime || 'NULL'}`);

    // ตรวจสอบเงื่อนไข
    console.log('\n✅ ตรวจสอบเงื่อนไข:');
    const checks = {
      'Clinic NOT LIKE %SC%': !item.ClinicName?.includes('SC'),
      'Clinic NOT IN exclude list': !['99994','150043','SCKTB','999911','14009','150042','99999'].includes(item.Clinic),
      'ApprovedByUserCode IS NOT NULL': !!item.ApprovedByUserCode,
      'DrugAcknowledge = 1': item.DrugAcknowledge === 1,
      'StockCode != NODRUG': item.StockCode !== 'NODRUG',
      'FacilityRequestMethod IS NULL': !item.FacilityRequestMethod
    };
    
    let passAll = true;
    for (const [condition, pass] of Object.entries(checks)) {
      const icon = pass ? '✅' : '❌';
      console.log(`   ${icon} ${condition}`);
      if (!pass) passAll = false;
    }

    if (!passAll) {
      log('yellow', '\n⚠️  VN นี้ไม่ผ่านบางเงื่อนไข จะไม่ปรากฏในคิวยา');
      return;
    }

    // หา LINE User ID
    const lineUserId = await getLineUserIdByVN(item.VN, item.HN);
    if (!lineUserId) {
      log('yellow', '\n⚠️  ไม่พบ LINE User ID');
      return;
    }

    log('green', `✅ พบ LINE User ID: ${lineUserId.substring(0, 10)}...`);

    // กำหนดสถานะและส่งข้อความ
    console.log('\n💊 วิเคราะห์สถานะ:');
    const determinedStatus = determineStatus(item);
    console.log(`   ➡️  สถานะที่กำหนด: ${determinedStatus}`);
    
    if (determinedStatus === 'completed' && (item.StockCode === 'NODRUG' || item.FacilityRequestMethod !== null)) {
      console.log('   → เหตุผล: ไม่มียา (NODRUG หรือ FacilityRequestMethod)');
      await test5_SendNoDrugMessage(item, lineUserId, dryRun);
    }
    else if (determinedStatus === 'medicine_ready') {
      console.log('   → เหตุผล: ยาพร้อม (DrugReady = 1, StockCode != NODRUG, FacilityRequestMethod IS NULL)');
      await test4_SendMedicineReadyMessage(item, lineUserId, dryRun);
    }
    else if (determinedStatus === 'waiting_medicine') {
      console.log('   → เหตุผล: รอจัดยา (DrugAcknowledge = 1, DrugReady = 0, StockCode != NODRUG, FacilityRequestMethod IS NULL)');
      await test3_SendWaitingMedicineMessage(item, lineUserId, dryRun);
    }
    else {
      log('yellow', '   → สถานะ: completed (ชำระเงินแล้วหรือออกจากระบบ)');
    }

  } catch (error) {
    log('red', '❌ ทดสอบไม่สำเร็จ:');
    console.error(error);
  }
}

/**
 * TEST 10: ล้างข้อมูลทดสอบ
 */
async function test10_Cleanup(vn = null) {
  log('cyan', '\n========== TEST 10: ล้างข้อมูลทดสอบ ==========');
  
  try {
    if (vn) {
      // ลบข้อมูล VN เฉพาะ
      await queryDB2('DELETE FROM pharmacy_queue_tracking WHERE vn = ?', [vn]);
      await queryDB2('DELETE FROM payment_queue_tracking WHERE vn = ?', [vn]);
      log('green', `✅ ลบข้อมูลทดสอบของ VN: ${vn} สำเร็จ`);
    } else {
      // ลบข้อมูลเก่าทั้งหมด (เก็บแค่วันนี้)
      await queryDB2(
        'DELETE FROM pharmacy_queue_tracking WHERE DATE(created_at) < CURDATE()'
      );
      await queryDB2(
        'DELETE FROM payment_queue_tracking WHERE DATE(created_at) < CURDATE()'
      );
      log('green', '✅ ลบข้อมูลเก่าสำเร็จ (เก็บแค่วันนี้)');
    }
  } catch (error) {
    log('red', '❌ ล้างข้อมูลไม่สำเร็จ:');
    console.error(error);
  }
}

/**
 * TEST 11: ทดสอบ determineStatus function
 */
async function test11_DetermineStatus() {
  log('cyan', '\n========== TEST 11: ทดสอบ determineStatus() ==========');
  
  const testCases = [
    {
      name: 'รอจัดยา (DrugReady=0)',
      data: { DrugAcknowledge: 1, DrugReady: 0, StockCode: 'ABC123', FacilityRequestMethod: null, ReceiptNo: null, OutDateTime: null },
      expected: 'waiting_medicine'
    },
    {
      name: 'ยาพร้อม (DrugReady=1)',
      data: { DrugAcknowledge: 1, DrugReady: 1, StockCode: 'ABC123', FacilityRequestMethod: null, ReceiptNo: null, OutDateTime: null },
      expected: 'medicine_ready'
    },
    {
      name: 'ไม่มียา (NODRUG)',
      data: { DrugAcknowledge: 1, DrugReady: 0, StockCode: 'NODRUG', FacilityRequestMethod: null, ReceiptNo: null, OutDateTime: null },
      expected: 'completed'
    },
    {
      name: 'ไม่มียา (FacilityRequestMethod)',
      data: { DrugAcknowledge: 1, DrugReady: 0, StockCode: 'ABC123', FacilityRequestMethod: 'SOME_METHOD', ReceiptNo: null, OutDateTime: null },
      expected: 'completed'
    },
    {
      name: 'ชำระเงินแล้ว',
      data: { DrugAcknowledge: 1, DrugReady: 1, StockCode: 'ABC123', FacilityRequestMethod: null, ReceiptNo: 'R12345', OutDateTime: null },
      expected: 'completed'
    },
    {
      name: 'ออกจากระบบแล้ว',
      data: { DrugAcknowledge: 1, DrugReady: 1, StockCode: 'ABC123', FacilityRequestMethod: null, ReceiptNo: null, OutDateTime: '2025-01-20' },
      expected: 'completed'
    }
  ];

  console.log('\nทดสอบทุกกรณี:');
  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    const result = determineStatus(testCase.data);
    const isPass = result === testCase.expected;
    
    if (isPass) {
      log('green', `✅ ${testCase.name}: ${result}`);
      passed++;
    } else {
      log('red', `❌ ${testCase.name}: ได้ ${result}, คาดหวัง ${testCase.expected}`);
      failed++;
    }
  }

  console.log(`\n📊 สรุป: ผ่าน ${passed}/${testCases.length} กรณี`);
  if (failed === 0) {
    log('green', '🎉 ทดสอบผ่านทุกกรณี!');
  }
}

// ===== เมนูหลัก =====
async function runTests() {
  console.log('\n' + '='.repeat(70));
  log('cyan', '🧪 ระบบทดสอบ Pharmacy Queue Monitor (อัพเดทตาม drug.txt)');
  console.log('='.repeat(70));

  const args = process.argv.slice(2);
  
  // ตรวจสอบ dry-run mode
  const dryRun = args.includes('--dry-run');
  if (dryRun) {
    log('yellow', '\n⚠️  DRY RUN MODE: จะไม่ส่งข้อความ LINE จริง\n');
  }

  // ดึง VN จาก argument
  let specificVN = null;
  const vnArg = args.find(arg => arg.startsWith('--vn='));
  if (vnArg) {
    specificVN = vnArg.split('=')[1];
  }

  try {
    if (args.includes('--all')) {
      // รันทุก test
      log('blue', '\n📝 รันการทดสอบทั้งหมด...\n');
      await test1_DatabaseConnection();
      await test2_FetchPharmacyQueue();
      await test11_DetermineStatus();
      await test8_FullFlow(dryRun);
      
    } else if (args.includes('--vn') && specificVN) {
      // ทดสอบ VN เฉพาะ
      log('blue', `\n🎯 ทดสอบ VN: ${specificVN}\n`);
      await test1_DatabaseConnection();
      await test9_SpecificVN(specificVN, dryRun);
      
    } else if (args.includes('--queue')) {
      // ทดสอบดึงข้อมูลคิว
      log('blue', '\n📋 ทดสอบดึงข้อมูลคิว\n');
      await test1_DatabaseConnection();
      await test2_FetchPharmacyQueue();
      
    } else if (args.includes('--payment')) {
      // ทดสอบ Payment Queue
      log('blue', '\n💰 ทดสอบ Payment Queue\n');
      await test1_DatabaseConnection();
      await test7_PaymentQueue(dryRun);
      
    } else if (args.includes('--call') && specificVN) {
      // ทดสอบเรียกคิว
      log('blue', `\n🔔 ทดสอบเรียกคิว VN: ${specificVN}\n`);
      await test1_DatabaseConnection();
      await test6_SendQueueCalledMessage(specificVN, dryRun);
      
    } else if (args.includes('--cleanup')) {
      // ล้างข้อมูลทดสอบ
      await test1_DatabaseConnection();
      await test10_Cleanup(specificVN);
      
    } else if (args.includes('--status')) {
      // ทดสอบ determineStatus
      await test11_DetermineStatus();
      
    } else if (args.includes('--quick')) {
      // Quick test
      log('blue', '\n⚡ Quick Test\n');
      await test1_DatabaseConnection();
      const queueData = await test2_FetchPharmacyQueue();
      if (queueData.length > 0) {
        log('green', `\n✅ ระบบพร้อมใช้งาน (พบคิว ${queueData.length} รายการ)`);
      }
      await test11_DetermineStatus();
      
    } else {
      // แสดงเมนู
      console.log('\n📚 วิธีใช้งาน:');
      console.log('─'.repeat(70));
      console.log('\n🔍 ทดสอบพื้นฐาน:');
      console.log('  node testPharmacyMonitor.js --quick');
      console.log('  node testPharmacyMonitor.js --queue');
      console.log('  node testPharmacyMonitor.js --payment');
      console.log('  node testPharmacyMonitor.js --status           # ทดสอบ determineStatus()');
      
      console.log('\n🎯 ทดสอบ VN เฉพาะ:');
      console.log('  node testPharmacyMonitor.js --vn=265');
      console.log('  node testPharmacyMonitor.js --vn=265 --dry-run');
      
      console.log('\n🔔 ทดสอบเรียกคิว:');
      console.log('  node testPharmacyMonitor.js --call --vn=265');
      console.log('  node testPharmacyMonitor.js --call --vn=265 --dry-run');
      
      console.log('\n🚀 ทดสอบเต็มรูปแบบ:');
      console.log('  node testPharmacyMonitor.js --all');
      console.log('  node testPharmacyMonitor.js --all --dry-run');
      
      console.log('\n🧹 ล้างข้อมูลทดสอบ:');
      console.log('  node testPharmacyMonitor.js --cleanup');
      console.log('  node testPharmacyMonitor.js --cleanup --vn=265');
      
      console.log('\n💡 TIP:');
      console.log('  --dry-run = ไม่ส่ง LINE จริง (แค่แสดงข้อความ)');
      console.log('  เหมาะสำหรับทดสอบก่อนใช้งานจริง');
      console.log('\n📌 เงื่อนไขใหม่:');
      console.log('  ✓ Clinic NOT LIKE %SC%');
      console.log('  ✓ Clinic NOT IN (99994, 150043, SCKTB, ...)');
      console.log('  ✓ ApprovedByUserCode IS NOT NULL');
      console.log('  ✓ StockCode != NODRUG');
      console.log('  ✓ FacilityRequestMethod IS NULL');
      
      console.log('\n─'.repeat(70));
      
      // รัน quick test โดยอัตโนมัติ
      log('blue', '\n💡 รัน Quick Test โดยอัตโนมัติ...\n');
      await test1_DatabaseConnection();
      await test2_FetchPharmacyQueue();
      await test11_DetermineStatus();
    }

    console.log('\n' + '='.repeat(70));
    log('cyan', '✅ การทดสอบเสร็จสิ้น');
    console.log('='.repeat(70) + '\n');
    
  } catch (error) {
    log('red', '\n❌ เกิดข้อผิดพลาด:');
    console.error(error);
  }
  
  process.exit(0);
}

// ===== เริ่มการทดสอบ =====
if (require.main === module) {
  runTests().catch(error => {
    log('red', '\n❌ เกิดข้อผิดพลาดร้ายแรง:');
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  test1_DatabaseConnection,
  test2_FetchPharmacyQueue,
  test3_SendWaitingMedicineMessage,
  test4_SendMedicineReadyMessage,
  test5_SendNoDrugMessage,
  test6_SendQueueCalledMessage,
  test7_PaymentQueue,
  test8_FullFlow,
  test9_SpecificVN,
  test10_Cleanup,
  test11_DetermineStatus,
  fetchPharmacyQueueFromSSB,
  getLineUserIdByVN,
  determineStatus
};