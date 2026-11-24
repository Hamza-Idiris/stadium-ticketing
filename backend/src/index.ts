import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const { SUPABASE_URL = '', SUPABASE_ANON_KEY = '', SUPABASE_SERVICE_ROLE_KEY = '', CORS_ORIGIN = 'http://localhost:5173', PORT = '4000' } = process.env;
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

app.get('/api/me', auth(), (req, res) => { res.json({ role: (req as Ctx).role }); });

app.use((e: Error, _q: Request, res: Response, _n: NextFunction) => { console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); });
app.listen(Number(PORT), () => console.log(`API on :${PORT}`));
