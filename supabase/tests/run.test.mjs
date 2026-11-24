// Runs the REAL migrations on a throw-away Postgres and attacks seat booking, check-in and open entry
// with true parallel connections. Supabase's auth schema is stubbed (auth.users, auth.uid(), auth.role()).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

const PORT = 54329, cfg = { host: '127.0.0.1', port: PORT, user: 'postgres', password: 'pw', database: 'stadium' };
const mig = (f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');
const STUB = `do $$ begin create role anon; exception when duplicate_object then null; end $$; do $$ begin create role authenticated; exception when duplicate_object then null; end $$; create schema auth;
create table auth.users(id uuid primary key default gen_random_uuid(), raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true),''),'authenticated') $$;`;
let server, su, stad, M1; const open = [];
const q = (c, sql, p = []) => c.query(sql, p).then((r) => r.rows);
const fail = (pr) => pr.then(() => null, (e) => e.message);
async function as(uid) { const c = new pg.Client(cfg); await c.connect(); await c.query("select set_config('request.jwt.claim.sub',$1,false)", [uid]); open.push(c); return c; }
async function user(role = 'customer') { const id = (await q(su, 'insert into auth.users default values returning id'))[0].id; if (role !== 'customer') await q(su, 'update profiles set role=$2 where id=$1', [id, role]); return id; }
const crowd = (n, role) => Promise.all(Array.from({ length: n }, async () => as(await user(role))));
const bye = (cs) => Promise.all(cs.map((c) => c.end()));
async function mkMatch() { const t = await q(su, 'insert into teams(name) values($1),($2) returning id', ['A' + Math.random(), 'B' + Math.random()]);
  return (await q(su, "insert into matches(stadium_id,title,home_team_id,away_team_id,kickoff) values($1,'M',$2,$3,now()+interval '1 day') returning id", [stad, t[0].id, t[1].id]))[0].id; }
async function ms(cap, o = {}) { const s = (await q(su, 'insert into sections(stadium_id,name,capacity,row_size,numbered) values($1,$2,$3,$4,$5) returning id', [stad, 'S' + Math.random(), cap, o.row ?? 10, o.numbered ?? true]))[0].id;
  return (await q(su, 'insert into match_sections(match_id,section_id,price,capacity,mode) values($1,$2,$3,$4,$5) returning id', [o.match ?? M1, s, o.price ?? 0, cap, o.mode ?? (o.price ? 'paid' : 'free_booking')]))[0].id; }
const book = (c, id, n) => q(c, 'select reserve_booking($1,$2,$3,$4) as id', [id, n, 'Test', '611111111']).then((r) => r[0].id);
const seats = async (id, booking) => (await q(su, `select seat_no from booking_seats where match_section_id=$1 ${booking ? 'and booking_id=$2' : ''} order by seat_no`, booking ? [id, booking] : [id])).map((r) => r.seat_no);
const adjacent = (s, row) => s.every((x, i) => i === 0 || x === s[i - 1] + 1) && new Set(s.map((x) => Math.floor((x - 1) / row))).size === 1;
const scan = async (c, token) => (await q(c, 'select check_in($1,null) as r', [token]))[0].r;
const tokenOf = async (b) => (await q(su, 'select token from tickets where booking_id=$1', [b]))[0].token;

before(async () => {
  if (process.env.PG_EXTERNAL) { const a = new pg.Client({ ...cfg, database: 'postgres' }); await a.connect(); await a.query('drop database if exists stadium with (force)'); await a.query('create database stadium'); await a.end(); }
  else { // default: throw-away embedded Postgres. Set PG_EXTERNAL=1 to use a server already running on PORT (user postgres, password pw); the 'stadium' database is recreated each run
    server = new EmbeddedPostgres({ databaseDir: '/tmp/stadium-pg-' + process.pid, user: 'postgres', password: 'pw', port: PORT, persistent: false, createPostgresUser: true });
    await server.initialise(); await server.start(); await server.createDatabase('stadium');
  }
  su = new pg.Client(cfg); await su.connect(); await su.query(STUB);
  for (const f of ['0001_schema.sql', '0002_functions.sql', '0004_cancel_refund.sql']) await su.query(mig(f));
  stad = (await q(su, "insert into stadiums(name) values('S') returning id"))[0].id; M1 = await mkMatch();
});
after(async () => { for (const c of open) await c.end().catch(() => {}); await su?.end(); await server?.stop(); });

// ---------- SEATS ----------
test('a group of 5 gets 5 adjacent seats in one row', async () => {
  const id = await ms(40); const [c] = await crowd(1); const b = await book(c, id, 5);
  const s = await seats(id, b); assert.equal(s.length, 5); assert.ok(adjacent(s, 10), `seats ${s}`);
});
test('a group never splits across rows: skips to the next row', async () => {
  const id = await ms(40); const [c] = await crowd(1); await book(c, id, 7);
  const b = await book(c, id, 5); assert.deepEqual(await seats(id, b), [11, 12, 13, 14, 15]);
});
test('free seats exist but none adjacent -> NO_ADJACENT_SEATS (single still works)', async () => {
  const id = await ms(20); const [c] = await crowd(1); for (let i = 0; i < 20; i++) await book(c, id, 1);
  await q(su, 'with d as (delete from booking_seats where match_section_id=$1 and seat_no%4=0 returning booking_id), t as (update tickets set status=\'cancelled\' where match_section_id=$1 and seat_no%4=0 returning 1) update bookings set status=\'cancelled\' where id in (select booking_id from d)', [id]); // cancelling a booking = cancel its tickets + free its seats
  assert.equal(await fail(book(c, id, 2)), 'NO_ADJACENT_SEATS'); assert.ok(await book(c, id, 1));
});
test('capacity is never exceeded', async () => {
  const id = await ms(10); const [c] = await crowd(1); await book(c, id, 6);
  assert.equal(await fail(book(c, id, 6)), 'SOLD_OUT'); assert.equal(await fail(book(c, id, 0)), 'BAD_QUANTITY');
});
test('open-entry sections cannot be booked online', async () => {
  const id = await ms(10, { mode: 'open_entry', numbered: false }); const [c] = await crowd(1);
  assert.equal(await fail(book(c, id, 1)), 'OPEN_ENTRY_NO_BOOKING');
});
test('20 parallel buyers fight for 10 seats: exactly 10 win, no seat shared', async () => {
  const id = await ms(10); const cs = await crowd(20);
  const r = await Promise.allSettled(cs.map((c) => book(c, id, 1)));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 10);
  assert.ok(r.filter((x) => x.status === 'rejected').every((x) => x.reason.message === 'SOLD_OUT'));
  const s = await seats(id); assert.equal(new Set(s).size, 10); await bye(cs);
});
test('parallel groups of 2 on 10 seats: 5 win, every group adjacent, no overlap', async () => {
  const id = await ms(10); const cs = await crowd(6);
  const r = await Promise.allSettled(cs.map((c) => book(c, id, 2)));
  const won = r.filter((x) => x.status === 'fulfilled'); assert.equal(won.length, 5);
  for (const w of won) assert.ok(adjacent(await seats(id, w.value), 10));
  assert.equal(new Set(await seats(id)).size, 10); await bye(cs);
});

