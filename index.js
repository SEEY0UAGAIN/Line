const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { 
  startRegistration, 
  replyMessage, 
  checkRegistrationStatus,
  processIdCardInput,
  handleCheckPharmacyQueue,      
  handleCheckPaymentQueue,
  handleCheckAllStatus        
} = require('./handlers/messageHandler');
const redisClient = require('./redisClient');
const { handlePostback } = require('./handlers/postbackHandler');
const queueRouter = require('./routes');
const { queryDB1, queryDB2, queryDB3 } = require('./db');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

// ========================================
// STATIC FILES - ต้องอยู่ก่อน ROUTES
// ========================================
app.use('/frontend', express.static(path.join(__dirname, 'frontend')));
app.use(express.static(path.join(__dirname, 'frontend'))); // เพิ่มบรรทัดนี้

// ========================================
// BASIC ROUTES
// ========================================
app.get('/webhook', (req, res) => res.send('LINE OA Webhook running'));

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString() 
  });
});

// Dashboard Route - แก้ไขให้ใช้ path.join
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'dashboard.html'));
});

// ========================================
// API ROUTES
// ========================================

// API ดูสถานะคิวทั้งหมด
app.get('/api/pharmacy-queue/status', async (req, res) => {
  console.log('📊 API /api/pharmacy-queue/status called');
  try {
    const queues = await queryDB2(
      `SELECT 
        pq.*,
        lr.full_name,
        lr.id_card
      FROM pharmacy_queue_tracking pq
      LEFT JOIN line_registered_users lr ON pq.line_user_id = lr.line_user_id
      WHERE DATE(pq.created_at) = CURDATE()
      ORDER BY pq.created_at DESC`
    );

    console.log(`✅ Found ${queues.length} queues`);
    
    res.json({ 
      success: true, 
      count: queues.length,
      queues 
    });
  } catch (error) {
    console.error('❌ API pharmacy-queue status error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: error.message
    });
  }
});

