const redisClient = require('../redisClient');
const { sendLineMessage } = require('../utils/lineNotify');
const { logEvent } = require('../utils/auditLog');
const { queryDB1, queryDB2 } = require('../db');
const sqlServer = require('mssql');

// ลงทะเบียนคิว
async function registerQueue(req, res) {
    try {
        const { vn, patient_name, queue_type, line_user_id } = req.body;
        
        if (!vn || !queue_type || !line_user_id) {
            return res.status(400).json({ 
                success: false,
                error: 'Missing required parameters: vn, queue_type, or line_user_id' 
            });
        }

        // ตรวจสอบว่ามีคิวอยู่แล้วหรือไม่
        const existingQueueKey = `queue:${vn}:${queue_type}`;
        const existingQueue = await redisClient.get(existingQueueKey);
        
        if (existingQueue) {
            const queue = JSON.parse(existingQueue);
            await logEvent('queue.duplicate', { 
                vn, 
                queue_type, 
                queue_no: queue.queue_no, 
                line_user_id 
            });
            
            return res.json({ 
                success: true, 
                queue,
                message: 'คุณมีคิวอยู่แล้ว'
            });
        }

        // ดึงข้อมูลผู้ป่วยจาก SSB ถ้าไม่ได้ส่งชื่อมา
        let patientName = patient_name;
        if (!patientName) {
            const patientQuery = `
                SELECT N.FirstName, N.LastName, N.InitialName
                FROM HNOPD_MASTER OM
                LEFT JOIN HNName N ON OM.HN = N.HN
                WHERE OM.VN = @vn
            `;
            const patientRows = await queryDB1(patientQuery, {
                vn: { type: sqlServer.VarChar, value: vn }
            });
            
            if (patientRows.length > 0) {
                const p = patientRows[0];
                patientName = `${p.InitialName || ''}${p.FirstName || ''} ${p.LastName || ''}`.trim();
            } else {
                patientName = 'ผู้ป่วย';
            }
        }

        // สร้างหมายเลขคิวสำหรับประเภทนี้
        const queueNoKey = `queue_no:${queue_type}:${new Date().toISOString().split('T')[0]}`;
        const queueNo = await redisClient.incr(queueNoKey);
        
        // ตั้งค่า expire ให้หมายเลขคิวรีเซ็ตทุกวัน (เที่ยงคืน)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        const ttl = Math.floor((tomorrow - new Date()) / 1000);
        await redisClient.expire(queueNoKey, ttl);

        const queueData = {
            queue_no: queueNo,
            vn,
            queue_type,
            patient_name: patientName,
            line_user_id,
            status: 'waiting',
            created_at: Date.now(),
            updated_at: Date.now()
        };

        // บันทึกข้อมูลคิว
        await redisClient.set(existingQueueKey, JSON.stringify(queueData), { 
            EX: 24 * 3600 
        });

        // เพิ่มเข้า List สำหรับการจัดการคิวแบบ FIFO
        const queueListKey = `queue_list:${queue_type}`;
        await redisClient.rPush(queueListKey, vn);

        // บันทึกลง MySQL เพื่อเก็บประวัติ
        await queryDB2(
            `INSERT INTO queue_history 
            (vn, queue_no, queue_type, patient_name, line_user_id, status, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [vn, queueNo, queue_type, patientName, line_user_id, 'waiting']
        );

        // Audit log
        await logEvent('queue.register', { 
            vn, 
            queue_type, 
            queue_no: queueNo, 
            line_user_id,
            patient_name: patientName
        });

        // นับจำนวนคิวที่รออยู่ข้างหน้า
        const waitingCount = await getWaitingCount(queue_type);

        // ส่งข้อความ LINE
        const lineMessage = `✅ ลงทะเบียนคิวสำเร็จ

📋 ประเภท: ${getQueueTypeLabel(queue_type)}
🎫 หมายเลขคิว: ${queueNo}
👤 ชื่อ: ${patientName}
⏱️ คิวที่รออยู่ข้างหน้า: ${waitingCount} คน

กรุณารอเรียกคิวของคุณ`;

        await sendLineMessage(line_user_id, lineMessage);

        res.json({ 
            success: true, 
            queue: queueData,
            waiting_count: waitingCount
        });

    } catch (err) {
        console.error('registerQueue error:', err);
        await logEvent('queue.register.error', { 
            error: err.message,
            body: req.body
        });
        res.status(500).json({ 
            success: false,
            error: 'Internal server error',
            message: 'เกิดข้อผิดพลาดในการลงทะเบียนคิว'
        });
    }
}

// ตรวจสอบสถานะคิว
async function getQueueStatus(req, res) {
    try {
        const { vn, queue_type, line_user_id } = req.query;
        
        if (!vn || !queue_type) {
            return res.status(400).json({ 
                success: false,
                error: 'Missing parameters: vn or queue_type' 
            });
        }

        const queueKey = `queue:${vn}:${queue_type}`;
        const data = await redisClient.get(queueKey);

        if (!data) {
            await logEvent('queue.status.notfound', { vn, queue_type, line_user_id });
            return res.status(404).json({ 
                success: false,
                error: 'Queue not found',
                message: 'ไม่พบข้อมูลคิวของคุณ'
            });
        }

        const queue = JSON.parse(data);

        // นับจำนวนคิวที่รออยู่ข้างหน้า
        const waitingCount = await getWaitingCountBefore(queue_type, vn);

        // Audit log
        await logEvent('queue.status', { 
            vn, 
            queue_type, 
            queue_no: queue.queue_no, 
            status: queue.status,
            line_user_id: queue.line_user_id 
        });

        res.json({ 
            success: true, 
            queue,
            waiting_count: waitingCount,
            estimated_wait_time: waitingCount * 5 // ประมาณ 5 นาทีต่อคน
        });

    } catch (err) {
        console.error('getQueueStatus error:', err);
        res.status(500).json({ 
            success: false,
            error: 'Internal server error' 
        });
    }
}

// อัปเดต status คิว
async function updateQueueStatus(req, res) {
    try {
        const { vn, queue_type, status, updated_by } = req.body;
        
        if (!vn || !queue_type || !status) {
            return res.status(400).json({ 
                success: false,
                error: 'Missing parameters: vn, queue_type or status' 
            });
        }

        const validStatuses = ['waiting', 'called', 'serving', 'done', 'cancelled', 'no_show'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ 
                success: false,
                error: 'Invalid status',
                message: 'สถานะไม่ถูกต้อง'
            });
        }

        const queueKey = `queue:${vn}:${queue_type}`;
        const data = await redisClient.get(queueKey);
        
        if (!data) {
            await logEvent('queue.update.notfound', { vn, queue_type, status });
            return res.status(404).json({ 
                success: false,
                error: 'Queue not found',
                message: 'ไม่พบข้อมูลคิว'
            });
        }

        const queue = JSON.parse(data);
        const oldStatus = queue.status;
        queue.status = status;
        queue.updated_at = Date.now();
        queue.updated_by = updated_by || 'system';

        await redisClient.set(queueKey, JSON.stringify(queue), { EX: 24 * 3600 });

        // อัปเดตใน MySQL
        await queryDB2(
            `UPDATE queue_history 
            SET status = ?, updated_at = NOW(), updated_by = ? 
            WHERE vn = ? AND queue_type = ? AND DATE(created_at) = CURDATE()`,
            [status, queue.updated_by, vn, queue_type]
        );

        // ลบออกจาก queue list ถ้าเสร็จสิ้นหรือยกเลิก
        if (status === 'done' || status === 'cancelled' || status === 'no_show') {
            const queueListKey = `queue_list:${queue_type}`;
            await redisClient.lRem(queueListKey, 1, vn);
        }

        // Audit log
        await logEvent('queue.update', { 
            vn, 
            queue_type, 
            queue_no: queue.queue_no, 
            old_status: oldStatus,
            new_status: status, 
            updated_by: queue.updated_by,
            line_user_id: queue.line_user_id 
        });

        // ส่ง LINE แจ้งผู้ป่วย
        const lineMessage = getStatusMessage(status, queue);
        await sendLineMessage(queue.line_user_id, lineMessage);

        res.json({ 
            success: true, 
            queue,
            message: 'อัปเดตสถานะสำเร็จ'
        });

    } catch (err) {
        console.error('updateQueueStatus error:', err);
        res.status(500).json({ 
            success: false,
            error: 'Internal server error' 
        });
    }
}

// เรียกคิวถัดไป
async function callNextQueue(req, res) {
    try {
        const { queue_type, counter_no, staff_name } = req.body;
        
        if (!queue_type) {
            return res.status(400).json({ 
                success: false,
                error: 'Missing queue_type parameter' 
            });
        }

        const queueListKey = `queue_list:${queue_type}`;
        const vn = await redisClient.lPop(queueListKey);

        if (!vn) {
            return res.json({ 
                success: false,
                message: 'ไม่มีคิวรอ',
                queue: null
            });
        }

        const queueKey = `queue:${vn}:${queue_type}`;
        const data = await redisClient.get(queueKey);

        if (!data) {
            return res.status(404).json({ 
                success: false,
                error: 'Queue data not found' 
            });
        }

        const queue = JSON.parse(data);
        queue.status = 'called';
        queue.counter_no = counter_no;
        queue.staff_name = staff_name;
        queue.called_at = Date.now();
        queue.updated_at = Date.now();

        await redisClient.set(queueKey, JSON.stringify(queue), { EX: 24 * 3600 });

        // อัปเดตใน MySQL
        await queryDB2(
            `UPDATE queue_history 
            SET status = 'called', counter_no = ?, staff_name = ?, called_at = NOW(), updated_at = NOW()
            WHERE vn = ? AND queue_type = ? AND DATE(created_at) = CURDATE()`,
            [counter_no, staff_name, vn, queue_type]
        );

        await logEvent('queue.call', { 
            vn, 
            queue_type, 
            queue_no: queue.queue_no,
            counter_no,
            staff_name
        });

        // ส่ง LINE เรียกคิว
        const lineMessage = `🔔 ถึงคิวของคุณแล้ว!

📋 ประเภท: ${getQueueTypeLabel(queue_type)}
🎫 หมายเลขคิว: ${queue.queue_no}
🏢 ช่องบริการ: ${counter_no || 'กรุณาดูหน้าจอ'}
👨‍⚕️ เจ้าหน้าที่: ${staff_name || '-'}

กรุณามาที่ช่องบริการด้วยค่ะ`;

        await sendLineMessage(queue.line_user_id, lineMessage);

        res.json({ 
            success: true, 
            queue,
            message: 'เรียกคิวสำเร็จ'
        });

    } catch (err) {
        console.error('callNextQueue error:', err);
        res.status(500).json({ 
            success: false,
            error: 'Internal server error' 
        });
    }
}

// ดูรายการคิวทั้งหมด
async function getAllQueues(req, res) {
    try {
        const { queue_type, status } = req.query;
        
        if (!queue_type) {
            return res.status(400).json({ 
                success: false,
                error: 'Missing queue_type parameter' 
            });
        }

        // ดึงข้อมูลจาก MySQL
        let query = `
            SELECT * FROM queue_history 
            WHERE queue_type = ? AND DATE(created_at) = CURDATE()
        `;
        const params = [queue_type];

        if (status) {
            query += ' AND status = ?';
            params.push(status);
        }

        query += ' ORDER BY queue_no ASC';

        const queues = await queryDB2(query, params);

        res.json({ 
            success: true, 
            queues,
            count: queues.length
        });

    } catch (err) {
        console.error('getAllQueues error:', err);
        res.status(500).json({ 
            success: false,
            error: 'Internal server error' 
        });
    }
}

// ยกเลิกคิว
async function cancelQueue(req, res) {
    try {
        const { vn, queue_type, line_user_id, reason } = req.body;
        
        if (!vn || !queue_type) {
            return res.status(400).json({ 
                success: false,
                error: 'Missing parameters' 
            });
        }

        const queueKey = `queue:${vn}:${queue_type}`;
        const data = await redisClient.get(queueKey);

        if (!data) {
            return res.status(404).json({ 
                success: false,
                error: 'Queue not found' 
            });
        }

        const queue = JSON.parse(data);
        queue.status = 'cancelled';
        queue.cancelled_reason = reason;
        queue.updated_at = Date.now();

        await redisClient.set(queueKey, JSON.stringify(queue), { EX: 24 * 3600 });

        // อัปเดตใน MySQL
        await queryDB2(
            `UPDATE queue_history 
            SET status = 'cancelled', cancelled_reason = ?, updated_at = NOW()
            WHERE vn = ? AND queue_type = ? AND DATE(created_at) = CURDATE()`,
            [reason, vn, queue_type]
        );

        // ลบออกจาก queue list
        const queueListKey = `queue_list:${queue_type}`;
        await redisClient.lRem(queueListKey, 1, vn);

        await logEvent('queue.cancel', { 
            vn, 
            queue_type, 
            queue_no: queue.queue_no,
            reason,
            line_user_id: queue.line_user_id
        });

        const lineMessage = `❌ ยกเลิกคิวแล้ว

📋 ประเภท: ${getQueueTypeLabel(queue_type)}
🎫 หมายเลขคิว: ${queue.queue_no}

${reason ? `เหตุผล: ${reason}` : ''}`;

        await sendLineMessage(queue.line_user_id, lineMessage);

        res.json({ 
            success: true, 
            queue,
            message: 'ยกเลิกคิวสำเร็จ'
        });

    } catch (err) {
        console.error('cancelQueue error:', err);
        res.status(500).json({ 
            success: false,
            error: 'Internal server error' 
        });
    }
}

// Helper Functions
async function getWaitingCount(queueType) {
    const queueListKey = `queue_list:${queueType}`;
    return await redisClient.lLen(queueListKey);
}

async function getWaitingCountBefore(queueType, vn) {
    const queueListKey = `queue_list:${queueType}`;
    const position = await redisClient.lPos(queueListKey, vn);
    return position !== null ? position : 0;
}

function getQueueTypeLabel(queueType) {
    const labels = {
        'pharmacy': 'ห้องยา',
        'lab': 'ห้องแล็บ',
        'xray': 'ห้องเอ็กซเรย์',
        'doctor': 'ห้องตรวจ',
        'cashier': 'ห้องการเงิน'
    };
    return labels[queueType] || queueType;
}

function getStatusMessage(status, queue) {
    const messages = {
        'waiting': `⏳ คิวของคุณกำลังรออยู่

📋 ประเภท: ${getQueueTypeLabel(queue.queue_type)}
🎫 หมายเลขคิว: ${queue.queue_no}

กรุณารอเรียกคิวของคุณ`,

        'called': `🔔 ถึงคิวของคุณแล้ว!

📋 ประเภท: ${getQueueTypeLabel(queue.queue_type)}
🎫 หมายเลขคิว: ${queue.queue_no}
${queue.counter_no ? `🏢 ช่องบริการ: ${queue.counter_no}` : ''}

กรุณามาที่ช่องบริการด้วยค่ะ`,

        'serving': `👨‍⚕️ กำลังให้บริการ

📋 ประเภท: ${getQueueTypeLabel(queue.queue_type)}
🎫 หมายเลขคิว: ${queue.queue_no}`,

        'done': `✅ เสร็จสิ้นการบริการ

📋 ประเภท: ${getQueueTypeLabel(queue.queue_type)}
🎫 หมายเลขคิว: ${queue.queue_no}

ขอบคุณที่ใช้บริการค่ะ`,

        'cancelled': `❌ ยกเลิกคิวแล้ว

📋 ประเภท: ${getQueueTypeLabel(queue.queue_type)}
🎫 หมายเลขคิว: ${queue.queue_no}`,

        'no_show': `⚠️ ไม่มาตามนัด

📋 ประเภท: ${getQueueTypeLabel(queue.queue_type)}
🎫 หมายเลขคิว: ${queue.queue_no}

หากต้องการใช้บริการกรุณาลงทะเบียนใหม่`
    };

    return messages[status] || `สถานะคิวของคุณถูกอัปเดตเป็น ${status}`;
}

module.exports = { 
    registerQueue, 
    getQueueStatus, 
    updateQueueStatus,
    callNextQueue,
    getAllQueues,
    cancelQueue
};