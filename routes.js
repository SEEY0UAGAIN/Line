const express = require('express');
const router = express.Router();
const { registerQueue, getQueueStatus } = require('./handlers/queueHandler');

router.post('/queue/register', registerQueue);
router.get('/queue/status', getQueueStatus);

module.exports = router;
