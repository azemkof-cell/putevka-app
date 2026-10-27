// Fills a database with an example park so you can click through every role.
// Usage: DB_PATH=data/demo.db npm run demo   (then: DB_PATH=data/demo.db npm start)
process.env.TZ = process.env.TZ || 'Europe/Moscow';
process.env.SUPER_PASSWORD = process.env.SUPER_PASSWORD || 'root-demo-pass';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/server.js';
import { DEFAULT_PARK_SETTINGS } from '../src/db.js';
import { dayKey, addDays } from '../src/time.js';

const file = process.env.DB_PATH || 'data/demo.db';
const { db, svc, payments, epd } = createApp({ dbFile: file, log: () => {} });
if (db.prepare('SELECT 1 FROM parks LIMIT 1').get()) { console.log(`В ${file} уже есть данные — пропускаю.`); process.exit(0); }
const h = (s) => bcrypt.hashSync(s, 10);
const today = dayKey('Europe/Moscow');

db.prepare("INSERT INTO platform (key, value) VALUES ('supportPhone', '+7 900 000-00-00'), ('signupOpen', '1'), ('reqName', 'ООО «Путёвка»'), ('reqInn', '7700000001'), ('reqKpp', '770001001'), ('reqAccount', '40702810900000000001'), ('reqBank', 'АО «Пример Банк», г. Москва'), ('reqBic', '044525000'), ('reqCorr', '30101810400000000225'), ('reqAddr', '127000, г. Москва, ул. Примерная, д. 10'), ('reqVat', 'none')").run();

const settings = { ...DEFAULT_PARK_SETTINGS, eplMode: process.env.DEMO_PAPER ? 'off' : 'sandbox', medOrg: 'ООО «Медосмотр Пример»', medAddr: '105000, г. Москва, ул. Лечебная, д. 2', medLic: 'Л041-00000-77/00000000', dispPhone: '+7 900 000-00-00' };
const big = db.prepare("SELECT id FROM tariffs WHERE name = 'Парк'").get().id;
const parkId = db.prepare(`INSERT INTO parks (name, inn, contact, phone, email, city, tz, tariff_id, balance, trial_until, billed_month, paid_until, settings, payer)
  VALUES ('Такси Восток', '7700000000', 'Соколов Андрей Викторович', '79000000000', 'park@example.ru', 'Москва', 'Europe/Moscow', ?, 0, '', ?, '', ?, ?)`)
  .run(big, today.slice(0, 7), JSON.stringify(settings), JSON.stringify({ name: 'ООО «Такси Восток»', inn: '7700000000', kpp: '770001001', addr: '127000, г. Москва, ул. Таксомоторная, д. 5' })).lastInsertRowid;
const c1 = db.prepare("INSERT INTO carriers (park_id, name, inn, ogrn, addr, phone, reestr) VALUES (?, 'ИП Соколов Андрей Викторович', '771234567890', '320774600012345', '127000, г. Москва, ул. Примерная, д. 1, кв. 1', '+7 900 000-00-00', '77-0001')").run(parkId).lastInsertRowid;
const c2 = db.prepare("INSERT INTO carriers (park_id, name, inn, ogrn, addr, phone) VALUES (?, 'ИП Ершов Денис Андреевич', '500000000001', '321500000000001', 'Московская обл., г. Химки, ул. Лесная, д. 3', '+7 900 000-00-02')").run(parkId).lastInsertRowid;

for (const [login, name, role, pass] of [['owner', 'Соколов Андрей Викторович', 'owner', 'owner-demo'], ['disp', 'Смирнова Ольга Николаевна', 'dispatcher', 'disp-demo'], ['medic', 'Орлова Наталья Ивановна', 'medic', 'medic-demo']])
  db.prepare('INSERT INTO users (park_id, login, name, role, pass_hash) VALUES (?, ?, ?, ?, ?)').run(parkId, login, name, role, h(pass));

