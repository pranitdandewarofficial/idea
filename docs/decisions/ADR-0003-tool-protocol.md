# ADR-0003 — A fenced text tool protocol instead of provider-native function calling

**Status:** accepted · **Date:** 2026-10 · **Deciders:** founder + build agent
**Referenced from:** `backend/app/protocol.py`

## Context

Eleven agents must call 23 tools through nine provider kinds: OpenAI, OpenAI-compatible
(OpenRouter, LM Studio, vLLM), Anthropic, Gemini, Ollama, generic HTTP, and an offline
mock. Every provider has a *different* function-calling dialect — different schemas,
different tool-result message shapes, different streaming rules, and small local models
often ignore tool schemas entirely or emit malformed arguments.

The product also has to be testable with **no network at all**.

## Decision

Define one provider-neutral text protocol in `app/protocol.py` and parse it ourselves:

```
# PRANIT/AGENT <agent_id> v1        ← preamble, states the contract for this agent
…task, evidence, allowed tools with JSON schemas…

```tool                            ← the model emits fenced calls
{"tool": "write_file", "args": {"path": "src/app.py", "content": "…"}}
```

FINAL: …                           ← the terminal answer, validated against the output contract
```

Three preambles exist: `# PRANIT/PLANNER v1` (plan JSON), `# PRANIT/AGENT <id> v1` (tool
rounds) and `# PRANIT/DECISION v1` (typed decision answers).

## Reasons

1. **One code path for nine providers.** Adapters only have to turn
   `(system, user, max_tokens, temperature)` into text and return text. Adding a provider
   is ~100 lines, not a re-implementation of tool plumbing.
2. **Local models actually work.** An 8B model on Ollama frequently drops or corrupts
   native tool-call structures. A fenced JSON block inside ordinary prose is the most
   robust thing you can ask a small model for, and malformed fences degrade into "no tool
   call this round" rather than a crash.
3. **The protocol is inspectable.** Every prompt and every reply is stored verbatim in the
   `messages` table and shown in the Agent Workspace. With native function calling, half
   the conversation lives in provider-specific structures that are awkward to persist and
   display honestly.
4. **Offline determinism.** The mock provider is a text generator. Because the protocol is
   text, the mock can drive the *entire* real pipeline — planning, tool execution,
   verification, repair, reporting — with no network. That is what makes 186 backend tests
   run in ~8 seconds.
5. **Policy sits between the parse and the execution.** We control the exact moment a
   parsed call meets `tools/policy.py`, so allowlist/denylist/approval checks cannot be
   bypassed by a provider-side optimisation.
6. **Versioned and explicit.** The `v1` marker means a future protocol change can be
   rolled out without silently misreading stored transcripts.

## Consequences

* We own the parser, including its failure modes: unterminated fences, JSON with trailing
  commas, multiple calls in one round, a `FINAL:` that arrives with pending calls. All are
  handled and tested.
* Token overhead is higher than native tool calling — the tool schemas are in the prompt.
  Mitigated by sending only the agent's whitelisted tools with compact schemas, and by
  `decision_max_state_chars`-style truncation elsewhere.
* No provider-side parallel tool execution or server-enforced schema validation. Our
  `validate_contract` step is stricter anyway: a `diff_summary` with no real
  `files_changed`, or a `test_report` with no executed test command, is rejected.
* Streaming token-by-token into the UI is not implemented for agent rounds; the transcript
  appears per round. Acceptable for a task-oriented console, and honest about it.

## Alternatives considered

* **Native function calling everywhere** — best token efficiency and schema enforcement on
  the big providers, but nine dialects, brittle small-model behaviour, and no offline path.
* **MCP (Model Context Protocol)** — the right answer for exposing *our* tools to *other*
  clients, and a plausible future addition; it does not remove the need for a
  provider-neutral agent loop, and adopting it now would have meant an external dependency
  for something we can parse in 100 lines.
* **ReAct-style free text (`Action: …`)** — weaker structure, harder to validate, more
  prone to hallucinated tool names.
* **XML tags** — comparable robustness; fenced code blocks were chosen because small models
  reproduce markdown fences more reliably than nested XML.
