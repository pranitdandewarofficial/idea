"""Wire protocol between the orchestrator and a language model.

Two things are standardised here so every provider behaves identically:

1. **Prompt markers** — the first line of every system prompt identifies the
   caller (``# PRANIT/PLANNER v1`` or ``# PRANIT/AGENT <id> v1``).  The offline
   mock provider keys off these markers; real providers ignore them.
2. **Tool calls** — a fenced ``tool`` block containing one JSON object.  This is
   used instead of vendor-specific function calling so that a single code path
   works for OpenAI-compatible, Anthropic, Gemini, Ollama and local servers.
   (See docs/decisions/ADR-0003-tool-protocol.md.)
"""

from __future__ import annotations

import json
import re
from typing import Any

PLANNER_MARKER = "# PRANIT/PLANNER v1"
DECISION_MARKER = "# PRANIT/DECISION v1"


def agent_marker(agent_id: str) -> str:
    return f"# PRANIT/AGENT {agent_id} v1"


AGENT_MARKER_RE = re.compile(r"#\s*PRANIT/AGENT\s+([a-z0-9_\-]+)\s+v1", re.IGNORECASE)

TOOL_BLOCK_RE = re.compile(r"```(?:tool|tool_call|function)\s*\n?(.*?)```", re.DOTALL | re.IGNORECASE)
JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*\n?(.*?)```", re.DOTALL | re.IGNORECASE)
FINAL_RE = re.compile(r"^\s*FINAL\s*:\s*", re.IGNORECASE | re.MULTILINE)


def parse_agent_marker(system_prompt: str) -> str | None:
    match = AGENT_MARKER_RE.search(system_prompt or "")
    return match.group(1).lower() if match else None


def is_planner_prompt(system_prompt: str) -> bool:
    return PLANNER_MARKER in (system_prompt or "")


def is_decision_prompt(system_prompt: str) -> bool:
    return DECISION_MARKER in (system_prompt or "")


def parse_tool_calls(text: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Extract tool calls from a model reply.

    Returns ``(calls, errors)`` where each call is ``{"tool": str, "args": dict}``.
    Malformed blocks are reported as errors so the runtime can send the exact
    parse failure back to the model for a bounded retry.
    """
    calls: list[dict[str, Any]] = []
    errors: list[str] = []
    for match in TOOL_BLOCK_RE.finditer(text or ""):
        body = match.group(1).strip()
        if not body:
            errors.append("empty tool block")
            continue
        try:
            data = json.loads(body)
        except json.JSONDecodeError as exc:
            errors.append(f"tool block is not valid JSON ({exc.msg} at position {exc.pos})")
            continue
        candidates = data if isinstance(data, list) else [data]
        for item in candidates:
            if not isinstance(item, dict):
                errors.append("tool block entries must be JSON objects")
                continue
            name = item.get("tool") or item.get("name") or item.get("function")
            if not isinstance(name, str) or not name:
                errors.append("tool block is missing a 'tool' name")
                continue
            args = item.get("args")
            if args is None:
                args = item.get("arguments") or item.get("parameters") or {}
            if not isinstance(args, dict):
                errors.append(f"args for '{name}' must be a JSON object")
                continue
            calls.append({"tool": name.strip(), "args": args})
    return calls, errors


def strip_tool_blocks(text: str) -> str:
    return TOOL_BLOCK_RE.sub("", text or "").strip()


def extract_json(text: str) -> dict[str, Any] | list[Any] | None:
    """Pull the first JSON object/array out of a model reply."""
    if not text:
        return None
    fenced = JSON_BLOCK_RE.findall(text)
    candidates = list(fenced) + [text]
    for candidate in candidates:
        candidate = candidate.strip()
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            pass
        for opener, closer in (("{", "}"), ("[", "]")):
            start = candidate.find(opener)
            end = candidate.rfind(closer)
            if start != -1 and end > start:
                try:
                    return json.loads(candidate[start : end + 1])
                except json.JSONDecodeError:
                    continue
    return None


def format_tool_results(results: list[dict[str, Any]]) -> str:
    lines = ["Tool results:"]
    for item in results:
        status = "ok" if item.get("ok") else ("denied" if item.get("denied") else "error")
        body = str(item.get("result", item.get("reason", "")))
        lines.append(f"- {item.get('tool')} [{status}]: {body[:1500]}")
    lines.append("")
    lines.append(
        "Continue with the next tool call, or reply with your final summary beginning with 'FINAL:'."
    )
    return "\n".join(lines)


def final_summary(text: str) -> str:
    """Return the agent's final summary, preferring an explicit FINAL: block."""
    if not text:
        return ""
    match = FINAL_RE.search(text)
    if match:
        return text[match.end() :].strip()
    return strip_tool_blocks(text).strip()