const soon = addDays(today, 9), later = addDays(today, 200);
const cars = [['Belgee X50', 'Х415КМ', '797', 128440, '14008', '021303-1', later, later, later], ['Kia K5', 'А702ОР', '750', 64912, '14011', '021303-2', soon, later, later],
  ['Skoda Octavia', 'М218ТН', '790', 201337, '14015', '021303-3', later, addDays(today, -3), later], ['Haval Jolion', 'В940ЕУ', '750', 37580, '14019', '021303-4', later, later, later],
  ['Hyundai Solaris', 'Е117ОТ', '799', 88021, '14022', '021303-5', later, later, later]];
const carIds = cars.map((c) => db.prepare('INSERT INTO cars (park_id, model, num, reg, odo, garage, permit, osago, osago_to, diag_to, permit_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(parkId, c[0], c[1], c[2], c[3], c[4], c[5], 'ХХХ 0000000000', c[6], c[7], c[8]).lastInsertRowid);

const drivers = [['Каримов Руслан Ильдарович', '79000000001', c1, 0], ['Ершов Денис Андреевич', '79000000002', c2, 1], ['Мамедов Тимур Рашидович', '79000000003', c1, 2],
  ['Лысенко Павел Сергеевич', '79000000004', c1, 3], ['Гусев Артём Олегович', '79000000005', c1, 4]];
const pin = h('1111');
const dIds = drivers.map(([name, phone, carrier, car], i) => db.prepare(`INSERT INTO drivers (park_id, carrier_id, car_id, name, phone, pin_hash, lic, lic_from, lic_to, snils, blocked, block_reason)
  VALUES (?, ?, ?, ?, ?, ?, ?, '2020-03-02', '2030-03-02', ?, ?, ?)`).run(parkId, carrier, carIds[car], name, phone, pin, `99 ${20 + i} ${100000 + i * 7919}`, `000-000-00${i + 1} 0${i + 1}`,
  i === 3 ? 1 : 0, i === 3 ? 'не сдана выручка за неделю' : '').lastInsertRowid);

// a paid invoice renews the subscription, a second one waits for payment
const park = db.prepare('SELECT * FROM parks WHERE id = ?').get(parkId);
const inv = payments.createInvoice({ park, amount: 1000000, payer: JSON.parse(park.payer), by: 'Соколов Андрей Викторович' });
payments.credit(inv, 1000000, 'root');
payments.createInvoice({ park, amount: 500000, payer: JSON.parse(park.payer), by: 'Соколов Андрей Викторович' });
// Every staff member has their own signature; the dispatcher is also the certified vehicle controller.
db.prepare("UPDATE users SET sig_type = 'goskey', sig_cert = 'GK-7F3A-0012', sig_ready = 1, tech_cert = 'АТ-77-0451', tech_cert_date = '2026-03-12' WHERE login = 'disp'").run();
db.prepare("UPDATE users SET sig_type = 'goskey', sig_cert = 'GK-7F3A-0001', sig_ready = 1 WHERE login = 'owner'").run();
db.prepare("UPDATE users SET sig_type = 'ukep', sig_cert = '01DA4C2E00B1', sig_ready = 1 WHERE login = 'medic'").run();
const medic = db.prepare("SELECT * FROM users WHERE login = 'medic'").get();
const disp = db.prepare("SELECT * FROM users WHERE login = 'disp'").get();
const p = db.prepare('SELECT * FROM parks WHERE id = ?').get(parkId);
const sign = async (user, items) => { epd.confirm(await epd.startSession(user, p, items), user); await epd.settle(p.id); };
// Ершов: closed shift today; Мамедов's car has an expired diagnostic card; Гусев: on the line; Каримов: waiting for the medical check + a planned week.
const a = svc.issue(parkId, dIds[1], today, { odo: 64912, by: 'Ершов Денис Андреевич' });
const b = svc.issue(parkId, dIds[4], today, { odo: 88021, by: disp.name });
const c = svc.issue(parkId, dIds[0], today, { odo: 128440, by: 'Каримов Руслан Ильдарович' });
await sign(disp, [a, b, c].map((sheetId) => ({ code: 'T1', sheetId })));
await sign(medic, [a, b].map((sheetId) => ({ code: 'T2', sheetId, ok: true })));
await sign(disp, [a, b].map((sheetId) => ({ code: 'T34', sheetId, ok: true, odo: null })));
svc.finish(parkId, a, dIds[1], 65180);
await sign(disp, [{ code: 'T5', sheetId: a, odo: 65180 }]);
svc.issueDays(parkId, dIds[0], [1, 2, 3, 4].map((n) => addDays(today, n)), 'Каримов Руслан Ильдарович');
svc.issueDays(parkId, dIds[1], [1, 2].map((n) => addDays(today, n)), disp.name);

// Services: a partner medic and a service mechanic work for «Такси Север», which has no staff of its own.
db.prepare(`INSERT INTO users (park_id, login, name, role, pass_hash, service, svc_org, svc_lic, svc_city, tech_cert, sig_type, sig_cert, sig_ready)
  VALUES (NULL, 'smed', 'Медведева Анна Сергеевна', 'medic', ?, 1, 'ООО «Медпартнёр»', 'Л041-01-77/012345', 'Москва', '', 'ukep', '02AF11C900D2', 1),
         (NULL, 'smech', 'Механиков Олег Петрович', 'dispatcher', ?, 1, 'Путёвка', '', 'Москва', 'АТ-77-0999', 'goskey', 'GK-9B10-0007', 1)`).run(h('smed-demo'), h('smech-demo'));
const north = db.prepare(`INSERT INTO parks (name, inn, contact, phone, email, city, tz, tariff_id, balance, trial_until, billed_month, settings)
  VALUES ('Такси Север', '5000000000', 'Белов Илья Андреевич', '79000000100', 'north@example.ru', 'Москва', 'Europe/Moscow', 1, 300000, '', ?, ?)`)
  .run(today.slice(0, 7), JSON.stringify({ ...DEFAULT_PARK_SETTINGS, eplMode: 'sandbox', svcMed: '1', svcMech: '1', dispPhone: '+7 900 000-01-00' })).lastInsertRowid;
const nc = db.prepare("INSERT INTO carriers (park_id, name, inn, ogrn, addr) VALUES (?, 'ИП Белов Илья Андреевич', '500000000100', '321500000000100', 'г. Мытищи, ул. Северная, д. 7')").run(north).lastInsertRowid;
db.prepare("INSERT INTO users (park_id, login, name, role, pass_hash, sig_type, sig_cert, sig_ready) VALUES (?, 'north', 'Белов Илья Андреевич', 'owner', ?, 'goskey', 'GK-0100', 1)").run(north, h('north-demo'));
const nCars = [['Lada Vesta', 'К321МР', '750', 54120], ['Chery Tiggo 4', 'О555ХА', '790', 23400]].map((c) => db.prepare('INSERT INTO cars (park_id, model, num, reg, odo, osago_to, diag_to) VALUES (?, ?, ?, ?, ?, ?, ?)').run(north, ...c, later, later).lastInsertRowid);
const nDrv = [['Соловьёв Глеб Андреевич', '79000000101'], ['Яковлев Марк Ильич', '79000000102']].map(([n, ph], i) => db.prepare(`INSERT INTO drivers (park_id, carrier_id, car_id, name, phone, pin_hash, lic, lic_to) VALUES (?, ?, ?, ?, ?, ?, ?, '2031-05-01')`).run(north, nc, nCars[i], n, ph, pin, `99 30 20000${i}`).lastInsertRowid);
const northOwner = db.prepare("SELECT * FROM users WHERE login = 'north'").get();
const np = db.prepare('SELECT * FROM parks WHERE id = ?').get(north);
const ns = nDrv.map((d, i) => svc.issue(north, d, today, { odo: [54120, 23400][i], by: northOwner.name }));
epd.confirm(await epd.startSession(northOwner, np, ns.map((sheetId) => ({ code: 'T1', sheetId }))), northOwner);

console.log(`Демо записано в ${file}.
  Платформа:   root / root-demo-pass
  Таксопарк:   owner / owner-demo (владелец), disp / disp-demo (диспетчер), medic / medic-demo (медработник)
  Водители:    +7 900 000-00-01 … 05, пароль 1111 (04 заблокирован)
  Исполнители: smed / smed-demo (медработник партнёра), smech / smech-demo (механик сервиса), парк без своих: north / north-demo`);
