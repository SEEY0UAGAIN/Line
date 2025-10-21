const sqlServer = require('mssql');
const { queryDB1, queryDB2, queryDB3 } = require('./db');
const { sendLineMessage } = require('./utils/lineNotify');
const { logEvent } = require('./auditLog');
require('dotenv').config();

const POLL_INTERVAL = process.env.POLL_INTERVAL || 15000; // 30 วินาที

/**
 * ✅ แก้ไข: ดึงข้อมูลคิวยาจาก SSB ให้ตรงกับหน้า "รอจัดยา" (drug.txt)
 * เงื่อนไข: DrugAcknowledge=1 AND DrugReady=0
 */
async function fetchPharmacyQueueFromSSB() {
  try {
    const sql = `
      SELECT DISTINCT 
        HNOPD_MASTER.VN,
        HNOPD_MASTER.HN,
        HNOPD_PRESCRIP.DrugAcknowledge,
        HNOPD_PRESCRIP.DrugReady,
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
      LEFT OUTER JOIN HNPAT_NAME 
        ON HNOPD_MASTER.HN=HNPAT_NAME.HN
      WHERE HNOPD_MASTER.Cxl=0
        AND CONVERT(DATE, HNOPD_MASTER.VisitDate) = CONVERT(DATE, GETDATE())
        AND HNOPD_MASTER.OutDateTime IS NULL
        AND HNOPD_PRESCRIP.CloseVisitCode NOT IN ('ADM','C01','C02','C03','C04','C05','C06','C07','C08','C09','C10','C11','C12','C13','C14','C15')
        AND HNOPD_RECEIVE_HEADER.ReceiptNo IS NULL
        AND HNPAT_NAME.SuffixSmall=0
        AND HNOPD_PRESCRIP.ApprovedByUserCode IS NOT NULL
        AND HNOPD_PRESCRIP.DrugAcknowledge=1 
        AND HNOPD_PRESCRIP.DrugReady=0
    `;

    const rows = await queryDB1(sql);
    console.log(`✅ พบคิว "รอจัดยา": ${rows.length} รายการ`);
    return rows;
  } catch (error) {
    console.error('❌ Error fetching pharmacy queue (รอจัดยา):', error);
    return [];
  }
}

/**
 * ✅ เพิ่ม: ดึงข้อมูลคิว "รอเรียก" (ยาพร้อม) ตรงกับหน้า showcallV2
 * เงื่อนไข: DrugReady=1 OR StockCode='NODRUG'
 */
