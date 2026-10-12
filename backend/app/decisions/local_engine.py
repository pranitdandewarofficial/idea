"""Deterministic local decision engine (System 1 fallback).

This engine answers the same three primitives as Laya (``choice`` / ``score`` /
``noul``) without any model weights.  It is a **transparent lexical + structural
scorer**, not a trained classifier:

* ``hints["structural"]`` (a hard fact computed by ordinary code, in ``[-1, 1]``)
  always dominates the answer,
* ``hints["evidence_ratio"]`` (a caller-computed coverage fraction) is mapped
  through a logistic curve,
* otherwise keyword evidence from the state text is weighed against per-question
  lexicons.

Because it contains no sampling, the same state always produces the same answer,
which makes the orchestrator's decision layer unit-testable.  Probabilities it
returns are *heuristic* confidences and are labelled as such in the UI; only a
real Laya runtime produces ML-calibrated probabilities.
"""

from __future__ import annotations

import math
import re
from typing import Any

from .schemas import Answer, Question

STOPWORDS = frozenset(
    """a an the and or but if then else of to in on for with without from into over under is are was were be
    been being do does did done have has had having this that these those it its as at by we you they i not no
    yes please should would could can may might must will shall about after before between each every any all
    some more most other another such only own same so than too very just now here there when where why how
    what which who whom whose""".split()
)

#: Domain terms keyed by the label most routing questions use.
DOMAIN_TERMS: dict[str, tuple[str, ...]] = {
    "pm": ("requirement", "requirements", "user", "story", "stories", "acceptance", "criteria", "scope",
           "priority", "stakeholder", "mvp", "spec", "specification", "roadmap", "backlog", "tradeoff"),
    "product": ("requirement", "requirements", "user", "story", "acceptance", "criteria", "scope", "mvp"),
    "architect": ("architecture", "module", "modules", "schema", "contract", "interface", "boundary",
                  "data", "model", "dependency", "dependencies", "pattern", "layer", "layers", "design"),
    "designer": ("design", "layout", "mockup", "wireframe", "figma", "color", "colour", "typography",
                 "spacing", "hierarchy", "ux", "ui", "accessibility", "contrast", "motion", "style"),
    "frontend": ("frontend", "front-end", "react", "next", "nextjs", "component", "components", "page",
                 "pages", "css", "tailwind", "browser", "client", "route", "router", "hook", "vite",
                 "typescript", "tsx", "jsx", "html", "canvas", "ui"),
    "backend": ("backend", "back-end", "api", "endpoint", "endpoints", "fastapi", "flask", "django",
                "database", "sql", "postgres", "postgresql", "sqlite", "server", "rest", "graphql",
                "migration", "orm", "sqlalchemy", "pydantic", "route", "handler", "service", "python"),
    "qa": ("test", "tests", "testing", "pytest", "jest", "vitest", "qa", "bug", "defect", "regression",
           "coverage", "assertion", "assertions", "e2e", "playwright", "verify", "verification",
           "reproduce", "failing", "failure"),
    "security": ("security", "vulnerability", "vulnerabilities", "cve", "injection", "xss", "csrf",
                 "secret", "secrets", "audit", "owasp", "traversal", "permission", "authentication",
                 "authorization", "threat", "exploit", "sanitise", "sanitize", "validate"),
    "devops": ("docker", "container", "ci", "cd", "deploy", "deployment", "kubernetes", "actions",
               "terraform", "nginx", "env", "environment", "pipeline", "infra", "infrastructure",
               "compose", "build", "release", "script", "scripts"),
    "docs": ("readme", "documentation", "docs", "doc", "guide", "tutorial", "reference", "changelog",
             "adr", "explain", "instructions", "manual", "comment", "comments"),
    "research": ("research", "investigate", "compare", "comparison", "benchmark", "literature", "survey",
                 "analysis", "evidence", "findings", "evaluate", "options", "alternatives"),
}

INJECTION_TERMS = (
    "ignore previous", "ignore all previous", "disregard", "forget your instructions", "new instructions",
    "you are now", "system prompt", "reveal your prompt", "override", "jailbreak", "developer mode",
    "</system>", "<system>", "act as root", "sudo", "rm -rf", "curl | sh", "curl|bash", "eval(",
    "base64 -d", "exec(", "__import__",
)

DESTRUCTIVE_TERMS = (
    "rm -rf", "rmdir", "delete all", "drop table", "truncate", "force push", "--force", "git reset --hard",
    "shutdown", "reboot", "format", "destroy", "wipe", "remove directory", "chmod 777", "mkfs",
    "kill -9", "uninstall",
)

