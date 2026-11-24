import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/api';
import { useI18n } from '../lib/i18n';

export default function Login() {
  const { t } = useI18n(); const nav = useNavigate();
  const [signup, setSignup] = useState(false); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [msg, setMsg] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    const cleanEmail = email.trim().toLowerCase();
    const { data, error } = signup
      ? await supabase.auth.signUp({ email: cleanEmail, password })
      : await supabase.auth.signInWithPassword({ email: cleanEmail, password });
    if (error) {
      setMsg(error.message);
    } else if (signup && !data.session) {
      setMsg('Account created! If email confirmation is enabled in Supabase, please verify your email before logging in.');
    } else {
      nav('/');
    }
  }
  return (
    <form onSubmit={submit} className="card mx-auto grid max-w-sm gap-3 p-6">
      <h1 className="text-2xl font-extrabold">{signup ? t('signup') : t('login')}</h1>
      <input className="input" type="email" required placeholder={t('email')} value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className="input" type="password" required minLength={8} placeholder={t('password')} value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="btn">{signup ? t('signup') : t('login')}</button>
      <button type="button" className="text-sm font-semibold text-muted" onClick={() => setSignup(!signup)}>{signup ? t('login') : t('signup')}</button>
      {msg && <p className="text-sm text-red-500">{msg}</p>}
    </form>
  );
}
