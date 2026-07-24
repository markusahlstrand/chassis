/**
 * The raw `CREATE TABLE` DDL for the issuer's SQLite store — the drizzle-over-SQLite drivers
 * (Durable Object and better-sqlite3) do not run migrations, so both stores are created from
 * these on init. Kept byte-for-byte consistent with the Drizzle schema in `src/auth-schema.ts`.
 *
 * This lives OUTSIDE `src/` on purpose. `tools/boundary-lint.mjs` builds its table-ownership
 * map by scanning every `CREATE TABLE <name>` under a package's `src/`, and these are the
 * GENERIC Better Auth table names (`user`, `session`, `account`, `verification`, `config`)
 * that other packages (e.g. apps/dashboard) also create. Declaring them under `src/` would
 * make this demo the global "owner" of those names and flag every other package's own auth
 * tables as R5 violations. Raw infra DDL is not module code, so — like Callout's
 * `migrations/*.sql` — it belongs out of the linted module tree. The drizzle `sqliteTable`
 * definitions carry no `CREATE TABLE` literal, so they stay in `src/` safely.
 */
export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS user (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    email_verified INTEGER NOT NULL DEFAULT 0, image TEXT,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    role TEXT, banned INTEGER DEFAULT 0, ban_reason TEXT, ban_expires INTEGER)`,
  `CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, impersonated_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS session_userId_idx ON session (user_id)`,
  `CREATE TABLE IF NOT EXISTS account (
    id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    access_token TEXT, refresh_token TEXT, id_token TEXT,
    access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS account_userId_idx ON account (user_id)`,
  `CREATE TABLE IF NOT EXISTS verification (
    id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`,
  `CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier)`,
  `CREATE TABLE IF NOT EXISTS jwks (
    id TEXT PRIMARY KEY NOT NULL, public_key TEXT NOT NULL, private_key TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)), expires_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS oauth_application (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, icon TEXT, metadata TEXT,
    client_id TEXT NOT NULL UNIQUE, client_secret TEXT, redirect_urls TEXT NOT NULL, type TEXT NOT NULL,
    disabled INTEGER DEFAULT 0, user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`,
  `CREATE INDEX IF NOT EXISTS oauth_application_userId_idx ON oauth_application (user_id)`,
  `CREATE TABLE IF NOT EXISTS oauth_access_token (
    id TEXT PRIMARY KEY NOT NULL, access_token TEXT UNIQUE, refresh_token TEXT UNIQUE,
    access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, client_id TEXT,
    user_id TEXT REFERENCES user(id) ON DELETE CASCADE, scopes TEXT,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`,
  `CREATE INDEX IF NOT EXISTS oauth_access_token_clientId_idx ON oauth_access_token (client_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_access_token_userId_idx ON oauth_access_token (user_id)`,
  `CREATE TABLE IF NOT EXISTS oauth_consent (
    id TEXT PRIMARY KEY NOT NULL, client_id TEXT, user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
    scopes TEXT, consent_given INTEGER,
    created_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)),
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))`,
  `CREATE INDEX IF NOT EXISTS oauth_consent_clientId_idx ON oauth_consent (client_id)`,
  `CREATE INDEX IF NOT EXISTS oauth_consent_userId_idx ON oauth_consent (user_id)`,
  // This issuer's own config — notably its generated, persisted signing secret.
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];
