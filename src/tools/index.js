const { createRequestId, logEvent } = require('../logger');
const { createCatalogTools } = require('./catalog');
const { createShippingTool } = require('./shipping');
const { createEscalationTool } = require('./escalation');
const { checkStoreHours } = require('./store_hours');
const { recordWaitlistRequest } = require('./waitlist');
const { releaseExpiredHolds, create_order_reservation, verify_transfer_receipt } = require('./orders');

function createTools(db, { emit = logEvent, sessionId } = {}) {
  const handlers = {
    ...createCatalogTools(db),
    calculate_shipping: createShippingTool(db),
    escalate_to_human: createEscalationTool(db),
    check_store_hours: (input) => checkStoreHours(db, input),
    record_waitlist_request: (input) => recordWaitlistRequest(db, input),
    create_order_reservation: (input) => create_order_reservation(input, { db, sessionId }),
    verify_transfer_receipt: (input) => verify_transfer_receipt(input, { db, sessionId })
  };

  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, (input) => {
    const requestId = createRequestId();
    const startedAt = performance.now();
    emit('tool.call.started', {
      request_id: requestId,
      component: 'tools',
      stage: 'dispatch',
      tool: name,
      field_count: input && typeof input === 'object' ? Object.keys(input).length : 0
    });

    try {
      const result = handler(input);
      emit('tool.call.completed', {
        request_id: requestId,
        component: 'tools',
        stage: 'dispatch',
        tool: name,
        outcome: result?.ok === false ? 'error' : 'success',
        result_count: Number.isInteger(result?.count) ? result.count : undefined,
        duration_ms: performance.now() - startedAt,
        error_code: result?.ok === false ? 'tool_returned_error' : undefined
      });
      return result;
    } catch (error) {
      emit('tool.call.failed', {
        request_id: requestId,
        component: 'tools',
        stage: 'dispatch',
        tool: name,
        outcome: 'error',
        error_code: error?.name === 'SqliteError' ? 'database_error' : 'internal_error',
        duration_ms: performance.now() - startedAt
      });
      return { ok: false, error: 'Error: tool execution failed' };
    }
  }]))
}

module.exports = {
  createTools,
  createCatalogTools,
  createShippingTool,
  createEscalationTool,
  checkStoreHours,
  recordWaitlistRequest,
  releaseExpiredHolds,
  create_order_reservation,
  verify_transfer_receipt
};