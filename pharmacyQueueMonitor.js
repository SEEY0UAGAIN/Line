const sqlServer = require('mssql');
const { queryDB1, queryDB2 } = require('./db');
const { sendLineMessage } = require('./utils/lineNotify');
const { logEvent } = require('./auditLog');
require('dotenv').config();

// ตรวจสอบสถานะคิวยาทุก 30 วินาที
const POLL_INTERVAL = 30000; // 30 seconds

/**
 * ดึงข้อมูลคิวยาจาก SSB ที่ตรงกับเงื่อนไขใน TTT.txt
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
        HNOPD_PRESCRIP.CloseVisitCode,
        HNOPD_RECEIVE_HEADER.ReceiptNo,
        SUBSTRING(dbo.HNPAT_NAME.FirstName, 2, 100) + ' ' + SUBSTRING(dbo.HNPAT_NAME.LastName, 2, 100) AS PatientName,
        (SELECT ISNULL(SUBSTRING(LocalName, 2, 1000), SUBSTRING(EnglishName, 2, 1000))
         FROM DNSYSCONFIG 
         WHERE CtrlCode = '42203' AND code = HNOPD_PRESCRIP.Clinic) AS ClinicName,
        CASE 
          WHEN HNOPD_PRESCRIP.DrugAcknowledge=1 AND HNOPD_PRESCRIP.DrugReady=0 THEN 'รอจัดยา'
          WHEN HNOPD_PRESCRIP.DrugAcknowledge=1 AND HNOPD_PRESCRIP.DrugReady=1 THEN 'จัดยาเรียบร้อย'
          WHEN HNOPD_PRESCRIP_MEDICINE.StockCode = 'NODRUG' THEN 'ไม่มียา'
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
             WHERE CtrlCode = '42203' AND code = HNOPD_PRESCRIP.Clinic) LIKE '%WI%'
        AND HNOPD_MASTER.OutDateTime IS NULL
        AND HNOPD_PRESCRIP.CloseVisitCode IS NOT NULL
        AND HNOPD_PRESCRIP.CloseVisitCode NOT IN ('ADM','C01','C02','C03','C04','C05','C06','C07','C08','C09','C10','C11','C12','C13','C14','C15')
        AND HNOPD_RECEIVE_HEADER.ReceiptNo IS NULL
        AND HNOPD_PRESCRIP_MEDICINE.CxlDateTime IS NULL
        AND HNPAT_NAME.SuffixSmall=0
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
 * ดึงข้อมูล LINE User ID จาก VN
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
 * ประมวลผลและส่งการแจ้งเตือนตามสถานะ
 */
