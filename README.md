# GS Alerting — flexible alerting & notification service

Self-hosted service that gets the right alert to the right people on their preferred channel, and walks them through the team's runbook. Next.js app: the UI and the backend (API routes, delivery worker, log tailer) run in one process.

**Positioning:** data never leaves the bank, AI only proposes (a human decides), and alerts keep flowing when the AI is down.

## Quick start (2 commands)

```bash
bun install
bun run dev            # http://localhost:3000
```

Optional: `cp .env.example .env.local` and set `OPENROUTER_API_KEY` to turn on AI-assisted schema onboarding and runbook structuring. Everything else works without it.

On the **Live alerts** page, click the "Simulate sources" buttons to replay the events from the brief, or send your own:

```bash
curl -XPOST localhost:3000/api/ingest/webhook -H 'content-type: application/json' -d '{"anything":"any shape"}'
curl -XPOST localhost:3000/api/ingest/log -H 'content-type: text/plain' --data-binary '2026-10-23T09:14:02Z WARN pricing-engine-3 instrument=EURUSD latency_ms=1200 msg="stale"'
echo '2026-10-23T09:14:02Z WARN pricing-engine-2 instrument=USDJPY latency_ms=1400' >> data/logs/pricing.log
```

| Script | What it does |
| --- | --- |
| `bun run smoke` | 17 end-to-end checks against a running server (routing, dedup, channel outage, runbook, SMS approval, auto-close, templates, log grouping) |
| `bun run loadtest` | open-model load test; flags `--rate 500 --duration 20 --mode e2e\|noise`; writes `results/*.json` |
| `bun run eval:mapping` | precision/coverage of the deterministic schema mapper on 10 labelled schemas |

## How it works

```
 sources                     one Next.js process (N stateless copies → see Scaling)
 ─────────                   ─────────────────────────────────────────────────────────────
 POST /api/ingest/<source>   ┐
 Alertmanager webhook        ├─► schema detect ─► normalise ─► rules ─► dedup/group ─► outbox ─► channel adapters
 data/logs/*.log (tailed)    ┘   (cached per      (mapping      (AND/OR,   (fingerprint,    (retry,     phone · sms · email · ui (SSE)
 broker (simulated)               fingerprint)    table)        raw paths) window,throttle)  backoff,DLQ)
                                      │
                                      └─► new schema? ─► layer 1 rules ─► layer 2 AI (async, names only) ─► layer 3 human ✓
```

No model call sits on the event path: once a schema is known, every event is mapped from the stored table.

### Ingest (2.1)
- Source types: HTTP webhook (any JSON, arrays, Alertmanager envelopes), a tailed log file (`data/logs/*.log`, key=value or JSON lines), and plain-text log lines over HTTP. The broker source is simulated by the demo buttons; a Kafka consumer would call the same `ingest()` function.
- Unknown schemas are detected by their structure. Similar shapes (≥75% shared paths) are merged, so optional fields don't create new schemas.
- Canonical model (9 fields): `severity, service, environment, type, error.code, error.message, timestamp, entityId, status`. The raw payload is always kept, and rules can use either canonical names or raw paths (`payload.notional`).

### Schema mapping in three layers
1. **Rules** (`src/lib/engine/schema.ts`): camelCase/snake_case splitting, synonyms, value-format detection (ISO, epoch ms/s, currency, enum codes, ids, free text), known formats (Prometheus Alertmanager) and a common severity scale.
2. **AI** (only for the leftovers): it receives field paths, types and formats, **never values**. Path segments that look like data become `<id>`. Fields are referenced by opaque ids, and the output is strict JSON that is validated (field exists, type fits, key allowed).
3. **Human**: ✓/✗ in *Sources & schemas*. Approved mappings are saved to `config/schemas.yaml` and recorded in the audit log.

`bun run eval:mapping` on 10 labelled schemas (the 3 from the brief plus snake_case, epoch seconds, nested envelopes, abbreviations and a prompt-injection field name): **rules alone map 47 of 54 fields (87%), with 0 wrong mappings**. Six of the 7 leftovers are in the deliberately abbreviated "payment stuck" schema. In a live run, the rules proposed its timestamp and the AI proposed the other 5, all waiting for a human ✓.

