const sqlServer = require('mssql');
const { queryDB1, queryDB2, queryDB3 } = require('./db');
const { sendLineMessage } = require('./utils/lineNotify');
const { logEvent } = require('./auditLog');
require('dotenv').config();

const POLL_INTERVAL = process.env.POLL_INTERVAL || 15000; // 15 วินาที

/**
 * 🔧 แก้ไข: ดึงข้อมูลคิวจาก SSB ให้ตรงกับหน้า "รอจัดยา" (drug.txt)
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
    console.log(`🔍 พบคิว "รอจัดยา": ${rows.length} รายการ`);
    return rows;
  } catch (error) {
    console.error('❌ Error fetching pharmacy queue (รอจัดยา):', error);
    return [];
  }
}

/**
 * 🔧 เพิ่ม: ดึงข้อมูลคิว "รอเรียก (ยาพร้อม) ตรงกับหน้า showcallV2
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
    console.log(`🔍 พบคิว "รอเรียก": ${rows.length} รายการ`);
    return rows;
  } catch (error) {
    console.error('❌ Error fetching ready queue (รอเรียก):', error);
    return [];
  }
}

/**
 * 🔧 เพิ่ม: ดึงข้อมูลคิว "เรียกแล้ว" ตรงกับหน้า PHP สุดท้าย
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
    console.log(`🔍 พบคิว "เรียกแล้ว": ${rows.length} รายการ`);
    return rows;
  } catch (error) {
    console.error('❌ Error fetching called queue (เรียกแล้ว):', error);
    return [];
  }
}

/**
 * 🔧 เพิ่มฟังก์ชัน: ดึง HN และ ID Card จาก VN ผ่าน SSB
 */
async function getHNAndIdCardByVN(vn) {
  try {
    // 🔧 เพิ่มเงื่อนไข VisitDate = วันนี้ เพื่อป้องกันดึง VN ซ้ำจากวันก่อน
    const sql = `
      SELECT TOP 1 
        OM.HN,
        N.ID as IdCard,
        OM.VN,
        OM.VisitDate
      FROM HNOPD_MASTER OM WITH (NOLOCK)
      LEFT JOIN HNName N ON OM.HN = N.HN
      WHERE OM.VN = @vn 
        AND CONVERT(DATE, OM.VisitDate) = CONVERT(DATE, GETDATE())
        AND N.ID IS NOT NULL
      ORDER BY OM.VisitDate DESC
    `;
    
    const result = await queryDB1(sql, {
      vn: { type: sqlServer.VarChar, value: vn }
    });

    if (result.length > 0) {
      const idCard = result[0].IdCard;
      console.log(`🔎 [getHNAndIdCardByVN] VN: ${vn} -> HN: ${result[0].HN}, ID: ${idCard || 'N/A'}, VisitDate: ${result[0].VisitDate}`);
      
      // ตรวจสอบว่า ID Card ไม่ใช่ค่าว่างหรือ invalid
      if (idCard && idCard.length >= 13) {
        return {
          hn: result[0].HN,
          idCard: idCard
        };
      }
      
      // ถ้า ID Card ไม่ valid ให้คืน HN อย่างเดียว
      return {
        hn: result[0].HN,
        idCard: null
      };
    }
    
    console.log(`❌ [getHNAndIdCardByVN] ไม่พบข้อมูลสำหรับ VN: ${vn}`);
    return null;
  } catch (error) {
    console.error(`Error getting HN/ID from VN ${vn}:`, error);
    return null;
  }
}

/**
 * 🔧 แก้ไข: ดึง LINE User ID โดยรองรับหลาย format HN และ fallback ไป ID Card
 */