async function processQueueStatus(queueData) {
  for (const item of queueData) {
    const { VN, HN, DrugAcknowledge, DrugReady, StockCode, PatientName, ClinicName } = item;

    try {
      // ดึง LINE User ID
      const lineUserId = await getLineUserIdByVN(VN, HN);
      if (!lineUserId) {
        console.log(`No LINE User ID found for VN: ${VN}`);
        continue;
      }

      // ตรวจสอบสถานะปัจจุบันในฐานข้อมูล
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

      // กำหนดสถานะใหม่ตามข้อมูลจาก SSB
      let newStatus = currentStatus;
      
      if (StockCode === 'NODRUG') {
        newStatus = 'completed'; // ไม่มียา ถือว่าเสร็จ
      } else if (DrugReady === 1) {
        newStatus = 'medicine_ready'; // ยาพร้อม รอเรียก
      } else if (DrugAcknowledge === 1 && DrugReady === 0) {
        newStatus = 'waiting_medicine'; // รอจัดยา
      }

      // ส่งการแจ้งเตือนตามสถานะ
      if (newStatus === 'waiting_medicine' && !notifiedWaiting) {
        // ส่งแจ้งเตือนรอจัดยา
        const message = `⏳ รอจัดยา

📋 VN: ${VN}
👤 ชื่อ: ${PatientName || '-'}
🏥 คลินิก: ${ClinicName || '-'}

กรุณารอสักครู่ ระบบกำลังจัดเตรียมยาให้คุณ`;

        await sendLineMessage(lineUserId, message);
        
        // บันทึกหรืออัพเดทสถานะ
        if (trackingResult.length === 0) {
          await queryDB2(
            `INSERT INTO pharmacy_queue_tracking 
             (vn, line_user_id, status, notified_waiting) 
             VALUES (?, ?, ?, 1)`,
            [VN, lineUserId, newStatus]
          );
        } else {
          await queryDB2(
            'UPDATE pharmacy_queue_tracking SET status = ?, notified_waiting = 1, updated_at = NOW() WHERE vn = ?',
            [newStatus, VN]
          );
        }

        await logEvent('pharmacy.queue.waiting', { vn: VN, line_user_id: lineUserId });
      } 
      else if (newStatus === 'medicine_ready' && !notifiedReady) {
        // ส่งแจ้งเตือนยาพร้อม รอเรียก
        const message = `✅ ยาของคุณพร้อมแล้ว!

📋 VN: ${VN}
👤 ชื่อ: ${PatientName || '-'}
🏥 คลินิก: ${ClinicName || '-'}

กรุณารอเรียกคิวที่หน้าช่องจ่ายยา
ระบบจะแจ้งเตือนเมื่อถึงคิวของคุณ 🔔`;

        await sendLineMessage(lineUserId, message);
        
        // อัพเดทสถานะ
        await queryDB2(
          'UPDATE pharmacy_queue_tracking SET status = ?, notified_ready = 1, updated_at = NOW() WHERE vn = ?',
          [newStatus, VN]
        );

        await logEvent('pharmacy.queue.ready', { vn: VN, line_user_id: lineUserId });
      }
      else if (newStatus === 'completed' && StockCode === 'NODRUG') {
        // กรณีไม่มียา
        const message = `ℹ️ แจ้งเตือน

📋 VN: ${VN}
👤 ชื่อ: ${PatientName || '-'}

คุณไม่มียาที่ต้องรับในครั้งนี้
กรุณาติดต่อเจ้าหน้าที่หากมีข้อสงสัย`;

        await sendLineMessage(lineUserId, message);
        
        if (trackingResult.length === 0) {
          await queryDB2(
            `INSERT INTO pharmacy_queue_tracking 
             (vn, line_user_id, status, notified_waiting, notified_ready) 
             VALUES (?, ?, ?, 1, 1)`,
            [VN, lineUserId, newStatus]
          );
        } else {
          await queryDB2(
            'UPDATE pharmacy_queue_tracking SET status = ?, updated_at = NOW() WHERE vn = ?',
            [newStatus, VN]
          );
        }

        await logEvent('pharmacy.queue.no_drug', { vn: VN, line_user_id: lineUserId });
      }

    } catch (error) {
      console.error(`Error processing VN ${VN}:`, error);
    }
  }
}

/**
 * ทำความสะอาดข้อมูลเก่า (เก็บแค่วันนี้)
 */
async function cleanupOldRecords() {
  try {
    await queryDB2(
      'DELETE FROM pharmacy_queue_tracking WHERE DATE(created_at) < CURDATE()'
    );
    console.log('Old pharmacy queue records cleaned up');
  } catch (error) {
    console.error('Error cleaning up old records:', error);
  }
}

/**
 * Main monitoring loop
 */
async function startMonitoring() {
  console.log('🚀 Pharmacy Queue Monitor started');

  // ทำความสะอาดข้อมูลเก่าทุกวัน
  setInterval(cleanupOldRecords, 24 * 60 * 60 * 1000);

  // เริ่มตรวจสอบคิว
  while (true) {
    try {
      console.log('🔍 Checking pharmacy queue...');
      const queueData = await fetchPharmacyQueueFromSSB();
      
      if (queueData.length > 0) {
        console.log(`Found ${queueData.length} items in queue`);
        await processQueueStatus(queueData);
      } else {
        console.log('No items in queue');
      }
    } catch (error) {
      console.error('Error in monitoring loop:', error);
      await logEvent('pharmacy.monitor.error', { error: error.message });
    }

    // รอ 30 วินาที
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * ฟังก์ชันสำหรับเรียกคิวจากหน้าจอแสดงผล (เชื่อมกับ TTT)
 */
async function markQueueAsCalled(vn) {
  try {
    // ดึง LINE User ID
    const tracking = await queryDB2(
      'SELECT line_user_id FROM pharmacy_queue_tracking WHERE vn = ? AND status = "medicine_ready"',
      [vn]
    );

    if (tracking.length === 0) {
      return { success: false, message: 'Queue not found or not ready' };
    }

    const lineUserId = tracking[0].line_user_id;

    // ส่งแจ้งเตือนว่าถึงคิว
    const message = `🔔 ถึงคิวของคุณแล้ว!

📋 VN: ${vn}

กรุณามารับยาที่ช่องจ่ายยาด้วยค่ะ`;

    await sendLineMessage(lineUserId, message);

    // อัพเดทสถานะเป็น called
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

// เริ่มการทำงาน
if (require.main === module) {
  startMonitoring().catch(error => {
    console.error('Fatal error in pharmacy queue monitor:', error);
    process.exit(1);
  });
}

module.exports = { startMonitoring, fetchPharmacyQueueFromSSB, markQueueAsCalled };