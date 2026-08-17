// Shared types for the support inbox plugin.

export type TicketSource = "webhook" | "agent" | "manual";
export type TicketSeverity = "critical" | "major" | "minor" | "trivial";
export type TicketStatus = "open" | "resolved" | "spam";

export type ClusterStatus =
  | "pending"
  | "confirmed"
  | "dismissed"
  | "in_progress"
  | "resolved";

export type DraftStatus = "pending_review" | "approved" | "rejected" | "sent";
export type DraftChannel = "public" | "email" | "internal";

export type FixThreadStatus = "open" | "in_progress" | "closed";

export interface Ticket {
  id: string;
  source: TicketSource;
  reporter_name: string | null;
  reporter_email: string | null;
  title: string;
  body: string | null;
  metadata: string | null;
  cluster_id: string | null;
  severity: TicketSeverity | null;
  status: TicketStatus;
  created_at: number;
  updated_at: number;
}

export interface Cluster {
  id: string;
  canonical_title: string;
  canonical_summary: string | null;
  severity: TicketSeverity | null;
  status: ClusterStatus;
  ticket_count: number;
  first_reported_at: number | null;
  last_reported_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Draft {
  id: string;
  cluster_id: string;
  status: DraftStatus;
  channel: DraftChannel;
  subject: string | null;
  body: string;
  created_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
}

export interface FixThread {
  id: string;
  cluster_id: string;
  thread_id: string;
  project_id: string;
  status: FixThreadStatus;
  created_at: number;
}

export interface ClusterSummary extends Cluster {
  latest_ticket_at: number | null;
}
