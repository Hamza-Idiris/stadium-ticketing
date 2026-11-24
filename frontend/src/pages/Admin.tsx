import { useEffect, useState } from 'react';
import { api, download, money } from '../lib/api';
import { useI18n } from '../lib/i18n';
import Crud, { Field } from './Crud';

type Stats = { matches: number; paidTickets: number; freeTickets: number; usedTickets: number; revenue: Record<string, number>; pendingPayments: number };
type P = { id: string; amount: number; currency: string; created_at: string; bookings: { customer_name: string; customer_phone: string; qty: number; expires_at: string } };

function PayRow({ p, done }: { p: P; done: () => void }) {
  const { t, err } = useI18n(); const [method, setMethod] = useState(''); const [ref, setRef] = useState(''); const [e, setE] = useState('');
  async function ok() { try { await api(`/payments/${p.id}/confirm`, { method: 'POST', body: { method, ref } }); done(); } catch (x) { setE(err(x)); } }
  return (
    <div className="grid gap-2 rounded-xl border border-line p-3 text-sm">
      <div className="flex justify-between"><b>{p.bookings.customer_name} · {p.bookings.customer_phone}</b><b className="font-num">{money(p.amount, p.currency)}</b></div>
      <div className="text-xs text-muted">{p.bookings.qty} × · {new Date(p.created_at).toLocaleString()}</div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"><input className="input" placeholder={t('method')} value={method} onChange={(x) => setMethod(x.target.value)} />
        <input className="input" placeholder={t('ref')} value={ref} onChange={(x) => setRef(x.target.value)} />
        <button className="btn !py-2" disabled={method.length < 2 || ref.length < 3} onClick={ok}>{t('confirm')}</button></div>
      {e && <p className="text-xs text-red-500">{e}</p>}
    </div>
  );
}

