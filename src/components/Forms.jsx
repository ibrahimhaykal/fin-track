import { useEffect, useState } from 'react';
import { AlertCircle, ArrowDownLeft, ArrowUpRight, Bitcoin, Landmark, RefreshCw, Repeat, Search } from 'lucide-react';
import { request } from '../lib/api';
import { coins, formatDate, nav, rupiah } from '../lib/format';
import { MILESTONE_COLOR, WALLET_ICONS, isFundAsset } from '../lib/theme';
import { CreateForm, IconPicker, Modal, MoneyInput, Select, SuggestInput, inputCls } from './ui';

// Each form calls onCreate(path, body, successMessage); it throws on API errors so the form shows them.

export function WalletForm({ walletTypes, onCreate, onClose }) {
  return (
    <Modal title="Wallet baru" onClose={onClose}>
      <CreateForm
        submitLabel="Tambah wallet"
        fields={[
          { name: 'icon', label: 'Ikon', type: 'icon', defaultValue: 'Wallet' },
          { name: 'name', label: 'Nama', placeholder: 'mis. Kantong Liburan', required: true },
          { name: 'category', label: 'Tipe', placeholder: 'mis. Tabungan, E-Wallet', options: walletTypes },
          { name: 'balance', label: 'Saldo awal', type: 'money', defaultValue: '0' },
        ]}
        onSubmit={(v) =>
          onCreate('/wallets', { name: v.name, category: v.category, icon: v.icon, balance: Number(v.balance || 0) }, 'Sip, wallet baru udah jadi')
        }
      />
    </Modal>
  );
}

export function WalletIconForm({ wallet, onPick, onClose }) {
  return (
    <Modal title={`Ikon · ${wallet.name}`} onClose={onClose}>
      <IconPicker value={WALLET_ICONS[wallet.icon] ? wallet.icon : null} onChange={(icon) => onPick(wallet, icon)} />
    </Modal>
  );
}