// ---------- PAYMENTS ----------
test('no tickets before verified payment; price is frozen at purchase', async () => {
  const id = await ms(10, { price: 10 }); const [c] = await crowd(1); const [a] = await crowd(1, 'stadium_admin'); const b = await book(c, id, 3);
  assert.equal((await q(su, 'select count(*)::int n from tickets where booking_id=$1', [b]))[0].n, 0);
  const pay = (await q(su, 'select id, amount from payments where booking_id=$1', [b]))[0]; assert.equal(Number(pay.amount), 30);
  assert.equal(await fail(q(c, 'select confirm_payment($1,$2,$3)', [pay.id, 'EVC', 'REF1'])), 'FORBIDDEN');
  await q(a, 'select confirm_payment($1,$2,$3)', [pay.id, 'EVC', 'REF1']);
  await q(su, 'update match_sections set price=99 where id=$1', [id]);
  const t = await q(su, 'select token, price, seat_code from tickets where booking_id=$1', [b]);
  assert.equal(t.length, 3); assert.equal(new Set(t.map((x) => x.token)).size, 3); assert.ok(t.every((x) => Number(x.price) === 10 && x.token.length === 48 && x.seat_code));
  assert.equal(await fail(q(a, 'select confirm_payment($1,$2,$3)', [pay.id, 'EVC', 'REF2'])), 'PAYMENT_NOT_PENDING');
});
test('expired hold: late payment is rejected and seats are released', async () => {
  const id = await ms(10, { price: 5 }); const [c] = await crowd(1); const [a] = await crowd(1, 'stadium_admin'); const b = await book(c, id, 2);
  await q(su, "update bookings set expires_at=now()-interval '1 minute' where id=$1", [b]);
  const pay = (await q(su, 'select id from payments where booking_id=$1', [b]))[0].id;
  assert.equal(await fail(q(a, 'select confirm_payment($1,$2,$3)', [pay, 'EVC', 'LATE'])), 'RESERVATION_EXPIRED');
  await q(su, 'select expire_reservations()'); assert.equal((await seats(id)).length, 0);
  assert.equal((await q(su, 'select status from payments where id=$1', [pay]))[0].status, 'failed');
});