async function fetchReadyQueueFromSSB() {
  try {
    const sql = `
      SELECT DISTINCT 
        HNOPD_MASTER.HN,
        SUBSTRING(dbo.HNPAT_NAME.FirstName, 2, 100) + ' ' + SUBSTRING(dbo.HNPAT_NAME.LastName, 2, 100) AS Name,
        HNOPD_PRESCRIP.VN,
        HNOPD_PRESCRIP.PrescriptionNo,
        HNOPD_PRESCRIP.Clinic,
        (SELECT ISNULL(SUBSTRING(LocalName, 2, 1000), SUBSTRING(EnglishName, 2, 1000))
         FROM DNSYSCONFIG 
         WHERE CtrlCode = '42203' AND code = HNOPD_PRESCRIP.Clinic) AS Clinic,
        HNOPD_PRESCRIP.DrugAcknowledge,
        HNOPD_PRESCRIP.DrugReady,
        HNOPD_PRESCRIP_MEDICINE.StockCode,
        HNOPD_PRESCRIP_MEDICINE.FacilityRequestMethod,
        CASE 
          WHEN HNOPD_PRESCRIP.DrugAcknowledge=1 AND HNOPD_PRESCRIP.DrugReady=0 
               AND HNOPD_PRESCRIP_MEDICINE.StockCode != 'NODRUG' 
               AND HNOPD_PRESCRIP_MEDICINE.FacilityRequestMethod IS NULL 
          THEN 'รอจัดยา'
          WHEN HNOPD_PRESCRIP.DrugAcknowledge=1 AND HNOPD_PRESCRIP.DrugReady=1 
               AND HNOPD_PRESCRIP_MEDICINE.StockCode != 'NODRUG' 
               AND HNOPD_PRESCRIP_MEDICINE.FacilityRequestMethod IS NULL 
          THEN 'จัดยาเรียบร้อย'
          ELSE 'ไม่มียา'
        END AS MEDICINE
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
             WHERE CtrlCode = '42203' AND code = HNOPD_PRESCRIP.Clinic) LIKE '%WI%'
        AND HNOPD_MASTER.OutDateTime IS NULL
        AND HNOPD_PRESCRIP.CloseVisitCode IS NOT NULL
        AND HNOPD_PRESCRIP.CloseVisitCode NOT IN ('ADM','C01','C02','C03','C04','C05','C06','C07','C08','C09','C10','C11','C12','C13','C14','C15')
        AND HNOPD_RECEIVE_HEADER.ReceiptNo IS NULL
        AND HNOPD_PRESCRIP_MEDICINE.CxlDateTime IS NULL
        AND (HNOPD_PRESCRIP.DrugReady=1 OR HNOPD_PRESCRIP_MEDICINE.StockCode = 'NODRUG')
        AND HNPAT_NAME.SuffixSmall=0
    `;

    const rows = await queryDB1(sql);
    console.log(`✅ พบคิว "รอเรียก": ${rows.length} รายการ`);
    return rows;
  } catch (error) {
    console.error('❌ Error fetching ready queue (รอเรียก):', error);
    return [];
  }
}

/**
 * ✅ เพิ่ม: ดึงข้อมูลคิว "เรียกแล้ว" ตรงกับหน้า PHP สุดท้าย
 * เงื่อนไข: ไม่กรอง Clinic (แสดงทั้งหมด) + กรอง SC + คลินิกพิเศษ
 */
async function fetchCalledQueueFromSSB() {
  try {
    const sql = `
      SELECT DISTINCT
        HNOPD_MASTER.HN,
        SUBSTRING(dbo.HNPAT_NAME.FirstName, 2, 100) + ' ' + SUBSTRING(dbo.HNPAT_NAME.LastName, 2, 100) AS Name,
        HNOPD_PRESCRIP.VN,
        HNOPD_PRESCRIP.PrescriptionNo,
        HNOPD_PRESCRIP.Clinic,
        (SELECT ISNULL(SUBSTRING(LocalName, 2, 1000), SUBSTRING(EnglishName, 2, 1000))
         FROM DNSYSCONFIG 
         WHERE CtrlCode = '42203' AND code = HNOPD_PRESCRIP.Clinic) AS Clinic,
        HNOPD_PRESCRIP.DrugAcknowledge,
        HNOPD_PRESCRIP.DrugReady,
        HNOPD_PRESCRIP_MEDICINE.StockCode,
        HNOPD_PRESCRIP_MEDICINE.FacilityRequestMethod,
        CASE 
          WHEN HNOPD_PRESCRIP.DrugAcknowledge=1 AND HNOPD_PRESCRIP.DrugReady=0 
               AND HNOPD_PRESCRIP_MEDICINE.StockCode!='NODRUG' 
               AND HNOPD_PRESCRIP_MEDICINE.FacilityRequestMethod IS NULL 
          THEN 'รอจัดยา'
          WHEN HNOPD_PRESCRIP.DrugAcknowledge=1 AND HNOPD_PRESCRIP.DrugReady=1 
               AND HNOPD_PRESCRIP_MEDICINE.StockCode!='NODRUG' 
               AND HNOPD_PRESCRIP_MEDICINE.FacilityRequestMethod IS NULL 
          THEN 'จัดยาเรียบร้อย'
          ELSE 'ไม่มียา'
        END AS MEDICINE
      FROM HNOPD_MASTER WITH (NOLOCK)
      LEFT JOIN HNOPD_PRESCRIP 
        ON HNOPD_MASTER.VisitDate = HNOPD_PRESCRIP.VisitDate 
        AND HNOPD_MASTER.VN = HNOPD_PRESCRIP.VN
      LEFT JOIN HNOPD_RECEIVE_HEADER 
        ON HNOPD_MASTER.VisitDate = HNOPD_RECEIVE_HEADER.VisitDate 
        AND HNOPD_MASTER.VN = HNOPD_RECEIVE_HEADER.VN
      LEFT JOIN HNOPD_PRESCRIP_MEDICINE 
        ON HNOPD_PRESCRIP.VisitDate = HNOPD_PRESCRIP_MEDICINE.VisitDate 
        AND HNOPD_PRESCRIP.VN = HNOPD_PRESCRIP_MEDICINE.VN 
        AND HNOPD_PRESCRIP.PrescriptionNo = HNOPD_PRESCRIP_MEDICINE.PrescriptionNo
      LEFT JOIN HNPAT_NAME 
        ON HNOPD_MASTER.HN = HNPAT_NAME.HN
      WHERE HNOPD_MASTER.Cxl = 0
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
        AND HNPAT_NAME.SuffixSmall = 0
      ORDER BY HNOPD_MASTER.HN
    `;

    const rows = await queryDB1(sql);
    console.log(`✅ พบคิว "เรียกแล้ว": ${rows.length} รายการ`);
    return rows;
  } catch (error) {
    console.error('❌ Error fetching called queue (เรียกแล้ว):', error);
    return [];
  }
}

