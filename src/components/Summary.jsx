import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, CalendarDays, ChevronDown, Flame, Eye, EyeOff, ShieldCheck, ShieldAlert } from 'lucide-react';
import { formatDate, pct, rupiah } from '../lib/format';
import { Legend, StackedBar } from './charts';
import { Card, IconButton } from './ui';

const monthLabel = (ym) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// Hero card: net worth + allocation bar on the left; this month's *real* flow (from the ledger) on the right,
// with the salary plan shown only as a reference line.
// The cheer that goes with a recording streak of `n` days (today = something recorded today already).
function streakText({ current: n, today }) {
  if (!n) return 'Yuk mulai streak, catet satu transaksi hari ini.';
  if (!today) return `Streak ${n} hari. Catet hari ini biar nggak putus!`;
  if (n >= 100) return `${n} hari nggak putus. Ini udah level legenda.`;
  if (n >= 30) return `Sebulan lebih konsisten nyatet. Keren parah, pertahanin!`;
  if (n >= 14) return `Dua minggu konsisten. Kebiasaan baik udah kebentuk nih.`;
  if (n >= 7) return `Seminggu penuh konsisten nyatet. Mantap, lanjutkan!`;
  if (n >= 3) return `Udah ${n} hari konsisten nyatet. Gas terus!`;
  return 'Awal yang bagus. Besok catet lagi, ya!';
}

function StreakBadge({ streak }) {
  const lit = streak.current > 0 && streak.today;
  return (
    <div className="mt-4 flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${lit ? 'bg-amber-500/15 text-amber-400 ring-amber-500/30' : 'bg-white/[0.04] text-zinc-500 ring-white/[0.08]'}`}
      >
        <Flame size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-200">
          <span className="font-semibold tabular-nums">{streak.current} hari</span> berturut-turut nyatet
          {streak.best > streak.current && <span className="text-xs text-zinc-500"> · rekor {streak.best} hari</span>}
          {streak.best > 1 && streak.best === streak.current && <span className="text-xs text-amber-400"> · rekor baru!</span>}
        </p>
        <p className="text-xs text-zinc-500">{streakText(streak)}</p>
      </div>
    </div>
  );
}

