import { FormEvent, useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { api, supabase } from '../lib/api';
import { useI18n } from '../lib/i18n';

export type Field = { k: string; label: string; type: 'text' | 'textarea' | 'number' | 'datetime' | 'bool' | 'select' | 'ref' | 'image'; options?: string[]; ref?: [string, string]; bucket?: string; req?: boolean; def?: unknown };
type Row = Record<string, any>;
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

export default function Crud({ table, fields }: { table: string; fields: Field[] }) {
  const { err } = useI18n();
  const empty = (): Row => Object.fromEntries(fields.map((f) => [f.k, f.def ?? (f.type === 'bool' ? true : f.type === 'select' ? f.options![0] : '')]));
  const [rows, setRows] = useState<Row[]>([]); const [refs, setRefs] = useState<Record<string, Row[]>>({});
  const [form, setForm] = useState<Row>(empty()); const [editId, setEditId] = useState<string | null>(null); const [e, setE] = useState('');
  const load = async () => {
    try { setRows(await api<Row[]>(`/admin/${table}`)); const r: Record<string, Row[]> = {};
      for (const f of fields) if (f.ref && !r[f.ref[0]]) r[f.ref[0]] = await api<Row[]>(`/admin/${f.ref[0]}`);
      setRefs(r);
    } catch (x) { setE(err(x)); }
  };
  useEffect(() => { void load(); }, []);
  const lab = (f: Field, id: string) => refs[f.ref![0]]?.find((r) => r.id === id)?.[f.ref![1]] ?? id;

  async function upload(f: Field, file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2_000_000) return setE('Image must be JPG, PNG or WebP under 2 MB.');
    const path = `${crypto.randomUUID()}.${file.type.split('/')[1]}`;
    const { error } = await supabase.storage.from(f.bucket!).upload(path, file, { contentType: file.type });
    if (error) return setE(error.message);
    const url = supabase.storage.from(f.bucket!).getPublicUrl(path).data.publicUrl;
    setForm((p) => ({ ...p, [f.k]: url })); setE('');
  }
  async function save(ev: FormEvent) {
    ev.preventDefault(); setE('');
    const body: Row = {};
    for (const f of fields) { const v = form[f.k];
      body[f.k] = f.type === 'number' ? (v === '' || v == null ? null : Number(v)) : f.type === 'datetime' ? (v ? new Date(v).toISOString() : null) : f.type === 'bool' ? !!v : v === '' || v === undefined ? null : v; }
    try { await api(editId ? `/admin/${table}/${editId}` : `/admin/${table}`, { method: editId ? 'PATCH' : 'POST', body }); setForm(empty()); setEditId(null); await load(); }
    catch (x) { setE(err(x)); }
  }
  async function del(id: string) { if (!confirm('Delete?')) return; try { await api(`/admin/${table}/${id}`, { method: 'DELETE' }); await load(); } catch (x) { setE(err(x)); } }
  const edit = (r: Row) => { setEditId(r.id); setForm(Object.fromEntries(fields.map((f) => [f.k, f.type === 'datetime' ? toLocal(r[f.k]) : r[f.k] ?? '']))); };
  const set = (k: string, v: unknown) => setForm((p) => ({ ...p, [k]: v }));

  const input = (f: Field) => {
    const v = form[f.k] ?? '';
    switch (f.type) {
      case 'textarea': return <textarea className="input" rows={2} value={v} onChange={(x) => set(f.k, x.target.value)} />;
      case 'bool': return <input type="checkbox" className="h-5 w-5" checked={!!form[f.k]} onChange={(x) => set(f.k, x.target.checked)} />;
      case 'select': return <select className="input" value={v} onChange={(x) => set(f.k, x.target.value)}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>;
      case 'ref': return <select className="input" required={f.req} value={v} onChange={(x) => set(f.k, x.target.value)}><option value="" />{(refs[f.ref![0]] ?? []).map((r) => <option key={r.id} value={r.id}>{r[f.ref![1]]}</option>)}</select>;
      case 'image': return <div className="flex items-center gap-2">{v && <img src={v} alt="" className="h-10 w-10 rounded object-cover" />}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(x) => x.target.files?.[0] && void upload(f, x.target.files[0])} />{v && <button type="button" className="text-xs underline" onClick={() => set(f.k, '')}>remove</button>}</div>;
      case 'datetime': return <input type="datetime-local" className="input" required={f.req} value={v} onChange={(x) => set(f.k, x.target.value)} />;
      case 'number': return <input type="number" step="any" min={0} className="input" required={f.req} value={v} onChange={(x) => set(f.k, x.target.value)} />;
      default: return <input className="input" required={f.req} value={v} onChange={(x) => set(f.k, x.target.value)} />;
    }
  };
  const summary = (r: Row) => fields.filter((f) => f.type !== 'textarea' && f.type !== 'image').slice(0, 5)
    .map((f) => (f.ref ? lab(f, r[f.k]) : f.type === 'datetime' && r[f.k] ? new Date(r[f.k]).toLocaleString() : f.type === 'bool' ? (r[f.k] ? '✓' : '✗') : String(r[f.k] ?? ''))).join(' · ');
  return (
    <div className="grid gap-4">
      <form onSubmit={save} className="card grid gap-3 p-4 sm:grid-cols-2">
        {fields.map((f) => <label key={f.k} className="grid gap-1 text-xs font-semibold text-muted">{f.label}{input(f)}</label>)}
        <div className="flex items-center gap-2 sm:col-span-2"><button className="btn">{editId ? 'Update' : 'Add'}</button>
          {editId && <button type="button" className="btn-ghost" onClick={() => { setEditId(null); setForm(empty()); }}>Cancel</button>}{e && <span className="text-sm text-red-500">{e}</span>}</div>
      </form>
      {rows.map((r) => <div key={r.id} className="card flex items-center justify-between gap-3 p-3 text-sm"><span>{summary(r)}</span>
        <span className="flex gap-2"><button className="btn-ghost !p-2" aria-label="Edit" onClick={() => edit(r)}><Pencil size={14} /></button><button className="btn-ghost !p-2" aria-label="Delete" onClick={() => del(r.id)}><Trash2 size={14} /></button></span></div>)}
    </div>
  );
}
