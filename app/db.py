import json
from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app import config

SCHEMA = """
create table if not exists cases (
    id serial primary key,
    status text not null default 'review',
    stage int not null default 0,
    raw_report text not null,
    reporter_name text,
    reporter_phone text,
    zone text not null,
    extracted jsonb,
    verification jsonb,
    urgency text not null default 'normal',
    ai_ok boolean not null default true,
    created_at timestamptz not null default now(),
    approved_at timestamptz,
    approved_by text,
    sighted_at timestamptz,
    closed_at timestamptz,
    closed_by text,
    close_note text
);

create table if not exists sightings (
    id serial primary key,
    case_id int references cases(id),
    text text not null,
    zone text not null,
    reporter text,
    score real,
    reasons jsonb,
    route text not null default 'unmatched',
    decision text,
    decided_by text,
    created_at timestamptz not null default now(),
    decided_at timestamptz
);

create table if not exists alerts (
    id serial primary key,
    case_id int not null references cases(id),
    channel text not null,
    message_id text,
    kind text not null default 'alert',
    sent_at timestamptz not null default now(),
    withdrawn_at timestamptz,
    error text
);

alter table cases add column if not exists public_token text;

create table if not exists events (
    id serial primary key,
    case_id int references cases(id),
    actor text not null,
    action text not null,
    detail text,
    at timestamptz not null default now()
);
"""


pool = ConnectionPool(
    config.DATABASE_URL,
    min_size=1,
    max_size=6,
    open=False,
    kwargs={"row_factory": dict_row, "connect_timeout": 10, "prepare_threshold": None, "autocommit": True},
    check=ConnectionPool.check_connection,
)


@contextmanager
def conn():
    with pool.connection() as c:
        yield c


def init():
    pool.open(wait=True, timeout=30)
    with conn() as c:
        c.execute(SCHEMA)


def one(sql, *args):
    with conn() as c:
        return c.execute(sql, args).fetchone()


def all(sql, *args):
    with conn() as c:
        return c.execute(sql, args).fetchall()


def run(sql, *args):
    with conn() as c:
        cur = c.execute(sql, args)
        return cur.fetchone() if cur.description else None


def as_json(value):
    return json.dumps(value) if value is not None else None


def log(case_id, actor, action, detail=None):
    run("insert into events (case_id, actor, action, detail) values (%s, %s, %s, %s)", case_id, actor, action, detail)
