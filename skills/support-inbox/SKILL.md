---
name: support-inbox
description: Use when the user reports a bug, asks to file an issue, or submit feedback through the support inbox plugin. Also use when asked to review pending bug clusters, approve/rejection drafts, or check support inbox stats.
---

# Support Inbox

The support inbox plugin (`support-inbox`) ingests bug reports from users, clusters duplicates, drafts replies for your review, and spawns fix threads for confirmed bugs.

## Filing bugs

Use the `support_inbox.report_bug` agent tool:

- `title` (required) — short descriptive title
- `body` (optional) — steps to reproduce, expected vs actual
- `severity` (optional) — `critical`, `major`, `minor`, `trivial`

The tool auto-clusters similar reports into a single issue.

## Reviewing the inbox

The inbox UI lives in the **Support Inbox** sidebar panel. Use it to:

1. Browse pending clusters (grouped duplicates)
2. Confirm valid bugs or dismiss invalid ones
3. Review/edit/reject auto-generated response drafts
4. Approve drafts to send to reporters

## Stats

Call `rpc.call("stats", null)` to get counts of open tickets, pending clusters, drafts awaiting review, and active fix threads.

## Configuration

- Set the **Fix Thread Project** in plugin settings to enable automatic fix thread spawning for confirmed bugs.
- Enable **Auto-confirm clusters** to auto-confirm when 3+ reports arrive for the same issue.
- The webhook endpoint is at `/api/v1/plugins/support-inbox/http/webhook` (POST, token-auth) — send JSON `{title, body, severity, reporter_name, reporter_email, metadata}`.
