import { Link, Route, Routes } from 'react-router-dom';
import { Moon, Sun, Ticket } from 'lucide-react';
import { useI18n } from './lib/i18n';
import { supabase, useRole, useSession } from './lib/api';
import Gate from './pages/Gate';
import Admin from './pages/Admin';
import Home from './pages/Home';
import Tickets from './pages/Tickets';
import Login from './pages/Login';

export default function App() {
  const { t, lang, setLang, dark, toggleDark, site } = useI18n();
  const session = useSession();
  const role = useRole(session);
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-4">
          <Link to="/" className="flex items-center gap-2 text-lg font-extrabold tracking-tight"><span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-brand-ink">⚽</span>Garoonka</Link>
          <div className="ml-auto flex items-center gap-2">
            <div className="flex rounded-full border border-line bg-line/50 p-0.5 text-xs font-bold" role="group" aria-label="Language">
              {(['en', 'so'] as const).map((l) => <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l} className={`rounded-full px-3 py-1.5 ${lang === l ? 'bg-surface shadow' : 'text-muted'}`}>{l.toUpperCase()}</button>)}
            </div>
            <button onClick={toggleDark} aria-label="Theme" className="grid h-9 w-9 place-items-center rounded-full border border-line bg-surface">{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
            {session ? (<>
              {['gate_staff', 'stadium_admin', 'super_admin'].includes(role) && <Link to="/gate" className="text-sm font-semibold">{t('gate')}</Link>}
              {['stadium_admin', 'super_admin'].includes(role) && <Link to="/admin" className="text-sm font-semibold">{t('admin')}</Link>}
              <Link to="/tickets" className="btn-ghost !px-4 !py-2"><Ticket size={16} />{t('tickets')}</Link>
              <button className="text-sm font-semibold text-muted" onClick={() => supabase.auth.signOut()}>{t('logout')}</button>
            </>) : <Link to="/login" className="btn !px-4 !py-2">{t('login')}</Link>}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Routes><Route path="/" element={<Home />} /><Route path="/tickets" element={<Tickets />} /><Route path="/login" element={<Login />} /><Route path="/gate" element={<Gate />} /><Route path="/admin" element={<Admin />} /></Routes>
      </main>
      <footer className="border-t border-line py-8 text-sm text-muted">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4">
          <span>© 2026 Garoonka Tickets</span>
          <nav className="flex flex-wrap gap-4">{site.links.map((l) => <a key={l.id} href={l.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-ink">{l.label}</a>)}</nav>
        </div>
      </footer>
    </div>
  );
}
