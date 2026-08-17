// Support Inbox backend — ingest, cluster, draft, fix.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import Database from "better-sqlite3";
import { applyMigrations } from "./lib/db.js";
import {
  findBestCluster,
  computeCanonicalTitle,
  computeCanonicalSummary,
} from "./lib/clustering.js";
import type {
  Ticket,
  Cluster,
  Draft,
  FixThread,
  TicketSource,
  TicketSeverity,
  TicketStatus,
  ClusterStatus,
  DraftStatus,
} from "./lib/types.js";

// helpers -----------------------------------------------------------------

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function rowToTicket(r: Record<string, unknown>): Ticket {
  return {
    id: r.id as string,
    source: r.source as TicketSource,
    reporter_name: (r.reporter_name as string) ?? null,
    reporter_email: (r.reporter_email as string) ?? null,
    title: r.title as string,
    body: (r.body as string) ?? null,
    metadata: (r.metadata as string) ?? null,
    cluster_id: (r.cluster_id as string) ?? null,
    severity: (r.severity as TicketSeverity) ?? null,
    status: (r.status as TicketStatus) ?? "open",
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
  };
}

function rowToCluster(r: Record<string, unknown>): Cluster {
  return {
    id: r.id as string,
    canonical_title: r.canonical_title as string,
    canonical_summary: (r.canonical_summary as string) ?? null,
    severity: (r.severity as TicketSeverity) ?? null,
    status: (r.status as ClusterStatus) ?? "pending",
    ticket_count: (r.ticket_count as number) ?? 0,
    first_reported_at: (r.first_reported_at as number) ?? null,
    last_reported_at: (r.last_reported_at as number) ?? null,
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
  };
}

function rowToDraft(r: Record<string, unknown>): Draft {
  return {
    id: r.id as string,
    cluster_id: r.cluster_id as string,
    status: (r.status as DraftStatus) ?? "pending_review",
    channel: (r.channel as Draft["channel"]) ?? "public",
    subject: (r.subject as string) ?? null,
    body: r.body as string,
    created_at: r.created_at as number,
    reviewed_at: (r.reviewed_at as number) ?? null,
    reviewed_by: (r.reviewed_by as string) ?? null,
  };
}

function rowToFixThread(r: Record<string, unknown>): FixThread {
  return {
    id: r.id as string,
    cluster_id: r.cluster_id as string,
    thread_id: r.thread_id as string,
    project_id: r.project_id as string,
    status: (r.status as FixThread["status"]) ?? "open",
    created_at: r.created_at as number,
  };
}

// prepared statement caches (reused across calls) -----------------------

interface PreparedStatements {
  insertTicket: Database.Statement;
  insertCluster: Database.Statement;
  updateTicketCluster: Database.Statement;
  updateClusterRecalc: Database.Statement;
  getClustersByStatus: Database.Statement;
  getClusterById: Database.Statement;
  getTicketsByCluster: Database.Statement;
  getDraftsByCluster: Database.Statement;
  getLatestFixThread: Database.Statement;
  getFixThreadById: Database.Statement;
  getTicketCountByCluster: Database.Statement;
  insertDraft: Database.Statement;
  insertFixThread: Database.Statement;
  updateClusterStatus: Database.Statement;
  updateDraftStatus: Database.Statement;
  getPendingAutoConfirm: Database.Statement;
  getClusterTicketsAll: Database.Statement;
}

