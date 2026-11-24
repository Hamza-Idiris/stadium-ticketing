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
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, opts);
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

// ---- Customer ----
const Book = z.object({ matchSectionId: z.string().uuid(), qty: z.number().int().min(1).max(50), name: z.string().min(2).max(100), phone: z.string().min(6).max(25) });
app.post('/api/bookings', strict, auth(), async (req, res) => {
  const p = Book.safeParse(req.body); if (!p.success) return bad(res);
  const { data, error } = await db(req).rpc('reserve_booking', { p_ms: p.data.matchSectionId, p_qty: p.data.qty, p_name: p.data.name, p_phone: p.data.phone });
  if (error) return sendError(res, error);
  res.status(201).json({ bookingId: data });
});

app.get('/api/bookings/mine', auth(), async (req, res) => {
  const { data, error } = await db(req).from('bookings')
    .select('*, payments(id,status,amount,currency), tickets(id,seat_code,token,status,holder_name)')
    .eq('user_id', (req as Ctx).uid!).order('created_at', { ascending: false });
  if (error) return sendError(res, error);
  res.json(data);
});

// MOCK payment (dev only). Replace with a provider webhook that calls confirm_payment after verifying the transaction.
app.post('/api/bookings/:id/mock-pay', strict, auth(), async (req, res) => {
  if (MOCK_PAYMENTS !== 'true') return res.status(404).json({ error: 'NOT_FOUND' });
  const { data: pay } = (await admin.from('payments').select('id, bookings!inner(user_id)').eq('booking_id', req.params.id).eq('status', 'pending').maybeSingle()) as any;
  if (!pay || pay.bookings.user_id !== (req as Ctx).uid) return res.status(404).json({ error: 'NOT_FOUND' });
  const { error } = await admin.rpc('confirm_payment', { p_payment: pay.id, p_method: 'MOCK', p_ref: `MOCK-${randomUUID()}` });
  if (error) return sendError(res, error);
  res.json({ ok: true });
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

// ---- PDF ticket (owner or admin; RLS decides) ----
app.get('/api/tickets/:id/pdf', auth(), async (req, res) => {
  const { data: k } = (await db(req).from('tickets').select('id, seat_code, token, status, holder_name, match_sections(sections(name), matches(title, kickoff, stadiums(name), home:teams!home_team_id(name), away:teams!away_team_id(name)))').eq('id', req.params.id).maybeSingle()) as any;
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

app.use((e: Error, _q: Request, res: Response, _n: NextFunction) => { console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); });
app.listen(Number(PORT), () => console.log(`API on :${PORT}`));
