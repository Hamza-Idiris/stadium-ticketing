import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

const { SUPABASE_URL = '', SUPABASE_ANON_KEY = '', SUPABASE_SERVICE_ROLE_KEY = '', CORS_ORIGIN = 'http://localhost:5173', PORT = '4000', MOCK_PAYMENTS = 'false' } = process.env;
const opts = { auth: { persistSession: false } };
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, opts); // service role: server only
const pub = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, opts);

interface Ctx extends Request { db?: SupabaseClient; uid?: string; role?: string }
const db = (r: Request) => (r as Ctx).db!;
const CONFLICT = ['SOLD_OUT', 'NO_ADJACENT_SEATS', 'CAPACITY_REACHED', 'RESERVATION_EXPIRED', 'PAYMENT_NOT_PENDING', 'PAYMENT_NOT_PAID', 'TICKETS_USED'];
function sendError(res: Response, e: { message?: string }) {
  const m = e.message ?? 'ERROR';
  const code = m === 'FORBIDDEN' ? 403 : m === 'LOGIN_REQUIRED' ? 401 : CONFLICT.includes(m) ? 409 : /^[A-Z_]+$/.test(m) ? 400 : 500;
  if (code === 500) console.error(e);
  res.status(code).json({ error: code === 500 ? 'SERVER_ERROR' : m });
}
const bad = (res: Response) => res.status(400).json({ error: 'INVALID_INPUT' });

// Authenticates the JWT and gives each request a Supabase client acting AS the user (RLS + auth.uid() apply).
const auth = (...roles: string[]) => async (req: Request, res: Response, next: NextFunction) => {
  const r = req as Ctx;
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  const { data: u } = await admin.auth.getUser(token);
  if (!u.user) return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  r.db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { ...opts, global: { headers: { Authorization: `Bearer ${token}` } } });
  r.uid = u.user.id;
  const { data: role } = await r.db.rpc('my_role');
  r.role = (role as string) ?? 'customer';
  if (roles.length && !roles.includes(r.role)) return res.status(403).json({ error: 'FORBIDDEN' });
  next();
};
const ADMIN = auth('super_admin', 'stadium_admin');
const GATE = auth('gate_staff', 'stadium_admin', 'super_admin');
const optAuth = async (req: Request, _res: Response, next: NextFunction) => {
  const r = req as Ctx;
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    const { data: u } = await admin.auth.getUser(token).catch(() => ({ data: { user: null } }));
    if (u?.user) {
      r.db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { ...opts, global: { headers: { Authorization: `Bearer ${token}` } } });
      r.uid = u.user.id;
    }
  }
  next();
};

const app = express();
app.set('trust proxy', 1);
app.use(helmet(), cors({ origin: CORS_ORIGIN.split(',') }), express.json({ limit: '100kb' }), rateLimit({ windowMs: 60_000, limit: 120 }));
const strict = rateLimit({ windowMs: 60_000, limit: 10 });

app.get('/api/health', (_q, r) => { r.json({ ok: true }); });

// ---- Public ----
app.get('/api/matches', async (_q, res) => {
  const { data, error } = (await pub.from('matches')
    .select('*, home:teams!home_team_id(name,logo_url), away:teams!away_team_id(name,logo_url), stadium:stadiums(name), match_sections(id,price,currency,capacity,mode,active, section:sections(name,description,image_url,numbered,display_order))')
    .in('status', ['upcoming', 'live']).order('kickoff')) as any;
  if (error) return sendError(res, error);
  const [b, e] = await Promise.all([
    admin.from('bookings').select('match_section_id, qty').in('status', ['reserved', 'confirmed']),
    admin.from('entry_counts').select('match_section_id, occupancy')]);
  const sold: Record<string, number> = {}, occ: Record<string, number> = {};
  (b.data ?? []).forEach((x: any) => { sold[x.match_section_id] = (sold[x.match_section_id] ?? 0) + x.qty; });
  (e.data ?? []).forEach((x: any) => { occ[x.match_section_id] = x.occupancy; });
  res.json((data ?? []).map((m: any) => ({ ...m, match_sections: m.match_sections.filter((s: any) => s.active)
    .map((s: any) => ({ ...s, remaining: Math.max(0, s.capacity - (s.mode === 'open_entry' ? occ[s.id] ?? 0 : sold[s.id] ?? 0)) })) })));
});

