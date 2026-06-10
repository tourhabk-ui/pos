---
name: trust-first
version: 1.0.0
license: Apache-2.0
description: >
  Use when building or reviewing tourist booking platforms, outdoor/adventure apps,
  emergency/rescue features, offline-capable travel tools, or any product where:
  user safety matters more than conversion rate, data must work without internet,
  official registrations (MChS/МЧС, park permits) are part of the flow, or the
  platform makes safety claims it must actually deliver on.
  Covers: offline SOS design, safety data modeling, operator verification flows,
  trust audit, pre-launch safety checklist, MChS registration integration,
  offline-first PWA patterns for wilderness/expedition contexts.
user-invocable: true
argument-hint: "[audit|safety|offline|preflight] [target]"
---

# Trust-First — safety-first tourist & booking platforms

A skill for platforms where user safety is non-negotiable. Extracted from KamchatourHub — a wilderness tourism platform for Kamchatka, Russia, where routes are active volcanoes and the nearest hospital is 200 km away.

## Core principle

**Trust is infrastructure, not copy.** Every claim ("works offline", "verified operator", "route is open") must be backed by code that actually delivers it. If you can't prove it runs, remove the claim.

## Sub-commands

| Command | Reference file |
|---------|---------------|
| `audit` — trust & safety audit of a platform | `reference/audit.md` |
| `safety` — offline SOS, MChS registration, emergency patterns | `reference/safety.md` |
| `offline` — offline-first PWA: IndexedDB, Background Sync, GPX | `reference/offline.md` |
| `preflight` — pre-launch trust checklist (12 gates) | `reference/preflight.md` |

## Quick audit

```bash
node .claude/skills/trust-first/scripts/audit-trust.mjs
```

## Anti-patterns this skill prevents

- SOS button that silently fails when offline
- "Verified operator" badge without actual verification logic
- Route shown as "open" without real-time status check
- Price displayed without a date ("from ₽X" without validity)
- Emergency phone numbers that are dead links on mobile
- Booking confirmation sent before operator actually confirmed
