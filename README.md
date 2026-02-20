![TouchGrass.city](public/touchgrass-city.png)

# TouchGrass.city

Realtime multiplayer "touch grass" game built with TanStack Start, WebSockets, Better Auth, and Postgres.

Players sign up, pick a color, move around a large scrolling map, collect grass for points, grab powerups, and avoid roaming computers that chase nearby players and reset score on contact.

## Features

- Realtime multiplayer game state over WebSockets (`/ws/game`)
- Email/password auth with Better Auth
- Persistent player scores and saved player color in Postgres
- Large world with camera-centered movement
- Powerups (speed, magnet, double points)
- Enemy computers with territorial AI
- Keyboard and touch joystick controls
- In-game leaderboard and FPS counter

## Tech Stack

- TanStack Start + TanStack Router
- React + TypeScript
- CrossWS
- Better Auth
- Drizzle ORM + drizzle-kit
- PostgreSQL
- Tailwind CSS

## Quick Start

1. Install dependencies:

```bash
bun install
```

2. Create `.env.local` in the project root (or copy from `.env.example`):

```bash
cp .env.example .env.local

DATABASE_URL=postgres://postgres:postgres@localhost:5432/touchgrass
BETTER_AUTH_SECRET=replace-with-a-long-random-secret
BETTER_AUTH_URL=http://localhost:3000
PORT=3000
```

3. Run database migrations:

```bash
bun --bun run db:migrate
```

4. Start development server:

```bash
bun --bun run dev
```

5. Open `http://localhost:3000`.

## Environment Variables

| Variable | Required | Example | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | `postgres://postgres:postgres@localhost:5432/touchgrass` | Postgres connection string used by Drizzle and score/profile persistence. |
| `BETTER_AUTH_SECRET` | Yes (prod), recommended (dev) | `super-long-random-string` | Secret used by Better Auth for signing/encrypting auth data. |
| `BETTER_AUTH_URL` | Recommended | `http://localhost:3000` | Base URL for Better Auth endpoints/cookies in local/prod deployments. |
| `PORT` | Optional | `3000` | Server port (defaults to `3000`). |

Note on `DATABASE_URL`: make sure it contains real Postgres credentials. Placeholder usernames like `username` can cause errors such as `role "username" does not exist`.

## Database

This project stores:

- `player_scores` (persistent score by `user_id`)
- `player_profiles` (persistent color by `user_id`)

If you change schema, generate and run migrations:

```bash
bun --bun run db:generate
bun --bun run db:migrate
```

## Scripts

- `bun --bun run dev` - Start dev server on port 3000
- `bun --bun run build` - Production build
- `bun --bun run preview` - Preview production build
- `bun --bun run start` - Run built server (`.output/server/index.mjs`)
- `bun --bun run test` - Run tests
- `bun --bun run lint` - Biome lint
- `bun --bun run format` - Biome format
- `bun --bun run check` - Biome check
- `bun --bun run db:generate` - Generate Drizzle migration files
- `bun --bun run db:migrate` - Apply migrations
- `bun --bun run db:push` - Push schema directly to DB
- `bun --bun run db:pull` - Pull schema from DB
- `bun --bun run db:studio` - Open Drizzle Studio

## Production Notes

- Set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` explicitly in production.
- Ensure your production Postgres is reachable from the app runtime.
- Build with:

```bash
bun --bun run build
```

- Run with:

```bash
bun --bun run start
```
