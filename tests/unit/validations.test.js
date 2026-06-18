import { describe, it, expect } from 'vitest';
import { dlqRetrySchema } from '../../src/validations/dlq';

describe('dlqRetrySchema validation', () => {
  it('debería validar un payload con bullJobId', () => {
    const result = dlqRetrySchema.safeParse({ bullJobId: 'job.approved-123' });
    expect(result.success).toBe(true);
  });

  it('debería rechazar payload sin bullJobId', () => {
    const result = dlqRetrySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('debería rechazar payload con bullJobId vacío', () => {
    const result = dlqRetrySchema.safeParse({ bullJobId: '' });
    expect(result.success).toBe(false);
  });
});