app.get('/api/site', async (_q, res) => {
  const [t, l] = await Promise.all([pub.from('site_texts').select('*'), pub.from('footer_links').select('*').order('sort')]);
  res.json({ texts: t.data ?? [], links: l.data ?? [] });
});

const Contact = z.object({ topic: z.enum(['error', 'question']), name: z.string().min(1).max(100), contact: z.string().min(3).max(120), message: z.string().min(3).max(2000) });
app.post('/api/contact', strict, async (req, res) => {
  const p = Contact.safeParse(req.body); if (!p.success) return bad(res);
  const { error } = await pub.from('contact_messages').insert(p.data);
  if (error) return sendError(res, error);
  res.status(201).json({ ok: true });
});

// ---- Customer / Guest ----
const Book = z.object({ matchSectionId: z.string().uuid(), qty: z.number().int().min(1).max(50), name: z.string().min(2).max(100), phone: z.string().min(6).max(25) });
app.post('/api/bookings', strict, optAuth, async (req, res) => {
  const p = Book.safeParse(req.body); if (!p.success) return bad(res);
  const client = (req as Ctx).db ?? admin;
  const { data, error } = await client.rpc('reserve_booking', { p_ms: p.data.matchSectionId, p_qty: p.data.qty, p_name: p.data.name, p_phone: p.data.phone });
  if (error) return sendError(res, error);
  if ((req as Ctx).uid && data) {
    await admin.from('bookings').update({ user_id: (req as Ctx).uid }).eq('id', data);
  }
  res.status(201).json({ bookingId: data });
});

app.get('/api/bookings/:id', async (req, res) => {
  const { data, error } = await admin.from('bookings')
    .select('*, match_sections(price,currency,sections(name),matches(title,kickoff,stadiums(name),home:teams!home_team_id(name),away:teams!away_team_id(name))), payments(id,status,amount,currency), tickets(id,seat_code,token,status,holder_name)')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return sendError(res, error);
  if (!data) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json(data);
});

app.get('/api/bookings/mine', auth(), async (req, res) => {
  const { data, error } = await db(req).from('bookings')
    .select('*, payments(id,status,amount,currency), tickets(id,seat_code,token,status,holder_name)')
    .eq('user_id', (req as Ctx).uid!).order('created_at', { ascending: false });
  if (error) return sendError(res, error);
  res.json(data);
});

// MOCK payment (dev only). Replace with a provider webhook that calls confirm_payment after verifying the transaction.
app.post('/api/bookings/:id/mock-pay', strict, optAuth, async (req, res) => {
  if (MOCK_PAYMENTS !== 'true') return res.status(404).json({ error: 'NOT_FOUND' });
  const { data: pay } = (await admin.from('payments').select('id, bookings!inner(user_id)').eq('booking_id', req.params.id).eq('status', 'pending').maybeSingle()) as any;
  if (!pay) return res.status(404).json({ error: 'NOT_FOUND' });
  const uid = (req as Ctx).uid;
  if (pay.bookings?.user_id && uid && pay.bookings.user_id !== uid) return res.status(403).json({ error: 'FORBIDDEN' });
  const { error } = await admin.rpc('confirm_payment', { p_payment: pay.id, p_method: 'MOCK', p_ref: `MOCK-${randomUUID()}` });
  if (error) return sendError(res, error);
  const { data: t } = await admin.from('tickets').select('id, seat_code, token, status, holder_name').eq('booking_id', req.params.id);
  res.json({ ok: true, tickets: t ?? [] });
});

app.get('/api/me', auth(), (req, res) => { res.json({ role: (req as Ctx).role }); });

// ---- Staff ----
const Confirm = z.object({ method: z.string().min(2).max(30), ref: z.string().min(3).max(80) });
app.post('/api/payments/:id/confirm', ADMIN, async (req, res) => {
  const p = Confirm.safeParse(req.body); if (!p.success) return bad(res);
  const { error } = await db(req).rpc('confirm_payment', { p_payment: req.params.id, p_method: p.data.method, p_ref: p.data.ref });
  if (error) return sendError(res, error);
  res.json({ ok: true });
});

