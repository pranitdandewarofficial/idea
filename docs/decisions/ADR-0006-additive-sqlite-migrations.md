# ADR-0006 — Additive-only SQLite migrations, no migration framework

**Status:** accepted · **Date:** 2026-10 · **Deciders:** founder + build agent

## Context

The product stores everything that matters in one SQLite file: agents, providers (with
Fernet-encrypted keys), projects, plans, tasks, tool calls, messages, memory, knowledge
sources and chunks, events, decisions, checkpoints, approvals, usage records, audit rows
and runtime settings.

That file lives in `backend/.data/` next to the API token and the encryption key. It is the
founder's company history. A migration that corrupts it, or that requires a separate
toolchain to run, is worse than no migration at all.

The schema also changed *while* the product was being built — `DecisionRecord.action` was
added late, when the router started distinguishing `auto` from `escalate`.

## Decision

**`init_db()` is the only migration step, and it is additive only.**

```python
def init_db() -> None:
    Base.metadata.create_all(bind=engine)   # creates missing tables, no-op for existing ones
    migrate_schema()                        # ALTER TABLE … ADD COLUMN for missing columns
```

`migrate_schema()` reads `PRAGMA table_info(<table>)` for each table that has grown, and
issues `ALTER TABLE <table> ADD COLUMN <name> <type> [DEFAULT …]` for every declared column
that is absent. It runs on every boot, is idempotent, needs no version table, no revision
graph and no CLI.

**Nothing in the codebase drops a column, renames a column, retypes a column, or rewrites a
table.** A field that is no longer used is simply left in place and ignored.

## Reasons

1. **SQLite's DDL is genuinely limited.** It supports `ADD COLUMN` (with restrictions) and
   nothing else in-place. Every other change requires the twelve-step
   copy-to-new-table-and-swap dance, which is exactly where data loss happens.
2. **Idempotent beats versioned for a single-user local app.** There is no fleet to keep in
   sync, no down-migration to run, no CI to gate. The question "does this database have the
   columns the code expects?" is answerable directly, from the database, on every boot.
3. **No dependency and no second source of truth.** Alembic would add a revision history
   that can drift from the SQLAlchemy models. Deriving the migration from
   `Base.metadata` means the models *are* the schema definition.
4. **Forward-compatible with a real framework.** If the project ever needs destructive
   migrations or multi-process deploys, `migrate_schema()` is a clean seam to replace with
   Alembic autogenerate — the models do not change.
5. **It already proved itself.** `DecisionRecord.action` was added mid-build; existing
   databases gained the column on the next boot with no data loss and no manual step. That
   is asserted in `backend/tests/test_decisions.py`.

## Consequences

* **No down-migrations.** Rolling back to older code against a newer database works (extra
  columns are ignored), but the reverse — newer code, older database — relies on
  `migrate_schema()` having run. It runs at boot, so this is fine in practice.
* **Dead columns accumulate.** Accepted: SQLite columns cost nothing when unused, and
  honesty about history is worth more than a tidy `PRAGMA table_info`.
* **Type changes are impossible in place.** If a column's type must change, the plan is:
  add a new column, backfill in Python at boot, switch reads, stop writing the old one.
  Documented here so nobody reaches for a destructive `ALTER`.
* **Concurrent boots.** Two processes starting at once could both attempt the same
  `ADD COLUMN`; the second fails with "duplicate column name", which `migrate_schema()`
  treats as success. WAL journaling plus a single uvicorn process makes this rare.
* **Backups are a file copy.** `.data/` (database + token + key) and `workspaces/` should be
  copied together; without the key, stored provider keys are unreadable.

## Alternatives considered

* **Alembic** — the right tool for a deployed, multi-environment schema. Overkill here, and
  it introduces a revision history that can disagree with the models.
* **`create_all` alone** — what most prototypes do. It creates missing *tables* but never
  adds missing *columns*, so the first schema change silently breaks an existing install
  with `no such column`. That is the exact failure `migrate_schema()` exists to prevent.
* **Recreate the database on schema change** — destroys the founder's audit trail and run
  history. Unacceptable for an append-only-audit product.
* **JSON blob per row instead of columns** — flexible, but it would make the audit trail
  and the decision log unqueryable, and both are product surfaces.
