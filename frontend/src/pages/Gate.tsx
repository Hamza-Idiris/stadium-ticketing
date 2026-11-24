import { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { api, useRole, useSession } from '../lib/api';
import { useI18n } from '../lib/i18n';

type R = { result: string; holder?: string; seat?: string; section?: string; match?: string; at?: string };
type OE = { id: string; label: string; remaining: number; capacity: number };
const LABEL: Record<string, string> = { valid: 'VALID', already_used: 'ALREADY USED', invalid: 'INVALID TICKET', cancelled: 'CANCELLED', refunded: 'REFUNDED' };
const COLOR: Record<string, string> = { valid: 'bg-emerald-600', already_used: 'bg-amber-600', invalid: 'bg-red-600', cancelled: 'bg-slate-600', refunded: 'bg-slate-600' };

export default function Gate() {
  const { t, err } = useI18n(); const role = useRole(useSession());
  const [res, setRes] = useState<R | null>(null); const [log, setLog] = useState<R[]>([]); const [on, setOn] = useState(false);
  const [manual, setManual] = useState(''); const [e, setE] = useState(''); const [oe, setOe] = useState<OE[]>([]);
  const scanner = useRef<Html5Qrcode | null>(null); const last = useRef({ token: '', at: 0 });

  async function check(token: string) {
    const now = Date.now(); if (token === last.current.token && now - last.current.at < 3000) return;
    last.current = { token, at: now };
    try { const r = await api<R>('/scan', { method: 'POST', body: { token } }); const x = { ...r, at: new Date().toLocaleTimeString() };
      setRes(x); setLog((l) => [x, ...l].slice(0, 10)); setE(''); navigator.vibrate?.(r.result === 'valid' ? 80 : [80, 60, 80]);
    } catch (x) { setE(err(x)); }
  }
  async function start() {
    try { const s = new Html5Qrcode('reader'); scanner.current = s; await s.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 }, (txt) => { void check(txt); }, () => {}); setOn(true); }
    catch { setE('Camera unavailable. Use the ticket code field.'); }
  }
  async function stop() { await scanner.current?.stop(); scanner.current?.clear(); scanner.current = null; setOn(false); }
  useEffect(() => () => { if (scanner.current?.isScanning) scanner.current.stop().catch(() => {}); }, []);

  const loadOe = () => api<any[]>('/matches').then((ms) => setOe(ms.flatMap((m) => m.match_sections.filter((s: any) => s.mode === 'open_entry')
    .map((s: any) => ({ id: s.id, label: `${m.home.name} v ${m.away.name} · ${s.section.name}`, remaining: s.remaining, capacity: s.capacity }))))).catch(() => {});
  useEffect(() => { void loadOe(); }, []);
  async function add(id: string, delta: number) { try { await api('/open-entry', { method: 'POST', body: { matchSectionId: id, delta } }); setE(''); await loadOe(); } catch (x) { setE(err(x)); } }
  const isAdmin = ['stadium_admin', 'super_admin'].includes(role);

  return (
    <div className="mx-auto grid max-w-lg gap-5">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('gate')}</h1>
      <div className="card overflow-hidden p-3"><div id="reader" className="min-h-[8px] overflow-hidden rounded-xl" />
        <button className="btn mt-3 w-full" onClick={on ? stop : start}>{on ? t('stop') : t('scan')}</button></div>
      <form className="flex gap-2" onSubmit={(ev) => { ev.preventDefault(); if (manual.trim()) { void check(manual.trim()); setManual(''); } }}>
        <input className="input" placeholder={t('manual')} value={manual} onChange={(x) => setManual(x.target.value)} /><button className="btn">{t('check')}</button></form>
      {e && <p className="text-sm text-red-500">{e}</p>}
      {res && <div className={`rounded-2xl p-5 text-white ${COLOR[res.result] ?? 'bg-red-600'}`} role="status">
        <div className="text-3xl font-extrabold tracking-tight">{LABEL[res.result] ?? res.result}</div>
        {res.holder && <div className="mt-2 text-sm opacity-95">{res.holder} · {res.section}{res.seat ? ` · ${res.seat}` : ''}<br />{res.match}</div>}
        <div className="mt-2 text-xs opacity-80">{res.at}</div></div>}
      <section className="card p-4"><h2 className="mb-3 font-extrabold">{t('entry')}</h2>
        {oe.map((s) => { const inside = s.capacity - s.remaining; return (
          <div key={s.id} className="mb-3 border-b border-line pb-3 last:mb-0 last:border-0 last:pb-0">
            <div className="text-sm font-semibold">{s.label}</div>
            <div className="mt-1 flex items-center justify-between"><span className="font-num text-2xl font-bold">{inside} / {s.capacity} <span className="text-xs font-normal text-muted">{t('inside')} · {s.remaining} {t('left')}</span></span>
              <span className="flex gap-2">{isAdmin && <button className="btn-ghost !px-3 !py-2" onClick={() => add(s.id, -1)}>−1</button>}
                <button className="btn !px-3 !py-2" disabled={s.remaining === 0} onClick={() => add(s.id, 1)}>+1</button>
                <button className="btn !px-3 !py-2" disabled={s.remaining < 5} onClick={() => add(s.id, 5)}>+5</button></span></div></div>); })}</section>
      {log.length > 0 && <section className="card p-4"><h2 className="mb-2 font-extrabold">{t('recent')}</h2>
        {log.map((l, i) => <div key={i} className="flex justify-between text-sm"><span>{l.holder ?? '—'} {l.seat ?? ''}</span><b>{LABEL[l.result] ?? l.result}</b></div>)}</section>}
    </div>
  );
}
