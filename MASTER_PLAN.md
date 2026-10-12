# MASTER PLAN — PRANIT AI CITY

This is the plan the build followed, and an honest record of what became of each part.
It is kept next to the code so the reasoning survives the implementation.

**Status: built, running, tested.** Backend 186 tests, frontend 99 tests, production build
clean, one full end-to-end run verified against the live HTTP server. See
[README.md](README.md#what-was-actually-tested) for the evidence and
[README.md](README.md#known-limitations) for what is still weak.

---

## 1. The product in one paragraph

A local-first autonomous AI company. The Founder states an objective in natural language.
One Orchestrator (CEO) produces a dependency-aware plan, assigns tasks to eleven
specialists, and those specialists execute real tools — filesystem, shell, git, test
runner, dev server — inside a sandboxed workspace. Failures are diagnosed and repaired
within bounded retries. The result is a runnable project plus a delivery report derived
only from executed evidence. The company is visualised as a living 2D city whose state is
the database, not an animation.

**Non-negotiable rule:** if the UI shows it, the backend did it. No fake controls, no
decorative progress, no invented results. Where something could not be done, the interface
states what is missing and how to supply it.

---

## 2. Constraints taken from the brief

| Constraint | How it is enforced in code |
| --- | --- |
| One authoritative orchestrator | `orchestrator/orchestrator.py` owns the only run loop; `validate_plan` rejects `ceo`/`laya` as task owners; `WORKER_IDS` excludes them |
| No runaway spend | Zero-spend enforced in `providers/registry.py`; per-plan and global token budgets pause a run and raise an approval |
| No infinite agent chat | `agent_tool_rounds` bounds rounds; `max_repairs` bounds retries; task and shell timeouts bound wall clock |
| Least privilege | 23-tool catalogue, per-agent whitelist, whitelist can only be narrowed (409 otherwise) |
| Workspace-scoped paths | `security/paths.py` resolves and rejects escapes before execution |
| Shell allowlist | `tools/policy.py`, `shlex`-tokenised, denylist substrings/paths, no raw pipes or command substitution |
| Approval gates | `orchestrator/approvals.py` + `risk_assessment` decision; `delete_file`/`git_push` never auto-approved |
| Append-only audit | `AuditRecord` rows, never updated or deleted by application code |
| Secrets server-side only | Fernet at rest; `has_key`/fingerprint out; `security/redact.py` on logs, audit and errors |
| Localhost only | `PRANIT_HOST=127.0.0.1`, CORS limited to local dev origins, browser uses relative URLs |
| Mock providers flagged | `mocked: true` on every completion; report sets `used_mock_provider` and forces `delivered: false` |
| Premium, art-directed UI | Light-first neutral canvas, one indigo accent, Inter + JetBrains Mono, one shadow tier, no gradients/glow/emoji, `prefers-reduced-motion` honoured |

---

## 3. Phases

### Phase 0 — Decisions before code
Recorded as ADRs in [`docs/decisions/`](docs/decisions/): Vite over Next.js, Canvas 2D over
PixiJS, a fenced tool protocol over provider-native function calling, Laya as an optional
adapter with a deterministic local engine as the default, Python 3.11 as the floor,
additive-only SQLite migrations.

### Phase 1 — Backend spine
Config, database, models, error envelope, auth, path safety, crypto, redaction, event bus,
health and setup-status endpoints. **Done.** 81 HTTP routes + `/ws`.

### Phase 2 — Tools and policy
`fs`, `shell`, `vcs`, `servers`, the tool registry and the policy layer, with a
`ToolContext` that pins every operation to one workspace. **Done.** 23 tools, 3 gated.

### Phase 3 — Providers
Registry with pick/complete/usage, zero-spend enforcement, rate limiting, concurrency
semaphore, retries, and adapters for Anthropic, Gemini, Ollama, OpenAI-compatible
(OpenAI/OpenRouter/LM Studio/vLLM), generic HTTP and the offline mock. **Done.** Paid
adapters are complete but were never called with real credentials here.

### Phase 4 — Agents
Twelve profiles with charters and output contracts; a runtime that sends the protocol
preamble, recalled memory and retrieved knowledge, loops tool rounds, guards every round,
and validates the output contract against hard evidence. **Done.**

### Phase 5 — Orchestrator
Planner (normalise, repair dependencies, break cycles, topological order, validate),
scheduler (bounded concurrency, readiness by dependency), budget guard, checkpoints,
approval gate, verifier (execute verify commands, evaluate acceptance criteria against
evidence), repair loop, reporter. **Done.**

### Phase 6 — Decision layer
Typed questions (`choice`, `score`, `noul`), eight presets wired into the real code paths,
a router with per-type strictness, the Laya adapter with runtime auto-detection, a
deterministic local engine, an LLM fallback that is re-gated, persisted `DecisionRecord`s,
calibration endpoint, live probe. **Done**, with the honest caveat that Laya itself never
ran in this environment.

### Phase 7 — Knowledge and memory
Ingest, chunking, BM25 search, evidence formatting; agent/project/company scoped memory
with weights and recall. **Done.** Retrieval is lexical; no embedding model.

### Phase 8 — API surface and city payload
All routers, the city projection (`GET /api/city`) built from live database state, event
streaming with three transports. **Done.**

### Phase 9 — Frontend
Client, live stream, store, city camera maths and Canvas 2D renderer, UI primitives, shell
with navigation/approvals/toasts, then the ten areas. **Done.**

### Phase 10 — Tests
Backend suites boot/security/decisions/planning/providers+knowledge/e2e/approvals+events;
frontend unit tests for pure logic and component tests against captured payloads.
**Done.** 186 + 99.

### Phase 11 — Docs and delivery
README, `.env.example`, `docker-compose.yml`, scripts, ADRs, this plan, the "what was
actually tested" checklist. **Done.**

---

## 4. Verification matrix

Every row was exercised by an automated test or by a live request against the running
server. The right-hand column says where.

| Requirement | Status | Evidence |
| --- | --- | --- |
| Ten UI areas, all functional | ✅ | `frontend/src/areas/*`, `areas.test.tsx` (32 tests) |
| Eleven named specialists + CEO | ✅ | `agents/profiles.py`; `test_01::test_every_agent_profile_is_seeded` asserts all twelve names |
| Natural-language objective → plan | ✅ | `POST /api/objectives`; `test_04`, `test_06` |
| Dependency-aware DAG | ✅ | `planner.normalise_plan`, `dagLayers`; `test_04`, `PlanDag.test.tsx` |
| Real filesystem/shell/git/test execution | ✅ | `tools/*`; `test_02` (53 policy tests), `test_06` |
| Real files in a real workspace | ✅ | `workspaces/live-preview-demo` — 11 files, real git commit |
| Real test execution with exit codes | ✅ | `test_06`; re-verified manually: `pytest -q` → 2 passed |
| Failure repair within bounds | ✅ | `repair.py` + `repair_strategy` decision; `test_04`, `test_decisions` |
| Delivery report from evidence only | ✅ | `reporter.py`; `test_06`, `DeliveryReport.test.tsx` |
| Mock run never labelled a delivery | ✅ | `delivered: false`, `used_mock_provider: true` in the captured report |
| Living city reflects real state | ✅ | `city.py`; `GET /api/city` fixture; `CityArea` tests |
| Approval gates block until decided | ✅ | `test_07` (blocks, denial, double-decide 409) |
| Append-only audit with redaction | ✅ | `test_07`, `test_02` |
| Zero-spend default, per-run authorisation | ✅ | `test_02`, `test_05`, `test_06` (grant then revoke) |
| Secrets encrypted, never returned | ✅ | `test_05` reads the encrypted column directly |
| Localhost-only binding | ✅ | `config.py`; live server bound to 127.0.0.1 |
| Bounded concurrency/retries/tokens | ✅ | `test_04`, `test_06` budget snapshot |
| Local decision model, < 100 ms | ✅ | 0.6–1.5 ms measured; `test_decisions` |
| Calibrated confidence ≥ 0.85 gate | ✅ | per-type gates; `test_decisions::test_confidence_is_separable` |
| LLM fallback when unsure | ✅ | `llm_fallback.py`, re-gated at 0.85; `test_decisions` |
| Persisted DecisionRecord | ✅ | `test_decisions`, `test_06` (37 records, 2 engines) |
| System 1 / System 2 split visible in UI | ✅ | Activity Center → Decision log; `areas.test.tsx` |
| Laya running locally with real weights | ❌ | huggingface.co unreachable in the build environment; adapter reports `available: false` with the reason |
| Real paid provider call | ❌ | No credentials available; integration complete, connectivity test real |
| Sandbox tier 2 (Docker) | ❌ | No Docker daemon in the build environment; tier 1 exercised everywhere |

---

## 5. What changed while building (and why)

* **`meets_criteria` had to stop guessing.** The first output-quality check compared the
  task summary against the done-criteria by word overlap and rejected honest, verified work
  (coverage 0.0–0.33 on real tasks). It now takes hard evidence — verified checks and real
  `files_changed` — as a structural hint that dominates the lexical signal.
* **Soft ratings must not gate.** Taking the minimum confidence across all answers let one
  advisory score escalate every decision. Ratings are now `gating: false` and the gate uses
  `gate_confidence`.
* **`agent_roster` in the routing state destroyed the margin signal.** Removing it took
  routing from marginal to 10/10 with clear separation.
* **Shell classification had to be token-aware.** A quoted `;` inside an argument used to
  split a command; `classify_shell` now tokenises with `shlex` and checks every segment.
* **Mock round detection had to be state-based.** The runtime replaces the conversation each
  round, so counting occurrences of a marker never worked; the mock now infers its stage
  from what is already in the workspace.
* **Two real bugs found by tests, not by reading:** `models.get_setting` had a
  `NameError` (missing `session_scope` import), and `routes_projects.py` had lost a
  `ToolContext` import, which made the entire projects API return 500.
* **The frontend `Stat` component rendered its own label twice** (once as a label, once as
  a tone badge). Caught by a text query in the area tests; the tone now colours the value.
* **`clearTimers()` never cleared the polling timer**, so the SSE/polling fallback kept
  running after `stop()`. Caught while writing the stream tests.

---

## 6. Deliberately not built

* No user accounts, roles or multi-tenancy — single local founder.
* No cloud sync, telemetry or update check.
* No embedding-based retrieval — BM25 only, and the UI says so.
* No agent-to-agent free chat — agents communicate through tasks and stored artefacts,
  because an unbounded chat loop is exactly the runaway the brief forbids.
* No game-engine city — Canvas 2D, state-driven, 0.4–2.5× zoom.
* No auto-publishing or deployment. `git_push` and deploy-shaped commands always need a
  human.