function Overview() {
  const { t, err } = useI18n(); const [s, setS] = useState<Stats | null>(null); const [pay, setPay] = useState<P[]>([]); const [e, setE] = useState('');
  const load = () => { api<Stats>('/admin/stats').then(setS).catch((x) => setE(err(x))); api<P[]>('/admin/payments/pending').then(setPay).catch(() => {}); };
  useEffect(load, []);
  const cards: [string, string | number][] = s ? [['Matches', s.matches], ['Paid tickets', s.paidTickets], ['Free tickets', s.freeTickets], ['Used tickets', s.usedTickets], [t('pendingPay'), s.pendingPayments],
    ...Object.entries(s.revenue).map(([c, v]): [string, string] => [`${t('revenue')} (${c})`, money(v, c)])] : [];
  return (
    <div className="grid gap-6">
      {e && <p className="text-sm text-red-500">{e}</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{cards.map(([k, v]) => <div key={k} className="card p-4"><div className="text-xs font-semibold text-muted">{k}</div><div className="font-num text-3xl font-bold">{v}</div></div>)}</div>
      <section className="grid gap-3"><h2 className="text-xl font-extrabold">{t('pendingPay')}</h2>
        {pay.map((p) => <PayRow key={p.id} p={p} done={load} />)}</section>
    </div>
  );
}

const YN = (k: string, label: string, def = true): Field => ({ k, label, type: 'bool', def });
const CFG: Record<string, { label: string; fields: Field[] }> = {
  matches: { label: 'Matches', fields: [
    { k: 'title', label: 'Title', type: 'text', req: true }, { k: 'tournament', label: 'Tournament / cup', type: 'text' },
    { k: 'stadium_id', label: 'Stadium', type: 'ref', ref: ['stadiums', 'name'], req: true },
    { k: 'home_team_id', label: 'Home team', type: 'ref', ref: ['teams', 'name'], req: true }, { k: 'away_team_id', label: 'Away team', type: 'ref', ref: ['teams', 'name'], req: true },
    { k: 'kickoff', label: 'Kick-off', type: 'datetime', req: true }, { k: 'status', label: 'Status', type: 'select', options: ['upcoming', 'live', 'completed', 'cancelled'] },
    { k: 'sales_open', label: 'Sales open', type: 'datetime' }, { k: 'sales_close', label: 'Sales close', type: 'datetime' }, { k: 'description', label: 'Description', type: 'textarea' }] },
  match_sections: { label: 'Prices & capacity', fields: [
    { k: 'match_id', label: 'Match', type: 'ref', ref: ['matches', 'title'], req: true }, { k: 'section_id', label: 'Section', type: 'ref', ref: ['sections', 'name'], req: true },
    { k: 'price', label: 'Price', type: 'number', req: true, def: 0 }, { k: 'currency', label: 'Currency', type: 'select', options: ['USD', 'SOS'] },
    { k: 'capacity', label: 'Capacity', type: 'number', req: true }, { k: 'mode', label: 'Booking mode', type: 'select', options: ['paid', 'free_booking', 'open_entry'] }, YN('active', 'Active')] },
  sections: { label: 'Sections', fields: [
    { k: 'stadium_id', label: 'Stadium', type: 'ref', ref: ['stadiums', 'name'], req: true }, { k: 'name', label: 'Name', type: 'text', req: true },
    { k: 'capacity', label: 'Default capacity', type: 'number', req: true }, YN('numbered', 'Numbered seats'), { k: 'row_size', label: 'Seats per row', type: 'number', def: 20 },
    { k: 'display_order', label: 'Display order', type: 'number', def: 0 }, YN('active', 'Active'),
    { k: 'image_url', label: 'Image', type: 'image', bucket: 'section-images' }, { k: 'description', label: 'Description', type: 'textarea' }] },
  teams: { label: 'Teams', fields: [{ k: 'name', label: 'Name', type: 'text', req: true }, { k: 'logo_url', label: 'Logo (optional)', type: 'image', bucket: 'team-logos' }] },
  stadiums: { label: 'Stadiums', fields: [{ k: 'name', label: 'Name', type: 'text', req: true }, { k: 'city', label: 'City', type: 'text' }] },
  footer_links: { label: 'Footer links', fields: [{ k: 'label', label: 'Label', type: 'text', req: true }, { k: 'url', label: 'URL (https:, tel:, mailto:)', type: 'text', req: true }, { k: 'sort', label: 'Order', type: 'number', def: 0 }] },
};
const TEXT_KEYS = ['hero', 'lead', 'matches', 'book', 'contact', 'login', 'tickets'];

function TextsEditor() {
  const { site, refresh, err } = useI18n(); const [key, setKey] = useState(TEXT_KEYS[0]); const [lang, setLang] = useState('en'); const [value, setValue] = useState(''); const [e, setE] = useState('');
  async function save() { try { await api('/admin/site_texts', { method: 'POST', body: { key, lang, value } }); setValue(''); refresh(); } catch (x) { setE(err(x)); } }
  async function reset(k: string, l: string) { try { await api(`/admin/site_texts/${k}/${l}`, { method: 'DELETE' }); refresh(); } catch (x) { setE(err(x)); } }
  return (
    <div className="grid gap-3">
      <div className="card grid gap-2 p-4 sm:grid-cols-[auto_auto_1fr_auto]">
        <select className="input" value={key} onChange={(x) => setKey(x.target.value)}>{TEXT_KEYS.map((k) => <option key={k}>{k}</option>)}</select>
        <select className="input" value={lang} onChange={(x) => setLang(x.target.value)}><option value="en">EN</option><option value="so">SO</option></select>
        <input className="input" placeholder="New text" value={value} onChange={(x) => setValue(x.target.value)} /><button className="btn" disabled={!value} onClick={save}>Save</button></div>
      {e && <p className="text-sm text-red-500">{e}</p>}
      {site.texts.map((x) => <div key={x.key + x.lang} className="card flex items-center justify-between gap-3 p-3 text-sm"><span><b>{x.key}</b> [{x.lang}] {x.value}</span><button className="btn-ghost !px-3 !py-1.5" onClick={() => reset(x.key, x.lang)}>Reset</button></div>)}
    </div>
  );
}

export default function Admin() {
  const { t } = useI18n(); const [tab, setTab] = useState('overview');
  const tabs: [string, string][] = [['overview', 'Overview'], ...Object.entries(CFG).map(([k, v]): [string, string] => [k, v.label]), ['texts', 'Site text'], ['refunds', 'Cancel & refunds'], ['reports', 'Reports']];
  return (
    <div className="grid gap-5">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('admin')}</h1>
      <div className="flex gap-2 overflow-x-auto pb-1">{tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold ${tab === k ? 'bg-brand text-brand-ink' : 'bg-line text-ink'}`}>{l}</button>)}</div>
      {tab === 'overview' ? <Overview /> : tab === 'texts' ? <TextsEditor /> : tab === 'refunds' ? <Refunds /> : tab === 'reports' ? <Reports /> : <Crud key={tab} table={tab} fields={CFG[tab].fields} />}
    </div>
  );
}

const REPS = ['summary', 'sales', 'free', 'attendance', 'payments', 'refunds'];
function Reports() {
  const { err } = useI18n(); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [e, setE] = useState('');
  const get = (r: string, f: 'csv' | 'pdf') => download(`/admin/reports/${r}?format=${f}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`, `${r}.${f}`).catch((x) => setE(err(x)));
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-2"><input type="date" className="input" value={from} onChange={(x) => setFrom(x.target.value)} /><input type="date" className="input" value={to} onChange={(x) => setTo(x.target.value)} /></div>
      {REPS.map((r) => <div key={r} className="card flex items-center justify-between p-3 text-sm"><b className="capitalize">{r}</b>
        <span className="flex gap-2"><button className="btn-ghost !py-1.5" onClick={() => get(r, 'csv')}>CSV</button><button className="btn-ghost !py-1.5" onClick={() => get(r, 'pdf')}>PDF</button></span></div>)}
      {e && <p className="text-sm text-red-500">{e}</p>}
    </div>
  );
}

function Refunds() {
  const { err } = useI18n(); const [ms, setMs] = useState<any[]>([]); const [pays, setPays] = useState<any[]>([]); const [e, setE] = useState(''); const [reason, setReason] = useState('Match cancelled');
  const load = () => { api<any[]>('/admin/matches').then(setMs).catch((x) => setE(err(x))); api<any[]>('/admin/payments/paid').then(setPays).catch(() => {}); };
  useEffect(load, []);
  async function cancel(id: string) { if (!confirm('Cancel this match? Valid tickets are cancelled and unpaid holds released.')) return; try { await api(`/admin/matches/${id}/cancel`, { method: 'POST' }); load(); } catch (x) { setE(err(x)); } }
  async function refund(id: string) { if (!confirm('Record a full refund? Its tickets become invalid.')) return; try { await api(`/payments/${id}/refund`, { method: 'POST', body: { reason } }); load(); } catch (x) { setE(err(x)); } }
  return (
    <div className="grid gap-4">
      {e && <p className="text-sm text-red-500">{e}</p>}
      <h2 className="text-xl font-extrabold">Cancel a match</h2>
      {ms.filter((m) => m.status !== 'cancelled' && m.status !== 'completed').map((m) => <div key={m.id} className="card flex items-center justify-between gap-3 p-3 text-sm"><span>{m.title} · {new Date(m.kickoff).toLocaleString()}</span><button className="btn !bg-red-600 !py-1.5 !text-white" onClick={() => cancel(m.id)}>Cancel match</button></div>)}
      <h2 className="text-xl font-extrabold">Paid payments</h2>
      <p className="text-xs text-muted">Return the money through the payment provider (EVC Plus, ZAAD, ...), then record it here.</p>
      <input className="input" value={reason} onChange={(x) => setReason(x.target.value)} placeholder="Reason" />
      {pays.map((p) => { const m = p.bookings?.match_sections?.matches; return (
        <div key={p.id} className="card flex items-center justify-between gap-3 p-3 text-sm"><span><b>{p.bookings?.customer_name}</b> · {p.bookings?.customer_phone} · {money(p.amount, p.currency)}<br /><span className={m?.status === 'cancelled' ? 'font-bold text-red-500' : 'text-muted'}>{m?.title} ({m?.status})</span></span>
          <button className="btn-ghost !py-1.5" disabled={reason.length < 3} onClick={() => refund(p.id)}>Refund</button></div>); })}
    </div>
  );
}
