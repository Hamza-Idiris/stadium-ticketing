import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

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

const app = express();
app.set('trust proxy', 1);
app.use(helmet(), cors({ origin: CORS_ORIGIN.split(',') }), express.json({ limit: '100kb' }), rateLimit({ windowMs: 60_000, limit: 120 }));
const strict = rateLimit({ windowMs: 60_000, limit: 10 });

app.get('/api/health', (_q, r) => { r.json({ ok: true }); });

app.use((e: Error, _q: Request, res: Response, _n: NextFunction) => { console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); });
app.listen(Number(PORT), () => console.log(`API on :${PORT}`));
