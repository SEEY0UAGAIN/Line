const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { 
  startRegistration, 
  replyMessage, 
  checkRegistrationStatus,
  processIdCardInput
} = require('./handlers/messageHandler');
const redisClient = require('./redisClient');
const { handlePostback } = require('./handlers/postbackHandler');
const queueRouter = require('./routes');
const { queryDB2 } = require('./db');
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
// OTHER ROUTES
// ========================================
app.use('/queue', queueRouter);

// ========================================
// WEBHOOK
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
          { type: 'action', action: { type: 'message', label: 'ตรวจสอบสิทธิ์', text: 'ตรวจสอบสิทธิ์' } },
          { type: 'action', action: { type: 'message', label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' } }
        ];
        
        await replyMessage(event.replyToken, [
          { type: 'text', text: '🎉 ยินดีต้อนรับสู่ระบบตรวจสอบสิทธิ์การรักษา\nกรุณาเลือกเมนูด้านล่าง' }
        ], quickReplyItems);
      }

      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        const msg = event.message.text.trim().toLowerCase();

        const quickReplyItems = [
          { type: 'action', action: { type: 'message', label: 'ลงทะเบียน', text: 'ลงทะเบียน' } },
          { type: 'action', action: { type: 'message', label: 'ตรวจสอบสิทธิ์', text: 'ตรวจสอบสิทธิ์' } },
          { type: 'action', action: { type: 'message', label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' } },
          { type: 'action', action: { type: 'message', label: 'รับ Token', text: 'รับ token' } }
        ];

        if (msg === 'ลงทะเบียน' || msg === 'register') {
          await startRegistration(userId, event.replyToken);
        } 
        else if (msg === 'ตรวจสอบสิทธิ์' || msg === 'ตรวจสอบสถานะ' || msg === 'check_status') {
          await checkRegistrationStatus(userId, event.replyToken);
        } 
        else if (msg === 'ติดต่อเจ้าหน้าที่' || msg === 'contact') {
          await replyMessage(event.replyToken, [
            { 
              type: 'text', 
              text: '☎️ ติดต่อสอบถามข้อมูล\n\n📞 โทร: 02-xxx-xxxx\n📧 Email: info@hospital.go.th\n⏰ เวลาทำการ: 08:00-16:30 น.' 
            }
          ], quickReplyItems);
        } 
        else if (msg === 'รับ token' || msg === 'get_token') {
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
            { type: 'text', text: 'กรุณาเลือกเมนูด้านล่าง หรือพิมพ์:\n• "ลงทะเบียน" - สำหรับลงทะเบียนใหม่\n• "ตรวจสอบสิทธิ์" - ดูข้อมูลสิทธิ์การรักษา\n• "ติดต่อเจ้าหน้าที่" - สอบถามข้อมูล' }
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
startMonitoring(); // 🔁 เริ่มตรวจคิวทุก 10 วิ ตาม POLL_INTERVAL


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
  console.log(`📁 Dashboard path: ${path.join(__dirname, 'frontend', 'dashboard.html')}`);
});