// API ดูสถานะคิวทั้งหมด (รวมคนที่ไม่มี LINE)
app.get('/api/pharmacy-queue/all-status', async (req, res) => {
  console.log('📊 API /api/pharmacy-queue/all-status called');
  try {
    // ดึงข้อมูลทั้งหมดจาก SSB
    console.log('🔍 Querying SSB database...');
    const queues = await queryDB1(
      `SELECT DISTINCT 
        HNOPD_MASTER.VN,
        HNOPD_MASTER.HN,
        ISNULL(HNOPD_PRESCRIP.DrugAcknowledge, 0) as DrugAcknowledge,
        ISNULL(HNOPD_PRESCRIP.DrugReady, 0) as DrugReady,
        HNOPD_MASTER.OutDateTime,
        HNOPD_MASTER.VisitDate as VisitDateTime,
        SUBSTRING(ISNULL(dbo.HNPAT_NAME.FirstName, ''), 2, 100) + ' ' + 
        SUBSTRING(ISNULL(dbo.HNPAT_NAME.LastName, ''), 2, 100) AS PatientName,
        HNOPD_PRESCRIP.Clinic,
        (SELECT ISNULL(SUBSTRING(LocalName, 2, 1000), SUBSTRING(EnglishName, 2, 1000))
         FROM DNSYSCONFIG 
         WHERE CtrlCode = '42203' AND code = HNOPD_PRESCRIP.Clinic) AS ClinicName,
        HNOPD_RECEIVE_HEADER.ReceiptNo,
        HNOPD_PRESCRIP_MEDICINE.StockCode
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
        AND HNPAT_NAME.SuffixSmall=0
      ORDER BY HNOPD_MASTER.VN DESC`
    );

    console.log(`✅ Found ${queues.length} queues from SSB`);

    // ดึง LINE User ID จาก DB2 และกำหนดสถานะ
    const { getLineUserIdByVN } = require('./pharmacyQueueMonitor');
    
    console.log('🔍 Checking LINE User IDs and status...');
    for (let i = 0; i < queues.length; i++) {
      try {
        const queue = queues[i];
        
        // เช็ค LINE User ID
        const lineUserId = await getLineUserIdByVN(queue.VN, queue.HN);
        queue.line_user_id = lineUserId;
        
        // กำหนดสถานะ "เสร็จสิ้น" (ชำระเงินแล้ว)
        queue.is_completed = queue.ReceiptNo ? true : false;
        
        // กำหนดสถานะ "ไม่มียา" (NODRUG)
        queue.is_no_drug = queue.StockCode === 'NODRUG' ? true : false;
        
        if (i % 10 === 0) {
          console.log(`Progress: ${i}/${queues.length}`);
        }
      } catch (err) {
        console.error(`Error checking LINE ID for VN ${queues[i].VN}:`, err.message);
        queues[i].line_user_id = null;
        queues[i].is_completed = false;
        queues[i].is_no_drug = false;
      }
    }

    console.log(`✅ LINE check complete`);
    
    res.json({ 
      success: true, 
      count: queues.length,
      queues 
    });
  } catch (error) {
    console.error('❌ API pharmacy-queue all-status error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// API ดูสถิติคิววันนี้
app.get('/api/pharmacy-queue/stats', async (req, res) => {
  console.log('📊 API /api/pharmacy-queue/stats called');
  try {
    const stats = await queryDB2(
      `SELECT 
        status,
        COUNT(*) as count
      FROM pharmacy_queue_tracking
      WHERE DATE(created_at) = CURDATE()
      GROUP BY status`
    );

    const result = {
      waiting_medicine: 0,
      medicine_ready: 0,
      called: 0,
      completed: 0
    };

    stats.forEach(s => {
      result[s.status] = s.count;
    });

    console.log('✅ Stats:', result);

    res.json({ 
      success: true, 
      stats: result,
      total: stats.reduce((sum, s) => sum + s.count, 0)
    });
  } catch (error) {
    console.error('❌ API pharmacy-queue stats error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: error.message
    });
  }
});

// API สำหรับเรียกคิวจากหน้าจอแสดงผล
app.post('/api/call-pharmacy-queue', async (req, res) => {
  console.log('📞 API /api/call-pharmacy-queue called');
  try {
    const { vn } = req.body;
    
    if (!vn) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing VN parameter' 
      });
    }

    const { markQueueAsCalled } = require('./pharmacyQueueMonitor');
    const result = await markQueueAsCalled(vn);

    res.json(result);
  } catch (error) {
    console.error('API call-pharmacy-queue error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// API สำหรับตรวจสอบสิทธิ์จากภายนอก (ต้องมี Token)
app.post('/api/check-rights', async (req, res) => {
  try {
    const { token, idCard } = req.body;
    
    if (!token || !idCard) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required parameters' 
      });
    }

    const { verifyToken } = require('./jwtHelper');
    const decoded = verifyToken(token);
    
    if (!decoded || decoded.id_card !== idCard) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid token or ID card mismatch' 
      });
    }

    const { checkUserRightsFromSSB } = require('./handlers/messageHandler');
    const rightsCheck = await checkUserRightsFromSSB(idCard);

    if (!rightsCheck.success) {
      return res.status(404).json({ 
        success: false, 
        message: rightsCheck.message 
      });
    }

    res.json({
      success: true,
      data: {
        userInfo: rightsCheck.userInfo,
        rights: rightsCheck.rights,
        rightGroups: rightsCheck.rightGroups,
        latestVisit: rightsCheck.latestVisit
      }
    });

  } catch (error) {
    console.error('API check-rights error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// API สำหรับ LIFF Registration
app.post('/liff-register', async (req, res) => {
  try {
    const { userId, firstName, lastName, idCard, birthDate, phone, pdpaConsent } = req.body;

    if (!userId || !firstName || !lastName || !idCard || !birthDate || !phone) {
      return res.json({ 
        success: false, 
        message: 'กรุณากรอกข้อมูลให้ครบถ้วน' 
      });
    }

    if (!/^\d{13}$/.test(idCard)) {
      return res.json({ 
        success: false, 
        message: 'เลขบัตรประชาชนไม่ถูกต้อง' 
      });
    }

    if (!/^0[0-9]{9}$/.test(phone)) {
      return res.json({ 
        success: false, 
        message: 'เบอร์โทรศัพท์ไม่ถูกต้อง' 
      });
    }

    if (!pdpaConsent) {
      return res.json({ 
        success: false, 
        message: 'กรุณายอมรับเงื่อนไข PDPA' 
      });
    }

    const registrationData = {
      firstName,
      lastName,
      idCard,
      birthDate,
      phone,
      pdpaConsent
    };

    await processIdCardInput(userId, registrationData.idCard, null);

    res.json({ 
      success: true, 
      message: '✅ ลงทะเบียนสำเร็จ!' 
    });

  } catch (err) {
    console.error('LIFF Registration error:', err);
    res.json({ 
      success: false, 
      message: 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง' 
    });
  }
});

// ========================================
// API สำหรับ Dashboard ผู้ใช้งาน
// ========================================

// API ดึงรายชื่อผู้ใช้ทั้งหมด
app.get('/api/registered-users', async (req, res) => {
  console.log('📋 API /api/registered-users called');
  try {
    const users = await queryDB2(
      `SELECT 
        line_user_id,
        id_card,
        full_name,
        hn,
        registered_at,
        updated_at
      FROM line_registered_users
      ORDER BY registered_at DESC`
    );

    console.log(`✅ Found ${users.length} registered users`);
    
    res.json({ 
      success: true, 
      count: users.length,
      users: users
    });
  } catch (error) {
    console.error('❌ API registered-users error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: error.message
    });
  }
});

// API ส่งข้อความ Push Message
app.post('/api/send-push-message', async (req, res) => {
  console.log('📤 API /api/send-push-message called');
  try {
    const { lineUserId, message } = req.body;

    if (!lineUserId || !message) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required parameters' 
      });
    }

    const { pushMessage } = require('./handlers/messageHandler');
    
    await pushMessage(lineUserId, [
      {
        type: 'text',
        text: message
      }
    ]);

    console.log(`✅ Message sent to ${lineUserId}`);
    
    res.json({ 
      success: true, 
      message: 'Message sent successfully' 
    });
  } catch (error) {
    console.error('❌ API send-push-message error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to send message',
      error: error.message
    });
  }
});

