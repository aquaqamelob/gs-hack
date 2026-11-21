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

Config (rules, recipients, custom fields, runbooks) lives in Postgres, like everything else; `config/` only seeds it on first boot. A save from any replica reaches every replica within milliseconds (`pg_notify`, plus a 5 s version check as a fallback). Each save locks the row and starts from what is stored, so two concurrent edits never overwrite each other; a save based on a stale copy gets `409` and the UI reloads. `GET /api/rules/export` gives the current rules as YAML for git.

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
bun run smoke                    # 41 end-to-end checks against the running stack
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
- **Rules:** stored in Postgres (`config_docs`, seeded from `config/rules.yaml` on first boot); a save from any instance is broadcast with `pg_notify` and every instance reloads. `GET /api/rules/export` returns them as YAML. Recipients, custom fields and runbooks work the same way. Ops `eq, neq, in, not_in, gt, gte, lt, lte, regex, glob, exists`, nested `all`/`any`. Grouping like Alertmanager: `group_by`, `group_wait`, `group_interval`, `dedup_window`. The editor previews a rule against the last 1000 events (`RULE_PREVIEW_EVENTS`), including its noise budget. Evaluation errors are counted (`rule_errors_total`) and flagged on the rule.
- **Delivery:** transactional outbox claimed with `FOR UPDATE SKIP LOCKED`, exponential backoff with jitter, dead-letter queue with requeue. Idempotency key = alert + notification + channel + recipient. Per-person channel preferences and working hours.
- **People, filters and admin:** SSO is mocked — you pick who you are in the bottom-left corner and the console sends that id in `x-actor`. The role comes from the recipients config (`role: admin`), never from the request. **My view** (`/me`) shows a person's live alerts (their own plus those of the teams in `teams:` or where they are on call), their personal filters and their channel preferences. A person can create, pause, edit and delete only their own filters (a rule owned by them that notifies only them) and change only their own preferences. An **admin** changes every rule, including team filters, and every recipient, including roles and team membership. The API enforces this (403 otherwise).
- **Runbooks:** YAML, Markdown or free text (seeded from `config/runbooks/`). One action kind, a webhook, configured by name in `config/actions.yaml`; targets allow-listed, secrets only from env. Approval in the UI or by replying `YES <code>` (expires after 1 h). Everything goes to the audit log.

## Design decisions

- **Unknown events are never dropped.** An event that matches no schema or rule returns `202` and lands in the visible *Unassigned* inbox for a human. Dropping it would hide exactly the failure nobody planned for.
- **The tool proposes, people decide.** Heuristics may suggest a schema mapping or a runbook structure; a human approves it. Runbooks learn the same way: resolving an alert with "What fixed it?" turns each new step into a templated suggestion (IDs become `{{field}}`, repeats across incidents are merged), and an admin adds it to the runbook. Anyone can also propose a fix from an alert (too noisy, wrong team, missing step, ...). The service has no LLM.
- **Delivery is at-least-once.** A crash after a provider accepts a message but before the outbox records it causes a repeat send. Every send carries an idempotency key (alert + notification + channel + recipient), so a provider that honours the key delivers it once. The real SMS provider must support this, and SMTP has only the `Message-ID` for downstream deduplication.
- **NOTIFY is sent after commit.** A Postgres transaction with `NOTIFY` takes a global lock at commit and holds it through the WAL flush, which made it the main wait under load. Hot paths now send one batched notification after commit, without a flush. Losing one in a crash costs a UI refresh, because the data is already committed and dispatchers also poll every 250 ms.
- **Noise budget before saving.** The rule preview replays the last 1000 events through the real grouping (`group_wait`, `group_interval`, `dedup_window`) and `planDeliveries`, and shows who would get what, including sends outside working hours. It stores and sends nothing.

### Failure and scaling

App instances are stateless, and work is shared through row locks, so losing one only delays what it had leased (30 s). In `docker-compose.yml`, **Postgres, Redpanda and nginx are single instances**, so each is a single point of failure in this demo. Production needs a managed or replicated Postgres with automatic failover, a 3-node broker and a redundant load balancer. The outbox guarantees no accepted event is lost on Postgres failover only with **synchronous replication**; an asynchronous replica can lose the last commits.

Events are kept for `EVENT_RETENTION_HOURS` (default 24) and deleted in short batches, up to 1M rows per minute. At sustained high volume the next step is daily partitions of `events`, so retention becomes `DROP PARTITION`. This is not implemented.

## What is mocked and how to make it real

| Part | Today | To make it real |
| --- | --- | --- |
| Email | Real SMTP, delivered to MailHog | Set `SMTP_URL` |
| SMS / phone | `mock-gateway` over HTTP | Implement one `ChannelAdapter` in `src/lib/engine/channels.ts` |
| Inbound replies | Mock gateway signs them with HMAC | Point the provider's webhook at `/api/reply` with `INGEST_HMAC_REPLY` |
| Runbook webhooks | `mock-gateway` | Set target URLs and `ACTION_ALLOWED_HOSTS` |
| SSO | "Acting as" picker sends `x-actor` | Replace `actorOf` / `me` with verified identity |
| LLM | None | Not needed |

