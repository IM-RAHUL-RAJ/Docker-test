"""
RDS Explorer
============
A small Flask app that connects to an Amazon RDS database (PostgreSQL or MySQL),
lists its schemas and tables, shows the data page by page, and serves the
numbers the front-end needs for 3D visualisations.

Everything is READ-ONLY: the app only ever runs SELECT statements.
"""
import datetime
import decimal
import os
from urllib.parse import quote_plus

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from sqlalchemy import create_engine, func, inspect, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.sql import column as sql_column
from sqlalchemy.sql import table as sql_table

load_dotenv()  # reads a local .env file when you run `python app.py` (ignored if absent)

# Schemas that belong to the database engine itself - we hide them from the UI.
SYSTEM_SCHEMAS = {
    "information_schema", "pg_catalog", "pg_toast",   # PostgreSQL
    "mysql", "performance_schema", "sys",              # MySQL / MariaDB
}
MAX_PAGE_SIZE = 1000


# --------------------------------------------------------------------------- #
# 1. Database connection
# --------------------------------------------------------------------------- #
def build_database_url() -> str:
    """Build the SQLAlchemy URL from environment variables.

    Either set DATABASE_URL directly, or set the individual DB_* variables.
    """
    if os.getenv("DATABASE_URL"):
        return os.environ["DATABASE_URL"]

    drivers = {
        "postgresql": ("postgresql+psycopg2", 5432),
        "postgres":   ("postgresql+psycopg2", 5432),
        "mysql":      ("mysql+pymysql", 3306),
        "mariadb":    ("mysql+pymysql", 3306),
    }
    engine_name = os.getenv("DB_ENGINE", "postgresql").lower()
    if engine_name not in drivers:
        raise ValueError(f"DB_ENGINE must be one of {sorted(drivers)}, got '{engine_name}'")

    driver, default_port = drivers[engine_name]
    user = quote_plus(os.environ["DB_USER"])          # quote_plus handles @ : / in passwords
    password = quote_plus(os.environ["DB_PASSWORD"])
    host = os.environ["DB_HOST"]                       # your RDS endpoint
    port = os.getenv("DB_PORT", default_port)
    name = os.environ["DB_NAME"]
    return f"{driver}://{user}:{password}@{host}:{port}/{name}"


DATABASE_URL = build_database_url()
connect_args = {} if DATABASE_URL.startswith("sqlite") else {"connect_timeout": 10}

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,     # check a pooled connection is alive before using it
    pool_recycle=1800,      # recycle connections every 30 min (RDS closes idle ones)
    connect_args=connect_args,
)

app = Flask(__name__)


# --------------------------------------------------------------------------- #
# 2. Small helpers
# --------------------------------------------------------------------------- #
class NotFound(Exception):
    pass


def to_json(value):
    """Convert database values (Decimal, datetime, bytes...) into JSON-friendly ones."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<{len(bytes(value))} bytes>"
    if isinstance(value, (list, dict)):
        return value
    return str(value)


def column_kind(col_type) -> str:
    """Classify a column as number / date / boolean / text (used by the charts)."""
    try:
        py = col_type.python_type
    except (NotImplementedError, AttributeError):
        return "text"
    if py is bool:
        return "boolean"
    if issubclass(py, (int, float, decimal.Decimal)):
        return "number"
    if issubclass(py, (datetime.date, datetime.datetime)):
        return "date"
    return "text"


def visible_schemas(insp):
    return [
        s for s in insp.get_schema_names()
        if s not in SYSTEM_SCHEMAS and not s.startswith(("pg_temp", "pg_toast_temp"))
    ]


def check_table_exists(insp, schema, table):
    """Only allow schema/table names that really exist - protects against SQL injection."""
    if schema not in visible_schemas(insp):
        raise NotFound(f"Schema '{schema}' not found")
    if table not in insp.get_table_names(schema=schema):
        raise NotFound(f"Table '{schema}.{table}' not found")


def count_rows(conn, schema, table):
    return conn.execute(
        select(func.count()).select_from(sql_table(table, schema=schema))
    ).scalar()


# --------------------------------------------------------------------------- #
# 3. Routes
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return render_template("index.html")


@app.get("/health")
def health():
    """Used by Docker / load balancers to check the app can reach the database."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return jsonify(status="ok")
    except SQLAlchemyError as exc:
        return jsonify(status="error", error=str(exc.__cause__ or exc)), 503


