const { z } = require('zod');

const dlqRetrySchema = z.object({
  bullJobId: z.string().min(1, 'Falta el parámetro bullJobId').max(200, 'bullJobId demasiado largo')
});

module.exports = { dlqRetrySchema };