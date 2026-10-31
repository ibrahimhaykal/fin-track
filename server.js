import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { ImapFlow } from 'imapflow';

const PORT = Number(process.env.PORT) || 5000;
// Loopback only: the API exposes balances and must not be reachable from other devices on the network.
const HOST = process.env.HOST || '127.0.0.1';
const db = new Database(process.env.FINANCE_DB || 'finance.db');
db.pragma('journal_mode = WAL');

// ---------- Schema ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    balance REAL NOT NULL DEFAULT 0,
    category TEXT,
    icon TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS flexible_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS milestones (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    target_amount REAL NOT NULL,
    current_amount REAL NOT NULL DEFAULT 0,
    deadline TEXT,
    category TEXT,
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS financial_rules (
    key TEXT PRIMARY KEY,
    value REAL NOT NULL
  );
  -- Emails already applied by Gmail sync, so re-running sync never double-counts.
  CREATE TABLE IF NOT EXISTS gmail_sync_log (
    message_id TEXT PRIMARY KEY,
    subject TEXT,
    source TEXT,
    type TEXT,
    amount REAL,
    target TEXT,
    email_date TEXT,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  -- Daily money ledger: every movement, typed in manually or parsed from Gmail. Wallet balances move with it.
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                       -- YYYY-MM-DD in WIB
    type TEXT NOT NULL,                       -- income | expense | transfer
    amount REAL NOT NULL,
    description TEXT,
    category TEXT,                            -- optional, usually a flexible_expenses budget name
    wallet TEXT,                              -- wallet credited (income) or debited (expense / transfer source)
    to_wallet TEXT,                           -- transfer destination
    source TEXT NOT NULL DEFAULT 'manual',    -- 'manual' or the bank/app it came from (Jago, GoPay, ...)
    message_id TEXT UNIQUE,                   -- Gmail message this came from, if any
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
`);
// Older databases created before these columns existed.
if (!db.prepare('PRAGMA table_info(wallets)').all().some((c) => c.name === 'icon')) {
  db.exec('ALTER TABLE wallets ADD COLUMN icon TEXT');
}
// Crypto wallets: `units` of `asset` (a CoinGecko id); balance = units x price, refreshed from the price API.
const walletColumns = db.prepare('PRAGMA table_info(wallets)').all().map((c) => c.name);
for (const [col, type] of [
  ['asset', 'TEXT'],
  ['units', 'REAL'],
  ['price', 'REAL'],
  ['price_change', 'REAL'],
  ['price_at', 'DATETIME'],
]) {
  if (!walletColumns.includes(col)) db.exec(`ALTER TABLE wallets ADD COLUMN ${col} ${type}`);
}
// Display order set by drag & drop in the UI. Existing wallets keep their creation order.
if (!walletColumns.includes('sort_order')) {
  db.exec('ALTER TABLE wallets ADD COLUMN sort_order INTEGER');
  db.exec('UPDATE wallets SET sort_order = rowid');
}

// Wallets in display order. `seq` (creation order) is what the UI keys identity colors on,
// so a wallet keeps its color when it is dragged to a new position.
const listWallets = () =>
  db.prepare('SELECT *, rowid AS seq FROM wallets ORDER BY COALESCE(sort_order, rowid), rowid').all();
const ledgerColumns = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
for (const col of ['from_pocket', 'to_pocket']) {
  // Pocket names as written in the email, kept even when no wallet matches (shown in the UI, used by "Hubungkan").
  if (!ledgerColumns.includes(col)) db.exec(`ALTER TABLE transactions ADD COLUMN ${col} TEXT`);
}
// applied = 0: recorded for history and monthly totals only, the wallet balance already includes it
// (typed in as "saldo udah bener", or synced from an email older than the wallet's last balance check).
if (!ledgerColumns.includes('applied')) db.exec('ALTER TABLE transactions ADD COLUMN applied INTEGER NOT NULL DEFAULT 1');
// Milestones whose progress fills itself from spending in one category (e.g. monthly payments to Ibu).
{
  const cols = db.prepare('PRAGMA table_info(milestones)').all().map((c) => c.name);
  if (!cols.includes('track_category')) db.exec('ALTER TABLE milestones ADD COLUMN track_category TEXT');
  if (!cols.includes('track_since')) db.exec('ALTER TABLE milestones ADD COLUMN track_since TEXT');
}
// When the user last typed a wallet's real balance ("samain saldo"). Transactions dated before this are
// already inside that balance, so a late-arriving email for them must not move it again.
if (!db.prepare('PRAGMA table_info(wallets)').all().some((c) => c.name === 'reconciled_at')) {
  db.exec('ALTER TABLE wallets ADD COLUMN reconciled_at TEXT');
}
const syncLogColumns = db.prepare('PRAGMA table_info(gmail_sync_log)').all().map((c) => c.name);
for (const col of ['source', 'email_date', 'wallet']) {
  if (!syncLogColumns.includes(col)) db.exec(`ALTER TABLE gmail_sync_log ADD COLUMN ${col} TEXT`);
}
// A reverted entry stays in the log so the same email is never re-applied on the next sync.
// Added before the "forwarded" migration below, which reads it (a fresh database has neither column).
if (!syncLogColumns.includes('reverted')) {
  db.exec('ALTER TABLE gmail_sync_log ADD COLUMN reverted INTEGER NOT NULL DEFAULT 0');
}
// Whether the synced email was a forwarded copy (manual "Fwd:" or from another mailbox). Only an original and a
// forwarded copy of the same notification are treated as duplicates; two originals are two real transactions.
if (!syncLogColumns.includes('forwarded')) {
  db.exec('ALTER TABLE gmail_sync_log ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0');
  // Manual forwards sent from Gmail carry a Gmail Message-ID; bank originals never do.
  db.exec("UPDATE gmail_sync_log SET forwarded = 1 WHERE message_id LIKE '%@mail.gmail.com>'");
  // Undo duplicates wrongly flagged between two originals (older rule); they are re-synced as real transactions.
  db.exec(`DELETE FROM gmail_sync_log
           WHERE reverted = 1 AND target = 'duplikat (sudah tercatat)' AND forwarded = 0
             AND NOT EXISTS (
               SELECT 1 FROM gmail_sync_log o JOIN transactions t ON t.message_id = o.message_id
               WHERE o.forwarded = 1 AND o.type = gmail_sync_log.type AND o.amount = gmail_sync_log.amount
                 AND o.subject = gmail_sync_log.subject)`);
}
// Units a "unit reksa dana sudah masuk" email added to a fund wallet (no ledger row), so it can be reverted.
if (!syncLogColumns.includes('units')) db.exec('ALTER TABLE gmail_sync_log ADD COLUMN units REAL');

// ---------- Monthly plan (editable) ----------
// The salary plan: income and fixed-expense lines the user manages in the UI, plus the date it starts.
// Flexible budgets (flexible_expenses) are added on top as one more expense line.
db.exec(`
  CREATE TABLE IF NOT EXISTS plan_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    amount REAL NOT NULL DEFAULT 0,
    note TEXT,
    sort_order INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  -- Monthly schedules (salary, transfer to Ibu, bills). They never move money by themselves: each month's
  -- occurrence waits until a matching ledger row shows up (usually from email) or the user confirms / skips it.
  CREATE TABLE IF NOT EXISTS recurring (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    amount REAL NOT NULL,
    wallet TEXT,
    category TEXT,
    day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31), -- clamped to the month's last day
    start_period TEXT NOT NULL                          -- YYYY-MM of the first occurrence
  );
  -- How one month's occurrence was settled: 'done' (transaction_id = matched or confirmed row) or 'skipped'.
  CREATE TABLE IF NOT EXISTS recurring_runs (
    recurring_id INTEGER NOT NULL REFERENCES recurring(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('done', 'skipped')),
    transaction_id INTEGER,
    PRIMARY KEY (recurring_id, period)
  );
`);

const getSetting = (key, fallback) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const envDate = (name) => (DATE_ONLY_RE.test(process.env[name] || '') ? process.env[name] : null);
// The 1st of the current month in WIB, the starting point for a fresh install.
const firstOfThisMonth = () =>
  `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date()).slice(0, 7)}-01`;

// Databases from before these dates were saved ran on a fixed 1 Oct 2026; they keep it. A fresh one starts this month.
{
  const used = (table) => db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
  const legacy = '2026-10-01';
  if (!getSetting('plan_start', null) && !envDate('PLAN_START_DATE')) {
    setSetting('plan_start', used('transactions') ? legacy : firstOfThisMonth());
  }
  if (!getSetting('sync_start', null) && !envDate('SYNC_START_DATE') && used('gmail_sync_log')) setSetting('sync_start', legacy);
}

// Plan start: saved setting > PLAN_START_DATE in .env > this month.
const planStart = () => getSetting('plan_start', envDate('PLAN_START_DATE') || firstOfThisMonth());
const listPlanItems = () => db.prepare('SELECT * FROM plan_items ORDER BY type DESC, COALESCE(sort_order, id), id').all();

// ---------- Gmail Financial Sync ----------
// Only official transaction notifications are processed. Everything else is skipped before it can touch the DB.

// STRICT TRANSACTIONAL WHITELIST. Checked in this order, first match wins, so a specific phrase
// ("You have made a payment") beats a weak one that can also appear in the same email ("Pocket Main").
const TX_RULES = [
  { type: 'income', re: /your (jago )?pocket has received/i },
  { type: 'transfer', re: /money moved( between pockets)?/i },
  {
    type: 'expense',
    re: /you have made a payment|(riwayat )?tagihan gopay|pembayaran steam|thank you for your purchases?/i,
  },
  { type: 'expense', re: /\bitemku\b|\bsteam\b/i },
  { type: 'transfer', re: /pocket main|kantong utama/i },
];

// Gmail connection, set in the app (Pengaturan Gmail) or, as before, in .env. The app's own setting wins.
// sync_start: emails before this date are never synced (fresh start on payday).
function gmailConfig() {
  return {
    user: getSetting('gmail_user', null) || process.env.GMAIL_USER || '',
    pass: (getSetting('gmail_app_pass', null) || process.env.GMAIL_APP_PASS || '').replace(/\s+/g, ''),
    start: getSetting('sync_start', null) || envDate('SYNC_START_DATE') || firstOfThisMonth(),
  };
}
const gmailConfigured = ({ user, pass }) => Boolean(user && pass && !user.startsWith('email_lu'));
const syncStartTime = (start) => new Date(`${start}T00:00:00+07:00`).getTime(); // WIB midnight

// PRIVACY LOCK: the IMAP search only returns emails containing a whitelisted phrase or sender.
// Gmail's after: is day-granular in Pacific time, so search from the day before and filter exactly in code.
const gmailQuery = (start) =>
  `after:${new Date(syncStartTime(start) - 86400000).toISOString().slice(0, 10).replace(/-/g, '/')} ` +
  '-category:promotions -category:social -category:forums {' +
  [
    '"Your Jago pocket has received"',
    '"Your pocket has received"',
    '"Money moved between pockets"',
    '"Money moved"',
    '"Pocket Main"',
    '"Kantong Utama"',
    '"You have made a payment"',
    '"Riwayat tagihan GoPay"',
    '"Tagihan GoPay"',
    '"Pembayaran Steam"',
    '"Thank you for your purchase"',
    '"Thank you for your purchases"',
    'from:noreply@jago.com', // every Jago transaction notification (marketing comes from info@jago.com)
    'from:bca.co.id', // myBCA "Internet Transaction Journal" (non-transaction mail is skipped by the parser)
    'from:support@pintu.co.id', // Pintu Rupiah deposits / withdrawals (marketing comes from marketing.pintu.co.id)
    'from:no-reply@bibit.id', // Bibit purchases / units / redemptions (marketing comes from info@bibit.id)
    // Other banks & e-wallets (general parser; account notices and promos are skipped there)
    ...[
      'bankmandiri.co.id', 'bri.co.id', 'bni.co.id', 'bankbsi.co.id', 'cimbniaga.co.id', 'permatabank.co.id', 'permatabank.com',
      'danamon.co.id', 'btn.co.id', 'seabank.co.id', 'ocbc.id', 'btpn.com', 'jenius.com', 'bcadigital.co.id', 'superbank.id',
      'allobank.com', 'dana.id', 'ovo.id', 'shopeepay.co.id', 'linkaja.id',
    ].map((d) => `from:${d}`),
    'from:itemku',
    'subject:itemku',
    'from:steampowered.com',
    'subject:steam',
  ].join(' ') +
  '}';
// The wallet emails without a pocket name land in: chosen in the app > SYNC_MAIN_WALLET in .env > guessed.
const mainWalletSetting = () => getSetting('main_wallet', null) || process.env.SYNC_MAIN_WALLET || null;
const GMAIL_MAX_MESSAGES = 50;

// ANTI-NEWSLETTER GUARDRAIL: any hit means the email is ignored.
const NEWSLETTER_HEADERS = ['list-unsubscribe', 'precedence', 'x-campaign', 'x-campaign-id', 'x-campaignid'];
const NEWSLETTER_HEADER_RE = /^(list-unsubscribe|x-campaign[\w-]*)\s*:|^precedence\s*:\s*bulk/im;
const NEWSLETTER_WORDS_RE =
  /\b(unsubscribe|berhenti berlangganan|newsletters?|insights?|weekly|what if|promo\w*|tips|digest|edukasi|jobstreet|penawaran)\b|view (it )?in (your )?browser/i;

// Amounts: "Rp 1.200.000", "IDR 50.000,00". Shorthand like "Rp100 ribu" / "Rp1 jt" is marketing copy, not a transaction.
const AMOUNT_RE = /(?:Rp|IDR)\.?\s*(\d[\d.]*(?:,\d{1,2})?)(?![\d.]|,\d)(?!\s*(?:rb|ribu|jt|juta|miliar|%))/gi;
const AMOUNT_HINT_RE = /(nominal|jumlah|total|amount|sebesar|senilai|payment of|paid|received|moved|of)\s*[:=]?\s*$/i;
const BALANCE_HINT_RE = /(saldo|balance|sisa|limit|cashback|hemat|diskon|discount|potongan)\s*(akhir|kamu|anda|tersedia)?\s*[:=]?\s*$/i;
const MIN_AMOUNT = 1000;

// "Rp 1.200.000,50" -> 1200000 (Indonesian format: dot = thousands, comma = decimals)
const parseRupiah = (s) => Math.round(Number(s.split(',')[0].replace(/\./g, '')));

// Prefer a labelled amount, then the first amount after the matched phrase. Balances are never picked.
function extractAmount(text, phraseIndex = 0) {
  const amounts = [...text.matchAll(AMOUNT_RE)]
    .map((m) => ({ value: parseRupiah(m[1]), index: m.index, before: text.slice(Math.max(0, m.index - 30), m.index) }))
    .filter((m) => m.value >= MIN_AMOUNT && !BALANCE_HINT_RE.test(m.before));
  const pick =
    amounts.find((m) => AMOUNT_HINT_RE.test(m.before)) || amounts.find((m) => m.index >= phraseIndex) || amounts[0];
  return pick ? pick.value : null;
}

// ---------- Jago: every transaction email, any kind ----------
// Jago sends all transaction notifications from noreply@jago.com (also recognised inside a manual forward),
// so instead of whitelisting exact subjects, any such email with an amount is a transaction and only its
// direction is decided here. Order matters: pocket moves and cash withdrawals before generic "transaction".
const JAGO_SENDER_RE = /noreply@jago\.com/i;
const JAGO_BODY_RE = /PT Bank Jago Tbk|Jago Mail/i; // survives a manual "Fwd:" from another mailbox
const JAGO_KINDS = [
  { type: 'transfer', re: /moved between (your )?pockets|has been moved from|dipindahkan (antar|dari) kantong|pindah(kan)? (uang|dana)/i },
  { type: 'withdraw', re: /cash withdrawal|withdr[ae]wn? cash|tarik tunai|penarikan tunai/i },
  {
    type: 'income',
    re: /(pocket|kantong)\s+(has\s+)?received|you('ve| have)? received|money received|incoming (transfer|money)|received (money|a transfer)|\brefund|cashback|interest (credited|earned|payment)|\bbunga\b|telah diterima|menerima (uang|dana|transfer)|dana masuk|uang masuk/i,
  },
  {
    type: 'expense',
    re: /made a payment|payment (to|of)|paid|debit card|made a transaction|purchase|sent (money|to)|transfer(red)? to|top.?up (to|for|ke)|bill|tagihan|auto.?debit|pembayaran|pembelian|kirim uang|terkirim|transfer ke|transaksi/i,
  },
];

// Returns { type, phrase, index } for a Jago transaction email, or null when its kind is not recognised.
function jagoRule(subject, body) {
  for (const text of [subject, `${subject}\n${body}`]) {
    for (const k of JAGO_KINDS) {
      const m = k.re.exec(text);
      if (m) return { type: k.type, phrase: m[0], index: text === subject ? 0 : m.index };
    }
  }
  return null;
}

// The subject only says what kind of transaction it was; the payee is in the body's summary:
// "To kentang 88 9360001234567890123 Amount", "To SITI AMINAH Jago • 501234567890 Amount", "To: 081234567890 Amount:".
const JAGO_BANK_RE = /\s+(Jago|BCA|BNI|BRI|Mandiri|BSI|BTN|CIMB Niaga|CIMB|Permata|Danamon|OCBC|Maybank|Panin|SeaBank|blu|Jenius|Superbank)$/i;
function jagoPayee(body) {
  const raw = /\bTo:?\s+(.+?)\s+Amount\b/i.exec(body || '')?.[1]?.trim();
  if (!raw) return null;
  const number = /\d{6,}$/.exec(raw)?.[0] || null; // account / merchant / phone number
  let name = raw.replace(/\s*•?\s*\d{6,}$/, '').trim();
  // Only a bank transfer has "Bank • number"; a merchant named "... Blu" is not a bank.
  const bank = raw.includes('•') ? JAGO_BANK_RE.exec(name)?.[1] || null : null;
  if (bank) name = name.slice(0, -bank.length).trim();
  return { name: name || null, bank, number };
}

// "Bayar kentang 88", "Transfer ke SITI AMINAH", "Transfer ke BCA" (own account), "Top up e-Wallet 0812…".
function jagoDescription(subject, payee, holder) {
  if (/debit card/i.test(subject)) return 'Bayar pakai kartu debit Jago';
  if (/top.?up/i.test(subject) && payee) return `Top up e-Wallet ${payee.name || payee.number}`;
  if (/made a transfer|transferred/i.test(subject) && payee?.name) {
    return `Transfer ke ${payee.bank && sameName(payee.name, holder) ? payee.bank : payee.name}`;
  }
  if (/made a payment/i.test(subject)) {
    const merchant = payee?.name || merchantOf(subject);
    if (merchant) return `Bayar ${merchant}`;
  }
  return subject;
}

// ---------- BCA: myBCA "Internet Transaction Journal" ----------
// Sent for money leaving a BCA account (transfers, virtual accounts / top-ups, payments). The body is a list of
// "Label : value" pairs; amounts are English-formatted ("IDR 1,200,000.00").
const BCA_SENDER_RE = /@bca\.co\.id/i;
const BCA_BODY_RE = /\bmyBCA\b|\bKlikBCA\b|PT\.?\s*Bank Central Asia Tbk/i;
const BCA_LABELS = [
  'Status', 'Transaction Date', 'Transaction Type', 'Transfer Type', 'Payment Type', 'Source of Fund', 'Source Currency',
  'Beneficiary Account', 'Beneficiary Account No.', 'Beneficiary Bank', 'Beneficiary Name', 'Save to beneficiary list',
  'Transfer Currency', 'Transfer Amount', 'Transfer Method', 'Fee',
  'BCA Virtual Account No.', 'Company/Product Name', 'Merchant Name', 'Customer ID', 'Name', 'Transfer Bill Total', 'Bill Total',
  // QRIS: "Payment to : ketoprak maskur"
  'Payment to', 'Merchant Location', 'Acquirer', 'Merchant PAN', 'Terminal ID', 'Customer PAN', 'RRN',
  // e-wallet top up: "Name : Bxxx Sxxxxxx Phone No. : 0812 - …"
  'Phone No.', 'Admin Fee',
  'Total Payment', 'Amount', 'Remarks', 'Description', 'Reference No.',
];
const BCA_LABEL_RE = new RegExp(
  `(${[...BCA_LABELS].sort((a, b) => b.length - a.length).map((l) => l.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})\\s*:\\s*`,
  'g'
);
const BCA_TAIL_RE = /\s+(Please save|If you do not|Note\(s\)|Best Regards|Hormat Kami|Simpan email|PT\.? BANK CENTRAL)/i;

// { 'Transfer Amount': 'IDR 1,200,000.00', ... }: each value runs until the next known label.
function bcaFields(text) {
  const hits = [];
  BCA_LABEL_RE.lastIndex = 0;
  for (let m; (m = BCA_LABEL_RE.exec(text)); ) hits.push({ label: m[1], start: m.index, from: BCA_LABEL_RE.lastIndex });
  const fields = {};
  hits.forEach((h, i) => {
    const value = text.slice(h.from, i + 1 < hits.length ? hits[i + 1].start : undefined).split(BCA_TAIL_RE)[0].trim();
    if (!(h.label in fields)) fields[h.label] = value;
  });
  return fields;
}

// "IDR 1,200,000.00" (English) or "Rp 1.200.000,00" (Indonesian) -> 1200000
function parseMoney(value) {
  const m = /(\d[\d.,]*)/.exec(String(value || ''));
  if (!m) return null;
  let s = m[1];
  if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.'); // Indonesian
  else s = s.replace(/,/g, ''); // English
  const n = Math.round(Number(s));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Account holder from the greeting: "Hello BUDI SANTOSO," -> "BUDI SANTOSO".
const holderOf = (body) => /\b(?:Hi|Hello|Halo|Dear|Yth\.?)\s+([A-Z][A-Z .'-]+?)\s*,/.exec(body || '')?.[1] || null;

// Same person, also when one side is masked the way BCA masks e-wallet names ("Bxxx Sxxxxxx" = "BUDI SANTOSO").
function sameName(a, b) {
  if (!a || !b) return false;
  const words = (s) => s.replace(/\s+/g, ' ').trim().toUpperCase().split(' ');
  const [x, y] = [words(a), words(b)];
  const masked = (m, w) => /^.X+$/.test(m) && m.length === w.length && m[0] === w[0];
  return x.length === y.length && x.every((w, i) => w === y[i] || masked(w, y[i]) || masked(y[i], w));
}

// "e-Wallet - GO-PAY TOPUP" -> "GoPay"
function eWalletOf(type) {
  const m = /e-?wallet\s*-\s*(.+?)(?:\s+top\s?up)?$/i.exec(type || '');
  if (!m) return null;
  const name = m[1].trim();
  return /^go-?pay$/i.test(name) ? 'GoPay' : /^shopee-?pay$/i.test(name) ? 'ShopeePay' : name;
}

// Parsed journal, a skip-reason string, or null when the email is not a BCA transaction journal.
function parseBcaJournal(subject, body) {
  if (!/internet transaction journal|jurnal transaksi/i.test(`${subject} ${body}`)) return null;
  const f = bcaFields(body);
  if (f.Status && !/success|berhasil/i.test(f.Status)) return 'BCA, transaksi nggak berhasil';
  const amount = parseMoney(f['Total Payment'] || f['Transfer Amount'] || f.Amount || f['Bill Total']);
  if (!amount) return 'BCA, nominal nggak ketemu';

  const holder = holderOf(body);
  const product =
    (f['Company/Product Name'] || '').split('/').pop().trim() || // "DOMPET ANAK BANGSA PT / GoPay" -> "GoPay"
    eWalletOf(f['Transaction Type']) ||
    null;
  const toName = f['Beneficiary Name'] || f.Name || null;
  const note = (f.Remarks || f.Description || '').trim();
  const suffix = note && note !== '-' ? ` · ${note}` : '';

  // Paid to an account / e-wallet in your own name: money only moved between your own wallets.
  if (holder && sameName(toName, holder)) {
    const toLabel = product || f['Beneficiary Bank'] || 'Rekening sendiri';
    return {
      type: 'transfer',
      amount,
      description: `${product ? `Top up ${product}` : `Transfer ke ${toLabel}`}${suffix}`,
      toLabel,
      counterparty: toLabel,
    };
  }
  const counterparty = f['Beneficiary Name'] || f['Payment to'] || f['Merchant Name'] || product || f.Name || null;
  const description = f['Beneficiary Name']
    ? `Transfer ke ${f['Beneficiary Name']}`
    : counterparty
      ? `Bayar ${counterparty}`
      : f['Transaction Type'] || f['Transfer Type'] || f['Payment Type'] || 'Transaksi BCA';
  return { type: 'expense', amount, description: description + suffix, counterparty };
}

// Wallet that holds physical cash (for ATM withdrawals), by name/type.
const cashWallet = () =>
  db.prepare('SELECT id, name, category FROM wallets').all().find((w) => /tunai|cash|dompet fisik/i.test(`${w.name} ${w.category}`))?.id || null;

function matchRule(text) {
  for (const rule of TX_RULES) {
    const m = rule.re.exec(text);
    if (m) return { type: rule.type, phrase: m[0], index: m.index };
  }
  return null;
}

function detectSource(from, text) {
  if (/jago\.com/i.test(from)) return 'Jago';
  if (/gopay|gojek/i.test(from) || /tagihan gopay/i.test(text)) return 'GoPay';
  if (/steampowered|steam/i.test(from) || /pembayaran steam/i.test(text)) return 'Steam';
  if (/itemku/i.test(from) || /\bitemku\b/i.test(text)) return 'Itemku';
  if (/\bjago\b|pocket/i.test(text)) return 'Jago';
  return 'Lainnya';
}

// Banks decorate subjects with emoji ("…to Marks Gym💸"); the app shows none, so they are dropped on the way in.
// Subjects can also carry HTML entities ("Printing &amp; Fotoc").
const stripEmoji = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

// Clean emoji out of descriptions/subjects synced before this rule existed, and name Jago payments the way BCA
// ones are ("You have made a payment to kentang 88" -> "Bayar kentang 88") so both banks share remembered categories.
{
  const tidy = (s) => stripEmoji(s).replace(/^You have made a payment to\s+/i, 'Bayar ');
  const fix = (table, idCol, col) => {
    const rows = db.prepare(`SELECT ${idCol} AS id, ${col} AS v FROM ${table}`).all();
    const set = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${idCol} = ?`);
    db.transaction(() => rows.forEach((r) => r.v && tidy(r.v) !== r.v && set.run(tidy(r.v), r.id)))();
  };
  fix('transactions', 'id', 'description');
  fix('gmail_sync_log', 'message_id', 'subject');
}