// ---------- SCANNING ----------
test('valid once, then ALREADY USED; unknown token is invalid; customers cannot scan', async () => {
  const id = await ms(10); const [c] = await crowd(1); const [g] = await crowd(1, 'gate_staff'); const tok = await tokenOf(await book(c, id, 1));
  assert.equal((await scan(g, tok)).result, 'valid'); assert.equal((await scan(g, tok)).result, 'already_used');
  assert.equal((await scan(g, 'nope')).result, 'invalid'); assert.equal(await fail(scan(c, tok)), 'FORBIDDEN');
  assert.equal((await q(su, "select count(*)::int n from ticket_scans where token_tail=$1", [tok.slice(-6)]))[0].n, 2);
});
test('10 gates scan the same QR at the same instant: exactly one VALID', async () => {
  const id = await ms(10); const [c] = await crowd(1); const tok = await tokenOf(await book(c, id, 1)); const gs = await crowd(10, 'gate_staff');
  const r = (await Promise.all(gs.map((g) => scan(g, tok)))).map((x) => x.result);
  assert.equal(r.filter((x) => x === 'valid').length, 1); assert.equal(r.filter((x) => x === 'already_used').length, 9);
  assert.equal((await q(su, "select count(*)::int n from ticket_scans where token_tail=$1", [tok.slice(-6)]))[0].n, 10); await bye(gs);
});
test('cancelled match -> CANCELLED; refunded payment -> REFUNDED; used tickets cannot be refunded', async () => {
  const M2 = await mkMatch(); const id = await ms(10, { match: M2 }); const [c] = await crowd(1); const [g] = await crowd(1, 'gate_staff'); const [a] = await crowd(1, 'stadium_admin');
  const tok = await tokenOf(await book(c, id, 1)); await q(a, 'select cancel_match($1)', [M2]); assert.equal((await scan(g, tok)).result, 'cancelled');
  const id2 = await ms(10, { price: 4 }); const b2 = await book(c, id2, 1); const p2 = (await q(su, 'select id from payments where booking_id=$1', [b2]))[0].id;
  await q(a, 'select confirm_payment($1,$2,$3)', [p2, 'EVC', 'R9']); const t2 = await tokenOf(b2);
  await q(a, "select refund_payment($1,'test')", [p2]); assert.equal((await scan(g, t2)).result, 'refunded');
  assert.equal(await fail(q(a, "select refund_payment($1,'again')", [p2])), 'PAYMENT_NOT_PAID');
  const b3 = await book(c, id2, 1); const p3 = (await q(su, 'select id from payments where booking_id=$1', [b3]))[0].id;
  await q(a, 'select confirm_payment($1,$2,$3)', [p3, 'EVC', 'R10']); await scan(g, await tokenOf(b3));
  assert.equal(await fail(q(a, "select refund_payment($1,'x')", [p3])), 'TICKETS_USED');
});

// ---------- OPEN ENTRY ----------
test('open entry stops at capacity; corrections need admin; never below zero', async () => {
  const id = await ms(3, { mode: 'open_entry', numbered: false }); const [g] = await crowd(1, 'gate_staff'); const [a] = await crowd(1, 'stadium_admin');
  for (let i = 0; i < 3; i++) await q(g, 'select open_entry_add($1,1)', [id]);
  assert.equal(await fail(q(g, 'select open_entry_add($1,1)', [id])), 'CAPACITY_REACHED');
  assert.equal(await fail(q(g, 'select open_entry_add($1,-1)', [id])), 'FORBIDDEN');
  assert.equal((await q(a, 'select open_entry_add($1,-1) as n', [id]))[0].n, 2);
  assert.equal(await fail(q(a, 'select open_entry_add($1,-10)', [id])), 'BAD_COUNT');
});
test('10 parallel gate clickers on capacity 5: exactly 5 get in', async () => {
  const id = await ms(5, { mode: 'open_entry', numbered: false }); const gs = await crowd(10, 'gate_staff');
  const r = await Promise.allSettled(gs.map((g) => q(g, 'select open_entry_add($1,1)', [id])));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 5);
  assert.equal((await q(su, 'select occupancy from entry_counts where match_section_id=$1', [id]))[0].occupancy, 5); await bye(gs);
});
