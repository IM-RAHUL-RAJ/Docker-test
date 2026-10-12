"""
seed.py - check the database connection and load demo data into RDS.

Uses the same settings as the app (.env / environment variables).

    python seed.py --check     # only test the connection, change nothing
    python seed.py             # create demo schemas + tables and fill them (skips tables that already have data)
    python seed.py --reset     # drop the demo tables first, then re-create and fill them

With Docker (no Python install needed on the host):

    docker run --rm --env-file .env rds-explorer python seed.py

What it creates (all in new schemas, so your own tables are never touched):

    sales.customers   300 rows
    sales.products     40 rows
    sales.orders     5000 rows   -> customers, products
    hr.departments      6 rows
    hr.employees      120 rows   -> departments

The DB user needs permission to CREATE SCHEMA / CREATE TABLE (the RDS master
user has it). Afterwards you can keep using a read-only user for the app.
"""
import argparse
import datetime as dt
import random
import sys

from sqlalchemy import (Boolean, Column, Date, DateTime, ForeignKey, Integer,
                        MetaData, Numeric, String, Table, func, inspect, select,
                        text)
from sqlalchemy.exc import SQLAlchemyError

from app import engine, explain_db_error

metadata = MetaData()

# --------------------------------------------------------------------------- #
# Table definitions (SQLAlchemy writes the right SQL for PostgreSQL or MySQL)
# --------------------------------------------------------------------------- #
customers = Table(
    "customers", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("name", String(100), nullable=False),
    Column("email", String(150)),
    Column("city", String(60)),
    Column("segment", String(30)),
    Column("joined_on", Date),
    schema="sales",
)
products = Table(
    "products", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("name", String(100), nullable=False),
    Column("category", String(50)),
    Column("price", Numeric(10, 2)),
    Column("stock", Integer),
    schema="sales",
)
orders = Table(
    "orders", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("customer_id", Integer, ForeignKey("sales.customers.id")),
    Column("product_id", Integer, ForeignKey("sales.products.id")),
    Column("quantity", Integer),
    Column("amount", Numeric(12, 2)),
    Column("status", String(20)),
    Column("channel", String(20)),
    Column("ordered_at", DateTime),
    schema="sales",
)
departments = Table(
    "departments", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("name", String(60), nullable=False),
    Column("location", String(60)),
    schema="hr",
)
employees = Table(
    "employees", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("name", String(100), nullable=False),
    Column("department_id", Integer, ForeignKey("hr.departments.id")),
    Column("title", String(60)),
    Column("salary", Integer),
    Column("hired_on", Date),
    Column("active", Boolean),
    schema="hr",
)

# --------------------------------------------------------------------------- #
# Fake-but-realistic data
# --------------------------------------------------------------------------- #
rng = random.Random(42)  # fixed seed -> same data every run
FIRST = ["Aarav", "Diya", "Rahul", "Priya", "Arjun", "Ananya", "Vikram", "Meera", "Karthik", "Sneha",
         "Rohan", "Isha", "Aditya", "Kavya", "Siddharth", "Nisha", "Varun", "Pooja", "Nikhil", "Lakshmi"]
LAST = ["Sharma", "Iyer", "Reddy", "Patel", "Nair", "Gupta", "Menon", "Rao", "Singh", "Kumar"]
CITIES = ["Chennai", "Bengaluru", "Mumbai", "Delhi", "Hyderabad", "Pune", "Kolkata", "Kochi"]
CATEGORIES = {
    "Electronics": ["Headphones", "Smartwatch", "Keyboard", "Monitor", "Speaker", "Webcam", "Power bank"],
    "Books": ["Novel", "Cookbook", "Biography", "Comic", "Textbook"],
    "Home": ["Lamp", "Cushion", "Kettle", "Mixer", "Bedsheet", "Wall clock"],
    "Fitness": ["Yoga mat", "Dumbbells", "Resistance band", "Water bottle"],
    "Fashion": ["Sneakers", "Backpack", "Sunglasses", "Jacket", "Wallet"],
}
DEPARTMENTS = [("Engineering", "Bengaluru"), ("Sales", "Mumbai"), ("Marketing", "Delhi"),
               ("Finance", "Chennai"), ("HR", "Chennai"), ("Support", "Hyderabad")]
TITLES = ["Associate", "Analyst", "Senior Analyst", "Lead", "Manager", "Director"]


def person():
    return f"{rng.choice(FIRST)} {rng.choice(LAST)}"


