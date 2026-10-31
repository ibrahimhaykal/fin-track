import { useEffect, useState } from 'react';
import { Eye, EyeOff, History, Mail, Monitor, Moon, RefreshCw, Settings, Sun } from 'lucide-react';
import CelenganAyam from './CelenganAyam';
import { formatDate, relativeTime } from '../lib/format';
import { useThemeMode } from '../lib/themeMode';

const outlineBtn =
  'inline-flex items-center gap-2 rounded-lg border border-white/[0.08] px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-white/[0.04] hover:text-zinc-100';

const THEME_OPTIONS = [
  { key: 'system', label: 'Ikut sistem', icon: Monitor },
  { key: 'light', label: 'Terang', icon: Sun },
  { key: 'dark', label: 'Gelap', icon: Moon },
];

// Sistem / Terang / Gelap pill.
function ThemePill() {
  const [mode, setMode] = useThemeMode();
  return (
    <div role="radiogroup" aria-label="Tema" className="flex rounded-lg border border-white/[0.08] p-0.5">
      {THEME_OPTIONS.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          role="radio"
          aria-checked={mode === key}
          title={label}
          aria-label={label}
          onClick={() => setMode(key)}
          className={`rounded-md p-1.5 transition-colors ${mode === key ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200'}`}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}

// Re-render on an interval so relative times ("5 menit lalu") keep moving without a reload.
function useNow(ms) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export default function Header({ sync, hidden, onToggleHidden, onOpenLog, onSettings, onSync, syncing }) {
  useNow(30 * 1000);
  const connected = sync.configured !== false;
  return (
    <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-100 text-zinc-900">
          <CelenganAyam size={30} title="Celengin" />
        </span>
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Celengin</h1>
          <p className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Mail size={12} />
            {/* The sync start date is only a detail, so it lives in the tooltip. */}
            <span title={`Email transaksi dibaca mulai ${formatDate(sync.start, false)}`}>
              {!connected ? (
                'Gmail belum dihubungin'
              ) : syncing ? (
                'Lagi ngecek email…'
              ) : sync.lastSync ? (
                // Real date + time of the last check, plus a relative hint that keeps ticking (useNow above).
                <>
                  Terakhir dicek {formatDate(sync.lastSync)}
                  {Date.now() - new Date(sync.lastSync).getTime() < 86400000 && <> · {relativeTime(sync.lastSync)}</>}
                </>
              ) : (
                'Email belum pernah dicek'
              )}
            </span>
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ThemePill />
        <button
          onClick={onToggleHidden}
          title={hidden ? 'Lihat saldo' : 'Umpetin saldo'}
          aria-label={hidden ? 'Lihat saldo' : 'Umpetin saldo'}
          aria-pressed={hidden}
          className={outlineBtn}
        >
          {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
          <span className="hidden sm:inline">{hidden ? 'Lihat saldo' : 'Umpetin saldo'}</span>
        </button>
        <button onClick={onOpenLog} className={outlineBtn}>
          <History size={15} /> Log
        </button>
        <button onClick={onSettings} title="Pengaturan Gmail" aria-label="Pengaturan Gmail" className={outlineBtn}>
          <Settings size={15} />
          <span className="hidden sm:inline">Gmail</span>
        </button>
        <button
          onClick={onSync}
          disabled={syncing}
          className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-3.5 py-2 text-sm font-semibold text-zinc-900 shadow-sm transition-all hover:bg-white active:scale-[0.98] disabled:cursor-wait disabled:opacity-70"
        >
          {connected ? <RefreshCw size={15} className={syncing ? 'animate-spin' : ''} /> : <Mail size={15} />}
          {!connected ? 'Hubungin Gmail' : syncing ? 'Lagi ngintip email…' : 'Cek mutasi'}
        </button>
      </div>
    </header>
  );
}
