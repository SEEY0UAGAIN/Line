const express = require('express');
const router = express.Router();
const { registerQueue, getQueueStatus, updateQueueStatus } = require('./handlers/queueHandler');

// queue routes
router.post('/register', registerQueue);
router.get('/status', getQueueStatus);
router.put('/update-status', updateQueueStatus);

module.exports = router;