def fill_sales(conn):
    today = dt.date.today()
    conn.execute(customers.insert(), [{
        "name": (n := person()),
        "email": n.lower().replace(" ", ".") + f"{i}@example.com",
        "city": rng.choice(CITIES),
        "segment": rng.choices(["Consumer", "Corporate", "Small Business"], [6, 3, 2])[0],
        "joined_on": today - dt.timedelta(days=rng.randint(30, 900)),
    } for i in range(300)])

    prods = []
    for cat, items in CATEGORIES.items():
        for item in items:
            for tier in rng.sample(["Lite", "Pro", "Max"], 2):
                prods.append({"name": f"{item} {tier}", "category": cat,
                              "price": round(rng.uniform(199, 14999), 2), "stock": rng.randint(0, 500)})
    conn.execute(products.insert(), prods[:40])

    cust_ids = conn.execute(select(customers.c.id)).scalars().all()
    prod_rows = conn.execute(select(products.c.id, products.c.price)).all()
    now = dt.datetime.now().replace(microsecond=0)
    rows = []
    for _ in range(5000):
        pid, price = rng.choice(prod_rows)
        qty = rng.choices([1, 2, 3, 4, 5], [50, 25, 12, 8, 5])[0]
        rows.append({
            "customer_id": rng.choice(cust_ids),
            "product_id": pid,
            "quantity": qty,
            "amount": round(float(price) * qty, 2),
            "status": rng.choices(["delivered", "shipped", "pending", "cancelled", "returned"], [55, 15, 12, 10, 8])[0],
            "channel": rng.choices(["web", "mobile", "store"], [5, 4, 2])[0],
            "ordered_at": now - dt.timedelta(minutes=rng.randint(0, 365 * 24 * 60)),
        })
    for i in range(0, len(rows), 1000):          # insert in batches
        conn.execute(orders.insert(), rows[i:i + 1000])


def fill_hr(conn):
    conn.execute(departments.insert(), [{"name": n, "location": loc} for n, loc in DEPARTMENTS])
    dept_ids = conn.execute(select(departments.c.id)).scalars().all()
    today = dt.date.today()
    rows = []
    for _ in range(120):
        level = rng.choices(range(len(TITLES)), [30, 25, 20, 12, 9, 4])[0]
        rows.append({
            "name": person(),
            "department_id": rng.choice(dept_ids),
            "title": TITLES[level],
            "salary": 450000 + level * 350000 + rng.randint(0, 250000),
            "hired_on": today - dt.timedelta(days=rng.randint(30, 3000)),
            "active": rng.random() > 0.08,
        })
    conn.execute(employees.insert(), rows)


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def check_connection():
    url = engine.url
    print(f"→ Connecting to {url.get_backend_name()} at {url.host}:{url.port or 'default'} / {url.database} as {url.username} ...")
    try:
        with engine.connect() as conn:
            version = conn.execute(text("SELECT version()")).scalar()
    except SQLAlchemyError as exc:
        print("✗ Connection FAILED\n  " + explain_db_error(exc))
        sys.exit(1)
    print(f"✓ Connected: {str(version).splitlines()[0][:80]}")


def count(conn, table):
    return conn.execute(select(func.count()).select_from(table)).scalar()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="only test the connection")
    parser.add_argument("--reset", action="store_true", help="drop the demo tables first")
    args = parser.parse_args()

    check_connection()
    if args.check:
        return

    try:
        with engine.begin() as conn:            # one transaction: all or nothing
            for schema in ("sales", "hr"):
                # works on both PostgreSQL and MySQL (where SCHEMA == DATABASE)
                conn.execute(text(f"CREATE SCHEMA IF NOT EXISTS {schema}"))
            if args.reset:
                print("→ Dropping demo tables ...")
                metadata.drop_all(conn, checkfirst=True)
            metadata.create_all(conn, checkfirst=True)
            print("✓ Schemas and tables ready")

            if count(conn, customers) == 0:
                print("→ Seeding sales.* ...")
                fill_sales(conn)
            else:
                print("• sales.* already has data - skipped (use --reset to reload)")
            if count(conn, departments) == 0:
                print("→ Seeding hr.* ...")
                fill_hr(conn)
            else:
                print("• hr.* already has data - skipped (use --reset to reload)")

            print("\nRow counts:")
            for t in metadata.sorted_tables:
                print(f"  {t.schema + '.' + t.name:<18} {count(conn, t):>6}")
    except SQLAlchemyError as exc:
        print("✗ Seeding FAILED - nothing was changed\n  " + explain_db_error(exc))
        if "permission denied" in str(exc).lower() or "command denied" in str(exc).lower():
            print("  Hint: run the seed with the RDS master user (it needs CREATE privileges).")
        sys.exit(1)

    print("\n✓ Done. Refresh the app in your browser.")
    if inspect(engine).dialect.name == "postgresql":
        print("  (Using a read-only user for the app? Grant it access to the new schemas:\n"
              "   GRANT USAGE ON SCHEMA sales, hr TO explorer;\n"
              "   GRANT SELECT ON ALL TABLES IN SCHEMA sales, hr TO explorer;)")


if __name__ == "__main__":
    main()
