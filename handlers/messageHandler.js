const sqlServer = require('mssql');
const { queryDB1, queryDB2 } = require('../db');
const redisClient = require('../redisClient');
const { logEvent } = require('../auditLog');
const { isValidIdCard } = require('../utils/validation');
const { formatRightsMessage } = require('../utils/rightsMapper'); 
const axios = require('axios');
const { createToken } = require('../jwtHelper'); 
require('dotenv').config();

const LINE_MESSAGING_API = process.env.LINE_MESSAGING_API;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// ส่งข้อความ Reply พร้อม Quick Reply
async function replyMessage(replyToken, messages, quickReplyItems = []) {
  try {
    const messagePayload = { replyToken, messages };
    if (quickReplyItems.length > 0) {
      messagePayload.messages[0].quickReply = { items: quickReplyItems };
    }
    await axios.post(
      `${LINE_MESSAGING_API}/reply`,
      messagePayload,
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
  } catch (error) {
    console.error('Error sending reply:', error.response?.data || error.message);
  }
}

// ส่งข้อความ Push
async function pushMessage(lineUserId, messages) {
  try {
    await axios.post(
      `${LINE_MESSAGING_API}/push`,
      { to: lineUserId, messages },
      { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
  } catch (error) {
    console.error('Error sending push message:', error.response?.data || error.message);
  }
}

// ตรวจสอบสิทธิ์ผู้ใช้งาน
async function checkUserRights(idCard) {
  const sqlQuery = `
    SELECT 
      R.RightCode,
      R.CompanyCode,
      R.ValidFrom,
      R.ValidTill
    FROM HNPAT_RIGHT R
    INNER JOIN HNPAT_INFO I ON R.HN = I.HN
    WHERE I.PrePatientNo = @id_card
      AND R.ValidFrom IS NOT NULL
      AND R.ValidTill IS NOT NULL
      AND GETDATE() BETWEEN R.ValidFrom AND R.ValidTill
    ORDER BY R.ValidFrom DESC;
  `;

  const rows = await queryDB1(sqlQuery, {
    id_card: { type: sqlServer.VarChar, value: idCard }
  });

  if (!rows.length) return [];

  // ส่งเฉพาะรหัสสิทธิ์ที่ยัง Active อยู่
  const rights = rows.map(r => r.RightCode);
  return rights;
}

// เริ่ม registration  ส่ง LIFF template ให้กรอกเลขบัตร
async function startRegistration(userId, replyToken) {
  const existing = await queryDB2(
    'SELECT id_card FROM line_registered_users WHERE line_user_id = ?',
    [userId]
  );

  let nameWithoutTitle = 'ผู้ใช้งาน';
  let lastName = '';

  if (existing.length > 0) {
    const idCard = existing[0].id_card;

    const sqlQuery = `
      SELECT N.FirstName, N.LastName
      FROM HNOPD_MASTER OM
      LEFT JOIN HNName N ON OM.HN = N.HN
      WHERE N.ID = @id_card
      ORDER BY OM.VN ASC
    `;
    const userInfoRows = await queryDB1(sqlQuery, {
      id_card: { type: sqlServer.VarChar, value: idCard }
    });

    if (userInfoRows.length > 0) {
      nameWithoutTitle = (userInfoRows[0].FirstName || '').replace(/^(นาย|นาง|นางสาว)/, '').trim();
      lastName = (userInfoRows[0].LastName || '').trim();
    }

    const welcomeMessage = `✅ คุณได้ลงทะเบียนไว้แล้ว\nยินดีต้อนรับคุณ ${nameWithoutTitle} ${lastName}`;

    if (replyToken) {
      await replyMessage(replyToken, [
        { type: 'text', text: welcomeMessage }
      ]);
    } else {
      await pushMessage(userId, [
        { type: 'text', text: welcomeMessage }
      ]);
    }
    return;
  }

  const liffUrl = "https://liff.line.me/2008268424-1GqpgeO5";
  const message = [
    {
      type: "template",
      altText: "ลงทะเบียน",
      template: {
        type: "buttons",
        thumbnailImageUrl: "https://cdn-icons-png.flaticon.com/512/747/747376.png",
        title: "ลงทะเบียนผู้ใช้งาน",
        text: "กรุณากดปุ่มด้านล่างเพื่อกรอกเลขบัตรประชาชน",
        actions: [
          { type: "uri", label: "กรอกข้อมูล", uri: liffUrl }
        ]
      }
    }
  ];

  if (replyToken) {
    await replyMessage(replyToken, message);
  } else {
    await pushMessage(userId, [
      { type: 'text', text: '📝 กรุณากดปุ่มด้านล่างเพื่อกรอกเลขบัตรประชาชน' }
    ]);
  }
}

// ประมวลผลเลขบัตรและลงทะเบียน
async function processIdCardInput(userId, idCard, replyToken) {
  if (!isValidIdCard(idCard)) {
    await replyMessage(replyToken, [
      { type: 'text', text: '❌ กรุณากรอกเลขบัตรประชาชน 13 หลักให้ถูกต้อง' }
    ]);
    return;
  }

  const sqlQuery = `
    SELECT 
      N.HN,
      N.ID AS CID,
      N.InitialName,
      N.FirstName,
      N.LastName,
      N.BirthDateTime AS DOB,
      OM.DefaultRightCode AS DefaultRight,
      OM.VN
    FROM HNOPD_MASTER OM
    LEFT JOIN HNName N ON OM.HN = N.HN
    WHERE N.ID = @id_card
    ORDER BY OM.VN ASC
  `;

  const userInfoRows = await queryDB1(sqlQuery, {
    id_card: { type: sqlServer.VarChar, value: idCard }
  });
  const userInfo = userInfoRows[0];

  if (!userInfo) {
    await replyMessage(replyToken, [
      { type: 'text', text: '❌ ไม่พบข้อมูลเลขบัตรนี้ในระบบวันนี้' }
    ]);
    await logEvent('register.failed', { userId, id_card: idCard, reason: 'Not found in HNOPD_MASTER' });
    return;
  }

  const nameWithoutTitle = (userInfo.FirstName || '').replace(/^(นาย|นาง|นางสาว)/, '').trim();
  const lastName = (userInfo.LastName || '').trim();

  try {
    await queryDB2(
      'INSERT INTO line_registered_users (line_user_id, id_card, full_name, hn, registered_at) VALUES (?, ?, ?, ?, NOW())',
      [userId, idCard, `${nameWithoutTitle} ${lastName}`, userInfo.HN]
    );

    await redisClient.del(`session:${userId}`);

    const tokenPayload = {
      lineUserId: userId,
      id_card: idCard,
      full_name: `${nameWithoutTitle} ${lastName}`
    };
    const jwtToken = createToken(tokenPayload, '24h');

    // ส่งข้อความยินดีต้อนรับ
    if (replyToken) {
      await replyMessage(replyToken, [
        { type: 'text', text: `✅ ลงทะเบียนสำเร็จ!\nยินดีต้อนรับคุณ ${nameWithoutTitle} ${lastName}` }
      ]);
    } else {
      await pushMessage(userId, [
        { type: 'text', text: `✅ ลงทะเบียนสำเร็จ!\nยินดีต้อนรับคุณ ${nameWithoutTitle} ${lastName}` }
      ]);
    }

    // แจ้งสิทธิ์ผู้ใช้
    const userRights = await checkUserRights(idCard);
    const rightsMessage = formatRightsMessage(userRights);

    await pushMessage(userId, [{ type: 'text', text: rightsMessage }]);

    // แจ้งเตือนเพิ่มเติมหลัง 2 วินาที
    setTimeout(async () => {
      await pushMessage(userId, [
        { type: 'text', text: '🎉 ขอบคุณที่ลงทะเบียนกับเรา\nคุณจะได้รับข้อความแจ้งเตือนสำคัญผ่าน LINE OA นี้' }
      ]);
    }, 2000);

    await logEvent('register.success', { userId, id_card: idCard, jwtToken });

  } catch (error) {
    console.error(error);
    if (error.code === 'ER_DUP_ENTRY') {
      const welcomeMessage = `✅ คุณได้ลงทะเบียนไว้แล้ว\nยินดีต้อนรับคุณ ${nameWithoutTitle} ${lastName}`;
      if (replyToken) {
        await replyMessage(replyToken, [{ type: 'text', text: welcomeMessage }]);
      } else {
        await pushMessage(userId, [{ type: 'text', text: welcomeMessage }]);
      }
      await logEvent('register.failed', { userId, id_card: idCard, reason: 'Duplicate entry' });
      return;
    }

    await replyMessage(replyToken, [
      { type: 'text', text: '❌ เกิดข้อผิดพลาดในการลงทะเบียน\nกรุณาลองใหม่อีกครั้ง' }
    ]);
    await logEvent('register.failed', { userId, id_card: idCard, reason: 'DB2 insert error' });
  }
}

/**
 * ✅ เพิ่มใหม่: ตรวจสอบสถานะคิวยา (Reply แทน Push)
 */
async function handleCheckPharmacyQueue(lineUserId, replyToken) {
  try {
    // ดึงข้อมูลคิวของผู้ใช้
    const queues = await queryDB2(
      `SELECT vn, status, patient_name, clinic_name, created_at, updated_at 
       FROM pharmacy_queue_tracking 
       WHERE line_user_id = ? 
       AND DATE(created_at) = CURDATE()
       ORDER BY created_at DESC`,
      [lineUserId]
    );

    if (queues.length === 0) {
      await replyMessage(replyToken, [
        { 
          type: 'text', 
          text: '❌ ไม่พบข้อมูลคิวของคุณในวันนี้\n\nหากคุณเพิ่งมาตรวจ กรุณารอสักครู่แล้วลองใหม่อีกครั้ง' 
        }
      ]);
      return;
    }

    // สร้างข้อความตอบกลับ
    let message = '📋 สถานะคิวยาของคุณ\n\n';
    
    for (const queue of queues) {
      const statusEmoji = {
        'waiting_medicine': '⏳ รอจัดยา',
        'medicine_ready': '✅ ยาพร้อมแล้ว',
        'no_medicine': '🔔 ไม่มียา',
        'called': '📢 เรียกแล้ว',
        'completed': '✔️ เสร็จสิ้น'
      };

      message += `🏥 VN: ${queue.vn}\n`;
      message += `👤 ชื่อ: ${queue.patient_name || '-'}\n`;
      message += `🏨 คลินิก: ${queue.clinic_name || '-'}\n`;
      message += `📊 สถานะ: ${statusEmoji[queue.status] || queue.status}\n`;
      
      if (queue.status === 'medicine_ready') {
        message += `\n✨ กรุณารอเรียกคิวที่หน้าช่องจ่ายยา\nระบบจะแจ้งเตือนเมื่อถึงคิวของคุณ 🔔\n`;
      } else if (queue.status === 'waiting_medicine') {
        message += `\n💊 กรุณารอสักครู่ ระบบกำลังจัดเตรียมยาให้คุณ\n`;
      } else if (queue.status === 'no_medicine') {
        message += `\n📝 คุณไม่มียาที่ต้องรับในครั้งนี้\n`;
      }
      
      message += `\n───────────────\n\n`;
    }

    // อัพเดทว่าผู้ใช้อ่านแล้ว
    await queryDB2(
      'UPDATE pharmacy_queue_tracking SET has_unread = 0 WHERE line_user_id = ? AND DATE(created_at) = CURDATE()',
      [lineUserId]
    );

    await replyMessage(replyToken, [
      { type: 'text', text: message.trim() }
    ]);

  } catch (error) {
    console.error('Error handling check pharmacy queue:', error);
    await replyMessage(replyToken, [
      { 
        type: 'text', 
        text: '❌ เกิดข้อผิดพลาดในการตรวจสอบคิว\nกรุณาลองใหม่อีกครั้ง' 
      }
    ]);
  }
}

/**
 * ✅ เพิ่มใหม่: ตรวจสอบสถานะคิวชำระเงิน (Reply แทน Push)
 */
async function handleCheckPaymentQueue(lineUserId, replyToken) {
  try {
    const payments = await queryDB2(
      `SELECT vn, payment_slot, created_at, updated_at 
       FROM payment_queue_tracking 
       WHERE line_user_id = ? 
       AND DATE(created_at) = CURDATE()
       ORDER BY created_at DESC`,
      [lineUserId]
    );

    if (payments.length === 0) {
      await replyMessage(replyToken, [
        { 
          type: 'text', 
          text: '❌ ไม่พบข้อมูลคิวชำระเงินของคุณในวันนี้' 
        }
      ]);
      return;
    }

    let message = '💰 สถานะคิวชำระเงิน\n\n';
    
    for (const payment of payments) {
      message += `🏥 VN: ${payment.vn}\n`;
      message += `🔢 ช่องชำระเงิน: ${payment.payment_slot}\n`;
      message += `\n📍 กรุณาไปที่ช่องชำระเงินหมายเลข ${payment.payment_slot} เพื่อทำการชำระเงินค่ะ\n`;
      message += `\n───────────────\n\n`;
    }

    // อัพเดทว่าผู้ใช้อ่านแล้ว
    await queryDB2(
      'UPDATE payment_queue_tracking SET has_unread = 0 WHERE line_user_id = ? AND DATE(created_at) = CURDATE()',
      [lineUserId]
    );

    await replyMessage(replyToken, [
      { type: 'text', text: message.trim() }
    ]);

  } catch (error) {
    console.error('Error handling check payment queue:', error);
    await replyMessage(replyToken, [
      { 
        type: 'text', 
        text: '❌ เกิดข้อผิดพลาดในการตรวจสอบคิวชำระเงิน\nกรุณาลองใหม่อีกครั้ง' 
      }
    ]);
  }
}

async function handleCheckAllStatus(lineUserId, replyToken) {
  try {
    console.log(`🔍 [handleCheckAllStatus] Checking status for user: ${lineUserId}`);

    // 1. ตรวจสอบว่าลงทะเบียนแล้วหรือยัง
    const userRows = await queryDB2(
      'SELECT id_card, full_name, hn FROM line_registered_users WHERE line_user_id = ? LIMIT 1',
      [lineUserId]
    );

    if (userRows.length === 0) {
      await replyMessage(replyToken, [
        {
          type: 'text',
          text: '❌ คุณยังไม่ได้ลงทะเบียน\n\n📝 กรุณากดปุ่ม "ลงทะเบียน" เพื่อเริ่มใช้งานระบบ'
        }
      ]);
      return;
    }

    const user = userRows[0];
    const idCard = user.id_card;
    const fullName = user.full_name;
    const hn = user.hn;
    console.log(`✅ User found: ${fullName} (HN: ${hn})`);

    // 2. ตรวจสอบสิทธิ์การรักษา
    let rightsText = '';
    try {
      const userRights = await checkUserRights(idCard);
      if (userRights.length > 0) {
        rightsText = `✅ สิทธิ์การรักษา: ${userRights.join(', ')}`;
      } else {
        rightsText = '⚠️ ไม่พบสิทธิ์การรักษาที่ Active';
      }
    } catch (err) {
      console.error('Error checking rights:', err);
      rightsText = '⚠️ ไม่สามารถตรวจสอบสิทธิ์ได้';
    }

    // 3. ดึงข้อมูล Real-time จาก SSB โดยตรง
    let statusText = '';
    try {
      const vnQuery = `
        SELECT 
          OM.VN, OM.HN, OM.VisitDate, OM.OutDateTime,
          SUBSTRING(N.FirstName, 2, 100) + ' ' + SUBSTRING(N.LastName, 2, 100) AS PatientName,
          -- สถานะยา (ดึงทุกใบ)
          P.PrescriptionNo,
          ISNULL(P.DrugAcknowledge, 0) AS DrugAcknowledge,
          ISNULL(P.DrugReady, 0) AS DrugReady,
          P.CloseVisitCode,
          P.ApprovedByUserCode,
          -- สถานะชำระเงิน
          RH.ReceiptNo,
          -- ข้อมูลยา (กรองตามเงื่อนไข)
          PM.StockCode,
          PM.CxlDateTime,
          PM.RightCode,
          PM.OutsideHospitalDrug,
          -- ข้อมูล StockMaster
          S.StockComposeCategory,
          -- คลินิก
          (SELECT ISNULL(SUBSTRING(LocalName, 2, 1000), SUBSTRING(EnglishName, 2, 1000))
           FROM DNSYSCONFIG WHERE CtrlCode = '42203' AND code = P.Clinic) AS ClinicName
        FROM HNOPD_MASTER OM WITH (NOLOCK)
        LEFT JOIN HNName N ON OM.HN = N.HN
        LEFT JOIN HNOPD_PRESCRIP P ON OM.VisitDate = P.VisitDate AND OM.VN = P.VN
        LEFT JOIN HNOPD_RECEIVE_HEADER RH ON OM.VisitDate = RH.VisitDate AND OM.VN = RH.VN
        LEFT JOIN HNOPD_PRESCRIP_MEDICINE PM ON P.VisitDate = PM.VisitDate 
          AND P.VN = PM.VN 
          AND P.PrescriptionNo = PM.PrescriptionNo
        LEFT JOIN DNSTOCK..STOCKMASTER S ON PM.StockCode = S.StockCode
        WHERE OM.HN = @hn
          AND CONVERT(DATE, OM.VisitDate) = CONVERT(DATE, GETDATE())
          AND OM.Cxl = 0
          AND P.PrescriptionNo IS NOT NULL
        ORDER BY OM.VisitDate DESC, OM.VN, P.PrescriptionNo
      `;

      const vnResult = await queryDB1(vnQuery, {
        hn: { type: sqlServer.VarChar, value: hn }
      });

      if (vnResult.length === 0) {
        statusText = '\n\n📋 สถานะวันนี้: ยังไม่มีการมาตรวจ';
      } else {
        // **ขั้นตอนที่ 1: Group by VN**
        const vnGroups = {};
        for (const row of vnResult) {
          if (!vnGroups[row.VN]) {
            vnGroups[row.VN] = [];
          }
          vnGroups[row.VN].push(row);
        }

        const vnList = Object.keys(vnGroups);
        console.log(`📊 Found ${vnList.length} VN(s):`, vnList);

        // **ขั้นตอนที่ 2: ตรวจสอบว่ามีหลาย VN หรือไม่**
        if (vnList.length > 1) {
          statusText = `\n\n⚠️ วันนี้คุณมาตรวจ ${vnList.length} ครั้ง\n`;
          for (const vn of vnList) {
            const vnData = vnGroups[vn];
            const vnStatus = analyzeVNStatus(vn, vnData);
            statusText += `\n${vnStatus}`;
          }
        } else {
          const vn = vnList[0];
          const vnData = vnGroups[vn];
          statusText = analyzeVNStatus(vn, vnData);
        }

        // เพิ่มข้อมูลคิวชำระเงิน (ถ้ามี)
        try {
          const paymentQueues = await queryDB2(
            `SELECT vn, payment_slot FROM payment_queue_tracking 
             WHERE line_user_id = ? AND DATE(created_at) = CURDATE() 
             ORDER BY created_at DESC LIMIT 1`,
            [lineUserId]
          );
          if (paymentQueues.length > 0) {
            const payment = paymentQueues[0];
            statusText += `\n\n━━━━━━━━━━━━━━\n💰 คิวชำระเงิน\n━━━━━━━━━━━━━━\n\n🔢 ช่อง: ${payment.payment_slot}\n📍 กรุณาชำระเงินที่ช่อง ${payment.payment_slot}`;
          }
        } catch (e) {
          console.error('Error checking payment queue:', e);
        }
      }
    } catch (err) {
      console.error('Error checking visit status:', err);
      statusText = '\n\n⚠️ ไม่สามารถตรวจสอบสถานะได้ในขณะนี้';
    }

    // 4. รวมข้อความทั้งหมด
    const finalMessage = `👤 คุณ ${fullName}\n${statusText}\n\n━━━━━━━━━━━━━━\n⏰ อัพเดท: ${new Date().toLocaleString('th-TH')}`;

    // 5. ส่งข้อความตอบกลับ
    await replyMessage(replyToken, [
      { type: 'text', text: finalMessage }
    ]);

    console.log(`✅ Status check completed for user: ${lineUserId}`);
  } catch (error) {
    console.error('❌ Error in handleCheckAllStatus:', error);
    await replyMessage(replyToken, [
      {
        type: 'text',
        text: '❌ เกิดข้อผิดพลาดในการตรวจสอบสถานะ\nกรุณาลองใหม่อีกครั้ง หรือติดต่อเจ้าหน้าที่'
      }
    ]);
  }
}

// **ฟังก์ชันวิเคราะห์สถานะของแต่ละ VN**
function analyzeVNStatus(vn, vnData) {
  let maxStepNumber = 0;
  let currentStep = '';
  let stepDetails = '';

  // นับจำนวนแต่ละสถานะ
  let countWaitingApprove = 0;
  let countWaitingMedicine = 0;
  let countMedicineReady = 0;
  let countNoDrug = 0;
  let countCompleted = 0;

  // สร้าง Map สำหรับจัดกลุ่มตามคลินิก
  const clinicMap = {};
  let receiptNo = null;

  for (const prescription of vnData) {
    const clinicName = prescription.ClinicName || 'ไม่ระบุคลินิก';

    // เก็บเลขที่ใบเสร็จ (ถ้ามี)
    if (prescription.ReceiptNo) {
      receiptNo = prescription.ReceiptNo;
    }

    // สร้าง entry ใหม่สำหรับคลินิกถ้ายังไม่มี
    if (!clinicMap[clinicName]) {
      clinicMap[clinicName] = {
        total: 0,
        withDrug: 0,
        noDrug: 0
      };
    }

    // **เงื่อนไขการกรองยา (ตาม SQL Query)**
    const isValidDrug = 
      prescription.StockCode && 
      prescription.StockCode !== 'NODRUG' &&
      prescription.CxlDateTime === null &&
      prescription.StockComposeCategory && 
      prescription.StockComposeCategory.startsWith('M') &&
      (!prescription.RightCode || !prescription.RightCode.startsWith('2100'));

    // นับสถานะแต่ละใบ
    if (prescription.CloseVisitCode && !prescription.ApprovedByUserCode) {
      countWaitingApprove++;
    } else if (prescription.ApprovedByUserCode && 
               prescription.DrugAcknowledge === 1 && 
               prescription.DrugReady === 0 && 
               isValidDrug) {
      countWaitingMedicine++;
      maxStepNumber = Math.max(maxStepNumber, 2);
    } else if (prescription.DrugReady === 1 && 
               !prescription.ReceiptNo && 
               isValidDrug) {
      countMedicineReady++;
      maxStepNumber = Math.max(maxStepNumber, 3);
    } else if (!isValidDrug) {
      countNoDrug++;
    } else if (prescription.ReceiptNo) {
      countCompleted++;
      maxStepNumber = Math.max(maxStepNumber, 6);
    }

    // นับจำนวนยาแต่ละคลินิก (เฉพาะที่ผ่านเงื่อนไข)
    clinicMap[clinicName].total++;
    if (isValidDrug) {
      clinicMap[clinicName].withDrug++;
    } else {
      clinicMap[clinicName].noDrug++;
    }
  }

  // สร้างข้อความรายละเอียดคลินิก (แสดงเฉพาะคลินิกที่มียาที่ผ่านเงื่อนไข)
  const clinicList = Object.entries(clinicMap)
    .filter(([_, data]) => data.withDrug > 0)
    .map(([name, data]) => `💊 ${name} (${data.withDrug} รายการ)`)
    .join('\n');

  const clinicCount = Object.keys(clinicMap).length;

  // กำหนดสถานะหลักตามที่ก้าวหน้าที่สุด
  if (countCompleted > 0 || receiptNo) {
    currentStep = '✔️ เสร็จสิ้น';
    maxStepNumber = 6;
    stepDetails = `ขอบคุณที่ใช้บริการค่ะ\n📄 เลขที่ใบเสร็จ: ${receiptNo}`;
  } else if (countMedicineReady > 0) {
    currentStep = '✅ ยาพร้อมแล้ว - รอชำระเงิน';
    maxStepNumber = 3;
    stepDetails = `มียา ${countMedicineReady} รายการพร้อมแล้ว\nกรุณารอชำระเงินเพื่อรับยา\n🏥 VN: ${vn}`;

    // เพิ่มรายละเอียดคลินิก
    if (clinicList) {
      stepDetails += `\n\n🏥 รายละเอียดยา:\n${clinicList}`;
    }

    if (countWaitingMedicine > 0) {
      stepDetails += `\n\n⏳ อีก ${countWaitingMedicine} รายการกำลังจัดเตรียม`;
    }
  } else if (countWaitingMedicine > 0) {
    currentStep = '⏳ กำลังจัดยา';
    maxStepNumber = 2;
    stepDetails = `เภสัชกรกำลังจัดเตรียมยา ${countWaitingMedicine} รายการ\nกรุณารอสักครู่...\n🏥 VN: ${vn}`;

    // เพิ่มรายละเอียดคลินิก
    if (clinicList) {
      stepDetails += `\n\n🏥 รายละเอียดยา:\n${clinicList}`;
    }
  } else if (countWaitingApprove > 0) {
    currentStep = '📋 ตรวจเสร็จ - รอแพทย์อนุมัติใบสั่งยา';
    maxStepNumber = 1;
    stepDetails = `แพทย์กำลังตรวจสอบและอนุมัติใบสั่งยา ${countWaitingApprove} ใบ`;

    if (clinicCount > 1) {
      const allClinics = Object.keys(clinicMap).join(', ');
      stepDetails += `\n\n🏥 คลินิกที่รักษา: ${allClinics}`;
    }
  } else if (countNoDrug === vnData.length) {
    currentStep = '📋 ไม่มียา';
    maxStepNumber = 4;
    stepDetails = 'คุณไม่มียาที่ต้องรับในครั้งนี้\nสามารถไปชำระเงินได้เลย';
  } else {
    currentStep = '🏥 อยู่ระหว่างการตรวจ';
    maxStepNumber = 0;
    stepDetails = `กรุณารอแพทย์ตรวจเสร็จ\n🏥 VN: ${vn}`;

    if (clinicCount > 1) {
      const allClinics = Object.keys(clinicMap).join(', ');
      stepDetails += `\n\n🏥 คลินิกที่รักษา: ${allClinics}`;
    } else {
      stepDetails += `\n🏨 ${Object.keys(clinicMap)[0]}`;
    }
  }

  // สร้าง Progress Bar
  const steps = [
    '1️⃣ ตรวจเสร็จ',
    '2️⃣ จัดยา',
    '3️⃣ ยาพร้อม',
    '4️⃣ ชำระเงิน',
    '5️⃣ รับยา',
    '6️⃣ เสร็จสิ้น'
  ];

  let progressBar = '\n━━━━━━━━━━━━━━\n📍 ติดตามสถานะ\n━━━━━━━━━━━━━━\n\n';
  for (let i = 0; i < steps.length; i++) {
    if (i < maxStepNumber - 1) {
      progressBar += `✅ ${steps[i]}\n`;
    } else if (i === maxStepNumber - 1) {
      progressBar += `🔵 ${steps[i]} ← ปัจจุบัน\n`;
    } else {
      progressBar += `⚪ ${steps[i]}\n`;
    }
  }

  progressBar += `\n━━━━━━━━━━━━━━\n📊 ${currentStep}\n━━━━━━━━━━━━━━\n\n${stepDetails}`;

  return progressBar;
}

// ฟังก์ชันส่ง Push Message
async function pushMessage(userId, messages) {
  try {
    const response = await axios.post(
      'https://api.line.me/v2/bot/message/push',
      {
        to: userId,
        messages: messages
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
        }
      }
    );

    console.log(`✅ Push message sent to ${userId}`);
    return { success: true };
  } catch (error) {
    console.error('❌ Error sending push message:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { 
  startRegistration, 
  processIdCardInput, 
  replyMessage, 
  pushMessage, 
  checkUserRights,
  handleCheckPharmacyQueue,
  handleCheckPaymentQueue,
  handleCheckAllStatus,
  pushMessage
};