async function getLineUserIdByVN(vn, hn) {
  try {
    console.log(`🔎 [getLineUserIdByVN] VN: ${vn}, HN: ${hn || 'ไม่ระบุ'}`);
    
    let hnData = null;
    
    // 🔧 ถ้าไม่มี HN ให้ดึงจาก SSB
    if (!hn) {
      console.log(`🔍 ดึง HN และ ID Card จาก SSB...`);
      hnData = await getHNAndIdCardByVN(vn);
      
      if (hnData) {
        hn = hnData.hn;
        console.log(`✅ ได้ HN: ${hn}, ID Card: ${hnData.idCard || 'N/A'}`);
      } else {
        console.log(`❌ ไม่พบข้อมูลใน SSB สำหรับ VN: ${vn}`);
        return null;
      }
    }
    
    // 🔧 ลองหา LINE User ID จาก HN (รองรับทั้งมี - และไม่มี -)
    if (hn) {
      // ลองหาแบบตรงๆก่อน
      let result = await queryDB2(
        `SELECT line_user_id, id_card, hn 
         FROM line_registered_users 
         WHERE hn = ? 
         LIMIT 1`,
        [hn]
      );

      if (result.length > 0) {
        console.log(`✅ พบ LINE User ID จาก HN (ตรงทุกตัว): ${result[0].line_user_id}`);
        return result[0].line_user_id;
      }

      // 🔧 ลองหาแบบเอา - ออก (กรณี DB เก็บ 55-003514 แต่ได้มา 55003514)
      const hnWithoutDash = hn.replace(/-/g, '');
      result = await queryDB2(
        `SELECT line_user_id, id_card, hn 
         FROM line_registered_users 
         WHERE REPLACE(hn, '-', '') = ? 
         LIMIT 1`,
        [hnWithoutDash]
      );

      if (result.length > 0) {
        console.log(`✅ พบ LINE User ID จาก HN (เอา - ออก): ${result[0].line_user_id}`);
        return result[0].line_user_id;
      }

      console.log(`⚠️ ไม่พบ LINE User ID จาก HN: ${hn}, ลองใช้ ID Card...`);
    }

    // 🔧 ลองหาจาก ID Card
    if (hnData && hnData.idCard) {
      const lineUserResult = await queryDB2(
        'SELECT line_user_id FROM line_registered_users WHERE id_card = ? LIMIT 1',
        [hnData.idCard]
      );
      
      if (lineUserResult.length > 0) {
        console.log(`✅ พบ LINE User ID จาก ID Card: ${lineUserResult[0].line_user_id}`);
        return lineUserResult[0].line_user_id;
      }
    } else if (!hnData) {
      // ถ้ายังไม่มี hnData ให้ดึงจาก SSB อีกครั้ง
      console.log(`🔍 ลองดึง ID Card จาก SSB อีกครั้ง...`);
      const ssbData = await getHNAndIdCardByVN(vn);
      
      if (ssbData && ssbData.idCard) {
        const lineUserResult = await queryDB2(
          'SELECT line_user_id FROM line_registered_users WHERE id_card = ? LIMIT 1',
          [ssbData.idCard]
        );
        
        if (lineUserResult.length > 0) {
          console.log(`✅ พบ LINE User ID จาก ID Card: ${lineUserResult[0].line_user_id}`);
          return lineUserResult[0].line_user_id;
        }
      }
    }

    console.log(`❌ ไม่พบ LINE User ID สำหรับ VN: ${vn}`);
    
    // 🔧 Debug: แสดง HN ที่ใกล้เคียง (เฉพาะตอน dev)
    if (hn && process.env.NODE_ENV !== 'production') {
      try {
        const debugCheck = await queryDB2(
          `SELECT hn, id_card FROM line_registered_users 
           WHERE hn LIKE ? OR REPLACE(hn, '-', '') LIKE ? 
           LIMIT 5`,
          [`%${hn.slice(-4)}%`, `%${hn.replace(/-/g, '').slice(-4)}%`]
        );
        if (debugCheck.length > 0) {
          console.log(`🔍 Debug - HN ที่ใกล้เคียง:`, debugCheck.map(r => r.hn));
        }
      } catch (e) {
        // Silent fail
      }
    }
    
    return null;
  } catch (error) {
    console.error(`❌ Error getting LINE User ID for VN ${vn}:`, error);
    return null;
  }
}

/**
 * ✅ เปลี่ยนใหม่: บันทึกข้อมูลคิวลง Database แทนการส่งข้อความทันที (เปลี่ยนจาก Push เป็น Reply)
 */