// ---------- Auto category for synced expenses ----------
// Bank emails carry a merchant name, not a category, so the category is inferred from the merchant/subject only
// (never the whole body, whose footers mention unrelated brands).

// "You have made a payment to Marks Gym💸" -> "Marks Gym", and the app's own "Bayar Marks Gym" -> "Marks Gym"
function merchantOf(text) {
  const m =
    /(?:payment|paid|pembayaran|bayar|transaksi)\s+(?:to|ke|kepada|di|at)\s+([^\n.,;]{2,60})/i.exec(text || '') ||
    /^Bayar\s+(?!pakai\b)([^\n·]{2,60})/i.exec(text || '');
  return m ? m[1].replace(/[^\p{L}\p{N}&'\s-]/gu, '').replace(/\s+/g, ' ').trim() || null : null;
}

const CATEGORY_RULES = [
  ['Gym & Olahraga', /\b(gym|fitness|fit ?hub|yoga|pilates|futsal|badminton|renang|sport|lapangan)\b/i],
  ['Jajan / Kopi', /\b(kopi|coffee|cafe|kafe|starbucks|janji jiwa|kenangan|fore|tomoro|chatime|mixue|boba|jajan)\b/i],
  ['Makan', /\b(gofood|grabfood|shopeefood|resto|restaurant|restoran|warung|mcd|mcdonald'?s?|kfc|burger|pizza|bakso|sate|nasi|ayam)\b/i],
  ['Bensin', /\b(pertamina|spbu|shell|vivo energy|bensin|bbm|pertalite|pertamax)\b/i],
  ['Parkir & Toll', /\b(parkir|parking|tol|toll|e-?toll|flazz|jasa marga)\b/i],
  ['Transport', /\b(gojek|goride|gocar|grab|maxim|krl|mrt|lrt|transjakarta|kai|commuter)\b/i],
  ['Game', /\b(steam|itemku|playstation|psn|nintendo|xbox|garena|codashop|unipin|valorant)\b/i],
  ['Belanja', /\b(tokopedia|shopee|lazada|blibli|tiktok shop|indomaret|alfamart|supermarket|hypermart|superindo)\b/i],
  ['Langganan', /\b(netflix|spotify|youtube premium|disney|icloud|google one|chatgpt|openai|anthropic|claude)\b/i],
  ['Pulsa & Internet', /\b(pulsa|paket data|telkomsel|indosat|smartfren|indihome|biznet|first media|myrepublic)\b/i],
  ['Sedekah', /\b(sedekah|donasi|zakat|infaq|infak|kitabisa)\b/i],
];

// Budget category for an expense: the user's own flexible_expenses name when it clearly fits, else a generic label.
function categorize(subject, merchant, source) {
  const hay = `${merchant || ''} ${subject || ''}`;
  // 0) Remembered: the category last used for the same payee ("Transfer ke SITI AMINAH", "payment to
  //    ketoprak maskur"), ignoring the remark after " · ". Only when there is a payee, so generic notices like
  //    "transaction using your debit card" never inherit one merchant's category.
  const base = String(subject || '').split(' · ')[0].trim();
  if (merchant && base) {
    const prev = db
      .prepare(
        `SELECT category FROM transactions WHERE category IS NOT NULL AND (description = ? OR description LIKE ?)
         ORDER BY id DESC LIMIT 1`
      )
      .get(base, `${base} · %`);
    if (prev) return prev.category;
  }

  const budgets = db.prepare('SELECT name FROM flexible_expenses').all().map((r) => r.name);
  const words = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);

  // 1) A budget word appears in the merchant, e.g. budget "Service Beat Karbu" <- "AHASS Service".
  const own = budgets.find((b) => words(b).some((w) => new RegExp(`\\b${w}\\b`, 'i').test(merchant || '')));
  if (own) return own;

  // 2) Generic rule, mapped onto a budget that starts with the same word ("Bensin" -> "Bensin Beat Karbu").
  const rule = CATEGORY_RULES.find(([, re]) => re.test(hay));
  if (rule) {
    const lead = rule[0].split(/[\s/&]+/)[0].toLowerCase();
    return budgets.find((b) => b.toLowerCase().startsWith(lead)) || rule[0];
  }
  if (source === 'Steam' || source === 'Itemku') return 'Game';
  return null;
}

// Fill categories for synced expenses saved before auto-categorising existed (only empty ones, never overwrites).
{
  const rows = db
    .prepare("SELECT id, description, source FROM transactions WHERE type = 'expense' AND source != 'manual' AND category IS NULL")
    .all();
  const set = db.prepare('UPDATE transactions SET category = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      const c = categorize(r.description, merchantOf(r.description), r.source);
      if (c) set.run(c, r.id);
    }
  })();
}

// The everyday wallet ("Pocket Main"); unknown pocket names fall back to it for income/expense.
// Resolved on every sync because wallets can be renamed, deleted or re-created from the UI:
// the wallet picked in Pengaturan Gmail (or SYNC_MAIN_WALLET in .env) > a wallet named/typed "main"/"utama" >
// seeded liquidCash > the first wallet.
function mainWallet() {
  const wallets = db.prepare('SELECT id, name, category FROM wallets ORDER BY rowid').all();
  const byId = (id) => wallets.find((w) => w.id === id)?.id;
  return (
    byId(mainWalletSetting()) ||
    wallets.find((w) => /\b(main|utama)\b/i.test(`${w.id.replace(/([A-Z])/g, ' $1')} ${w.name} ${w.category}`))?.id ||
    byId('liquidCash') ||
    wallets[0]?.id ||
    null
  );
}

// Maps a pocket name from the email ("Pocket Main", "Motor Fund") to a wallet id, or null if unknown.
function walletForPocket(name) {
  if (!name) return null;
  // "your Main Pocket Pocket" -> "main", "kantong GoPay Tabungan kamu" -> "gopay tabungan"
  const n = name
    .toLowerCase()
    .replace(/\b(pocket|kantong|your|kamu|anda|mu)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return null;
  if (/\b(main|utama)\b/.test(n)) return mainWallet();
  const wallets = db.prepare('SELECT id, name, category FROM wallets').all();
  const hit = wallets.find((w) =>
    [w.id, w.name, w.category].some((v) => v && (v.toLowerCase().includes(n) || n.includes(v.toLowerCase())))
  );
  return hit ? hit.id : null;
}

const POCKET = String.raw`((?:pocket|kantong)?\s*[\w&' -]{2,40}?)`;
const TRANSFER_POCKETS_RE = new RegExp(String.raw`(?:from|dari)\s+${POCKET}\s+(?:to|ke)\s+${POCKET}(?=[.,;\n]|\s+(?:on|pada|at|with|sebesar|of)\b|$)`, 'i');
const RECEIVED_POCKET_RE = new RegExp(String.raw`(?:received|diterima|masuk)\b.{0,40}?\b(?:in|into|di|ke)\s+${POCKET}(?=[.,;\n]|\s|$)`, 'i');
const PAID_FROM_POCKET_RE = new RegExp(String.raw`(?:from|dari|using|pakai)\s+${POCKET}(?=[.,;\n]|\s|$)`, 'i');

// Readable pocket name as written in the email: "your Main Pocket Pocket" -> "Main Pocket",
// "your GoPay Tabungan Pocket" -> "GoPay Tabungan". Kept on the ledger row even when no wallet matches.
function pocketLabel(raw) {
  if (!raw) return null;
  const label = raw
    .replace(/\b(your|kamu|anda)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(pocket|kantong)$/i, ''); // Jago appends "Pocket" to every pocket name
  return label || null;
}

// Decides which wallet(s) a transaction touches, plus the pocket names seen in the email.
function resolveWallets(type, text) {
  if (type === 'transfer') {
    const m = TRANSFER_POCKETS_RE.exec(text);
    const fromLabel = pocketLabel(m?.[1]);
    const toLabel = pocketLabel(m?.[2]);
    const from = m && walletForPocket(m[1]);
    const to = m && walletForPocket(m[2]);
    // Both sides must be known wallets, otherwise balances are left alone (money only moved between own pockets).
    return from && to && from !== to ? { from, to, fromLabel, toLabel } : { fromLabel, toLabel };
  }
  const m = (type === 'income' ? RECEIVED_POCKET_RE : PAID_FROM_POCKET_RE).exec(text);
  return { wallet: walletForPocket(m?.[1]) || mainWallet(), label: pocketLabel(m?.[1]) };
}

// Pick text/plain if present, otherwise text/html, from an IMAP bodystructure tree.
function findTextPart(node) {
  if (!node) return null;
  if (node.childNodes) {
    const parts = node.childNodes.map(findTextPart).filter(Boolean);
    return parts.find((p) => p.type === 'text/plain') || parts[0] || null;
  }
  if (node.type === 'text/plain' || node.type === 'text/html') {
    return { type: node.type, part: node.part || '1' };
  }
  return null;
}

async function streamToString(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const htmlToText = (html) =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

// Moves a wallet's balance by `delta` rupiah. On a crypto wallet the coin amount moves too, at the last known price,
// so a manual "+Rp 100.000 top up" also buys the matching amount of coin.
const adjustWalletStmt = db.prepare(
  `UPDATE wallets SET
     balance = balance + ?,
     units = CASE WHEN asset IS NOT NULL AND price > 0 THEN COALESCE(units, 0) + ? / price ELSE units END,
     updated_at = CURRENT_TIMESTAMP
   WHERE id = ?`
);
const adjustWallet = { run: (delta, id) => adjustWalletStmt.run(delta, delta, id) };

// YYYY-MM-DD in WIB (UTC+7) for a timestamp in ms.
const wibDate = (ms = Date.now()) => new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);

// Applies (sign 1) or undoes (sign -1) a ledger row's effect on wallet balances.
// A transfer with an unknown side is logged only, so it never changes balances; neither does an unapplied row.
function walletEffect(tx, sign) {
  if (tx.applied === 0) return;
  if (tx.type === 'income') adjustWallet.run(sign * tx.amount, tx.wallet);
  else if (tx.type === 'expense') adjustWallet.run(-sign * tx.amount, tx.wallet);
  else if (tx.wallet && tx.to_wallet) {
    adjustWallet.run(-sign * tx.amount, tx.wallet);
    adjustWallet.run(sign * tx.amount, tx.to_wallet);
  }
}

const insertLedgerRow = db.prepare(
  `INSERT INTO transactions (date, type, amount, description, category, wallet, to_wallet, from_pocket, to_pocket, source, message_id, applied)
   VALUES (@date, @type, @amount, @description, @category, @wallet, @to_wallet, @from_pocket, @to_pocket, @source, @message_id, @applied)`
);

// True when any of these wallets had its real balance typed in after `isoTime` (see reconciled_at).
const reconciledAfter = (walletIds, isoTime) =>
  walletIds.filter(Boolean).some((id) => {
    const at = db.prepare('SELECT reconciled_at FROM wallets WHERE id = ?').get(id)?.reconciled_at;
    return Boolean(at && at > isoTime);
  });

// Single entry point for money movements: writes the ledger row and moves the balances together.
const recordTransaction = db.transaction((tx) => {
  const row = {
    category: null,
    wallet: null,
    to_wallet: null,
    from_pocket: null,
    to_pocket: null,
    source: 'manual',
    message_id: null,
    applied: 1,
    ...tx,
  };
  const { lastInsertRowid } = insertLedgerRow.run(row);
  walletEffect(row, 1);
  return lastInsertRowid;
});

// Deletes a ledger row and undoes its balance change; a Gmail row is also marked reverted so it is never re-synced.
const deleteLedgerRow = db.transaction((row) => {
  walletEffect(row, -1);
  db.prepare('DELETE FROM transactions WHERE id = ?').run(row.id);
  if (row.message_id) db.prepare('UPDATE gmail_sync_log SET reverted = 1 WHERE message_id = ?').run(row.message_id);
});

// ---------- Recurring (monthly schedules) ----------
// An occurrence is due on `day` of its month (clamped to the last day). Emails can come days late (BCA) or never
// (incoming salary), so nothing is booked automatically: a pending occurrence is settled by a matching ledger row
// within [due - 3, due + 10] days, or by the user ("Udah masuk" / "Lewatin").
const RECURRING_MATCH_BEFORE = 3;
const RECURRING_MATCH_AFTER = 10;
const RECURRING_LOOKBACK = 2; // also show still-pending occurrences from up to 2 months back

const shiftPeriod = (period, n) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
// Day 1 means "on payday", so it follows the period's start when that month's payday was moved (salary on 31 Okt).
const dueDate = (period, day) => {
  if (day === 1) return periodStart(period);
  const [y, m] = period.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period}-${String(Math.min(day, last)).padStart(2, '0')}`;
};
const shiftDay = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---------- Pay periods ----------
// A "month" in the app (period "2026-11") runs from its payday to the day before the next one. Payday is the 1st
// unless the user moved it for that month (setting "payday:2026-11" = "2026-10-31"): salary does not always come
// on the same date, and money received on 31 Okt is November's money.
const PAYDAY_EARLIEST_DAY = 20; // a payday can move back as far as the 20th of the previous month…
const PAYDAY_LATEST_DAY = 10; // …or forward to the 10th of its own month
const paydayKey = (period) => `payday:${period}`;
const periodStart = (period) => getSetting(paydayKey(period), null) || `${period}-01`;
const periodEnd = (period) => shiftDay(periodStart(shiftPeriod(period, 1)), -1);
function periodOf(date) {
  const p = date.slice(0, 7);
  if (date >= periodStart(shiftPeriod(p, 1))) return shiftPeriod(p, 1);
  if (date < periodStart(p)) return shiftPeriod(p, -1);
  return p;
}
const currentPeriod = () => periodOf(wibDate());
// Allowed paydays for a period: [20th of the previous month, 10th of the month].
const paydayBounds = (period) => [
  `${shiftPeriod(period, -1)}-${PAYDAY_EARLIEST_DAY}`,
  `${period}-${String(PAYDAY_LATEST_DAY).padStart(2, '0')}`,
];
// What the UI needs about one period.
const periodInfo = (period) => ({
  period,
  start: periodStart(period),
  end: periodEnd(period),
  moved: Boolean(getSetting(paydayKey(period), null)),
  bounds: paydayBounds(period),
});

// Periods worth showing for a rule: from its start (at most RECURRING_LOOKBACK months back) through this month.
function recurringPeriods(rule, today = wibDate()) {
  const current = periodOf(today);
  let p = rule.start_period > shiftPeriod(current, -RECURRING_LOOKBACK) ? rule.start_period : shiftPeriod(current, -RECURRING_LOOKBACK);
  const out = [];
  for (; p <= current; p = shiftPeriod(p, 1)) out.push(p);
  return out;
}

// Same type, inside the date window, not already settling another occurrence, and either from the rule's wallet with
// a similar amount (10% or FEE_TOLERANCE: salary can differ a bit), or tagged with the rule's category at a looser
// amount (50%), so a 60k phone top-up in "Pulsa & Internet" does not settle a 300k wifi bill.
function findRecurringMatch(rule, due) {
  const tolerance = Math.max(rule.amount * 0.1, FEE_TOLERANCE);
  const categoryTolerance = Math.max(rule.amount * 0.5, FEE_TOLERANCE);
  return db
    .prepare(
      `SELECT * FROM transactions t
       WHERE type = ? AND date BETWEEN ? AND ?
         AND id NOT IN (SELECT transaction_id FROM recurring_runs WHERE transaction_id IS NOT NULL)
         AND ((? IS NOT NULL AND lower(trim(category)) = lower(trim(?)) AND abs(amount - ?) <= ?)
              OR (wallet = ? AND abs(amount - ?) <= ?))
       ORDER BY (lower(trim(coalesce(category, ''))) = lower(trim(coalesce(?, '')))) DESC, abs(amount - ?), abs(julianday(date) - julianday(?))
       LIMIT 1`
    )
    .get(
      rule.type,
      shiftDay(due, -RECURRING_MATCH_BEFORE),
      shiftDay(due, RECURRING_MATCH_AFTER),
      rule.category,
      rule.category,
      rule.amount,
      categoryTolerance,
      rule.wallet,
      rule.amount,
      tolerance,
      rule.category,
      rule.amount,
      due
    );
}

// Settles what can be settled and returns every rule with the status of each shown period:
// done (with its transaction) | skipped | pending (due, unsettled) | upcoming (not due yet).
const recurringStatus = db.transaction(() => {
  const today = wibDate();
  // A settled occurrence whose transaction was deleted goes back to pending.
  db.prepare(
    "DELETE FROM recurring_runs WHERE status = 'done' AND transaction_id NOT IN (SELECT id FROM transactions)"
  ).run();
  const runOf = db.prepare('SELECT * FROM recurring_runs WHERE recurring_id = ? AND period = ?');
  const settle = db.prepare(
    "INSERT INTO recurring_runs (recurring_id, period, status, transaction_id) VALUES (?, ?, 'done', ?)"
  );
  const txById = db.prepare('SELECT id, date, amount, description, source FROM transactions WHERE id = ?');

  return db
    .prepare('SELECT * FROM recurring ORDER BY day, id')
    .all()
    .map((rule) => {
      const occurrences = recurringPeriods(rule, today).map((period) => {
        const due = dueDate(period, rule.day);
        let run = runOf.get(rule.id, period);
        // Matching also runs before the due date: a transfer done a day early still counts for that month.
        if (!run && today >= shiftDay(due, -RECURRING_MATCH_BEFORE)) {
          const tx = findRecurringMatch(rule, due);
          if (tx) {
            settle.run(rule.id, period, tx.id);
            run = { status: 'done', transaction_id: tx.id };
          }
        }
        const status = run ? run.status : due <= today ? 'pending' : 'upcoming';
        return { period, due, status, transaction: run?.transaction_id ? txById.get(run.transaction_id) : null };
      });
      return { ...rule, occurrences };
    });
});

// A move between your own accounts is announced twice: by the sending side ("transfer out", e.g. BCA, Pintu) and
// by the receiving bank ("money in", e.g. Jago). These find the other half among rows already recorded from email.
// The received amount may be lower by an admin fee (Pintu withdrawal: sent 64.955, received 60.455), so a match
// allows up to FEE_TOLERANCE less on the receiving side; the closest amount wins.
const FEE_TOLERANCE = 25000;
const incomeTwin = (sent, date, wallet, source) =>
  db
    .prepare(
      `SELECT * FROM transactions WHERE type = 'income' AND date = ? AND message_id IS NOT NULL AND source != ?
         AND amount BETWEEN ? AND ? AND (? IS NULL OR wallet = ?) ORDER BY ABS(amount - ?), id DESC LIMIT 1`
    )
    .get(date, source, sent - FEE_TOLERANCE, sent, wallet, wallet, sent);
const transferTwin = (received, date, wallet, source) =>
  db
    .prepare(
      `SELECT * FROM transactions WHERE type = 'transfer' AND date = ? AND message_id IS NOT NULL AND source != ?
         AND amount BETWEEN ? AND ? AND (to_wallet IS NULL OR to_wallet = ?) ORDER BY ABS(amount - ?), id DESC LIMIT 1`
    )
    .get(date, source, received, received + FEE_TOLERANCE, wallet, received);
// Money sent from a bank into an app (Jago "You have made a transfer" -> Pintu deposit): the bank side was recorded
// as spending; the app's deposit email shows it was a move into your own wallet.
const expenseTwin = (amount, date, source) =>
  db
    .prepare(
      `SELECT * FROM transactions WHERE type = 'expense' AND amount = ? AND date = ? AND message_id IS NOT NULL
         AND source != ? ORDER BY id DESC LIMIT 1`
    )
    .get(amount, date, source);

// The same notification sent twice within a few minutes (Pintu does this): counted once.
const nearDuplicate = db.prepare(
  `SELECT 1 FROM gmail_sync_log WHERE source = ? AND type = ? AND subject = ? AND email_date IS NOT NULL
     AND ABS(strftime('%s', email_date) - strftime('%s', ?)) <= 180 LIMIT 1`
);

// Records the admin fee kept by the sender when the received amount is lower than the amount sent.
function recordFee(fee, fromWallet, date, label, source) {
  if (!(fee > 0) || !fromWallet) return;
  recordTransaction({
    date: wibDate(Date.parse(date)),
    type: 'expense',
    amount: fee,
    description: `Biaya admin · ${label}`,
    category: 'Biaya Admin',
    wallet: fromWallet,
    source,
    applied: reconciledAfter([fromWallet], date) ? 0 : 1,
  });
}

// ---------- Pintu (crypto exchange): Rupiah deposits and withdrawals ----------
const PINTU_SENDER_RE = /support@pintu\.co\.id/i;
const idrPlain = new Intl.NumberFormat('id-ID');
function parsePintu(subject, text) {
  const amount = extractAmount(text, 0);
  if (!amount) return null;
  if (/successfully sent|berhasil (dikirim|ditarik)|withdraw/i.test(subject)) return { kind: 'withdraw', amount };
  if (/you have received|received idr|deposit/i.test(subject)) return { kind: 'deposit', amount };
  return null;
}
// The wallet that stands for the Pintu account (e.g. "BTC CRYPTO", type "Pintu").
const pintuWallet = () =>
  db.prepare('SELECT id, name, category FROM wallets').all().find((w) => /\bpintu\b/i.test(`${w.name} ${w.category}`))?.id || null;

// ---------- Other banks & e-wallets: one general parser ----------
// Most Indonesian bank notifications are a run of "Label value" (or "Label : value") pairs:
// "Penerima kentang 88 Jakarta - ID Tanggal … Nominal Transaksi Rp 8.000,00 …" (Livin' by Mandiri). Only mail from
// these official domains is read; a kind or amount that is not clearly recognised is skipped and shown in the log.
const BANK_SENDERS = [
  ['Mandiri', /bankmandiri\.co\.id/i],
  ['BRI', /\bbri\.co\.id/i],
  ['BNI', /\bbni\.co\.id/i],
  ['BSI', /bankbsi\.co\.id/i],
  ['CIMB Niaga', /cimbniaga\.co\.id/i],
  ['Permata', /permatabank\.(co\.id|com)/i],
  ['Danamon', /danamon\.co\.id/i],
  ['BTN', /\bbtn\.co\.id/i],
  ['SeaBank', /seabank\.co\.id/i],
  ['OCBC', /\bocbc\.(id|com)/i],
  ['Jenius', /\b(btpn|jenius)\.com/i],
  ['blu', /bcadigital\.co\.id/i],
  ['Superbank', /superbank\.id/i],
  ['Allo Bank', /allobank\.com/i],
  ['DANA', /\bdana\.id/i],
  ['OVO', /\bovo\.id/i],
  ['ShopeePay', /shopeepay\.co\.id/i],
  ['LinkAja', /linkaja\.(id|com)/i],
];
const bankOf = (from) => BANK_SENDERS.find(([, re]) => re.test(from))?.[0] || null;
// The wallet for a bank / e-wallet by whole word in its name or type ("Mandiri", "BRI Tabungan"). Short all-caps
// names (DANA, OVO, BRI) must match in caps, so a "Dana Darurat" wallet is not the DANA e-wallet.
function walletNamed(name) {
  if (!name) return null;
  const word = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, /^[A-Z]{3,4}$/.test(name) ? 'u' : 'iu');
  return db.prepare('SELECT id, name, category FROM wallets').all().find((w) => re.test(`${w.name} ${w.category || ''}`))?.id || null;
}

// Account notices that are not money movements (or cannot be read, like an encrypted statement).
const BANK_NOTICE_RE =
  /kode verifikasi|\botp\b|e-?statement|consolidated statement|rekening koran|berhasil dihubungkan|pembukaan rekening|kartu debit virtual|\blogin\b|kata sandi|password|\bpin\b|perubahan data|aktivasi/i;
const BANK_FAILED_RE = /tidak berhasil|gagal|failed|unsuccessful|ditolak|dibatalkan|kedaluwarsa|expired/i;
const BANK_KINDS = [
  { kind: 'income', re: /(dana|uang|transfer) masuk|menerima (dana|uang|transfer)|telah diterima|received|incoming|\bcredited\b|\bkredit\b|refund|pengembalian dana|cashback/i },
  { kind: 'withdraw', re: /tarik tunai|penarikan tunai|cash withdrawal/i },
  { kind: 'topup', re: /top.?up|isi ulang|isi saldo/i },
  { kind: 'transfer', re: /transfer|kirim (uang|dana)|pemindahbukuan/i },
  { kind: 'payment', re: /pembayaran|bayar|payment|pembelian|purchase|transaksi qris|\bqris\b|\bdebit\b|tagihan/i },
];
// Where a labelled value stops: the next label of the same email.
const BANK_STOP =
  'Tanggal|Jam|Waktu|Date|Time|Nominal|Jumlah|Total|Biaya|Amount|Fee|No\\.|Nomor|Customer|Keterangan|Berita|Catatan|Remarks|Rekening|Sumber|Source|Status|Merchant PAN|Terminal|Pengakuisisi|Acquirer|Tujuan Transaksi|Simpan|Terima kasih|Bank\\s|\\d{6,}';
// Labels are tried in the order given (most specific first), so a common word later in the list ("Tujuan")
// cannot win over a real label just because it appears earlier in the text.
const bankField = (text, labels) => {
  for (const label of labels.split('|')) {
    const v = new RegExp(`\\b${label}\\s*:?\\s+(.+?)\\s*(?=\\b(?:${BANK_STOP})|\\s-\\s|$)`, 'i').exec(text)?.[1]?.trim();
    if (v) return v;
  }
  return null;
};
const bankAmount = (text, labels) => {
  for (const label of labels.split('|')) {
    const v = parseMoney(new RegExp(`\\b${label}\\s*:?\\s*((?:Rp|IDR)\\.?\\s*\\d[\\d.,]*)`, 'i').exec(text)?.[1]);
    if (v) return v;
  }
  return null;
};
// "Bank Central Asia" -> "BCA", the short names wallets are usually called by.
const BANK_SHORT = [
  [/central asia/i, 'BCA'],
  [/syariah indonesia/i, 'BSI'],
  [/negara indonesia/i, 'BNI'],
  [/rakyat indonesia/i, 'BRI'],
  [/tabungan negara/i, 'BTN'],
  [/^(bank )?mandiri$/i, 'Mandiri'],
  [/^(bank )?jago$/i, 'Jago'],
];
const shortBank = (name) => BANK_SHORT.find(([re]) => re.test(name || ''))?.[1] || (name || '').replace(/^bank\s+/i, '').trim() || null;
const EWALLETS_RE = /^(gopay|go-pay|ovo|dana|shopeepay|linkaja)$/i;

// { type, kind, amount, description, counterparty, toLabel } for a recognised email, a skip reason string, or null.
function parseBankEmail(bank, subject, body) {
  const head = `${subject}\n${body.slice(0, 400)}`;
  if (BANK_NOTICE_RE.test(subject)) return null;
  if (BANK_FAILED_RE.test(subject)) return `${bank}, transaksi nggak berhasil`;
  const kind = (BANK_KINDS.find((k) => k.re.test(subject)) || BANK_KINDS.find((k) => k.re.test(head)))?.kind;
  if (!kind) return null;

  const amount =
    bankAmount(body, 'Total Transaksi|Total Pembayaran|Total Payment|Total Transfer|Total Debit|Total') ||
    bankAmount(body, 'Nominal Transaksi|Nominal Transfer|Nominal Top-?up|Nominal Pembayaran|Jumlah Transfer|Jumlah Pembayaran|Jumlah Dana|Nominal|Jumlah|Amount') ||
    extractAmount(`${subject}\n${body}`, 0);
  if (!amount || amount < MIN_AMOUNT) return `${bank}, nominal nggak ketemu`;

  // "e-money ****4138" -> "e-money", "kentang 88 Jakarta - ID" -> "kentang 88 Jakarta"
  const tidy = (s) => (s ? s.replace(/\s+-\s+ID$/i, '').replace(/\s*\*+\d*$/, '').replace(/\s+/g, ' ').trim() || null : null);
  const holder = holderOf(body);
  if (kind === 'income') {
    const sender = tidy(bankField(body, 'Nama Pengirim|Pengirim|Sender|Dari\\s*:|From\\s*:'));
    return { type: 'income', kind, amount, description: sender ? `Terima dari ${sender}` : `Uang masuk ${bank}`, counterparty: sender };
  }
  if (kind === 'withdraw') return { type: 'expense', kind, amount, description: `Tarik tunai ${bank}`, counterparty: null };
  if (kind === 'topup') {
    const provider = tidy(bankField(body, 'Penyedia Jasa|Penyedia|Provider|Produk|Tujuan\\s*:'));
    const name = /^go-?pay$/i.test(provider || '') ? 'GoPay' : provider;
    // Topping up your own e-wallet moves money (a GoPay -> Jago move later folds into it); a toll / e-money card
    // top up is spending.
    return EWALLETS_RE.test(provider || '')
      ? { type: 'transfer', kind, amount, description: `Top up ${name}`, counterparty: name, toLabel: name }
      : { type: 'expense', kind, amount, description: `Top up ${name || 'e-wallet'}`, counterparty: name };
  }
  const name = tidy(bankField(body, 'Nama Penerima|Penerima|Nama Merchant|Merchant|Payment to|Beneficiary Name|Kepada|Tujuan\\s*:'));
  if (kind === 'transfer') {
    const toBank = shortBank(/\b(Bank [A-Za-z ]+?|BCA|BNI|BRI|BSI|BTN|CIMB Niaga|Permata|Danamon|SeaBank|Jago|Jenius|blu)\s+[-•]\s*[\d*]{4,}/.exec(body)?.[1]);
    if (name && toBank && sameName(name, holder)) {
      return { type: 'transfer', kind: 'own', amount, description: `Transfer ke ${toBank}`, counterparty: toBank, toLabel: toBank };
    }
    return { type: 'expense', kind, amount, description: name ? `Transfer ke ${name}` : `Transfer ${bank}`, counterparty: name };
  }
  return { type: 'expense', kind, amount, description: name ? `Bayar ${name}` : `Pembayaran ${bank}`, counterparty: name };
}

// ---------- Bibit (mutual funds): purchases, units, redemptions ----------
// One purchase sends two emails sharing an order number: "Pembayaran kamu sudah berhasil diterima" (money left the
// bank) and a day later "Unit Reksa Dana Kamu Sudah Masuk" (exact units at the real NAV). A redemption ends with
// "Dana Berhasil Dicairkan" (money arrived in the bank). Bodies are "Label value" runs; amounts are "Rp300,000".
const BIBIT_SENDER_RE = /no-reply@bibit\.id/i;
const BIBIT_NEXT_LABEL =
  'Order ID|Nominal|Tanggal|Metode|Reference No|Nama Reksa Dana|Biaya|Nilai|Jumlah Unit|NAV|Kode Unik|Bank Penerima|No\\. Rekening|Nama Penerima|Aktifkan|Jika ada|Terima kasih';
const bibitField = (text, label) =>
  new RegExp(`${label}\\s*:?\\s*(.+?)\\s*(?=\\b(?:${BIBIT_NEXT_LABEL})\\b|$)`, 'i').exec(text)?.[1] || null;
const bibitRupiah = (s) => (s && /Rp/i.test(s) ? Number(s.replace(/[^\d]/g, '')) || null : null); // no decimals
const bibitUnits = (s) => (s ? Number(s.replace(/,/g, '').match(/\d+(?:\.\d+)?/)?.[0]) || null : null);
// "REKSA DANA SYARIAH MAJORIS PASAR UANG SYARIAH INDONESIA" -> "Majoris Pasar Uang Syariah Indonesia"
const bibitFundName = (s) =>
  String(s || '')
    .replace(/^reksa dana\s+(syariah\s+)?/i, '')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

function parseBibit(subject, body) {
  const order = (bibitField(body, 'Order ID Pembayaran') || bibitField(body, 'Nomor Order') || '').split(/\s/)[0] || null;
  const fund = bibitFundName(bibitField(body, 'Nama Reksa Dana'));
  if (/pembayaran kamu sudah berhasil/i.test(subject)) {
    const amount = bibitRupiah(bibitField(body, 'Nominal Pembelian'));
    const paid = bibitRupiah(bibitField(body, 'Nominal Terverifikasi')) || amount;
    return amount && { kind: 'buy', order, fund, amount, fee: paid - amount, method: bibitField(body, 'Metode Pembayaran') };
  }
  if (/unit reksa dana kamu sudah masuk/i.test(subject)) {
    const amount = bibitRupiah(bibitField(body, 'Nilai Pembelian'));
    const units = bibitUnits(bibitField(body, 'Jumlah Unit'));
    return amount && units && { kind: 'units', order, fund, amount, units };
  }
  if (/dana berhasil dicairkan/i.test(subject)) {
    const amount = bibitRupiah(bibitField(body, 'Nilai Transfer yang Diterima')) || bibitRupiah(bibitField(body, 'Nilai Penjualan'));
    return amount && { kind: 'sell', order, fund, amount, bank: bibitField(body, 'Bank Penerima') };
  }
  return null; // "Penjualan dalam proses", "Lakukan pembayaran", account notices: nothing moved yet
}

// The fund's wallet: a Bibit / Pasardana-linked wallet sharing the most name words with the fund
// ("RDPU Majoris Pasar Uang Syariah" <- "Majoris Pasar Uang Syariah Indonesia"), or the only one there is.
function fundWallet(fund) {
  const wallets = db
    .prepare('SELECT id, name, category, asset FROM wallets')
    .all()
    .filter((w) => /\bbibit\b/i.test(`${w.name} ${w.category}`) || String(w.asset || '').startsWith('fund:'));
  const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 4 && !/^(reksa|dana|syariah|indonesia)$/.test(x));
  const wanted = new Set(words(fund));
  const [best] = wallets
    .map((w) => ({ w, score: words(w.name).filter((x) => wanted.has(x)).length }))
    .sort((a, b) => b.score - a.score);
  return best && (best.score > 0 || wallets.length === 1) ? best.w : null;
}

// A bank / payment method named in the email ("Jago Dana Darurat", "Bank Jago", "BCA") -> wallet id, or null.
function bankWallet(name) {
  const n = String(name || '').replace(/^bank\s+/i, '').trim();
  if (/^jago$/i.test(n)) return mainWallet();
  return walletForPocket(n.replace(/^jago\s+/i, '')) || null;
}

// A transfer already recorded for this fund move (from the bank's email, the other Bibit email, or typed in),
// same amount within a day either side. `col` is 'to_wallet' for purchases and 'wallet' for redemptions.
const fundTwin = (col, wallet, amount, day, source) =>
  db
    .prepare(
      `SELECT * FROM transactions WHERE type = 'transfer' AND ${col} = ? AND amount = ? AND date BETWEEN ? AND ?
         AND source != ? ORDER BY id DESC LIMIT 1`
    )
    .get(wallet, amount, shiftDay(day, -1), shiftDay(day, 1), source);

// "Unit sudah masuk": the purchase was recorded as a transfer into the fund wallet, which bought units at the last
// known NAV (or bought none when the paying pocket is not a wallet here). The email has the exact units, so the
// wallet is corrected to them. Returns the log target, or null when the units are already in a typed-in balance.
const applyFundUnits = db.transaction(({ messageId, subject, wallet, order, amount, units, date }) => {
  const w = db.prepare('SELECT * FROM wallets WHERE id = ?').get(wallet);
  const day = wibDate(Date.parse(date));
  const byOrder = `%${order || '\u0000'}%`;
  const buy = db
    .prepare(
      `SELECT * FROM transactions WHERE type = 'transfer' AND to_wallet = ?
         AND (description LIKE ? OR (amount = ? AND date BETWEEN ? AND ?))
       ORDER BY description LIKE ? DESC, id DESC LIMIT 1`
    )
    .get(wallet, byOrder, amount, shiftDay(day, -7), day, byOrder);
  if (buy && !buy.applied) return null;
  const counted = Boolean(buy?.wallet); // both sides known: the transfer already moved the balance
  const priced = Boolean(w.asset) && w.price > 0;
  const unitsDelta = w.asset ? units - (counted && priced ? buy.amount / w.price : 0) : 0;
  const newUnits = (w.units || 0) + unitsDelta;
  const balanceDelta = priced ? Math.round(newUnits * w.price) - w.balance : counted ? 0 : amount;
  db.prepare('UPDATE wallets SET units = ?, balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    w.asset ? newUnits : w.units,
    balanceDelta,
    wallet
  );
  const target = `${w.name} · ${units.toLocaleString('id-ID', { maximumFractionDigits: 4 })} unit`;
  db.prepare(
    `INSERT INTO gmail_sync_log (message_id, subject, source, type, amount, target, wallet, email_date, units)
     VALUES (?, ?, 'Bibit', 'transfer', ?, ?, ?, ?, ?)`
  ).run(messageId, subject, balanceDelta, target, wallet, date, unitsDelta);
  return target;
});

// Paying an investment app (Bibit, Pintu, …) from a bank is a move into your own wallet for it, not spending.
const INVEST_APP_RE = /\b(bibit|bareksa|ajaib|pluang|stockbit|pintu|indodax|tokocrypto|nanovest)\b/i;
function investWalletFor(merchant) {
  const app = INVEST_APP_RE.exec(merchant || '')?.[1];
  if (!app) return null;
  return db.prepare('SELECT id, name, category FROM wallets').all().find((w) => new RegExp(`\\b${app}\\b`, 'i').test(`${w.name} ${w.category}`))?.id || null;
}

// Applies one parsed email: a ledger row plus a sync-log row. Returns a human-readable `target`.
const applyTransaction = db.transaction((tx) => {
  const { wallet = null, from = null, to = null, fromLabel = null, toLabel = null, label = null } = tx.wallets;
  const isTransfer = tx.type === 'transfer';
  const debit = isTransfer ? from : wallet;
  const target = isTransfer
    ? from && to
      ? `${from} → ${to}`
      : `${fromLabel || '?'} → ${toLabel || '?'} (saldo tidak diubah)`
    : debit || '(tanpa wallet)';

  recordTransaction({
    date: wibDate(Date.parse(tx.date)),
    type: tx.type,
    amount: tx.amount,
    description: tx.subject,
    category: tx.type === 'expense' ? tx.category || null : null,
    wallet: debit,
    to_wallet: isTransfer ? to : null,
    from_pocket: isTransfer ? fromLabel : tx.type === 'expense' ? label : null,
    to_pocket: isTransfer ? toLabel : tx.type === 'income' ? label : null,
    source: tx.source,
    message_id: tx.messageId,
    // Email older than the last "samain saldo" on an involved wallet: already inside that balance.
    applied: reconciledAfter([debit, isTransfer ? to : null], tx.date) ? 0 : 1,
  });
  db.prepare(
    `INSERT INTO gmail_sync_log (message_id, subject, source, type, amount, target, wallet, email_date, forwarded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tx.messageId, tx.subject, tx.source, tx.type, tx.amount, target, debit, tx.date, tx.forwarded ? 1 : 0);
  return target;
});

