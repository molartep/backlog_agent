CREATE TABLE IF NOT EXISTS inbox (
  update_id INTEGER PRIMARY KEY,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  action TEXT NOT NULL,
  original TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  result_url TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS sessions (
  owner TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drafts_owner ON drafts(owner, state);
