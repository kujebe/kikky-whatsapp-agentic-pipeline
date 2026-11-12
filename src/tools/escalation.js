const { randomUUID } = require('node:crypto');
const { z } = require('zod');

const escalationSchema = z.object({
  reason: z.string().trim().min(1),
  customer_summary: z.string().trim().optional()
});

function createEscalationTool(db) {
  const insertHandoff = db.prepare(`
    INSERT INTO handoffs (id, reason, customer_summary)
    VALUES (@id, @reason, @customer_summary)
  `);

  return function escalate_to_human(input) {
    const parsed = escalationSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Invalid arguments: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'input'} ${issue.message}`).join('; ')}`
      };
    }

    const id = randomUUID();
    try {
      insertHandoff.run({
        id,
        reason: parsed.data.reason,
        customer_summary: parsed.data.customer_summary ?? null
      });
      return {
        ok: true,
        handoff_id: id,
        message: 'Chat successfully flagged for human staff review.'
      };
    } catch {
      return { ok: false, error: 'Error: could not create human handoff' };
    }
  };
}

module.exports = { createEscalationTool };