import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Download, Search } from 'lucide-react';
import { api, download, useSession } from '../lib/api';
import { useI18n } from '../lib/i18n';

type TicketItem = { id: string; seat_code: string | null; token: string; status: string; holder_name: string };
type B = {
  id: string;
  status: string;
  qty: number;
  match_sections?: {
    price: number;
    currency: string;
    sections?: { name: string };
    matches?: { title: string; kickoff: string; stadiums?: { name: string } };
  };
  payments?: { id: string; status: string; amount: number; currency: string }[];
  tickets: TicketItem[];
};

export default function Tickets() {
  const { t, err } = useI18n();
  const session = useSession();
  const [list, setList] = useState<B[]>([]);
  const [loading, setLoading] = useState(true);
  const [e, setE] = useState('');
  const [searchId, setSearchId] = useState('');

  async function load() {
    setLoading(true);
    setE('');
    const results: B[] = [];
    const seen = new Set<string>();

    // 1. If logged in, fetch user's account bookings
    if (session) {
      try {
        const mine = await api<B[]>('/bookings/mine');
        for (const b of mine) {
          if (!seen.has(b.id)) {
            seen.add(b.id);
            results.push(b);
          }
        }
      } catch (x) {
        console.error(x);
      }
    }

    // 2. Fetch any guest bookings saved in browser local storage
    try {
      const guestIds: string[] = JSON.parse(localStorage.getItem('guest_bookings') || '[]');
      for (const id of guestIds) {
        if (!seen.has(id)) {
          seen.add(id);
          try {
            const b = await api<B>(`/bookings/${id}`);
            results.push(b);
          } catch {}
        }
      }
    } catch {}

    setList(results);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, [session]);

  async function searchBooking(ev: React.FormEvent) {
    ev.preventDefault();
    const id = searchId.trim();
    if (!id) return;
    setLoading(true);
    setE('');
    try {
      const b = await api<B>(`/bookings/${id}`);
      setList((prev) => [b, ...prev.filter((x) => x.id !== b.id)]);
      // Save for future visits
      const listIds: string[] = JSON.parse(localStorage.getItem('guest_bookings') || '[]');
      if (!listIds.includes(b.id)) {
        localStorage.setItem('guest_bookings', JSON.stringify([b.id, ...listIds]));
      }
      setSearchId('');
    } catch (x) {
      setE('Booking not found. Please check your Booking ID.');
    } finally {
      setLoading(false);
    }
  }

  async function pay(id: string) {
    try {
      await api(`/bookings/${id}/mock-pay`, { method: 'POST' });
      await load();
    } catch (x) {
      setE(err(x));
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-extrabold tracking-tight">{t('tickets')}</h1>
      </div>

      {/* Lookup Bar */}
      <form onSubmit={searchBooking} className="flex gap-2 max-w-md">
        <input
          className="input flex-1"
          placeholder="Find tickets by Booking ID..."
          value={searchId}
          onChange={(ev) => setSearchId(ev.target.value)}
        />
        <button className="btn !px-4 !py-2 flex items-center gap-1.5">
          <Search size={15} /> Find
        </button>
      </form>

      {e && <p className="text-sm text-red-500">{e}</p>}

      {loading && list.length === 0 ? (
        <p className="text-muted">Loading tickets...</p>
      ) : list.length === 0 ? (
        <div className="card p-8 text-center grid gap-2">
          <p className="text-lg font-bold">{t('none')}</p>
          <p className="text-sm text-muted">Book a match ticket from the home page or look up a booking above.</p>
        </div>
      ) : (
        <div className="grid gap-5">
          {list.map((b) => (
            <section key={b.id} className="card p-5 grid gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                <div>
                  <div className="text-sm font-bold">
                    {b.match_sections?.matches?.title ?? 'Match Booking'}
                  </div>
                  <div className="text-xs text-muted font-num">Booking #{b.id.slice(0, 8)} · {b.qty} ticket(s)</div>
                </div>
                {b.status === 'reserved' && (
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-amber-600">{t('pending')}</span>
                    <button className="btn !py-1.5 !px-3 text-xs" onClick={() => pay(b.id)}>
                      {t('pay')}
                    </button>
                  </div>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {b.tickets.map((k) => (
                  <div key={k.id} className="flex items-center gap-4 rounded-xl border border-line bg-surface p-3">
                    <div className="rounded-lg bg-white p-2 shadow-sm">
                      <QRCodeSVG value={k.token} size={88} />
                    </div>
                    <div className="text-sm flex-1 grid gap-0.5">
                      <b className="font-num text-base">{k.seat_code ?? t('free')}</b>
                      <div className="text-xs text-muted">{k.holder_name}</div>
                      <div className="mt-1 text-xs font-bold uppercase text-brand">{k.status}</div>
                      {['valid', 'used'].includes(k.status) && (
                        <button
                          type="button"
                          className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-brand underline"
                          onClick={() => download(`/tickets/${k.id}/pdf`, `ticket-${k.seat_code ?? k.id.slice(0, 8)}.pdf`).catch((x) => setE(err(x)))}
                        >
                          <Download size={12} /> PDF Ticket
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
