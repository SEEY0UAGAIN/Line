const redisClient = require('../redisClient');
const { sendLineMessage } = require('../utils/lineNotify');
const { v4: uuidv4 } = require('uuid');
const { logEvent } = require('../utils/auditLog'); // import logEvent

// ลงทะเบียนคิว
async function registerQueue(req, res) {
    const { vn, patient_name, queue_type, line_user_id } = req.body;
    if (!vn || !queue_type || !line_user_id) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const queueKey = `queue:${vn}:${queue_type}`;
    // สร้างหมายเลขคิวสำหรับประเภทนี้
    const queueNoKey = `queue_no:${queue_type}`;
    const queueData = {
        queue_no: await redisClient.incr(queueNoKey),
        queue_type,
        patient_name,
        line_user_id,
        status: 'waiting',
        created_at: Date.now()
    };

    await redisClient.set(queueKey, JSON.stringify(queueData), { EX: 24*3600 });

    // Audit log
    logEvent('queue.register', { vn, queue_type, queue_no: queueData.queue_no, line_user_id });

    // ส่งข้อความ LINE
    await sendLineMessage(line_user_id, `คุณอยู่คิวที่ ${queueData.queue_no} สำหรับ ${queue_type}`);

    res.json({ success: true, queue: queueData });
}


// ตรวจสอบสถานะคิว
async function getQueueStatus(req, res) {
    const { visit_id } = req.query;
    if (!visit_id) return res.status(400).json({ error: 'Missing visit_id' });

    const queueKey = `queue:${visit_id}`;
    const data = await redisClient.get(queueKey);
    if (!data) {
        await logEvent('queue.status.failed', { visit_id });
        return res.status(404).json({ error: 'Queue not found' });
    }

    const queue = JSON.parse(data);

    // Audit log
    await logEvent('queue.status', { visit_id, queue_no: queue.queue_no, id_card: queue.id_card });

    res.json({ success: true, queue });
}

module.exports = { registerQueue, getQueueStatus };