// Undoes one synced email. New rows live in the ledger; the branch below handles
// older log rows from before the ledger existed (expenses were written to flexible_expenses).
const revertTransaction = db.transaction((row) => {
  const ledger = db.prepare('SELECT * FROM transactions WHERE message_id = ?').get(row.message_id);
  if (ledger) return deleteLedgerRow(ledger);

  if (row.units != null) {
    // Bibit "unit sudah masuk": only corrected the fund wallet's units and balance.
    db.prepare('UPDATE wallets SET units = units - ?, balance = balance - ? WHERE id = ?').run(row.units, row.amount, row.wallet);
  } else if (row.type === 'income') {
    adjustWallet.run(-row.amount, row.wallet || row.target);
  } else if (row.type === 'transfer') {
    const [from, to] = String(row.target).split(' → ');
    if (to) {
      adjustWallet.run(row.amount, from);
      adjustWallet.run(-row.amount, to);
    }
  } else {
    if (row.wallet) adjustWallet.run(row.amount, row.wallet);
    db.prepare(
      'DELETE FROM flexible_expenses WHERE id = (SELECT MAX(id) FROM flexible_expenses WHERE name = ? AND amount = ?)'
    ).run(row.target, row.amount);
  }
  db.prepare('UPDATE gmail_sync_log SET reverted = 1 WHERE message_id = ?').run(row.message_id);
});

