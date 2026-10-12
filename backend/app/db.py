"""Database engine, session helpers and declarative base."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


def _build_engine():
    url = settings.resolved_db_url()
    connect_args = {"check_same_thread": False, "timeout": 30} if url.startswith("sqlite") else {}
    eng = create_engine(url, connect_args=connect_args, future=True, pool_pre_ping=True)

    if url.startswith("sqlite"):

        @event.listens_for(eng, "connect")
        def _sqlite_pragmas(dbapi_connection, _record):  # pragma: no cover - driver hook
            cur = dbapi_connection.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=30000")
            cur.close()

    return eng


engine = _build_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def _sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def migrate_schema() -> list[str]:
    """Additive forward migration for an existing database.

    ``create_all`` only creates *missing tables*; it never alters one that
    already exists.  A local-first app has to survive an upgrade without asking
    the founder to run a migration tool, so every model column that is absent
    from the live database is added with ``ALTER TABLE ... ADD COLUMN``, using
    the column's declared type and scalar default.

    Only additive changes are attempted.  Renames, drops and type changes are
    deliberately not guessed at: they require an export/re-import, which
    ``POST /api/settings/purge`` provides.
    """
    from sqlalchemy import inspect
    from sqlalchemy import types as sa_types

    from . import models  # noqa: F401  (registers mappers)

    applied: list[str] = []
    inspector = inspect(engine)
    live = {name: {c["name"] for c in inspector.get_columns(name)} for name in inspector.get_table_names()}
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if table.name not in live:
                continue
            for column in table.columns:
                if column.name in live[table.name]:
                    continue
                ddl_type = column.type.compile(engine.dialect)
                default = column.default.arg if column.default is not None and column.default.is_scalar else None
                nullability = "NOT NULL" if not column.nullable else "NULL"
                if not column.nullable and default is None:
                    default = "" if isinstance(column.type, sa_types.String) else 0
                statement = (
                    f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {ddl_type} '
                    f'{nullability} DEFAULT {_sql_literal(default)}'
                )
                conn.exec_driver_sql(statement)
                applied.append(f"{table.name}.{column.name}")
    return applied


def init_db() -> None:
    from . import models  # noqa: F401  (registers mappers)

    Base.metadata.create_all(engine)
    return migrate_schema()


@contextmanager
def session_scope() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_session() -> Iterator[Session]:
    """FastAPI dependency."""
    with session_scope() as session:
        yield session
