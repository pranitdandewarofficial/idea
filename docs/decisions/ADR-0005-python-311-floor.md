# ADR-0005 — Python 3.11 as the floor, not 3.12+

**Status:** accepted · **Date:** 2026-10 · **Deciders:** founder + build agent

## Context

The brief asked for Python 3.12+. The machine this was built and tested on has
**Python 3.11.2** (Debian/Ubuntu system python), and installing a newer interpreter was not
a dependency the product should require from a founder running `./scripts/setup.sh`.

## Decision

Target **Python ≥ 3.11**: `backend/pyproject.toml` declares `requires-python = ">=3.11"`,
`scripts/setup.sh` fails with a clear message below 3.11, and no 3.12-only syntax or
standard-library feature is used anywhere in `backend/app/`.

## Reasons

1. **Everything we need already exists in 3.11.** `asyncio.TaskGroup`, `asyncio.timeout`,
   PEP 604 unions (`str | None`), PEP 585 builtin generics, `tomllib`, `Self`, exception
   groups, and per-interpreter improvements we do not rely on.
2. **3.12's headline features buy us nothing here.** Type-parameter syntax
   (`def f[T](x: T)`) is cosmetic for this codebase; `itertools.batched` has a two-line
   replacement; the f-string grammar relaxation is a liability, not a feature, in a project
   that parses fenced JSON out of model output.
3. **Install friction is a real cost for a local-first product.** `sudo apt install
   python3.11 python3.11-venv` works on Ubuntu 22.04 and 24.04 without a PPA or a version
   manager. Requiring 3.12 on 22.04 means deadsnakes or pyenv in the quickstart.
4. **3.11 is faster than 3.10 and well-supported.** It receives security fixes until
   October 2027, which outlives any reasonable decision point for this project.

## Consequences

* 3.12 and 3.13 both work; the test suite is written against 3.11 and uses nothing
  version-specific. `GET /api/health` reports the interpreter it is actually running on
  (`python: 3.11.2`), and the shell footer shows it — so nobody has to guess.
* `docker-compose.yml` uses `python:3.11-slim` to match. `PRANIT_DOCKER_IMAGE` (sandbox
  tier 2) defaults to `python:3.12-slim` because generated *projects* are free to target a
  newer interpreter than the orchestrator.
* If a future dependency requires 3.12, the floor moves — but that is a decision to make
  then, with a reason, not now.

## Alternatives considered

* **Require 3.12+ as the brief said** — rejected: it would have made the quickstart fail on
  the machine it was built on, and the product's own rule is that instructions must be
  runnable, not aspirational.
* **Support 3.10 too** — rejected: `asyncio.TaskGroup` and `asyncio.timeout` are genuinely
  useful for bounded concurrent task execution, and backporting them adds risk.
* **Version-conditional code paths** — rejected: two behaviours to test for zero benefit.