async function updateQueueDatabase(waitingQueue, readyQueue) {
  // ประมวลผลคิว "รอจัดยา"
  for (const item of waitingQueue) {
    const { VN, HN, PatientName, ClinicName } = item;

    try {
      const lineUserId = await getLineUserIdByVN(VN, HN);
      if (!lineUserId) {
        console.log(`⚠️ VN ${VN}: ไม่พบ LINE User ID`);
        continue;
      }

      // บันทึกข้อมูลลง DB แทนการส่งข้อความ
      await queryDB2(
        `INSERT INTO pharmacy_queue_tracking 
         (vn, line_user_id, status, patient_name, clinic_name, has_unread, created_at, updated_at) 
         VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())
         ON DUPLICATE KEY UPDATE 
         status = VALUES(status), 
         patient_name = VALUES(patient_name), 
         clinic_name = VALUES(clinic_name), 
         has_unread = 1, 
         updated_at = NOW()`,
        [VN, lineUserId, 'waiting_medicine', PatientName, ClinicName]
      );

      console.log(`📝 บันทึกสถานะ "รอจัดยา" VN: ${VN}`);
    } catch (error) {
      console.error(`❌ Error updating queue VN ${VN}:`, error);
    }
  }

  // ประมวลผลคิว "รอเรียก" (ยาพร้อม)
  for (const item of readyQueue) {
    const { VN, HN, Name, Clinic, MEDICINE } = item;

    try {
      const lineUserId = await getLineUserIdByVN(VN, HN);
      if (!lineUserId) {
        console.log(`⚠️ VN ${VN}: ไม่พบ LINE User ID`);
        continue;
      }

      let status = MEDICINE === 'ไม่มียา' ? 'no_medicine' : 'medicine_ready';

      await queryDB2(
        `INSERT INTO pharmacy_queue_tracking 
         (vn, line_user_id, status, patient_name, clinic_name, has_unread, created_at, updated_at) 
         VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())
         ON DUPLICATE KEY UPDATE 
         status = VALUES(status), 
         has_unread = 1, 
         updated_at = NOW()`,
        [VN, lineUserId, status, Name, Clinic]
      );

      console.log(`✅ บันทึกสถานะ "${MEDICINE}" VN: ${VN}`);
    } catch (error) {
      console.error(`❌ Error updating ready queue VN ${VN}:`, error);
    }
  }
}

/**
 * 🔧 ดึงข้อมูลจาก paymentq ใน DB3 (ไม่มี HN - ต้องไปหาจาก SSB)
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
 * ✅ เปลี่ยนใหม่: บันทึกข้อมูล Payment Queue ลง Database แทนการส่งข้อความทันที
 */
async function updatePaymentQueueDatabase(rows) {
  console.log(`🔍 เริ่มประมวลผล Payment Queue: ${rows.length} รายการ`);
  
  for (const row of rows) {
    try {
      const vn = row.vn;
      const paymentSlot = row.payment_slot ? String(row.payment_slot) : '-';
      
      console.log(`\n--- Processing VN: ${vn}, Payment Slot: ${paymentSlot} ---`);
      
      if (!vn) {
        console.log(`⚠️ ข้าม: VN เป็น null/undefined`);
        continue;
      }

      // ตรวจสอบว่าเคยบันทึกแล้วหรือยัง
      const tracking = await queryDB2(
        'SELECT * FROM payment_queue_tracking WHERE vn = ? AND payment_slot = ?',
        [vn, paymentSlot]
      );

      if (tracking.length > 0) {
        console.log(`⚠️ ข้าม VN ${vn}: บันทึกไว้แล้ว (Slot: ${paymentSlot})`);
        continue;
      }

      // ดึง LINE User ID
      console.log(`🔍 กำลังค้นหา LINE User ID สำหรับ VN: ${vn}`);
      const lineUserId = await getLineUserIdByVN(vn, null);
      
      if (!lineUserId) {
        console.log(`❌ ไม่พบ LINE User ID สำหรับ VN: ${vn}`);
        continue;
      }
      
      console.log(`✅ พบ LINE User ID: ${lineUserId}`);

      // บันทึกลง Database แทนการส่งข้อความ
      await queryDB2(
        `INSERT INTO payment_queue_tracking (vn, line_user_id, payment_slot, has_unread, created_at, updated_at)
         VALUES (?, ?, ?, 1, NOW(), NOW())`,
        [vn, lineUserId, paymentSlot]
      );

      await logEvent('payment.queue.recorded', {
        vn,
        line_user_id: lineUserId,
        payment_slot: paymentSlot
      });

      console.log(`📝 บันทึกข้อมูลชำระเงิน VN: ${vn}, Slot: ${paymentSlot}`);

    } catch (err) {
      console.error(`❌ Error processing payment queue row (VN: ${row.vn}):`, err);
    }
  }
  
  console.log(`\n✅ ประมวลผล Payment Queue เสร็จสิ้น\n`);
}

