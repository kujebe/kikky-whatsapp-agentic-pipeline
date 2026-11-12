# Kikky WhatsApp Agentic Pipeline

Standalone prototype for deterministic catalog and shipping tools. It has no WhatsApp connection or LLM integration.

## Temporary data warning

The five products and seven shipping-rate rows are fixtures. They cover state baselines for Ondo, Lagos, FCT, and Abuja, plus city-specific rates for Akure, Lagos, and Abuja. Prices, stock, descriptions, shipping fees, and delivery estimates are not verified store data. Replace them with approved business data before using any result with customers. `usage_summary` is informational only and is not medical advice.

Shipping lookup requires a state and optionally accepts a city. It prefers a city-specific rate and falls back to the state's baseline. Unknown states return an escalation message instead of a guessed fee. The tools are exported from `src/tools/index.js`: `search_catalog`, `get_product_details`, `calculate_shipping`, and `escalate_to_human`.

## Setup

Requires Node.js 20 or newer.

```sh
npm install
npm run init-db
npm test
npm run test-tools
```

The interactive harness accepts a tool number and JSON arguments, then prints the input, duration, and structured result. Press `q` to exit.

Examples:

```json
{"query":"massager","max_price":30000}
{"product_id":"rose-massager-01"}
{"state":"Ondo","city":"Akure"}
{"reason":"customer_request","customer_summary":"Customer requested a staff member."}
```

Select tools 1 through 4 in the harness; escalation creates a pending row in the local `handoffs` table.

Set `DB_PATH` to use another SQLite file. The database uses WAL mode; this prototype assumes a single application instance and persistent local storage.

## Timing for a later messaging adapter

An 8-second trailing quiet window with a 15-second maximum wait is a reasonable starting point for bursty chats. It reduces repeat work without holding a customer indefinitely. The tested debounce helper is independent of WhatsApp and LLM code.

For replies, send a supported typing indicator while processing. A short, variable pause before a very fast reply can make the exchange feel less abrupt, but typing delays do not prevent account restrictions or replace platform policy compliance. Baileys is unofficial; this project intentionally does not connect it yet.