const gmailClient = ({ user, pass }) =>
  new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });

async function syncGmailTransactions() {
  const config = gmailConfig();
  if (!gmailConfigured(config)) {
    const err = new Error('Gmail belum dihubungin. Isi email & App Password di Pengaturan Gmail dulu, ya.');
    err.status = 400;
    err.code = 'gmail_not_configured';
    throw err;
  }
  const SYNC_START = config.start;
  const SYNC_START_TIME = syncStartTime(SYNC_START);
  const GMAIL_QUERY = gmailQuery(SYNC_START);

  const client = gmailClient(config);

  const details = [];
  const skipped = {}; // reason -> count, so the UI can explain why nothing was applied
  const skip = (reason) => (skipped[reason] = (skipped[reason] || 0) + 1);
  const alreadySynced = db.prepare('SELECT 1 FROM gmail_sync_log WHERE message_id = ?');
  // The same payment can arrive twice (Gmail auto-forward + a manual "Fwd:"), each with its own Message-ID.
  // A copy of an already-recorded notification: same kind, amount, subject and day, where exactly one of the two
  // is a forward (auto-forward original + manual "Fwd:"). Two originals are two real transactions.
  const sameTransaction = db.prepare(
    `SELECT 1 FROM transactions t JOIN gmail_sync_log l ON l.message_id = t.message_id
     WHERE t.type = ? AND t.amount = ? AND t.description = ? AND t.date = ? AND l.forwarded != ?`
  );
  const logDuplicate = db.prepare(
    `INSERT INTO gmail_sync_log (message_id, subject, source, type, amount, target, email_date, reverted, forwarded)
     VALUES (?, ?, ?, ?, ?, 'duplikat (sudah tercatat)', ?, 1, ?)`
  );

  await client.connect();
  try {
    // Auto-forwarded bank mail often lands in Spam (it fails the sender's DMARC check after forwarding),
    // so Spam is searched too. The same whitelist query and guardrails apply there.
    const boxes = await client.list();
    const mailboxes = ['INBOX', boxes.find((b) => b.specialUse === '\\Junk')?.path].filter(Boolean);
    for (const mailbox of mailboxes) {
      await syncMailbox(mailbox);
    }
  } finally {
    await client.logout().catch(() => {});
  }

  // Readable text of a message (text/plain preferred, else text/html stripped of tags).
  async function bodyOf(msg) {
    const textPart = findTextPart(msg.bodyStructure);
    if (!textPart) return '';
    const { content } = await client.download(msg.uid, textPart.part, { uid: true, maxBytes: 512 * 1024 });
    if (!content) return '';
    const body = await streamToString(content);
    return textPart.type === 'text/html' ? htmlToText(body) : body;
  }

  // Rows synced before the payee was read from the body ("You have made a transfer", "Transaksi BCA") get their
  // description rewritten from the original email. Only the wording changes, never the amount or the wallets.
  async function renameGenericRows() {
    const rows = db
      .prepare(
        `SELECT id, message_id, source, type, description, category FROM transactions
         WHERE message_id IS NOT NULL AND message_id NOT LIKE 'uid:%' AND date >= ?
           AND ((source = 'Jago' AND description IN ('You have made a transfer', 'You have done an e-Wallet top up',
                                                     'You have made a transaction using your debit card'))
             OR (source = 'BCA' AND description = 'Transaksi BCA'))`
      )
      .all(SYNC_START);
    for (const row of rows) {
      const [uid] = (await client.search({ gmraw: `rfc822msgid:${row.message_id}` }, { uid: true })) || [];
      if (!uid) continue;
      const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
      const subject = stripEmoji((msg.envelope?.subject || '').replace(/^\s*((fwd?|fw|tr)\s*:\s*)+/i, ''));
      const body = await bodyOf(msg);
      const bca = row.source === 'BCA' ? parseBcaJournal(subject, body) : null;
      const payee = row.source === 'Jago' ? jagoPayee(body) : null;
      const description = bca ? (typeof bca === 'string' ? null : bca.description) : jagoDescription(subject, payee, holderOf(body));
      if (!description || description === row.description) continue;
      const category =
        row.category || (row.type === 'expense' ? categorize(description, bca?.counterparty || payee?.name, row.source) : null);
      db.prepare('UPDATE transactions SET description = ?, category = ? WHERE id = ?').run(description, category, row.id);
      db.prepare('UPDATE gmail_sync_log SET subject = ? WHERE message_id = ?').run(description, row.message_id);
    }
  }

  async function syncMailbox(mailbox) {
    const lock = await client.getMailboxLock(mailbox);
    try {
      await renameGenericRows();
      const uids = (await client.search({ gmraw: GMAIL_QUERY }, { uid: true })) || [];
      const recent = uids.slice(-GMAIL_MAX_MESSAGES);

      // Collect metadata first; downloading parts while a fetch is streaming would deadlock the connection.
      const messages = [];
      if (recent.length) {
        const query = { envelope: true, bodyStructure: true, headers: NEWSLETTER_HEADERS };
        for await (const msg of client.fetch(recent, query, { uid: true })) messages.push(msg);
      }

      for (const msg of messages) {
        const messageId = msg.envelope?.messageId || `uid:${msg.uid}`;
        if (alreadySynced.get(messageId)) continue;
        if (msg.envelope?.date && new Date(msg.envelope.date).getTime() < SYNC_START_TIME) {
          skip(`sebelum ${SYNC_START}`);
          continue;
        }

        // Manually forwarded notifications arrive as "Fwd: ..."; keep the original subject, minus the bank's emoji.
        const subject = stripEmoji((msg.envelope?.subject || '').replace(/^\s*((fwd?|fw|tr)\s*:\s*)+/i, '')) || '(tanpa subjek)';
        const from = (msg.envelope?.from || []).map((a) => `${a.name || ''} ${a.address || ''}`).join(' ');

        // Guardrail A + B (subject), before the body is ever downloaded.
        if (NEWSLETTER_HEADER_RE.test(msg.headers?.toString() || '')) {
          skip('newsletter: header bulk/unsubscribe');
          continue;
        }
        if (NEWSLETTER_WORDS_RE.test(`${from} ${subject}`)) {
          skip('newsletter: kata di pengirim/subjek');
          continue;
        }

        const body = await bodyOf(msg);

        // Guardrail B (body).
        if (NEWSLETTER_WORDS_RE.test(body)) {
          skip('newsletter: kata di isi email');
          continue;
        }

        const text = `${subject}\n${body}`;
        const isBibit = BIBIT_SENDER_RE.test(from);
        const isBca = !isBibit && (BCA_SENDER_RE.test(from) || BCA_BODY_RE.test(body));
        const isJago = !isBibit && !isBca && (JAGO_SENDER_RE.test(from) || JAGO_BODY_RE.test(body));
        const isPintu = !isBibit && !isBca && !isJago && PINTU_SENDER_RE.test(from);
        const otherBank = !isBibit && !isBca && !isJago && !isPintu ? bankOf(from) : null;
        const date = (msg.envelope?.date ? new Date(msg.envelope.date) : new Date()).toISOString();
        const day = wibDate(Date.parse(date));

        // Turn the email into one transaction: { type, amount, description, source, wallets, category, phrase }.
        let tx;
        let fee = 0;
        if (isBibit) {
          const b = parseBibit(subject, body);
          if (!b) {
            skip('Bibit, bukan email transaksi');
            continue;
          }
          const fund = fundWallet(b.fund);
          if (!fund) {
            skip(`Bibit, wallet reksa dana "${b.fund}" belum ada`);
            continue;
          }
          if (b.kind === 'units') {
            const target = applyFundUnits({ messageId, subject, wallet: fund.id, order: b.order, amount: b.amount, units: b.units, date });
            if (!target) {
              logDuplicate.run(messageId, subject, 'Bibit', 'transfer', b.amount, date, 0);
              skip('Bibit, unit udah ada di saldo');
              continue;
            }
            details.push({ message_id: messageId, subject, source: 'Bibit', type: 'TRANSFER', amount: b.amount, target, phrase: 'unit sudah masuk', mailbox, date });
            continue;
          }
          const order = b.order ? ` · ${b.order}` : '';
          if (b.kind === 'buy') {
            tx = {
              type: 'transfer',
              amount: b.amount,
              description: `Beli ${b.fund} di Bibit${order}`,
              source: 'Bibit',
              phrase: 'pembayaran berhasil',
              wallets: { from: bankWallet(b.method), to: fund.id, fromLabel: b.method || 'Bank', toLabel: fund.name },
              category: null,
              twin: ['to_wallet', fund.id],
            };
            fee = Math.max(0, b.fee || 0);
          } else {
            tx = {
              type: 'transfer',
              amount: b.amount,
              description: `Jual ${b.fund} di Bibit${order}`,
              source: 'Bibit',
              phrase: 'dana dicairkan',
              wallets: { from: fund.id, to: bankWallet(b.bank), fromLabel: fund.name, toLabel: b.bank || 'Bank' },
              category: null,
              twin: ['wallet', fund.id],
            };
          }
        } else if (isBca) {
          const bca = parseBcaJournal(subject, body);
          if (!bca || typeof bca === 'string') {
            skip(bca || 'BCA, bukan email transaksi');
            continue;
          }
          const bcaWallet = walletForPocket('BCA'); // a wallet named/typed "BCA", if there is one
          const investTo = bca.type === 'expense' ? investWalletFor(bca.counterparty) : null;
          tx = {
            type: investTo ? 'transfer' : bca.type,
            amount: bca.amount,
            description: bca.description,
            source: 'BCA',
            phrase: 'Internet Transaction Journal',
            wallets: investTo
              ? { from: bcaWallet, to: investTo, fromLabel: 'BCA', toLabel: bca.counterparty }
              : bca.type === 'transfer'
                ? { from: bcaWallet, to: walletForPocket(bca.toLabel), fromLabel: 'BCA', toLabel: bca.toLabel }
                : { wallet: bcaWallet, label: 'BCA' },
            category: bca.type === 'expense' && !investTo ? categorize(bca.description, bca.counterparty, 'BCA') : null,
            twin: investTo ? ['to_wallet', investTo] : null,
          };
        } else if (otherBank) {
          const p = parseBankEmail(otherBank, subject, body);
          if (!p || typeof p === 'string') {
            skip(p || `${otherBank}, bukan email transaksi`);
            continue;
          }
          const own = walletNamed(otherBank); // a wallet called "Mandiri", "BRI", …, if there is one
          const investTo = p.type === 'expense' ? investWalletFor(p.counterparty) : null;
          const withdrawTo = p.kind === 'withdraw' ? cashWallet() : null;
          tx = {
            type: investTo || withdrawTo ? 'transfer' : p.type,
            amount: p.amount,
            description: p.description,
            source: otherBank,
            phrase: p.kind,
            wallets:
              p.type === 'income'
                ? { wallet: own, label: otherBank }
                : investTo
                  ? { from: own, to: investTo, fromLabel: otherBank, toLabel: p.counterparty }
                  : withdrawTo
                    ? { from: own, to: withdrawTo, fromLabel: otherBank, toLabel: null }
                    : p.type === 'transfer'
                      ? { from: own, to: walletNamed(p.toLabel) || walletForPocket(p.toLabel), fromLabel: otherBank, toLabel: p.toLabel }
                      : { wallet: own, label: otherBank },
            category: p.type === 'expense' && !investTo && !withdrawTo ? categorize(p.description, p.counterparty, otherBank) : null,
            twin: investTo ? ['to_wallet', investTo] : null,
          };
        } else if (isPintu) {
          // Rupiah moving in or out of the Pintu account: always a move between your own wallets.
          const p = parsePintu(subject, text);
          if (!p) {
            skip('Pintu, bukan email transaksi');
            continue;
          }
          const wallet = pintuWallet();
          const nominal = `IDR ${idrPlain.format(p.amount)}`; // keeps two different withdrawals apart
          tx = {
            type: 'transfer',
            amount: p.amount,
            description: p.kind === 'withdraw' ? `Tarik ${nominal} dari Pintu` : `Top up ${nominal} ke Pintu`,
            source: 'Pintu',
            phrase: p.kind === 'withdraw' ? 'successfully sent' : 'received',
            wallets:
              p.kind === 'withdraw'
                ? { from: wallet, to: null, fromLabel: 'Pintu', toLabel: 'Bank' }
                : { from: null, to: wallet, fromLabel: 'Bank', toLabel: 'Pintu' },
            category: null,
          };
        } else {
          let rule = isJago ? jagoRule(subject, body) : matchRule(text);
          if (!rule) {
            // Jago account notices (OTP, e-mail changed, new contact…) carry no amount: not transactions.
            // A Jago email *with* an amount but an unknown kind is reported by subject so a rule can be added.
            if (isJago) skip(extractAmount(text, 0) ? `Jago, jenis belum dikenal: "${subject.slice(0, 60)}"` : 'Jago, bukan email transaksi');
            else skip('bukan frasa transaksi resmi');
            continue;
          }
          // Cash withdrawal: money moves to the cash wallet if there is one, otherwise it counts as spent.
          let withdrawTo = null;
          if (rule.type === 'withdraw') {
            withdrawTo = cashWallet();
            rule = { ...rule, type: withdrawTo ? 'transfer' : 'expense' };
          }
          const amount = extractAmount(text, rule.index);
          if (!amount) {
            skip('nominal tidak ditemukan');
            continue;
          }
          const source = detectSource(from, text);
          const payee = isJago ? jagoPayee(body) : null;
          const merchant = payee?.name || merchantOf(text);
          const investTo = rule.type === 'expense' ? investWalletFor(merchant) : null;
          const paidFrom = resolveWallets('expense', text).wallet;
          // Jago transfer to an account in your own name at another bank ("To BUDI SANTOSO BCA • 1234…"): a move into
          // that bank's wallet, not spending.
          const ownTo =
            isJago && rule.type === 'expense' && !investTo && payee?.bank && sameName(payee.name, holderOf(body))
              ? walletForPocket(payee.bank)
              : null;
          const ownTransfer = Boolean(ownTo && ownTo !== paidFrom);
          const description = isJago ? jagoDescription(subject, payee, holderOf(body)) : subject;
          tx = {
            type: investTo || ownTransfer ? 'transfer' : rule.type,
            amount,
            description,
            source,
            phrase: rule.phrase,
            wallets: withdrawTo
              ? { from: paidFrom, to: withdrawTo, fromLabel: null, toLabel: null }
              : investTo
                ? { from: paidFrom, to: investTo, fromLabel: null, toLabel: merchant }
                : ownTransfer
                  ? { from: paidFrom, to: ownTo, fromLabel: null, toLabel: payee.bank }
                  : resolveWallets(rule.type, text),
            category: rule.type === 'expense' && !investTo && !ownTransfer ? categorize(description, merchant, source) : null,
            twin: investTo ? ['to_wallet', investTo] : null,
          };
        }

        // The same notification sent twice within minutes: count it once (checked before any merging below).
        if (nearDuplicate.get(tx.source, tx.type, tx.description, date)) {
          logDuplicate.run(messageId, tx.description, tx.source, tx.type, tx.amount, date, 0);
          skip('email kembar (dikirim dua kali)');
          continue;
        }

        // A fund purchase / redemption announced by both the bank and Bibit (or typed in by hand): counted once.
        if (tx.twin && fundTwin(tx.twin[0], tx.twin[1], tx.amount, day, tx.source)) {
          logDuplicate.run(messageId, tx.description, tx.source, tx.type, tx.amount, date, 0);
          skip('investasi udah tercatat');
          continue;
        }

        // One own-account move, two emails: keep a single transfer (minus any admin fee).
        if (tx.type === 'transfer') {
          // The receiving bank's "money in" came first: fold it into this transfer (and learn the destination).
          const twin = incomeTwin(tx.amount, day, tx.wallets.to || null, tx.source);
          if (twin) {
            if (!tx.wallets.to) tx.wallets = { ...tx.wallets, to: twin.wallet };
            fee = tx.amount - twin.amount; // e.g. Pintu sent 64.955, Jago received 60.455 -> fee 4.500
            if (fee > 0) tx.amount = twin.amount;
            deleteLedgerRow(twin);
            db.prepare("UPDATE gmail_sync_log SET target = 'digabung ke transfer' WHERE message_id = ?").run(twin.message_id);
          }
          // The sending bank logged it as spending first (e.g. Jago "You have made a transfer" into Pintu).
          if (!tx.wallets.from) {
            const spent = expenseTwin(tx.amount, day, tx.source);
            if (spent) {
              tx.wallets = { ...tx.wallets, from: spent.wallet };
              deleteLedgerRow(spent);
              db.prepare("UPDATE gmail_sync_log SET target = 'digabung ke transfer' WHERE message_id = ?").run(spent.message_id);
            }
          }
        } else if (tx.type === 'income') {
          // The sender's transfer is already recorded: this is just its receiving side (maybe minus a fee).
          const twin = transferTwin(tx.amount, day, tx.wallets.wallet, tx.source);
          if (twin) {
            const updated = { ...twin, amount: tx.amount, to_wallet: twin.to_wallet || tx.wallets.wallet };
            walletEffect(twin, -1); // no-op when a side was unknown or the row was not applied
            db.prepare('UPDATE transactions SET amount = ?, to_wallet = ? WHERE id = ?').run(updated.amount, updated.to_wallet, twin.id);
            walletEffect(updated, 1);
            recordFee(twin.amount - tx.amount, twin.wallet, date, twin.description, twin.source);
            logDuplicate.run(messageId, tx.description, tx.source, tx.type, tx.amount, date, 0);
            skip('uang masuk dari transfer yang udah tercatat');
            continue;
          }
        }

        // Forwarded copy: a "Fwd:" subject, or a bank notification that did not come from the bank itself.
        const forwarded =
          /^\s*(fwd?|fw|tr)\s*:/i.test(msg.envelope?.subject || '') ||
          (isJago && !JAGO_SENDER_RE.test(from)) ||
          (isBca && !BCA_SENDER_RE.test(from))
            ? 1
            : 0;
        if (sameTransaction.get(tx.type, tx.amount, tx.description, day, forwarded)) {
          // Logged (as reverted) so this copy is not re-checked on every sync.
          logDuplicate.run(messageId, tx.description, tx.source, tx.type, tx.amount, date, forwarded);
          skip('duplikat (email yang sama sudah tercatat)');
          continue;
        }

        const target = applyTransaction({
          messageId,
          subject: tx.description,
          source: tx.source,
          type: tx.type,
          amount: tx.amount,
          wallets: tx.wallets,
          date,
          category: tx.category,
          forwarded,
        });
        recordFee(fee, tx.wallets.from, date, tx.description, tx.source);
        details.push({
          message_id: messageId,
          subject: tx.description,
          source: tx.source,
          type: tx.type.toUpperCase(),
          amount: tx.amount,
          target,
          phrase: tx.phrase,
          mailbox,
          date,
        });
      }
    } finally {
      lock.release();
    }
  }

  // When the mailbox was last checked, even if nothing new came in (shown as "terakhir …" in the header).
  const checkedAt = new Date().toISOString();
  setSetting('last_sync_at', checkedAt);

  return {
    success: true,
    count: details.length,
    skipped,
    details,
    checkedAt,
    // Fresh balances so the UI can update wallet cards without refetching everything.
    wallets: listWallets(),
  };
}