/**
 * ดึงข้อมูล LINE User ID จาก VN
 */
async function getLineUserIdByVN(vn, hn) {
  try {
    // ลองหา LINE User ID จาก HN ก่อน
    if (hn) {
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
 * ✅ แก้ไข: ประมวลผลและส่งการแจ้งเตือนตามสถานะ
 * - รอจัดยา (DrugReady=0)
 * - ยาพร้อม (DrugReady=1)
 * - ไม่มียา (NODRUG)
 */
async function processQueueStatus(waitingQueue, readyQueue) {
  // ประมวลผลคิว "รอจัดยา"
  for (const item of waitingQueue) {
    const { VN, HN, PatientName, ClinicName } = item;

    try {
      const lineUserId = await getLineUserIdByVN(VN, HN);
      if (!lineUserId) {
        console.log(`⚠️  VN ${VN}: ไม่พบ LINE User ID`);
        continue;
      }

      // ตรวจสอบว่าเคยส่งแจ้งเตือนแล้วหรือยัง
      const tracking = await queryDB2(
        'SELECT * FROM pharmacy_queue_tracking WHERE vn = ?',
        [VN]
      );

      if (tracking.length > 0 && tracking[0].notified_waiting) {
        continue; // เคยแจ้งแล้ว ข้าม
      }

      // ส่งแจ้งเตือน "รอจัดยา"
      const message = `⏳ รอจัดยา

📋 VN: ${VN}
👤 ชื่อ: ${PatientName || '-'}
🏥 คลินิก: ${ClinicName || '-'}

กรุณารอสักครู่ ระบบกำลังจัดเตรียมยาให้คุณ`;

      await sendLineMessage(lineUserId, message);

      // บันทึกสถานะ
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
      console.log(`✅ ส่งแจ้งเตือน "รอจัดยา" VN: ${VN}`);

    } catch (error) {
      console.error(`❌ Error processing waiting VN ${VN}:`, error);
    }
  }

  // ประมวลผลคิว "รอเรียก" (ยาพร้อม)
  for (const item of readyQueue) {
    const { VN, HN, Name, Clinic, MEDICINE, StockCode, FacilityRequestMethod } = item;

    try {
      const lineUserId = await getLineUserIdByVN(VN, HN);
      if (!lineUserId) {
        console.log(`⚠️  VN ${VN}: ไม่พบ LINE User ID`);
        continue;
      }

      // ตรวจสอบสถานะ
      const tracking = await queryDB2(
        'SELECT * FROM pharmacy_queue_tracking WHERE vn = ?',
        [VN]
      );

      // กรณีไม่มียา (NODRUG)
      if (MEDICINE === 'ไม่มียา') {
        if (tracking.length > 0 && tracking[0].status === 'completed') {
          continue; // เคยแจ้งแล้ว
        }

        const message = `ℹ️ แจ้งเตือน

📋 VN: ${VN}
👤 ชื่อ: ${Name || '-'}

คุณไม่มียาที่ต้องรับในครั้งนี้
กรุณาติดต่อเจ้าหน้าที่หากมีข้อสงสัย`;

        await sendLineMessage(lineUserId, message);

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
        console.log(`✅ ส่งแจ้งเตือน "ไม่มียา" VN: ${VN}`);
        continue;
      }

      // กรณียาพร้อม (จัดยาเรียบร้อย)
      if (MEDICINE === 'จัดยาเรียบร้อย') {
        if (tracking.length > 0 && tracking[0].notified_ready) {
          continue; // เคยแจ้งแล้ว
        }

        const message = `✅ ยาของคุณพร้อมแล้ว!

📋 VN: ${VN}
👤 ชื่อ: ${Name || '-'}
🏥 คลินิก: ${Clinic || '-'}

กรุณารอเรียกคิวที่หน้าช่องจ่ายยา
ระบบจะแจ้งเตือนเมื่อถึงคิวของคุณ 🔔`;

        await sendLineMessage(lineUserId, message);

        if (tracking.length === 0) {
          await queryDB2(
            `INSERT INTO pharmacy_queue_tracking 
             (vn, line_user_id, status, notified_waiting, notified_ready) 
             VALUES (?, ?, ?, 1, 1)`,
            [VN, lineUserId, 'medicine_ready']
          );
        } else {
          await queryDB2(
            'UPDATE pharmacy_queue_tracking SET status = ?, notified_ready = 1, updated_at = NOW() WHERE vn = ?',
            ['medicine_ready', VN]
          );
        }

        await logEvent('pharmacy.queue.ready', { vn: VN, line_user_id: lineUserId });
        console.log(`✅ ส่งแจ้งเตือน "ยาพร้อม" VN: ${VN}`);
      }

    } catch (error) {
      console.error(`❌ Error processing ready VN ${VN}:`, error);
    }
  }
}

/**
 * ดึงข้อมูลจาก paymentq ใน DB3
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
    console.log('🔍 Sample payment queue data:', rows.slice(0, 2));
    return rows;
  } catch (err) {
    console.error('Error fetching payment queue from DB3:', err);
    return [];
  }
}

/**
 * ประมวลผล paymentq rows และส่งแจ้งเตือน LINE (เพิ่ม Debug Logging)
 */
async function processPaymentQueueRows(rows) {
  console.log(`🔍 เริ่มประมวลผล Payment Queue: ${rows.length} รายการ`);
  
  for (const row of rows) {
    try {
      const vn = row.vn;
      let hn = row.hn; // 👈 ดึง HN จาก paymentq
      const paymentSlot = row.payment_slot ? String(row.payment_slot) : '-';
      
      console.log(`\n--- Processing VN: ${vn}, HN: ${hn} ---`);
      
      // ✅ ตรวจสอบ VN
      if (!vn) {
        console.log(`⚠️  ข้าม: VN เป็น null/undefined`);
        continue;
      }

      if (!hn) {
        try {
          const hnResult = await queryDB1(
            'SELECT TOP 1 HN FROM HNOPD_MASTER WITH (NOLOCK) WHERE VN = @vn',
            { vn: { type: sqlServer.VarChar, value: vn } }
          );
          if (hnResult.length > 0 && hnResult[0].HN) {
            hn = hnResult[0].HN;
            console.log(`🔁 ดึง HN จาก SSB สำเร็จ: VN ${vn} → HN ${hn}`);
          } else {
            console.log(`⚠️ ไม่พบ HN ใน SSB สำหรับ VN: ${vn}`);
          }
        } catch (e) {
          console.warn(`⚠️ Error fetching HN from SSB (VN: ${vn}):`, e.message);
        }
      }

      // ✅ ตรวจสอบว่าเคยส่งไปแล้วหรือยัง
      const tracking = await queryDB2(
        'SELECT * FROM payment_queue_tracking WHERE vn = ? AND payment_slot = ?',
        [vn, paymentSlot]
      );

      if (tracking.length > 0) {
        console.log(`⏭️  ข้าม VN ${vn}: เคยส่งแจ้งเตือนไปแล้ว (Slot: ${paymentSlot})`);
        continue;
      }

      // ✅ ดึง LINE User ID (ส่ง HN เข้าไปด้วย!)
      console.log(`🔍 กำลังค้นหา LINE User ID สำหรับ VN: ${vn}, HN: ${hn}`);
      const lineUserId = await getLineUserIdByVN(vn, hn); // 👈 ส่ง HN เข้าไป!
      
      if (!lineUserId) {
        console.log(`❌ ไม่พบ LINE User ID สำหรับ VN: ${vn}`);
        continue;
      }
      
      console.log(`✅ พบ LINE User ID: ${lineUserId}`);

      // ✅ ส่งแจ้งเตือน LINE
      const message = `💰 ถึงคิวชำระเงินของคุณแล้ว

📋 VN: ${vn}
🧮 ช่องชำระเงิน: ${paymentSlot}

กรุณาไปที่ช่องชำระเงินหมายเลข ${paymentSlot} เพื่อทำการชำระเงินค่ะ`;

      console.log(`📤 กำลังส่งข้อความไปยัง LINE User ID: ${lineUserId}`);
      await sendLineMessage(lineUserId, message);
      console.log(`✅ ส่งข้อความสำเร็จ`);

      // ✅ บันทึกสถานะแจ้งแล้วใน DB2
      await queryDB2(
        `INSERT INTO payment_queue_tracking (vn, line_user_id, payment_slot, notified_payment)
         VALUES (?, ?, ?, 1)`,
        [vn, lineUserId, paymentSlot]
      );

      await logEvent('payment.queue.called', {
        vn,
        line_user_id: lineUserId,
        payment_slot: paymentSlot
      });

      console.log(`✅ ส่งแจ้งเตือนชำระเงิน VN: ${vn}, Slot: ${paymentSlot}`);

    } catch (err) {
      console.error(`❌ Error processing payment queue row (VN: ${row.vn}):`, err);
      console.error('Full error details:', {
        message: err.message,
        stack: err.stack,
        row: row
      });
    }
  }
  
  console.log(`\n✅ ประมวลผล Payment Queue เสร็จสิ้น\n`);
}

/**
 * ทำความสะอาดข้อมูลเก่า (เก็บแค่วันนี้)
 */
async function cleanupOldRecords() {
  try {
    await queryDB2(
      'DELETE FROM pharmacy_queue_tracking WHERE DATE(created_at) < CURDATE()'
    );
    
    try {
      await queryDB2(
        'DELETE FROM payment_queue_tracking WHERE DATE(created_at) < CURDATE()'
      );
    } catch (e) {
      console.warn('Warning: unable to cleanup payment_queue_tracking:', e.message);
    }

    console.log('🧹 ทำความสะอาดข้อมูลเก่าเรียบร้อย');
  } catch (error) {
    console.error('Error cleaning up old records:', error);
  }
}

/**
 * ฟังก์ชันสำหรับเรียกคิวจากหน้าจอแสดงผล (เชื่อมกับ TTT)
 */
async function markQueueAsCalled(vn) {
  try {
    const tracking = await queryDB2(
      'SELECT line_user_id FROM pharmacy_queue_tracking WHERE vn = ? AND status = "medicine_ready"',
      [vn]
    );

    if (tracking.length === 0) {
      return { success: false, message: 'Queue not found or not ready' };
    }

    const lineUserId = tracking[0].line_user_id;

    const message = `🔔 ถึงคิวของคุณแล้ว!

📋 VN: ${vn}

กรุณามารับยาที่ช่องจ่ายยาด้วยค่ะ`;

    await sendLineMessage(lineUserId, message);

    await queryDB2(
      'UPDATE pharmacy_queue_tracking SET status = "called", updated_at = NOW() WHERE vn = ?',
      [vn]
    );

    await logEvent('pharmacy.queue.called', { vn, line_user_id: lineUserId });

    return { success: true, message: 'Queue called successfully' };
  } catch (error) {
    console.error(`Error marking queue ${vn} as called:`, error);
    return { success: false, message: error.message };
  }
}

/**
 * ✅ Main monitoring loop - แก้ไขให้ดึงทั้ง 3 คิว
 */
async function startMonitoring() {
  console.log('🚀 Pharmacy Queue Monitor started (ปรับให้ตรงกับหน้าจอ PHP)');

  try {
    await queryDB3();
  } catch (e) {
    console.warn('⚠️  Proceeding without DB3 initially', e.message);
  }

  // ทำความสะอาดข้อมูลเก่าทุกวัน
  setInterval(cleanupOldRecords, 24 * 60 * 60 * 1000);

  // เริ่มตรวจสอบคิว
  while (true) {
    try {
      console.log('\n🔍 กำลังตรวจสอบคิวทั้งหมด...');
      
      // 1. ดึงคิว "รอจัดยา" (DrugReady=0)
      console.log('📋 [1/3] ตรวจสอบคิว "รอจัดยา"...');
      const waitingQueue = await fetchPharmacyQueueFromSSB();
      
      // 2. ดึงคิว "รอเรียก" (DrugReady=1 หรือ NODRUG)
      console.log('📋 [2/3] ตรวจสอบคิว "รอเรียก"...');
      const readyQueue = await fetchReadyQueueFromSSB();
      
      // 3. ประมวลผลและส่งการแจ้งเตือน
      if (waitingQueue.length > 0 || readyQueue.length > 0) {
        console.log('📤 กำลังส่งการแจ้งเตือน...');
        await processQueueStatus(waitingQueue, readyQueue);
      } else {
        console.log('✅ ไม่มีคิวที่ต้องประมวลผล');
      }

      // 4. ตรวจสอบ Payment Queue จาก DB3
      try {
        console.log('💰 [3/3] ตรวจสอบคิว "ชำระเงิน"...');
        const paymentRows = await fetchPaymentQueueFromDB3();
        if (paymentRows && paymentRows.length > 0) {
          console.log(`✅ พบคิวชำระเงิน: ${paymentRows.length} รายการ`);
          await processPaymentQueueRows(paymentRows);
        } else {
          console.log('✅ ไม่มีคิวชำระเงิน');
        }
      } catch (e) {
        console.error('❌ Error checking payment queue (DB3):', e);
      }

    } catch (error) {
      console.error('❌ Error in monitoring loop:', error);
      await logEvent('pharmacy.monitor.error', { error: error.message });
    }

    // รอ POLL_INTERVAL
    console.log(`⏰ รอ ${POLL_INTERVAL/1000} วินาที...\n`);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

// เริ่มการทำงาน
if (require.main === module) {
  startMonitoring().catch(error => {
    console.error('💥 Fatal error in pharmacy queue monitor:', error);
    process.exit(1);
  });
}

module.exports = { 
  startMonitoring, 
  fetchPharmacyQueueFromSSB,
  fetchReadyQueueFromSSB,
  fetchCalledQueueFromSSB,
  markQueueAsCalled, 
  fetchPaymentQueueFromDB3, 
  processPaymentQueueRows 
};