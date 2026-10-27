import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Every park-owned row carries park_id; all park queries filter by it.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS platform (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS tariffs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  per_sheet INTEGER NOT NULL DEFAULT 0,      -- kopecks per issued waybill
  monthly INTEGER NOT NULL DEFAULT 0,        -- kopecks per calendar month
  trial_days INTEGER NOT NULL DEFAULT 14,
  is_default INTEGER NOT NULL DEFAULT 0,
  personal INTEGER NOT NULL DEFAULT 0,       -- made for a single park
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS parks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  inn TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL DEFAULT 'Europe/Moscow',
  tariff_id INTEGER NOT NULL REFERENCES tariffs(id),
  balance INTEGER NOT NULL DEFAULT 0,
  trial_until TEXT NOT NULL DEFAULT '',
  billed_month TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  block_reason TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  park_id INTEGER REFERENCES parks(id),
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super','owner','dispatcher','medic')),
  pass_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS carriers (
  id INTEGER PRIMARY KEY,
  park_id INTEGER NOT NULL REFERENCES parks(id),
  name TEXT NOT NULL,
  inn TEXT NOT NULL DEFAULT '',
  ogrn TEXT NOT NULL DEFAULT '',
  addr TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  reestr TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cars (
  id INTEGER PRIMARY KEY,
  park_id INTEGER NOT NULL REFERENCES parks(id),
  model TEXT NOT NULL,
  num TEXT NOT NULL,
  reg TEXT NOT NULL,
  garage TEXT NOT NULL DEFAULT '',
  permit TEXT NOT NULL DEFAULT '',
  permit_to TEXT NOT NULL DEFAULT '',
  osago TEXT NOT NULL DEFAULT '',
  osago_to TEXT NOT NULL DEFAULT '',
  diag_to TEXT NOT NULL DEFAULT '',
  sts TEXT NOT NULL DEFAULT '',
  fuel TEXT NOT NULL DEFAULT 'АИ-95',
  odo INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (park_id, num, reg)
);

CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY,
  park_id INTEGER NOT NULL REFERENCES parks(id),
  carrier_id INTEGER REFERENCES carriers(id),
  car_id INTEGER REFERENCES cars(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  lic TEXT NOT NULL,
  lic_from TEXT NOT NULL DEFAULT '',
  lic_to TEXT NOT NULL DEFAULT '',
  cls TEXT NOT NULL DEFAULT 'B',
  snils TEXT NOT NULL DEFAULT '',
  blocked INTEGER NOT NULL DEFAULT 0,
  block_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (park_id, phone)
);
CREATE INDEX IF NOT EXISTS drivers_phone ON drivers(phone);

CREATE TABLE IF NOT EXISTS day_counters (park_id INTEGER NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (park_id, day));

CREATE TABLE IF NOT EXISTS sheets (
  id INTEGER PRIMARY KEY,
  park_id INTEGER NOT NULL REFERENCES parks(id),
  no TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  shift_date TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  driver_id INTEGER NOT NULL REFERENCES drivers(id),
  car_id INTEGER NOT NULL REFERENCES cars(id),
  carrier_id INTEGER NOT NULL REFERENCES carriers(id),
  issued_at TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  odo_out INTEGER,
  snapshot TEXT NOT NULL,
  med_status TEXT CHECK (med_status IN ('ok','refused')),
  med_at TEXT, med_by TEXT, med_entered_by TEXT, med_info TEXT, med_note TEXT,
  tech_status TEXT CHECK (tech_status IN ('ok','refused')),
  tech_at TEXT, tech_by TEXT, tech_note TEXT,
  back_at TEXT, odo_back INTEGER,
  closed_at TEXT, closed_by TEXT,
  cancelled_at TEXT, cancelled_by TEXT, cancel_reason TEXT,
  UNIQUE (park_id, no)
);
CREATE INDEX IF NOT EXISTS sheets_park_day ON sheets(park_id, shift_date);
CREATE INDEX IF NOT EXISTS sheets_driver ON sheets(driver_id, shift_date);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  park_id INTEGER NOT NULL REFERENCES parks(id),
  at TEXT NOT NULL,
  amount INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('topup','sheet','refund','monthly','adjust','service')),
  comment TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL DEFAULT '',
  sheet_id INTEGER
);
CREATE INDEX IF NOT EXISTS ledger_park ON ledger(park_id, at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('driver','user')),
  subject_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  park_id INTEGER,
  at TEXT NOT NULL,
  who TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_park ON audit(park_id, at);