### Rules (2.2)
`config/rules.yaml` is the single source of truth. The UI editor, `PUT /api/rules` and hand edits all write that file, and a file watcher reloads it live. Rules can use any field with `eq, neq, in, nin, gt, gte, lt, lte, contains, matches (glob), regex, exists, missing`. `all`/`any` groups can be nested. `gte` on severity compares by rank (`severity ≥ warning`). Each rule sets its routing (`notify`), presentation (`present.title/body/fields/color/severity`, `{{path | number}}` templates), grouping (`group.by/windowSec/throttleSec`) and runbook. The editor's "Test against recent events" shows what a rule would match before you save it. All four example rules from the brief are in the seed config.

### Channels (2.3)
- People and teams have per-severity channel preferences (`config/recipients.yaml`, editable in *People & channels*). Teams have an on-call person, and routes can add quiet hours (`hours: {from, to, tz, otherwise}`).
- Delivery uses an outbox: every notification is a delivery record with an idempotency key (`alert:seq:recipient:channel`). The worker retries with exponential backoff and jitter (capped at 10 s); after 12 attempts a delivery goes to the dead-letter queue, which you can requeue from *System*. Pending deliveries are snapshotted to disk and resumed after a restart.
- Adding a real provider means replacing one adapter in `src/lib/engine/channels.ts`.

### Anti-noise (2.5)
Fingerprint = rule + values of `group.by`. Duplicates within the window increase a counter; re-notification is throttled per alert. Example: **500 identical errors → 1 alert ×500**; a `--mode noise` load test turned **10,000 mixed events into 24 alerts**.

### Runbooks (2.6)
Drop a file into `config/runbooks/` (or paste one in the UI): `.yaml` steps, `.md` page or checklist, `.txt` free text or a `.url` wiki link. Every format becomes the same step list: `{text, action{kind, params}, approval, when}`.
- YAML is parsed directly. Markdown list items and free-text sentences go through a heuristic parser (restart, roll back, fail over, retry, escalate, post to channel, wait, open ticket). "Needs approval" and risky action kinds force `approval: required`.
- The optional **"Structure with AI"** button converts prose into steps; you accept or reject the result, and accepted steps are saved as YAML.
- Steps are filled in with event values (`{{workflowId}}`), shown in full in the UI and email, and as a short link in SMS.
- Risky steps wait for approval in the UI or by **replying to the alert** (`YES 1703`, `ACK 1703`, `RESOLVE 1703`; codes expire after 1 hour).
- Everything goes to the audit log. Alerts close on a `resolved` event from the source (e.g. Alertmanager).
- Resolution notes feed back into the runbook ("learned from incidents") and create suggestions for the rule owner.

## Measured performance

`bun run build && bun run start`, then `bun run loadtest` on an Apple-silicon laptop. Single process. Open model (k6 `constant-arrival-rate` style): requests fire on schedule regardless of responses, and HTTP latency is measured from the *scheduled* send time, so there is no coordinated omission. End-to-end latency is measured in the service from ingest until the channel adapter accepts the message.

| Load | Achieved | HTTP errors | HTTP p50 / p99 | Ingest → delivery p50 / p99 | Processing per event p50 / p99 |
| --- | --- | --- | --- | --- | --- |
| 500 msg/s × 20 s, every event a new alert (20k deliveries) | 499.9 msg/s | 0 | 3.6 / 13.4 ms | 0 / 2 ms | 0.075 / 0.31 ms |
| 2000 msg/s × 15 s, every event a new alert | 1997.9 msg/s | 0 | 2.7 / 34.1 ms | 1 / 16 ms | 0.076 / 0.45 ms |
| 1000 msg/s × 10 s, realistic mix with duplicates | 999.6 msg/s | 0 | 2.7 / 11.9 ms | 1 / 11 ms | 0.017 / 0.09 ms |

Raw results are in `results/`. Re-run them on the demo machine before recording.