// API ค้นหาผู้ใช้
app.get('/api/search-users', async (req, res) => {
  console.log('🔍 API /api/search-users called');
  try {
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing search query' 
      });
    }

    const users = await queryDB2(
      `SELECT 
        line_user_id,
        id_card,
        full_name,
        hn,
        registered_at
      FROM line_registered_users
      WHERE full_name LIKE ? 
         OR hn LIKE ? 
         OR id_card LIKE ?
      ORDER BY registered_at DESC
      LIMIT 50`,
      [`%${query}%`, `%${query}%`, `%${query}%`]
    );

    res.json({ 
      success: true, 
      count: users.length,
      users: users
    });
  } catch (error) {
    console.error('❌ API search-users error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: error.message
    });
  }
});

// API ดูประวัติการส่งข้อความ (ถ้าต้องการเก็บ log)
app.get('/api/message-history/:lineUserId', async (req, res) => {
  console.log('📜 API /api/message-history called');
  try {
    const { lineUserId } = req.params;

    // ตรวจสอบว่าผู้ใช้มีอยู่จริง
    const users = await queryDB2(
      'SELECT * FROM line_registered_users WHERE line_user_id = ?',
      [lineUserId]
    );

    if (users.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    // ถ้ามี table message_logs
    // const messages = await queryDB2(
    //   `SELECT * FROM message_logs 
    //    WHERE line_user_id = ? 
    //    ORDER BY created_at DESC 
    //    LIMIT 50`,
    //   [lineUserId]
    // );

    res.json({ 
      success: true,
      user: users[0],
      // messages: messages
      messages: [] // ถ้ายังไม่มี table
    });
  } catch (error) {
    console.error('❌ API message-history error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      error: error.message
    });
  }
});

// ========================================
// OTHER ROUTES
// ========================================
app.use('/queue', queueRouter);

const verifyRouter = require('./routes/verify');
app.use('/api', verifyRouter);

