# PRCS Attendance Management System

Internal attendance system for PRCS: biometric punches from a ZKTeco uFace800, Excel imports,
daily/monthly attendance, leave and NOC workflows with approval routing, and salary-ready reports.

## Stack

| Area | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router) + React 19 |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4 |
| Database | PostgreSQL via Prisma 7 (`@prisma/adapter-pg`) |
| Auth | Custom JWT session cookie (`jose`, HS256, 8 h) |
| Validation | Zod |
| Device | ZKTeco poller (`@graphland/zkteco`) |

## Requirements

- Node.js 20+
- PostgreSQL 14+
- PostgreSQL client tools (`pg_dump`) if you want `npm run backup`
- Network access to the biometric device for live sync

## Setup

```bash
npm install

# 1. Configuration
cp .env.example .env        # then fill in DATABASE_URL, SESSION_SECRET, seed admin, device IP

# 2. Database
npm run db:migrate          # apply all migrations
npm run db:seed             # create system roles and the first Admin account

# 3. Run (web + device poller together)
npm run dev
```

Open <http://localhost:3000> and sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.
Unless `SEED_ADMIN_MUST_CHANGE_PASSWORD=false`, the first sign-in forces a password change.

### Environment

See `.env.example` for every variable. The important ones:

- `DATABASE_URL` – PostgreSQL connection string.
- `SESSION_SECRET` – at least 32 characters; signs the session cookie. Rotating it signs everyone out.
- `SEED_*` – the bootstrap Admin. `SEED_RESET_ADMIN_PASSWORD=true` overwrites the existing
  Admin password on the next seed, so leave it `false` outside deliberate resets.
- `ZK_*` – `ZK_DEVICES` (JSON list of `{id, ip, port, commKey}`) for one or more devices,
  `ZK_DEVICE_*` for a single device, plus poll interval and clock mode.
- `OFFICE_TIMEZONE` – timezone used for attendance dates and rules (default: server timezone).
- `COOKIE_SECURE=false` – only for plain-HTTP deployments on an office LAN.
- `ENABLE_HSTS=true` – only when the site is served over HTTPS.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next dev server + ZKTeco poller (`concurrently`) |
| `npm run dev:web` | Next dev server only |
| `npm run sync` | ZKTeco poller only |
| `npm run build` | Generate Prisma client and build for production |
| `npm start` | Serve the production build (**does not** start the poller) |
| `npm run lint` | ESLint |
| `npm test` | Type-level/assertion checks in `lib/**/*.check.mts` |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:migrate` | Apply pending migrations (`prisma migrate deploy`) |
| `npm run db:seed` | Create system roles and the seed Admin |
| `npm run backup` | `pg_dump` the database into `backups/` |

## Production notes

1. `npm ci && npm run build`
2. `npm run db:migrate` (and `npm run db:seed` on first install only)
3. `npm start` on a process manager (PM2, Windows service, systemd…)
4. Run the device poller as a **separate** long-lived process: `npm run sync`.
   `npm start` only serves the web app; without the poller no new punches arrive.
   The poller must run on a machine that can reach the devices on the office LAN
   (ZKTeco pulls over TCP, default port 4370). It writes straight to `DATABASE_URL`,
   so on Vercel or another host the web app and the office poller can share one Neon
   database; the web host itself can never reach the devices.
5. Multiple devices: set `ZK_DEVICES` to a JSON list. Every device gets its own heartbeat
   row, and the dashboard shows the weakest one, so a single unreachable machine cannot
   hide behind healthy ones.
6. Schedule `npm run backup` (for example nightly) and keep copies off the server.
   NOC documents are stored as `bytea` in PostgreSQL, so a database backup is also their only backup.

Changing or resetting a password bumps `User.sessionVersion`; every session issued with the old
password is rejected immediately, including Admin password resets and the seeded Admin reset.

## Access model

Two independent layers decide what a person sees:

1. **Role permissions** (`lib/auth/permissions.ts`) – `ADMIN`, `HR`, `IT_OFFICER`, `EMPLOYEE`,
   editable on the Roles page. Admin always holds every permission defined in code.
2. **Designation approval level** (`STAFF → DD → CEO → CHAIRMAN`, `lib/leave/approval-routing.ts`) –
   drives leave/NOC approval routing and, together with the role, the data scope.

Data scope (`lib/auth/data-scope.ts`) is `ALL`, `DEPARTMENT` (a DD, including additional charges)
or `SELF`. Reports are readable by anyone with a department/organization scope; PDF/CSV export
needs `reports:export` or one of the senior designation levels.

## Attendance data conventions

- Dates are stored as `@db.Date` at UTC midnight and handled through
  `lib/attendance/office-clock.ts` and `lib/attendance/dates.ts`. Do not use raw local-time
  `Date` math when grouping days, or reports will shift by a day across timezones.
- The rules engine lives in `lib/attendance/attendance-rules.ts`; shift times, grace, half-day,
  overtime and short-leave settings come from `AttendanceSettings` (Rules page).
- Excel import and the device poller both feed `Attendance` through the roster/leave-sync logic in
  `lib/attendance/`.

## Project layout

```
app/(auth)            login, change password
app/(dashboard)       dashboard pages (attendance, employees, leaves, NOC, reports, admin)
app/api               login/logout, attendance import, report export, NOC documents
components             UI, shell/navigation, forms
lib/attendance        dates, office clock, rules, roster, import, leave sync
lib/auth              jwt, session, authorization, permissions, data scope
lib/reports           report types, columns, CSV/PDF rendering
services              data access and business rules (server-only)
prisma                schema, migrations, seed, ERD
scripts               ZKTeco poller, backup, diagnostics
```

## Before deploying

- Rotate `SESSION_SECRET`, the database password and the seed Admin password if they were ever
  shared (a `.env` file that left the server counts as shared).
- Keep `SEED_RESET_ADMIN_PASSWORD=false` except during a planned reset.
- Put the app behind HTTPS and set `ENABLE_HSTS=true`; the session cookie is `Secure` in production
  unless `COOKIE_SECURE=false`.
- Verify `npm test`, `npm run lint` and `npm run build` pass.