REPAIRABLE_TERMS = (
    "syntaxerror", "indentationerror", "nameerror", "attributeerror", "typeerror", "importerror",
    "modulenotfounderror", "keyerror", "assertionerror", "assert", "typo", "undefined", "not defined",
    "missing", "expected", "unexpected token", "cannot find module", "enoent", "traceback", "failed test",
    "1 failed", "2 failed", "compile", "lint", "unresolved reference", "nullpointer", "runtimeerror",
)

FATAL_TERMS = (
    "permission denied", "quota exceeded", "rate limit", "429", "401 unauthorized", "403 forbidden",
    "invalid api key", "authentication failed", "network is unreachable", "connection refused",
    "no space left", "out of memory", "killed", "segfault", "budget exceeded", "provider unavailable",
    "model not found", "account suspended",
)

VAGUE_TERMS = (
    "etc", "and so on", "stuff", "things", "somehow", "maybe", "appropriate", "as needed", "optimize",
    "improve", "make it better", "nice", "good", "whatever",
)

CONCRETE_TERMS = (
    "endpoint", "file", "function", "class", "route", "table", "column", "test", "component", "api",
    "schema", "create", "implement", "add", "remove", "rename", "return", "accept", "reject", "port",
    "path", "config", "migration", "script",
)

_WORD_RE = re.compile(r"[a-z0-9_][a-z0-9_\-\.]*")


def tokenize(text: str) -> set[str]:
    if not text:
        return set()
    lowered = text.lower()
    return {w for w in _WORD_RE.findall(lowered) if w not in STOPWORDS and len(w) > 1}


def _logistic(x: float, slope: float = 6.0) -> float:
    return 1.0 / (1.0 + math.exp(-slope * x))


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def state_text(state: dict[str, Any] | str) -> str:
    from .schemas import state_to_text

    return state_to_text(state)