// ---------- Crypto prices ----------
// Live IDR prices for crypto wallets. CoinGecko first (has 24h change), Indodax (IDR market) as fallback.
// Only public price endpoints are called; no wallet data leaves this machine.
const CRYPTO_ASSETS = {
  bitcoin: { symbol: 'BTC', name: 'Bitcoin', indodax: 'btcidr' },
  ethereum: { symbol: 'ETH', name: 'Ethereum', indodax: 'ethidr' },
  solana: { symbol: 'SOL', name: 'Solana', indodax: 'solidr' },
  binancecoin: { symbol: 'BNB', name: 'BNB', indodax: 'bnbidr' },
  ripple: { symbol: 'XRP', name: 'XRP', indodax: 'xrpidr' },
  dogecoin: { symbol: 'DOGE', name: 'Dogecoin', indodax: 'dogeidr' },
  tether: { symbol: 'USDT', name: 'Tether', indodax: 'usdtidr' },
};
const PRICE_REFRESH_MS = 5 * 60 * 1000;

async function fetchJson(url, timeoutMs = 6000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

// { bitcoin: { price, change, source } } for the requested ids; ids no source could price are left out.
async function fetchCryptoPrices(ids) {
  const out = {};
  try {
    const q = new URLSearchParams({ ids: ids.join(','), vs_currencies: 'idr', include_24hr_change: 'true' });
    const data = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?${q}`);
    for (const id of ids) {
      if (data[id]?.idr) out[id] = { price: data[id].idr, change: data[id].idr_24h_change ?? null, source: 'CoinGecko' };
    }
  } catch (e) {
    console.warn('CoinGecko price fetch failed:', e.message);
  }
  for (const id of ids.filter((i) => !out[i] && CRYPTO_ASSETS[i]?.indodax)) {
    try {
      const { ticker } = await fetchJson(`https://indodax.com/api/ticker/${CRYPTO_ASSETS[id].indodax}`);
      if (Number(ticker?.last) > 0) out[id] = { price: Number(ticker.last), change: null, source: 'Indodax' };
    } catch (e) {
      console.warn(`Indodax price fetch failed for ${id}:`, e.message);
    }
  }
  return out;
}

