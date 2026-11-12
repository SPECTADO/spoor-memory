---
spoor_id: 84dae16f-e329-4ff1-9445-00494063177a
adr: 33
title: "System usage dashboard: /admin/usage shows 14-day agent usage and sampled host resources; per-project usage lives on the project dashboard"
status: proposed
date: 2026-11-12
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m54]
tags: [status, usage, dashboard, web-ui]
anchors: [packages/server/src/modules/status/service.ts, packages/web/src/pages/DashboardPage.tsx]
---
# System usage dashboard: /admin/usage shows 14-day agent usage and sampled host resources; per-project usage lives on the project dashboard

## Context
Operators need agent usage over 14 days per project and per server instance, plus host resource usage per instance. The status page polls every 15 seconds, so usage queries must not slow it down. Request logs are admin-only under ADR-0018, and the request log covers agent traffic only, not web UI use.

## Decision
We will serve instance usage from an IA-only endpoint and an `/admin/usage` page in the status module, extending ADR-0031. We will sample host resources every 5 minutes into a new table kept 14 days, and draw charts as hand-written inline SVG. The project dashboard will show a Status widget with counts to every member, and the list of recent agent requests only to project admins.

## Consequences
- The 15-second status poll stays cheap because usage queries run on a separate endpoint.
- Trade-off: the sample table and its scheduler job add storage and upkeep, though charts survive restarts.
- Trade-off: inline SVG avoids a chart library dependency but means maintaining custom rendering code.
- Trade-off: usage excludes web UI traffic, so the figures undercount total use.
- Follow-up: the storage choice and member-visibility rule were defaults stated to the owner and not yet objected to. Confirm both before merge.

## Alternatives considered
- In-memory ring buffer for host resource samples (rejected: charts would not survive restarts).
