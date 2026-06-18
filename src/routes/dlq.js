const express = require('express');
const asyncHandler = require('../utils/async-handler');
const { verifyApiToken } = require('../middleware/api-auth');
const { jobQueue } = require('../jobs/bull-queue');
const { dlqRetrySchema } = require('../validations/dlq');
const config = require('../config');

const router = express.Router();

router.use(verifyApiToken);

let dlqCache = { data: null, timestamp: 0 };

router.get('/dlq', asyncHandler(async (req, res) => {
  const now = Date.now();
  if (dlqCache.data && (now - dlqCache.timestamp) < config.SECONDARY_CACHE_TTL_MS) {
    return res.json(dlqCache.data);
  }

  const failedJobs = await jobQueue.getFailedJobs();
  const data = { success: true, count: failedJobs.length, jobs: failedJobs };
  dlqCache = { data, timestamp: now };
  res.json(data);
}));

router.post('/dlq/retry', asyncHandler(async (req, res) => {
  const parsed = dlqRetrySchema.safeParse(req.body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i => i.message).join(', ');
    return res.status(400).json({ error: errors });
  }

  const { bullJobId } = parsed.data;
  await jobQueue.retryFailedJob(bullJobId);
  dlqCache = { data: null, timestamp: 0 };
  res.json({ success: true, message: `Trabajo ${bullJobId} encolado para reintento` });
}));

router.post('/dlq/clear', asyncHandler(async (req, res) => {
  await jobQueue.clearFailedJobs();
  dlqCache = { data: null, timestamp: 0 };
  res.json({ success: true, message: 'Se ha vaciado la cola de trabajos fallidos' });
}));

module.exports = router;