const { createCatalogTools } = require('./catalog');
const { createShippingTool } = require('./shipping');
const { createEscalationTool } = require('./escalation');

function createTools(db) {
  return {
    ...createCatalogTools(db),
    calculate_shipping: createShippingTool(db),
    escalate_to_human: createEscalationTool(db)
  };
}

module.exports = {
  createTools,
  createCatalogTools,
  createShippingTool,
  createEscalationTool
};