**Known limitation:** because SSO is mocked, anyone who can reach the API can claim any identity in `x-actor`, including `admin`, and approve a runbook step through `/api/alerts/:id/steps/:stepId`. The console must not be exposed outside a trusted network until real SSO is in place.

## Measured performance

Measured on an Apple M5 in one Colima VM (6 vCPU, 10 GB) shared by the app, Postgres, nginx, Redpanda and the load generator. Open-model load, 15 s per point, one alert per event, `ui` channel, latency measured from the scheduled send time. Because everything shares 6 vCPU, **these numbers show capacity on this machine and do not demonstrate linear horizontal scaling**.

Effect of batching NOTIFY, median of 3 runs. "Held" means no errors, every event stored, at least 95% of the target rate, HTTP p99 under 1 s and an empty queue.

| Replicas | Target msg/s | HTTP p99 before | HTTP p99 after | Ingest→delivery p99 after | Held before | Held after |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2000 | 1066 ms | 115 ms | 115 ms | 0/3 | 3/3 |
| 2 | 3000 | 1082 ms | 103 ms | 92 ms | 0/3 | 3/3 |
| 4 | 2000 | 39 ms | 35 ms | 31 ms | 3/3 | 3/3 |
| 4 | 3000 | 1309 ms | 153 ms | 143 ms | 0/3 | 3/3 |

Scaling curve, HTTP p99 from a single run:

| Replicas | 500/s | 1000/s | 1500/s | 2000/s | 3000/s |
| --- | --- | --- | --- | --- | --- |
| 1 | 7 ms | 9 ms | 13 ms | 247 ms | not held (2313/s) |
| 2 | 9 ms | 10 ms | 13 ms | 34 ms | 239 ms |
| 4 | 10 ms | 16 ms | 60 ms | 299 ms | not held (2268/s) |

**3000 msg/s on 4 replicas is at the limit of this machine:** it held in 3 of 4 runs. 2 replicas held it in 4 of 4. With email added, the local MailHog sink becomes the limit: 2 replicas held 1000 msg/s with ingest→delivery p99 of 468 ms, and 4 replicas accepted the same rate but delivered with a p99 of 6.4 s.

Failure drill: 3 replicas, 100 msg/s for 30 s, SMS gateway down from 6 s to 15 s, one replica killed with SIGKILL at 10 s and restarted at 20 s. In 3 of 3 runs, **3000 of 3000 accepted events reached the gateway, with 0 lost, 0 duplicates and 0 dead-lettered**. No kill landed between a send and its outbox update, so these runs do not exercise the repeat-send path described above.

Schema mapping (`bun run eval:mapping`, 10 schemas, 53 fields): rules alone map **48 fields (91%)** and leave 5 for a human. The script reports 1 wrong mapping, an extra `title → title` on the Datadog-like case, whose expected answer does not list a title.

Reproduce:

```bash
scripts/scale-curve.sh "1 2 4" "500 1000 1500 2000 3000" 15 final
```

```bash
CHANNELS=ui,email scripts/scale-curve.sh "1 2 4" "250 500 1000" 15 final-email
```

```bash
scripts/chaos.sh 3 100 30
```

```bash
bun run eval:mapping
```

The first three use an isolated Compose project (`ctrl-perf`) with its own database and remove it afterwards. Results go to `results/`.

## AI usage, security and privacy

**AI tools:** Claude Code was used during development to audit the code, implement and test changes, and run the load and failure measurements. The team set priorities and decides what is merged. **The running service calls no AI model**, so no event data leaves it for that purpose.

**Security:** ingest sources authenticate per source with a bearer token or HMAC. Reply webhooks are signed; a reply must come from an address that was notified about that alert, uses a code unique among open alerts, and is rate-limited, with failures in the audit log. Runbook webhooks go only to allow-listed hosts, with secrets from the environment. Credentials in `docker-compose.yml` are demo values and must be replaced. See the SSO limitation above.

**Privacy:** raw events are stored in Postgres and can contain personal data. The `events` table is purged after the retention period, but alerts, deliveries (including phone numbers and email addresses) and the audit log are kept until deleted, so production needs a retention policy for them too.

## Layout

```
config/          seed files: rules.yaml, recipients.yaml, fields.yaml, runbooks/ (copied to Postgres on first boot); actions.yaml
db/schema.sql    Postgres schema (applied on start under an advisory lock)
src/lib/engine/  pipeline, schemas, rules, outbox, channels, alerts, runbooks, actions, kafka, auth
src/app/api/     ingest, stream (SSE), alerts, rules, schemas, runbooks, recipients, me, reply, system, metrics
src/app/(app)/   My view, Live alerts, alert detail, Rules, Sources & schemas, Runbooks, People, System & audit
mock-gateway/    SMS / phone / webhook mock (Bun)
scripts/         smoke.ts, loadtest.ts, scale-curve.sh, chaos.sh, chaos-restart.ts, eval-mapping.ts, dev-db.ts
```

UI components come from Tailwind Catalyst (see `LICENSE.md`).
