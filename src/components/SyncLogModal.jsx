import { useEffect, useState } from 'react';
import { CheckCircle2, Inbox, RotateCcw } from 'lucide-react';
import { request } from '../lib/api';
import { DEVELOPER_EMAIL, mailtoDeveloper } from '../lib/contact';
import { notify } from '../lib/alerts';
import { formatDate } from '../lib/format';
import { TxAmount, TxTypeLabel } from './tx';
import { EmptyState, IconButton, LoadMore, Modal } from './ui';

const STEP = 20;

// Full sync history (including reverted rows). `result` is the sync that just ran, if any.
export default function SyncLogModal({ result, start, refreshKey, onRevert, onClose }) {
  const [limit, setLimit] = useState(STEP);
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    request(`/sync-log?limit=${limit + 1}`)
      .then((r) => {
        if (cancelled) return;
        setRows(r.slice(0, limit));
        setHasMore(r.length > limit);
      })
      .catch((e) => notify(false, e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [limit, refreshKey]);

  const newIds = new Set((result?.details || []).map((d) => d.message_id));
  const skipped = Object.entries(result?.skipped || {});

  return (
    <Modal title="Riwayat cek email" onClose={onClose} wide>
      {result && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-white/[0.06] bg-zinc-950 px-4 py-3 text-sm">
          <CheckCircle2 size={18} className="shrink-0 text-emerald-400" />
          <span className="text-zinc-300">
            {result.count ? (
              <>
                Dapet <b className="text-zinc-100">{result.count} transaksi baru</b>, udah dicatet semua. Saldo wallet juga udah ke-update.
              </>
            ) : (
              'Belum ada yang baru. Kamu irit banget hari ini.'
            )}
          </span>
        </div>
      )}
      {skipped.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-zinc-500">Dilewatin:</span>
          {skipped.map(([reason, n]) => (
            <span key={reason} className="rounded-md bg-white/[0.05] px-2 py-0.5 text-zinc-400">
              {reason} · {n}
            </span>
          ))}
          <p className="basis-full text-zinc-500">
            Email transaksi dari bank kamu nggak kebaca? Forward satu contohnya ke{' '}
            <a
              href={mailtoDeveloper('Celengin: format email belum kebaca')}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:underline"
            >
              {DEVELOPER_EMAIL}
            </a>{' '}
            (sensor dulu nomor rekening & saldonya), nanti formatnya ditambahin.
          </p>
        </div>
      )}
      <SyncLogTable rows={rows} newIds={newIds} onRevert={onRevert} start={start} />
      <LoadMore hasMore={hasMore} loading={loading} onMore={() => setLimit((l) => l + STEP)} className="mt-4" />
    </Modal>
  );
}

function SyncLogTable({ rows, newIds, onRevert, start }) {
  if (!rows.length) {
    return <EmptyState icon={Inbox} text={`Belum ada transaksi dari email sejak ${formatDate(start, false)}.`} />;
  }
  return (
    <div className="-mx-6 overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead className="text-xs text-zinc-500">
          <tr className="border-b border-white/[0.06]">
            <th className="px-6 py-2 font-medium">Tanggal</th>
            <th className="px-3 py-2 font-medium">Sumber</th>
            <th className="px-3 py-2 font-medium">Keterangan</th>
            <th className="px-3 py-2 font-medium">Kategori</th>
            <th className="px-3 py-2 text-right font-medium">Nominal</th>
            <th className="w-10 px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {rows.map((r) => {
            const isNew = newIds.has(r.message_id);
            return (
              <tr
                key={r.message_id}
                className={`transition-colors hover:bg-white/[0.02] ${isNew ? 'bg-emerald-500/[0.04]' : ''} ${r.reverted ? 'opacity-50' : ''}`}
              >
                <td className="whitespace-nowrap px-6 py-3 text-zinc-400">
                  {formatDate(r.email_date || r.synced_at)}
                  {isNew && <span className="ml-2 text-[10px] font-semibold uppercase text-emerald-400">Baru</span>}
                </td>
                <td className="px-3 py-3">
                  <span className="rounded-md bg-white/[0.05] px-1.5 py-0.5 text-xs text-zinc-300">{r.source || '—'}</span>
                </td>
                <td className="max-w-[220px] px-3 py-3">
                  <p className="truncate text-zinc-200" title={r.subject}>
                    {r.subject}
                  </p>
                  <p className="truncate text-xs text-zinc-500" title={r.target}>
                    {r.reverted && !String(r.target).startsWith('duplikat') ? 'Dibatalin' : r.target}
                  </p>
                </td>
                <td className="px-3 py-3">
                  <TxTypeLabel type={r.type} />
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right">
                  <TxAmount type={r.type} amount={r.amount} muted={Boolean(r.reverted)} />
                </td>
                <td className="px-3 py-3">
                  {!r.reverted && (
                    <IconButton onClick={() => onRevert(r)} title="Batalin transaksi" danger>
                      <RotateCcw size={14} />
                    </IconButton>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
