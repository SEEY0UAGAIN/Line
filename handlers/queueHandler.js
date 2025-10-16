const redisClient = require('../redisClient');
const { sendLineMessage } = require('../utils/lineNotify');
const { v4: uuidv4 } = require('uuid');
const { logEvent } = require('../auditLog'); // import logEvent

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
    try {
        const { vn, queue_type } = req.query;
        if (!vn || !queue_type) {
            return res.status(400).json({ error: 'Missing parameters: vn or queue_type' });
        }

        const queueKey = `queue:${vn}:${queue_type}`;
        const data = await redisClient.get(queueKey);

        if (!data) {
            await logEvent('queue.status.failed', { vn, queue_type });
            return res.status(404).json({ error: 'Queue not found' });
        }

        const queue = JSON.parse(data);

        // Audit log
        await logEvent('queue.status', { vn, queue_type, queue_no: queue.queue_no, line_user_id: queue.line_user_id });

        res.json({ success: true, queue });
    } catch (err) {
        console.error('getQueueStatus error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

// อัปเดต status คิว
async function updateQueueStatus(req, res) {
    try {
        const { vn, queue_type, status } = req.body;
        if (!vn || !queue_type || !status) {
            return res.status(400).json({ error: 'Missing parameters: vn, queue_type or status' });
        }

        const queueKey = `queue:${vn}:${queue_type}`;
        const data = await redisClient.get(queueKey);
        if (!data) {
            await logEvent('queue.update.failed', { vn, queue_type, status });
            return res.status(404).json({ error: 'Queue not found' });
        }

        const queue = JSON.parse(data);
        queue.status = status;

        await redisClient.set(queueKey, JSON.stringify(queue), { EX: 24*3600 });

        // Audit log
        await logEvent('queue.update', { vn, queue_type, queue_no: queue.queue_no, status, line_user_id: queue.line_user_id });

        // ส่ง LINE แจ้งผู้ป่วย
        let msg = '';
        if (status === 'called') msg = `🔔 ถึงคิวของคุณแล้ว สำหรับ ${queue_type}`;
        else if (status === 'done') msg = `✅ เสร็จสิ้นคิว ${queue_type}`;
        else msg = `สถานะคิวของคุณถูกอัปเดตเป็น ${status}`;

        await sendLineMessage(queue.line_user_id, msg);

        res.json({ success: true, queue });

    } catch (err) {
        console.error('updateQueueStatus error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}

module.exports = { registerQueue, getQueueStatus, updateQueueStatus };