const TX_TYPES = [
  { key: 'expense', label: 'Pengeluaran', icon: ArrowDownLeft, active: 'bg-rose-500/15 text-rose-300 ring-rose-500/30' },
  { key: 'income', label: 'Pemasukan', icon: ArrowUpRight, active: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  { key: 'transfer', label: 'Transfer', icon: Repeat, active: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' },
];

const todayWib = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());

// Manual ledger entry. Defaults to an expense from the main wallet, today.
export function TransactionForm({ wallets, categories, defaultWallet, onCreate, onClose }) {
  const [v, setV] = useState({
    type: 'expense',
    amount: '',
    description: '',
    category: '',
    wallet: defaultWallet || wallets[0]?.id || '',
    to_wallet: '',
    date: todayWib(),
    recordOnly: false, // "saldo udah bener": history + monthly totals only, the balance already includes it
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const isTransfer = v.type === 'transfer';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!v.wallet || (isTransfer && !v.to_wallet)) return setError('Pilih wallet-nya dulu, ya');
    setSaving(true);
    try {
      await onCreate(
        '/transactions',
        {
          type: v.type,
          amount: Number(v.amount),
          description: v.description,
          category: v.type === 'expense' ? v.category : '',
          wallet: v.wallet,
          to_wallet: isTransfer ? v.to_wallet : null,
          date: v.date,
          affects_balance: !v.recordOnly,
        },
        'Udah dicatet'
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const walletSelect = (key, label, exclude) => (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-zinc-400">{label}</span>
      <Select
        value={v[key]}
        onChange={(id) => set(key, id)}
        placeholder="Pilih wallet"
        options={wallets.filter((w) => w.id !== exclude).map((w) => ({ value: w.id, label: w.name }))}
      />
    </div>
  );

  return (
    <Modal title="Catet transaksi" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div role="radiogroup" aria-label="Tipe transaksi" className="grid grid-cols-3 gap-2">
          {TX_TYPES.map(({ key, label, icon: Icon, active }) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={v.type === key}
              onClick={() => set('type', key)}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold ring-1 ring-inset transition-colors ${v.type === key ? active : 'text-zinc-400 ring-white/[0.08] hover:bg-white/[0.04] hover:text-zinc-100'}`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">Nominal</span>
          <MoneyInput
            autoFocus
            required
            value={v.amount}
            onChange={(val) => set('amount', val)}
            placeholder="0"
            inputClassName={`${inputCls} text-lg font-semibold`}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">Keterangan</span>
          <input
            value={v.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder={isTransfer ? 'mis. Top up RDPU' : v.type === 'income' ? 'mis. Bonus CRM' : 'mis. Kopi susu'}
            className={inputCls}
          />
        </label>

        {v.type === 'expense' && (
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Kategori</span>
            <SuggestInput
              value={v.category}
              onChange={(c) => set('category', c)}
              options={categories}
              placeholder="mis. Jajan / Kopi"
            />
          </label>
        )}

        <div className={`grid gap-3 ${isTransfer ? 'grid-cols-2' : ''}`}>
          {walletSelect('wallet', isTransfer ? 'Dari wallet' : v.type === 'income' ? 'Masuk ke wallet' : 'Bayar pakai wallet')}
          {isTransfer && walletSelect('to_wallet', 'Ke wallet', v.wallet)}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">Tanggal</span>
          <input type="date" value={v.date} max={todayWib()} onChange={(e) => set('date', e.target.value)} className={inputCls} />
        </label>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/[0.06] px-3 py-2.5">
          <input
            type="checkbox"
            checked={v.recordOnly}
            onChange={(e) => set('recordOnly', e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-sky-500"
          />
          <span className="text-xs leading-relaxed text-zinc-400">
            <span className="block text-sm font-medium text-zinc-200">Saldo udah bener, cuma catat</span>
            Centang kalau saldo wallet-nya udah kamu samain. Transaksinya tetap masuk riwayat & hitungan bulanan, tapi saldo
            nggak dipotong lagi.
          </span>
        </label>

        {error && (
          <p className="flex items-center gap-2 text-sm text-rose-400">
            <AlertCircle size={15} /> {error}
          </p>
        )}
        <button
          disabled={saving}
          className="w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-60"
        >
          {saving ? 'Nyimpen…' : 'Catet'}
        </button>
      </form>
    </Modal>
  );
}

// Accepts Indonesian and English styles: "0,00018977", "2.135,36" and Bibit's "2,135.3600" all parse.
// With both separators present, the last one is the decimal point; a lone "," is decimal (Indonesian);
// a lone "." followed by exactly 3 digits in groups ("1.500") is a thousands separator.
const parseDecimal = (input) => {
  let s = String(input).trim().replace(/\s/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? ',' : '.';
    s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    s = s.replace(/,/g, '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  return Number(s);
};

// Turn a wallet into a live-priced wallet, or back to a normal one. Two kinds:
//  - Crypto: coin amount x IDR price (CoinGecko / Indodax), refreshed every few minutes.
//  - Reksa dana: units x NAB per unit (Pasardana), published once per trading day.
// onSave(wallet, body) may throw; the error is shown inline.
export function LivePriceForm({ wallet, onSave, onClose }) {
  const [kind, setKind] = useState(isFundAsset(wallet.asset) ? 'fund' : 'crypto');
  const [mode, setMode] = useState('units'); // 'units' | 'rupiah'
  const [value, setValue] = useState(wallet.asset ? String(wallet.units ?? '') : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Crypto
  const [coinsList, setCoinsList] = useState(null);
  const [coin, setCoin] = useState(isFundAsset(wallet.asset) || !wallet.asset ? 'bitcoin' : wallet.asset);

  // Reksa dana
  const [query, setQuery] = useState('');
  const [funds, setFunds] = useState([]);
  const [searching, setSearching] = useState(false);
  const [fund, setFund] = useState(null); // selected fund { id, name, nav, navDate, ... }

  useEffect(() => {
    request('/crypto/assets')
      .then(setCoinsList)
      .catch(() => setCoinsList([]));
    if (isFundAsset(wallet.asset)) {
      request(`/funds/search?id=${encodeURIComponent(wallet.asset)}`)
        .then((r) => r[0] && setFund(r[0]))
        .catch(() => {});
    }
  }, [wallet.asset]);

  // Debounced fund search. The first search downloads the full fund list once (a few seconds).
  useEffect(() => {
    if (kind !== 'fund' || query.trim().length < 3) {
      setFunds([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      setSearching(true);
      request(`/funds/search?q=${encodeURIComponent(query.trim())}`)
        .then((r) => !cancelled && setFunds(r))
        .catch((e) => !cancelled && setError(e.message))
        .finally(() => !cancelled && setSearching(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [kind, query]);

  const coinInfo = coinsList?.find((a) => a.id === coin);
  const price = kind === 'fund' ? fund?.nav : coinInfo?.price;
  const unitName = kind === 'fund' ? 'unit' : coinInfo?.symbol || 'koin';
  const n = mode === 'rupiah' ? Number(value || NaN) : parseDecimal(value);
  const valid = value !== '' && Number.isFinite(n) && n >= 0;
  const preview = price && valid ? (mode === 'units' ? rupiah(n * price) : `${coins(n / price, { fund: kind === 'fund' })} ${unitName}`) : null;
  const asset = kind === 'fund' ? fund?.id : coin;

  const switchMode = (next) => {
    setMode(next);
    setValue(next === 'rupiah' ? String(Math.round(wallet.balance || 0) || '') : wallet.asset ? String(wallet.units ?? '') : '');
  };

  const save = async (body) => {
    setSaving(true);
    setError('');
    try {
      await onSave(wallet, body);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Harga live · ${wallet.name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && asset) save({ asset, ...(mode === 'units' ? { units: n } : { balance: n }) });
        }}
        className="space-y-4"
      >
        <div role="radiogroup" aria-label="Jenis aset" className="grid grid-cols-2 gap-2">
          {[
            ['crypto', 'Crypto', Bitcoin],
            ['fund', 'Reksa dana', Landmark],
          ].map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={kind === key}
              onClick={() => setKind(key)}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold ring-1 ring-inset transition-colors ${kind === key ? 'bg-sky-500/15 text-sky-300 ring-sky-500/30' : 'text-zinc-400 ring-white/[0.08] hover:bg-white/[0.04] hover:text-zinc-100'}`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        <p className="text-xs leading-relaxed text-zinc-400">
          {kind === 'fund'
            ? 'Saldo dihitung dari jumlah unit × NAB terbaru. NAB diumumin tiap hari bursa, data dari Pasardana.'
            : 'Saldo dihitung dari jumlah koin × harga live (IDR), diperbarui tiap 5 menit.'}
        </p>

        {kind === 'crypto' ? (
          <div>
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Koin</span>
            <Select
              value={coin}
              onChange={setCoin}
              options={(coinsList || [{ id: coin, symbol: '…', name: 'Lagi dimuat…' }]).map((a) => ({
                value: a.id,
                label: `${a.symbol} · ${a.name}`,
              }))}
            />
            <span className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-500">
              {!coinsList && <RefreshCw size={12} className="animate-spin" />}
              {coinInfo?.price ? (
                <>
                  1 {coinInfo.symbol} = <b className="font-medium text-zinc-300">{rupiah(coinInfo.price)}</b> · {coinInfo.source}
                </>
              ) : (
                coinsList && 'Harga lagi nggak tersedia'
              )}
            </span>
          </div>
        ) : (
          <div>
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Reksa dana</span>
            {fund ? (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-sky-500/30 bg-sky-500/[0.06] px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-100">{fund.name}</p>
                  <p className="mt-0.5 text-xs text-zinc-400">
                    {fund.type}
                    {fund.sharia && ' · Syariah'} · NAB <b className="font-medium text-zinc-200">{nav(fund.nav)}</b> (
                    {formatDate(fund.navDate, false)})
                    {fund.yearly != null && <> · 1 thn {(fund.yearly * 100).toFixed(2)}%</>}
                  </p>
                </div>
                <button type="button" onClick={() => setFund(null)} className="shrink-0 text-xs font-medium text-sky-400 hover:underline">
                  Ganti
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-zinc-500" />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Cari nama, mis. majoris pasar uang"
                    className={`${inputCls} pl-9`}
                  />
                </div>
                <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                  {searching && (
                    <p className="flex items-center gap-2 px-1 py-2 text-xs text-zinc-500">
                      <RefreshCw size={12} className="animate-spin" /> Lagi nyari… (pertama kali agak lama)
                    </p>
                  )}
                  {!searching && query.trim().length >= 3 && funds.length === 0 && (
                    <p className="px-1 py-2 text-xs text-zinc-500">Nggak ketemu. Coba kata lain, ya.</p>
                  )}
                  {funds.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setFund(f)}
                      className="block w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/[0.05]"
                    >
                      <p className="text-sm text-zinc-200">{f.name}</p>
                      <p className="text-[11px] text-zinc-500">
                        {f.type}
                        {f.sharia && ' · Syariah'} · NAB {nav(f.nav)}
                        {f.yearly != null && <> · 1 thn {(f.yearly * 100).toFixed(2)}%</>}
                      </p>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">
              {mode === 'units' ? (kind === 'fund' ? 'Jumlah unit (lihat di app Bibit)' : `Jumlah ${unitName}`) : 'Nilai sekarang'}
            </span>
            <div className="flex rounded-lg bg-white/[0.04] p-0.5 text-[11px]">
              {[
                ['units', kind === 'fund' ? 'Jumlah unit' : 'Jumlah koin'],
                ['rupiah', 'Nilai Rp'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => switchMode(key)}
                  className={`rounded-md px-2 py-1 font-medium transition-colors ${mode === key ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {mode === 'rupiah' ? (
            <MoneyInput
              required
              value={value}
              onChange={setValue}
              placeholder="mis. 3.190.888"
              inputClassName={`${inputCls} text-lg font-semibold`}
            />
          ) : (
            <input
              inputMode="decimal"
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={kind === 'fund' ? 'mis. 2134,1062' : 'mis. 0,00018977'}
              className={`${inputCls} text-lg font-semibold tabular-nums`}
            />
          )}
          {preview && <p className="mt-1.5 text-xs text-zinc-400">≈ {preview}</p>}
        </div>

        {error && (
          <p className="flex items-center gap-2 text-sm text-rose-400">
            <AlertCircle size={15} /> {error}
          </p>
        )}
        <button
          disabled={saving || !valid || !price || !asset}
          className="w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-60"
        >
          {saving ? 'Nyimpen…' : wallet.asset ? 'Simpan' : 'Nyalain harga live'}
        </button>
        {wallet.asset && (
          <button
            type="button"
            disabled={saving}
            onClick={() => save({ asset: null })}
            className="w-full rounded-lg px-4 py-2 text-xs font-medium text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-rose-300"
          >
            Matiin harga live (balik jadi wallet biasa)
          </button>
        )}
      </form>
    </Modal>
  );
}

const NEW_WALLET = '__new__';

// Match an unlinked transfer to wallets with two dropdowns. A pocket with no wallet yet defaults to
// "+ Buat wallet baru"; its balance is typed as shown in the bank app *now* (after this transfer).
export function LinkTransferForm({ tx, wallets, onLink, onClose }) {
  const init = (match, pocket) => ({ choice: match || (pocket ? NEW_WALLET : ''), name: pocket || '', current: '' });
  const [sides, setSides] = useState({ from: init(tx.from_match, tx.from_pocket), to: init(tx.to_match, tx.to_pocket) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (side, patch) => setSides((s) => ({ ...s, [side]: { ...s[side], ...patch } }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const body = {};
    for (const side of ['from', 'to']) {
      const s = sides[side];
      if (!s.choice) return setError('Pilih wallet-nya dulu, ya');
      if (s.choice !== NEW_WALLET) {
        body[side] = s.choice;
        continue;
      }
      const current = Number(s.current || 0);
      // Balance before this transfer: the destination had less, the source had more.
      body[side] = { name: s.name, balance: side === 'to' ? current - tx.amount : current + tx.amount };
      if (body[side].balance < 0) return setError(`Saldo "${s.name}" sekarang minimal ${rupiah(tx.amount)}`);
    }
    if (body.from && body.from === body.to) return setError('Wallet asal dan tujuan harus beda');
    setSaving(true);
    try {
      await onLink(tx, body);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const sideField = (side, label, pocket) => {
    const s = sides[side];
    const other = sides[side === 'from' ? 'to' : 'from'].choice;
    return (
      <div className="space-y-2">
        <div>
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">
            {label}
            {pocket && <span className="text-zinc-500"> · di email: “{pocket}”</span>}
          </span>
          <Select
            value={s.choice}
            onChange={(choice) => set(side, { choice })}
            placeholder="Pilih wallet"
            options={[
              ...wallets.map((w) => ({ value: w.id, label: w.name, disabled: w.id === other })),
              { value: NEW_WALLET, label: `+ Buat wallet baru${pocket ? `: ${pocket}` : ''}` },
            ]}
          />
        </div>
        {s.choice === NEW_WALLET && (
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-dashed border-white/[0.08] p-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-zinc-500">Nama wallet</span>
              <input value={s.name} onChange={(e) => set(side, { name: e.target.value })} required className={inputCls} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-zinc-500">Saldo di aplikasi sekarang</span>
              <MoneyInput
                value={s.current}
                onChange={(val) => set(side, { current: val })}
                placeholder="0"
                inputClassName={inputCls}
              />
            </label>
          </div>
        )}
      </div>
    );
  };

  return (
    <Modal title="Hubungin transfer" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-xl border border-white/[0.06] bg-zinc-950 px-4 py-3">
          <p className="text-sm text-zinc-200">{tx.description}</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-sky-400">{rupiah(tx.amount)}</p>
        </div>
        {sideField('from', 'Dari wallet', tx.from_pocket)}
        {sideField('to', 'Ke wallet', tx.to_pocket)}
        <p className="text-xs text-zinc-500">Saldo pindah dari wallet asal ke tujuan. Total duitmu nggak berubah.</p>
        {error && (
          <p className="flex items-center gap-2 text-sm text-rose-400">
            <AlertCircle size={15} /> {error}
          </p>
        )}
        <button
          disabled={saving}
          className="w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-60"
        >
          {saving ? 'Nyimpen…' : 'Hubungin & pindahin saldo'}
        </button>
      </form>
    </Modal>
  );
}

export function PlanItemForm({ type, onCreate, onClose }) {
  const income = type === 'income';
  return (
    <Modal title={income ? 'Pos pemasukan rencana' : 'Pos pengeluaran tetap'} onClose={onClose}>
      <CreateForm
        submitLabel="Tambah ke rencana"
        fields={[
          { name: 'name', label: 'Nama', placeholder: income ? 'mis. Freelance' : 'mis. Cicilan Motor', required: true },
          { name: 'amount', label: 'Nominal per bulan', type: 'money', required: true },
          { name: 'note', label: 'Catatan (opsional)', placeholder: income ? 'mis. naik Jan 2027' : 'mis. s.d. Des 2027' },
        ]}
        onSubmit={(v) => onCreate('/plan-items', { ...v, type, amount: Number(v.amount) }, 'Udah masuk rencana')}
      />
    </Modal>
  );
}

// Edit a milestone's target, and choose how its progress fills: typed by hand, or automatically from
// spending in one category since a start date (e.g. monthly transfers to Ibu tagged "Komitmen Ibu").
export function MilestoneEditForm({ milestone: m, categories, onSave, onClose }) {
  const isFlag = m.target_amount === 1 && !m.track_category;
  const [target, setTarget] = useState(isFlag ? '' : String(Math.round(m.target_amount)));
  const [deadline, setDeadline] = useState(m.deadline || '');
  const [auto, setAuto] = useState(Boolean(m.track_category));
  const [category, setCategory] = useState(m.track_category || '');
  const [since, setSince] = useState(m.track_since || todayWib());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!Number(target)) return setError('Isi target nominalnya dulu, ya');
    if (auto && !category.trim()) return setError('Pilih kategori yang mau dilacak');
    setSaving(true);
    try {
      await onSave(m, {
        target_amount: Number(target),
        deadline: deadline || null,
        track_category: auto ? category.trim() : null,
        track_since: auto ? since : null,
        // Switching back to manual keeps what was collected so far.
        ...(!auto && m.track_category ? { current_amount: m.current_amount } : {}),
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Atur target · ${m.title}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {isFlag && (
          <p className="rounded-lg bg-sky-500/10 px-3 py-2 text-xs leading-relaxed text-sky-300">
            Target ini sekarang cuma "lunas / belum". Isi nominal biar progresnya bisa jalan, misalnya Rp 1,2 jt × 15 bulan =
            Rp 18 jt.
          </p>
        )}
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">Target</span>
          <MoneyInput autoFocus required value={target} onChange={setTarget} placeholder="0" inputClassName={`${inputCls} text-lg font-semibold`} />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">Deadline</span>
          <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className={inputCls} />
        </label>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">Progres diisi</span>
          <div role="radiogroup" className="grid grid-cols-2 gap-2">
            {[
              [false, 'Manual'],
              [true, 'Otomatis dari kategori'],
            ].map(([value, label]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={auto === value}
                onClick={() => setAuto(value)}
                className={`rounded-lg px-2 py-2 text-xs font-semibold ring-1 ring-inset transition-colors ${auto === value ? 'bg-sky-500/15 text-sky-300 ring-sky-500/30' : 'text-zinc-400 ring-white/[0.08] hover:bg-white/[0.04] hover:text-zinc-100'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {auto && (
          <div className="grid grid-cols-[1fr_auto] gap-3 rounded-lg border border-dashed border-white/[0.08] p-3">
            <label className="block">
              <span className="mb-1 block text-[11px] text-zinc-500">Kategori pengeluaran</span>
              <SuggestInput value={category} onChange={setCategory} options={categories} placeholder="mis. Komitmen Ibu" />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-zinc-500">Mulai dihitung</span>
              <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className={inputCls} />
            </label>
            <p className="col-span-2 text-[11px] leading-relaxed text-zinc-500">
              Tiap pengeluaran berkategori ini (dari email atau yang kamu catet) sejak tanggal itu langsung nambahin progres.
            </p>
          </div>
        )}

        {error && (
          <p className="flex items-center gap-2 text-sm text-rose-400">
            <AlertCircle size={15} /> {error}
          </p>
        )}
        <button
          disabled={saving}
          className="w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-60"
        >
          {saving ? 'Nyimpen…' : 'Simpan'}
        </button>
      </form>
    </Modal>
  );
}

export function ExpenseForm({ onCreate, onClose }) {
  return (
    <Modal title="Budget baru" onClose={onClose}>
      <CreateForm
        submitLabel="Tambah budget"
        fields={[
          { name: 'name', label: 'Nama kategori', placeholder: 'mis. Laundry', required: true },
          { name: 'amount', label: 'Budget per bulan', type: 'money', required: true },
        ]}
        onSubmit={(v) => onCreate('/expenses', { name: v.name, amount: Number(v.amount) }, 'Budget baru udah jadi')}
      />
    </Modal>
  );
}

export function MilestoneForm({ milestones, onCreate, onClose }) {
  const categories = [...new Set([...Object.keys(MILESTONE_COLOR), ...milestones.map((m) => m.category).filter(Boolean)])];
  return (
    <Modal title="Target baru" onClose={onClose}>
      <CreateForm
        submitLabel="Tambah target"
        fields={[
          { name: 'title', label: 'Judul', placeholder: 'mis. Dana Liburan Jepang', required: true },
          { name: 'target_amount', label: 'Target', type: 'money', required: true },
          { name: 'current_amount', label: 'Terkumpul saat ini', type: 'money', defaultValue: '0' },
          { name: 'deadline', label: 'Deadline', type: 'date' },
          { name: 'category', label: 'Kategori', placeholder: 'mis. Asset', options: categories },
          { name: 'notes', label: 'Catatan', placeholder: 'Strategi / sumber dana' },
        ]}
        onSubmit={(v) =>
          onCreate(
            '/milestones',
            { ...v, target_amount: Number(v.target_amount), current_amount: Number(v.current_amount || 0) },
            'Target udah dipasang. Semangat!'
          )
        }
      />
    </Modal>
  );
}

// "Masuk kategori apa?" for one ledger row: free text, with budgets and used categories as suggestions.
export function CategoryForm({ tx, categories, onSave, onClose }) {
  const [category, setCategory] = useState(tx.category || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onSave(tx, category.trim());
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title="Masuk kategori apa?" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="truncate text-sm text-zinc-400" title={tx.description}>
          {tx.description} · <span className="tabular-nums text-zinc-300">{rupiah(tx.amount)}</span>
        </p>
        <SuggestInput value={category} onChange={setCategory} options={categories} placeholder="mis. Gym & Olahraga" autoFocus />
        {error && (
          <p className="flex items-center gap-2 text-sm text-rose-400">
            <AlertCircle size={15} /> {error}
          </p>
        )}
        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-60"
        >
          {saving ? 'Nyimpen…' : 'Simpan'}
        </button>
      </form>
    </Modal>
  );
}

// New or edited monthly schedule (salary, transfer to Ibu, bills). `rule` is null for a new one.
export function RecurringForm({ rule, wallets, categories, defaultWallet, onSave, onClose }) {
  const [v, setV] = useState({
    name: rule?.name || '',
    type: rule?.type || 'income',
    amount: rule ? String(Math.round(rule.amount)) : '',
    wallet: rule?.wallet || defaultWallet || wallets[0]?.id || '',
    category: rule?.category || '',
    day: String(rule?.day || 1),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!v.wallet) return setError('Pilih wallet-nya dulu, ya');
    setSaving(true);
    try {
      await onSave(rule, {
        name: v.name,
        type: v.type,
        amount: Number(v.amount),
        wallet: v.wallet,
        // Defaults to the name so matching by category works out of the box ("Komitmen Ibu").
        category: v.category.trim() || v.name.trim(),
        day: Number(v.day),
      });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={rule ? 'Ubah jadwal' : 'Jadwal rutin baru'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div role="radiogroup" aria-label="Tipe" className="grid grid-cols-2 gap-2">
          {TX_TYPES.filter((t) => t.key !== 'transfer').map(({ key, label, icon: Icon, active }) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={v.type === key}
              onClick={() => set('type', key)}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold ring-1 ring-inset transition-colors ${v.type === key ? active : 'text-zinc-400 ring-white/[0.08] hover:bg-white/[0.04] hover:text-zinc-100'}`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">Nama</span>
          <input
            autoFocus
            required
            value={v.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder={v.type === 'income' ? 'mis. Gaji' : 'mis. Komitmen Ibu'}
            className={inputCls}
          />
        </label>

        <div className="grid grid-cols-[1fr_7rem] gap-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Nominal</span>
            <MoneyInput required value={v.amount} onChange={(val) => set('amount', val)} placeholder="0" inputClassName={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Tiap tanggal</span>
            <input
              type="number"
              min={1}
              max={31}
              required
              value={v.day}
              onChange={(e) => set('day', e.target.value)}
              className={inputCls}
            />
          </label>
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">
            {v.type === 'income' ? 'Masuk ke wallet' : 'Bayar dari wallet'}
          </span>
          <Select
            value={v.wallet}
            onChange={(id) => set('wallet', id)}
            placeholder="Pilih wallet"
            options={wallets.map((w) => ({ value: w.id, label: w.name }))}
          />
        </div>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">Kategori</span>
          <SuggestInput
            value={v.category}
            onChange={(c) => set('category', c)}
            options={categories}
            placeholder={v.name.trim() || 'Kosongin = sama kayak nama'}
          />
        </label>

        <p className="text-xs leading-relaxed text-zinc-500">
          Saldo nggak diubah otomatis. Kalau ada transaksi yang cocok (dari email atau kamu catet) sekitar tanggalnya,
          bulan itu langsung beres. Kalau belum ada, muncul pengingat buat kamu konfirmasi.
        </p>

        {error && (
          <p className="flex items-center gap-2 text-sm text-rose-400">
            <AlertCircle size={15} /> {error}
          </p>
        )}
        <button
          disabled={saving}
          className="w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-60"
        >
          {saving ? 'Nyimpen…' : rule ? 'Simpan' : 'Bikin jadwal'}
        </button>
      </form>
    </Modal>
  );
}

// "Pengaturan Gmail": the mailbox to read transaction emails from, from when, and the default wallet.
// The App Password is write-only: the server only says whether one is saved.
export function GmailSettingsForm({ wallets, onSaved, onClose }) {
  const [s, setS] = useState(null);
  const [v, setV] = useState({ user: '', pass: '', start: '', mainWallet: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tested, setTested] = useState(false);

  useEffect(() => {
    request('/settings/gmail')
      .then((r) => {
        setS(r);
        setV({ user: r.user, pass: '', start: r.start, mainWallet: r.mainWallet || '' });
      })
      .catch((e) => setError(e.message));
  }, []);
  const set = (k, val) => {
    setV((x) => ({ ...x, [k]: val }));
    setTested(false);
  };
  const body = () => ({ user: v.user, pass: v.pass, start: v.start, mainWallet: v.mainWallet || null });

  const act = (kind, fn) => async (e) => {
    e?.preventDefault();
    setError('');
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };
  const test = act('test', async () => {
    await request('/settings/gmail/test', { method: 'POST', body: JSON.stringify(body()) });
    setTested(true);
  });
  const save = act('save', async () => onSaved(await request('/settings/gmail', { method: 'PUT', body: JSON.stringify(body()) })));
  const disconnect = act('disconnect', async () =>
    onSaved(await request('/settings/gmail', { method: 'PUT', body: JSON.stringify({ disconnect: true }) }))
  );

  const guessed = wallets.find((w) => w.id === s?.guessedMainWallet)?.name;
  return (
    <Modal title="Pengaturan Gmail" onClose={onClose}>
      {!s ? (
        <p className="text-sm text-zinc-500">{error || 'Bentar…'}</p>
      ) : (
        <form onSubmit={save} className="space-y-4">
          <p className="text-xs leading-relaxed text-zinc-400">
            Celengin cuma baca email notif transaksi dari bank & aplikasi yang dikenal. Email diproses di laptop ini,
            nggak dikirim ke mana-mana. Pakai{' '}
            <a
              href="https://myaccount.google.com/apppasswords"
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:underline"
            >
              App Password Gmail
            </a>{' '}
            (16 huruf), bukan password biasa. Perlu verifikasi 2 langkah aktif.
          </p>
          {s.fromEnv && (
            <p className="rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
              Sekarang kebaca dari file <code>.env</code>. Kalau disimpan di sini, setting ini yang dipakai.
            </p>
          )}
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Email Gmail</span>
            <input
              type="email"
              autoFocus
              value={v.user}
              onChange={(e) => set('user', e.target.value)}
              placeholder="kamu@gmail.com"
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">App Password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={v.pass}
              onChange={(e) => set('pass', e.target.value)}
              placeholder={s.hasPassword ? '•••• udah tersimpan (kosongin kalau nggak diganti)' : 'abcd efgh ijkl mnop'}
              className={inputCls}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-400">Baca email mulai</span>
              <input type="date" value={v.start} max={todayWib()} onChange={(e) => set('start', e.target.value)} className={inputCls} />
            </label>
            <div>
              <span className="mb-1.5 block text-xs font-medium text-zinc-400">Wallet utama</span>
              <Select
                value={v.mainWallet}
                onChange={(id) => set('mainWallet', id)}
                options={[
                  { value: '', label: guessed ? `Otomatis (${guessed})` : 'Otomatis' },
                  ...wallets.filter((w) => !w.asset).map((w) => ({ value: w.id, label: w.name })),
                ]}
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-zinc-500">
            Wallet utama dipakai buat transaksi yang email-nya nggak nyebut pocket/rekening.
          </p>
          {error && (
            <p className="flex items-center gap-2 text-sm text-rose-400">
              <AlertCircle size={15} /> {error}
            </p>
          )}
          {tested && <p className="text-sm text-emerald-400">Nyambung! Login Gmail berhasil.</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={test}
              disabled={Boolean(busy)}
              className="flex-1 rounded-lg border border-white/[0.08] px-4 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/[0.04] disabled:opacity-60"
            >
              {busy === 'test' ? 'Ngecek…' : 'Tes koneksi'}
            </button>
            <button
              disabled={Boolean(busy)}
              className="flex-1 rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-60"
            >
              {busy === 'save' ? 'Nyimpen…' : 'Simpan'}
            </button>
          </div>
          {s.configured && !s.fromEnv && (
            <button
              type="button"
              onClick={disconnect}
              disabled={Boolean(busy)}
              className="w-full text-center text-xs text-zinc-500 transition-colors hover:text-rose-400"
            >
              Putusin Gmail dari Celengin
            </button>
          )}
        </form>
      )}
    </Modal>
  );
}

const periodLabel = (ym) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

// "Tanggal gajian": when a period's salary actually came, which is where that period starts (default the 1st).
// `periods` = [this period, next period] from the dashboard; the upcoming payday is picked once it is near.
export function PaydayForm({ periods, onSave, onClose }) {
  const today = todayWib();
  const [current, next] = periods;
  const [period, setPeriod] = useState(today >= next.bounds[0] ? next.period : current.period);
  const info = periods.find((p) => p.period === period);
  const [date, setDate] = useState(info.start);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const first = `${period}-01`;
  const lastOfPrev = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10);

  const pickPeriod = (p) => {
    setPeriod(p);
    setDate(periods.find((x) => x.period === p).start);
  };
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onSave(period, date === first ? null : date);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title="Tanggal gajian" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs leading-relaxed text-zinc-400">
          Periode keuangan mulai dari hari gajian sampai sehari sebelum gajian berikutnya. Kalau gajinya maju (misal
          masuk 31 Okt), semua yang masuk & keluar dari tanggal itu diitung ke bulan berikutnya.
        </p>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">Gaji buat bulan</span>
          <Select
            value={period}
            onChange={pickPeriod}
            options={periods.map((p) => ({ value: p.period, label: periodLabel(p.period) }))}
          />
        </label>
        <div>
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">Masuknya tanggal</span>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {[
              [first, 'Tgl 1 (biasa)'],
              [lastOfPrev, `Akhir bulan, ${dayLabel(lastOfPrev)}`],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setDate(value)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors ${date === value ? 'bg-sky-500/15 text-sky-300 ring-sky-500/40' : 'text-zinc-400 ring-white/[0.08] hover:text-zinc-200'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="date"
            required
            value={date}
            min={info.bounds[0]}
            max={info.bounds[1]}
            onChange={(e) => setDate(e.target.value)}
            className={inputCls}
          />
          <p className="mt-1.5 text-xs text-zinc-500">
            {periodLabel(period)} jadi mulai <span className="text-zinc-300">{dayLabel(date || first)}</span>
          </p>
        </div>
        {error && (
          <p className="flex items-center gap-2 text-sm text-rose-400">
            <AlertCircle size={15} /> {error}
          </p>
        )}
        <button
          disabled={saving}
          className="w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-60"
        >
          {saving ? 'Nyimpen…' : 'Simpan'}
        </button>
      </form>
    </Modal>
  );
}

// "Udah masuk" / "Udah dibayar" for one month of a schedule: the amount can differ (bonus, deductions).
export function RecurringConfirmForm({ rule, occ, walletName, onConfirm, onClose }) {
  const [amount, setAmount] = useState(String(Math.round(rule.amount)));
  const [date, setDate] = useState(occ.due);
  const [recordOnly, setRecordOnly] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const income = rule.type === 'income';

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onConfirm(rule, occ, { period: occ.period, amount: Number(amount), date, affects_balance: !recordOnly });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={income ? `${rule.name} udah masuk?` : `${rule.name} udah dibayar?`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-400">Nominal {income ? 'yang masuk' : 'yang dibayar'}</span>
          <MoneyInput autoFocus required value={amount} onChange={setAmount} inputClassName={`${inputCls} text-lg font-semibold`} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Tanggal</span>
            <input type="date" value={date} max={todayWib()} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </label>
          <div>
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Wallet</span>
            <p className="truncate rounded-lg border border-white/[0.06] px-3 py-2.5 text-sm text-zinc-300">{walletName}</p>
          </div>
        </div>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-white/[0.06] px-3 py-2.5">
          <input
            type="checkbox"
            checked={recordOnly}
            onChange={(e) => setRecordOnly(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-sky-500"
          />
          <span className="text-xs leading-relaxed text-zinc-400">
            <span className="block text-sm font-medium text-zinc-200">Saldo udah bener, cuma catat</span>
            Centang kalau saldo {walletName} udah kamu samain dan udah termasuk ini.
          </span>
        </label>
        {error && (
          <p className="flex items-center gap-2 text-sm text-rose-400">
            <AlertCircle size={15} /> {error}
          </p>
        )}
        <button
          disabled={saving}
          className="w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-60"
        >
          {saving ? 'Nyimpen…' : 'Catet'}
        </button>
      </form>
    </Modal>
  );
}