export default function Summary({ stats, actual, planStart, walletCount, safe, streak, hidden, onToggleHidden, onRecap, onPayday }) {
  const { totalWallets, allocation, netSavings: planNet } = stats;
  const { income, expense, net, month, count } = actual;
  const planActive = actual.month >= planStart.slice(0, 7);

  return (
    <Card className="mb-6 grid overflow-hidden lg:grid-cols-[1.6fr_1fr]">
      <div className="p-6 sm:p-8">
        <p className="flex items-center gap-2 text-sm text-zinc-400">
          Total duitmu
          <IconButton onClick={onToggleHidden} title={hidden ? 'Lihat saldo' : 'Umpetin saldo'} className="-my-1">
            {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
          </IconButton>
        </p>
        <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl">{rupiah(totalWallets)}</p>
        <p className="mt-2 text-sm text-zinc-500">Ada di {walletCount} wallet</p>
        <SafeToSpend safe={safe} />
        {streak && <StreakBadge streak={streak} />}
        <div className="mt-6">
          <StackedBar segments={allocation} label="Alokasi saldo per wallet" />
        </div>
        <div className="mt-5">
          <Legend items={allocation.map((a) => ({ ...a, share: pct(a.value, totalWallets) }))} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-white/[0.06] bg-white/[0.06] lg:grid-cols-1 lg:border-t-0 lg:border-l">
        <FlowStat label={`Pemasukan · ${monthLabel(month)}`} value={income} icon={ArrowUpRight} tone="text-emerald-400" />
        <FlowStat label={`Pengeluaran · ${monthLabel(month)}`} value={expense} icon={ArrowDownLeft} tone="text-rose-400" />
        <div className="col-span-2 bg-zinc-900/60 px-6 py-5 lg:col-span-1">
          <p className="flex items-center gap-2 text-xs text-zinc-500">
            Sisa bulan ini
            <span className="rounded bg-white/[0.05] px-1.5 py-px text-[10px] font-medium text-zinc-400">
              real · {count} transaksi
            </span>
          </p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${net >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {rupiah(net)}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {planActive ? (
              <>
                Targetnya <span className="font-medium text-zinc-300">{rupiah(planNet)}</span> / bulan
                {income > 0 && <> · savings rate {pct(net, income).toFixed(0)}%</>}
              </>
            ) : (
              <>
                Rencananya {rupiah(planNet)} / bulan, mulai jalan {formatDate(planStart, false)}
              </>
            )}
          </p>
          {actual.start && (
            <p className="mt-1 text-xs text-zinc-500">
              Periode {shortDate(actual.start)} – {shortDate(actual.end)}
            </p>
          )}
          {onPayday && (
            <button
              onClick={onPayday}
              title="Gajinya maju / mundur? Atur di sini"
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-sky-500/10 px-2.5 py-1.5 text-xs font-medium text-sky-300 ring-1 ring-sky-500/30 ring-inset transition-colors hover:bg-sky-500/20"
            >
              <CalendarDays size={13} /> Gajian {shortDate(actual.start)} · ubah
            </button>
          )}
          <button
            onClick={onRecap}
            className="mt-3 block text-xs font-medium text-sky-400 transition-colors hover:text-sky-300 hover:underline"
          >
            Lihat rekap bulanan
          </button>
        </div>
      </div>
    </Card>
  );
}

function FlowStat({ label, value, icon: Icon, tone }) {
  return (
    <div className="bg-zinc-900/60 px-6 py-5">
      <p className="flex items-center gap-1.5 text-xs text-zinc-500">
        <Icon size={13} className={tone} /> {label}
      </p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-zinc-100">{rupiah(value)}</p>
    </div>
  );
}

const shortDate = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// "Aman dipakai": what is free to spend until the next salary, with the breakdown one click away.
function SafeToSpend({ safe }) {
  const [open, setOpen] = useState(false);
  const ok = safe.safe >= 0;
  const Icon = ok ? ShieldCheck : ShieldAlert;
  const until = safe.nextIncome ? `${safe.nextIncome.name.toLowerCase()} ${shortDate(safe.until)}` : `${shortDate(safe.until)}`;
  return (
    <div className="mt-5 rounded-xl border border-white/[0.06] bg-white/[0.02]">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <Icon size={18} className={`shrink-0 ${ok ? 'text-emerald-400' : 'text-rose-400'}`} />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-zinc-500">
            {ok ? 'Aman dipakai' : 'Kelebihan rencana'} sampai {until} · {safe.daysLeft} hari lagi
          </p>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className={`text-xl font-semibold tabular-nums ${ok ? 'text-emerald-400' : 'text-rose-400'}`}>
              {rupiah(Math.abs(safe.safe))}
            </span>
            <span className="text-xs text-zinc-500">
              {ok ? <>≈ {rupiah(Math.floor(safe.perDay / 1000) * 1000)} / hari di luar budget</> : 'rem dulu ya, saldonya nggak nutup budget & jadwal'}
            </span>
          </p>
        </div>
        <ChevronDown size={16} className={`shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <dl className="space-y-1.5 border-t border-white/[0.06] px-4 py-3 text-xs">
          <Line label="Saldo siap pakai" value={safe.liquid} hint="Wallet biasa. Investasi live (reksa dana, crypto) nggak diitung." />
          <Line
            label="Jadwal rutin yang belum dibayar"
            value={-safe.scheduledTotal}
            hint={safe.scheduled.length ? safe.scheduled.map((x) => x.name).join(', ') : 'Semua udah beres bulan ini'}
          />
          <Line label="Sisa budget bulan ini" value={-safe.budgetLeft} hint="Udah dialokasiin buat kategori budget" />
          <div className="flex justify-between border-t border-white/[0.06] pt-1.5 font-medium text-zinc-200">
            <dt>{ok ? 'Aman dipakai' : 'Kurang'}</dt>
            <dd className="tabular-nums">{rupiah(safe.safe)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function Line({ label, value, hint }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="min-w-0">
        <span className="text-zinc-400">{label}</span>
        {hint && <span className="block truncate text-[11px] text-zinc-600">{hint}</span>}
      </dt>
      <dd className="shrink-0 tabular-nums text-zinc-300">
        {value < 0 ? '− ' : ''}
        {rupiah(Math.abs(value))}
      </dd>
    </div>
  );
}
