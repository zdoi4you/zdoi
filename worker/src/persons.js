/*
 * Лица, от чието име се подават заявления: Сдружението (по подразбиране) и други, добавени от суперадминистратор.
 * Всяко лице има свои данни (заявител и бланка), регистър (номерация на преписките и Изх. №) и пощенска кутия.
 * Суперадминистраторът определя кои потребители могат да водят преписки от името на кое лице.
 */

import { ROLE_SUPER } from './config.js';
import { fail, line, stamp, oneOf, isEmail, validEik, view } from './util.js';
import { audit, cached, dropCache, setting, setSetting } from './core.js';
import { accessOf, dropUser } from './auth.js';
import { mailboxAddress } from './mailbox.js';

export const REG_BASIS = ['', 'ЕИК по Търговския закон (Търговски регистър)', 'Код по БУЛСТАТ (Закон за регистър БУЛСТАТ)'];
export const DEFAULT_CODE = 'zdoi';
export const CODE_RE = /^[a-z][a-z0-9]{1,9}$/;
const PREFIX_RE = /^[A-ZА-Я0-9]{2,10}$/;

/*
 * Вътрешен идентификатор на лицето за адреса за отговор: случаен, без връзка с кода или наименованието
 * (priemna+k7q2mx-2026-0001@zdoi.eu). Пази се в настройките (ключ ptag:<код>) и не се сменя.
 */
const TAG_RE = /^[a-z][a-z0-9]{5}$/;
function newTagId(taken) {
  const A = 'abcdefghjkmnpqrstuvwxyz', B = A + '23456789';
  let t;
  do {
    const b = crypto.getRandomValues(new Uint8Array(6));
    t = A[b[0] % A.length] + [...b.slice(1)].map(x => B[x % B.length]).join('');
  } while (taken.has(t));
  return t;
}

export const ORG_DEFAULT = {
  name: 'Сдружение „Просвета за демокрация“', brand: 'ЗДОИ4You', regBasis: REG_BASIS[2], eik: '', address: '', oblast: '',
  rep: '', repPosition: 'председател на Управителния съвет', phone: '', email: 'priemna@zdoi.eu', web: 'my.zdoi4you.eu', place: 'София'
};
const PROFILE_KEYS = Object.keys(ORG_DEFAULT);

/* Сдружението: данните от предишния профил (настройка „org“) стават първото лице */
async function seedPerson(app) {
  let o = {};
  try { o = JSON.parse((await setting(app, 'org', '{}')) || '{}'); } catch (_) { o = {}; }
  return Object.assign({}, ORG_DEFAULT, o, { code: DEFAULT_CODE, outPrefix: 'ЗДОИ', mailbox: '', isDefault: 'Да', active: 'Да' });
}

const personView = r => {
  const o = view(r);
  PROFILE_KEYS.forEach(k => { if (o[k] === undefined || o[k] === null) o[k] = ''; });
  return Object.assign(o, { isDefault: r.isDefault === 'Да', active: r.active !== 'Не', tagId: r.tagId || '' });
};

export async function allPersons(app) {
  return cached(app, 'persons', 300, async () => {
    let rows;
    try { rows = await app.store.list('persons'); } catch (e) {
      // списъкът още не е създаден в SharePoint („Обнови структурата на базата“): работи само Сдружението
      console.error('persons: ' + e.message);
      return [personView(await seedPerson(app))];
    }
    if (!rows.some(r => r.isDefault === 'Да')) rows.unshift(await app.store.insert('persons', Object.assign(await seedPerson(app), { by: 'система', at: stamp() })));
    // старите преписки са без код на лице и принадлежат на Сдружението, затова кодът му е винаги 'zdoi'
    for (const r of rows.filter(x => x.isDefault === 'Да' && x.code !== DEFAULT_CODE)) {
      console.error('persons: кодът на лицето по подразбиране е „' + r.code + '“ – поправя се на ' + DEFAULT_CODE);
      await app.store.patch('persons', r._id, { code: DEFAULT_CODE });
      r.code = DEFAULT_CODE;
    }
    const taken = new Set();
    for (const r of rows.sort((a, b) => Number(a._id) - Number(b._id))) {
      let t = await setting(app, 'ptag:' + r.code, '');
      if (!TAG_RE.test(t) || taken.has(t)) { t = newTagId(taken); await setSetting(app, 'ptag:' + r.code, t); }
      taken.add(t);
      r.tagId = t;
    }
    return rows.sort((a, b) => (b.isDefault === 'Да') - (a.isDefault === 'Да') || Number(a._id) - Number(b._id)).map(personView);
  });
}

