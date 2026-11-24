import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar, MapPin, Minus, Plus, X } from 'lucide-react';
import { api, money, useSession } from '../lib/api';
import { useI18n } from '../lib/i18n';

type Sec = { id: string; price: number; currency: string; mode: string; remaining: number; section: { name: string; image_url: string | null; numbered: boolean; display_order: number } };
type Team = { name: string; logo_url: string | null };
type Match = { id: string; title: string; tournament: string | null; kickoff: string; home: Team; away: Team; stadium: { name: string }; match_sections: Sec[] };

const Crest = ({ t }: { t: Team }) => (t.logo_url ? <img src={t.logo_url} alt="" className="mx-auto h-14 w-14 rounded-full object-cover" /> :
  <div className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-line bg-line/60 font-num text-lg font-bold text-brand">{t.name.slice(0, 2).toUpperCase()}</div>);

function BookModal({ sec, onClose }: { sec: Sec; onClose: () => void }) {
  const { t, err } = useI18n(); const nav = useNavigate(); const session = useSession();
  const [qty, setQty] = useState(1); const [name, setName] = useState(''); const [phone, setPhone] = useState('');
  const [bid, setBid] = useState<string | null>(null); const [e, setE] = useState(''); const [busy, setBusy] = useState(false);
  const total = sec.price * qty;
  async function reserve(ev: FormEvent) {
    ev.preventDefault();
    if (!session) return nav('/login');
    setBusy(true); setE('');
    try { const r = await api<{ bookingId: string }>('/bookings', { method: 'POST', body: { matchSectionId: sec.id, qty, name, phone } });
      if (total === 0) nav('/tickets'); else setBid(r.bookingId);
    } catch (x) { setE(err(x)); } finally { setBusy(false); }
  }
  async function pay() { setBusy(true); try { await api(`/bookings/${bid}/mock-pay`, { method: 'POST' }); nav('/tickets'); } catch (x) { setE(err(x)); } finally { setBusy(false); } }
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-auto bg-black/55 p-4" onClick={onClose}>
      <form onSubmit={reserve} onClick={(x) => x.stopPropagation()} className="card grid w-full max-w-md gap-3 p-6">
        <div className="flex items-center justify-between"><h2 className="text-xl font-extrabold">{sec.section.name}</h2><button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <div className="flex items-center justify-between"><span className="text-sm font-semibold">{t('qty')}</span>
          <div className="flex items-center gap-3"><button type="button" className="btn-ghost !p-2" onClick={() => setQty(Math.max(1, qty - 1))}><Minus size={14} /></button><b className="w-6 text-center font-num text-lg">{qty}</b><button type="button" className="btn-ghost !p-2" onClick={() => setQty(Math.min(10, qty + 1))}><Plus size={14} /></button></div></div>
        {sec.section.numbered && <p className="text-xs text-muted">{t('adj')}</p>}
        <input className="input" required minLength={2} placeholder={t('name')} value={name} onChange={(x) => setName(x.target.value)} disabled={!!bid} />
        <input className="input" required minLength={6} placeholder={t('phone')} value={phone} onChange={(x) => setPhone(x.target.value)} disabled={!!bid} />
        <div className="flex items-center justify-between"><span>{t('total')}</span><b className="font-num text-2xl">{total === 0 ? t('free') : money(total, sec.currency)}</b></div>
        {bid ? <button type="button" className="btn" disabled={busy} onClick={pay}>{t('pay')}</button> : <button className="btn" disabled={busy}>{t('reserve')}</button>}
        {e && <p className="text-sm text-red-500">{e}</p>}
      </form>
    </div>
  );
}

export default function Home() {
  const { t, lang, err } = useI18n();
  const [matches, setMatches] = useState<Match[]>([]); const [pick, setPick] = useState<Sec | null>(null);
  const [c, setC] = useState({ topic: 'error', name: '', contact: '', message: '' }); const [cm, setCm] = useState('');
  useEffect(() => { api<Match[]>('/matches').then(setMatches).catch(() => {}); }, []);
  async function send(ev: FormEvent) { ev.preventDefault(); try { await api('/contact', { method: 'POST', body: c }); setCm(t('sent')); setC({ ...c, message: '' }); } catch (x) { setCm(err(x)); } }
  return (<>
    <section className="py-8"><h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">{t('hero')}</h1><p className="mt-4 max-w-xl text-lg text-muted">{t('lead')}</p></section>
    <h2 className="mb-4 text-2xl font-extrabold tracking-tight">{t('matches')}</h2>
    <div className="grid gap-5">
      {matches.map((m) => (
        <article key={m.id} className="card p-5">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center"><div><Crest t={m.home} /><b className="text-sm">{m.home.name}</b></div><span className="font-num text-sm text-muted">VS</span><div><Crest t={m.away} /><b className="text-sm">{m.away.name}</b></div></div>
          <p className="mt-3 flex flex-wrap justify-center gap-4 text-sm text-muted"><span className="flex items-center gap-1"><Calendar size={14} />{new Date(m.kickoff).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' })}</span><span className="flex items-center gap-1"><MapPin size={14} />{m.stadium.name}</span></p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[...m.match_sections].sort((a, b) => a.section.display_order - b.section.display_order).map((s) => (
              <div key={s.id} className="overflow-hidden rounded-xl border border-line">
                <div className="h-20 bg-gradient-to-br from-emerald-700 to-emerald-400 bg-cover bg-center" style={s.section.image_url ? { backgroundImage: `url(${s.section.image_url})` } : undefined} />
                <div className="grid gap-1 p-3"><div className="flex items-baseline justify-between"><b>{s.section.name}</b><span className="font-num text-lg font-bold">{money(s.price, s.currency) || t('free')}</span></div>
                  {s.mode === 'open_entry' ? <span className="text-xs text-muted">{t('openEntry')} · {s.remaining} {t('left')}</span> : <>
                    <span className="text-xs text-muted">{s.remaining} {t('left')}</span>
                    <button className="btn mt-1 !py-2" disabled={s.remaining === 0} onClick={() => setPick(s)}>{s.remaining === 0 ? t('soldOut') : t('book')}</button></>}
                </div></div>))}
          </div>
        </article>))}
    </div>
    <section className="mt-12"><h2 className="mb-4 text-2xl font-extrabold tracking-tight">{t('contact')}</h2>
      <form onSubmit={send} className="card grid max-w-lg gap-3 p-5">
        <select className="input" value={c.topic} onChange={(x) => setC({ ...c, topic: x.target.value })}><option value="error">{t('topic_error')}</option><option value="question">{t('topic_question')}</option></select>
        <input className="input" required placeholder={t('name')} value={c.name} onChange={(x) => setC({ ...c, name: x.target.value })} />
        <input className="input" required minLength={3} placeholder={t('email') + ' / ' + t('phone')} value={c.contact} onChange={(x) => setC({ ...c, contact: x.target.value })} />
        <textarea className="input" required minLength={3} rows={3} placeholder={t('message')} value={c.message} onChange={(x) => setC({ ...c, message: x.target.value })} />
        <button className="btn">{t('send')}</button>{cm && <p className="text-sm text-muted">{cm}</p>}
      </form></section>
    {pick && <BookModal sec={pick} onClose={() => setPick(null)} />}
  </>);
}