// ---------- Mutual fund NAV (reksa dana) ----------
// Wallet asset "fund:<Pasardana id>": balance = units x NAV (NAB per unit), from Pasardana's public fund data.
// NAV is published once per trading day, so price_at holds the NAV date rather than the fetch time.
const FUND_PREFIX = 'fund:';
const FUND_RE = /^fund:\d+$/;
const isFundAsset = (asset) => FUND_RE.test(String(asset || ''));
const PASARDANA = 'https://pasardana.id/api/FundSearchResult';
const FUND_TYPES = { 0: 'Campuran', 1: 'Saham', 2: 'Pendapatan Tetap', 3: 'Pasar Uang', 4: 'Terproteksi' };

// Pasardana dates are WIB wall-clock without a zone ("2026-09-28T00:00:00").
const wibIso = (s) => (s ? new Date(`${s.slice(0, 19)}+07:00`).toISOString() : null);

const toFund = (f) => ({
  id: `${FUND_PREFIX}${f.Id}`,
  name: f.Name,
  manager: f.InvestmentManagerName,
  type: FUND_TYPES[f.Type] || 'Lainnya',
  sharia: Boolean(f.Sharia),
  nav: f.NetAssetValue,
  navDate: wibIso(f.LastUpdate),
  daily: f.DailyReturn,
  yearly: f.YearlyReturn,
});

async function fetchFund(asset) {
  const f = await fetchJson(`${PASARDANA}/Get?id=${Number(String(asset).slice(FUND_PREFIX.length))}`, 10000);
  return f?.Id && f.NetAssetValue > 0 ? toFund(f) : null;
}

// Every fund, for the search box. About 6.5 MB, so it is cached for 12 hours.
let fundCache = { at: 0, list: [] };
async function fundList() {
  if (fundCache.list.length && Date.now() - fundCache.at < 12 * 3600 * 1000) return fundCache.list;
  const data = await fetchJson(`${PASARDANA}/GetAll?pageBegin=1&pageLength=5000&sortField=Name&sortOrder=ASC`, 45000);
  fundCache = { at: Date.now(), list: data.filter((f) => f.NetAssetValue > 0).map(toFund) };
  return fundCache.list;
}

// Prices for any mix of crypto ids and fund assets: { asset: { price, change (% per day), at, source } }.
async function fetchAssetPrices(assets) {
  const out = {};
  const coins = assets.filter((a) => !isFundAsset(a));
  if (coins.length) Object.assign(out, await fetchCryptoPrices(coins));
  for (const a of assets.filter(isFundAsset)) {
    try {
      const f = await fetchFund(a);
      if (f) out[a] = { price: f.nav, change: f.daily != null ? f.daily * 100 : null, at: f.navDate, source: 'Pasardana', name: f.name };
    } catch (e) {
      console.warn(`Pasardana NAV fetch failed for ${a}:`, e.message);
    }
  }
  return out;
}

// Revalues every live-priced wallet (crypto and funds). Offline or rate-limited? Balances keep their last value.
async function refreshPricedWallets() {
  const wallets = db.prepare('SELECT id, asset, units FROM wallets WHERE asset IS NOT NULL').all();
  if (!wallets.length) return { updated: 0 };
  const prices = await fetchAssetPrices([...new Set(wallets.map((w) => w.asset))]);
  const update = db.prepare('UPDATE wallets SET balance = ?, price = ?, price_change = ?, price_at = ? WHERE id = ?');
  let updated = 0;
  db.transaction(() => {
    for (const w of wallets) {
      const p = prices[w.asset];
      if (!p) continue;
      update.run(Math.round((w.units || 0) * p.price), p.price, p.change, p.at || new Date().toISOString(), w.id);
      updated++;
    }
  })();
  return { updated, prices };
}

refreshPricedWallets().catch(() => {});
setInterval(() => refreshPricedWallets().catch(() => {}), PRICE_REFRESH_MS).unref();

// ---------- Daily backup ----------
// One snapshot per day (finance-YYYY-MM-DD.db), newest BACKUP_KEEP kept. BACKUP_DIR can point at a synced folder
// (e.g. Google Drive) so a copy survives losing this disk. Checked hourly because the app lives in the tray for days.
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || 'backups');
const BACKUP_KEEP = 14;

