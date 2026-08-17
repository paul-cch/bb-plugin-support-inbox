// Support Inbox frontend — nav panel with cluster list, detail view, draft review.
import { useState, useEffect, useCallback } from "react";
import {
  definePluginApp,
  useRpc,
  useRealtime,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";


type ClusterStatus =
  | "pending"
  | "confirmed"
  | "dismissed"
  | "in_progress"
  | "resolved";

interface Cluster {
  id: string;
  canonical_title: string;
  canonical_summary: string | null;
  severity: string | null;
  status: ClusterStatus;
  ticket_count: number;
  first_reported_at: number | null;
  last_reported_at: number | null;
  created_at: number;
  updated_at: number;
}

interface Ticket {
  id: string;
  source: string;
  reporter_name: string | null;
  reporter_email: string | null;
  title: string;
  body: string | null;
  severity: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface Draft {
  id: string;
  status: string;
  channel: string;
  subject: string | null;
  body: string;
  created_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
}

interface FixThread {
  id: string;
  thread_id: string;
  project_id: string;
  status: string;
  created_at: number;
}

interface ClusterDetail {
  cluster: Cluster | null;
  tickets: Ticket[];
  drafts: Draft[];
  fix_thread: FixThread | null;
}

const STATUS_OPTIONS: Array<{ value: ClusterStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "confirmed", label: "Confirmed" },
  { value: "in_progress", label: "In Progress" },
  { value: "dismissed", label: "Dismissed" },
  { value: "resolved", label: "Resolved" },
];

const SEVERITY_COLORS: Record<string, string> = {
  critical: "bg-red-500/20 text-red-300 border-red-500/30",
  major: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  minor: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  trivial: "bg-blue-500/20 text-blue-300 border-blue-500/30",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  confirmed: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  in_progress: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  dismissed: "bg-gray-500/20 text-gray-300 border-gray-500/30",
  resolved: "bg-green-500/20 text-green-300 border-green-500/30",
};

function Badge({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

function formatDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ClusterList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [clusters, setClusters] = useState<
    Array<{
      id: string;
      canonical_title: string;
      canonical_summary: string | null;
      severity: string | null;
      status: string;
      ticket_count: number;
      first_reported_at: number | null;
      last_reported_at: number | null;
      created_at: number;
      updated_at: number;
    }>
  >([]);
  const [statusFilter, setStatusFilter] = useState<ClusterStatus | "all">(
    "all",
  );
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await rpc.call("listClusters", {
        status: statusFilter === "all" ? undefined : statusFilter,
        limit: 100,
      });
      setClusters(result.clusters);
    } catch (err) {
      console.error("failed to load clusters", err);
    } finally {
      setLoading(false);
    }
  }, [rpc, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh on realtime updates
  useRealtime("support-inbox:updated", () => {
    void load();
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <select
          className="flex h-8 rounded-md border border-input bg-transparent px-2 text-sm"
          value={statusFilter}
          onChange={(e) =>
            setStatusFilter(e.target.value as ClusterStatus | "all")
          }
        >
          {STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? "…" : "↻"}
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {clusters.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {loading ? "Loading…" : "No clusters found."}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {clusters.map((c) => (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={`w-full cursor-pointer p-3 text-left transition-colors hover:bg-state-hover ${
                  selectedId === c.id ? "bg-state-active" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {c.canonical_title}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge className={STATUS_COLORS[c.status] ?? ""}>
                        {c.status}
                      </Badge>
                      {c.severity && (
                        <Badge className={SEVERITY_COLORS[c.severity] ?? ""}>
                          {c.severity}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {c.ticket_count} report{c.ticket_count !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDate(c.last_reported_at)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ClusterDetailView({ clusterId }: { clusterId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [detail, setDetail] = useState<{
    cluster: {
      id: string;
      canonical_title: string;
      canonical_summary: string | null;
      severity: string | null;
      status: string;
      ticket_count: number;
      first_reported_at: number | null;
      last_reported_at: number | null;
      created_at: number;
      updated_at: number;
    } | null;
    tickets: Array<{
      id: string;
      source: string;
      reporter_name: string | null;
      reporter_email: string | null;
      title: string;
      body: string | null;
      severity: string | null;
      status: string;
      created_at: number;
      updated_at: number;
    }>;
    drafts: Array<{
      id: string;
      status: string;
      channel: string;
      subject: string | null;
      body: string;
      created_at: number;
      reviewed_at: number | null;
      reviewed_by: string | null;
    }>;
    fix_thread: {
      id: string;
      thread_id: string;
      project_id: string;
      status: string;
      created_at: number;
    } | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingDraft, setEditingDraft] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await rpc.call("getCluster", { clusterId });
      setDetail(result);
    } catch (err) {
      console.error("failed to load cluster", err);
    } finally {
      setLoading(false);
    }
  }, [rpc, clusterId]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime("support-inbox:updated", () => {
    void load();
  });

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!detail?.cluster) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Cluster not found.
      </div>
    );
  }

  const { cluster, tickets, drafts, fix_thread } = detail;

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{cluster.canonical_title}</h2>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge className={STATUS_COLORS[cluster.status] ?? ""}>
            {cluster.status}
          </Badge>
          {cluster.severity && (
            <Badge className={SEVERITY_COLORS[cluster.severity] ?? ""}>
              {cluster.severity}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {cluster.ticket_count} report{cluster.ticket_count !== 1 ? "s" : ""} ·{" "}
            {formatDate(cluster.first_reported_at)} –{" "}
            {formatDate(cluster.last_reported_at)}
          </span>
        </div>
        {cluster.canonical_summary && (
          <p className="mt-2 text-sm text-muted-foreground">
            {cluster.canonical_summary}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
        {cluster.status === "pending" && (
          <>
            <Button
              size="sm"
              onClick={async () => {
                await rpc.call("confirmCluster", { clusterId });
                await load();
              }}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await rpc.call("dismissCluster", { clusterId });
                await load();
              }}
            >
              Dismiss
            </Button>
          </>
        )}
        {(cluster.status === "confirmed" ||
          cluster.status === "in_progress") && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await rpc.call("generateDraft", { clusterId });
              await load();
            }}
          >
            Regenerate Draft
          </Button>
        )}
        {cluster.status === "dismissed" && (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await rpc.call("reopenCluster", { clusterId });
              await load();
            }}
          >
            Reopen
          </Button>
        )}
        </div>
        <ReportBugDialog />
      </div>

      {/* Fix Thread */}
      {fix_thread && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Fix Thread</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Thread: {fix_thread.thread_id.slice(0, 8)}… · Status:{" "}
            {fix_thread.status}
          </CardContent>
        </Card>
      )}

      {/* Drafts */}
      {drafts.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Drafts</h3>
          {drafts.map((d) => (
            <Card key={d.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">
                    {d.subject ?? "(no subject)"}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge
                      className={
                        d.status === "pending_review"
                          ? "bg-yellow-500/20 text-yellow-300"
                          : d.status === "approved"
                            ? "bg-green-500/20 text-green-300"
                            : d.status === "rejected"
                              ? "bg-red-500/20 text-red-300"
                              : "bg-gray-500/20 text-gray-300"
                      }
                    >
                      {d.status}
                    </Badge>
                    <Badge>{d.channel}</Badge>
                  </div>
                </div>
                <CardDescription>
                  {formatDate(d.created_at)}
                  {d.reviewed_at && ` · reviewed ${formatDate(d.reviewed_at)}`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {editingDraft === d.id ? (
                  <div className="space-y-2">
                    <textarea
                      className="w-full rounded-md border border-input bg-transparent p-2 text-sm"
                      rows={8}
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={async () => {
                          await rpc.call("updateDraft", {
                            draftId: d.id,
                            body: editBody,
                          });
                          setEditingDraft(null);
                          await load();
                        }}
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingDraft(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md bg-muted/30 p-3">
                    <pre className="whitespace-pre-wrap break-words text-sm">{d.body}</pre>
                  </div>
                )}
                {d.status === "pending_review" && editingDraft !== d.id && (
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      onClick={async () => {
                        await rpc.call("approveDraft", { draftId: d.id });
                        await load();
                      }}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingDraft(d.id);
                        setEditBody(d.body);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await rpc.call("rejectDraft", { draftId: d.id });
                        await load();
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Tickets */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Reports ({tickets.length})</h3>
        {tickets.map((t) => (
          <Card key={t.id}>
            <CardContent className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{t.title}</div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{t.source}</span>
                    {t.reporter_name && <span>· {t.reporter_name}</span>}
                    {t.reporter_email && <span>· {t.reporter_email}</span>}
                    <span>· {formatDate(t.created_at)}</span>
                  </div>
                </div>
                {t.severity && (
                  <Badge className={SEVERITY_COLORS[t.severity] ?? ""}>
                    {t.severity}
                  </Badge>
                )}
              </div>
              {t.body && (
                <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                  {t.body}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function ReportBugDialog() {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState("major");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await rpc.call("createManualTicket", {
        title: title.trim(),
        body: body.trim() || undefined,
        severity: severity as "critical" | "major" | "minor" | "trivial",
      });
      setTitle("");
      setBody("");
      setSeverity("major");
      setOpen(false);
    } catch (err) {
      console.error("failed to create ticket", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">+ Report Bug</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Report a Bug</DialogTitle>
          <DialogDescription>
            File a bug report. It will be clustered with similar issues
            automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Title</label>
            <Input
              className="mt-1"
              placeholder="Short descriptive title…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Details</label>
            <textarea
              className="mt-1 w-full rounded-md border border-input bg-transparent p-2 text-sm"
              rows={4}
              placeholder="Steps to reproduce, expected vs actual…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Severity</label>
            <select
              className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
            >
              <option value="critical">Critical</option>
              <option value="major">Major</option>
              <option value="minor">Minor</option>
              <option value="trivial">Trivial</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || !title.trim()}>
            {submitting ? "Submitting…" : "Submit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InboxPanel() {
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(
    null,
  );

  return (
    <div className="flex h-full">
      {/* Left: cluster list */}
      <div className="w-80 shrink-0 border-r border-border">
        <ClusterList
          selectedId={selectedClusterId}
          onSelect={setSelectedClusterId}
        />
      </div>
      {/* Right: detail */}
      <div className="flex-1 overflow-hidden">
        {selectedClusterId ? (
          <ClusterDetailView clusterId={selectedClusterId} />
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-border p-3">
              <span className="text-sm font-medium text-muted-foreground">
                Support Inbox
              </span>
              <ReportBugDialog />
            </div>
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              Select a cluster to view details.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "inbox",
    title: "Support Inbox",
    icon: "Inbox",
    path: "inbox",
    component: InboxPanel,
    experimental_sidebarAccessory: function InboxBadge() {
      const rpc = useRpc<typeof rpcContract>();
      const [count, setCount] = useState<number | null>(null);

      const load = useCallback(async () => {
        try {
          const stats = await rpc.call("stats", null);
          setCount(stats.pending_clusters + stats.drafts_pending);
        } catch {
          // ignore
        }
      }, [rpc]);

      useEffect(() => {
        void load();
        const interval = setInterval(() => void load(), 30_000);
        return () => clearInterval(interval);
      }, [load]);

      useRealtime("support-inbox:updated", () => {
        void load();
      });

      if (count === null || count === 0) return null;
      return (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
          {count > 99 ? "99+" : count}
        </span>
      );
    },
  });

  app.slots.sidebarFooterAction({
    id: "report-bug",
    title: "Support Inbox Settings",
    icon: "Settings",
    run: ({ openSettings }) => openSettings(),
  });
});
