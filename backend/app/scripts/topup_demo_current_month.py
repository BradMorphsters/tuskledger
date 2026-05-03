"""
Top-up the demo DB with a handful of distinctive transactions in the
current month, so a freshly-seeded demo doesn't render a thin "this
month" tile when "today" is early in the month.

Why this exists: `seed_demo.py` re-anchors the synthetic dataset to
`today` and generates ~12 months of transactions back from there. If
"today" is the 2nd of the month, the current month has only one or
two days of data — fine for an honest demo, ugly for a screencast.

Usage:
    cd backend && python -m app.scripts.topup_demo_current_month

The script is **idempotent-ish**: it stamps inserted rows with a
`plaid_transaction_id` prefix of `topup_<YYYY-MM>_` so a second run
notices the prior run and bails. Re-anchor by running
`seed_demo.py --output ./tuskledger_demo.db` first if you want a
clean slate.

Safety: only ever writes to the demo DB (DEMO_DATABASE_URL); never
touches the real DB. Refuses to run if the demo DB doesn't exist —
won't accidentally create a sibling DB that the real app then can't
find.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import date
from pathlib import Path


# Distinctive merchants + categories that read well on the dashboard.
# Designed to trip the anomaly-card thresholds (Groceries, Food &
# Dining, Gas) so the demo dashboard fires multiple insight cards.
ROWS_FOR_DAY_1 = [
    (14.97,  "NETFLIX.COM",          "Netflix",            "Entertainment"),
    (25.00,  "NYTimes*Subscription", "The New York Times", "Entertainment"),
    (38.42,  "WHOLE FOODS MARKET",   "Whole Foods",        "Groceries"),
    (18.50,  "CHIPOTLE 2845",        "Chipotle",           "Food & Dining"),
]

ROWS_FOR_DAY_2 = [
    (5.45,   "STARBUCKS STORE",      "Starbucks",          "Food & Dining"),
    (142.18, "AMAZON.COM*MX5KF",     "Amazon",             "Shopping"),
    (9.99,   "SPOTIFY USA",          "Spotify",            "Entertainment"),
    (-487.00,"STRIPE TRANSFER",      "Stripe",             "Income"),
    (62.30,  "TRADER JOE'S #194",    "Trader Joe's",       "Groceries"),
    (28.91,  "SHELL OIL",            "Shell",              "Gas & Fuel"),
    (11.73,  "SWEETGREEN",           "Sweetgreen",         "Food & Dining"),
    (7.49,   "BLUE BOTTLE COFFEE",   "Blue Bottle",        "Food & Dining"),
]


def main(db_path: Path) -> int:
    if not db_path.exists():
        print(f"Demo DB not found at {db_path}.", file=sys.stderr)
        print("Run `python -m app.scripts.seed_demo` first.", file=sys.stderr)
        return 1

    today = date.today()
    if today.day < 2:
        # On the 1st, just write to "today". Day-2 rows would be future-dated.
        target_dates = [today]
    else:
        # Most days: spread rows across day 1 and day 2 of this month
        # (or yesterday and today if we're past day 2). Doesn't really
        # matter — both end up in "this month."
        target_dates = [
            date(today.year, today.month, 1),
            date(today.year, today.month, 2),
        ]
    month_tag = today.strftime("%Y-%m")

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Idempotency check: if any prior run already stamped rows for this
    # month, bail rather than duplicate.
    cur.execute(
        "SELECT COUNT(*) FROM transactions WHERE plaid_transaction_id LIKE ?",
        (f"topup_{month_tag}_%",),
    )
    prior = cur.fetchone()[0]
    if prior > 0:
        print(f"Already topped up for {month_tag} ({prior} rows). No-op.")
        return 0

    # Find the primary checking account.
    cur.execute("""
        SELECT id, COALESCE(official_name, name) FROM accounts
        WHERE LOWER(subtype) = 'checking'
        ORDER BY id LIMIT 1
    """)
    row = cur.fetchone()
    if row is None:
        print("No checking account found in demo DB.", file=sys.stderr)
        return 1
    checking_id, checking_name = row
    print(f"Using account #{checking_id}: {checking_name}")

    # Insert rows.
    inserted = 0
    rows_by_day = (
        ROWS_FOR_DAY_1 + ROWS_FOR_DAY_2
        if len(target_dates) == 2 else
        ROWS_FOR_DAY_1
    )

    # Distribute across target dates. First N rows on date 1, rest on date 2.
    n_day_1 = len(ROWS_FOR_DAY_1)
    for i, (amt, name, merchant, cat) in enumerate(rows_by_day):
        d = target_dates[0] if i < n_day_1 else target_dates[1]
        plaid_txn_id = f"topup_{month_tag}_{i:02d}"
        cur.execute("""
            INSERT INTO transactions
                (account_id, plaid_transaction_id, name, merchant_name,
                 amount, currency, date, pending, category, is_transfer)
            VALUES (?, ?, ?, ?, ?, 'USD', ?, 0, ?, 0)
        """, (checking_id, plaid_txn_id, name, merchant, amt, d.isoformat(), cat))
        inserted += 1

    conn.commit()

    # Verify
    cur.execute("""
        SELECT COUNT(*),
               SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS spent,
               -SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS income
        FROM transactions
        WHERE strftime('%Y-%m', date) = ?
    """, (month_tag,))
    n, spent, income = cur.fetchone()
    print(f"Inserted {inserted} top-up rows.")
    print(f"{month_tag} totals — txns: {n}, spent: ${spent or 0:.2f}, income: ${income or 0:.2f}")

    conn.close()
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        default="./tuskledger_demo.db",
        help="Path to the demo SQLite DB (default: ./tuskledger_demo.db)",
    )
    args = parser.parse_args()
    sys.exit(main(Path(args.db).resolve()))
