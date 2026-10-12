# PRANIT AI CITY

A **local-first autonomous AI company**. You are the Founder. You type one objective in
plain language; a single Orchestrator (the CEO) turns it into a dependency-aware plan,
assigns the work to eleven specialists, and those specialists run **real tools** — they
write files, execute shell commands, run the test suite, commit to git, and start dev
servers — inside a sandboxed project workspace. Failures are diagnosed and repaired.
What comes out is a runnable project plus a delivery report built only from executed
evidence.

The whole company is rendered as a living 2D city: departments are buildings, agents
walk between them, and a task in flight is a marker on the roof of whoever owns it.

> **The one rule this codebase obeys:** *if the UI shows it, the backend really did it.*
> No decorative progress bars, no placeholder buttons, no ghost features, and no invented
> test results. When something could not be done — no provider configured, Laya weights
> unavailable, a run that used the offline mock — the interface says exactly that.

---

## Contents

1. [What you get](#what-you-get)
2. [The ten areas](#the-ten-areas)
3. [The company](#the-company)
4. [Architecture](#architecture)
5. [Install and run (Ubuntu)](#install-and-run-ubuntu)
6. [First run](#first-run)
7. [Configuring an AI provider](#configuring-an-ai-provider)
8. [How a run actually works](#how-a-run-actually-works)
9. [The decision layer (System 1 / System 2)](#the-decision-layer-system-1--system-2)
10. [Security model](#security-model)
11. [Configuration reference](#configuration-reference)
12. [Database and migrations](#database-and-migrations)
13. [API surface](#api-surface)
14. [Tests](#tests)
15. [What was actually tested](#what-was-actually-tested)
16. [Known limitations](#known-limitations)
17. [Repository layout](#repository-layout)
18. [Troubleshooting](#troubleshooting)

---

## What you get

| | |
| --- | --- |
| Backend | FastAPI + Pydantic v2 + SQLAlchemy 2 + SQLite (WAL), asyncio, **81 HTTP routes + 1 WebSocket** |
| Frontend | Vite 6 + React 19 + TypeScript 5.7 + Tailwind 4, hand-written Canvas 2D city, **10 areas** |
| Agents | 12 profiles (11 specialists + the decision agent), **23-tool catalogue**, per-agent least-privilege whitelists |
| Execution | Real filesystem, shell, git, test-runner and dev-server tools, workspace-scoped and policy-checked |
| Decisions | Pluggable System-1 layer (Laya when available, deterministic local engine otherwise) with calibrated confidence gates |
| Safety | Zero-spend by default, Fernet-encrypted keys, approval gates, append-only audit trail, secret redaction |
| Tests | **186 backend tests** (pytest) and **99 frontend tests** (vitest), all passing |

Nothing is a SaaS. There is no account, no telemetry, no cloud dependency. The API binds
to `127.0.0.1` and the browser only ever talks to the dev server, which proxies `/api`
and `/ws`.

---

## The ten areas

| # | Area | Route | What is really behind it |
| --- | --- | --- | --- |
| 1 | **City** | `/` | `GET /api/city` — buildings, roads, seats, agent positions, live task markers, degraded providers. Canvas 2D, pan/zoom 0.4–2.5×, keyboard districts `1`–`9`, `Esc` fit, `C` compact (writes `compact_mode`), rendering frozen while the tab is hidden. |
| 2 | **Command Center** | `/command` | Submit an objective (`POST /api/objectives`), watch the plan state machine, pause/resume/cancel, grant budget approvals, inspect the DAG, checkpoints, budget and delivery report. |
| 3 | **Agent Directory** | `/agents` | The twelve real profiles: charter, responsibilities, prohibitions, output contract, model config (editable), tool whitelist (`GET /api/agents/{id}/tools`), recent tasks, memory namespace, live model connectivity test. |
| 4 | **Agent Workspace** | `/workspace/:agentId` | The console for one specialist: verbatim conversation, every tool call with arguments, exit code, duration, denial reason and result excerpt, task history, recalled memory. |
| 5 | **Task Manager** | `/tasks` | All tasks with real evidence — verification checks and exit codes, files changed, retries, tokens — plus retry and reassign. |
| 6 | **Projects** | `/projects`, `/projects/:id` | The workspaces on disk: file tree, file viewer, **execute the project's tests on demand**, git log, working-tree diff, start/stop a real dev server, secret scan, delivery report. |
| 7 | **AI Providers** | `/providers` | Add/edit/test providers (9 kinds), discover models, per-provider usage, default/fallback selection, and the hard zero-spend switch. Keys are write-only. |
| 8 | **Knowledge Center** | `/knowledge` | Upload reference material (18 accepted formats), see real chunk counts and index status, BM25 search with scores, re-index, delete. |
| 9 | **Activity Center** | `/activity` | Three honest logs: the live event stream (WebSocket → SSE → polling fallback), the decision log with per-type gates and a live probe, and the append-only audit trail. JSON export. |
| 10 | **Settings** | `/settings` | Readiness checklist computed from `/api/setup/status`, token budgets, every runtime-editable setting with its description and default, local paths, and a danger zone (purge history, reset memory). |

---

## The company

One orchestrator, eleven specialists, one decision agent. Names and ids are fixed in
`backend/app/agents/profiles.py`; the id is what the API and the city use.

| id | Name | Role | Department | Output contract |
| --- | --- | --- | --- | --- |
| `ceo` | **Pranit** | Orchestrator / CEO | Command Tower | plan |
| `pm` | **Mira** | Product Manager | Product Studio | markdown |
| `architect` | **Karan** | Architect | Engineering HQ | markdown |
| `research` | **Anya** | Research | Research Lab | findings |
| `designer` | **Reva** | UI/UX Designer | Design Studio | diff_summary |
| `frontend` | **Ishaan** | Frontend Engineer | Engineering HQ | diff_summary |
| `backend` | **Dev** | Backend Engineer | Engineering HQ | diff_summary |
| `qa` | **Rhea** | QA Engineer | QA Center | test_report |
| `security` | **Vikram** | Security Engineer | Security Ops Center | diff_summary |
| `devops` | **Noor** | DevOps Engineer | Infrastructure Center | diff_summary |
| `docs` | **Tara** | Documentation | Docs & Delivery | markdown |
| `laya` | **Laya** | Decision agent (System 1) | Decision Lab | — (never owns tasks) |

`ceo` and `laya` are excluded from task routing: the plan validator rejects a plan that
assigns work to either of them, so there is exactly **one** authoritative orchestrator and
no agent can start a competing global loop.

Each profile carries a fixed charter — responsibilities, skills, an explicit *prohibited*
list, and a tool whitelist that can only ever be **narrowed** from the UI
(`PATCH /api/agents/{id}` answers `409 tool_not_permitted` if you try to widen it).

---

## Architecture

```
                       browser (relative URLs only)
                                 │
                    ┌────────────▼─────────────┐
                    │  Vite dev server :5173   │   React 19 + Tailwind 4
                    │  proxy /api, /ws         │   Canvas 2D city, zustand store
                    └────────────┬─────────────┘   WebSocket → SSE → polling
                                 │
                    ┌────────────▼─────────────┐
                    │ FastAPI  127.0.0.1:8000  │  bearer auth, error envelope,
                    │ 81 HTTP routes + /ws     │  request ids, redaction
                    └────────────┬─────────────┘
        ┌──────────────┬─────────┼──────────┬───────────────┬──────────────┐
        ▼              ▼         ▼          ▼               ▼              ▼
  Orchestrator   Decision layer Providers  Tools        Knowledge      Event bus
  planner        routing       registry   policy       ingest/chunk   + SQLite
  scheduler      guardrails    zero-spend  fs/shell     BM25 search    (WAL)
  budget         repair        usage       vcs/servers
  checkpoints    LLM fallback              approval gates
  verifier
  reporter
        │
        ▼
  workspaces/<project>/   ← real files, real git repo, real test runs
```

**Backend module map** (`backend/app/`)

| Module | Responsibility |
| --- | --- |
| `config.py` | `PRANIT_*` settings, key/token generation (0600 files) |
| `db.py` | Engine, `session_scope`, `init_db`, additive `migrate_schema()` |
| `models.py` | All tables + `SETTING_KEYS` runtime settings |
| `planning.py` | Deterministic heuristic planner (used when no provider is configured) |
| `protocol.py` | `# PRANIT/PLANNER v1`, `# PRANIT/AGENT <id> v1`, `# PRANIT/DECISION v1`, fenced tool calls |
| `city.py` | Builds the city payload from live database state |
| `security/` | `auth` (bearer), `paths` (workspace containment), `crypto` (Fernet), `redact` (secret patterns) |
| `api/` | Routers, one error envelope, request-id/duration headers |
| `events/` | In-process bus with persisted history, priority triage |
| `decisions/` | `schemas`, `local_engine`, `laya_adapter`, `router`, `service`, `presets`, `llm_fallback` |
| `providers/` | `registry` (pick/complete/usage/zero-spend) + adapters: anthropic, gemini, ollama, openai_compat, http, mock |
| `tools/` | `context`, `fs`, `shell`, `vcs`, `servers`, `registry` (23 tools), `policy` (allowlist/denylist/risk) |
| `knowledge/` | `ingest`, `chunking`, `search` (BM25) |
| `memory/store.py` | Agent / project / company scoped recall with weights |
| `agents/` | `profiles` (the 12 charters), `runtime` (rounds, guardrails, contract validation) |
| `orchestrator/` | `planner`, `scheduler`, `budget`, `checkpoints`, `approvals`, `verifier`, `repair`, `reporter`, `orchestrator` |

---

## Install and run (Ubuntu)

Tested on Ubuntu 22.04/24.04 with Python 3.11.2 and Node 20+.

```bash
# 1. System packages
sudo apt update
sudo apt install -y python3 python3-venv python3-pip curl git

# Node 20 (skip if you already have node --version >= 20)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Get the code
git clone https://github.com/pranitdandewarofficial/idea.git
cd idea

# 3. Install both halves (creates backend/.venv, backend/.env, frontend/node_modules)
./scripts/setup.sh

# 4. Run: API on 127.0.0.1:8000, UI on http://localhost:5173
./scripts/dev.sh
```

Open **http://localhost:5173**. `Ctrl-C` stops both processes.

Manual equivalent, if you prefer to see every step:

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
# new terminal:
cd frontend
npm install
npm run dev
```

Production build of the UI (the API still serves the data; any static host can serve `dist/`):

```bash
cd frontend && npm run build && npm run preview   # http://localhost:4173
```

Docker (optional, UI published on `127.0.0.1:5173` only, API not published at all):

```bash
docker compose up --build
```

> **Requirements:** Python ≥ 3.11 (3.12+ works, the code uses no 3.12-only syntax),
> Node ≥ 20, `git` on PATH for the version-control tools, and `pytest` or an
> `npm test` script inside a project workspace if you want the QA agent to run tests.
> Docker is optional and only used at sandbox tier 2.

---

## First run

1. **Read the readiness checklist** (Settings). It is computed from `/api/setup/status`
   and `/api/health`, so it tells you the truth: backend reachable, provider configured,
   a *free* provider exists, zero-spend state, decision engine, sandbox tier.
2. **Add a provider** (AI Providers). With no provider the CEO falls back to the
   deterministic heuristic planner and the run is labelled accordingly.
3. **Submit an objective** (Command Center). Be specific about stack, deliverables and
   what "done" means — a vague objective gets stated assumptions instead of questions.
4. **Watch the city**. Buildings light up, agents move, task markers appear on roofs,
   failures turn a building amber.
5. **Answer approval gates** when they appear (bell button, top right). Destructive,
   deploy and credential actions stop there until you decide.
6. **Read the delivery report**. It lists per-criterion verdicts with evidence, the files
   that really exist, the tool-call and decision counts, and every limitation.

The API token is generated at first boot into `backend/.data/api_token` (mode `0600`),
printed once in the server log, and shown on the Settings screen. The browser fetches it
from `/api/setup/status` and keeps it **in memory only**.

---

## Configuring an AI provider

Nine kinds are supported (`GET /api/providers/kinds`): `openai`, `openai_compatible`,
`openrouter`, `lmstudio`, `vllm`, `anthropic`, `gemini`, `ollama`, `mock`.

### Recommended: Ollama (local, free, no key)

```bash
# install: https://ollama.com/download
ollama serve                 # leave running
ollama pull llama3.1:8b
ollama pull qwen2.5-coder:7b # a stronger coding model, optional
```

Then in **AI Providers → Add provider**:

| Field | Value |
| --- | --- |
| Label | `Ollama (local)` |
| Kind | `ollama` |
| Base URL | `http://127.0.0.1:11434` |
| Default model | `llama3.1:8b` |
| API key | *(leave empty — this kind needs none)* |
| Paid provider | **off** |
| Role models | `planning=llama3.1:8b` / `coding=qwen2.5-coder:7b` (one per line) |

Press **Test**. You get a real latency and a real reply, or the real error.

### Paid providers

| Kind | Base URL | Key |
| --- | --- | --- |
| `anthropic` | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` value |
| `gemini` | `https://generativelanguage.googleapis.com` | Google AI Studio key |
| `openai` | `https://api.openai.com` | `sk-…` |
| `openrouter` | `https://openrouter.ai/api/v1` | `sk-or-…` |
| `openai_compatible` / `vllm` / `lmstudio` | your endpoint | usually none |

Paid providers are **blocked while zero-spend mode is on** (the default). Two ways to use
one:

* per run — tick *Authorize paid providers for this run* when submitting the objective
  (`spend_authorized: true`), or
* globally — turn zero-spend off in AI Providers or Settings (written to the audit trail).

### The offline mock provider

`kind: mock`, `is_paid: false`. It needs no network and no key, and it drives the *whole*
real pipeline: planning, scheduling, tool execution, verification, repair, reporting. Its
outputs are deliberately stubs, so:

* every completion is recorded with `mocked: true`,
* the delivery report sets `used_mock_provider: true` and **`delivered: false`**,
* the report's first limitation says the run was a dry run.

A mock run can never be labelled a successful delivery. That is enforced in
`orchestrator/reporter.py`, not in the UI.

### Where keys go

Keys are accepted only by `POST /api/providers` and `PATCH /api/providers/{id}`. They are
encrypted with Fernet (`app/security/crypto.py`) before they reach SQLite, and the API
returns only `has_key: true` and a short `key_fingerprint`. They never appear in a
response body, a log line, an error trace, an agent prompt, or browser storage.

---

## How a run actually works

```
objective ──► received ──► planning ──► scheduled ──► executing ──► verifying
                                 │                        │  ▲          │
                                 │                        ▼  │          ▼
                                 └── clarifying        repairing ──► integrating
                                                                            │
   complete ◄── delivering ◄── reviewing ◄──────────────────────────────────┘

   blocked / paused / failed / cancelled can be reached from any active state
```

1. **Plan.** The CEO is given the objective plus the roster and produces a plan in the
   `# PRANIT/PLANNER v1` protocol: requirements, acceptance criteria, assumptions,
   clarifying questions, and tasks with `depends_on`, expected outputs, done-criteria and
   **verify commands**. With no provider, `planning.heuristic_plan` produces a real,
   runnable plan and the plan is flagged `heuristic: true` in the UI.
2. **Validate.** `planner.normalise_plan` repairs dependencies, breaks cycles, computes a
   topological order, then `validate_plan` rejects owners that are `ceo`/`laya`, unknown
   agents, empty descriptions or missing outputs. The `plan_validation` decision adds a
   semantic check. Validation ratios (actionable, coverage, estimated tokens vs budget)
   are shown in the Command Center.
3. **Route.** Before each dispatch, the `routing` decision scores all eligible specialists
   against the task; below the gate it escalates to the LLM fallback, and the chosen agent
   is recorded as a `DecisionRecord` with its confidence and engine.
4. **Execute.** The agent runtime sends the task with the protocol preamble, recalled
   memory and retrieved knowledge (labelled as untrusted evidence), then loops up to
   `agent_tool_rounds` times: the model emits fenced tool calls, the policy layer checks
   each one, the registry executes it in the workspace, and the real result is fed back.
5. **Guard.** Every round passes the `guardrail` decision (injection, destructive action,
   secret leak, path escape). At probability ≥ 0.85 the round is blocked.
6. **Verify.** Each task's `verify_commands` are executed for real; exit codes and output
   are stored in `task.verification`. The output contract is enforced: a `diff_summary`
   without real `files_changed` is rejected, a `test_report` without an executed test
   command and a pass/fail line is rejected.
7. **Repair.** On failure the `repair_strategy` decision chooses `retry_same`,
   `fix_context`, `reassign` or `escalate`, bounded by `max_repairs`.
8. **Gate.** `risk_assessment` decides whether an action needs a human. `delete_file` and
   `git_push` are **never** auto-approved. Budget exhaustion creates an approval too.
9. **Checkpoint.** State is saved at every task boundary; an interrupted run resumes.
10. **Report.** `reporter` builds the delivery report from executed evidence only:
    per-criterion status, artefact list with sizes and a workspace hash, tool-call and
    decision metrics, token usage, and limitations. `delivered` is true only when the run
    completed, verification passed, **and** no mock provider was involved.

Every step emits events on the bus, which the UI receives over the WebSocket
(`/ws?token=…&since=…`, with `ping`/`pong` and `replay`), falling back to Server-Sent
Events and then to polling — and the header shows which transport is actually in use.

---

## The decision layer (System 1 / System 2)

Fast, calibrated, non-generative decisions are answered by **System 1**; anything it is
not confident about escalates to **System 2** (the configured LLM) or to you.

**Runtime status is honest.** `GET /api/decisions/status` reports:

```json
"laya": {
  "mode": "local",
  "available": false,
  "reason": "Laya runtime not installed (pip install laya-mnn) and no hosted endpoint
             configured; using the deterministic local decision engine"
}
```

Laya (Convai Innovations, Apache-2.0, 421M-parameter non-autoregressive decision model)
is supported through a pluggable adapter that auto-detects `laya` or `laya-mnn` at runtime,
or calls a hosted endpoint if you set `PRANIT_LAYA_BASE_URL`. **In the environment where
this was built, huggingface.co was unreachable, so the weights could not be downloaded and
Laya did not run.** The deterministic local engine answered every decision instead, and the
UI says so. Install the runtime and press *Re-detect runtime* in the Activity Center to
switch:

```bash
backend/.venv/bin/pip install laya-mnn      # ~50 ms per decision on CPU
# or: backend/.venv/bin/pip install laya    # PyTorch, ~33-38 ms on GPU
```

**Gates.** A decision acts on its own only when its calibrated gate confidence clears a
per-type threshold: `gate(type) = global_threshold × strictness(type)`, with
`global_threshold = 0.85` by default.

| Decision type | Strictness | Gate | Primitive | Used by |
| --- | --- | --- | --- | --- |
| `routing` | 0.70 | 0.595 | choice | orchestrator, before every dispatch |
| `context_relevance` | 0.65 | 0.5525 | noul + score | memory / knowledge re-ranking |
| `event_triage` | 0.65 | 0.5525 | choice + noul | event priority and notifications |
| `plan_validation` | 0.85 | 0.7225 | noul | planner, after normalisation |
| `repair_strategy` | 0.85 | 0.7225 | noul + choice | repair loop |
| `output_quality` | 0.90 | 0.765 | noul + score | orchestrator, before hand-off |
| `guardrail` | 1.00 | 0.85 | noul | agent runtime, every round |
| `risk_assessment` | 1.00 | 0.85 | noul + score | approval gate |

Guardrails and risk are deliberately never relaxed by the global threshold.

**Measured behaviour** (from `backend/tests/test_decisions.py`): routing answered 10/10
correctly on a labelled set in 0.6–1.5 ms per decision — well inside the 100 ms budget —
with clear cases returning `action: "auto"` at confidence 0.64–0.96 and deliberately vague
cases returning ≈0.14 and escalating. Every decision is persisted as a `DecisionRecord`
(type, engine, confidence, action, fallback flag, latency, state hash, answers), and the
Activity Center shows the System-1/System-2 split, the confidence distribution and a live
probe.

Soft ratings (`quality_score`, `risk_score`, `relevance_score`) are marked
`gating: false`, so an opinion never blocks a run on its own.

---

## Security model

| Concern | What is implemented |
| --- | --- |
| **Authentication** | Bearer token on every `/api` route. Only `/api/health` and `/api/setup/status` are open, and the latter exists for local first-run bootstrap. Token generated with `secrets.token_urlsafe(32)`, stored `0600`. |
| **Network exposure** | API binds `127.0.0.1`. CORS allows only localhost dev origins. The browser uses relative URLs; the dev server proxies. Nothing is published. |
| **Secrets at rest** | Provider keys encrypted with Fernet before SQLite. `PRANIT_SECRET_KEY` auto-generated into `.data/secret_key` (`0600`). |
| **Secrets in transit / logs** | `security/redact.py` strips key-shaped values from logs, audit context and error payloads; matches are replaced with `[REDACTED]`. The API never returns a key, only `has_key` + fingerprint. |
| **Zero spend** | Enforced in the provider registry, not the UI: a paid provider raises `SpendBlockedError` unless that specific run was authorised. On by default. |
| **Path safety** | `security/paths.py` resolves every path and rejects anything escaping `workspaces/` (traversal, absolute paths, symlink escape) before a tool runs. |
| **Shell policy** | Allowlist of executables (`python`, `pytest`, `pip`, `node`, `npm`, `npx`, `git`, `ls`, `cat`, `grep`, `rg`, `find`, `mkdir`, `ruff`, `mypy`, `tsc`, `bash`), hard-denied substrings (`rm`, `curl`, `wget`, `sudo`, `ssh`, `nc`, `chmod 777`, `eval`, `base64 -d`), denied path fragments (`/etc/`, `/proc/`, `/sys/`, `/dev/`), raw pipes and command substitution rejected, compound commands allowed only if every segment passes. Tokenised with `shlex`, so a quoted `;` does not split a command. |
| **Least privilege** | 23 tools in the catalogue; each agent is whitelisted for a subset, and the whitelist can only be narrowed. 3 tools are approval-gated (`delete_file`, `run_shell`, `git_push`). |
| **Approval gates** | `risk_assessment` decides; low-risk auto-approval is bounded by `low_risk_threshold`; `delete_file` and `git_push` always need a human. Decisions are recorded with a note in the audit trail. |
| **Sandbox** | Tier 1 (default): subprocess with a scrubbed environment, working directory pinned to the workspace, and wall-clock timeouts (`shell_timeout_seconds`, `task_timeout_seconds`). Tier 2: one Docker container per project when a docker CLI is present. |
| **Runaway prevention** | One orchestrator only. Bounded concurrency (`max_concurrency`, per-agent `max_parallel_tasks`), bounded rounds (`agent_tool_rounds`), bounded retries (`max_repairs`), bounded plan size (`max_plan_tasks`), and token budgets that pause a run and raise an approval instead of spending more. |
| **Audit** | Append-only `AuditRecord` rows for settings changes, approvals, deletions, provider tests, purges, uploads. `GET /api/audit` with actor/action filters. |
| **Prompt injection** | Retrieved knowledge and memory are wrapped as clearly-labelled untrusted evidence; the `guardrail` decision inspects model output and retrieved text at gate 0.85. |

---

## Configuration reference

Copy `.env.example` to `backend/.env` (done for you by `scripts/setup.sh`). Every value is
optional; the defaults are the safe ones. Full list with explanations in
[`.env.example`](.env.example).

Settings split in two layers:

* **Boot settings** (`PRANIT_*` env vars, `app/config.py`) — host/port, CORS, storage
  paths, sandbox tier, Laya mode, budgets.
* **Runtime settings** (`GET/PATCH /api/settings`, stored in the `app_settings` table) —
  zero-spend, concurrency, timeouts, repairs, decision threshold/mode, guardrail
  sensitivity, auto-approve, compact mode, default/fallback provider, token budgets.
  Changing one emits `settings.changed` and writes an audit row.

---

## Database and migrations

SQLite with WAL journaling at `.data/pranit.db` (`PRANIT_DB_URL` overrides).

* **Init** — `init_db()` runs `Base.metadata.create_all()`, which is a no-op for tables
  that already exist, then seeds the 12 agent profiles and default settings. Idempotent;
  safe on every boot.
* **Migration strategy — additive, no destructive DDL.** `migrate_schema()` inspects
  `PRAGMA table_info` and issues `ALTER TABLE … ADD COLUMN` for any column that is missing
  (this is how `DecisionRecord.action` was added). SQLite cannot drop or retype columns
  safely, so nothing in the codebase does; a removed field is simply left unused.
* **Your data** — `.data/` holds the database, the API token and the Fernet key;
  `workspaces/` holds every generated project. Both are git-ignored. Back up both
  together: without the key, stored provider keys are unreadable (re-enter them).
* **Reset** — delete `.data/` and restart, or use Settings → danger zone to purge history
  and reset memory without touching workspaces.

---

## API surface

81 HTTP routes plus `WS /ws`. Every response is JSON; every error is one envelope:

```json
{ "error": { "code": "tool_not_permitted",
             "message": "qa may not use: delete_file. Authorised tools: …",
             "context": { "agent_id": "qa", "unknown": ["delete_file"] },
             "request_id": "1b71462682db" } }
```

Every response also carries `X-Request-Id` and `X-Duration-Ms`. Interactive docs at
`/docs` while the server runs.

| Group | Highlights |
| --- | --- |
| Health / bootstrap | `GET /api/health`, `GET /api/setup/status` |
| Objectives & plans | `POST/GET /api/objectives`, `GET /api/plans`, `GET /api/plans/{id}` + `/dag` `/start` `/pause` `/resume` `/cancel` `/spend` `/report` `/checkpoints` `/budget` `/timeline` |
| Tasks | `GET /api/tasks`, `GET /api/tasks/{id}`, `/timeline`, `POST …/retry`, `POST …/reassign` |
| Approvals | `GET /api/approvals`, `POST /api/approvals/{id}/decision` |
| Agents | `GET /api/agents`, `GET/PATCH /api/agents/{id}`, `/tools` `/tasks` `/tool-calls` `/messages` `/memory` (GET+DELETE), `POST …/test-model` |
| Projects | `GET /api/projects`, `GET/DELETE /api/projects/{id}`, `/tree` `/file` `/diff` `/git/log` `/tests` `/preview[/start|/stop]` `/secrets-scan` |
| Providers | `GET/POST /api/providers`, `/kinds`, `/usage/global`, `GET/PATCH/DELETE /{id}`, `/{id}/test` `/models` `/usage` |
| Knowledge | `GET /api/knowledge`, `POST /upload`, `GET /search` `/stats`, `POST /{id}/reindex`, `DELETE /{id}` |
| Decisions | `GET /api/decisions`, `/status` `/types` `/calibration`, `POST /probe` `/status/refresh` |
| Settings | `GET/PATCH /api/settings`, `/budget`, `POST /zero-spend` `/purge` `/memory/reset` |
| Events / audit / city / runs | `GET /api/events` `/kinds` `/export` `/stream`, `GET /api/audit` `/actors`, `GET /api/city` `/city/buildings/{id}`, `GET /api/runs`, `WS /ws` |

Useful codes: `unauthorized` 401, `not_found` 404, `conflict` 409, `validation_error` 422,
`tool_not_permitted` 409, `already_decided` 409, `report_not_ready` 409,
`no_repository` 409, `unsupported_file_type` 415, `spend_blocked` 409, `policy_denied` 403.

---

## Tests

```bash
./scripts/test.sh              # everything: pytest + tsc + vitest + build
./scripts/test.sh backend      # pytest only
./scripts/test.sh frontend     # tsc + vitest + build only
```

Current status on the machine where this was written:

| Suite | Result | Time |
| --- | --- | --- |
| `backend/tests/` (pytest, 8 files) | **186 passed** | ~8.3 s |
| `frontend/src/**/*.test.ts(x)` (vitest, 7 files) | **99 passed** | ~7 s |
| `tsc -b --noEmit` | clean, 0 errors | — |
| `vite build` | 485 kB JS (141 kB gzip), 30 kB CSS | ~5 s |

Backend tests use a throwaway data directory created in `conftest.py` **before** any app
module is imported, so they never touch your real database or workspaces. They run the
real orchestrator against the offline mock provider, execute real shell commands and real
pytest inside a temp workspace, and assert on exit codes.

Frontend tests render the real components against **payloads captured from a live backend
run** (`frontend/src/test/fixtures/`, see the README there). Pure logic — city camera maths,
formatting, the HTTP client, DAG layering — is unit-tested separately.

---

## What was actually tested

Everything below was executed, not asserted by inspection.

**Boot & API (13 tests)**
- [x] App boots; `/api/health` reports version, zero-spend, auth, sandbox tier, decision engine
- [x] `/api/setup/status` reports a complete first-run picture including the local token
- [x] All 12 agent profiles seeded with the exact names from the brief
- [x] Agent detail exposes tools, output contract, status, load
- [x] New `GET /api/agents/{id}/tools` reports authorised vs granted vs revoked, marks the 3 gated tools, and 404s for an unknown agent
- [x] Error envelope shape, `X-Request-Id`, 401/404/409/422 codes

**Security (53 tests)**
- [x] Auth required on every route; wrong token rejected; open routes are only health + setup status
- [x] Path traversal, absolute paths and symlink escape blocked (`../`, `/etc/passwd`, workspace escape)
- [x] Shell policy: allowlist enforced, denied substrings, denied paths, raw pipes, command substitution, quoted `;` not splitting a command, compound commands checked segment by segment
- [x] `delete_file` and `git_push` never auto-approved
- [x] Fernet round-trip: keys encrypted at rest, only `has_key`/fingerprint returned
- [x] Redaction strips key-shaped values from logs, audit context and error payloads
- [x] Zero-spend blocks a paid provider at the registry; a free provider still works

**Decision layer (26 tests)**
- [x] Routing accuracy 10/10 on a labelled set, latency 0.6–1.5 ms (< 100 ms budget)
- [x] Confidence is separable: clear cases ≥ gate → `auto`, vague cases ≈0.14 → `escalate`
- [x] Per-type thresholds = global × strictness; guardrail and risk never relaxed
- [x] LLM fallback answers carry confidence 0.85 and are re-gated
- [x] `DecisionRecord` persisted with engine, confidence, action, latency, state hash
- [x] Laya adapter reports `available: false` with a real reason when the runtime is absent
- [x] Disabled layer → `answers: {}`, `confidence: 1.0`, `action: "auto"`
- [x] Cache applies only to routing / context_relevance / event_triage

**Planning & scheduling (21 tests)**
- [x] Heuristic plan is valid, has real outputs and verify commands
- [x] Dependency repair, cycle breaking, topological ordering
- [x] `validate_plan` rejects `ceo`/`laya` as owners, unknown agents, empty descriptions
- [x] String bullets are not split into characters; partial orders survive
- [x] Bounded concurrency and per-agent parallelism respected

**Providers & knowledge (26 tests)**
- [x] All 9 kinds register; `test` returns real `ok`, `latency_ms`, `mocked`, `is_paid`
- [x] Usage accounting per provider and globally (calls, tokens, cost, mocked count)
- [x] Upload → chunk → index → BM25 search returns the right source; stats correct
- [x] Disallowed file type → 415; empty file → 422; re-index persists raw bytes
- [x] Encrypted at rest asserted by reading the database column directly

**End-to-end (29 tests)**
- [x] Objective → plan (9 tasks) → execution → verification → delivery report, in ~2–3 s
- [x] Real files written to a real workspace; real `pytest` executed; real exit codes stored
- [x] All 4 acceptance criteria evaluated against evidence, not text similarity
- [x] Report says `delivered: false` and `used_mock_provider: true`, with limitations listed
- [x] 37 decisions recorded across 2 engines; 13 tool calls, 0 denied
- [x] Checkpoints written at task boundaries; budget snapshot correct
- [x] Spend authorisation granted then revoked per plan
- [x] **Re-verified against the live HTTP server** (not only TestClient): a run completed with 11 real files, a real git commit, and `python -m pytest -q` in that workspace passing 2 tests

**Approvals & events (14 tests)**
- [x] A gated action blocks until decided; denial is honoured; double-decide → 409
- [x] Audit row written for the decision, with secrets redacted
- [x] Event history, kinds, export, priority triage
- [x] WebSocket: auth, `ping`/`pong`, `replay since`, malformed frame → `ws.error`, thread-safe emit

**Frontend (99 tests)**
- [x] City camera maths: fit, clamp, zoom-at-cursor invariance, focus, hit-testing, districts, frame-rate-independent easing
- [x] Formatting: time, duration, bytes, compact numbers, money, tones, grouping
- [x] HTTP client: bearer header, no header when anonymous, error envelope → `ApiError`, non-JSON body, query serialisation, JSON vs FormData, token never in localStorage or a cookie
- [x] DAG layering from real `depends_on`, cycles tolerated, one edge per dependency
- [x] Delivery report renders the captured payload: "Not delivered as a real outcome", the mock warning, per-criterion verdicts, `n/a` for the task with no verification command, real metrics
- [x] Shell: exactly the ten areas, real version/sandbox tier, zero-spend badge, active-route marking, approval drawer lists a pending gate and POSTs the decision, honest empty and error states, toasts
- [x] All ten areas render against captured fixtures and call the endpoints they claim to

**Not tested / not verified here**
- [ ] A real paid provider call (no credentials in this environment). The integration code is complete and the connectivity test is real; you must supply a key.
- [ ] Laya with real weights (huggingface.co unreachable here). The adapter, mode selection and status reporting are tested; the model itself never ran.
- [ ] Sandbox tier 2 (no Docker daemon in this environment). Tier 1 is what every test exercised.
- [ ] Multi-user concurrency and long-running (hours) plans.
- [ ] Browser-level interaction tests (Playwright/Cypress). Component tests use jsdom.

---

## Known limitations

Read these before trusting an output.

1. **Laya did not run here.** The weights could not be downloaded in the build
   environment, so the deterministic local engine answered every decision. It is fast
   (0.6–1.5 ms) and calibrated by construction, but it is a rule-and-signal engine, not a
   421M-parameter model. The UI reports this; install `laya-mnn` to change it.
2. **No real model was used for the demo run.** The end-to-end evidence above comes from
   the offline mock provider, which produces stub artefacts. Expect to re-run with Ollama
   or a paid provider for real code. The pipeline, tools, verification and reporting are
   genuinely exercised; the *content* the mock writes is not.
3. **Retrieval is lexical.** Knowledge search is BM25 over chunks; there is no embedding
   model. Paraphrases will miss. The UI says "no embedding model — lexical search".
4. **PDFs need a text layer.** Without a PDF extraction dependency, a PDF is stored and
   reported as `index_status: failed` with the real reason rather than silently indexed as
   garbage.
5. **Sandbox tier 1 is not a security boundary.** It is a subprocess with resource limits,
   a scrubbed environment, path validation and a shell allowlist. A determined model with
   `run_shell` could still do damage inside the workspace. Tier 2 (Docker) is implemented
   but was never exercised here.
6. **Single-user, single-machine.** One bearer token, one SQLite file, no multi-tenancy,
   no horizontal scaling. That is the point, but it is a limit.
7. **The planner's quality is your provider's quality.** With a small local model, plans
   can be shallow; the heuristic fallback is marked `heuristic: true` in the UI so you can
   tell.
8. **Verification is only as good as the verify commands.** A task with no automated check
   is accepted on its output contract alone, and the report says so in its limitations
   (the captured run had exactly one such task).
9. **Python 3.11, not 3.12+.** The environment had 3.11.2, so `requires-python` is
   `>=3.11` and no 3.12-only syntax is used. 3.12/3.13 work.
10. **The city is Canvas 2D, not a game engine.** No physics, no collision, no zoom beyond
    2.5×. It is a state visualisation, deliberately.
11. **No offline model bundling.** Ollama and its models are installed separately.

---

## Repository layout

```
idea/
├── README.md                  ← this file
├── MASTER_PLAN.md             ← the build plan, and what became of each item
├── .env.example               ← every setting, documented, no secrets
├── docker-compose.yml         ← optional containerised run
├── scripts/
│   ├── setup.sh               ← Ubuntu install (idempotent)
│   ├── dev.sh                 ← backend + frontend, one Ctrl-C
│   └── test.sh                ← every automated check + summary
├── backend/
│   ├── requirements.txt       ← runtime + test dependencies
│   ├── pyproject.toml
│   ├── app/                   ← the FastAPI application (see module map)
│   └── tests/                 ← 186 tests, 8 files
├── frontend/
│   ├── package.json           ← Vite 6, React 19, TS 5.7, Tailwind 4, vitest 3
│   ├── vite.config.ts         ← proxies /api and /ws; binds 0.0.0.0
│   └── src/
│       ├── api/client.ts      ← the only HTTP client
│       ├── live/stream.ts     ← WebSocket → SSE → polling
│       ├── store/app.ts       ← cross-cutting client state
│       ├── city/              ← camera maths + Canvas 2D renderer
│       ├── components/        ← shell, UI primitives, DAG, task detail, report
│       ├── areas/             ← the ten screens
│       └── test/fixtures/     ← payloads captured from a real run
├── docs/
│   ├── decisions/ADR-*.md     ← why the stack looks like this
│   ├── APK.md                 ← legacy IdeaForge Android build
│   └── legacy-ideaforge.md    ← the previous root README, preserved
├── .data/                     ← generated: SQLite, api_token, secret_key (git-ignored)
└── workspaces/                ← generated: one directory per project (git-ignored)
```

The root `src/`, `index.html`, `package.json`, `vite.config.ts`, `capacitor.config.ts`
and `public/` belong to the **legacy IdeaForge** app and are untouched. See
[`docs/legacy-ideaforge.md`](docs/legacy-ideaforge.md).

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| UI shows "The frontend cannot reach the backend" | The API is not running. `./scripts/dev.sh`, or start uvicorn manually. The dev server proxies to `http://127.0.0.1:8000` (`PRANIT_BACKEND` overrides). |
| 401 on every call | Token mismatch. Read `backend/.data/api_token`, or use Settings → API token → Copy. The browser keeps it in memory, so a page reload re-fetches it. |
| "No provider configured" / plan is `heuristic` | Add Ollama or the mock provider, then set it as default. Readiness checklist tells you which part is missing. |
| `spend_blocked` (409) | Zero-spend is on and the provider is marked paid. Either mark it free (it is local), authorise spend for that run, or turn zero-spend off. |
| `policy_denied` (403) on a shell command | The command is not on the allowlist, contains a denied substring (`rm`, `curl`, `sudo`…), uses a raw pipe or touches a denied path. Reword it; the denial reason is shown verbatim in the Agent Workspace. |
| A task sits in `blocked` | An approval gate is waiting. Open the approvals drawer (top right). With `approval_timeout_seconds: 0` it waits for you indefinitely. |
| Run pauses with a budget reason | A token budget was hit. The Command Center offers *Grant budget approval*, which resolves the pending gate. |
| Laya shows "not available" | Expected unless you installed `laya` / `laya-mnn` or set `PRANIT_LAYA_BASE_URL`. Press *Re-detect runtime* after installing. |
| `no_repository` (409) on the diff tab | The workspace has no git repo yet; the version-control task has not run. |
| Port 5173 busy | `PORT=5174 ./scripts/dev.sh`. |
| Tests fail with "no module named pytest" | You are using the system python. Use `backend/.venv/bin/python -m pytest`, or `./scripts/test.sh`. |

---

## License and provenance

Built as a single-product repository. Laya is © Convai Innovations, Apache-2.0, and is an
optional runtime dependency — it is not vendored here. All other code in `backend/` and
`frontend/` is original.
