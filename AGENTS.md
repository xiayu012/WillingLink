# AGENTS.md

## Cursor Cloud specific instructions

### Overview

WillingLink is a Next.js 16 AI chatbot / shift-coordination app built on the Vercel AI SDK. It uses pnpm 9.12.3 as the package manager. See `README.md` and `package.json` scripts for standard commands.

### PostgreSQL setup (non-obvious)

The Drizzle migrations require a `Shift` table that is **not** created by any migration file. Before running `pnpm db:migrate` on a fresh database, you must create the `Shift` and `SearchAudio` tables manually using the definitions in `lib/db/schema.ts`, then grant ownership to the application's DB user. The pgvector extension must also be enabled (`CREATE EXTENSION IF NOT EXISTS vector`). If using the local dev setup below, these steps have already been done.

### Local dev database

PostgreSQL 16 with pgvector is installed locally. To start it:

```
sudo pg_ctlcluster 16 main start
```

Connection string: `postgresql://chatuser:chatpass@localhost:5432/chatdb`

This is already configured in `.env.local`.

### Environment variables

The app reads `.env.local` (not `.env`). Required variables:
- `AUTH_SECRET` — session encryption key
- `POSTGRES_URL` — PostgreSQL connection string

For AI features, `AI_GATEWAY_API_KEY` is needed. For file uploads, `BLOB_READ_WRITE_TOKEN` is needed. For voice transcription (OpenAI Realtime API), `OPENAI_API_KEY` is needed. Redis (`REDIS_URL`) is optional. See `.env.example` for the full list.

These secrets are injected as environment variables by the Cloud Agent VM. To write them into `.env.local`, run:

```bash
cat > .env.local << EOF
AUTH_SECRET=$(openssl rand -base64 32)
POSTGRES_URL=postgresql://chatuser:chatpass@localhost:5432/chatdb
AI_GATEWAY_API_KEY=$AI_GATEWAY_API_KEY
BLOB_READ_WRITE_TOKEN=$BLOB_READ_WRITE_TOKEN
OPENAI_API_KEY=$OPENAI_API_KEY
EOF
```

### Running the dev server

```
pnpm dev
```

Runs on http://localhost:3000. The app uses auto-guest login via the proxy (`proxy.ts`): unauthenticated visitors are automatically redirected to `/api/auth/guest`, which creates a guest user and sets a session cookie.

### Lint

```
pnpm lint
```

Uses Biome (via Ultracite). The repo currently has ~119 pre-existing formatting warnings — these are not regressions.

### Tests

Playwright e2e tests in `tests/e2e/`. They require the dev server running and the `/ping` health endpoint (handled by `proxy.ts`). Run with:

```
pnpm test
```

Note: E2e tests require `AI_GATEWAY_API_KEY` and a working Postgres to be meaningful. Without these, chat-related tests will fail.

### Playwright browser (avoid repeated installs)

This repository defaults Playwright to the system Chrome binary at `/usr/local/bin/google-chrome` for both e2e tests and crawler jobs.

- If this path exists, you usually **do not** need `pnpm exec playwright install`.
- You can override with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when needed.

### Rental crawler provider fallback (cloud-friendly)

The rental crawler first fetches HTML directly, then falls back to a hosted scraper provider if list/detail HTML is blocked.

- `SCRAPER_PROVIDER`: `none` | `zenrows` | `scrapingbee`
- `SCRAPER_API_KEY`: provider API key

### Starting the full dev environment

```bash
sudo pg_ctlcluster 16 main start   # Start PostgreSQL
pnpm dev                            # Start Next.js dev server on :3000
```

### Key architecture notes

- `proxy.ts` acts as Next.js middleware — handles auth redirects and the `/ping` health check.
- The homepage (`app/(chat)/page.tsx`) is a phone number collection form, NOT the chat UI. The chat interface lives at `/chat/[id]` routes and is created when a message is sent via `/api/chat`.
- The `Shift` table uses pgvector embeddings via raw SQL (not Drizzle schema) for semantic search.
- Redis is used for resumable streams but gracefully degrades when unavailable.
- The service worker (Serwist) is disabled in development mode.
- When killing the dev server, always remove `/workspace/.next/dev/lock` before restarting, otherwise Next.js may pick a different port.
