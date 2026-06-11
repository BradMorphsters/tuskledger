/**
 * Local SQLite mirror of the laptop's accounts + transactions.
 *
 * Why a mirror at all (vs. the phone fetching on-demand):
 *
 *   1. Speed. Reads happen against the device's flash, not the LAN.
 *      Opening the app at a checkout line should never spin.
 *   2. Offline. Train, plane, basement of a parking garage — the app
 *      stays useful, just stops getting fresh data.
 *   3. Render predictability. UI screens query SQLite the same way
 *      whether the sync just succeeded, failed, or never ran.
 *
 * Schema: deliberately a NEAR-mirror of the backend, not a 1:1 copy.
 * We carry only what the phone screens actually use (no audit fields,
 * no Plaid IDs, no tax_bucket etc.). When new mobile features need a
 * field, add a column AND bump SCHEMA_VERSION so existing installs
 * re-pull from scratch on next launch.
 *
 * `applySync()` upserts deltas in a single transaction, atomically. A
 * failed sync leaves the previous state intact — no half-updated rows.
 */
import * as SQLite from 'expo-sqlite';
import type {
  AccountWire,
  HoldingWire,
  ManualAssetWire,
  NetWorthSnapshotWire,
  SecurityWire,
  TransactionWire,
} from '../sync/types';

const DB_NAME = 'tuskledger.db';
// Bumped to 3 with the addition of manual_assets — without those, the
// phone's net worth was missing the user's homes, vehicles, and any
// non-Plaid liabilities, so the headline number didn't match the laptop.
// Bumping forces a one-time wipe + full re-pull on next launch — fine
// because the mirror is disposable and the laptop is the source of truth.
const SCHEMA_VERSION = 3;

let _db: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  await migrate(_db);
  return _db;
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  // Tracking schema version explicitly (rather than relying on PRAGMA
  // user_version) keeps it inspectable from the Settings screen.
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      custom_name TEXT,
      type TEXT NOT NULL,
      subtype TEXT,
      institution_name TEXT,
      mask TEXT,
      current_balance REAL,
      available_balance REAL,
      currency TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      merchant_name TEXT,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      pending INTEGER NOT NULL DEFAULT 0,
      category TEXT,
      custom_category TEXT,
      is_transfer INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_transactions_date ON transactions(date DESC);
    CREATE INDEX IF NOT EXISTS ix_transactions_account_id ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS ix_transactions_category ON transactions(category);

    CREATE TABLE IF NOT EXISTS securities (
      plaid_security_id TEXT PRIMARY KEY,
      ticker_symbol TEXT,
      name TEXT,
      type TEXT,
      close_price REAL,
      close_price_as_of TEXT,
      is_cash_equivalent INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      plaid_security_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      institution_price REAL,
      institution_value REAL,
      cost_basis REAL,
      iso_currency_code TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_holdings_account_id ON holdings(account_id);
    CREATE TABLE IF NOT EXISTS net_worth_snapshots (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      total_assets REAL NOT NULL DEFAULT 0,
      total_liabilities REAL NOT NULL DEFAULT 0,
      net_worth REAL NOT NULL DEFAULT 0,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_snapshots_date ON net_worth_snapshots(date);
    CREATE TABLE IF NOT EXISTS manual_assets (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'asset',
      type TEXT NOT NULL,
      current_value REAL NOT NULL DEFAULT 0,
      value_as_of TEXT,
      notes TEXT,
      plaid_mortgage_account_id INTEGER,
      updated_at TEXT
    );
  `);

  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM meta WHERE key = ?',
    ['schema_version'],
  );
  const installed = row ? parseInt(row.value, 10) : 0;
  if (installed !== SCHEMA_VERSION) {
    // Future migrations land here. For v1, force a re-pull on a
    // schema bump rather than hand-writing migration SQL — phone
    // mirrors are disposable, the source of truth is the laptop.
    if (installed !== 0) {
      // Clear every mirrored table — the SCHEMA_VERSION bump means the
      // shape changed; safer to repopulate from the source of truth than
      // to hand-write per-version migrations on a disposable mirror.
      await db.execAsync(`
        DELETE FROM accounts;
        DELETE FROM transactions;
        DELETE FROM securities;
        DELETE FROM holdings;
        DELETE FROM net_worth_snapshots;
        DELETE FROM manual_assets;
      `);
      // Also clear the sync cursor so the next sync does a full pull
      // against the now-empty tables. Without this, the incremental
      // cursor would point past most history and near-nothing would
      // be returned on the first post-migration sync.
      // Lazy import avoids a circular dependency: sqlite ← queries ← ...
      // sync/storage only touches SecureStore and has no DB imports.
      const { saveCursor } = await import('../sync/storage');
      await saveCursor('');
    }
    await db.runAsync(
      'INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)',
      ['schema_version', String(SCHEMA_VERSION)],
    );
  }
}

/** Wipe finance data. Used by /api/mobile/sync `full=true` path
 *  and the "Resync from scratch" button. */
export async function resetMirror(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    DELETE FROM accounts;
    DELETE FROM transactions;
    DELETE FROM securities;
    DELETE FROM holdings;
    DELETE FROM net_worth_snapshots;
    DELETE FROM manual_assets;
  `);
}

