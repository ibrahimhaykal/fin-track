import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { del, post, put, request } from './lib/api';
import { DEVELOPER_EMAIL, mailtoDeveloper } from './lib/contact';
import { confirmDanger, notify, swal } from './lib/alerts';
import { readHiddenPref, rupiah, saveHiddenPref, setAmountsHidden, todayWib } from './lib/format';
import { safeToSpend, spentByCategory, summarize } from './lib/finance';
import { useBudgetAlerts } from './hooks/useBudgetAlerts';
import CashflowCard from './components/CashflowCard';
import DailyTransactions from './components/DailyTransactions';
import ExpensesCard from './components/ExpensesCard';
import RecurringCard, { PendingRecurring, pendingOccurrences } from './components/RecurringCard';
import {
  CategoryForm,
  RecurringConfirmForm,
  RecurringForm,
  LivePriceForm,
  ExpenseForm,
  LinkTransferForm,
  MilestoneEditForm,
  MilestoneForm,
  PlanItemForm,
  TransactionForm,
  WalletForm,
  WalletIconForm,
  PaydayForm,
  GmailSettingsForm,
} from './components/Forms';
import LockScreen from './components/LockScreen';
import Onboarding from './components/Onboarding';
import SettingsModal, { useUpdateCheck } from './components/SettingsModal';
import Header from './components/Header';
import RecapModal, { RecapBanner, markRecapSeen, recapSeen } from './components/RecapModal';
import MilestoneRoadmap from './components/MilestoneRoadmap';
import Summary from './components/Summary';
import SyncLogModal from './components/SyncLogModal';
import WalletGrid from './components/WalletGrid';

// App owns the dashboard data and every action that changes it; components only render.
const UNLOCKED_KEY = 'celengin-unlocked';
const RELOCK_AFTER_MS = 5 * 60 * 1000;

// PIN lock state: locked on open (once per session) and again after the window sat hidden in the tray for a while.
function usePinLock() {
  const [state, setState] = useState({ enabled: false, locked: false, checked: false });
  useEffect(() => {
    let unlocked = false;
    try {
      unlocked = sessionStorage.getItem(UNLOCKED_KEY) === '1';
    } catch {
      // storage blocked: ask every time
    }
    request('/lock')
      .then((r) => setState({ enabled: r.enabled, locked: r.enabled && !unlocked, checked: true }))
      .catch(() => setState((s) => ({ ...s, checked: true })));
  }, []);
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) hiddenAt = Date.now();
      else if (hiddenAt && Date.now() - hiddenAt > RELOCK_AFTER_MS) setState((s) => (s.enabled ? { ...s, locked: true } : s));
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  const remember = (value) => {
    try {
      sessionStorage.setItem(UNLOCKED_KEY, value);
    } catch {
      // ignore
    }
  };
  return {
    ...state,
    unlock: () => {
      remember('1');
      setState((s) => ({ ...s, locked: false }));
    },
    setEnabled: (enabled) => setState((s) => ({ ...s, enabled })),
  };
}

