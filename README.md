# CTRL — flexible alerting & notification service

Gets the right alert to the right people on their preferred channel and walks them through the team's runbook. One Next.js app (UI + API + delivery worker) on Bun, Postgres as the only stateful component, N stateless instances.

## Run it (one command)

Requirements: Docker with Compose v2. No `.env` file, API keys or local tooling needed.

```bash
git clone git@github.com:aquaqamelob/gs-hack.git
cd gs-hack
docker compose up --build
```

The first build takes a few minutes. When the app logs `[ctrl] … ready`, open:

| URL | What |
| --- | --- |
| http://localhost:3000 | CTRL console (through the nginx load balancer) |
| http://localhost:8025 | MailHog: every email CTRL sends |
| http://localhost:4010/messages | Mock SMS / phone gateway and runbook webhook calls |
| http://localhost:3000/metrics | Prometheus metrics |

Three instances behind the load balancer:

```bash
APP_REPLICAS=3 docker compose up --build
```

Stop with `Ctrl+C`; `docker compose down -v` also deletes the database.

**GitHub Codespaces:** open the repo in a Codespace (the dev container installs Bun and Docker), then run `docker compose up --build` in its terminal. Ports 3000, 8025 and 4010 are forwarded automatically.

### Try it

On **Live alerts**, the *Simulate* buttons replay the events from the brief: workflow failure, a burst of 500 duplicates, an Alertmanager alert and its resolution, a rejected trade, pricing log lines, and an unknown schema. Or send your own:

```bash
# any JSON, any shape: unknown schemas are accepted (202) and land in the Unassigned inbox
curl -XPOST localhost:3000/ingest/webhook -H 'content-type: application/json' \
  -d '{"type":"WORKFLOW_FAILED","workflowId":"WF-1","workflowName":"order-settlement","step":"validate-counterparty","severity":"ERROR","environment":"prod","error":{"code":"TIMEOUT","message":"no response in 5000 ms"}}'

# log lines
curl -XPOST localhost:3000/ingest/logs -H 'content-type: text/plain' \
  --data-binary '2026-10-23T09:14:02Z WARN pricing-engine-3 instrument=EURUSD latency_ms=1200 msg="price latency above threshold"'

# Redpanda: topics "events" and "logs" are consumed by every instance (one consumer group)
docker compose exec redpanda rpk topic produce events <<< '{"type":"HEARTBEAT","service":"x"}'

# authenticated sources: bearer for "partner", HMAC for "payments"
curl -XPOST localhost:3000/ingest/partner -H 'authorization: Bearer dev-partner-token' -H 'content-type: application/json' -d '{"a":1}'
```

Simulate an outage: `docker compose stop mock-gateway`, trigger an alert, watch SMS deliveries retry on *System*, then `docker compose start mock-gateway` and see them delivered once.

### Services in `docker-compose.yml`

| Service | Role |
| --- | --- |
| `app` | CTRL (Next.js on Bun). Stateless, scale with `APP_REPLICAS` |
| `lb` | nginx in front of the app replicas (SSE buffering off) |
| `postgres` | the only state: events, schemas, alerts, outbox, audit log |
| `redpanda` | Kafka-compatible broker |
| `mailhog` | SMTP sink with a web UI |
| `mock-gateway` | SMS / phone provider mock and target of runbook webhooks (`counterparty-service`, `workflow-api`, `escalation-api`) |

There is no LLM or other AI in the service: schema mapping and runbook parsing are deterministic, and anything uncertain waits for a human.

## Local development without Docker

```bash
bun install
bun scripts/dev-db.ts            # embedded Postgres on :5432
bun mock-gateway/server.ts       # mock gateway on :4010 + SMTP sink on :1025
cp .env.example .env.local
bun run dev                      # http://localhost:3000
bun run smoke                    # 28 end-to-end checks against the running stack
```

## How it works

```
 Redpanda (events, logs) ┐
 POST /ingest/<source>   ├─► schema fingerprint ─► normalise ─► rules ─► dedup / group ─► outbox ─► adapters
 Alertmanager webhook    ┘   (stored mapping)                  (YAML)   (Postgres upsert)  (SKIP     email · sms · phone · ui (SSE)
                                   │                                                        LOCKED)
                                   └─► new schema ─► deterministic ─► fuzzy ─► human ✓
```

- **Ingest:** unknown schemas are never rejected (202); malformed JSON is 400, bad credentials 401. Events are written in batches in one transaction together with alert upserts and outbox rows.
- **Schema mapping:** fingerprint = sorted key paths, mapping stored in Postgres. No model call on the alert path. Unmapped events that match no rule go to the Unassigned inbox and to the default owner (`unmapped_events_total`).
- **Rules:** `config/rules.yaml`, hot-reloaded. Ops `eq, neq, in, not_in, gt, gte, lt, lte, regex, glob, exists`, nested `all`/`any`. Grouping like Alertmanager: `group_by`, `group_wait`, `group_interval`, `dedup_window`. The editor previews a rule against the last 100 events.
- **Delivery:** transactional outbox claimed with `FOR UPDATE SKIP LOCKED`, exponential backoff with jitter, dead-letter queue with requeue. Idempotency key = alert + notification + channel + recipient. Per-person channel preferences and working hours.
- **People, filters and admin:** SSO is mocked — you pick who you are in the bottom-left corner and the console sends that id in `x-actor`. The role comes from `config/recipients.yaml` (`role: admin`), never from the request. **My view** (`/me`) shows a person's live alerts (their own plus those of the teams in `teams:` or where they are on call), their personal filters and their channel preferences. A person can create, pause, edit and delete only their own filters (a rule owned by them that notifies only them) and change only their own preferences. An **admin** changes every rule, including team filters, and every recipient, including roles and team membership. The API enforces this (403 otherwise); the YAML files stay editable by whoever can edit the files.
- **Runbooks:** `config/runbooks/` in YAML, Markdown or free text. One action kind, a webhook, configured by name in `config/actions.yaml`; targets allow-listed, secrets only from env. Approval in the UI or by replying `YES <code>` (expires after 1 h). Everything goes to the audit log.

## Layout

```
config/          rules.yaml, recipients.yaml, actions.yaml, runbooks/
db/schema.sql    Postgres schema (applied on start under an advisory lock)
src/lib/engine/  pipeline, schemas, rules, outbox, channels, alerts, runbooks, actions, kafka, auth
src/app/api/     ingest, stream (SSE), alerts, rules, schemas, runbooks, recipients, me, reply, system, metrics
src/app/(app)/   My view, Live alerts, alert detail, Rules, Sources & schemas, Runbooks, People, System & audit
mock-gateway/    SMS / phone / webhook mock (Bun)
scripts/         smoke.ts, dev-db.ts
```

UI components come from Tailwind Catalyst (see `LICENSE.md`).