export async function applySync(
  accounts: AccountWire[],
  transactions: TransactionWire[],
  isFull: boolean,
  extra: {
    securities?: SecurityWire[];
    holdings?: HoldingWire[];
    netWorthSnapshots?: NetWorthSnapshotWire[];
    manualAssets?: ManualAssetWire[];
  } = {},
): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    if (isFull) {
      // The backend told us this was a full sync — wipe before insert
      // so deletions on the laptop side propagate. Otherwise an
      // incremental sync that returns no rows for a category that
      // got merged on the laptop would leave stale rows here forever.
      // Snapshots are append-only so no wipe needed for them on a full
      // sync — re-inserts will INSERT OR REPLACE on the unique date.
      await db.execAsync(`
        DELETE FROM accounts;
        DELETE FROM transactions;
        DELETE FROM securities;
        DELETE FROM holdings;
        DELETE FROM manual_assets;
      `);
    }

    // Batch upserts using prepareAsync/executeAsync/finalizeAsync.
    // Preparing once per table avoids re-parsing the SQL on every bridge
    // round-trip — critical for initial syncs with hundreds of rows.

    if (accounts.length > 0) {
      const stmt = await db.prepareAsync(
        `INSERT OR REPLACE INTO accounts
         (id, name, custom_name, type, subtype, institution_name, mask,
          current_balance, available_balance, currency, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const a of accounts) {
          await stmt.executeAsync([
            a.id,
            a.name,
            a.custom_name,
            a.type,
            a.subtype,
            a.institution_name,
            a.mask,
            a.current_balance,
            a.available_balance,
            a.currency,
            a.updated_at,
          ]);
        }
      } finally {
        await stmt.finalizeAsync();
      }
    }

    if (transactions.length > 0) {
      const stmt = await db.prepareAsync(
        `INSERT OR REPLACE INTO transactions
         (id, account_id, name, merchant_name, amount, date, pending,
          category, custom_category, is_transfer, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const t of transactions) {
          await stmt.executeAsync([
            t.id,
            t.account_id,
            t.name,
            t.merchant_name,
            t.amount,
            t.date,
            t.pending ? 1 : 0,
            t.category,
            t.custom_category,
            t.is_transfer ? 1 : 0,
            t.notes,
            t.updated_at,
          ]);
        }
      } finally {
        await stmt.finalizeAsync();
      }
    }

    const securities = extra.securities ?? [];
    if (securities.length > 0) {
      const stmt = await db.prepareAsync(
        `INSERT OR REPLACE INTO securities
         (plaid_security_id, ticker_symbol, name, type,
          close_price, close_price_as_of, is_cash_equivalent, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const s of securities) {
          await stmt.executeAsync([
            s.plaid_security_id,
            s.ticker_symbol,
            s.name,
            s.type,
            s.close_price,
            s.close_price_as_of,
            s.is_cash_equivalent ? 1 : 0,
            s.updated_at,
          ]);
        }
      } finally {
        await stmt.finalizeAsync();
      }
    }

    const holdings = extra.holdings ?? [];
    if (holdings.length > 0) {
      const stmt = await db.prepareAsync(
        `INSERT OR REPLACE INTO holdings
         (id, account_id, plaid_security_id, quantity,
          institution_price, institution_value, cost_basis,
          iso_currency_code, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const h of holdings) {
          await stmt.executeAsync([
            h.id,
            h.account_id,
            h.plaid_security_id,
            h.quantity,
            h.institution_price,
            h.institution_value,
            h.cost_basis,
            h.iso_currency_code,
            h.updated_at,
          ]);
        }
      } finally {
        await stmt.finalizeAsync();
      }
    }

    const netWorthSnapshots = extra.netWorthSnapshots ?? [];
    if (netWorthSnapshots.length > 0) {
      const stmt = await db.prepareAsync(
        `INSERT OR REPLACE INTO net_worth_snapshots
         (id, date, total_assets, total_liabilities, net_worth, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const n of netWorthSnapshots) {
          await stmt.executeAsync([
            n.id,
            n.date,
            n.total_assets,
            n.total_liabilities,
            n.net_worth,
            n.created_at,
          ]);
        }
      } finally {
        await stmt.finalizeAsync();
      }
    }

    const manualAssets = extra.manualAssets ?? [];
    if (manualAssets.length > 0) {
      const stmt = await db.prepareAsync(
        `INSERT OR REPLACE INTO manual_assets
         (id, name, side, type, current_value, value_as_of, notes,
          plaid_mortgage_account_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      try {
        for (const m of manualAssets) {
          await stmt.executeAsync([
            m.id,
            m.name,
            m.side,
            m.type,
            m.current_value,
            m.value_as_of,
            m.notes,
            m.plaid_mortgage_account_id,
            m.updated_at,
          ]);
        }
      } finally {
        await stmt.finalizeAsync();
      }
    }
  });
}