// ========================================
// WEBHOOK - ✅ แก้ไขส่วนนี้
// ========================================
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events;
    
    for (const event of events) {
      if (event.type === 'follow') {
        const { linkRichMenuToUser } = require('./richmenu/linkRichMenu');
        const RICH_MENU_ID = process.env.RICH_MENU_ID || 'richmenu-xxx';
        await linkRichMenuToUser(event.source.userId, RICH_MENU_ID);

        const quickReplyItems = [
          { type: 'action', action: { type: 'message', label: 'ลงทะเบียน', text: 'ลงทะเบียน' } },
          { type: 'action', action: { type: 'message', label: 'สถานะของฉัน', text: 'สถานะของฉัน' } },
          { type: 'action', action: { type: 'message', label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' } }
        ];
        
        await replyMessage(event.replyToken, [
          { type: 'text', text: '🎉 ยินดีต้อนรับสู่ระบบตรวจสอบสิทธิ์การรักษา\nกรุณาเลือกเมนูด้านล่าง' }
        ], quickReplyItems);
      }

      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        const msg = event.message.text.trim();

        const quickReplyItems = [
          { type: 'action', action: { type: 'message', label: 'ลงทะเบียน', text: 'ลงทะเบียน' } },
          { type: 'action', action: { type: 'message', label: 'สถานะของฉัน', text: 'สถานะของฉัน' } },
          { type: 'action', action: { type: 'message', label: 'ตรวจสิทธิ์ล่วงหน้า', text: 'ตรวจสิทธิ์ล่วงหน้า' } },
          { type: 'action', action: { type: 'message', label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' } }
        ];

        // ✅ แก้ไข: เพิ่มคำสั่งสำหรับตรวจสอบคิว
        if (msg === 'ลงทะเบียน' || msg.toLowerCase() === 'register') {
          await startRegistration(userId, event.replyToken);
        } 
        // ✅ ใหม่: ตรวจสอบคิวยา (เปลี่ยนจาก Push เป็น Reply)
        else if (msg === 'สถานะของฉัน' || msg === 'สถานะของฉัน' || msg === 'check_status') {
          await handleCheckAllStatus(userId, event.replyToken);  // ✅ เปลี่ยนเป็นบรรทัดนี้
        }
        // ✅ ใหม่: ตรวจสอบคิวชำระเงิน
        // else if (msg === 'ชำระเงิน' || msg === 'ตรวจสอบสถานะชำระเงิน' || msg === 'คิวชำระเงิน' || msg.toLowerCase() === 'payment') {
        //   await handleCheckPaymentQueue(userId, event.replyToken);
        // }
        // ✅ เก็บไว้: ตรวจสิทธิ์ล่วงหน้า (ใช้ QR Code)
        else if (msg === 'ตรวจสิทธิ์ล่วงหน้า' || msg.toLowerCase() === 'preverify') {
          const { sendVerifyQR } = require('./handlers/verifyLineHandler');

          // ดึงข้อมูลผู้ใช้จาก DB
          const rows = await queryDB2('SELECT * FROM line_registered_users WHERE line_user_id = ?', [userId]);
          if (rows.length === 0) {
            await replyMessage(event.replyToken, [
              { type: 'text', text: '❌ คุณยังไม่ได้ลงทะเบียน กรุณาลงทะเบียนก่อนใช้ฟังก์ชันนี้' }
            ], quickReplyItems);
            return;
          }

          const patient = rows[0];
          await sendVerifyQR(userId, event.replyToken, patient);
        }
        else if (msg === 'ติดต่อเจ้าหน้าที่' || msg.toLowerCase() === 'contact') {
          await replyMessage(event.replyToken, [
            { 
              type: 'text', 
              text: '☎️ ติดต่อสอบถามข้อมูล\n\n📞 โทร: 02-xxx-xxxx\n📧 Email: info@hospital.go.th\n⏰ เวลาทำการ: 08:00-16:30 น.' 
            }
          ], quickReplyItems);
        } 
        else if (msg === 'รับ token' || msg.toLowerCase() === 'get_token') {
          const rows = await queryDB2(
            'SELECT * FROM line_registered_users WHERE line_user_id = ?',
            [userId]
          );

          if (rows.length === 0) {
            await replyMessage(event.replyToken, [
              { type: 'text', text: '❌ คุณยังไม่ได้ลงทะเบียน\nกรุณาลงทะเบียนก่อน' }
            ], quickReplyItems);
            return;
          }

          const userInfo = rows[0];
          const { createToken } = require('./jwtHelper');
          const jwtToken = createToken({
            lineUserId: userId,
            id_card: userInfo.id_card,
            full_name: userInfo.full_name,
            hn: userInfo.hn
          }, '24h');

          await replyMessage(event.replyToken, [
            { type: 'text', text: `🛡️ Token สำหรับยืนยันตัวตน:\n\n${jwtToken}\n\n⏰ Token นี้มีอายุ 24 ชั่วโมง` }
          ], quickReplyItems);
        } 
        else {
          await replyMessage(event.replyToken, [
            { 
              type: 'text', 
              text: '❓ กรุณาเลือกเมนูด้านล่าง หรือพิมพ์:\n\n• "ลงทะเบียน" - ลงทะเบียนใหม่\n• "สถานะของฉัน" - ติดตามสถานะ\n• "ตรวจสิทธิ์ล่วงหน้า" - preverify\n• "ติดต่อเจ้าหน้าที่" - ขอความช่วยเหลือ' 
            }
          ], quickReplyItems);
        }
      } 
      else if (event.type === 'postback') {
        await handlePostback(event);
      }
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
});

// ========================================
// START SERVER
// ========================================

const { startMonitoring } = require('./handlers/queueHandler');
startMonitoring(); // 🔄 เริ่มตรวจคิวทุก 10 วิ ตาม POLL_INTERVAL

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE OA Webhook running on http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`🔗 API Endpoints:`);
  console.log(`   - GET  /api/pharmacy-queue/status`);
  console.log(`   - GET  /api/pharmacy-queue/stats`);
  console.log(`   - POST /api/call-pharmacy-queue`);
  console.log(`   - POST /api/check-rights`);
  console.log(`📂 Dashboard path: ${path.join(__dirname, 'frontend', 'dashboard.html')}`);
});