/**
 * queueHandler.js
 * รวม monitor + express route handler
 */

const sqlServer = require('mssql');
const redisClient = require('../redisClient');
const { sendLineMessage } = require('../utils/lineNotify');
const { logEvent } = require('../auditLog');
const { queryDB1, queryDB2, queryDB3 } = require('../db');
require('dotenv').config();

const POLL_INTERVAL = process.env.POLL_INTERVAL ? parseInt(process.env.POLL_INTERVAL, 10) : 10000;
const QUEUE_TYPES = ['pharmacy', 'doctor', 'lab', 'xray', 'cashier'];

/* -----------------------------
   📦 Helper Functions
------------------------------ */
function getQueueTypeLabel(queueType) {
  const labels = {
    pharmacy: 'ห้องยา',
    lab: 'ห้องแล็บ',
    xray: 'ห้องเอ็กซเรย์',
    doctor: 'ห้องตรวจ',
    cashier: 'ห้องการเงิน',
  };
  return labels[queueType] || queueType;
}

function getStatusMessage(status, queue) {
  const messages = {
    waiting: `⏳ คิวของคุณกำลังรออยู่

📋 ประเภท: ${getQueueTypeLabel(queue.queue_type)}
🎫 หมายเลขคิว: ${queue.queue_no}`,
    called: `🔔 ถึงคิวของคุณแล้ว!

📋 ประเภท: ${getQueueTypeLabel(queue.queue_type)}
🎫 หมายเลขคิว: ${queue.queue_no}`,
    done: `✅ เสร็จสิ้นการบริการ

📋 ประเภท: ${getQueueTypeLabel(queue.queue_type)}
🎫 หมายเลขคิว: ${queue.queue_no}`,
  };
  return messages[status] || `สถานะคิวของคุณถูกอัปเดตเป็น ${status}`;
}

/* -----------------------------
   🚀 updateStatus (ใช้ร่วมกัน)
------------------------------ */
async function updateStatus(vn, queue_type, newStatus, options = {}) {
  try {
    const queueKey = `queue:${vn}:${queue_type}`;
    const raw = await redisClient.get(queueKey);
    let queue = raw ? JSON.parse(raw) : null;

    if (!queue) {
      const rows = await queryDB2(
        `SELECT queue_no, patient_name, line_user_id 
         FROM queue_history 
         WHERE vn=? AND queue_type=? AND DATE(created_at)=CURDATE() LIMIT 1`,
        [vn, queue_type]
      );
      queue = {
        vn,
        queue_type,
        queue_no: rows.length ? rows[0].queue_no : null,
        patient_name: rows.length ? rows[0].patient_name : null,
        line_user_id: rows.length ? rows[0].line_user_id : null,
        status: newStatus,
      };
    }

    const oldStatus = queue.status || null;
    if (oldStatus === newStatus) return { updated: false, reason: 'same_status' };

    queue.status = newStatus;
    queue.updated_at = Date.now();
    queue.updated_by = options.updated_by || 'system';

    await redisClient.set(queueKey, JSON.stringify(queue), { EX: 86400 });

    const exist = await queryDB2(
      `SELECT id FROM queue_history WHERE vn=? AND queue_type=? AND DATE(created_at)=CURDATE() LIMIT 1`,
      [vn, queue_type]
    );

    if (exist.length)
      await queryDB2(
        `UPDATE queue_history SET status=?, updated_at=NOW(), updated_by=? WHERE id=?`,
        [newStatus, queue.updated_by, exist[0].id]
      );
    else
      await queryDB2(
        `INSERT INTO queue_history 
         (vn, queue_no, queue_type, patient_name, line_user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [vn, queue.queue_no, queue_type, queue.patient_name, queue.line_user_id, newStatus]
      );

    await logEvent('queue.update', { vn, queue_type, oldStatus, newStatus });

    if (queue.line_user_id)
      await sendLineMessage(queue.line_user_id, getStatusMessage(newStatus, queue));

    return { updated: true, oldStatus, newStatus };
  } catch (err) {
    console.error('updateStatus error:', err);
    return { updated: false, error: err.message };
  }
}

/* -----------------------------
   🧩 Monitor Background
------------------------------ */
async function startMonitoring() {
  console.log(`🚀 Queue Monitor started (${POLL_INTERVAL}ms)`);
  while (true) {
    try {
      // ตรงนี้คุณสามารถเรียกฟังก์ชัน monitor เดิม เช่น processPharmacyQueue()
      // เพื่อ loop ตรวจสถานะได้
    } catch (err) {
      console.error('Monitor error:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
}

/* -----------------------------
   🌐 Express Handlers
------------------------------ */
async function registerQueue(req, res) {
  try {
    const { vn, queue_type, queue_no, line_user_id, patient_name } = req.body;
    if (!vn || !queue_type)
      return res.status(400).json({ success: false, message: 'missing vn or queue_type' });

    const queue = { vn, queue_type, queue_no, line_user_id, patient_name, status: 'waiting' };
    await redisClient.set(`queue:${vn}:${queue_type}`, JSON.stringify(queue), { EX: 86400 });
    await queryDB2(
      `INSERT INTO queue_history (vn, queue_no, queue_type, patient_name, line_user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'waiting', NOW(), NOW())`,
      [vn, queue_no, queue_type, patient_name, line_user_id]
    );

    await logEvent('queue.register', queue);
    res.json({ success: true, message: 'queue registered', queue });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

async function getQueueStatus(req, res) {
  try {
    const { vn, queue_type } = req.query;
    if (!vn || !queue_type)
      return res.status(400).json({ success: false, message: 'missing vn or queue_type' });

    const queueKey = `queue:${vn}:${queue_type}`;
    const raw = await redisClient.get(queueKey);
    if (!raw) return res.json({ success: false, message: 'not found' });

    const queue = JSON.parse(raw);
    res.json({ success: true, queue });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

async function updateQueueStatus(req, res) {
  try {
    const { vn, queue_type, status } = req.body;
    if (!vn || !queue_type || !status)
      return res.status(400).json({ success: false, message: 'missing params' });

    const result = await updateStatus(vn, queue_type, status, { updated_by: 'api' });
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}

/* -----------------------------
   📤 Exports
------------------------------ */
module.exports = {
  registerQueue,
  getQueueStatus,
  updateQueueStatus,
  startMonitoring,
};
