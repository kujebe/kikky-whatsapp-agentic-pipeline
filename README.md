# Kikky WhatsApp Agentic Pipeline

Standalone prototype for deterministic catalog/shipping tools and multimodal media ingestion. It has no WhatsApp connection or sales-agent LLM integration.

## Temporary data warning

The five products and seven shipping-rate rows are fixtures. They cover state baselines for Ondo, Lagos, FCT, and Abuja, plus city-specific rates for Akure, Lagos, and Abuja. Prices, stock, descriptions, shipping fees, and delivery estimates are not verified store data. Replace them with approved business data before using any result with customers. `usage_summary` is informational only and is not medical advice.

Shipping lookup requires a state and optionally accepts a city. It prefers a city-specific rate and falls back to the state's baseline. Unknown states return an escalation message instead of a guessed fee. The tools are exported from `src/tools/index.js`: `search_catalog`, `get_product_details`, `calculate_shipping`, and `escalate_to_human`.

### Catalog Search & Typo Resilience
`search_catalog` uses SQLite FTS5 with prefix matching (`*`) and plural stripping (`-s`, `-es`, `-ies`). Products include an internal `search_tags` column indexed by FTS5 to bridge the gap between sanitized catalog listings (e.g. "Personal Massager") and colloquial WhatsApp buyer search terms or common typos (e.g. "vibrator", "vibrater", "lube", "dildo"). `search_tags` is never exposed in API output. When adding new products, include relevant customer slang and common misspellings in `search_tags`.

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

## Stage 2: media ingestion

Audio transcription uses Groq Whisper through `src/media/transcriber.js`. Image classification calls the authenticated Modal endpoint through `src/media/vision.js`. Product screenshots use a first pass to locate the physical product, then a second pass on its crop so social UI and text overlays have less influence. Receipt extraction returns unverified candidate fields only; it must never be treated as proof of payment.

Copy `.env.example` to `.env` and add newly rotated credentials. Do not reuse credentials that were exposed in chat. `.env` is ignored by Git. Modal proxy token credentials are separate from Modal CLI workspace credentials; the endpoint requires `MODAL_VISION_TOKEN_ID` and `MODAL_VISION_TOKEN_SECRET`.

Run the local CLI with:

```sh
npm run test-multimodal -- audio ./path/to/voice.ogg
npm run test-multimodal -- image ./path/to/screenshot.jpg
npm run test-multimodal -- image ./path/to/screenshot.jpg --debug
```

The optional `--debug` flag asks the protected vision service to return a one-request summary of the model's first- and second-pass outputs to the local CLI. This output is not written to Modal logs. Product descriptions, boxes, and keywords may be visible in the local terminal; receipt values are redacted. Use it only with images you are allowed to inspect and keep the terminal private.

The first vision prompt asks for a fixed JSON shape. The server validates and normalizes model output into a stable API response before returning it. Since prompt instructions alone cannot guarantee the model's raw JSON shape, the parser also accepts observed variants such as nested `physical_intimate_product.bbox_2d` and capitalized `Product`/`Keywords`. A valid box can proceed when confidence is missing; a supplied low confidence still triggers the safe fallback.

Audio tests require `GROQ_API_KEY`; image tests require the deployed endpoint URL and Modal proxy-token pair. Automated tests use mocked responses and need no keys, network access, or GPU.

### Deploying the vision endpoint

The Modal service is an authenticated FastAPI ASGI app with an explicit `POST /classify` route. `fastapi_endpoint` would expose a generated endpoint route rather than guaranteeing this path, so the service uses `asgi_app`. Before serving or deploying, install the small local endpoint dependencies with `pip install -r modal/requirements-local.txt`; the GPU image separately installs its pinned model dependencies. The public URL generated by Modal is workspace-specific; set `MODAL_VISION_URL` to that URL plus `/classify`.

After rotating exposed credentials and confirming the correct Modal account, use Modal's CLI to develop with `modal serve modal/vision_server.py` and deploy with `modal deploy modal/vision_server.py`. This downloads the model into the built image and runs inference on an A10G. Model download and initialization add build/startup time, and cold starts can last seconds to minutes. The endpoint has a 180-second server limit; the client timeout defaults to 90 seconds and can be changed with `MODAL_VISION_TIMEOUT_MS`. Keep this call off any synchronous WhatsApp response path and provide a staff-safe fallback.

Current Groq documentation lists OGG as a supported transcription format and lists the Whisper model IDs, but free quotas can change and are not assumed here. Check your account's current limits and pricing before production use.

Image processing is transient by default. Receipt candidates can include financial personal data; avoid logging or storing raw receipts and extracted names. The interactive CLI redacts the sender name in its displayed receipt result. Payment status must come from a verified payment webhook or staff review.

### Privacy-safe diagnostics

Operational events are JSON lines with a shared request ID, component, stage, outcome, and duration. The Modal vision service records request acceptance, model-pass start/completion, crop creation, fallback reason, and final result type. Node records provider status and tool-call timing. Logs may include media byte counts, image dimensions, confidence, keyword counts, and HTTP status.

Logs must not include API keys, proxy tokens, raw images or audio, prompts, transcripts, receipt fields, tool argument values, extracted keywords, or raw provider/model responses. The local multimodal CLI intentionally displays test results to the operator; treat its terminal output as sensitive when testing with real customer media.

Run the Node privacy/logging tests with `npm test`. Run the Modal pass and log-redaction tests with:

```sh
.venv/bin/python test/vision_server_logging_test.py
```