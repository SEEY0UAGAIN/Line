// index.js - Enhanced API Endpoint

const express = require('express');
const bodyParser = require('body-parser');
const { 
  startRegistration, 
  replyMessage, 
  checkRegistrationStatus,
  processIdCardInput
} = require('./handlers/messageHandler');
const redisClient = require('./redisClient');
const { handlePostback } = require('./handlers/postbackHandler');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

app.get('/webhook', (req, res) => res.send('LINE OA Webhook running'));

// Static files สำหรับ LIFF
app.use('/frontend', express.static(__dirname + '/frontend'));

// Webhook หลัก
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events;
    
    for (const event of events) {
      // Event follow: เมื่อผู้ใช้เพิ่ม OA
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

      // Event message: ข้อความจากผู้ใช้
      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        const msg = event.message.text.trim().toLowerCase();

        const quickReplyItems = [
          { type: 'action', action: { type: 'message', label: 'ลงทะเบียน', text: 'ลงทะเบียน' } },
          { type: 'action', action: { type: 'message', label: 'ตรวจสอบสิทธิ์', text: 'ตรวจสอบสิทธิ์' } },
          { type: 'action', action: { type: 'message', label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' } },
          { type: 'action', action: { type: 'message', label: 'รับ Token', text: 'รับ token' } }
        ];

        // เมนู: ลงทะเบียน
        if (msg === 'ลงทะเบียน' || msg === 'register') {
          await startRegistration(userId, event.replyToken);
        } 
        // เมนู: ตรวจสอบสิทธิ์
        else if (msg === 'ตรวจสอบสิทธิ์' || msg === 'ตรวจสอบสถานะ' || msg === 'check_status') {
          await checkRegistrationStatus(userId, event.replyToken);
        } 
        // เมนู: ติดต่อเจ้าหน้าที่
        else if (msg === 'ติดต่อเจ้าหน้าที่' || msg === 'contact') {
          await replyMessage(event.replyToken, [
            { 
              type: 'text', 
              text: '☎️ ติดต่อสอบถามข้อมูล\n\n📞 โทร: 02-xxx-xxxx\n📧 Email: info@hospital.go.th\n⏰ เวลาทำการ: 08:00-16:30 น.' 
            }
          ], quickReplyItems);
        } 
        // เมนู: รับ Token
        else if (msg === 'รับ token' || msg === 'get_token') {
          const { queryDB2 } = require('./db');
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
        // ข้อความอื่น ๆ
        else {
          await replyMessage(event.replyToken, [
            { type: 'text', text: 'กรุณาเลือกเมนูด้านล่าง หรือพิมพ์:\n• "ลงทะเบียน" - สำหรับลงทะเบียนใหม่\n• "ตรวจสอบสิทธิ์" - ดูข้อมูลสิทธิ์การรักษา\n• "ติดต่อเจ้าหน้าที่" - สอบถามข้อมูล' }
          ], quickReplyItems);
        }
      } 
      // Event postback
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

// API สำหรับ LIFF Registration
app.post('/liff-register', async (req, res) => {
  try {
    const { userId, firstName, lastName, idCard, birthDate, phone, pdpaConsent } = req.body;

    // Validate input
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

    // ประมวลผลการลงทะเบียน
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

    // ตรวจสอบ JWT Token
    const { verifyToken } = require('./jwtHelper');
    const decoded = verifyToken(token);
    
    if (!decoded || decoded.id_card !== idCard) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid token or ID card mismatch' 
      });
    }

    // ตรวจสอบสิทธิ์จาก SSB
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString() 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LINE OA Webhook running on http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
});