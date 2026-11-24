# Stadium Ticketing - Part 1: Database + design prototype

## Contents
- supabase/migrations/0001_schema.sql  tables, constraints, indexes, RLS
- supabase/migrations/0002_functions.sql  atomic booking (adjacent seats), payment confirmation, QR check-in, open-entry counter
- frontend-prototype/index.html  design (light/dark, Somali/English), mock booking, admin text/footer CRUD
- .env.example

## Setup
1. Create a Supabase project, then run both migrations in order (SQL editor, or `supabase db push`).
2. Register a user, then make them super admin:
   update profiles set role='super_admin' where id='<user uuid>';
3. Log in as super admin, open /admin and create: Stadium, Teams, Sections, Matches, then "Prices & capacity" per match (run migrations 0001-0004 in order; 0003 = image storage, 0004 = match cancellation and refunds).

## Seat rules
Numbered sections hand a group an adjacent block in ONE row (e.g. VIP-R1-S05..S09). If none exists, reserve_booking raises NO_ADJACENT_SEATS.
Unique index on booking_seats(match_section_id, seat_no) makes double-booking impossible, even under concurrency.

## Payments
Tickets exist only after confirm_payment (admin verification or a provider webhook using the service-role key). Mock now; live API later.
Note: a payment confirmed after the hold expires is rejected (RESERVATION_EXPIRED) and must be refunded or re-booked.

## Schedule expiry (pg_cron)
select cron.schedule('expire-holds','* * * * *','select expire_reservations()');

## Part 2: backend/ (Express + TypeScript, type-checked). See backend/API.md

## Part 3: frontend/ (React + TS + Tailwind, builds clean)
Customer site: matches, booking (adjacent seats), mock pay, QR tickets, contact, login, EN/SO, light/dark, admin-editable text and footer links.
Gate scanner (camera QR + manual code, VALID/ALREADY USED/INVALID/CANCELLED, open-entry counter) at /gate; Admin (stats, manual payment verification) at /admin. Nav links show by role.
Admin tabs: Matches, Prices & capacity, Sections (image upload), Teams (optional logo), Stadiums, Footer links, Site text (EN/SO).
Run: cd frontend && cp .env.example .env && npm install && npm run dev

## PDF tickets, reports, cancellation, refunds
- Customer: PDF button on each ticket (/api/tickets/:id/pdf). The QR holds only the random token. Cancelled/refunded tickets cannot be downloaded.
- Admin > Reports: summary, sales, free, attendance, payments, refunds as CSV or PDF, with optional date range. Currencies are never mixed. CSV cells are protected against formula injection.
- Admin > Cancel & refunds: cancelling a match cancels valid tickets and releases unpaid holds; refunds are recorded per payment (full refund). Return the money through the payment provider, then record it.

## Automated tests (seats, scanning, payments, open entry)
supabase/tests/run.test.mjs runs the real migrations (0001, 0002, 0004) on a throw-away Postgres and uses true parallel connections:
- group of N gets adjacent seats in ONE row; never split across rows; NO_ADJACENT_SEATS when only scattered seats remain
- capacity never exceeded; 20 parallel buyers on 10 seats -> exactly 10 win, no shared seat; parallel groups stay adjacent
- no tickets before verified payment; price frozen at purchase; late payment after hold expiry rejected
- 10 gates scan one QR at the same instant -> exactly one VALID; invalid / cancelled / refunded results; customers cannot scan
- refunds blocked for used tickets; open entry stops at capacity, corrections need admin, 10 parallel clicks on capacity 5 -> exactly 5
Run: cd supabase/tests && npm install && npm test
(Embedded Postgres refuses to run as root. As root, start any Postgres 15+ on port 54329 with user postgres / password pw and run: PG_EXTERNAL=1 npm test)
Not covered: Supabase Auth/RLS policies (auth is stubbed, tests run as superuser) and 0003 storage. Test those on a real Supabase project.

## Next parts (not included yet)
email notifications, PWA, charts, RLS tests on a real Supabase project.
