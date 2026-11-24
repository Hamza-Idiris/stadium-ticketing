import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { api, download, useSession } from '../lib/api';
import { useI18n } from '../lib/i18n';

type B = { id: string; status: string; qty: number; payments: { id: string; status: string; amount: number; currency: string }[]; tickets: { id: string; seat_code: string | null; token: string; status: string; holder_name: string }[] };

export default function Tickets() {
  const { t, err } = useI18n(); const session = useSession();
  const [list, setList] = useState<B[] | null>(null); const [e, setE] = useState('');
  const load = () => api<B[]>('/bookings/mine').then(setList).catch((x) => setE(err(x)));
  useEffect(() => { if (session) load(); }, [session]);
  if (!session) return <Link to="/login" className="btn">{t('login')}</Link>;
  async function pay(id: string) { try { await api(`/bookings/${id}/mock-pay`, { method: 'POST' }); load(); } catch (x) { setE(err(x)); } }
  return (
    <div className="grid gap-4">
      <h1 className="text-3xl font-extrabold tracking-tight">{t('tickets')}</h1>
      {e && <p className="text-sm text-red-500">{e}</p>}
      {list?.length === 0 && <p className="text-muted">{t('none')}</p>}
      {list?.map((b) => (
        <section key={b.id} className="card p-5">
          {b.status === 'reserved' && <div className="mb-3 flex items-center justify-between gap-3"><span className="text-sm font-semibold text-amber-600">{t('pending')}</span><button className="btn !py-2" onClick={() => pay(b.id)}>{t('pay')}</button></div>}
          <div className="grid gap-3 sm:grid-cols-2">
            {b.tickets.map((k) => (
              <div key={k.id} className="flex items-center gap-4 rounded-xl border border-line p-3">
                <div className="rounded-lg bg-white p-2"><QRCodeSVG value={k.token} size={96} /></div>
                <div className="text-sm"><b className="font-num text-base">{k.seat_code ?? t('free')}</b><div className="text-muted">{k.holder_name}</div><div className="mt-1 text-xs font-bold uppercase text-brand">{k.status}</div>
                  {['valid', 'used'].includes(k.status) && <button className="mt-1 text-xs font-semibold underline" onClick={() => download(`/tickets/${k.id}/pdf`, `ticket-${k.seat_code ?? k.id.slice(0, 8)}.pdf`).catch((x) => setE(err(x)))}>PDF</button>}</div>
              </div>))}
          </div>
        </section>))}
    </div>
  );
}
