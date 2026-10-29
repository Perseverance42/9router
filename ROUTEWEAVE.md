# RouteWeave combo strategy (experimental)

Select **RouteWeave** in the existing single or bulk combo strategy selector. This saves `settings.comboStrategies[comboName].fallbackStrategy = "routeweave"`. Ordinary outer combos may reach an inner RouteWeave combo; RouteWeave's own admitted candidates must be flat concrete routes.

## Service connection

Configure the server environment, never browser credentials:

```sh
ROUTEWEAVE_URL=http://127.0.0.1:9090
ROUTEWEAVE_SERVICE_TOKEN=<dedicated RouteWeave consumer token>
ROUTEWEAVE_MODE=active_required
ROUTEWEAVE_DECISION_TIMEOUT_MS=35000
ROUTEWEAVE_ALLOWLIST='{"openai/example":{"text":true,"context_tokens":32768,"max_output_tokens":4096,"tokens_per_byte":1,"template_tokens":1024}}'
```

The route and token bounds are illustrative, not certified. Each allowlist entry is an operator assertion for an exact gateway execution route: `tokens_per_byte` must bound its tokenizer over the UTF-8 serialized request, and `template_tokens` must cover translation/provider overhead. Unknown candidates are excluded; invalid entries and empty eligible pools fail before dispatch. Enable only after certifying these bounds and provider output-limit handling.

Connection configuration is read only after selecting a saved RouteWeave strategy. Missing/malformed configuration returns 503 for that request, not ordinary traffic or gateway startup. `ROUTEWEAVE_COMBOS` is obsolete and ignored. Global `comboStrategy` cannot activate RouteWeave. Mode defaults to `active_required`:

- **active_required:** unavailable, invalid or expired decisions fail closed before completion dispatch.
- **active_advisory:** a valid decision controls order; backend failure uses original admitted order.
- **shadow:** wait for a bounded decision, then dispatch admitted candidates in original configured order. No Smart classifier, rotation, stickiness or capability reorder.

All modes apply hard admission; capacity adapters cannot add candidates. Unsupported requests return 422 rather than unrestricted native fallback. Decision waits include fetch and body consumption, have no automatic retry, and use a configurable 100–60000 ms budget (default 35000). A monotonic check after parsing/validation rejects late decisions even if timeout notification is delayed. Client cancellation returns 499. Feedback has an independent 1-second timeout.

## Current ceiling

Only plain-text OpenAI chat / Claude Messages inputs ending in a nonempty user message are supported. Requests must explicitly supply positive `max_tokens`, reserved and passed unchanged to dispatch. `max_completion_tokens` alone is rejected; if supplied alongside `max_tokens`, it must match. No tools (even empty declarations), media, Responses inputs, continuity/cache-control extensions, unknown fields, multiple generations, thinking suffixes or nested candidate combos. Maximum 32 candidates, 256 messages/128 user messages and 256 KiB request/decision bodies.

Only canonical resolved `openai`/`anthropic` providers using their inspected registry `DefaultExecutor` and upstream chat/Claude formats are accepted. Codex, custom providers/executors and Responses upstreams are excluded; aliases and registry model-format overrides cannot bypass checks. Claude pools reject developer messages because that translator drops their role.

Effective global request transforms must be disabled; the existing `x-9router-token-saver: off` header can disable its supported saver modules, not custom prompts/PXPIPE. Thinking overrides are rejected only for admitted candidate providers; automatic thinking and unrelated provider settings are inert. Settings are checked again at dispatch. Naming/warmup bypass is disabled for RouteWeave attempts. Existing key access remains enforced. This standalone baseline has no per-key token-saver preferences or OpenRouter routing/ZDR integration.

Every new account/executor/fetch attempt checks cancellation and decision expiry. Retry waits are abortable; an already-started valid response may finish after decision expiry. Existing credential/DB work is not abortable and is checked afterward. Manual DNS-bypass transport is rejected for every RouteWeave attempt, including shadow/advisory without a decision. Decision and outcome service calls require verified TLS, reject redirects, never retry with insecure certificates, and reject manual DNS bypass. Use HTTPS outside a trusted local/private transport.

The standalone baseline retains its existing `/v1/systemone` 15-second endpoint budget and cancellation propagation; no integration-only OAuth/Fusion changes are imported.

## Outcomes

A bounded raw reader records genuine upstream terminal evidence before translation. Success requires usable delivered text, clean EOF and valid upstream completion, not a synthetic translator marker or HTTP 200. JSON and buffered non-streaming SSE reject bodies above 256 KiB. Empty/error/unfinished pre-content results can fail over within the admitted pool. Explicit safety refusals/content filters do not trigger another model and report failure. Late failures after text commitment report failure without replaying another model. Attempts summarize model-route dispatches, not individual accounts.

Outcome delivery is best-effort: at most 32 pending deliveries, a 1-second timeout, no durable queue or retry. Delivery failures do not fail completion. Feedback excludes account IDs, credentials, transcripts and raw provider errors. Service requests carry only the dedicated consumer credential plus normalized decision inputs; no client authorization, provider credentials or session identity.

## Rollback and verification

No schema migration or RouteWeave-specific gateway tables are added. Before reverting to a build without the strategy, switch affected combos back to supported strategies, preserving the complete strategy map and unrelated fields. Do not restore an old gateway database: doing so loses newer credentials and other writes. This baseline's combo repository does not migrate strategy keys on rename/delete; reselect the strategy after renaming and remove obsolete strategy keys explicitly. RouteWeave's own database is separate.

Run the explicit Node suites; `.mjs` checks are not matched by the gateway Vitest `**/*.test.js` pattern:

```sh
node --test tests/unit/routeweave.test.mjs tests/unit/routeweave-boundaries.test.mjs tests/unit/routeweave-dispatch.test.mjs tests/unit/routeweave-strategy-settings.test.mjs
```

The service contract test starts the real Bun RouteWeave application from `ROUTEWEAVE_TEST_SOURCE` (default `/home/coding-agent/git/routeweave`) with synthetic inference. It reads that checkout without editing it, requires its existing dependencies and Bun (`ROUTEWEAVE_TEST_BUN` override), validates real decision/outcome schemas, and creates/removes disposable app storage under `/tmp/opencode`. These tests do not establish live provider compatibility or authorize deployment.