/**
 * 🆕 ฟังก์ชันใหม่: ดึงข้อมูลจาก ordermed (รอรับยา)
 */
async function fetchMedicinePickupQueueFromDB3() {
  try {
    const sql = `
      SELECT id, vn, name, prescription_no, clinic_name, sub, created_at
      FROM ordermed
      WHERE DATE(created_at) = CURDATE()
      ORDER BY created_at DESC
      LIMIT 200
    `;
    const rows = await queryDB3(sql);
    console.log(`🔍 พบคิว "รอรับยา" (ordermed): ${rows.length} รายการ`);
    return rows;
  } catch (err) {
    console.error('❌ Error fetching medicine pickup queue from DB3:', err);
    return [];
  }
}

/**
 * 🆕 ฟังก์ชันใหม่: บันทึกข้อมูล "รอรับยา" และส่งการแจ้งเตือน
 */
async function updateMedicinePickupQueueDatabase(rows) {
  console.log(`🔍 เริ่มประมวลผล Medicine Pickup Queue: ${rows.length} รายการ`);
  
  for (const row of rows) {
    try {
      const vn = row.vn;
      const patientName = row.name;
      const clinicName = row.clinic_name || 'ไม่ระบุคลินิก';
      
      console.log(`\n--- Processing VN: ${vn} (รอรับยา) ---`);
      
      if (!vn) {
        console.log(`⚠️ ข้าม: VN เป็น null/undefined`);
        continue;
      }

      // ตรวจสอบว่าเคยส่งการแจ้งเตือนแล้วหรือยัง
      const tracking = await queryDB2(
        'SELECT * FROM medicine_pickup_tracking WHERE vn = ? AND DATE(created_at) = CURDATE()',
        [vn]
      );

      if (tracking.length > 0) {
        console.log(`⚠️ ข้าม VN ${vn}: ส่งการแจ้งเตือนไปแล้ว`);
        continue;
      }

      // ดึง LINE User ID
      console.log(`🔍 กำลังค้นหา LINE User ID สำหรับ VN: ${vn}`);
      const lineUserId = await getLineUserIdByVN(vn, null);
      
      if (!lineUserId) {
        console.log(`❌ ไม่พบ LINE User ID สำหรับ VN: ${vn}`);
        continue;
      }
      
      console.log(`✅ พบ LINE User ID: ${lineUserId}`);

      // ส่งการแจ้งเตือน LINE: "รอรับยา"
      const message = `💊 ยาของคุณพร้อมแล้ว - รอรับยา

👤 ชื่อ: ${patientName}
🏥 VN: ${vn}
🏨 คลินิก: ${clinicName}

กรุณามารับยาที่เคาน์เตอร์จ่ายยาค่ะ
━━━━━━━━━━━━━━
📍 ขั้นตอนที่ 5: รอรับยา`;

      await sendLineMessage(lineUserId, message);
      console.log(`📨 ส่งการแจ้งเตือน "รอรับยา" ไปยัง LINE User: ${lineUserId}`);

      // บันทึกลง Database
      await queryDB2(
        `INSERT INTO medicine_pickup_tracking (vn, line_user_id, patient_name, clinic_name, status, has_unread, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'waiting_pickup', 1, NOW(), NOW())`,
        [vn, lineUserId, patientName, clinicName]
      );

      await logEvent('medicine.pickup.notified', {
        vn,
        line_user_id: lineUserId,
        patient_name: patientName
      });

      console.log(`✅ บันทึกข้อมูล "รอรับยา" VN: ${vn}`);

    } catch (err) {
      console.error(`❌ Error processing medicine pickup queue (VN: ${row.vn}):`, err);
    }
  }
  
  console.log(`\n✅ ประมวลผล Medicine Pickup Queue เสร็จสิ้น\n`);
}

/**
 * 🆕 ฟังก์ชันใหม่: ตรวจจับว่ารับยาเสร็จแล้ว (ถูกลบออกจาก ordermed)
 */