function prepareStatements(db: Database.Database): PreparedStatements {
  return {
    insertTicket: db.prepare(
      `INSERT INTO tickets (id, source, reporter_name, reporter_email, title, body, metadata, cluster_id, severity, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'open', ?, ?)`,
    ),
    insertCluster: db.prepare(
      `INSERT INTO clusters (id, canonical_title, canonical_summary, severity, status, ticket_count, first_reported_at, last_reported_at, created_at, updated_at) VALUES (?, ?, NULL, NULL, 'pending', 1, ?, ?, ?, ?)`,
    ),
    updateTicketCluster: db.prepare(
      `UPDATE tickets SET cluster_id = ?, updated_at = ? WHERE id = ?`,
    ),
    updateClusterRecalc: db.prepare(
      `UPDATE clusters SET canonical_title = ?, canonical_summary = ?, severity = ?, ticket_count = ?, first_reported_at = ?, last_reported_at = ?, updated_at = ? WHERE id = ?`,
    ),
    getClustersByStatus: db.prepare(
      `SELECT id, canonical_title FROM clusters WHERE status IN ('pending','confirmed','in_progress')`,
    ),
    getClusterById: db.prepare(`SELECT * FROM clusters WHERE id = ?`),
    getTicketsByCluster: db.prepare(
      `SELECT id, source, reporter_name, reporter_email, title, body, severity, status, created_at, updated_at FROM tickets WHERE cluster_id = ? ORDER BY created_at DESC`,
    ),
    getDraftsByCluster: db.prepare(
      `SELECT * FROM drafts WHERE cluster_id = ? ORDER BY created_at DESC`,
    ),
    getLatestFixThread: db.prepare(
      `SELECT * FROM fix_threads WHERE cluster_id = ? ORDER BY created_at DESC LIMIT 1`,
    ),
    getFixThreadById: db.prepare(`SELECT * FROM fix_threads WHERE id = ?`),
    getTicketCountByCluster: db.prepare(
      `SELECT ticket_count FROM clusters WHERE id = ?`,
    ),
    insertDraft: db.prepare(
      `INSERT INTO drafts (id, cluster_id, status, channel, subject, body, created_at, reviewed_at, reviewed_by) VALUES (?, ?, 'pending_review', ?, ?, ?, ?, NULL, NULL)`,
    ),
    insertFixThread: db.prepare(
      `INSERT INTO fix_threads (id, cluster_id, thread_id, project_id, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)`,
    ),
    updateClusterStatus: db.prepare(
      `UPDATE clusters SET status = ?, updated_at = ? WHERE id = ?`,
    ),
    updateDraftStatus: db.prepare(
      `UPDATE drafts SET status = ?, reviewed_at = ? WHERE id = ?`,
    ),
    getPendingAutoConfirm: db.prepare(
      `SELECT id, ticket_count FROM clusters WHERE status = 'pending' AND ticket_count >= 3`,
    ),
    getClusterTicketsAll: db.prepare(
      `SELECT title, body, severity, created_at FROM tickets WHERE cluster_id = ? ORDER BY created_at ASC`,
    ),
  };
}

// rpc contract ------------------------------------------------------------