function backupDaily() {
  const day = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); // WIB date
  const file = path.join(BACKUP_DIR, `finance-${day}.db`);
  if (fs.existsSync(file)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^finance-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort()
    .slice(0, -BACKUP_KEEP);
  for (const f of old) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

const safeBackup = () => {
  try {
    backupDaily();
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
};
safeBackup();
setInterval(safeBackup, 3600e3).unref();

// ---------- API ----------
const app = express();
app.use(express.json());

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Recording streak: consecutive WIB days with at least one ledger row. It ends today, or yesterday while today has
// nothing yet, so the day is not counted as missed before it is over. `best` is the longest run ever.
function recordingStreak() {
  const today = wibDate();
  const days = db
    .prepare('SELECT DISTINCT date FROM transactions WHERE date <= ? ORDER BY date')
    .all(today)
    .map((r) => r.date);
  const has = new Set(days);
  let current = 0;
  for (let d = has.has(today) ? today : shiftDay(today, -1); has.has(d); d = shiftDay(d, -1)) current++;
  let best = 0;
  let run = 0;
  days.forEach((d, i) => {
    run = i > 0 && shiftDay(days[i - 1], 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return { current, best, today: has.has(today) };
}

app.get('/api/dashboard', (req, res) => {
  const wallets = listWallets();
  const expenses = db.prepare('SELECT * FROM flexible_expenses ORDER BY id').all();
  // Tracked milestones: progress = total spent in their category since the start date (e.g. payments to Ibu).
  const trackedSum = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
     WHERE type = 'expense' AND lower(trim(category)) = lower(trim(?)) AND date >= ?`
  );
  const milestones = db
    .prepare('SELECT * FROM milestones ORDER BY deadline')
    .all()
    .map((m) => (m.track_category ? { ...m, current_amount: trackedSum.get(m.track_category, m.track_since || '0000-01-01').s } : m));
  // Last successful mailbox check; before that setting existed, fall back to the newest synced email.
  const lastSync =
    getSetting('last_sync_at', null) ||
    db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', MAX(synced_at)) AS at FROM gmail_sync_log").get().at;
  res.json({
    wallets,
    expenses,
    milestones,
    planItems: listPlanItems(),
    planStart: planStart(),
    actual: actualMonth(),
    mainWallet: mainWallet(),
    sync: { start: gmailConfig().start, lastSync, configured: gmailConfigured(gmailConfig()) },
    recurring: recurringStatus(),
    ledgerStart: db.prepare('SELECT MIN(date) d FROM transactions').get().d,
    streak: recordingStreak(),
  });
});

// ---------- Recurring ----------
const recurringBody = (body, current = {}) => {
  const v = { ...current };
  if (body.name !== undefined) v.name = String(body.name).trim();
  if (body.type !== undefined) v.type = String(body.type);
  if (body.amount !== undefined) v.amount = toNumber(body.amount);
  if (body.wallet !== undefined) v.wallet = body.wallet || null;
  if (body.category !== undefined) v.category = String(body.category || '').trim() || null;
  if (body.day !== undefined) v.day = Math.trunc(toNumber(body.day) ?? 0);
  if (!v.name) return { error: 'Namanya diisi dulu, ya' };
  if (!PLAN_TYPES.includes(v.type)) return { error: 'Tipe harus pemasukan atau pengeluaran' };
  if (!v.amount || v.amount <= 0) return { error: 'Nominal harus lebih dari 0' };
  if (!walletExists(v.wallet)) return { error: 'Pilih wallet yang valid' };
  if (!(v.day >= 1 && v.day <= 31)) return { error: 'Tanggal harus 1 sampai 31' };
  return { value: v };
};

app.post('/api/recurring', (req, res) => {
  const { value: v, error } = recurringBody(req.body);
  if (error) return res.status(400).json({ error });
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO recurring (name, type, amount, wallet, category, day, start_period) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(v.name, v.type, v.amount, v.wallet, v.category, v.day, wibDate().slice(0, 7));
  res.status(201).json(db.prepare('SELECT * FROM recurring WHERE id = ?').get(lastInsertRowid));
});

app.put('/api/recurring/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM recurring WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'jadwal nggak ketemu' });
  const { value: v, error } = recurringBody(req.body, row);
  if (error) return res.status(400).json({ error });
  db.prepare('UPDATE recurring SET name = ?, type = ?, amount = ?, wallet = ?, category = ?, day = ? WHERE id = ?').run(
    v.name,
    v.type,
    v.amount,
    v.wallet,
    v.category,
    v.day,
    row.id
  );
  res.json(db.prepare('SELECT * FROM recurring WHERE id = ?').get(row.id));
});

// Removes the schedule only; transactions it matched or created stay in the ledger.
app.delete('/api/recurring/:id', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM recurring_runs WHERE recurring_id = ?').run(req.params.id);
    db.prepare('DELETE FROM recurring WHERE id = ?').run(req.params.id);
  })();
  res.status(204).end();
});

// Looks up a rule and a still-open period of it for confirm / skip; sends the error response and returns null if not.
const openOccurrence = (req, res) => {
  const rule = db.prepare('SELECT * FROM recurring WHERE id = ?').get(req.params.id);
  const period = String(req.body.period || '');
  let error = null;
  if (!rule) error = [404, 'jadwal nggak ketemu'];
  else if (!/^\d{4}-\d{2}$/.test(period) || period < rule.start_period) error = [400, 'Periode nggak valid'];
  else if (db.prepare('SELECT 1 FROM recurring_runs WHERE recurring_id = ? AND period = ?').get(rule.id, period)) {
    error = [409, 'Bulan ini udah beres'];
  }
  if (error) {
    res.status(error[0]).json({ error: error[1] });
    return null;
  }
  return { rule, period };
};

// "Udah masuk" / "Udah dibayar": records the transaction (amount may differ from the schedule) and settles the month.
app.post('/api/recurring/:id/confirm', (req, res) => {
  const occ = openOccurrence(req, res);
  if (!occ) return;
  const { rule, period } = occ;
  const amount = req.body.amount !== undefined ? toNumber(req.body.amount) : rule.amount;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Nominal harus lebih dari 0' });
  if (!walletExists(rule.wallet)) return res.status(400).json({ error: 'Wallet jadwal ini udah kehapus, ganti dulu ya' });
  const due = dueDate(period, rule.day);
  const date = DATE_RE.test(req.body.date || '') ? req.body.date : due;
  const id = db.transaction(() => {
    const txId = recordTransaction({
      date,
      type: rule.type,
      amount,
      description: rule.name,
      category: rule.category,
      wallet: rule.wallet,
      applied: req.body.affects_balance === false ? 0 : 1,
    });
    db.prepare("INSERT INTO recurring_runs (recurring_id, period, status, transaction_id) VALUES (?, ?, 'done', ?)").run(
      rule.id,
      period,
      txId
    );
    return txId;
  })();
  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
});

app.post('/api/recurring/:id/skip', (req, res) => {
  const occ = openOccurrence(req, res);
  if (!occ) return;
  db.prepare("INSERT INTO recurring_runs (recurring_id, period, status) VALUES (?, ?, 'skipped')").run(occ.rule.id, occ.period);
  res.status(204).end();
});

// Undo "Lewatin" (only skipped months; a settled one is undone by deleting its transaction).
app.delete('/api/recurring/:id/runs/:period', (req, res) => {
  db.prepare("DELETE FROM recurring_runs WHERE recurring_id = ? AND period = ? AND status = 'skipped'").run(
    req.params.id,
    req.params.period
  );
  res.status(204).end();
});

// ---------- Plan items ----------
const PLAN_TYPES = ['income', 'expense'];

app.post('/api/plan-items', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const type = String(req.body.type ?? '');
  const amount = toNumber(req.body.amount);
  if (!name || !PLAN_TYPES.includes(type) || amount === null || amount < 0) {
    return res.status(400).json({ error: 'Nama, tipe (income/expense) dan nominal ≥ 0 wajib diisi' });
  }
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO plan_items (name, type, amount, note, sort_order)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM plan_items))`
    )
    .run(name, type, amount, String(req.body.note || '').trim() || null);
  res.status(201).json(db.prepare('SELECT * FROM plan_items WHERE id = ?').get(lastInsertRowid));
});

// Partial update: any of name, amount, note.
app.put('/api/plan-items/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'plan item not found' });
  const name = req.body.name !== undefined ? String(req.body.name).trim() : row.name;
  const amount = req.body.amount !== undefined ? toNumber(req.body.amount) : row.amount;
  const note = req.body.note !== undefined ? String(req.body.note || '').trim() || null : row.note;
  if (!name || amount === null || amount < 0) return res.status(400).json({ error: 'Nama dan nominal ≥ 0 wajib diisi' });
  db.prepare('UPDATE plan_items SET name = ?, amount = ?, note = ? WHERE id = ?').run(name, amount, note, row.id);
  res.json(db.prepare('SELECT * FROM plan_items WHERE id = ?').get(row.id));
});

app.delete('/api/plan-items/:id', (req, res) => {
  const info = db.prepare('DELETE FROM plan_items WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'plan item not found' });
  res.status(204).end();
});

app.put('/api/settings/plan-start', (req, res) => {
  const date = String(req.body.date || '');
  if (!DATE_ONLY_RE.test(date)) return res.status(400).json({ error: 'Tanggal tidak valid' });
  setSetting('plan_start', date);
  res.json({ planStart: planStart() });
});

// Real income / expense for the current pay period (WIB) from the ledger. Transfers are net zero, so left out.
function actualMonth() {
  const month = currentPeriod();
  const range = [periodStart(month), periodEnd(month)];
  const rows = db
    .prepare(
      `SELECT type, SUM(amount) AS total, COUNT(*) AS n FROM transactions
       WHERE date BETWEEN ? AND ? AND type IN ('income', 'expense') GROUP BY type`
    )
    .all(...range);
  const get = (type) => rows.find((r) => r.type === type) || { total: 0, n: 0 };
  const income = get('income').total;
  const expense = get('expense').total;
  // Spending per category (biggest first); uncategorised rows, e.g. from Gmail, are grouped as null.
  const byCategory = db
    .prepare(
      `SELECT NULLIF(TRIM(category), '') AS category, SUM(amount) AS total, COUNT(*) AS n FROM transactions
       WHERE date BETWEEN ? AND ? AND type = 'expense' GROUP BY 1 ORDER BY total DESC`
    )
    .all(...range);
  return {
    month,
    start: range[0],
    end: range[1],
    income,
    expense,
    net: income - expense,
    count: get('income').n + get('expense').n,
    byCategory,
    // This period and the next, for the "tanggal gajian" setting.
    periods: [periodInfo(month), periodInfo(shiftPeriod(month, 1))],
  };
}

// Moves one period's payday ({ period: '2026-11', date: '2026-10-31' }), or back to the 1st with date null.
app.put('/api/settings/payday', (req, res) => {
  const period = String(req.body.period || '');
  if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'Periode nggak valid' });
  const date = req.body.date ? String(req.body.date) : null;
  const [min, max] = paydayBounds(period);
  if (date && (!DATE_ONLY_RE.test(date) || date < min || date > max)) {
    return res.status(400).json({ error: `Tanggal gajiannya harus antara ${min} dan ${max}` });
  }
  if (!date || date === `${period}-01`) db.prepare('DELETE FROM settings WHERE key = ?').run(paydayKey(period));
  else setSetting(paydayKey(period), date);
  res.json(periodInfo(period));
});

// Monthly recap (default: last period). Budgets are compared at their current amounts (no history is kept).
app.get('/api/recap', (req, res) => {
  const current = currentPeriod();
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : shiftPeriod(current, -1);
  const rangeOf = (m) => [periodStart(m), periodEnd(m)];
  const totals = (m) => {
    const rows = db
      .prepare(
        `SELECT type, SUM(amount) AS total, COUNT(*) AS n FROM transactions
         WHERE date BETWEEN ? AND ? AND type IN ('income', 'expense') GROUP BY type`
      )
      .all(...rangeOf(m));
    const get = (type) => rows.find((r) => r.type === type) || { total: 0, n: 0 };
    // Day-to-day spending: expenses minus the ones settling a schedule (transfer to Ibu, bills), which would
    // otherwise dominate the per-day comparison.
    const daily = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
         WHERE date BETWEEN ? AND ? AND type = 'expense'
           AND id NOT IN (SELECT transaction_id FROM recurring_runs WHERE transaction_id IS NOT NULL)`
      )
      .get(...rangeOf(m)).total;
    return { income: get('income').total, expense: get('expense').total, daily, count: get('income').n + get('expense').n };
  };
  const now = totals(month);
  const prev = totals(shiftPeriod(month, -1));

  const byCategory = db
    .prepare(
      `SELECT NULLIF(TRIM(category), '') AS category, SUM(amount) AS total, COUNT(*) AS n FROM transactions
       WHERE date BETWEEN ? AND ? AND type = 'expense' GROUP BY 1 ORDER BY total DESC`
    )
    .all(...rangeOf(month));
  const spentOf = (name) => byCategory.find((c) => c.category?.toLowerCase() === name.trim().toLowerCase())?.total || 0;
  const budgets = db
    .prepare('SELECT name, amount FROM flexible_expenses ORDER BY id')
    .all()
    .map((b) => ({ ...b, spent: spentOf(b.name) }));
  const biggest = db
    .prepare(
      `SELECT date, amount, description, category FROM transactions
       WHERE date BETWEEN ? AND ? AND type = 'expense' ORDER BY amount DESC LIMIT 1`
    )
    .get(...rangeOf(month));
  // Days counted for the daily average: the whole period, or so far if it is the current one; never before the
  // first recorded day (the ledger starts mid-September), so a partial first period compares fairly.
  const first = db.prepare('SELECT MIN(date) d FROM transactions').get().d;
  const daysIn = (mon) => {
    const [start, end] = rangeOf(mon);
    const from = first && first > start ? first : start;
    const to = mon === current ? wibDate() : end;
    return Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);
  };

  const recurring = db
    .prepare('SELECT * FROM recurring WHERE start_period <= ? ORDER BY day, id')
    .all(month)
    .map((r) => {
      const run = db.prepare('SELECT status FROM recurring_runs WHERE recurring_id = ? AND period = ?').get(r.id, month);
      return { name: r.name, type: r.type, amount: r.amount, status: run?.status || 'pending' };
    });

  const months = [
    ...new Set(
      db
        .prepare('SELECT DISTINCT date FROM transactions ORDER BY date DESC')
        .all()
        .map((r) => periodOf(r.date))
    ),
  ];

  res.json({
    month,
    current: month === current,
    ...now,
    net: now.income - now.expense,
    prev: prev.count ? { month: shiftPeriod(month, -1), ...prev, days: daysIn(shiftPeriod(month, -1)) } : null,
    byCategory,
    budgets,
    biggest: biggest || null,
    days: daysIn(month),
    recurring,
    months,
  });
});

// Save the drag & drop order: { ids: [walletId, ...] } in display order.
// Registered before /api/wallets/:id so "order" is not taken for a wallet id.
app.put('/api/wallets/order', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : null;
  if (!ids?.length) return res.status(400).json({ error: 'ids required' });
  const set = db.prepare('UPDATE wallets SET sort_order = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => set.run(i + 1, id)))();
  res.json(listWallets());
});

// Icon names are lucide-react component names chosen in the UI, e.g. "PiggyBank".
const ICON_RE = /^[A-Z][A-Za-z0-9]{1,40}$/;

// Body may carry `balance`, `icon`, or both. Only a balance change bumps updated_at.
app.put('/api/wallets/:id', (req, res) => {
  const { id } = req.params;
  if (!db.prepare('SELECT 1 FROM wallets WHERE id = ?').get(id)) return res.status(404).json({ error: 'wallet not found' });
  const hasBalance = req.body.balance !== undefined;
  const hasIcon = req.body.icon !== undefined;
  if (!hasBalance && !hasIcon) return res.status(400).json({ error: 'balance or icon required' });

  const balance = hasBalance ? toNumber(req.body.balance) : null;
  if (hasBalance && balance === null) return res.status(400).json({ error: 'balance must be a number' });
  if (hasIcon && req.body.icon !== null && !ICON_RE.test(req.body.icon)) {
    return res.status(400).json({ error: 'invalid icon' });
  }

  db.transaction(() => {
    // On a crypto wallet a typed rupiah value is converted back to a coin amount at the last price.
    if (hasBalance) {
      db.prepare(
        `UPDATE wallets SET balance = ?,
           units = CASE WHEN asset IS NOT NULL AND price > 0 THEN ? / price ELSE units END,
           updated_at = CURRENT_TIMESTAMP,
           reconciled_at = ?
         WHERE id = ?`
      ).run(balance, balance, new Date().toISOString(), id); // typed-in balance = the real one as of now
      // Everything recorded on this wallet so far is inside the typed balance now: deleting one of those rows
      // later must not move the balance again.
      db.prepare('UPDATE transactions SET applied = 0 WHERE applied = 1 AND (wallet = ? OR to_wallet = ?)').run(id, id);
    }
    if (hasIcon) db.prepare('UPDATE wallets SET icon = ? WHERE id = ?').run(req.body.icon, id);
  })();
  res.json(db.prepare('SELECT * FROM wallets WHERE id = ?').get(id));
});

// "Kantong Liburan" -> "kantongLiburan" (suffixed if taken), matching the seeded id style.
function uniqueId(table, base) {
  const words = base.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const slug = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w)).join('') || 'item';
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
  let id = slug;
  for (let n = 2; exists.get(id); n++) id = `${slug}${n}`;
  return id;
}

app.post('/api/wallets', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const category = String(req.body.category ?? '').trim();
  const balance = toNumber(req.body.balance ?? 0);
  if (!name || balance === null) return res.status(400).json({ error: 'name and numeric balance required' });
  const icon = ICON_RE.test(req.body.icon || '') ? req.body.icon : null;
  const id = uniqueId('wallets', name);
  // The starting balance is the real one as of now, so it counts as a balance check: emails for older
  // transactions (synced later) are recorded but must not move this balance again.
  db.prepare(`INSERT INTO wallets (id, name, balance, category, icon, sort_order, reconciled_at)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM wallets), ?)`).run(
    id,
    name,
    balance,
    category,
    icon,
    new Date().toISOString()
  );
  res.status(201).json(db.prepare('SELECT * FROM wallets WHERE id = ?').get(id));
});

app.delete('/api/wallets/:id', (req, res) => {
  const info = db.prepare('DELETE FROM wallets WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'wallet not found' });
  res.status(204).end();
});

app.post('/api/expenses', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const amount = toNumber(req.body.amount);
  if (!name || amount === null) return res.status(400).json({ error: 'name and numeric amount required' });
  const info = db.prepare('INSERT INTO flexible_expenses (name, amount) VALUES (?, ?)').run(name, amount);
  res.status(201).json({ id: info.lastInsertRowid, name, amount });
});

// Edit a monthly budget: { name?, amount? }. A rename carries over to transactions already in that category and to
// milestones tracking it, so spending recorded so far stays attached to the budget.
app.put('/api/expenses/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM flexible_expenses WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'budget not found' });
  const name = req.body.name !== undefined ? String(req.body.name).trim() : row.name;
  const amount = req.body.amount !== undefined ? toNumber(req.body.amount) : row.amount;
  if (!name) return res.status(400).json({ error: 'Nama budget nggak boleh kosong' });
  if (amount === null || amount < 0) return res.status(400).json({ error: 'Nominal budget nggak valid' });
  db.transaction(() => {
    db.prepare('UPDATE flexible_expenses SET name = ?, amount = ? WHERE id = ?').run(name, amount, row.id);
    if (name !== row.name) {
      const same = 'lower(trim(category)) = lower(trim(?))';
      db.prepare(`UPDATE transactions SET category = ? WHERE ${same}`).run(name, row.name);
      db.prepare(`UPDATE milestones SET track_category = ? WHERE lower(trim(track_category)) = lower(trim(?))`).run(name, row.name);
    }
  })();
  res.json(db.prepare('SELECT * FROM flexible_expenses WHERE id = ?').get(row.id));
});

app.delete('/api/expenses/:id', (req, res) => {
  const info = db.prepare('DELETE FROM flexible_expenses WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'expense not found' });
  res.status(204).end();
});

// Partial update: any of current_amount, target_amount, deadline, notes, track_category (null = manual), track_since.
app.put('/api/milestones/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM milestones WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'milestone not found' });
  const b = req.body;
  const current = b.current_amount !== undefined ? toNumber(b.current_amount) : m.current_amount;
  const target = b.target_amount !== undefined ? toNumber(b.target_amount) : m.target_amount;
  if (current === null || current < 0) return res.status(400).json({ error: 'Nominal terkumpul nggak valid' });
  if (target === null || target <= 0) return res.status(400).json({ error: 'Target harus lebih dari 0' });
  const track = b.track_category !== undefined ? String(b.track_category || '').trim() || null : m.track_category;
  const since = b.track_since !== undefined ? (DATE_ONLY_RE.test(b.track_since || '') ? b.track_since : null) : m.track_since;
  const deadline = b.deadline !== undefined ? (DATE_ONLY_RE.test(b.deadline || '') ? b.deadline : null) : m.deadline;
  const notes = b.notes !== undefined ? String(b.notes || '').trim() || null : m.notes;
  db.prepare(
    `UPDATE milestones SET current_amount = ?, target_amount = ?, track_category = ?, track_since = ?, deadline = ?, notes = ?
     WHERE id = ?`
  ).run(current, target, track, track ? since || wibDate() : null, deadline, notes, m.id);
  res.json(db.prepare('SELECT * FROM milestones WHERE id = ?').get(m.id));
});

app.post('/api/milestones', (req, res) => {
  const title = String(req.body.title ?? '').trim();
  const target = toNumber(req.body.target_amount);
  const current = toNumber(req.body.current_amount ?? 0);
  if (!title || !target || target <= 0 || current === null) {
    return res.status(400).json({ error: 'title, positive target_amount and numeric current_amount required' });
  }
  const id = uniqueId('milestones', title);
  db.prepare(
    `INSERT INTO milestones (id, title, target_amount, current_amount, deadline, category, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, title, target, current, req.body.deadline || null, req.body.category || null, req.body.notes || null);
  res.status(201).json(db.prepare('SELECT * FROM milestones WHERE id = ?').get(id));
});

app.delete('/api/milestones/:id', (req, res) => {
  const info = db.prepare('DELETE FROM milestones WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'milestone not found' });
  res.status(204).end();
});

// ---------- Daily transactions (manual + Gmail) ----------
const TX_TYPES = ['income', 'expense', 'transfer'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const walletExists = (id) => Boolean(id && db.prepare('SELECT 1 FROM wallets WHERE id = ?').get(id));

// One day's ledger (default: today in WIB) with totals.
const UNCATEGORIZED_SQL = "type = 'expense' AND (category IS NULL OR trim(category) = '')";

// One day of the ledger, or, when any filter is given (q, type, month, uncategorized=1), matching rows across all days.
// q matches description, category and pocket names; a plain number (dots allowed) also matches the exact amount.
app.get('/api/transactions', (req, res) => {
  const q = String(req.query.q || '').trim();
  const type = TX_TYPES.includes(req.query.type) ? req.query.type : null;
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
  const uncategorized = req.query.uncategorized === '1';
  const filtered = Boolean(q || type || month || uncategorized);
  const date = DATE_RE.test(req.query.date || '') ? req.query.date : wibDate();

  const where = [];
  const params = [];
  if (filtered) {
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const fields = ['description', 'category', 'from_pocket', 'to_pocket'].map((f) => `${f} LIKE ? ESCAPE '\\'`);
      params.push(like, like, like, like);
      const asAmount = /^[\d.]+$/.test(q) ? Number(q.replace(/\./g, '')) : null;
      if (asAmount) {
        fields.push('CAST(amount AS INTEGER) = ?');
        params.push(asAmount);
      }
      where.push(`(${fields.join(' OR ')})`);
    }
    if (type) {
      where.push('type = ?');
      params.push(type);
    }
    if (month) {
      where.push('date BETWEEN ? AND ?');
      params.push(periodStart(month), periodEnd(month));
    }
    if (uncategorized) where.push(UNCATEGORIZED_SQL);
  } else {
    where.push('date = ?');
    params.push(date);
  }

  const rows = db
    .prepare(
      `SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY date DESC, created_at DESC, id DESC${filtered ? ' LIMIT 500' : ''}`
    )
    .all(...params)
    // For transfers not yet linked, say which pocket names already match a wallet (the UI flags the rest).
    .map((r) =>
      r.type === 'transfer' && !(r.wallet && r.to_wallet)
        ? { ...r, from_match: r.wallet || walletForPocket(r.from_pocket), to_match: r.to_wallet || walletForPocket(r.to_pocket) }
        : r
    );
  const sum = (type) => rows.filter((r) => r.type === type).reduce((s, r) => s + r.amount, 0);
  res.json({
    date: filtered ? null : date,
    today: wibDate(),
    period: currentPeriod(),
    filtered,
    rows,
    totals: { income: sum('income'), expense: sum('expense'), transfer: sum('transfer') },
    uncategorized: db.prepare(`SELECT COUNT(*) n FROM transactions WHERE ${UNCATEGORIZED_SQL}`).get().n,
  });
});

app.post('/api/transactions', (req, res) => {
  const type = String(req.body.type || '');
  const amount = toNumber(req.body.amount);
  const wallet = req.body.wallet || null;
  const to_wallet = type === 'transfer' ? req.body.to_wallet || null : null;
  const date = DATE_RE.test(req.body.date || '') ? req.body.date : wibDate();

  if (!TX_TYPES.includes(type)) return res.status(400).json({ error: 'type harus income, expense, atau transfer' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Nominal harus lebih dari 0' });
  if (!walletExists(wallet)) return res.status(400).json({ error: 'Pilih wallet yang valid' });
  if (type === 'transfer' && (!walletExists(to_wallet) || to_wallet === wallet)) {
    return res.status(400).json({ error: 'Wallet tujuan transfer harus beda dan valid' });
  }

  const defaults = { income: 'Pemasukan', expense: 'Pengeluaran', transfer: 'Pindah dana' };
  const id = recordTransaction({
    date,
    type,
    amount,
    description: String(req.body.description || '').trim() || defaults[type],
    category: String(req.body.category || '').trim() || null,
    wallet,
    to_wallet,
    // "Saldo udah bener, cuma catat": keep it in history and monthly totals without moving the balance.
    applied: req.body.affects_balance === false ? 0 : 1,
  });
  res.status(201).json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
});

// Change a transaction's category (and/or description). Balances are not affected.
app.put('/api/transactions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'transaction not found' });
  const category = req.body.category !== undefined ? String(req.body.category || '').trim() || null : row.category;
  const description =
    req.body.description !== undefined ? String(req.body.description || '').trim() || row.description : row.description;
  db.prepare('UPDATE transactions SET category = ?, description = ? WHERE id = ?').run(category, description, row.id);
  res.json(db.prepare('SELECT * FROM transactions WHERE id = ?').get(row.id));
});

// Deleting undoes the balance change (and marks a Gmail row reverted so sync won't bring it back).
app.delete('/api/transactions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'transaction not found' });
  deleteLedgerRow(row);
  res.status(204).end();
});

// Link an unlinked transfer to wallets and apply the balance move.
// Body: { from, to }, each either an existing wallet id or { name, balance } to create that wallet on the spot
// (balance = its value *before* this transfer). A missing side falls back to matching the pocket name from the email.
app.post('/api/transactions/:id/link', (req, res) => {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'transaction not found' });
  if (row.type !== 'transfer' || (row.wallet && row.to_wallet)) {
    return res.status(400).json({ error: 'Transaksi ini sudah terhubung ke wallet' });
  }

  const sides = {};
  for (const [side, pocket, linked] of [
    ['from', row.from_pocket, row.wallet],
    ['to', row.to_pocket, row.to_wallet],
  ]) {
    const v = req.body[side];
    if (v && typeof v === 'object') {
      const name = String(v.name || '').trim();
      const balance = toNumber(v.balance ?? 0);
      if (!name || balance === null || balance < 0) return res.status(400).json({ error: 'Nama & saldo awal wallet baru tidak valid' });
      sides[side] = { create: { name, balance } };
    } else if (v) {
      if (!walletExists(v)) return res.status(400).json({ error: 'Wallet tidak ditemukan' });
      sides[side] = { id: v };
    } else {
      const id = linked || walletForPocket(pocket);
      if (!id) return res.status(400).json({ error: `Pilih wallet untuk "${pocket || side}"` });
      sides[side] = { id };
    }
  }
  if (sides.from.id && sides.from.id === sides.to.id) return res.status(400).json({ error: 'Wallet asal dan tujuan harus beda' });

  const createWallet = ({ name, balance }) => {
    const id = uniqueId('wallets', name);
    db.prepare(`INSERT INTO wallets (id, name, balance, category, icon, sort_order)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM wallets))`).run(
      id,
      name,
      balance,
      row.source && row.source !== 'manual' ? `${row.source} Pocket` : 'Pocket',
      'PiggyBank'
    );
    return id;
  };

  const result = db.transaction(() => {
    const from = sides.from.id || createWallet(sides.from.create);
    const to = sides.to.id || createWallet(sides.to.create);
    // A wallet whose real balance was typed in after this day already includes the move.
    const endOfDay = new Date(`${row.date}T23:59:59+07:00`).toISOString();
    const applied = row.applied === 0 || reconciledAfter([from, to], endOfDay) ? 0 : 1;
    db.prepare('UPDATE transactions SET wallet = ?, to_wallet = ?, applied = ? WHERE id = ?').run(from, to, applied, row.id);
    walletEffect({ ...row, wallet: from, to_wallet: to, applied }, 1);
    if (row.message_id) db.prepare('UPDATE gmail_sync_log SET target = ? WHERE message_id = ?').run(`${from} → ${to}`, row.message_id);
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(row.id);
  })();
  res.json(result);
});

