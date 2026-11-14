const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_catalog',
      description: 'Search the adult wellness product catalog by keyword, product type, category, or customer description. Returns matching items with retail_price and stock_quantity. MANDATORY: You must call this tool whenever a customer asks about product availability, options, or prices before quoting any price. Never guess or state a price without calling this tool.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search phrase, product category, or colloquial term used by the customer.'
          },
          max_price: {
            type: 'integer',
            description: 'Optional maximum price ceiling in Nigerian Naira (NGN).'
          }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_product_details',
      description: 'Retrieve detailed technical usage instructions and specifications for a specific product ID. ONLY call this tool when the customer explicitly asks how to use an item, what materials it is made of, or for detailed technical specs. Do NOT call this tool when a customer simply says yes or confirms an order.',
      parameters: {
        type: 'object',
        properties: {
          product_id: {
            type: 'string',
            description: 'The unique product identifier code in the catalog.'
          }
        },
        required: ['product_id'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculate_shipping',
      description: 'Calculate shipping cost and estimated delivery timeframe for a given Nigerian destination state and optional city. MANDATORY: Whenever a customer mentions ANY location (city or state), you MUST call this tool. NEVER guess, assume, or hallucinate a destination state or shipping fee.',
      parameters: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            description: 'Destination Nigerian state name or city explicitly stated by the customer.'
          },
          city: {
            type: 'string',
            description: 'Optional destination town or city within the state explicitly stated by the customer.'
          }
        },
        required: ['state'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_store_hours',
      description: 'Check official store opening hours, closing hours, and walk-in availability for Shop 32A Akure Mall for a given day of the week.',
      parameters: {
        type: 'object',
        properties: {
          day: {
            type: 'string',
            description: 'Day of the week name, or relative terms like today or tomorrow. If omitted, checks current day.'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'record_waitlist_request',
      description: 'Record a pre-order or restock notification request when an item is sold out or unavailable. Captures customer contact info and specifications.',
      parameters: {
        type: 'object',
        properties: {
          customer_contact: {
            type: 'string',
            description: 'Customer WhatsApp phone number or contact identifier.'
          },
          requested_item: {
            type: 'string',
            description: 'Name or description of the product requested.'
          },
          specifications: {
            type: 'string',
            description: 'Customer requirements such as dimension, color, motorized function, or price ceiling.'
          },
          deposit_offered: {
            type: 'integer',
            description: 'Optional deposit amount in NGN if customer offered a commitment deposit.'
          }
        },
        required: ['customer_contact', 'requested_item'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description: 'Flag the conversation and escalate to human staff for: 1) Unlisted delivery destinations where calculate_shipping returned { ok: false }, or 2) Repeated customer requests for ingestible prescription remedies or swallowed pills in the current turn. NEVER call this tool for: pricing questions, complaints, standard follow-up questions, the customer saying no, or normal shopping inquiries. IG always means Instagram.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Categorical reason code for staff escalation.'
          },
          customer_summary: {
            type: 'string',
            description: 'Brief context summary of the customer situation and query.'
          }
        },
        required: ['reason'],
        additionalProperties: false
      }
    }
  }
];

function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

module.exports = {
  TOOL_DEFINITIONS,
  getToolDefinitions
};
