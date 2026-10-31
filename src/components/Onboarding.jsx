import { useState } from 'react';
import { AlertCircle, Check, Mail, Wallet } from 'lucide-react';
import { post } from '../lib/api';
import { rupiah } from '../lib/format';
import CelenganAyam from './CelenganAyam';
import { MoneyInput, inputCls } from './ui';

// Starter budgets. Names match the server's auto-category rules (CATEGORY_RULES), so expenses read from email
// land in them right away.
const BUDGET_TEMPLATES = [
  ['Makan', 1500000],
  ['Jajan / Kopi', 300000],
  ['Transport', 400000],
  ['Bensin', 300000],
  ['Parkir & Toll', 100000],
  ['Belanja', 500000],
  ['Pulsa & Internet', 150000],
  ['Langganan', 100000],
  ['Gym & Olahraga', 200000],
  ['Game', 100000],
  ['Sedekah', 100000],
];
const WALLET_TYPES = ['Bank', 'E-Wallet', 'Tunai'];
const STEPS = ['Wallet pertama', 'Budget bulanan', 'Gmail'];

// First run (no wallets yet): one wallet with its real balance, starter budgets, then optionally Gmail.
export default function Onboarding({ onDone, onGmail }) {
  const [step, setStep] = useState(0);
  const [wallet, setWallet] = useState({ name: 'Rekening Utama', category: 'Bank', balance: '0' });
  const [picked, setPicked] = useState(new Set(['Makan', 'Jajan / Kopi', 'Transport', 'Pulsa & Internet']));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const saveWallet = (e) => {
    e.preventDefault();
    run(async () => {
      await post('/wallets', { name: wallet.name.trim(), category: wallet.category, icon: 'Wallet', balance: Number(wallet.balance || 0) });
      setStep(1);
    });
  };
  const saveBudgets = () =>
    run(async () => {
      for (const [name, amount] of BUDGET_TEMPLATES.filter(([n]) => picked.has(n))) await post('/expenses', { name, amount });
      setStep(2);
    });
  const toggle = (name) =>
    setPicked((s) => {
      const next = new Set(s);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 py-10 font-sans text-zinc-100 antialiased">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-100 text-zinc-900">
            <CelenganAyam size={34} title="Celengin" />
          </span>
          <h1 className="text-xl font-semibold">Selamat datang di Celengin</h1>
          <p className="mt-1 text-sm text-zinc-500">3 langkah singkat, abis itu langsung bisa nyatet.</p>
        </div>
        <ol className="mb-5 flex gap-2">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={`flex flex-1 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs ${i === step ? 'bg-sky-500/15 text-sky-300' : i < step ? 'text-emerald-400' : 'text-zinc-600'}`}
            >
              {i < step ? <Check size={12} /> : <span className="tabular-nums">{i + 1}.</span>} {label}
            </li>
          ))}
        </ol>

        <div className="rounded-2xl border border-white/[0.06] bg-zinc-900/60 p-5">
          {step === 0 && (
            <form onSubmit={saveWallet} className="space-y-4">
              <p className="flex items-center gap-2 text-sm text-zinc-300">
                <Wallet size={15} className="text-zinc-400" /> Duitmu biasanya di mana? Isi saldo yang sekarang.
              </p>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-400">Nama wallet</span>
                <input
                  required
                  autoFocus
                  value={wallet.name}
                  onChange={(e) => setWallet((w) => ({ ...w, name: e.target.value }))}
                  placeholder="mis. BCA, GoPay, Dompet"
                  className={inputCls}
                />
              </label>
              <div className="flex gap-1.5">
                {WALLET_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setWallet((w) => ({ ...w, category: t }))}
                    className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium ring-1 ring-inset ${wallet.category === t ? 'bg-sky-500/15 text-sky-300 ring-sky-500/40' : 'text-zinc-400 ring-white/[0.08] hover:text-zinc-200'}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-400">Saldo sekarang</span>
                <MoneyInput value={wallet.balance} onChange={(balance) => setWallet((w) => ({ ...w, balance }))} inputClassName={inputCls} />
              </label>
              <p className="text-xs text-zinc-500">Wallet lain (bank kedua, e-wallet, tunai) bisa ditambah nanti dari dashboard.</p>
              <Footer error={error} busy={busy} label="Lanjut" />
            </form>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-300">Pilih budget bulanan. Nominalnya bisa diubah kapan aja di dashboard.</p>
              <div className="flex flex-wrap gap-1.5">
                {BUDGET_TEMPLATES.map(([name, amount]) => {
                  const on = picked.has(name);
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggle(name)}
                      aria-pressed={on}
                      className={`rounded-lg px-2.5 py-1.5 text-left text-xs ring-1 ring-inset transition-colors ${on ? 'bg-sky-500/15 text-sky-200 ring-sky-500/40' : 'text-zinc-400 ring-white/[0.08] hover:text-zinc-200'}`}
                    >
                      <span className="font-medium">{name}</span>
                      <span className="ml-1.5 tabular-nums text-zinc-500">{rupiah(amount)}</span>
                    </button>
                  );
                })}
              </div>
              <Footer
                error={error}
                busy={busy}
                label={picked.size ? `Pakai ${picked.size} budget` : 'Lewatin dulu'}
                onClick={saveBudgets}
              />
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <p className="flex items-center gap-2 text-sm text-zinc-300">
                <Mail size={15} className="text-zinc-400" /> Mau transaksi kecatat otomatis dari email bank?
              </p>
              <p className="text-xs leading-relaxed text-zinc-500">
                Celengin bisa baca notif transaksi dari Gmail (Jago, BCA, Mandiri, Bibit, dll.). Opsional, bisa diatur nanti
                juga dari tombol Gmail di atas.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => onGmail()}
                  className="flex-1 rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-white"
                >
                  Hubungin Gmail
                </button>
                <button
                  onClick={onDone}
                  className="flex-1 rounded-lg border border-white/[0.08] px-4 py-2.5 text-sm text-zinc-300 hover:bg-white/[0.04]"
                >
                  Nanti aja
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Footer({ error, busy, label, onClick }) {
  return (
    <>
      {error && (
        <p className="flex items-center gap-2 text-sm text-rose-400">
          <AlertCircle size={15} /> {error}
        </p>
      )}
      <button
        type={onClick ? 'button' : 'submit'}
        onClick={onClick}
        disabled={busy}
        className="w-full rounded-lg bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white disabled:opacity-60"
      >
        {busy ? 'Nyimpen…' : label}
      </button>
    </>
  );
}