@app.get("/api/overview")
def overview():
    """Every schema with its tables, row counts and column counts."""
    insp = inspect(engine)
    schemas = []
    with engine.connect() as conn:
        for schema in visible_schemas(insp):
            tables = []
            for table in insp.get_table_names(schema=schema):
                try:
                    rows = count_rows(conn, schema, table)
                except SQLAlchemyError:
                    conn.rollback()
                    rows = None  # e.g. no SELECT permission on that table
                tables.append({
                    "name": table,
                    "rows": rows,
                    "columns": len(insp.get_columns(table, schema=schema)),
                })
            schemas.append({"name": schema, "tables": tables})

    return jsonify(
        engine=engine.dialect.name,
        database=engine.url.database,
        host=engine.url.host,
        schemas=schemas,
    )


@app.get("/api/schemas/<schema>/tables/<table>")
def table_details(schema, table):
    """Structure of one table: columns, keys, indexes, row count."""
    insp = inspect(engine)
    check_table_exists(insp, schema, table)

    pk = insp.get_pk_constraint(table, schema=schema).get("constrained_columns") or []
    columns = [{
        "name": c["name"],
        "type": str(c["type"]),
        "kind": column_kind(c["type"]),
        "nullable": c.get("nullable", True),
        "default": None if c.get("default") is None else str(c["default"]),
        "primary_key": c["name"] in pk,
    } for c in insp.get_columns(table, schema=schema)]

    foreign_keys = [{
        "columns": fk["constrained_columns"],
        "ref_schema": fk.get("referred_schema") or schema,
        "ref_table": fk["referred_table"],
        "ref_columns": fk["referred_columns"],
    } for fk in insp.get_foreign_keys(table, schema=schema)]

    indexes = [{
        "name": ix["name"],
        "columns": [c for c in ix["column_names"] if c],
        "unique": bool(ix.get("unique")),
    } for ix in insp.get_indexes(table, schema=schema)]

    with engine.connect() as conn:
        rows = count_rows(conn, schema, table)

    return jsonify(schema=schema, table=table, rows=rows, primary_key=pk,
                   columns=columns, foreign_keys=foreign_keys, indexes=indexes)


@app.get("/api/schemas/<schema>/tables/<table>/rows")
def table_rows(schema, table):
    """One page of data: ?page=1&size=50 (size max 1000)."""
    insp = inspect(engine)
    check_table_exists(insp, schema, table)

    page = max(request.args.get("page", 1, type=int), 1)
    size = min(max(request.args.get("size", 50, type=int), 1), MAX_PAGE_SIZE)

    names = [c["name"] for c in insp.get_columns(table, schema=schema)]
    pk = insp.get_pk_constraint(table, schema=schema).get("constrained_columns") or []
    order_by = pk or names[:1]   # stable ordering so pages don't overlap

    tbl = sql_table(table, *[sql_column(n) for n in names], schema=schema)
    query = (select(*tbl.c)
             .order_by(*[tbl.c[n] for n in order_by])
             .limit(size)
             .offset((page - 1) * size))

    with engine.connect() as conn:
        total = count_rows(conn, schema, table)
        result = conn.execute(query)
        rows = [[to_json(v) for v in row] for row in result]

    return jsonify(columns=names, rows=rows, total=total, page=page, size=size)


# --------------------------------------------------------------------------- #
# 4. Error handling - always answer with JSON so the UI can show a message
# --------------------------------------------------------------------------- #
@app.errorhandler(NotFound)
def handle_not_found(exc):
    return jsonify(error=str(exc)), 404


@app.errorhandler(SQLAlchemyError)
def handle_db_error(exc):
    app.logger.exception("Database error")
    return jsonify(error=f"Database error: {exc.__cause__ or exc}"), 500


if __name__ == "__main__":
    # Development server. In Docker we use gunicorn instead (see Dockerfile).
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)),
            debug=os.getenv("FLASK_DEBUG") == "1")
