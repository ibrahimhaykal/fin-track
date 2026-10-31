import { ArrowDownLeft, ArrowUpRight, BellRing, CalendarClock, CalendarDays, CheckCircle2, Plus, Repeat, SkipForward, Trash2, Undo2 } from 'lucide-react';
import { daysUntil, rupiah } from '../lib/format';
import { Card, CardHeader, EditableAmount, EmptyState, GhostButton, IconButton } from './ui';

// "2026-10-01" -> "1 Okt"
const shortDate = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const dueText = (occ) => {
  const n = daysUntil(occ.due);
  if (n === 0) return 'hari ini';
  if (n === 1) return 'besok';
  return n > 0 ? `${n} hari lagi` : `${-n} hari lalu`;
};

// Verb for the confirm button: money in arrives, money out gets paid.
export const confirmLabel = (rule) => (rule.type === 'income' ? 'Udah masuk' : 'Udah dibayar');

// Every month that is due but still unsettled, across all schedules (oldest first).
export const pendingOccurrences = (recurring) =>
  recurring
    .flatMap((rule) => rule.occurrences.filter((o) => o.status === 'pending').map((occ) => ({ rule, occ })))
    .sort((a, b) => a.occ.due.localeCompare(b.occ.due));

// Banner on top of the dashboard while something scheduled has not shown up yet (late BCA email, or none at all).
export function PendingRecurring({ items, onConfirm, onSkip }) {
  if (!items.length) return null;
  return (
    <section className="mb-6 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] px-5 py-4">
      <div className="mb-3 flex items-start gap-2.5">
        <BellRing size={16} className="mt-0.5 shrink-0 text-amber-400" />
        <div>
          <h3 className="text-sm font-semibold text-zinc-100">Ada yang belum kecatat nih</h3>
          <p className="text-xs text-zinc-400">
            Email-nya bisa telat. Kalau nanti nyampe, ini beres sendiri. Kalau udah pasti masuk, klik aja biar saldonya
            langsung bener.
          </p>
        </div>
      </div>
      <ul className="space-y-2">
        {items.map(({ rule, occ }) => (
          <li
            key={`${rule.id}-${occ.period}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-zinc-950/40 px-3.5 py-2.5 ring-1 ring-white/[0.04] ring-inset"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-zinc-200">
                {rule.name} · <span className="font-semibold tabular-nums">{rupiah(rule.amount)}</span>
              </p>
              <p className="text-xs text-zinc-500">
                Jadwalnya {shortDate(occ.due)} ({dueText(occ)})
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => onConfirm(rule, occ)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-semibold text-zinc-900 transition-colors hover:bg-white"
              >
                <CheckCircle2 size={13} /> {confirmLabel(rule)}
              </button>
              <GhostButton onClick={() => onSkip(rule, occ)}>
                <SkipForward size={13} /> Lewatin
              </GhostButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Status({ rule, occ, walletName, onConfirm, onUnskip }) {
  if (!occ) return null;
  if (occ.status === 'done') {
    const tx = occ.transaction;
    return (
      <span
        title={tx ? `${tx.description} · ${rupiah(tx.amount)} · ${shortDate(tx.date)}${tx.source !== 'manual' ? ` · dari ${tx.source}` : ''}` : ''}
        className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400 ring-1 ring-emerald-500/20 ring-inset"
      >
        <CheckCircle2 size={11} /> Beres
      </span>
    );
  }
  if (occ.status === 'skipped') {
    return (
      <button
        onClick={() => onUnskip(rule, occ)}
        title="Batal dilewatin"
        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-zinc-500 ring-1 ring-white/[0.08] ring-inset transition-colors hover:text-zinc-200"
      >
        <Undo2 size={11} /> Dilewatin
      </button>
    );
  }
  if (occ.status === 'pending') {
    return (
      <button
        onClick={() => onConfirm(rule, occ)}
        title={`Catat ${rule.name} ke ${walletName}`}
        className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-amber-500/30 ring-inset transition-colors hover:bg-amber-500/20"
      >
        <BellRing size={11} /> Nunggu
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
      <CalendarClock size={11} /> {dueText(occ)}
    </span>
  );
}

// Monthly schedules with this month's status. Amount edits in place; clicking the name opens the full edit form.
export default function RecurringCard({ recurring, walletNames, onAdd, onEdit, onUpdate, onDelete, onConfirm, onUnskip, onPayday }) {
  const settled = recurring.filter((r) => r.occurrences.at(-1)?.status === 'done').length;
  return (
    <Card>
      <CardHeader
        title="Rutin Bulanan"
        subtitle={recurring.length ? `${settled} dari ${recurring.length} udah beres bulan ini` : 'Gaji, kiriman, tagihan tiap bulan'}
        action={
          <div className="flex items-center gap-1">
            {onPayday && (
              <GhostButton onClick={onPayday}>
                <CalendarDays size={14} /> Tgl gajian
              </GhostButton>
            )}
            <GhostButton onClick={onAdd}>
              <Plus size={14} /> Jadwal
            </GhostButton>
          </div>
        }
      />
      <ul className="px-3 pb-4">
        {recurring.map((r) => {
          const Icon = r.type === 'income' ? ArrowUpRight : ArrowDownLeft;
          const walletName = walletNames[r.wallet] || 'wallet terhapus';
          return (
            <li
              key={r.id}
              className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-white/[0.03]"
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ${r.type === 'income' ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20' : 'bg-rose-500/10 text-rose-400 ring-rose-500/20'}`}
              >
                <Icon size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <button
                  onClick={() => onEdit(r)}
                  title="Ubah jadwal"
                  className="block max-w-full truncate text-left text-sm text-zinc-200 transition-colors hover:text-white hover:underline"
                >
                  {r.name}
                </button>
                <p className="truncate text-xs text-zinc-500">
                  {r.day === 1 ? 'tiap gajian' : `tiap tgl ${r.day}`} · {walletName}
                  {r.category && r.category !== r.name && <> · {r.category}</>}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <EditableAmount value={r.amount} onSave={(amount) => onUpdate(r.id, { amount })} className="text-sm text-zinc-200" />
                <Status rule={r} occ={r.occurrences.at(-1)} walletName={walletName} onConfirm={onConfirm} onUnskip={onUnskip} />
              </div>
              <IconButton
                onClick={() => onDelete(r)}
                title="Hapus jadwal"
                danger
                className="opacity-0 group-hover:opacity-100 focus:opacity-100"
              >
                <Trash2 size={14} />
              </IconButton>
            </li>
          );
        })}
        {recurring.length === 0 && <EmptyState icon={Repeat} text="Belum ada jadwal. Mulai dari gaji, yuk." />}
      </ul>
    </Card>
  );
}
