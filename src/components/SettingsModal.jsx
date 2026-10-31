import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CalendarDays, Database, Download, FileSpreadsheet, Lock, Mail, RefreshCw, Upload } from 'lucide-react';
import { put, request } from '../lib/api';
import { confirmDanger, notify } from '../lib/alerts';
import { Modal, inputCls } from './ui';

const rowCls =
  'flex w-full items-center gap-3 rounded-lg border border-white/[0.06] px-3 py-2.5 text-left text-sm text-zinc-200 transition-colors hover:bg-white/[0.03]';

function Section({ title, children }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

// One place for the app's settings: PIN, data out/in, Gmail, payday and version.
export default function SettingsModal({ lock, update, onLockChange, onGmail, onPayday, onClose }) {
  return (
    <Modal title="Pengaturan" onClose={onClose}>
      <div className="space-y-6">
        <Section title="Keamanan">
          <PinSettings enabled={lock.enabled} onChange={onLockChange} />
        </Section>
        <Section title="Data">
          <DataSettings />
        </Section>
        <Section title="Lainnya">
          <button onClick={onGmail} className={rowCls}>
            <Mail size={16} className="text-zinc-400" /> Pengaturan Gmail
          </button>
          {onPayday && (
            <button onClick={onPayday} className={rowCls}>
              <CalendarDays size={16} className="text-zinc-400" /> Tanggal gajian
            </button>
          )}
        </Section>
        <p className="text-center text-xs text-zinc-600">
          Celengin v{update?.current || '…'}
          {update?.available && (
            <>
              {' '}
              ·{' '}
              <a href={update.url} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
                versi {update.latest} udah ada
              </a>
            </>
          )}
        </p>
      </div>
    </Modal>
  );
}

// Set, change or remove the PIN. Changing or removing asks for the current one.
function PinSettings({ enabled, onChange }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ current: '', pin: '', again: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const digits = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.value.replace(/\D/g, '').slice(0, 6) }));

  const save = async (pin) => {
    setError('');
    if (pin !== null && pin !== v.again) return setError('PIN konfirmasinya beda');
    setSaving(true);
    try {
      const r = await put('/lock', { pin, current: v.current });
      onChange(r.enabled);
      notify(true, r.enabled ? 'PIN udah dipasang' : 'Kunci PIN dimatiin');
      setOpen(false);
      setV({ current: '', pin: '', again: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={rowCls}>
        <Lock size={16} className="text-zinc-400" />
        <span className="flex-1">Kunci pakai PIN</span>
        <span className={`text-xs ${enabled ? 'text-emerald-400' : 'text-zinc-500'}`}>{enabled ? 'Aktif' : 'Mati'}</span>
      </button>
    );
  }
  const pinInput = (k, label, autoFocus) => (
    <label className="block">
      <span className="mb-1 block text-xs text-zinc-400">{label}</span>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        autoFocus={autoFocus}
        value={v[k]}
        onChange={digits(k)}
        className={`${inputCls} tracking-[0.3em]`}
      />
    </label>
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save(v.pin);
      }}
      className="space-y-3 rounded-lg border border-white/[0.06] p-3"
    >
      <p className="text-xs text-zinc-500">
        PIN 4–6 angka, ditanya tiap Celengin dibuka. Ini kunci layar, database-nya sendiri nggak dienkripsi. Lupa PIN?
        Klik kanan ikon Celengin di tray → Reset PIN.
      </p>
      {enabled && pinInput('current', 'PIN sekarang', true)}
      <div className="grid grid-cols-2 gap-3">
        {pinInput('pin', enabled ? 'PIN baru' : 'PIN', !enabled)}
        {pinInput('again', 'Ulangi PIN')}
      </div>
      {error && (
        <p className="flex items-center gap-2 text-sm text-rose-400">
          <AlertCircle size={15} /> {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          disabled={saving || v.pin.length < 4}
          className="flex-1 rounded-lg bg-zinc-100 px-3 py-2 text-sm font-semibold text-zinc-900 hover:bg-white disabled:opacity-50"
        >
          {enabled ? 'Ganti PIN' : 'Pasang PIN'}
        </button>
        {enabled && (
          <button
            type="button"
            disabled={saving || v.current.length < 4}
            onClick={() => save(null)}
            className="rounded-lg px-3 py-2 text-sm text-zinc-400 ring-1 ring-white/[0.08] ring-inset hover:text-rose-400 disabled:opacity-50"
          >
            Matiin
          </button>
        )}
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 text-sm text-zinc-500 hover:text-zinc-200">
          Batal
        </button>
      </div>
    </form>
  );
}

// Export CSV, download a full backup, or restore one (the app restarts itself afterwards).
function DataSettings() {
  const fileRef = useRef(null);
  const [restoring, setRestoring] = useState(false);

  const restore = async (file) => {
    if (!file) return;
    const ok = await confirmDanger(
      'Restore dari backup ini?',
      `Semua data sekarang diganti isi "${file.name}". Data yang sekarang tetap disimpen di folder data sebagai cadangan.`,
      'Ya, restore'
    );
    if (!ok) return;
    setRestoring(true);
    try {
      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || res.statusText);
      notify(true, body.restart ? 'Restore beres, Celengin lagi restart…' : 'Restore siap. Restart server-nya buat dipakai.');
    } catch (err) {
      notify(false, err.message);
    } finally {
      setRestoring(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <a href="/api/export/transactions.csv" download className={rowCls}>
        <FileSpreadsheet size={16} className="text-zinc-400" />
        <span className="flex-1">Export transaksi (CSV, bisa dibuka di Excel / Sheets)</span>
        <Download size={14} className="text-zinc-500" />
      </a>
      <a href="/api/backup/download" download className={rowCls}>
        <Database size={16} className="text-zinc-400" />
        <span className="flex-1">Download backup lengkap (.db)</span>
        <Download size={14} className="text-zinc-500" />
      </a>
      <button onClick={() => fileRef.current?.click()} disabled={restoring} className={rowCls}>
        {restoring ? <RefreshCw size={16} className="animate-spin text-zinc-400" /> : <Upload size={16} className="text-zinc-400" />}
        <span className="flex-1">{restoring ? 'Lagi restore…' : 'Restore dari file backup'}</span>
      </button>
      <input ref={fileRef} type="file" accept=".db" hidden onChange={(e) => restore(e.target.files?.[0])} />
      <p className="text-xs text-zinc-600">Backup otomatis harian juga tetap jalan di folder data (14 terakhir).</p>
    </>
  );
}

// Fetches the update check once per app session (the server caches GitHub for 6 hours).
export function useUpdateCheck() {
  const [update, setUpdate] = useState(null);
  useEffect(() => {
    request('/update').then(setUpdate).catch(() => {});
  }, []);
  return update;
}
