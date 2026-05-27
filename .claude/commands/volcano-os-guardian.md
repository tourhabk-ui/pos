---
name: volcano-os-guardian
description: "Specialized skill for managing and developing the TourHab (Volcano OS) platform. Use for: database migrations, AI agent (Kuzmich) development, offline-first PWA maintenance, and Kamchatka tourism data management."
---

# Volcano OS Guardian

This skill provides specialized knowledge and workflows for the TourHab (Volcano OS) platform, a mobile operating system for tourists in Kamchatka.

## Project Overview

TourHab is an offline-first PWA designed for tourists in remote areas of Kamchatka. It features:
- **Offline Maps**: Cached tiles and GPS without internet.
- **Kuzmich AI**: A multi-modal assistant (text, photo, voice) with local knowledge.
- **Safety Features**: SOS numbers and real-time alerts from KBGS RAN.
- **Extensive Data**: Over 1,400 routes and 700+ places.

## Core Workflows

### Database Management

The project uses PostgreSQL with raw SQL and a custom migration system.

1. **Base Schema**: Always refer to `lib/database/schema.sql` for the core table definitions (users, partners, tours, assets).
2. **Migrations**: Numbered SQL files in `migrations/`.
   - To add a new migration: Create a new file `migrations/XXX_description.sql`.
   - To apply migrations locally: `DATABASE_URL=... npm run migrate`.
3. **Bootstrapping**:
   - Apply `lib/database/schema.sql` first.
   - Seed initial data (users/partners).
   - Run migrations.

### AI Agent Development (Kuzmich)

Kuzmich is the "brain" of the platform.

- **Core Logic**: `lib/kuzmich/core.ts`.
- **Safety Context**: `lib/kuzmich/guardian-context.ts`.
- **Agent Waterfall**: OpenRouter → DeepSeek → Gemini → MiniMax → Anthropic.
- **Caching Strategy**: Refer to `AGENTS.md` for context caching rules to minimize token costs.

### Scraping and Data Import

- **Tools**: Bright Data Web Unlocker for bypassing anti-bot protections (2GIS, Yandex Maps).
- **Scripts**: `import-tours.js`, `scrape-idilesom.js`, `scrape-idilesom-direct.js`.

## Technical Stack

- **Frontend**: Next.js 15 App Router, TypeScript (strict).
- **Backend**: Next.js API routes, PostgreSQL (raw SQL).
- **Auth**: JWT with role-based middleware.
- **Deployment**: Timeweb Cloud (Docker).

## Development Guidelines

- **Offline-First**: Ensure all new features work without an internet connection.
- **Performance**: Optimize for low-power mobile devices.
- **Safety**: Prioritize accurate safety information and emergency features.
- **Context Hygiene**: Follow the rules in `AGENTS.md` to maintain high cache hit rates.

## References

- `lib/database/schema.sql`: Core database structure.
- `AGENTS.md`: AI agent architecture and caching rules.
- `README.md`: Project overview and setup instructions.
