const { z } = require('zod');

const retryFailedSchema = z.object({
  jobId: z.string().min(1, 'Falta el parámetro jobId').max(100, 'jobId demasiado largo')
});

module.exports = { retryFailedSchema };
