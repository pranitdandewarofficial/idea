# Frontend test fixtures

Every `.json` file here is a **real response captured from the running backend**,
not a hand-written stub. They were produced by executing the same end-to-end run
the backend test suite performs (`backend/tests/test_06_e2e_run.py`): an objective
is submitted, the orchestrator plans it, eleven agents execute real tools in a real
workspace, verification commands really run, and the delivery report is generated
from that evidence. The payloads were then written out verbatim.

Two adjustments were made, both mechanical and both recorded inside the file:

1. Long lists were shortened to their first N items (`plan-timeline`, `decisions`,
   `task-timeline`, `plan-checkpoints`). Those files carry a `_note` field saying so.
2. Nothing else. Field names, values, timestamps and error envelopes are untouched.

## Why the fixtures matter

The product rule is *if the UI shows it, the backend really did it*. A screen test
written against invented data cannot enforce that rule; a screen test written
against a captured payload can. `src/areas/areas.test.tsx` asserts, for example:

- the delivery report renders **"Not delivered as a real outcome"** because the
  captured run used the offline mock provider (`used_mock_provider: true`);
- the QA agent's whitelist shows **11 granted of 11 authorised** tools out of a
  23-tool catalogue;
- the decision layer reports the **local** engine with Laya unavailable and the
  real reason string, plus the actual escalation rate (42.5%);
- the secret scan reports a genuinely clean workspace.

## Regenerating them

The capture is a throwaway pytest module: set up the mock provider, run one
objective to a terminal state, then `json.dump` each endpoint you care about into
this directory. Keep the file names in sync with the routing table in
`src/test/fixtures.ts`.

## Provenance of the run

| Fact | Value |
| --- | --- |
| Provider | offline mock (`kind: "mock"`, `mocked: true` on every call) |
| Plan state | `complete` |
| Tasks | 9 completed, 0 failed |
| Tool calls | 13 executed, 0 denied |
| Decisions | 37 recorded (30 local engine, 7 escalated to the LLM fallback) |
| Files written | 11 in `workspaces/fixture-demo` |
| `delivered` | `false` — correctly, because the provider was mocked |
