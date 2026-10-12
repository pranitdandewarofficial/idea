# ADR-0004 — Decision layer: optional Laya adapter with a deterministic local engine

**Status:** accepted · **Date:** 2026-10 · **Deciders:** founder + build agent
**Referenced from:** `backend/app/api/routes_decisions.py` (the `/calibration` note)

## Context

Most decisions in an autonomous company are not generative. *Which agent should own this
task? Is this plan structurally sound? Is this output good enough to hand downstream? Is
this failure repairable, and how? Does this text contain an injection? Does this action
need a human? How important is this event? Is this retrieved chunk relevant?*

Answering those with a large language model is slow (hundreds of milliseconds to seconds),
costs money, and produces an uncalibrated yes/no dressed up as prose. The brief asked for a
**System 1** layer: a local decision model answering typed questions with calibrated
probabilities in under 100 ms, with an LLM as **System 2** fallback.

Laya (Convai Innovations, Apache-2.0) is exactly that: a 421M-parameter,
non-autoregressive decision model on a ModernBERT-large backbone, trained with RLCD so its
probabilities are calibrated. It returns typed answers rather than text — `choice`
(categorical with per-option probabilities), `score` (ordinal rubric expected value) and
`noul` (a calibrated boolean, P(true)). Roughly 33–38 ms on GPU, ~50 ms on CPU via
`laya-mnn`, ~850 MB of weights, and a 512-token state limit.

**The blocking fact:** the build environment could reach `github.com`, `pypi.org` and
`registry.npmjs.org` only. `huggingface.co` was unreachable, so the weights could not be
downloaded and Laya could not be run here. Pretending otherwise would violate the product's
central rule.

## Decision

Build the decision layer as a **provider-neutral service with two engines**:

1. `decisions/laya_adapter.py` — detects `laya` or `laya-mnn` at runtime (or a hosted
   endpoint via `PRANIT_LAYA_BASE_URL`), warms it up, and reports its true status:
   `mode`, `available`, `reason`, `version`, `latency_ms`, `checked_at`.
2. `decisions/local_engine.py` — a deterministic engine that answers the same typed
   questions from explicit signals (keyword and structural evidence, roster margins,
   policy verdicts, priors), producing a probability **and** a confidence.

`decisions/router.py` computes a per-type gate, `decisions/service.py` answers, caches and
persists, and `decisions/llm_fallback.py` escalates to System 2 when the gate is missed.
`decision_mode` selects the engine: `auto | laya | laya_mnn | laya_hosted | local | llm`.

**Calibration is a gate, not a vibe.** Every question carries `gating: bool`. A decision
acts on its own only when `gate_confidence ≥ threshold_for(type)`, where

```
threshold_for(type) = decision_confidence_threshold × TYPE_STRICTNESS[type]
```

| type | strictness | gate @ 0.85 | why |
| --- | --- | --- | --- |
| `routing` | 0.70 | 0.595 | a wrong owner is recoverable — the repair loop reassigns |
| `context_relevance` | 0.65 | 0.5525 | advisory re-ranking |
| `event_triage` | 0.65 | 0.5525 | cosmetic priority |
| `plan_validation` | 0.85 | 0.7225 | structural checks already ran; this is the semantic layer |
| `repair_strategy` | 0.85 | 0.7225 | bounded by `max_repairs` |
| `output_quality` | 0.90 | 0.765 | gates what enters the next task's context |
| `guardrail` | 1.00 | 0.85 | safety is never discounted |
| `risk_assessment` | 1.00 | 0.85 | decides whether a human must click |

Advisory sub-answers (`quality_score`, `risk_score`, `relevance_score`) are
`gating: false`, so an opinion can never block a run by itself.

## Reasons

1. **The product must work with no download and no network.** A hard Laya dependency would
   have made the whole decision layer unusable in the environment where it was built, and
   in any air-gapped install.
2. **Honesty is enforceable this way.** `GET /api/decisions/status` returns the adapter's
   real reason string; the UI prints it verbatim ("Laya runtime not installed … using the
   deterministic local decision engine"). Every `DecisionRecord` stores which engine
   answered, so the Activity Center can show a 30-local / 7-LLM split for a real run.
3. **The interface is the valuable part.** `Question{id, type, instructions, criteria,
   hints, gating}` → `Answer{value, probability, probabilities, confidence}` →
   `DecisionResult{engine, confidence, gate_confidence, action, fallback_used, latency_ms,
   state_hash}`. Swapping the local engine for Laya changes nothing upstream; the eight
   presets (`routing`, `plan_validation`, `output_quality`, `repair_strategy`,
   `guardrails`, `risk_assessment`, `event_triage`, `context_relevance`) are already typed.
4. **Latency budget is met either way.** The local engine measured 0.6–1.5 ms per routing
   decision, an order of magnitude inside the 100 ms requirement; `laya-mnn` would be
   ~50 ms. Both fit.
5. **The LLM fallback stays gated.** Its answers arrive with confidence 0.85 and are
   re-evaluated against the same gate, so escalation cannot become a way to bypass a
   safety threshold.
6. **Caching where it is safe.** Only `routing`, `context_relevance` and `event_triage` are
   cached (120 s, keyed by `state_hash`); guardrail, risk and quality decisions are never
   cached.

## Consequences

* **Laya never ran here.** This is recorded in the README's limitation list and in the
  verification matrix. The adapter, mode selection, warm-up and status reporting are
  tested; the model itself is not.
* The local engine's confidence comes from signal margins and priors, not from RLCD. It is
  *separable* — 10/10 correct on a labelled routing set, clear cases at 0.64–0.96 and
  deliberately vague cases at ≈0.14 — but its calibration curve is not comparable to a
  trained model's. `/api/decisions/calibration` therefore returns the confidence
  distribution plus a note saying accuracy-vs-confidence calibration needs a labelled set,
  instead of implying a number we did not measure.
* Two engines to maintain. Mitigated by the shared typed schema and by presets that build
  questions once.
* The `state_hash` in every record makes engine swaps auditable: you can compare decisions
  before and after installing Laya.

## How to switch on the real thing

```bash
backend/.venv/bin/pip install laya-mnn        # ~850 MB of weights on first use
# or  backend/.venv/bin/pip install laya      # PyTorch runtime
# or  PRANIT_LAYA_BASE_URL=… PRANIT_LAYA_API_KEY=… for a hosted endpoint
# then set decision_mode = laya_mnn (or leave `auto`) in Settings
```

Press **Re-detect runtime** in Activity Center → Decision log
(`POST /api/decisions/status/refresh`); the status card reports the measured latency or the
real failure.

## Alternatives considered

* **Laya as a hard dependency** — rejected: unrunnable in this environment and in any
  offline install.
* **LLM for every decision** — rejected: slow, paid, uncalibrated, and it collapses the
  System 1 / System 2 distinction the brief asks for.
* **Pure `if/else` rules with no confidence** — this is what most agent frameworks do. It
  cannot express "I am not sure", so it cannot escalate, and it cannot be tuned. The local
  engine keeps the rules but adds a calibrated-shaped confidence and a gate.
* **A small classifier we train ourselves** — no labelled corpus, and it would have delayed
  everything else. The `DecisionRecord` history this design produces *is* the corpus for
  doing that later.