export const rpcContract = defineRpcContract({
  listClusters: {
    input: z
      .object({
        status: z
          .enum(["pending", "confirmed", "dismissed", "in_progress", "resolved"])
          .optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    output: z.object({
      clusters: z.array(
        z.object({
          id: z.string(),
          canonical_title: z.string(),
          canonical_summary: z.string().nullable(),
          severity: z.string().nullable(),
          status: z.string(),
          ticket_count: z.number().int(),
          first_reported_at: z.number().nullable(),
          last_reported_at: z.number().nullable(),
          created_at: z.number(),
          updated_at: z.number(),
        }),
      ),
    }),
  },
  getCluster: {
    input: z.object({ clusterId: z.string() }).strict(),
    output: z.object({
      cluster: z
        .object({
          id: z.string(),
          canonical_title: z.string(),
          canonical_summary: z.string().nullable(),
          severity: z.string().nullable(),
          status: z.string(),
          ticket_count: z.number().int(),
          first_reported_at: z.number().nullable(),
          last_reported_at: z.number().nullable(),
          created_at: z.number(),
          updated_at: z.number(),
        })
        .nullable(),
      tickets: z.array(
        z.object({
          id: z.string(),
          source: z.string(),
          reporter_name: z.string().nullable(),
          reporter_email: z.string().nullable(),
          title: z.string(),
          body: z.string().nullable(),
          severity: z.string().nullable(),
          status: z.string(),
          created_at: z.number(),
          updated_at: z.number(),
        }),
      ),
      drafts: z.array(
        z.object({
          id: z.string(),
          status: z.string(),
          channel: z.string(),
          subject: z.string().nullable(),
          body: z.string(),
          created_at: z.number(),
          reviewed_at: z.number().nullable(),
          reviewed_by: z.string().nullable(),
        }),
      ),
      fix_thread: z
        .object({
          id: z.string(),
          thread_id: z.string(),
          project_id: z.string(),
          status: z.string(),
          created_at: z.number(),
        })
        .nullable(),
    }),
  },
  confirmCluster: {
    input: z.object({ clusterId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  dismissCluster: {
    input: z.object({ clusterId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  reopenCluster: {
    input: z.object({ clusterId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  generateDraft: {
    input: z
      .object({
        clusterId: z.string(),
        channel: z.enum(["public", "email", "internal"]).optional(),
      })
      .strict(),
    output: z.object({
      draft: z.object({
        id: z.string(),
        cluster_id: z.string(),
        status: z.string(),
        channel: z.string(),
        subject: z.string().nullable(),
        body: z.string(),
        created_at: z.number(),
        reviewed_at: z.number().nullable(),
        reviewed_by: z.string().nullable(),
      }),
    }),
  },
  updateDraft: {
    input: z
      .object({
        draftId: z.string(),
        subject: z.string().optional(),
        body: z.string().optional(),
        channel: z.enum(["public", "email", "internal"]).optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  approveDraft: {
    input: z.object({ draftId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  rejectDraft: {
    input: z.object({ draftId: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }),
  },
  createManualTicket: {
    input: z
      .object({
        title: z.string().min(1),
        body: z.string().optional(),
        severity: z.enum(["critical", "major", "minor", "trivial"]).optional(),
        reporter_name: z.string().optional(),
        reporter_email: z.string().optional(),
      })
      .strict(),
    output: z.object({
      ticket: z.object({
        id: z.string(),
        source: z.string(),
        title: z.string(),
        body: z.string().nullable(),
        severity: z.string().nullable(),
        status: z.string(),
        cluster_id: z.string().nullable(),
        created_at: z.number(),
        updated_at: z.number(),
      }),
    }),
  },
  stats: {
    input: z.null(),
    output: z.object({
      open_tickets: z.number().int(),
      pending_clusters: z.number().int(),
      confirmed_clusters: z.number().int(),
      drafts_pending: z.number().int(),
      fix_threads: z.number().int(),
    }),
  },
});

// plugin factory ---------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    fixProject: { type: "project", label: "Fix Thread Project" },
    webhookToken: { type: "string", label: "Webhook Secret", secret: true, default: "" },
    minClusterScore: { type: "string", label: "Cluster Threshold", default: "0.45" },
    autoConfirm: { type: "boolean", label: "Auto-confirm clusters", default: false },
  });

  const db = bb.storage.database();
  applyMigrations(db);
  const stmts = prepareStatements(db);

  const initial = await settings.get();
  bb.log.info(`support-inbox loaded (fixProject=${initial.fixProject ?? "none"})`);

  // helpers that read fresh settings -------------------------------------

  async function getThreshold(): Promise<number> {
    const s = await settings.get();
    const n = parseFloat(s.minClusterScore || "0.45");
    return isNaN(n) ? 0.45 : n;
  }

  // clustering ------------------------------------------------------------

  function recalcCluster(db: Database.Database, clusterId: string): void {
    const tickets = stmts.getClusterTicketsAll.all(clusterId) as Array<{
      title: string;
      body: string | null;
      severity: string | null;
      created_at: number;
    }>;

    const titles = tickets.map((t) => t.title);
    const canonicalTitle = computeCanonicalTitle(titles);
    const canonicalSummary = computeCanonicalSummary(
      tickets.map((t) => t.body ?? ""),
    );

    const severities = tickets
      .map((t) => t.severity)
      .filter((s): s is string => s !== null);
    const severity = mostFrequent(severities);

    const firstAt = tickets.length > 0 ? tickets[0].created_at : null;
    const lastAt =
      tickets.length > 0 ? tickets[tickets.length - 1].created_at : null;

    stmts.updateClusterRecalc.run(
      canonicalTitle,
      canonicalSummary ?? null,
      severity ?? null,
      tickets.length,
      firstAt,
      lastAt,
      Date.now(),
      clusterId,
    );
  }

  function mostFrequent(arr: string[]): string | null {
    if (arr.length === 0) return null;
    const freq = new Map<string, number>();
    for (const s of arr) freq.set(s, (freq.get(s) ?? 0) + 1);
    let best: string | null = null;
    let bestN = 0;
    for (const [k, v] of freq) {
      if (v > bestN) {
        best = k;
        bestN = v;
      }
    }
    return best;
  }

  function runClustering(
    title: string,
    threshold: number,
  ): string | null {
    const clusters = stmts.getClustersByStatus.all() as Array<{
      id: string;
      canonical_title: string;
    }>;

    const best = findBestCluster({ title }, clusters, threshold);
    return best?.clusterId ?? null;
  }

  function assignOrCreateCluster(
    ticketId: string,
    title: string,
    threshold: number,
  ): string {
    const existingClusterId = runClustering(title, threshold);
    if (existingClusterId) {
      stmts.updateTicketCluster.run(existingClusterId, Date.now(), ticketId);
      recalcCluster(db, existingClusterId);
      return existingClusterId;
    }

    const clusterId = genId("cl");
    const now = Date.now();
    stmts.insertCluster.run(clusterId, title, now, now, now, now);
    stmts.updateTicketCluster.run(clusterId, now, ticketId);
    return clusterId;
  }

  // draft generation ------------------------------------------------------

  function buildDraftForCluster(
    cluster: Cluster,
    tickets: Ticket[],
    channel: Draft["channel"] = "public",
  ): string {
    const sevLine = cluster.severity ? `**Severity:** ${cluster.severity}\n` : "";
    const reporters = new Set(
      tickets.map((t) => t.reporter_email || t.reporter_name).filter(Boolean),
    );
    const reporterLine =
      reporters.size > 0
        ? `**Reporters:** ${[...reporters].join(", ")}\n`
        : "";
    const countLine = `**Reports:** ${cluster.ticket_count}\n`;

    const latestBody = tickets.find((t) => t.body)?.body ?? "";
    const details = latestBody
      ? `\n## Latest report\n${latestBody.slice(0, 500)}`
      : "";

    const intro =
      cluster.ticket_count === 1
        ? `Thanks for reporting this — we've received the bug report and are looking into it.`
        : `Thanks to everyone who reported this — we've received ${cluster.ticket_count} reports so far and are investigating.`;

    return `# Response draft: ${cluster.canonical_title}

${intro}

${sevLine}${reporterLine}${countLine}
## What we know
${cluster.canonical_summary ?? "(no details)"}
${details}

## Next steps
- [ ] Reproduce the issue
- [ ] Identify root cause
- [ ] Implement and verify fix

We'll update this thread once we have more information. If you have additional context, please reply here.

— Support`;
  }

  // public ingest function (used by RPC + webhook) ---------------------

  async function ingestTicket(opts: {
    title: string;
    body?: string;
    source: TicketSource;
    reporter_name?: string;
    reporter_email?: string;
    severity?: TicketSeverity;
    metadata?: string;
  }): Promise<{ ticketId: string; clusterId: string; isNewCluster: boolean }> {
    const ticketId = genId("tk");
    const now = Date.now();
    const threshold = await getThreshold();

    const clusterId = db.transaction(() => {
      stmts.insertTicket.run(
        ticketId,
        opts.source,
        opts.reporter_name ?? null,
        opts.reporter_email ?? null,
        opts.title,
        opts.body ?? null,
        opts.metadata ?? null,
        opts.severity ?? null,
        now,
        now,
      );
      return assignOrCreateCluster(ticketId, opts.title, threshold);
    })();

    const countRow = stmts.getTicketCountByCluster.get(clusterId) as {
      ticket_count: number;
    };

    return {
      ticketId,
      clusterId,
      isNewCluster: countRow.ticket_count <= 1,
    };
  }

  // fix thread spawning ---------------------------------------------------

  async function spawnFixThread(
    cluster: Cluster,
  ): Promise<FixThread | null> {
    const s = await settings.get();
    if (!s.fixProject) return null;

    const thread = await bb.sdk.threads.spawn({
      projectId: s.fixProject,
      environment: { type: "project-default" },
      prompt: `Fix the following bug report.\n\nTitle: ${cluster.canonical_title}\nSummary: ${cluster.canonical_summary ?? "(none)"}\nSeverity: ${cluster.severity ?? "unknown"}\n\nReproduce the issue, identify the root cause, implement a fix, and verify it. Create a PR when done.`,
      title: `[Support] ${cluster.canonical_title}`,
      visibility: "hidden",
    });

    const fixId = genId("fx");
    stmts.insertFixThread.run(
      fixId,
      cluster.id,
      thread.id,
      s.fixProject,
      Date.now(),
    );

    stmts.updateClusterStatus.run("in_progress", Date.now(), cluster.id);

    return rowToFixThread(
      stmts.getFixThreadById.get(fixId) as Record<string, unknown>,
    );
  }

  // rpc handlers ----------------------------------------------------------

  bb.rpc.register(rpcContract, {
    async listClusters({ status, limit = 50 }) {
      const db = bb.storage.database();
      const where = status ? `WHERE status = ?` : "";
      const params = status ? [status] : [];
      const rows = db
        .prepare(`SELECT * FROM clusters ${where} ORDER BY updated_at DESC LIMIT ?`)
        .all(...params, limit) as Array<Record<string, unknown>>;
      return {
        clusters: rows.map((r) => {
          const c = rowToCluster(r);
          return {
            id: c.id,
            canonical_title: c.canonical_title,
            canonical_summary: c.canonical_summary,
            severity: c.severity,
            status: c.status,
            ticket_count: c.ticket_count,
            first_reported_at: c.first_reported_at,
            last_reported_at: c.last_reported_at,
            created_at: c.created_at,
            updated_at: c.updated_at,
          };
        }),
      };
    },

    async getCluster({ clusterId }) {
      const db = bb.storage.database();
      const clusterRow = stmts.getClusterById.get(clusterId) as Record<string, unknown> | undefined;
      if (!clusterRow)
        return { cluster: null, tickets: [], drafts: [], fix_thread: null };

      const cluster = rowToCluster(clusterRow);
      const ticketRows = stmts.getTicketsByCluster.all(clusterId) as Array<Record<string, unknown>>;
      const draftRows = stmts.getDraftsByCluster.all(clusterId) as Array<Record<string, unknown>>;
      const fixRow = stmts.getLatestFixThread.get(clusterId) as Record<string, unknown> | undefined;

      return {
        cluster: {
          id: cluster.id,
          canonical_title: cluster.canonical_title,
          canonical_summary: cluster.canonical_summary,
          severity: cluster.severity,
          status: cluster.status,
          ticket_count: cluster.ticket_count,
          first_reported_at: cluster.first_reported_at,
          last_reported_at: cluster.last_reported_at,
          created_at: cluster.created_at,
          updated_at: cluster.updated_at,
        },
        tickets: ticketRows.map((r) => {
          const t = rowToTicket(r);
          return {
            id: t.id,
            source: t.source,
            reporter_name: t.reporter_name,
            reporter_email: t.reporter_email,
            title: t.title,
            body: t.body,
            severity: t.severity,
            status: t.status,
            created_at: t.created_at,
            updated_at: t.updated_at,
          };
        }),
        drafts: draftRows.map((r) => {
          const d = rowToDraft(r);
          return {
            id: d.id,
            status: d.status,
            channel: d.channel,
            subject: d.subject,
            body: d.body,
            created_at: d.created_at,
            reviewed_at: d.reviewed_at,
            reviewed_by: d.reviewed_by,
          };
        }),
        fix_thread: fixRow
          ? (() => {
              const f = rowToFixThread(fixRow);
              return {
                id: f.id,
                thread_id: f.thread_id,
                project_id: f.project_id,
                status: f.status,
                created_at: f.created_at,
              };
            })()
          : null,
      };
    },

    async confirmCluster({ clusterId }) {
      const db = bb.storage.database();
      const clusterRow = stmts.getClusterById.get(clusterId) as Record<string, unknown> | undefined;
      if (!clusterRow) return { ok: false };

      stmts.updateClusterStatus.run("confirmed", Date.now(), clusterId);

      // Generate draft
      const tickets = (stmts.getTicketsByCluster.all(clusterId) as Array<Record<string, unknown>>).map(rowToTicket);
      const c = rowToCluster(clusterRow);
      const body = buildDraftForCluster(c, tickets);
      const draftId = genId("dr");
      stmts.insertDraft.run(draftId, clusterId, "public", `Re: ${c.canonical_title}`, body, Date.now());

      return { ok: true };
    },

    async dismissCluster({ clusterId }) {
      stmts.updateClusterStatus.run("dismissed", Date.now(), clusterId);
      return { ok: true };
    },

    async reopenCluster({ clusterId }) {
      stmts.updateClusterStatus.run("pending", Date.now(), clusterId);
      return { ok: true };
    },

    async generateDraft({ clusterId, channel }) {
      const db = bb.storage.database();
      const clusterRow = stmts.getClusterById.get(clusterId) as Record<string, unknown> | undefined;
      if (!clusterRow) throw new Error(`cluster ${clusterId} not found`);

      const tickets = (stmts.getTicketsByCluster.all(clusterId) as Array<Record<string, unknown>>).map(rowToTicket);
      const c = rowToCluster(clusterRow);
      const body = buildDraftForCluster(c, tickets, channel ?? "public");
      const draftId = genId("dr");
      stmts.insertDraft.run(draftId, clusterId, channel ?? "public", `Re: ${c.canonical_title}`, body, Date.now());

      const draftRow = db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(draftId) as Record<string, unknown>;
      const d = rowToDraft(draftRow);
      return {
        draft: {
          id: d.id,
          cluster_id: d.cluster_id,
          status: d.status,
          channel: d.channel,
          subject: d.subject,
          body: d.body,
          created_at: d.created_at,
          reviewed_at: d.reviewed_at,
          reviewed_by: d.reviewed_by,
        },
      };
    },

    async updateDraft({ draftId, subject, body, channel }) {
      const db = bb.storage.database();
      const sets: string[] = [];
      const params: unknown[] = [];
      if (subject !== undefined) {
        sets.push("subject = ?");
        params.push(subject);
      }
      if (body !== undefined) {
        sets.push("body = ?");
        params.push(body);
      }
      if (channel !== undefined) {
        sets.push("channel = ?");
        params.push(channel);
      }
      if (sets.length === 0) return { ok: true };
      params.push(draftId);
      db.prepare(`UPDATE drafts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
      return { ok: true };
    },

    async approveDraft({ draftId }) {
      stmts.updateDraftStatus.run("approved", Date.now(), draftId);
      return { ok: true };
    },

    async rejectDraft({ draftId }) {
      stmts.updateDraftStatus.run("rejected", Date.now(), draftId);
      return { ok: true };
    },

    async createManualTicket({ title, body, severity, reporter_name, reporter_email }) {
      const result = await ingestTicket({
        title,
        body,
        severity,
        reporter_name,
        reporter_email,
        source: "manual",
      });
      const ticketRow = bb.storage.database()
        .prepare(`SELECT * FROM tickets WHERE id = ?`)
        .get(result.ticketId) as Record<string, unknown>;
      const t = rowToTicket(ticketRow);
      return {
        ticket: {
          id: t.id,
          source: t.source,
          title: t.title,
          body: t.body,
          severity: t.severity,
          status: t.status,
          cluster_id: t.cluster_id,
          created_at: t.created_at,
          updated_at: t.updated_at,
        },
      };
    },

    async stats() {
      const db = bb.storage.database();
      const openTickets = (db.prepare(`SELECT COUNT(*) n FROM tickets WHERE status = 'open'`).get() as { n: number }).n;
      const pendingClusters = (db.prepare(`SELECT COUNT(*) n FROM clusters WHERE status = 'pending'`).get() as { n: number }).n;
      const confirmedClusters = (db.prepare(`SELECT COUNT(*) n FROM clusters WHERE status = 'confirmed'`).get() as { n: number }).n;
      const draftsPending = (db.prepare(`SELECT COUNT(*) n FROM drafts WHERE status = 'pending_review'`).get() as { n: number }).n;
      const fixThreads = (db.prepare(`SELECT COUNT(*) n FROM fix_threads`).get() as { n: number }).n;
      return {
        open_tickets: openTickets,
        pending_clusters: pendingClusters,
        confirmed_clusters: confirmedClusters,
        drafts_pending: draftsPending,
        fix_threads: fixThreads,
      };
    },
  });

  // webhook HTTP endpoint ------------------------------------------------

  bb.http.route(
    "POST",
    "/webhook",
    async (c) => {
      try {
        const body = await c.req.json();
        const title = body.title || body.subject || body.summary;
        if (!title) {
          return c.json({ error: "title is required" }, 400);
        }
        const result = await ingestTicket({
          title: String(title),
          body: typeof body.body === "string" ? body.body : undefined,
          severity: body.severity as TicketSeverity | undefined,
          reporter_name: body.reporter_name ? String(body.reporter_name) : undefined,
          reporter_email: body.reporter_email ? String(body.reporter_email) : undefined,
          source: "webhook",
          metadata: body.metadata ? JSON.stringify(body.metadata) : undefined,
        });
        bb.log.info(`webhook ingested ticket ${result.ticketId} -> cluster ${result.clusterId}`);
        bb.realtime.publish("support-inbox:updated", {
          type: "ticket_created",
          ticketId: result.ticketId,
          clusterId: result.clusterId,
          isNewCluster: result.isNewCluster,
        });
        return c.json(result);
      } catch (err) {
        bb.log.error(`webhook error: ${err}`);
        return c.json({ error: "internal error" }, 500);
      }
    },
    { auth: "token" },
  );

  // agent tool ------------------------------------------------------------

  bb.agents.registerTool({
    name: "support_inbox",
    description:
      "Report a bug to the support inbox. Use when a user asks to file a bug, report an issue, or submit feedback. The inbox clusters duplicates automatically.",
    instructions:
      "When the user reports a bug or asks to file an issue, use support_inbox(title, body, severity?) to submit it. The inbox will cluster it with similar reports.",
    parameters: z.object({
      title: z.string().min(1).describe("Short descriptive title of the bug"),
      body: z.string().optional().describe("Detailed description, steps to reproduce, expected vs actual behavior"),
      severity: z
        .enum(["critical", "major", "minor", "trivial"])
        .optional()
        .describe("Bug severity. Infer from impact: critical=data loss/security, major=broken feature, minor=cosmetic/workaround, trivial=nitpick"),
    }),
    async execute({ title, body, severity }) {
      const result = await ingestTicket({
        title,
        body,
        severity,
        source: "agent",
      });
      return result.isNewCluster
        ? `New bug reported and filed as cluster \`${result.clusterId}\`. Title: ${title}`
        : `Bug reported and clustered with existing issue \`${result.clusterId}\`. Title: ${title}`;
    },
  });

  // instructions ----------------------------------------------------------

  bb.agents.contributeInstructions(() => {
    return "The support inbox plugin is active. When users report bugs or issues, use the support_inbox tool to file them. Review pending clusters at /plugins/support-inbox/inbox.";
  });

  // background service: auto-confirm clusters with high report counts ----

  bb.background.service("auto-confirm", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const s = await settings.get();
          if (s.autoConfirm) {
            const db = bb.storage.database();
            const pending = stmts.getPendingAutoConfirm.all() as Array<{
              id: string;
              ticket_count: number;
            }>;
            for (const c of pending) {
              stmts.updateClusterStatus.run("confirmed", Date.now(), c.id);
              bb.log.info(`auto-confirmed cluster ${c.id} (${c.ticket_count} reports)`);
            }
          }
        } catch (err) {
          bb.log.error(`auto-confirm error: ${err}`);
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 60_000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  // dispose ---------------------------------------------------------------

  bb.onDispose(() => {
    bb.log.info("support-inbox disposed");
    try {
      db.close();
    } catch {
      // already closed by host
    }
  });
}