const Scan = z.object({ token: z.string().min(6).max(200), gateId: z.string().uuid().nullish() });
app.post('/api/scan', GATE, async (req, res) => {
  const p = Scan.safeParse(req.body); if (!p.success) return bad(res);
  const { data, error } = await db(req).rpc('check_in', { p_token: p.data.token.trim(), p_gate: p.data.gateId ?? null });
  if (error) return sendError(res, error);
  res.json(data);
});

const Entry = z.object({ matchSectionId: z.string().uuid(), delta: z.number().int().min(-50).max(50).refine((n) => n !== 0), reason: z.string().max(200).optional() });
app.post('/api/open-entry', GATE, async (req, res) => {
  const p = Entry.safeParse(req.body); if (!p.success) return bad(res);
  const { data, error } = await db(req).rpc('open_entry_add', { p_ms: p.data.matchSectionId, p_delta: p.data.delta, p_reason: p.data.reason ?? null });
  if (error) return sendError(res, error);
  res.json({ occupancy: data });
});

// ---- Admin ----
app.get('/api/admin/stats', ADMIN, async (req, res) => {
  const d = db(req);
  const [t, p, m] = await Promise.all([d.from('tickets').select('status,price,currency'),
    d.from('payments').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    d.from('matches').select('id', { count: 'exact', head: true })]);
  const revenue: Record<string, number> = {}; let paid = 0, free = 0, used = 0;
  ((t.data ?? []) as any[]).forEach((x) => { if (+x.price > 0) { paid++; revenue[x.currency] = (revenue[x.currency] ?? 0) + +x.price; } else free++; if (x.status === 'used') used++; });
  res.json({ matches: m.count, paidTickets: paid, freeTickets: free, usedTickets: used, revenue, pendingPayments: p.count });
});

app.get('/api/admin/payments/pending', ADMIN, async (req, res) => {
  const { data, error } = await db(req).from('payments').select('id, amount, currency, created_at, bookings(customer_name, customer_phone, qty, expires_at)').eq('status', 'pending').order('created_at');
  if (error) return sendError(res, error); res.json(data);
});

app.delete('/api/admin/site_texts/:key/:lang', ADMIN, async (req, res) => {
  const { error } = await db(req).from('site_texts').delete().eq('key', req.params.key).eq('lang', req.params.lang);
  if (error) return sendError(res, error); res.json({ ok: true });
});

