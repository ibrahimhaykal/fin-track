import { useState } from 'react';
import { Lock } from 'lucide-react';
import { post } from '../lib/api';
import CelenganAyam from './CelenganAyam';

// Full-screen PIN prompt shown on open (and after the app sat hidden in the tray for a while).
export default function LockScreen({ onUnlock }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setChecking(true);
    setError('');
    try {
      await post('/lock/verify', { pin });
      onUnlock();
    } catch (err) {
      setError(err.message);
      setPin('');
      setChecking(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 font-sans text-zinc-100 antialiased">
      <form onSubmit={submit} className="w-full max-w-xs text-center">
        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 text-zinc-900">
          <CelenganAyam size={40} title="Celengin" />
        </span>
        <h1 className="flex items-center justify-center gap-2 text-lg font-semibold">
          <Lock size={16} className="text-zinc-400" /> Celengin dikunci
        </h1>
        <p className="mt-1 text-sm text-zinc-500">Masukin PIN buat buka</p>
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          aria-label="PIN"
          className="mt-6 w-full rounded-xl border border-white/[0.08] bg-zinc-900 px-4 py-3 text-center text-2xl tracking-[0.5em] text-zinc-100 outline-none focus:border-sky-500"
        />
        {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
        <button
          disabled={pin.length < 4 || checking}
          className="mt-4 w-full rounded-xl bg-zinc-100 px-4 py-3 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-50"
        >
          {checking ? 'Ngecek…' : 'Buka'}
        </button>
        <p className="mt-6 text-xs text-zinc-600">Lupa PIN? Klik kanan ikon Celengin di tray → Reset PIN.</p>
      </form>
    </div>
  );
}