def _overlap(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / math.sqrt(len(a) * len(b))


def _term_hits(text_lower: str, terms: tuple[str, ...] | list[str]) -> int:
    return sum(1 for t in terms if t in text_lower)


# --------------------------------------------------------------------------- #
# choice
# --------------------------------------------------------------------------- #
def answer_choice(question: Question, state: dict[str, Any] | str) -> Answer:
    text = state_text(state)
    lowered = text.lower()
    tokens = tokenize(text)
    criteria = question.criteria if isinstance(question.criteria, dict) else {}
    if not criteria:
        labels = question.criteria if isinstance(question.criteria, list) else []
        criteria = {str(x): "" for x in labels}
    if not criteria:
        return Answer(question_id=question.id, type="choice", value=None, confidence=0.0,
                      probabilities={})

    scores: dict[str, float] = {}
    for label, description in criteria.items():
        key = label.lower()
        raw = 0.0
        # 1. term overlap with the label's own description
        raw += 2.0 * _overlap(tokens, tokenize(f"{label} {description}"))
        # 2. built-in domain lexicon when the label looks like a known role
        for domain, terms in DOMAIN_TERMS.items():
            if domain in key:
                raw += 0.35 * _term_hits(lowered, terms)
        # 3. literal label mention
        if key and key.replace("_", " ") in lowered:
            raw += 0.8
        if key and key in tokens:
            raw += 0.6
        # 4. caller prior
        if label in question.hints:
            raw += 2.0 * float(question.hints[label])
        scores[label] = raw

    structural = question.hints.get("_structural")
    if isinstance(structural, dict):
        for label, weight in structural.items():
            scores[label] = scores.get(label, 0.0) + 6.0 * float(weight)

    total = sum(math.exp(min(s, 20.0)) for s in scores.values()) or 1.0
    probabilities = {label: math.exp(min(s, 20.0)) / total for label, s in scores.items()}
    best = max(probabilities.items(), key=lambda kv: kv[1])
    ordered = sorted(probabilities.values(), reverse=True)
    margin = best[1] - (ordered[1] if len(ordered) > 1 else 0.0)

    # Confidence is driven by the *raw evidence margin* over the runner-up, both in
    # absolute terms and relative to the winner's own evidence.  Softmax mass alone
    # is a poor confidence signal for wide label sets: with ten candidates even a
    # decisive winner only reaches ~0.4 of the distribution.
    raw = sorted(scores.values(), reverse=True)
    top_raw = raw[0]
    second_raw = raw[1] if len(raw) > 1 else 0.0
    raw_margin = max(0.0, top_raw - second_raw)
    relative_margin = (raw_margin / top_raw) if top_raw > 1e-6 else 0.0
    evidence = (
        0.55 * _logistic(relative_margin - 0.28, slope=8.0)
        + 0.45 * _logistic(raw_margin - 0.70, slope=2.8)
    )
    confidence = _clamp(0.82 * evidence + 0.18 * min(1.0, best[1] * 2.2))
    return Answer(
        question_id=question.id,
        type="choice",
        value=best[0],
        probability=round(best[1], 4),
        probabilities={k: round(v, 4) for k, v in probabilities.items()},
        confidence=round(confidence, 4),
    )


# --------------------------------------------------------------------------- #
# noul
# --------------------------------------------------------------------------- #
def answer_noul(question: Question, state: dict[str, Any] | str) -> Answer:
    text = state_text(state)
    lowered = text.lower()
    instructions = (question.instructions or "").lower()
    hints = question.hints or {}
    evidence = 0.0
    reasons: list[str] = []

    # Hard structural facts computed by ordinary code always dominate.
    if "structural" in hints:
        structural = float(hints["structural"])
        evidence += 8.0 * structural
        reasons.append(f"structural={structural:+.2f}")

    if "evidence_ratio" in hints:
        ratio = float(hints["evidence_ratio"])
        evidence += 6.0 * (ratio - 0.5)
        reasons.append(f"evidence_ratio={ratio:.2f}")

    if any(k in instructions for k in ("injection", "override", "manipulat", "untrusted instruction")):
        hits = _term_hits(lowered, INJECTION_TERMS)
        evidence += 2.2 * hits
        reasons.append(f"injection_terms={hits}")

    if any(k in instructions for k in ("destructive", "irreversible", "dangerous")):
        hits = _term_hits(lowered, DESTRUCTIVE_TERMS)
        evidence += 2.0 * hits
        reasons.append(f"destructive_terms={hits}")

    if any(k in instructions for k in ("secret", "credential", "api key", "password", "leak")):
        from ..security.redact import contains_secret

        hit = 1 if contains_secret(text) else 0
        evidence += 6.0 * hit
        reasons.append(f"secret_pattern={hit}")

    if any(k in instructions for k in ("repairable", "fixable", "recoverable", "retry")):
        rep = _term_hits(lowered, REPAIRABLE_TERMS)
        fatal = _term_hits(lowered, FATAL_TERMS)
        evidence += 1.1 * rep - 2.2 * fatal
        reasons.append(f"repairable_terms={rep},fatal_terms={fatal}")
        if hints.get("retry_count"):
            evidence -= 1.5 * float(hints["retry_count"])

    if any(k in instructions for k in ("actionable", "concrete", "executable", "well-defined", "specific")):
        concrete = _term_hits(lowered, CONCRETE_TERMS)
        vague = _term_hits(lowered, VAGUE_TERMS)
        length = len(text)
        evidence += 0.35 * min(concrete, 12) - 1.2 * vague
        evidence += 1.5 if length > 120 else -1.5
        reasons.append(f"concrete={concrete},vague={vague},len={length}")

    if any(k in instructions for k in ("meets", "satisfies", "fulfil", "fulfill", "done-criteria",
                                       "done criteria", "complete", "covered")):
        expected = tokenize(hints.get("criteria_text", ""))
        produced = tokenize(text)
        ratio = _overlap(expected, produced) if expected else 0.0
        evidence += 6.0 * (ratio - 0.45)
        reasons.append(f"criteria_overlap={ratio:.2f}")

    if any(k in instructions for k in ("cycle", "circular", "deadlock")):
        evidence += 0.0  # structural hint carries this decision
        reasons.append("structural-only")

    if any(k in instructions for k in ("relevant", "useful", "related")):
        a = tokenize(hints.get("task_text", text[:400]))
        b = tokenize(text)
        ratio = _overlap(a, b)
        evidence += 6.0 * (ratio - 0.3)
        reasons.append(f"relevance_overlap={ratio:.2f}")

    if any(k in instructions for k in ("hallucinat", "unsupported", "fabricat", "not supported")):
        claims = _term_hits(lowered, ("as per", "according to", "documented in", "see ", "referenced"))
        evidence += 2.0 - 0.8 * min(claims, 4)
        reasons.append(f"citation_markers={claims}")

    if any(k in instructions for k in ("approval", "human review", "escalate")):
        risk = float(hints.get("risk", 0.5))
        evidence += 5.0 * (risk - 0.45)
        evidence += 1.5 * _term_hits(lowered, DESTRUCTIVE_TERMS)
        reasons.append(f"risk={risk:.2f}")

    if any(k in instructions for k in ("notify", "notification", "surface")):
        severity = str(hints.get("severity", "normal")).lower()
        evidence += {"critical": 5.0, "high": 3.0, "normal": 0.0, "low": -3.0}.get(severity, 0.0)
        reasons.append(f"severity={severity}")

    if any(k in instructions for k in ("budget", "within limit", "affordable")):
        used = float(hints.get("used", 0))
        limit = float(hints.get("limit", 1) or 1)
        headroom = 1.0 - (used / limit)
        evidence += 6.0 * (headroom - 0.15)
        reasons.append(f"budget_headroom={headroom:.2f}")

    if "prior" in hints:
        evidence += 3.0 * (float(hints["prior"]) - 0.5)
        reasons.append(f"prior={hints['prior']}")

    positive = hints.get("positive_terms") or []
    negative = hints.get("negative_terms") or []
    if positive or negative:
        evidence += 0.8 * _term_hits(lowered, list(positive)) - 1.2 * _term_hits(lowered, list(negative))

    probability = _logistic(evidence, slope=1.0)
    # Heuristic confidence: how far from the decision boundary we are.
    confidence = _clamp(abs(probability - 0.5) * 2.0)
    return Answer(
        question_id=question.id,
        type="noul",
        # Strict inequality: zero evidence lands on exactly 0.5 and must resolve to
        # False, otherwise every benign guardrail check would read as a hit.
        value=bool(probability > 0.5),
        probability=round(probability, 4),
        confidence=round(confidence, 4),
        probabilities={"true": round(probability, 4), "false": round(1 - probability, 4)},
    )


# --------------------------------------------------------------------------- #
# score
# --------------------------------------------------------------------------- #
def answer_score(question: Question, state: dict[str, Any] | str) -> Answer:
    text = state_text(state)
    lowered = text.lower()
    rubric = question.criteria if isinstance(question.criteria, list) else []
    if not rubric:
        return Answer(question_id=question.id, type="score", value=None, probability=0.0,
                      confidence=0.0, probabilities=[])

    weights: list[float] = []
    for index, label in enumerate(rubric):
        key = str(label).lower()
        raw = 0.0
        raw += 3.0 * _overlap(tokenize(text), tokenize(str(label)))
        if key in lowered:
            raw += 1.0
        for domain, terms in DOMAIN_TERMS.items():
            if domain in key:
                raw += 0.3 * _term_hits(lowered, terms)
        if key in ("critical", "high", "severe", "blocker", "unusable"):
            raw += 1.2 * _term_hits(lowered, FATAL_TERMS + DESTRUCTIVE_TERMS)
        if key in ("none", "low", "excellent", "good"):
            raw += 0.6 * _term_hits(lowered, ("pass", "passed", "ok", "success", "green"))
        weights.append(raw)

    if "structural" in question.hints:
        # structural in [-1, 1] biases towards the top or bottom of the rubric
        bias = float(question.hints["structural"])
        n = len(weights)
        for i in range(n):
            position = (i / max(n - 1, 1)) * 2 - 1  # -1 .. +1
            weights[i] += 4.0 * (1.0 - abs(position - bias))

    if "target_index" in question.hints:
        target = int(question.hints["target_index"])
        for i in range(len(weights)):
            weights[i] += 4.0 if i == target else 0.0

    total = sum(math.exp(min(w, 20.0)) for w in weights) or 1.0
    probabilities = [math.exp(min(w, 20.0)) / total for w in weights]
    n = len(probabilities)
    expected = sum(i * p for i, p in enumerate(probabilities))
    normalised = expected / max(n - 1, 1)
    label = rubric[max(range(n), key=lambda i: probabilities[i])]
    # Confidence = how peaked the distribution is + how much hard evidence was
    # supplied.  A mid-rubric rating is not automatically uncertain; a *flat*
    # distribution is.
    concentration = (max(probabilities) - 1.0 / n) / max(1.0 - 1.0 / n, 1e-6)
    hard = 0.0
    if "target_index" in question.hints:
        hard = 1.0
    elif "structural" in question.hints:
        hard = min(1.0, abs(float(question.hints["structural"])))
    confidence = _clamp(0.5 * concentration + 0.5 * hard)
    return Answer(
        question_id=question.id,
        type="score",
        value=str(label),
        probability=round(normalised, 4),
        probabilities=[round(p, 4) for p in probabilities],
        confidence=round(confidence, 4),
    )


# --------------------------------------------------------------------------- #
def answer(question: Question, state: dict[str, Any] | str) -> Answer:
    if question.type == "choice":
        return answer_choice(question, state)
    if question.type == "score":
        return answer_score(question, state)
    return answer_noul(question, state)
