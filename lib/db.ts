// Database schema and migrations for the support inbox plugin.
import type Database from "better-sqlite3";

export const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    reporter_name TEXT,
    reporter_email TEXT,
    title TEXT NOT NULL,
    body TEXT,
    metadata TEXT,
    cluster_id TEXT,
    severity TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_cluster ON tickets(cluster_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY,
    canonical_title TEXT NOT NULL,
    canonical_summary TEXT,
    severity TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    ticket_count INTEGER NOT NULL DEFAULT 0,
    first_reported_at INTEGER,
    last_reported_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clusters_status ON clusters(status)`,
  `CREATE INDEX IF NOT EXISTS idx_clusters_updated ON clusters(updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    cluster_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_review',
    channel TEXT NOT NULL DEFAULT 'public',
    subject TEXT,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    reviewed_by TEXT,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_drafts_cluster ON drafts(cluster_id)`,
  `CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status)`,
  `CREATE TABLE IF NOT EXISTS fix_threads (
    id TEXT PRIMARY KEY,
    cluster_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (cluster_id) REFERENCES clusters(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fix_threads_cluster ON fix_threads(cluster_id)`,
];

export function applyMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  );
  const applied = (db.prepare(`SELECT id FROM _bb_migrations`).all() as Array<{ id: number }>).map((row) => row.id);
  const appliedSet = new Set(applied);

  const insertMigration = db.prepare(
    `INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)`,
  );

  db.transaction(() => {
    for (let i = 0; i < MIGRATIONS.length; i++) {
      if (appliedSet.has(i)) continue;
      db.exec(MIGRATIONS[i]);
      insertMigration.run(i, Date.now());
    }
  })();
}