-- Every top-up attempt: online (card, SBP), invoice for a company, or a manual credit.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  park_id INTEGER NOT NULL REFERENCES parks(id),
  method TEXT NOT NULL CHECK (method IN ('card','sbp','invoice','manual')),
  amount INTEGER NOT NULL,                  -- kopecks requested
  paid_amount INTEGER,                      -- kopecks actually received
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','canceled')),
  provider TEXT NOT NULL DEFAULT '',        -- yookassa | demo | bank
  provider_id TEXT,
  confirmation_url TEXT,
  invoice_no TEXT UNIQUE,
  payer TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  paid_at TEXT,
  comment TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS payments_park ON payments(park_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider ON payments(provider, provider_id) WHERE provider_id IS NOT NULL;

-- Incoming bank transfers loaded from a 1C statement; the key makes re-imports harmless.
CREATE TABLE IF NOT EXISTS bank_docs (
  id INTEGER PRIMARY KEY,
  doc_key TEXT NOT NULL UNIQUE,
  doc_date TEXT NOT NULL DEFAULT '',
  doc_no TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  payer TEXT NOT NULL DEFAULT '',
  payer_inn TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('matched','unmatched','ignored')),
  park_id INTEGER REFERENCES parks(id),
  payment_id INTEGER REFERENCES payments(id),
  imported_at TEXT NOT NULL
);
`;

// Electronic waybill (ЭПЛ): every part ("титул") is signed by its own person with their own signature.
const EPL_SCHEMA = `
CREATE TABLE IF NOT EXISTS epl_titles (
  id INTEGER PRIMARY KEY,
  park_id INTEGER NOT NULL REFERENCES parks(id),
  sheet_id INTEGER NOT NULL REFERENCES sheets(id),
  code TEXT NOT NULL CHECK (code IN ('T1','T2','T3','T4','T5')),
  signer_id INTEGER NOT NULL REFERENCES users(id),
  signer_name TEXT NOT NULL,
  sig_type TEXT NOT NULL,
  cert TEXT NOT NULL DEFAULT '',
  signed_at TEXT NOT NULL,
  session_id INTEGER,
  operator_id TEXT,
  UNIQUE (sheet_id, code)
);
CREATE TABLE IF NOT EXISTS sign_sessions (
  id INTEGER PRIMARY KEY,
  park_id INTEGER NOT NULL REFERENCES parks(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  items TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting','confirmed','canceled')),
  operator_id TEXT,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  result TEXT
);
`;

// Columns added after the first release; applied once on start.
const MIGRATIONS = [
  ['parks', 'paid_until', "ALTER TABLE parks ADD COLUMN paid_until TEXT NOT NULL DEFAULT ''"],
  ['parks', 'payer', "ALTER TABLE parks ADD COLUMN payer TEXT NOT NULL DEFAULT '{}'"],
  ['sheets', 'epl', 'ALTER TABLE sheets ADD COLUMN epl INTEGER NOT NULL DEFAULT 0'],
  ['sheets', 'gis_id', 'ALTER TABLE sheets ADD COLUMN gis_id TEXT'],
  ['sheets', 'gis_at', 'ALTER TABLE sheets ADD COLUMN gis_at TEXT'],
  ['users', 'sig_type', "ALTER TABLE users ADD COLUMN sig_type TEXT NOT NULL DEFAULT ''"],
  ['users', 'sig_cert', "ALTER TABLE users ADD COLUMN sig_cert TEXT NOT NULL DEFAULT ''"],
  ['users', 'sig_ready', 'ALTER TABLE users ADD COLUMN sig_ready INTEGER NOT NULL DEFAULT 0'],
  ['users', 'tech_cert', "ALTER TABLE users ADD COLUMN tech_cert TEXT NOT NULL DEFAULT ''"],
  ['users', 'tech_cert_date', "ALTER TABLE users ADD COLUMN tech_cert_date TEXT NOT NULL DEFAULT ''"],
  // staff of the service itself: partner medics and the service's mechanics working for subscribed parks
  ['users', 'service', 'ALTER TABLE users ADD COLUMN service INTEGER NOT NULL DEFAULT 0'],
  ['users', 'svc_org', "ALTER TABLE users ADD COLUMN svc_org TEXT NOT NULL DEFAULT ''"],
  ['users', 'svc_lic', "ALTER TABLE users ADD COLUMN svc_lic TEXT NOT NULL DEFAULT ''"],
  ['users', 'svc_city', "ALTER TABLE users ADD COLUMN svc_city TEXT NOT NULL DEFAULT ''"]
];

/** Older databases have a ledger that does not allow the 'service' kind; rebuild it once. */
function migrateLedger(db) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").get()?.sql || '';
  if (sql.includes("'service'")) return;
  db.exec(`BEGIN;
    CREATE TABLE ledger_new (
      id INTEGER PRIMARY KEY, park_id INTEGER NOT NULL REFERENCES parks(id), at TEXT NOT NULL, amount INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('topup','sheet','refund','monthly','adjust','service')),
      comment TEXT NOT NULL DEFAULT '', by TEXT NOT NULL DEFAULT '', sheet_id INTEGER);
    INSERT INTO ledger_new SELECT id, park_id, at, amount, kind, comment, by, sheet_id FROM ledger;
    DROP TABLE ledger;
    ALTER TABLE ledger_new RENAME TO ledger;
    CREATE INDEX IF NOT EXISTS ledger_park ON ledger(park_id, at);
    COMMIT;`);
}

/** Starting prices, set below the market (ЭПЛ from 33 ₽ a sheet, paper from 990 ₽ a month). Editable by the platform. */
export const DEFAULT_TARIFFS = [
  ['Старт', 1900, 0, 14, 1, 'До 15 машин. Без абонентской платы: только за выписанные листы'],
  ['Парк', 1200, 99000, 14, 0, '15–50 машин. Выгоднее «Старта» от 140 листов в месяц'],
  ['Большой парк', 700, 390000, 14, 0, 'От 50 машин. Выгоднее «Парка» от 580 листов в месяц']
];
/**
 * Services of the platform's own signers, charged per signature from the park balance (kopecks).
 * Market, autumn 2026: remote medical check 38–70 ₽ (pay-per-check ~60 ₽), in-person medical + technical check from 100 ₽.
 */
export const DEFAULT_SERVICES = {
  svcMedOn: '1', svcMedPrice: '4900', svcMedNote: 'Дистанционный предрейсовый медосмотр медработником партнёрской медорганизации. Нужен сертифицированный комплекс в парке или на точке выпуска.',
  svcMechOn: '1', svcMechPrice: '5900', svcMechNote: 'Выпуск на линию и приём машины аттестованным механиком сервиса на вашей стоянке. Только в городах, где есть механики сервиса.'
};

export const DEFAULT_PARK_SETTINGS = {
  route: 'Городские',
  okud: '0345001',
  licCard: 'стандартная',
  medOrg: '',
  medAddr: '',
  medLic: '',
  dispPhone: '',
  warnDays: '14',
  eplMode: 'off',
  svcMed: '0',
  svcMech: '0',
  techStamp: 'Опознавательный фонарь установлен. О режиме труда и отдыха предупреждён. Инструктаж по антитеррору и порядку действий при ЧС пройден. Выдана личная карточка водителя.'
};

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  for (const [table, col, sql] of MIGRATIONS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(sql);
  }
  db.exec(EPL_SCHEMA);
  migrateLedger(db);
  if (!db.prepare('SELECT 1 FROM tariffs LIMIT 1').get()) {
    const t = db.prepare('INSERT INTO tariffs (name, per_sheet, monthly, trial_days, is_default, note) VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of DEFAULT_TARIFFS) t.run(...row);
  }
  const ins = db.prepare('INSERT OR IGNORE INTO platform (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SERVICES)) ins.run(k, v);
  return db;
}

export function parkSettings(park) {
  let s = {};
  try { s = JSON.parse(park.settings || '{}'); } catch { /* keep defaults */ }
  return { ...DEFAULT_PARK_SETTINGS, ...s };
}
