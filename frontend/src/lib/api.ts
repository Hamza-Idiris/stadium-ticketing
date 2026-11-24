import { useEffect, useState } from 'react';
import { createClient, Session } from '@supabase/supabase-js';
export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL ?? '', import.meta.env.VITE_SUPABASE_ANON_KEY ?? '');
const BASE: string = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api';
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const r = await fetch(BASE + path, { method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? 'ERROR');
  return j as T;
}
export function useSession() {
  const [s, setS] = useState<Session | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setS(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, x) => setS(x));
    return () => data.subscription.unsubscribe();
  }, []);
  return s;
}
export const money = (n: number, c: string) => (n === 0 ? '' : c === 'USD' ? `$${n}` : `${n.toLocaleString()} SOS`);
export function useRole(s: Session | null) {
  const [r, setR] = useState('');
  useEffect(() => { if (!s) { setR(''); return; } api<{ role: string }>('/me').then((x) => setR(x.role)).catch(() => setR('')); }, [s]);
  return r;
}
export async function download(path: string, name: string) {
  const { data } = await supabase.auth.getSession();
  const r = await fetch(BASE + path, { headers: data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {} });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'ERROR');
  const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