export default function App() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [modal, setModal] = useState(null); // 'transaction' | 'wallet' | 'expense' | 'milestone' | 'syncLog' | 'gmail' | 'settings'
  const [iconFor, setIconFor] = useState(null); // wallet whose icon is being changed
  const [cryptoFor, setCryptoFor] = useState(null); // wallet being set up as a live crypto wallet
  const [linkFor, setLinkFor] = useState(null); // unlinked transfer being matched to wallets
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0); // bump to make the daily ledger + sync log refetch
  const [flashIds, setFlashIds] = useState([]);
  const flashTimer = useRef();
  const [hidden, setHidden] = useState(readHiddenPref);
  const [recap, setRecap] = useState(null); // { month } while the recap modal is open (month null = last month)
  const [recapDismissed, setRecapDismissed] = useState(false);
  const [onboarded, setOnboarded] = useState(false); // finished or skipped the first-run steps this session
  const update = useUpdateCheck();
  const lock = usePinLock();
  setAmountsHidden(hidden);

  const toggleHidden = () =>
    setHidden((h) => {
      saveHiddenPref(!h);
      return !h;
    });

  const load = async () => {
    try {
      setData(await request('/dashboard'));
      setLoadError('');
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setLoadError('Duh, datanya lagi susah dipanggil. Coba refresh, ya?');
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Crypto wallets are revalued on the server every 5 min; pick that up without a page reload.
  const hasCrypto = Boolean(data?.wallets.some((w) => w.asset));
  useEffect(() => {
    if (!hasCrypto) return;
    const t = setInterval(() => request('/dashboard').then(setData).catch(() => {}), 60 * 1000);
    return () => clearInterval(t);
  }, [hasCrypto]);

  // Budget notifications (80% / 100%). Called before the loading return below, like every hook.
  const spent = useMemo(() => (data ? spentByCategory(data.actual) : {}), [data]);
  useBudgetAlerts(data?.expenses || [], spent, data?.actual.month);

  // Run a mutation, then refresh the dashboard in place.
  const run = async (fn, successMessage) => {
    try {
      await fn();
      await load();
      if (successMessage) notify(true, successMessage);
    } catch (e) {
      notify(false, e.message);
    }
  };

  // Used by the create forms: throws on failure so the form can show the error inline.
  const create = async (path, body, message) => {
    await post(path, body);
    setModal(null);
    await load();
    notify(true, message);
  };

  // Typing a balance = "samain saldo": emails for older transactions will no longer move it again.
  const updateWallet = (id, balance) =>
    run(() => put(`/wallets/${id}`, { balance }), 'Saldo disamain. Transaksi sebelum ini nggak motong lagi');

  const updateWalletIcon = (w, icon) => {
    setIconFor(null);
    if (icon === w.icon) return;
    // Optimistic: swap the icon right away, the refresh in run() confirms it.
    setData((d) => ({ ...d, wallets: d.wallets.map((x) => (x.id === w.id ? { ...x, icon } : x)) }));
    run(() => put(`/wallets/${w.id}`, { icon }), 'Ikonnya udah diganti');
  };

  const deleteWallet = async (w) =>
    (await confirmDanger(`Yakin hapus wallet "${w.name}"?`, 'Saldonya ikut ilang dari total duitmu, lho.')) &&
    run(() => del(`/wallets/${w.id}`), 'Beres, wallet udah dihapus');

  const updateExpense = (id, patch) => run(() => put(`/expenses/${id}`, patch), 'Budget udah diupdate');

  // Renaming a budget also moves its past transactions and tracked targets to the new name (server side).
  const renameExpense = async (x) => {
    const { value, isConfirmed } = await swal.fire({
      title: 'Ganti nama budget',
      text: 'Transaksi yang udah masuk kategori ini ikut pindah ke nama baru.',
      input: 'text',
      inputValue: x.name,
      showCancelButton: true,
      confirmButtonText: 'Simpan',
      cancelButtonText: 'Batal',
      inputValidator: (v) => (!v.trim() ? 'Namanya diisi dulu, ya' : undefined),
    });
    if (isConfirmed && value.trim() !== x.name) run(() => put(`/expenses/${x.id}`, { name: value }), 'Nama budget udah diganti');
  };

  const deleteExpense = async (x) =>
    (await confirmDanger(`Hapus budget "${x.name}"?`, `Budget ${rupiah(x.amount)} / bulan-nya ikut ilang.`)) &&
    run(() => del(`/expenses/${x.id}`), 'Budget udah dihapus');

  const updateMilestone = (id, current_amount) => run(() => put(`/milestones/${id}`, { current_amount }));

  // "Atur target": target, deadline and auto-tracking. Throws so the modal shows the error inline.
  const [milestoneFor, setMilestoneFor] = useState(null);
  const saveMilestone = async (m, body) => {
    await put(`/milestones/${m.id}`, body);
    setMilestoneFor(null);
    await load();
    notify(true, body.track_category ? `Sip, progresnya keisi otomatis dari "${body.track_category}"` : 'Target udah diupdate');
  };

  // Monthly schedules. recurringEdit: { rule } with rule null for a new one; confirmFor: { rule, occ }.
  const [recurringEdit, setRecurringEdit] = useState(null);
  const [confirmFor, setConfirmFor] = useState(null);
  const saveRecurring = async (rule, body) => {
    await (rule ? put(`/recurring/${rule.id}`, body) : post('/recurring', body));
    setRecurringEdit(null);
    await load();
    notify(true, rule ? 'Jadwalnya udah diupdate' : `Sip, "${body.name}" dijadwalin tiap tanggal ${body.day}`);
  };
  const confirmRecurring = async (rule, occ, body) => {
    await post(`/recurring/${rule.id}/confirm`, body);
    setConfirmFor(null);
    await load();
    notify(true, `${rule.name} udah kecatat`);
  };
  const recurringActions = {
    onAdd: () => setRecurringEdit({ rule: null }),
    onEdit: (rule) => setRecurringEdit({ rule }),
    onUpdate: (id, patch) => run(() => put(`/recurring/${id}`, patch), 'Nominalnya udah diganti'),
    onConfirm: (rule, occ) => setConfirmFor({ rule, occ }),
    onSkip: (rule, occ) => run(() => post(`/recurring/${rule.id}/skip`, { period: occ.period }), `${rule.name} dilewatin bulan ini`),
    onUnskip: (rule, occ) => run(() => del(`/recurring/${rule.id}/runs/${occ.period}`), 'Oke, nggak jadi dilewatin'),
    onDelete: async (rule) =>
      (await confirmDanger(`Hapus jadwal "${rule.name}"?`, 'Transaksi yang udah kecatat tetap aman, cuma pengingatnya yang ilang.')) &&
      run(() => del(`/recurring/${rule.id}`), 'Jadwalnya udah dihapus'),
  };

  const deleteMilestone = async (m) =>
    (await confirmDanger(`Hapus target "${m.title}"?`, 'Progress-nya nggak bisa balik lagi, lho.')) &&
    run(() => del(`/milestones/${m.id}`), 'Target udah dihapus');

  const deleteTransaction = async (t) =>
    (await confirmDanger(
      'Hapus transaksi ini?',
      `"${t.description}" ${rupiah(t.amount)}. Saldo wallet-nya dibalikin.${t.source !== 'manual' ? ' Email ini juga nggak bakal dicek ulang.' : ''}`
    )) && run(() => del(`/transactions/${t.id}`), 'Beres, saldo udah dibalikin');

  // Editable salary plan (Cashflow → Rencana tab).
  const [planItemType, setPlanItemType] = useState(null); // 'income' | 'expense' while the add form is open
  const planActions = {
    onAdd: setPlanItemType,
    onUpdate: (id, patch) => run(() => put(`/plan-items/${id}`, patch)),
    onRename: async (p) => {
      const { value, isConfirmed } = await swal.fire({
        title: 'Ganti nama',
        input: 'text',
        inputValue: p.name,
        showCancelButton: true,
        confirmButtonText: 'Simpan',
        cancelButtonText: 'Batal',
        inputValidator: (v) => (!v.trim() ? 'Namanya diisi dulu, ya' : undefined),
      });
      if (isConfirmed && value.trim() !== p.name) run(() => put(`/plan-items/${p.id}`, { name: value }), 'Namanya udah diganti');
    },
    onDelete: async (p) =>
      (await confirmDanger(`Hapus "${p.name}" dari rencana?`, `${rupiah(p.amount)} / bulan nggak diitung lagi.`)) &&
      run(() => del(`/plan-items/${p.id}`), 'Udah dihapus dari rencana'),
    onPlanStart: (date) => run(() => put('/settings/plan-start', { date }), 'Tanggal mulainya udah disimpan'),
  };

  // "Tanggal gajian" for this or next period. Throws so the modal shows the error inline.
  const [paydayOpen, setPaydayOpen] = useState(false);
  const savePayday = async (period, date) => {
    await put('/settings/payday', { period, date });
    setPaydayOpen(false);
    await load();
    notify(true, 'Tanggal gajiannya udah disimpan');
  };

  // Category picker for one ledger row (suggestions: categorySuggestions below). Throws so the modal shows the error.
  const [categoryFor, setCategoryFor] = useState(null);
  const saveCategory = async (t, category) => {
    await put(`/transactions/${t.id}`, { category });
    setCategoryFor(null);
    await load();
    notify(true, 'Kategorinya udah diganti');
  };

  // Optimistic: show the new order immediately, then persist it (and resync if saving fails).
  const reorderWallets = async (ids) => {
    setData((d) => ({ ...d, wallets: ids.map((id) => d.wallets.find((w) => w.id === id)).filter(Boolean) }));
    try {
      await put('/wallets/order', { ids });
    } catch (e) {
      notify(false, 'Duh, urutannya gagal disimpan. Coba lagi, ya?');
      load();
    }
  };

  // Throws on failure so the modal can show the error inline.
  const saveCrypto = async (w, body) => {
    await put(`/wallets/${w.id}/crypto`, body);
    setCryptoFor(null);
    await load();
    notify(true, body.asset ? 'Sip, harga live udah nyala' : 'Balik jadi wallet biasa');
  };

  // Link an unlinked transfer to wallets (optionally creating missing ones) and move the balance.
  const linkTransaction = async (t, body) => {
    await post(`/transactions/${t.id}/link`, body);
    setLinkFor(null);
    await load();
    notify(true, 'Nyambung! Saldonya udah dipindah');
  };

  // Briefly highlight wallet cards whose balance changed.
  const flashWallets = (after) => {
    const prev = Object.fromEntries((data?.wallets || []).map((w) => [w.id, w.balance]));
    setFlashIds(after.filter((w) => prev[w.id] !== w.balance).map((w) => w.id));
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashIds([]), 2500);
  };

  const openSyncLog = (result = null) => {
    setSyncResult(result);
    setModal('syncLog');
  };

  // Gmail not connected yet: the sync button opens the settings instead.
  const syncGmail = async () => {
    if (data?.sync && data.sync.configured === false) return setModal('gmail');
    setSyncing(true);
    try {
      const result = await post('/sync-gmail', {});
      if (result.wallets) flashWallets(result.wallets);
      // Update wallet cards and the header's "terakhir dicek" right away, then refresh everything else.
      setData((d) => ({
        ...d,
        wallets: result.wallets || d.wallets,
        sync: { ...d.sync, lastSync: result.checkedAt || d.sync?.lastSync },
      }));
      openSyncLog(result);
      load();
    } catch (e) {
      if (e.code === 'gmail_not_configured') setModal('gmail');
      else swal.fire({ icon: 'error', title: 'Duh, gagal ngecek email', text: e.message, confirmButtonText: 'Oke' });
    } finally {
      setSyncing(false);
    }
  };
  const saveGmailSettings = async (s) => {
    setModal(null);
    await load();
    notify(true, s.configured ? 'Pengaturan Gmail udah disimpan' : 'Gmail udah diputusin');
  };

  const revertSync = async (row) => {
    if (!(await confirmDanger('Batalin transaksi ini?', `"${row.subject}". Saldonya dibalikin.`, 'Ya, batalin'))) return;
    try {
      const result = await post('/sync-log/revert', { message_id: row.message_id });
      if (result.wallets) flashWallets(result.wallets);
      await load();
      notify(true, 'Dibatalin, saldo udah dibalikin');
    } catch (e) {
      notify(false, e.message);
    }
  };

  // PIN first: nothing of the dashboard renders until it is entered (or the lock state is known).
  if (lock.locked) return <LockScreen onUnlock={lock.unlock} />;
  if (!data || !lock.checked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-400">
        {loadError ? (
          <span className="flex items-center gap-2 text-rose-400">
            <AlertCircle size={16} /> {loadError}
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <RefreshCw size={16} className="animate-spin" /> Bentar, lagi buka celengan…
          </span>
        )}
      </div>
    );
  }

  // First run: no wallet yet. The steps create their rows directly; the dashboard reloads when they end.
  if (!onboarded && data.wallets.length === 0) {
    const finish = (then) => {
      setOnboarded(true);
      then?.();
      load();
    };
    return <Onboarding onDone={() => finish()} onGmail={() => finish(() => setModal('gmail'))} />;
  }

  const { wallets, expenses, milestones, sync = {} } = data;
  const stats = summarize(data);
  // Category suggestions: budgets, plan expense lines (e.g. "Komitmen Ibu") and categories already used this month.
  const categorySuggestions = [
    ...new Set([
      ...expenses.map((x) => x.name),
      ...(data.planItems || []).filter((p) => p.type === 'expense').map((p) => p.name),
      ...(data.actual.byCategory || []).map((c) => c.category),
    ]),
  ].filter(Boolean);
  const walletNames = Object.fromEntries(wallets.map((w) => [w.id, w.name]));
  const today = todayWib();
  const safe = safeToSpend(data, today);
  // Last month's recap is announced during the first week, if the ledger already covered last month.
  const lastMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const showRecapBanner =
    Number(today.slice(8, 10)) <= 7 && data.ledgerStart && data.ledgerStart.slice(0, 7) <= lastMonth && !recapDismissed && !recapSeen(lastMonth);
  const openRecap = (month = null) => {
    if (!month || month === lastMonth) markRecapSeen(lastMonth);
    setRecap({ month });
  };
  const closeModal = () => setModal(null);

  return (
    <div className="min-h-screen bg-zinc-950 font-sans text-zinc-100 antialiased selection:bg-sky-500/30">
      <div className="w-full px-4 py-6 sm:px-6 sm:py-10 lg:px-8 2xl:px-12">
        <Header
          sync={sync}
          hidden={hidden}
          onToggleHidden={toggleHidden}
          onOpenLog={() => openSyncLog()}
          onSettings={() => setModal('settings')}
          update={update}
          onSync={syncGmail}
          syncing={syncing}
        />

        <PendingRecurring
          items={pendingOccurrences(data.recurring || [])}
          onConfirm={recurringActions.onConfirm}
          onSkip={recurringActions.onSkip}
        />

        {showRecapBanner && (
          <RecapBanner
            month={lastMonth}
            onOpen={() => openRecap(lastMonth)}
            onDismiss={() => {
              markRecapSeen(lastMonth);
              setRecapDismissed(true);
            }}
          />
        )}

        <Summary
          stats={stats}
          safe={safe}
          streak={data.streak}
          onRecap={() => openRecap(data.actual.month)}
          onPayday={data.actual.periods ? () => setPaydayOpen(true) : null}
          actual={data.actual}
          planStart={data.planStart}
          walletCount={wallets.length}
          hidden={hidden}
          onToggleHidden={toggleHidden}
        />

        <WalletGrid
          wallets={wallets}
          total={stats.totalWallets}
          walletColor={stats.walletColor}
          flashIds={flashIds}
          onAdd={() => setModal('wallet')}
          onUpdate={updateWallet}
          onDelete={deleteWallet}
          onPickIcon={setIconFor}
          onCrypto={setCryptoFor}
          onReorder={reorderWallets}
        />

        <div className="mb-6 grid items-start gap-6 lg:grid-cols-5">
          <DailyTransactions
            walletNames={walletNames}
            refreshKey={refreshKey}
            onAdd={() => setModal('transaction')}
            onDelete={deleteTransaction}
            onLink={setLinkFor}
            onEditCategory={setCategoryFor}
          />
          <div className="flex flex-col gap-6 lg:col-span-2">
            <CashflowCard
              actual={data.actual}
              plan={stats}
              planStart={data.planStart}
              planActive={data.actual.month >= data.planStart.slice(0, 7)}
              planActions={planActions}
            />
            <RecurringCard
              recurring={data.recurring || []}
              walletNames={walletNames}
              {...recurringActions}
              onPayday={data.actual.periods ? () => setPaydayOpen(true) : null}
            />
          </div>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-5">
          <MilestoneRoadmap
            milestones={milestones}
            onAdd={() => setModal('milestone')}
            onUpdate={updateMilestone}
            onEdit={setMilestoneFor}
            onDelete={deleteMilestone}
          />
          <ExpensesCard
            expenses={expenses}
            total={stats.totalFlexible}
            spentByCategory={spent}
            onAdd={() => setModal('expense')}
            onUpdate={updateExpense}
            onRename={renameExpense}
            onDelete={deleteExpense}
          />
        </div>

        <footer className="mt-10 text-center text-xs text-zinc-600">
          Ada saran, nemu bug, atau bank kamu belum kebaca?{' '}
          <a href={mailtoDeveloper('Celengin: saran / bug')} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-sky-400 hover:underline">
            Kabarin {DEVELOPER_EMAIL}
          </a>
        </footer>
      </div>

      {modal === 'transaction' && (
        <TransactionForm
          wallets={wallets}
          categories={categorySuggestions}
          defaultWallet={data.mainWallet}
          onCreate={create}
          onClose={closeModal}
        />
      )}
      {modal === 'wallet' && (
        <WalletForm
          walletTypes={[...new Set(wallets.map((w) => w.category).filter(Boolean))]}
          onCreate={create}
          onClose={closeModal}
        />
      )}
      {modal === 'expense' && <ExpenseForm onCreate={create} onClose={closeModal} />}
      {planItemType && (
        <PlanItemForm
          type={planItemType}
          onCreate={async (...args) => {
            await create(...args);
            setPlanItemType(null);
          }}
          onClose={() => setPlanItemType(null)}
        />
      )}
      {modal === 'milestone' && <MilestoneForm milestones={milestones} onCreate={create} onClose={closeModal} />}
      {iconFor && <WalletIconForm wallet={iconFor} onPick={updateWalletIcon} onClose={() => setIconFor(null)} />}
      {milestoneFor && (
        <MilestoneEditForm
          milestone={milestoneFor}
          categories={categorySuggestions}
          onSave={saveMilestone}
          onClose={() => setMilestoneFor(null)}
        />
      )}
      {cryptoFor && <LivePriceForm wallet={cryptoFor} onSave={saveCrypto} onClose={() => setCryptoFor(null)} />}
      {recap && <RecapModal initialMonth={recap.month} onClose={() => setRecap(null)} />}
      {paydayOpen && <PaydayForm periods={data.actual.periods} onSave={savePayday} onClose={() => setPaydayOpen(false)} />}
      {recurringEdit && (
        <RecurringForm
          rule={recurringEdit.rule}
          wallets={wallets}
          categories={categorySuggestions}
          defaultWallet={data.mainWallet}
          onSave={saveRecurring}
          onClose={() => setRecurringEdit(null)}
        />
      )}
      {confirmFor && (
        <RecurringConfirmForm
          rule={confirmFor.rule}
          occ={confirmFor.occ}
          walletName={walletNames[confirmFor.rule.wallet] || 'wallet terhapus'}
          onConfirm={confirmRecurring}
          onClose={() => setConfirmFor(null)}
        />
      )}
      {categoryFor && (
        <CategoryForm tx={categoryFor} categories={categorySuggestions} onSave={saveCategory} onClose={() => setCategoryFor(null)} />
      )}
      {linkFor && (
        <LinkTransferForm tx={linkFor} wallets={wallets} onLink={linkTransaction} onClose={() => setLinkFor(null)} />
      )}
      {modal === 'gmail' && <GmailSettingsForm wallets={wallets} onSaved={saveGmailSettings} onClose={closeModal} />}
      {modal === 'settings' && (
        <SettingsModal
          lock={lock}
          update={update}
          onLockChange={lock.setEnabled}
          onGmail={() => setModal('gmail')}
          onPayday={
            data.actual.periods
              ? () => {
                  setModal(null);
                  setPaydayOpen(true);
                }
              : null
          }
          onClose={closeModal}
        />
      )}
      {modal === 'syncLog' && (
        <SyncLogModal
          result={syncResult}
          start={sync.start}
          refreshKey={refreshKey}
          onRevert={revertSync}
          onClose={closeModal}
        />
      )}
    </div>
  );
}
