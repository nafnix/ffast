import Database from "better-sqlite3";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const dataDirectory = resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR ?? join(process.cwd(), "data"));
export const filesDirectory = join(dataDirectory, "files");
export const tempDirectory = join(dataDirectory, "tmp");

mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
mkdirSync(filesDirectory, { recursive: true, mode: 0o700 });
mkdirSync(tempDirectory, { recursive: true, mode: 0o700 });
for (const privateDirectory of [dataDirectory, filesDirectory, tempDirectory]) {
  try {
    chmodSync(privateDirectory, 0o700);
  } catch {
    // Mounted or managed filesystems may not allow permission changes.
  }
}

const dbPath = join(dataDirectory, "ffast.sqlite");

type DatabaseWithCache = typeof globalThis & { __ffastDatabase?: Database.Database };
const globalWithDatabase = globalThis as DatabaseWithCache;

function createDatabase() {
  // Remove temporary chunks left by an interrupted upload after a process restart.
  for (const entry of readdirSync(tempDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".part")) {
      rmSync(join(tempDirectory, entry.name), { force: true });
    }
  }

  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS login_limits (
      key TEXT PRIMARY KEY,
      failures INTEGER NOT NULL,
      window_started_at INTEGER NOT NULL,
      blocked_until INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      size INTEGER NOT NULL,
      share_token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_created_idx ON files(created_at DESC);
  `);

  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // File permissions may not be changeable on every mounted filesystem.
  }

  return database;
}

export const db = globalWithDatabase.__ffastDatabase ?? createDatabase();

if (process.env.NODE_ENV !== "production") {
  globalWithDatabase.__ffastDatabase = db;
}

export function isInitialized() {
  return Boolean(db.prepare("SELECT 1 FROM settings WHERE key = ?").get("admin_password_hash"));
}

export function getMaxUploadBytes() {
  const configured = Number(process.env.MAX_UPLOAD_SIZE_BYTES ?? 2 * 1024 ** 3);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 2 * 1024 ** 3;
}