## What is mocked

| Area | Status |
| --- | --- |
| Email, SMS, phone | Mock gateways; messages are visible in *People & channels*. One adapter each. |
| Message broker | Simulated by demo scenarios calling the same `ingest()`; no Kafka client |
| Runbook actions `retry_workflow`, `restart_service`, `rollback`, `failover`, `open_ticket`, `notify_channel` | Simulated, logged as `ops`/`chat` messages |
| `http_get` / `webhook` actions | Real HTTP to allow-listed hosts. Dot-less hosts such as `counterparty-service` are simulated internal services. |
| SSO / authorisation | Mocked: "Acting as" picker in the sidebar, sent as `x-actor` |
| Storage | In-memory state with a JSON snapshot every 2 s (`data/state.json`); config in YAML files |

## Scaling and single points of failure

Today the service is one process, which keeps the clone-to-demo path short. State is split by kind: config in git-friendly YAML; alerts, dedup windows and the outbox in memory plus a snapshot. To run N stateless instances, move that runtime state to Postgres:

- the alert table keyed by fingerprint becomes the dedup window (`INSERT … ON CONFLICT DO UPDATE count = count + 1`);
- the delivery table becomes a transactional outbox, claimed with `FOR UPDATE SKIP LOCKED`;
- broker consumers share one consumer group.

After that the database is the only SPOF; a replica is a deployment step. Each engine module (`store.ts`, `engine.ts`) has one entry point, so this change stays contained.

## Security & AI

| Risk (OWASP LLM Top 10) | Mitigation |
| --- | --- |
| Prompt injection (field names, runbook text) | Inputs are marked as untrusted data in the prompt; output is strict JSON validated against the real field list and action registry; nothing the model returns is executed without a human ✓ |
| Sensitive data disclosure | Only paths, types and formats are sent, never values; id-like path segments become `<id>`. `OPENROUTER_BASE_URL` can point to a self-hosted model so nothing leaves the network. |
| Excessive agency | The model cannot call actions. Actions run only from the rule engine or a human click/reply; risky kinds always need approval. |

Other measures:
- Runbook HTTP actions can only call hosts in `ACTION_ALLOWED_HOSTS` (SSRF guard), with no redirects and a 3 s timeout.
- Ingest can require `Authorization: Bearer $INGEST_TOKEN` or an `X-Signature: sha256=` HMAC.
- Secrets live only in `.env.local` (gitignored).
- Approvals by reply need the per-alert code, which expires after 1 hour.
- Every approval, step, rule or mapping change and config reload is in the audit log.

**AI in development:** the code was written with an AI coding assistant. Every change was reviewed and tested (`smoke`, `eval:mapping`, `loadtest`), and no company data was used in prompts.

## Extending

| Add a… | How |
| --- | --- |
| source | `POST /api/ingest/<name>` with any JSON, or drop a `.log` file into `data/logs/` — no code |
| schema | nothing to do; review the mapping in *Sources & schemas* |
| rule | UI editor, `PUT /api/rules`, or edit `config/rules.yaml` (live reload) |
| runbook | drop a `.yaml/.md/.txt/.url` file into `config/runbooks/` |
| channel provider | implement `ChannelAdapter.send()` in `src/lib/engine/channels.ts` |
| action kind | add one entry to `ACTIONS` in `src/lib/engine/actions.ts` |

## Layout

```
config/            rules.yaml, recipients.yaml, runbooks/, schemas.yaml (approved mappings)
src/lib/engine/    engine.ts (pipeline, dedup, outbox worker, approvals), schema.ts (layer-1 mapper),
                   rules.ts, runbooks.ts, actions.ts, channels.ts, llm.ts, config.ts, store.ts
src/app/api/       ingest, stream (SSE), alerts, rules, schemas, runbooks, recipients, reply, system, demo
src/app/(app)/     Live alerts, alert detail, Rules, Sources & schemas, Runbooks, People & channels, System & audit
scripts/           smoke.ts, loadtest.ts, eval-mapping.ts
```

UI components come from Tailwind Catalyst (see `LICENSE.md`).