// ---- PDF ticket (owner, guest, or admin) ----
app.get('/api/tickets/:id/pdf', async (req, res) => {
  const { data: k } = (await admin.from('tickets').select('id, seat_code, token, status, holder_name, match_sections(sections(name), matches(title, kickoff, stadiums(name), home:teams!home_team_id(name), away:teams!away_team_id(name)))').eq('id', req.params.id).maybeSingle()) as any;
  if (!k) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!['valid', 'used'].includes(k.status)) return res.status(409).json({ error: 'TICKET_NOT_VALID' });
  const m = k.match_sections.matches;
  const png = await QRCode.toBuffer(k.token, { width: 320, margin: 1 }); // QR holds only the random token
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="ticket-${String(k.seat_code ?? k.id).slice(0, 20)}.pdf"`);
  const doc = new PDFDocument({ size: [400, 700], margin: 28 }); doc.pipe(res);
  doc.rect(0, 0, 400, 80).fill('#0a8f5b'); doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('Garoonka Tickets', 28, 28);
  doc.fillColor('#0e1a14').fontSize(20).text(`${m.home.name} vs ${m.away.name}`, 28, 104, { width: 344 });
  doc.font('Helvetica').fontSize(11).fillColor('#5b6b62').text(m.title).text(new Date(m.kickoff).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })).text(m.stadiums?.name ?? '');
  doc.moveDown(1).fillColor('#0e1a14').font('Helvetica-Bold').fontSize(16).text(`${k.match_sections.sections.name}${k.seat_code ? ' · ' + k.seat_code : ''}`)
    .font('Helvetica').fontSize(11).text(k.holder_name);
  doc.image(png, 40, 300, { width: 320 });
  doc.font('Courier').fontSize(7).fillColor('#5b6b62').text(k.token, 28, 630, { width: 344, align: 'center' });
  doc.font('Helvetica').text('Valid for one entry. Do not share this QR code.', 28, 650, { width: 344, align: 'center' });
  doc.end();
});

// ---- Cancel match / refunds ----
app.post('/api/admin/matches/:id/cancel', ADMIN, async (req, res) => {
  const { error } = await db(req).rpc('cancel_match', { p_match: req.params.id });
  if (error) return sendError(res, error); res.json({ ok: true });
});
app.post('/api/payments/:id/refund', ADMIN, async (req, res) => {
  const p = z.object({ reason: z.string().min(3).max(200) }).safeParse(req.body); if (!p.success) return bad(res);
  const { error } = await db(req).rpc('refund_payment', { p_payment: req.params.id, p_reason: p.data.reason });
  if (error) return sendError(res, error); res.json({ ok: true });
});
app.get('/api/admin/payments/paid', ADMIN, async (req, res) => {
  const { data, error } = await db(req).from('payments').select('id, amount, currency, method, provider_ref, created_at, bookings(customer_name, customer_phone, qty, match_sections(matches(title, status)))').eq('status', 'paid').order('created_at', { ascending: false }).limit(200);
  if (error) return sendError(res, error); res.json(data);
});

// ---- Reports (CSV or PDF) ----
async function fetchAll(mk: (a: number, b: number) => any): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < 50; i++) { const { data, error } = await mk(i * 1000, i * 1000 + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break; }
  return out;
}
const TK = 'id, seat_code, holder_name, price, currency, status, used_at, created_at, match_sections(sections(name), matches(title))';
const TKC = ['ticket_id', 'match', 'section', 'seat', 'holder', 'price', 'currency', 'status', 'used_at', 'created_at'];
const tickets = (d: SupabaseClient, f: (q: any) => any, from?: string, to?: string) => fetchAll((a, b) => {
  let q = f(d.from('tickets').select(TK).order('created_at')); if (from) q = q.gte('created_at', from); if (to) q = q.lte('created_at', to); return q.range(a, b); });
const tk = (r: any) => [r.id, r.match_sections?.matches?.title, r.match_sections?.sections?.name, r.seat_code, r.holder_name, r.price, r.currency, r.status, r.used_at, r.created_at];
type Rep = (d: SupabaseClient, from?: string, to?: string) => Promise<{ cols: string[]; rows: unknown[][] }>;
const REPORTS: Record<string, Rep> = {
  sales: async (d, f, t) => ({ cols: TKC, rows: (await tickets(d, (q) => q.gt('price', 0), f, t)).map(tk) }),
  free: async (d, f, t) => ({ cols: TKC, rows: (await tickets(d, (q) => q.eq('price', 0), f, t)).map(tk) }),
  attendance: async (d, f, t) => ({ cols: TKC, rows: (await tickets(d, (q) => q.eq('status', 'used'), f, t)).map(tk) }),
  summary: async (d, f, t) => { // per match + section + currency (currencies are never mixed)
    const g: Record<string, any> = {};
    for (const r of await tickets(d, (q) => q, f, t)) {
      const k = [r.match_sections?.matches?.title, r.match_sections?.sections?.name, r.currency].join('|');
      const x = (g[k] ??= { m: r.match_sections?.matches?.title, s: r.match_sections?.sections?.name, c: r.currency, sold: 0, free: 0, used: 0, refunded: 0, cancelled: 0, rev: 0 });
      if (r.status === 'refunded') x.refunded++; else if (r.status === 'cancelled') x.cancelled++;
      else { x.sold++; if (+r.price === 0) x.free++; else x.rev += +r.price; if (r.status === 'used') x.used++; }
    }
    return { cols: ['match', 'section', 'currency', 'tickets_sold', 'of_which_free', 'used', 'refunded', 'cancelled', 'revenue'], rows: Object.values(g).map((x) => [x.m, x.s, x.c, x.sold, x.free, x.used, x.refunded, x.cancelled, x.rev]) };
  },
  payments: async (d, f, t) => ({ cols: ['payment_id', 'customer', 'phone', 'amount', 'currency', 'status', 'method', 'reference', 'verified_at', 'created_at'],
    rows: (await fetchAll((a, b) => { let q = d.from('payments').select('id, amount, currency, status, method, provider_ref, verified_at, created_at, bookings(customer_name, customer_phone)').order('created_at'); if (f) q = q.gte('created_at', f); if (t) q = q.lte('created_at', t); return q.range(a, b); }))
      .map((r) => [r.id, r.bookings?.customer_name, r.bookings?.customer_phone, r.amount, r.currency, r.status, r.method, r.provider_ref, r.verified_at, r.created_at]) }),
  refunds: async (d, f, t) => ({ cols: ['refund_id', 'payment_id', 'amount', 'reason', 'created_at'],
    rows: (await fetchAll((a, b) => { let q = d.from('refunds').select('*').order('created_at'); if (f) q = q.gte('created_at', f); if (t) q = q.lte('created_at', t); return q.range(a, b); })).map((r) => [r.id, r.payment_id, r.amount, r.reason, r.created_at]) }),
};
const cell = (v: unknown) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // blocks CSV formula injection
const isoDay = (v: unknown, end = false) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v + (end ? 'T23:59:59Z' : 'T00:00:00Z') : undefined);
app.get('/api/admin/reports/:type', ADMIN, async (req, res) => {
  const rep = REPORTS[req.params.type as string]; if (!rep) return res.status(404).json({ error: 'NOT_FOUND' });
  const { cols, rows } = await rep(db(req), isoDay(req.query.from), isoDay(req.query.to, true));
  const name = `${req.params.type}-${new Date().toISOString().slice(0, 10)}`;
  if (req.query.format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28 }); doc.pipe(res);
    doc.font('Helvetica-Bold').fontSize(14).text(`${req.params.type} report - ${new Date().toISOString().slice(0, 10)}`).moveDown(0.5);
    doc.font('Courier-Bold').fontSize(7).text(cols.join(' | ')).font('Courier'); rows.forEach((r) => doc.text(r.map((v) => v ?? '').join(' | '))); doc.end();
  } else {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send('\ufeff' + [cols, ...rows].map((r) => r.map(cell).join(',')).join('\n'));
  }
});

// Generic CRUD for admin-managed tables. RLS (admin_all) is the real gate.
const TABLES = ['teams', 'stadiums', 'matches', 'sections', 'match_sections', 'gates', 'footer_links', 'site_texts', 'settings'];
const KEYED = ['site_texts', 'settings'];
const tbl = (req: Request) => (TABLES.includes(req.params.table as string) ? (req.params.table as string) : null);
app.get('/api/admin/:table', ADMIN, async (req, res) => {
  const t = tbl(req); if (!t) return res.status(404).json({ error: 'NOT_FOUND' });
  const { data, error } = await db(req).from(t).select('*');
  if (error) return sendError(res, error); res.json(data);
});
app.post('/api/admin/:table', ADMIN, async (req, res) => {
  const t = tbl(req); if (!t) return res.status(404).json({ error: 'NOT_FOUND' });
  const q = KEYED.includes(t) ? db(req).from(t).upsert(req.body) : db(req).from(t).insert(req.body);
  const { data, error } = await q.select();
  if (error) return sendError(res, error); res.status(201).json(data);
});
app.patch('/api/admin/:table/:id', ADMIN, async (req, res) => {
  const t = tbl(req); if (!t || KEYED.includes(t)) return res.status(404).json({ error: 'NOT_FOUND' });
  const { data, error } = await db(req).from(t).update(req.body).eq('id', req.params.id).select();
  if (error) return sendError(res, error); res.json(data);
});
app.delete('/api/admin/:table/:id', ADMIN, async (req, res) => {
  const t = tbl(req); if (!t || KEYED.includes(t)) return res.status(404).json({ error: 'NOT_FOUND' });
  const { error } = await db(req).from(t).delete().eq('id', req.params.id);
  if (error) return sendError(res, error); res.json({ ok: true });
});

app.use((e: Error, _q: Request, res: Response, _n: NextFunction) => { console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); });
app.listen(Number(PORT), () => console.log(`API on :${PORT}`));