export const defaultPerson = async app => (await allPersons(app)).find(p => p.isDefault);
/* лицето на преписката; старите преписки без код са на Сдружението */
export async function personOf(app, code) {
  const all = await allPersons(app);
  return all.find(p => p.code === code) || all.find(p => p.isDefault);
}
export const codeOf = r => (r && r.person) || DEFAULT_CODE;

/* бланката на Сдружението (за входящия регистър и общите документи) */
export async function orgProfile(app) {
  const p = await defaultPerson(app);
  const o = {};
  PROFILE_KEYS.forEach(k => { o[k] = p[k] || ''; });
  return o;
}

/* пощенската кутия на лицето: собствена или тази на приемната */
export const boxOf = (app, p) => String((p && p.mailbox) || mailboxAddress(app.env)).toLowerCase();

/* ---------- регистър: номерация по лица ---------- */

/* Сдружението: П-2026-0001 и ЗДОИ-2026-0001; другите: П-<КОД>-2026-0001 и <префикс>-2026-0001 */
export const regNoFor = (p, y, n) => 'П-' + (p.isDefault ? '' : p.code.toUpperCase() + '-') + y + '-' + String(n).padStart(4, '0');
export const outNoFor = (p, y, n) => (p.outPrefix || 'ЗДОИ') + '-' + y + '-' + String(n).padStart(4, '0');
/*
 * Етикет в адреса за отговор: вътрешният идентификатор на лицето + годината и номера на преписката (k7q2mx-2026-0001),
 * за да не се смесват отговорите, когато няколко лица използват една и съща кутия. Кодът на лицето не участва.
 */
export const tagFor = (p, regNo) => {
  const m = /(\d{4})-(\d{4})$/.exec(String(regNo));
  return (p.tagId || 'p') + '-' + (m ? m[1] + '-' + m[2] : String(regNo).replace(/^П-/, '').toLowerCase());
};

/* ---------- достъп ---------- */

/* кодовете на лицата, до които потребителят има достъп */
export async function allowedCodes(app, ctx) {
  const all = await allPersons(app);
  const access = ctx.access !== undefined ? ctx.access : accessOf(ctx);
  if (access === '*') return all.map(p => p.code);
  const list = access || [DEFAULT_CODE];
  return all.filter(p => list.includes(p.code)).map(p => p.code);
}
export async function personsFor(app, ctx) {
  const codes = await allowedCodes(app, ctx);
  return (await allPersons(app)).filter(p => codes.includes(p.code));
}

/* ---------- управление (суперадминистратор) ---------- */

const userAccess = u => (u.role === ROLE_SUPER ? '*' : accessOf(u) || [DEFAULT_CODE]);

export async function personsList(d, ctx, app) {
  const [persons, users] = await Promise.all([allPersons(app), app.store.list('users')]);
  const counts = {};
  (await app.store.list('requests')).forEach(r => { const c = codeOf(r); counts[c] = (counts[c] || 0) + 1; });
  return {
    persons: persons.map(p => Object.assign({}, p, { box: boxOf(app, p), requests: counts[p.code] || 0 })),
    users: users.filter(u => u.active === 'Да').map(u => ({ username: u.username, name: u.name, role: u.role, access: userAccess(u) })),
    regBasis: REG_BASIS, defaultBox: mailboxAddress(app.env)
  };
}

function profileFields(o) {
  const v = {
    name: line(o.name, 250), brand: line(o.brand, 60), regBasis: oneOf(o.regBasis || '', REG_BASIS, 'Регистрация'), eik: line(o.eik, 13),
    address: line(o.address, 400), oblast: line(o.oblast, 80), rep: line(o.rep, 160), repPosition: line(o.repPosition, 160),
    phone: line(o.phone, 40), email: line(o.email, 200).toLowerCase(), web: line(o.web, 120), place: line(o.place, 80)
  };
  if (!v.name) fail('required', 'Посочете наименование.');
  if (v.eik && !validEik(v.eik)) fail('eik', 'Невалиден ЕИК/код по БУЛСТАТ.');
  if (v.email && !isEmail(v.email)) fail('email', 'Невалиден имейл.');
  return v;
}

