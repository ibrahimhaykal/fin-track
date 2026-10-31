import { pct } from './format';
import { OTHER, SERIES } from './theme';

// All derived dashboard numbers in one place, computed from the /api/dashboard payload.
// Neutral steps for plan expense lines (wallets own the categorical hues on this page).
// zinc steps flip with the theme, so the lines stay distinct from the surface in light and dark.
const PLAN_SHADES = [400, 500, 600, 700, 800].map((n) => `var(--color-zinc-${n})`);

export function summarize({ wallets, expenses, planItems = [] }) {
  const totalWallets = wallets.reduce((s, w) => s + w.balance, 0);
  const totalFlexible = expenses.reduce((s, x) => s + x.amount, 0);
  const planIncome = planItems.filter((p) => p.type === 'income');
  const planExpense = planItems.filter((p) => p.type === 'expense');
  const income = planIncome.reduce((s, p) => s + p.amount, 0);
  const outflow = planExpense.reduce((s, p) => s + p.amount, 0) + totalFlexible;
  const netSavings = income - outflow;

  // Identity colors follow creation order (`seq`), not display order, so dragging a wallet keeps its color.
  // Past 8 wallets the extra ones fold into "Lainnya".
  const byCreation = [...wallets].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const walletColor = Object.fromEntries(byCreation.map((w, i) => [w.id, SERIES[i] || OTHER]));
  const colored = wallets.filter((w) => walletColor[w.id] !== OTHER);
  const allocation = colored.map((w) => ({ key: w.id, label: w.name, value: w.balance, color: walletColor[w.id] }));
  if (colored.length < wallets.length) {
    const rest = wallets.filter((w) => walletColor[w.id] === OTHER).reduce((s, w) => s + w.balance, 0);
    allocation.push({ key: 'other', label: 'Lainnya', value: rest, color: OTHER });
  }

  // Where the planned income goes: each fixed expense line, the flexible budgets, and what is left to save.
  const cashflow = [
    ...planExpense.map((p, i) => ({ key: `p${p.id}`, label: p.name, value: p.amount, color: PLAN_SHADES[i % PLAN_SHADES.length] })),
    { key: 'flex', label: 'Budget Bulanan', value: totalFlexible, color: 'var(--color-zinc-700)' },
    { key: 'save', label: 'Tabungan', value: Math.max(0, netSavings), color: 'var(--series-3)' },
  ];

  return {
    totalWallets,
    totalFlexible,
    planIncome,
    planExpense,
    income,
    outflow,
    netSavings,
    savingsRate: pct(netSavings, income),
    walletColor,
    allocation,
    cashflow,
  };
}

const lower = (s) => (s || '').trim().toLowerCase();

// Spending per category this month, keyed by lowercased name (same matching as the budget card).
export const spentByCategory = (actual) =>
  Object.fromEntries((actual.byCategory || []).filter((c) => c.category).map((c) => [lower(c.category), c.total]));

// "Aman dipakai": cash you can spend freely until the next salary. Spendable wallets (not live-priced
// investments) minus this month's scheduled payments that are still open, minus what is left in each budget.
// A budget whose name is also a schedule's category is counted once (as the schedule).
export function safeToSpend({ wallets, expenses, actual, recurring = [] }, today) {
  const liquid = wallets.filter((w) => !w.asset).reduce((s, w) => s + w.balance, 0);
  const month = actual.month;
  const outgoing = recurring.filter((r) => r.type === 'expense');
  const scheduled = outgoing
    .map((r) => ({ rule: r, occ: r.occurrences.find((o) => o.period === month) }))
    .filter(({ occ }) => occ && (occ.status === 'pending' || occ.status === 'upcoming'))
    .map(({ rule }) => ({ name: rule.name, amount: rule.amount }));
  const scheduledTotal = scheduled.reduce((s, x) => s + x.amount, 0);

  const scheduledCats = new Set(outgoing.map((r) => lower(r.category || r.name)));
  const spent = spentByCategory(actual);
  const budgetLeft = expenses
    .filter((x) => !scheduledCats.has(lower(x.name)))
    .reduce((s, x) => s + Math.max(0, x.amount - (spent[lower(x.name)] || 0)), 0);

  // Next salary: the nearest upcoming income schedule (this period's if still ahead, else next period's).
  // A schedule on day 1 is "on payday", so next period's one falls on its (possibly moved) start.
  const nextStart = actual.periods?.[1]?.start;
  const [y, m] = month.split('-').map(Number);
  const nextIncome = recurring
    .filter((r) => r.type === 'income')
    .map((r) => {
      const thisMonth = r.occurrences.find((o) => o.period === month);
      if (thisMonth && thisMonth.status === 'upcoming') return { name: r.name, date: thisMonth.due };
      if (r.day === 1 && nextStart) return { name: r.name, date: nextStart };
      const next = new Date(Date.UTC(y, m, 1));
      const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      return { name: r.name, date: `${next.toISOString().slice(0, 8)}${String(Math.min(r.day, last)).padStart(2, '0')}` };
    })
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  // No salary schedule: budgets run per pay period, so count until the next one starts.
  const until = nextIncome?.date || nextStart || new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const daysLeft = Math.max(1, Math.round((new Date(`${until}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000));

  const safe = liquid - scheduledTotal - budgetLeft;
  return { liquid, scheduled, scheduledTotal, budgetLeft, safe, nextIncome, until, daysLeft, perDay: Math.max(0, safe) / daysLeft };
}