app.get('/api/sync-log', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  const where = req.query.active === '1' ? 'WHERE reverted = 0' : '';
  const rows = db
    .prepare(`SELECT * FROM gmail_sync_log ${where} ORDER BY COALESCE(email_date, synced_at) DESC LIMIT ?`)
    .all(limit)
    .map((r) => ({ ...r, type: String(r.type).toUpperCase() }));
  res.json(rows);
});

// Undo one synced email (wrongly parsed, duplicate, etc.). It stays logged so it is never re-applied.
app.post('/api/sync-log/revert', (req, res) => {
  const row = db.prepare('SELECT * FROM gmail_sync_log WHERE message_id = ?').get(String(req.body.message_id ?? ''));
  if (!row) return res.status(404).json({ error: 'log entry not found' });
  if (row.reverted) return res.status(409).json({ error: 'entry already reverted' });
  revertTransaction(row);
  res.json({ success: true, wallets: listWallets() });
});

const GMAIL_LOGIN_FAILED = 'Login Gmail gagal. Cek email & App Password-nya (harus App Password, bukan password Gmail biasa).';

app.post('/api/sync-gmail', async (req, res) => {
  try {
    res.json(await syncGmailTransactions());
  } catch (e) {
    const message = e.authenticationFailed ? GMAIL_LOGIN_FAILED : e.message;
    res.status(e.status || 500).json({ success: false, error: message, code: e.code || null });
  }
});

// ---------- Pengaturan Gmail ----------
// The App Password never leaves the server; the UI only learns whether one is saved.
const gmailSettings = () => {
  const c = gmailConfig();
  return {
    user: c.user,
    hasPassword: Boolean(c.pass),
    start: c.start,
    mainWallet: mainWalletSetting(),
    guessedMainWallet: mainWallet(),
    configured: gmailConfigured(c),
    fromEnv: !getSetting('gmail_user', null) && Boolean(process.env.GMAIL_USER),
  };
};

// { user, pass, start, mainWallet }: a blank pass keeps the saved one. { disconnect: true } forgets the login.
function readGmailBody(body) {
  const current = gmailConfig();
  const user = body.user !== undefined ? String(body.user).trim() : current.user;
  const pass = body.pass ? String(body.pass).replace(/\s+/g, '') : current.pass;
  const start = body.start !== undefined ? String(body.start) : current.start;
  if (user && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user)) return { error: 'Format email-nya belum bener' };
  if (pass && !/^[a-z]{16}$/i.test(pass)) return { error: 'App Password Gmail itu 16 huruf (spasi boleh)' };
  if (!DATE_ONLY_RE.test(start)) return { error: 'Tanggal mulai baca email nggak valid' };
  return { value: { user, pass, start } };
}

app.get('/api/settings/gmail', (req, res) => res.json(gmailSettings()));

app.put('/api/settings/gmail', (req, res) => {
  if (req.body.disconnect) {
    db.prepare("DELETE FROM settings WHERE key IN ('gmail_user', 'gmail_app_pass')").run();
    return res.json(gmailSettings());
  }
  const { value, error } = readGmailBody(req.body);
  if (error) return res.status(400).json({ error });
  if (req.body.mainWallet !== undefined && req.body.mainWallet && !walletExists(req.body.mainWallet)) {
    return res.status(400).json({ error: 'Wallet utamanya nggak ketemu' });
  }
  db.transaction(() => {
    setSetting('gmail_user', value.user);
    setSetting('gmail_app_pass', value.pass);
    setSetting('sync_start', value.start);
    if (req.body.mainWallet !== undefined) {
      if (req.body.mainWallet) setSetting('main_wallet', req.body.mainWallet);
      else db.prepare("DELETE FROM settings WHERE key = 'main_wallet'").run();
    }
  })();
  res.json(gmailSettings());
});

// Logs in with the given (or saved) email + App Password and logs out again; nothing is read.
app.post('/api/settings/gmail/test', async (req, res) => {
  const { value, error } = readGmailBody(req.body);
  if (error) return res.status(400).json({ error });
  if (!gmailConfigured(value)) return res.status(400).json({ error: 'Isi email sama App Password-nya dulu' });
  const client = gmailClient(value);
  try {
    await client.connect();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.authenticationFailed ? GMAIL_LOGIN_FAILED : `Nggak bisa nyambung ke Gmail: ${e.message}` });
  } finally {
    await client.logout().catch(() => {});
  }
});

// Supported coins with their current IDR price (for the setup form).
app.get('/api/crypto/assets', async (req, res) => {
  const prices = await fetchCryptoPrices(Object.keys(CRYPTO_ASSETS));
  res.json(Object.entries(CRYPTO_ASSETS).map(([id, a]) => ({ id, symbol: a.symbol, name: a.name, ...prices[id] })));
});

app.post('/api/crypto/refresh', async (req, res) => {
  const result = await refreshPricedWallets();
  res.json({ ...result, wallets: listWallets() });
});

// Mutual fund search for the setup form: ?q=majoris pasar uang (every word must match), or ?id=fund:3519.
app.get('/api/funds/search', async (req, res) => {
  try {
    if (req.query.id) {
      const f = isFundAsset(req.query.id) ? await fetchFund(req.query.id) : null;
      return res.json(f ? [f] : []);
    }
    const words = String(req.query.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return res.json([]);
    const hits = (await fundList()).filter((f) => words.every((w) => f.name.toLowerCase().includes(w)));
    // Money market first (what "RDPU" means), then by name.
    hits.sort((a, b) => (a.type === 'Pasar Uang' ? 0 : 1) - (b.type === 'Pasar Uang' ? 0 : 1) || a.name.localeCompare(b.name));
    res.json(hits.slice(0, 20));
  } catch (e) {
    res.status(502).json({ error: 'Data reksa dana lagi nggak bisa diambil. Cek koneksi internet, ya?' });
  }
});

// Turn a wallet into a live crypto wallet: { asset, units } (exact coin amount) or { asset, balance } (rupiah value now).
// { asset: null } turns it back into a normal wallet and keeps the last rupiah value.
app.put('/api/wallets/:id/crypto', async (req, res) => {
  const { id } = req.params;
  if (!db.prepare('SELECT 1 FROM wallets WHERE id = ?').get(id)) return res.status(404).json({ error: 'wallet not found' });

  if (req.body.asset === null) {
    db.prepare('UPDATE wallets SET asset = NULL, units = NULL, price = NULL, price_change = NULL, price_at = NULL WHERE id = ?').run(id);
    return res.json(db.prepare('SELECT * FROM wallets WHERE id = ?').get(id));
  }

  // A CoinGecko id from CRYPTO_ASSETS, or "fund:<Pasardana id>" for a mutual fund.
  const asset = String(req.body.asset || '');
  if (!CRYPTO_ASSETS[asset] && !isFundAsset(asset)) return res.status(400).json({ error: 'Aset tidak didukung' });
  const units = req.body.units != null ? toNumber(req.body.units) : null;
  const balance = req.body.balance != null ? toNumber(req.body.balance) : null;
  if ((units === null || units < 0) && (balance === null || balance < 0)) {
    return res.status(400).json({ error: 'Isi jumlah unit/koin atau nilai Rupiah' });
  }

  const p = (await fetchAssetPrices([asset]))[asset];
  if (!p) return res.status(502).json({ error: 'Harga / NAB nggak bisa diambil. Cek koneksi internet, ya?' });
  const amount = units !== null && units >= 0 ? units : balance / p.price;

  db.prepare(
    `UPDATE wallets SET asset = ?, units = ?, balance = ?, price = ?, price_change = ?,
       price_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(asset, amount, Math.round(amount * p.price), p.price, p.change, p.at || new Date().toISOString(), id);
  res.json(db.prepare('SELECT * FROM wallets WHERE id = ?').get(id));
});

// Built dashboard (npm run build), served from the same origin as the API. Used by the desktop app;
// in development Vite serves the UI instead and proxies /api here.
const DIST = path.resolve(process.env.APP_DIST || 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.listen(PORT, HOST, () => console.log(`API running on http://${HOST}:${PORT}`));