async function checkCompletedMedicinePickup() {
  try {
    console.log(`🔍 ตรวจสอบว่ามี VN ไหนรับยาเสร็จแล้ว...`);
    
    // ดึง VN ที่อยู่ใน tracking แต่ไม่อยู่ใน ordermed แล้ว (แปลว่ารับยาเสร็จแล้ว)
    const completedVNs = await queryDB2(
      `SELECT t.vn, t.line_user_id, t.patient_name
       FROM medicine_pickup_tracking t
       WHERE t.status = 'waiting_pickup'
       AND DATE(t.created_at) = CURDATE()
       AND NOT EXISTS (
         SELECT 1 FROM ordermed o WHERE o.vn = t.vn AND DATE(o.created_at) = CURDATE()
       )`
    );

    if (completedVNs.length === 0) {
      console.log(`✅ ไม่มี VN ที่รับยาเสร็จในรอบนี้`);
      return;
    }

    console.log(`🎉 พบ ${completedVNs.length} VN ที่รับยาเสร็จแล้ว`);

    for (const item of completedVNs) {
      try {
        const { vn, line_user_id, patient_name } = item;

        // ส่งการแจ้งเตือน LINE: "เสร็จสิ้น"
        const message = `✅ รับยาเสร็จสิ้น

👤 ชื่อ: ${patient_name}
🏥 VN: ${vn}

ขอบคุณที่ใช้บริการค่ะ
หวังว่าจะได้พบกันใหม่นะคะ 😊
━━━━━━━━━━━━━━
📍 ขั้นตอนที่ 6: เสร็จสิ้น`;

        await sendLineMessage(line_user_id, message);
        console.log(`📨 ส่งการแจ้งเตือน "เสร็จสิ้น" ไปยัง LINE User: ${line_user_id}`);

        // อัพเดทสถานะเป็น completed
        await queryDB2(
          `UPDATE medicine_pickup_tracking 
           SET status = 'completed', has_unread = 1, updated_at = NOW()
           WHERE vn = ?`,
          [vn]
        );

        await logEvent('medicine.pickup.completed', {
          vn,
          line_user_id,
          patient_name
        });

        console.log(`✅ อัพเดทสถานะ "เสร็จสิ้น" VN: ${vn}`);

      } catch (err) {
        console.error(`❌ Error processing completed VN ${item.vn}:`, err);
      }
    }

  } catch (err) {
    console.error('❌ Error checking completed medicine pickup:', err);
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
    
    try {
      await queryDB2(
        'DELETE FROM payment_queue_tracking WHERE DATE(created_at) < CURDATE()'
      );
    } catch (e) {
      console.warn('Warning: unable to cleanup payment_queue_tracking:', e.message);
    }

    try {
      await queryDB2(
        'DELETE FROM medicine_pickup_tracking WHERE DATE(created_at) < CURDATE()'
      );
    } catch (e) {
      console.warn('Warning: unable to cleanup medicine_pickup_tracking:', e.message);
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

    const message = `📢 ถึงคิวของคุณแล้ว!

🏥 VN: ${vn}

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
 * 🔄 Main monitoring loop - แก้ไขให้ดึงทั้ง 4 คิว + เก็บข้อมูลลง DB แทน Push
 */
async function startMonitoring() {
  console.log('🚀 Pharmacy Queue Monitor started (ปรับให้ตรงกับหน้าจอ PHP + เพิ่ม ordermed tracking)');

  // ทดลองเชื่อมต่อ DB3 แต่ไม่ให้ crash
  try {
    await queryDB3();
    console.log('✅ DB3 Connected');
  } catch (e) {
    console.warn('⚠️ DB3 connection failed initially, will retry on each loop');
  }

  // ทำความสะอาดข้อมูลเก่าทุกวัน
  setInterval(cleanupOldRecords, 24 * 60 * 60 * 1000);

  let errorCount = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  // เริ่มตรวจสอบคิว
  while (true) {
    try {
      console.log('\n🔄 กำลังตรวจสอบคิวทั้งหมด...');
      
      // 1. ดึงคิว "รอจัดยา" (DrugReady=0)
      let waitingQueue = [];
      try {
        console.log('🔍 [1/4] ตรวจสอบคิว "รอจัดยา"...');
        waitingQueue = await fetchPharmacyQueueFromSSB();
        errorCount = 0; // Reset error count on success
      } catch (err) {
        console.error('❌ Error fetching waiting queue:', err.message);
        errorCount++;
      }
      
      // 2. ดึงคิว "รอเรียก" (DrugReady=1 หรือ NODRUG)
      let readyQueue = [];
      try {
        console.log('🔍 [2/4] ตรวจสอบคิว "รอเรียก"...');
        readyQueue = await fetchReadyQueueFromSSB();
        errorCount = 0; // Reset error count on success
      } catch (err) {
        console.error('❌ Error fetching ready queue:', err.message);
        errorCount++;
      }
      
      // 3. บันทึกข้อมูลลง Database แทนการส่งข้อความ
      if (waitingQueue.length > 0 || readyQueue.length > 0) {
        try {
          console.log('🔍 กำลังบันทึกข้อมูลคิวลง Database...');
          await updateQueueDatabase(waitingQueue, readyQueue);
        } catch (err) {
          console.error('❌ Error updating queue database:', err.message);
        }
      } else {
        console.log('✅ ไม่มีคิวที่ต้องบันทึก');
      }

      // 4. ตรวจสอบ Payment Queue จาก DB3
      try {
        console.log('🔍 [3/4] ตรวจสอบคิว "ชำระเงิน"...');
        const paymentRows = await fetchPaymentQueueFromDB3();
        if (paymentRows && paymentRows.length > 0) {
          console.log(`✅ พบคิวชำระเงิน: ${paymentRows.length} รายการ`);
          await updatePaymentQueueDatabase(paymentRows);
        } else {
          console.log('✅ ไม่มีคิวชำระเงิน');
        }
      } catch (e) {
        console.error('❌ Error checking payment queue (DB3):', e.message);
        // ไม่นับเป็น critical error เพราะ DB3 อาจไม่พร้อม
      }

      // 🆕 5. ตรวจสอบคิว "รอรับยา" จาก ordermed (DB3)
      try {
        console.log('🔍 [4/4] ตรวจสอบคิว "รอรับยา" (ordermed)...');
        const pickupRows = await fetchMedicinePickupQueueFromDB3();
        if (pickupRows && pickupRows.length > 0) {
          console.log(`✅ พบคิว "รอรับยา": ${pickupRows.length} รายการ`);
          await updateMedicinePickupQueueDatabase(pickupRows);
        } else {
          console.log('✅ ไม่มีคิว "รอรับยา"');
        }
      } catch (e) {
        console.error('❌ Error checking medicine pickup queue:', e.message);
      }

      // 🆕 6. ตรวจสอบว่ามี VN ไหนรับยาเสร็จแล้ว (ถูกลบออกจาก ordermed)
      try {
        await checkCompletedMedicinePickup();
      } catch (e) {
        console.error('❌ Error checking completed medicine pickup:', e.message);
      }

      // Reset error count if we got here
      if (errorCount > 0) {
        errorCount = Math.max(0, errorCount - 1);
      }

    } catch (error) {
      console.error('❌ Error in monitoring loop:', error);
      errorCount++;
      
      try {
        await logEvent('pharmacy.monitor.error', { error: error.message });
      } catch (e) {
        // Silent fail on logging
      }
      
      // ถ้า error ติดต่อกันหลายครั้ง ให้รอนานขึ้น
      if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`⚠️ มี error ติดต่อกัน ${errorCount} ครั้ง - รอ 60 วินาที...`);
        await new Promise(resolve => setTimeout(resolve, 60000));
        errorCount = 0; // Reset
        continue;
      }
    }

    // รอ POLL_INTERVAL
    const waitTime = errorCount > 0 ? POLL_INTERVAL * 2 : POLL_INTERVAL;
    console.log(`⏱️ รอ ${waitTime/1000} วินาที...\n`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }
}

// เริ่มการทำงาน
if (require.main === module) {
  startMonitoring().catch(error => {
    console.error('💀 Fatal error in pharmacy queue monitor:', error);
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
  updatePaymentQueueDatabase,
  fetchMedicinePickupQueueFromDB3,
  updateMedicinePickupQueueDatabase,
  checkCompletedMedicinePickup,
  getHNAndIdCardByVN,
  getLineUserIdByVN
};