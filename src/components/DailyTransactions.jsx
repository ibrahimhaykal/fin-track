import { useEffect, useState } from 'react';
import {
  CalendarX,
  ChevronLeft,
  ChevronRight,
  CircleSlash2,
  Mail,
  PenLine,
  Plus,
  SearchX,
  Search,
  Sparkles,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { usePaged } from '../hooks/usePaged';
import { request } from '../lib/api';
import { notify } from '../lib/alerts';
import { rupiah } from '../lib/format';
import { TxAmount } from './tx';
import { Card, CardHeader, EmptyState, GhostButton, IconButton, LoadMore, Select } from './ui';

// "2026-09-25" +/- n days, done in UTC so there is no timezone drift.
const shiftDate = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const dayLabel = (date, today) => {
  if (date === today) return 'Hari ini';
  if (date === shiftDate(today, -1)) return 'Kemarin';
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('id-ID', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

// The 12 pay periods up to the current one as { value: '2026-10', label: 'Oktober 2026' }, newest first.
const recentMonths = (period) => {
  if (!period) return [];
  const [y, m] = period.split('-').map(Number);
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return {
      value: d.toISOString().slice(0, 7),
      label: d.toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    };
  });
};

const TYPES = [
  { value: '', label: 'Semua' },
  { value: 'expense', label: 'Keluar' },
  { value: 'income', label: 'Masuk' },
  { value: 'transfer', label: 'Transfer' },
];

const NO_FILTER = { q: '', type: '', month: '', uncategorized: false };

function Chip({ active, onClick, children, tone = 'zinc' }) {
  const on = tone === 'amber' ? 'bg-amber-500/15 text-amber-300 ring-amber-500/40' : 'bg-white/[0.08] text-zinc-100 ring-white/[0.12]';
  const off =
    tone === 'amber'
      ? 'text-amber-400/90 ring-amber-500/25 hover:bg-amber-500/10'
      : 'text-zinc-400 ring-white/[0.06] hover:bg-white/[0.04] hover:text-zinc-200';
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors ${active ? on : off}`}
    >
      {children}
    </button>
  );
}

// Wallet name for a side of a transaction; falls back to the pocket name from the email (flagged as unmatched).
function Side({ walletId, pocket, walletNames }) {
  if (walletId && walletNames[walletId]) return <span>{walletNames[walletId]}</span>;
  if (pocket) {
    return (
      <span className="text-amber-400/90" title="Belum ada wallet dengan nama ini, bikin dulu ya">
        {pocket}
      </span>
    );
  }
  return <span>{walletId ? 'wallet terhapus' : '?'}</span>;
}

// The ledger: one day at a time (manual entries and Gmail-synced ones together), or search/filter results across
// all days. Refetches when `refreshKey` changes.
export default function DailyTransactions({ walletNames, refreshKey, onAdd, onDelete, onLink, onEditCategory }) {
  const [date, setDate] = useState(null); // null = today (server decides, WIB)
  const [filter, setFilter] = useState(NO_FILTER);
  const [q, setQ] = useState(''); // search box text; copied into filter.q after a short pause
  const [day, setDay] = useState({ date: null, today: null, rows: [], totals: { income: 0, expense: 0 }, uncategorized: 0 });
  const page = usePaged(day.rows, 6);

  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => (f.q === q.trim() ? f : { ...f, q: q.trim() })), 250);
    return () => clearTimeout(t);
  }, [q]);

  const filtering = Boolean(filter.q || filter.type || filter.month || filter.uncategorized);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (filtering) {
      if (filter.q) params.set('q', filter.q);
      if (filter.type) params.set('type', filter.type);
      if (filter.month) params.set('month', filter.month);
      if (filter.uncategorized) params.set('uncategorized', '1');
    } else if (date) {
      params.set('date', date);
    }
    const qs = params.toString();
    request(`/transactions${qs ? `?${qs}` : ''}`)
      .then((d) => !cancelled && setDay(d))
      .catch((e) => notify(false, e.message));
    return () => {
      cancelled = true;
    };
  }, [date, filter, filtering, refreshKey]);

  const set = (patch) => setFilter((f) => ({ ...f, ...patch }));
  const clearAll = () => {
    setQ('');
    setFilter(NO_FILTER);
  };

  const current = day.date;
  const isToday = current && current === day.today;
  const go = (n) => current && setDate(shiftDate(current, n));

  return (
    <Card className="lg:col-span-3">
      <CardHeader
        title="Transaksi Harian"
        subtitle="Dari email & yang kamu catet"
        action={
          <GhostButton onClick={onAdd} className="bg-white/[0.04] text-zinc-200">
            <Plus size={14} /> Catat
          </GhostButton>
        }
      />

      <div className="space-y-2.5 px-6 pb-4">
        <div className="flex gap-2">
          <label className="relative flex-1">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-zinc-500" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQ('')}
              placeholder="Cari transaksi, kategori, atau nominal…"
              className="w-full rounded-lg border border-white/[0.08] bg-zinc-950 py-2 pr-8 pl-8 text-sm text-zinc-100 outline-none transition-colors placeholder:text-zinc-600 focus:border-sky-500"
            />
            {q && (
              <button
                onClick={() => setQ('')}
                title="Hapus pencarian"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-zinc-500 hover:text-zinc-200"
              >
                <X size={14} />
              </button>
            )}
          </label>
          <div className="w-44 shrink-0">
            <Select
              value={filter.month}
              onChange={(month) => set({ month })}
              title="Filter bulan"
              className="py-2"
              options={[{ value: '', label: 'Semua bulan' }, ...recentMonths(day.period || day.today)]}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {TYPES.map((t) => (
            <Chip key={t.value} active={filter.type === t.value} onClick={() => set({ type: t.value })}>
              {t.label}
            </Chip>
          ))}
          {(day.uncategorized > 0 || filter.uncategorized) && (
            <Chip tone="amber" active={filter.uncategorized} onClick={() => set({ uncategorized: !filter.uncategorized })}>
              <Tag size={11} /> Tanpa kategori · {day.uncategorized}
            </Chip>
          )}
          {filtering && (
            <button onClick={clearAll} className="ml-auto text-xs text-zinc-500 transition-colors hover:text-zinc-200">
              Reset filter
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 px-6 pb-4">
        {filtering ? (
          <p className="text-sm font-medium text-zinc-200">
            {day.rows.length} transaksi ketemu
            {day.rows.length === 500 && <span className="ml-1 text-xs font-normal text-zinc-500">(500 terbaru)</span>}
          </p>
        ) : (
          <div className="flex items-center gap-1">
            <IconButton onClick={() => go(-1)} title="Hari sebelumnya">
              <ChevronLeft size={16} />
            </IconButton>
            <span className="min-w-[8.5rem] text-center text-sm font-medium text-zinc-200">
              {current ? dayLabel(current, day.today) : '…'}
            </span>
            <IconButton onClick={() => go(1)} title="Hari berikutnya" className={isToday ? 'pointer-events-none opacity-30' : ''}>
              <ChevronRight size={16} />
            </IconButton>
            {!isToday && current && (
              <GhostButton onClick={() => setDate(null)} className="ml-1">
                Hari ini
              </GhostButton>
            )}
          </div>
        )}
        <div className="flex gap-4 text-right text-xs">
          <div>
            <p className="text-zinc-500">Keluar</p>
            <p className="text-sm font-semibold tabular-nums text-rose-400">{rupiah(day.totals.expense)}</p>
          </div>
          <div>
            <p className="text-zinc-500">Masuk</p>
            <p className="text-sm font-semibold tabular-nums text-emerald-400">{rupiah(day.totals.income)}</p>
          </div>
        </div>
      </div>

      <ul className="border-t border-white/[0.04] px-3 py-2">
        {page.visible.map((t) => {
          const fromEmail = t.source !== 'manual';
          const SourceIcon = fromEmail ? Mail : PenLine;
          const isTransfer = t.type === 'transfer';
          const unlinked = isTransfer && !(t.wallet && t.to_wallet);
          const walletText = isTransfer ? (
            <>
              <Side walletId={t.wallet || t.from_match} pocket={t.from_pocket} walletNames={walletNames} />
              {' → '}
              <Side walletId={t.to_wallet || t.to_match} pocket={t.to_pocket} walletNames={walletNames} />
            </>
          ) : (
            <Side walletId={t.wallet} pocket={t.type === 'income' ? t.to_pocket : t.from_pocket} walletNames={walletNames} />
          );
          return (
            <li
              key={t.id}
              className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-white/[0.03]"
            >
              <span
                title={fromEmail ? `Dari email (${t.source})` : 'Kamu catet sendiri'}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${fromEmail ? 'bg-sky-500/10 text-sky-400 ring-sky-500/20' : 'bg-white/[0.04] text-zinc-400 ring-white/[0.06]'}`}
              >
                <SourceIcon size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-zinc-200" title={t.description}>
                  {t.description}
                </p>
                <p className="truncate text-xs text-zinc-500">
                  {filtering && <>{dayLabel(t.date, day.today)} · </>}
                  {t.type === 'expense' &&
                    (t.category ? (
                      <>
                        <button
                          onClick={() => onEditCategory(t)}
                          title="Ganti kategori"
                          className="rounded text-zinc-400 transition-colors hover:text-zinc-200 hover:underline"
                        >
                          {t.category}
                        </button>
                        {' · '}
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => onEditCategory(t)}
                          title="Belum masuk budget mana pun. Klik buat kasih kategori"
                          className="mr-1 inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-px font-medium text-amber-300 ring-1 ring-amber-500/30 ring-inset transition-colors hover:bg-amber-500/20"
                        >
                          <Tag size={10} /> Kasih kategori
                        </button>
                      </>
                    ))}
                  {t.type !== 'expense' && t.category && <>{t.category} · </>}
                  {walletText}
                  {fromEmail && <> · {t.source}</>}
                  {t.applied === 0 && (
                    <span
                      className="ml-1.5 inline-flex items-center gap-0.5 text-zinc-500"
                      title="Cuma dicatat: saldo wallet-nya udah termasuk transaksi ini"
                    >
                      · <CircleSlash2 size={11} /> saldo nggak diubah
                    </span>
                  )}
                  {unlinked && (t.from_pocket || t.to_pocket) && (
                    <button
                      onClick={() => onLink(t)}
                      title="Cocokkan nama kantong ke wallet, lalu pindahkan saldo"
                      className="ml-2 rounded px-1.5 py-0.5 font-medium text-sky-400 ring-1 ring-sky-500/30 ring-inset transition-colors hover:bg-sky-500/10"
                    >
                      Hubungkan
                    </button>
                  )}
                </p>
              </div>
              <TxAmount type={t.type.toUpperCase()} amount={t.amount} />
              <IconButton
                onClick={() => onDelete(t)}
                title="Hapus transaksi"
                danger
                className="opacity-0 group-hover:opacity-100 focus:opacity-100"
              >
                <Trash2 size={14} />
              </IconButton>
            </li>
          );
        })}
        {filtering && day.rows.length === 0 && (
          <EmptyState
            icon={filter.uncategorized ? Sparkles : SearchX}
            text={filter.uncategorized ? 'Mantap, semua pengeluaran udah ada kategorinya.' : 'Nggak ketemu. Coba kata kunci lain, ya.'}
          />
        )}
        {!filtering && current && day.rows.length === 0 && (
          <EmptyState
            icon={isToday ? Sparkles : CalendarX}
            text={isToday ? 'Hari ini masih bersih. Dompet aman, hati tenang.' : 'Hari itu kosong, nggak ada transaksi.'}
          />
        )}
      </ul>
      <div className="px-6 pb-5 empty:hidden">
        <LoadMore remaining={page.remaining} step={page.step} onMore={page.more} onLess={page.less} />
      </div>
    </Card>
  );
}