/* профилът на Сдружението от „Система“ (администратор) */
export async function saveDefaultProfile(app, ctx, o) {
  const p = await defaultPerson(app);
  const v = Object.assign(profileFields(o), { updatedAt: stamp() });
  if (!v.brand) v.brand = 'ЗДОИ4You';
  if (!p._id) fail('setup', 'Обновете структурата на базата („Система“), за да се запази профилът.');
  await app.store.patch('persons', p._id, v);
  await dropCache(app, 'persons');
  await audit(app, ctx.username, 'Промяна на профила на Сдружението', p.code, '');
}

export async function personsSave(d, ctx, app) {
  const all = await allPersons(app);
  const cur = d.code && !d.isNew ? all.find(p => p.code === String(d.code)) : null;
  if (!d.isNew && !cur) fail('notfound', 'Лицето не е намерено.');
  const v = profileFields(d);
  const code = cur ? cur.code : line(d.code, 10).toLowerCase();
  if (!cur) {
    if (!CODE_RE.test(code)) fail('value', 'Кодът е от 2 до 10 малки латински букви и цифри и започва с буква (напр. abc). Използва се в номерата на преписките.');
    if (all.some(p => p.code === code)) fail('duplicate', 'Вече има лице с този код.');
  }
  v.outPrefix = line(d.outPrefix, 10).toUpperCase() || (cur ? cur.outPrefix : code.toUpperCase());
  if (!PREFIX_RE.test(v.outPrefix)) fail('value', 'Префиксът на Изх. № е от 2 до 10 главни букви или цифри (напр. АБВ).');
  if (all.some(p => p.code !== code && p.outPrefix === v.outPrefix)) fail('duplicate', 'Друго лице вече използва този префикс на Изх. №.');
  // префиксът е уникален за лицето, затова по него се разбира дали лицето вече има издадени документи
  if (cur && cur.outPrefix !== v.outPrefix && (await app.store.list('docs')).some(x => String(x.outNo).startsWith(cur.outPrefix + '-'))) {
    fail('value', 'Префиксът не се сменя, след като има издадени документи с него.');
  }
  v.mailbox = line(d.mailbox, 200).toLowerCase();
  if (v.mailbox && !isEmail(v.mailbox)) fail('email', 'Невалиден адрес на пощенската кутия.');
  if (v.mailbox === mailboxAddress(app.env)) v.mailbox = '';
  v.active = d.active === false ? 'Не' : 'Да';
  if (cur && cur.isDefault && v.active !== 'Да') fail('value', 'Сдружението (лицето по подразбиране) не може да бъде спряно.');
  if (!v.brand) v.brand = cur && cur.isDefault ? 'ЗДОИ4You' : '';
  v.updatedAt = stamp();
  if (cur) {
    if (!cur._id) fail('setup', 'Обновете структурата на базата („Система“), за да се запази лицето.');
    await app.store.patch('persons', cur._id, v);
  } else {
    await app.store.insert('persons', Object.assign({ code, isDefault: '', by: ctx.username, at: stamp() }, v));
  }
  await dropCache(app, 'persons');
  await audit(app, ctx.username, cur ? 'Промяна на лице' : 'Ново лице', code, v.name);
  if (Array.isArray(d.users)) await setAccess(app, ctx, code, d.users.map(String));
  return { code };
}

/* кои потребители водят преписки от името на лицето */
async function setAccess(app, ctx, code, usernames) {
  const users = await app.store.list('users');
  const changed = [];
  for (const u of users) {
    if (u.role === ROLE_SUPER) continue; // суперадминистраторът има достъп до всички
    const list = userAccess(u);
    const has = list.includes(code), want = usernames.includes(u.username);
    if (has === want) continue;
    const next = want ? list.concat(code) : list.filter(c => c !== code);
    await app.store.patch('users', u._id, { persons: JSON.stringify(next) });
    await dropUser(app, u.username);
    changed.push((want ? '+' : '−') + u.username);
  }
  if (changed.length) await audit(app, ctx.username, 'Достъп до лице', code, changed.join(', '));
}

/* достъпът на един потребител (от „Потребители“) */
export async function setUserAccess(app, codes) {
  const all = (await allPersons(app)).map(p => p.code);
  const bad = codes.find(c => !all.includes(c));
  if (bad) fail('value', 'Непознато лице: ' + bad);
  return JSON.stringify([...new Set(codes)]);
}
