/*
 * Локален вход: потребител + парола, с потребителите в SharePoint (списък „ADM Потребители“).
 *
 * Браузърът изчислява PBKDF2-SHA256 (600 000 итерации) от паролата и никога не я изпраща. Сървърът пази
 * HMAC-SHA256(резултат | сол) с тайния ключ PEPPER на Worker-а, затова хешовете в SharePoint не могат да се
 * проверяват офлайн без ключа. Сесията е в бисквитка HttpOnly; в KV се пази само хешът на ключа ѝ.
 */

import { CFG, ROLE_SUPER, ROLE_VIEW, ROLE_PERMS, PERMS, ADMIN_PERMS, VIEW_PERMS, LEGACY_PERMS, SESSION_CHOICES, isAdminRole, sessionMinOf } from './config.js';
import { fail, str, stamp } from './util.js';
import { sha256, randomToken, randomCode, hmac, sameText } from './crypto.js';
import { audit, mail, throttle, cached, dropCache } from './core.js';

export const USER_RE = /^[a-z0-9._-]{3,40}$/;
export const PREHASH_RE = /^[A-Za-z0-9+/=]{40,64}$/;

export async function serverHash(app, preHash, salt) {
  if (!app.env.PEPPER) fail('setup', 'Системата още не е настроена (липсва PEPPER).');
  return hmac(app.env.PEPPER, preHash + '|' + salt);
}

export async function setPassword(app, preHash) {
  const salt = randomToken().slice(0, 32);
  return { salt, hash: await serverHash(app, preHash, salt) };
}

export async function newInvite(hours) {
  const token = randomToken();
  return { token, hash: await sha256(token), exp: String(Date.now() + hours * 36e5) };
}

export const inviteLink = (app, username, token) => app.cfg.appUrl + '#/activate/' + encodeURIComponent(username) + '/' + token;

/* еднократна връзка за парола; самата парола не се изпраща */
export function accessMail(app, to, username, link, validFor) {
  return mail(app, to, app.cfg.appName + ' – достъп',
    'Потребител: ' + username + '\n\n' +
    'Задайте парола с тази еднократна връзка. Тя важи ' + validFor + ':\n' + link + '\n\n' +
    'Не препращайте това писмо. Ако не го очаквате, не отваряйте връзката и пишете на ' + app.cfg.support + '.');
}

export const findUser = async (app, username) => (await app.store.list('users', { username }))[0] || null;
export const dropUser = (app, username) => dropCache(app, 'usr:' + username);

/*
 * Записаните права: { v: 2, p: [...] } (подробни по операции) или стар списък [...] от преди 2026-11-22.
 * Без запис – правата по подразбиране за ролята.
 */
export function storedPerms(u) {
  if (!u.perms) return null;
  let raw;
  try { raw = JSON.parse(u.perms); } catch (_) { return null; }
  if (raw && raw.v === 2 && Array.isArray(raw.p)) return raw.p.filter(k => PERMS.includes(k));
  if (!Array.isArray(raw)) return null;
  // стар списък: „casesEdit“ се разгръща, регистрите се виждаха от всички, а администраторите имаха всичко
  const list = new Set(['inReg', 'outReg']);
  raw.forEach(k => (LEGACY_PERMS[k] || [k]).forEach(x => list.add(x)));
  if (isAdminRole(u.role)) ADMIN_PERMS.forEach(k => list.add(k));
  return [...list].filter(k => PERMS.includes(k));
}

export function permsOf(u) {
  const out = {};
  if (u.role === ROLE_SUPER) { PERMS.forEach(k => { out[k] = true; }); return out; }
  const list = storedPerms(u) || ROLE_PERMS[u.role] || [];
  list.forEach(k => { out[k] = true; });
  // администраторските права важат само за администратор; наблюдателят само преглежда
  if (!isAdminRole(u.role)) ADMIN_PERMS.forEach(k => delete out[k]);
  if (u.role === ROLE_VIEW) Object.keys(out).forEach(k => { if (!VIEW_PERMS.includes(k)) delete out[k]; });
  return out;
}

/*
 * Достъп до лицата, от чието име се подават заявления: '*' (суперадминистратор – всички),
 * списък с кодове или null – още не е задаван, тогава само лицето по подразбиране (Сдружението).
 */
export function accessOf(u) {
  if (u.role === ROLE_SUPER) return '*';
  if (!u.persons) return null;
  try { const a = JSON.parse(u.persons); return Array.isArray(a) ? a.map(String) : null; } catch (_) { return null; }
}

export function notifyOf(u) {
  let n = {};
  try { n = JSON.parse(u.notify || '{}') || {}; } catch (_) { n = {}; }
  return { assign: n.assign !== false, deadline: n.deadline !== false, mail: n.mail !== false, status: !!n.status, comments: !!n.comments, all: !!n.all };
}

const meInfo = u => ({
  username: u.username, name: u.name, role: u.role, perms: permsOf(u), twofa: u.twofa === 'Да',
  email: u.email, position: u.position, phone: u.phone, department: u.department, notify: notifyOf(u),
  sessionMin: sessionMinOf(u), sessionChoices: SESSION_CHOICES,
  linked: Object.fromEntries(Object.entries(oauthOf(u)).map(([p, x]) => [p, { email: x.email || '', name: x.name || '', at: x.at || '' }]))
});

/* свързани външни профили за вход: { google: { id, email, name, at }, microsoft: {…}, discord: {…} } */
export function oauthOf(u) {
  try { const o = JSON.parse(u.oauth || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (_) { return {}; }
}

/* ---------- вход ---------- */

const badLogin = left => fail('login', 'Грешен потребител или парола.' + (left ? ' Остават ' + left + (left === 1 ? ' опит.' : ' опита.') : ''));
const LOCKED = 'Твърде много неуспешни опити. Опитайте отново след 15 минути или поискайте нова парола по имейл.';

/* IP адресът се записва с приблизителното място: „1.2.3.4 (Sofia, BG)“ */
export const recordLogin = (app, username, result) =>
  app.store.insert('logins', { at: stamp(), username, ip: app.ip + (app.ip && app.geo ? ' (' + app.geo + ')' : ''), agent: app.agent, result });

/* при вход от непознат IP адрес потребителят получава писмо (помнят се последните 20 адреса) */
async function knownIp(app, u) {
  if (!app.ip) return;
  const key = 'ips:' + u.username;
  let list = [];
  try { list = JSON.parse((await app.kv.get(key)) || '[]'); } catch (_) { list = []; }
  if (list.includes(app.ip)) return;
  if (list.length && u.email) {
    await mail(app, u.email, app.cfg.appName + ' – вход от нов IP адрес', 'Влязохте в системата като ' + u.username + ' от IP адрес ' + app.ip + (app.geo ? ' (' + app.geo + ')' : '') + ', от който не сте влизали досега.\n' +
      'Браузър: ' + (app.agent || '—') + '\nВреме: ' + stamp().replace('T', ' ').slice(0, 16) + '\n\nАко не сте вие, сменете паролата си веднага и уведомете администратора. Активните сесии се виждат в „Моите входове“.');
  }
  await app.kv.put(key, JSON.stringify([app.ip].concat(list).slice(0, 20)));
}

export async function login(d, ctx, app) {
  const username = str(d.username, 40).toLowerCase(), preHash = str(d.hash, 64);
  if (!USER_RE.test(username) || !PREHASH_RE.test(preHash)) badLogin();
  const t = await throttle(app, 'login|' + username), byIp = app.ip ? await throttle(app, 'ip|' + app.ip, CFG.MAX_IP_FAILS) : null;
  if ((await t.blocked()) || (byIp && (await byIp.blocked()))) fail('locked', LOCKED);
  const u = await findUser(app, username);
  const ok = u && u.active === 'Да' && u.salt && sameText(await serverHash(app, preHash, u.salt), u.hash);
  if (!ok) {
    const count = await t.hit();
    if (byIp) await byIp.hit();
    // въведеното име може да е парола, написана погрешно, затова непознато име не се записва
    await recordLogin(app, u ? username : '(непознат)', !u ? 'Непознат потребител' : u.active === 'Да' ? 'Грешна парола' : 'Спрян потребител');
    if (u) await audit(app, username, 'Неуспешен вход', '', app.ip);
    if (count >= CFG.MAX_FAILS) {
      await recordLogin(app, u ? username : '(непознат)', 'Заключен за 15 минути');
      if (u && u.email) await mail(app, u.email, app.cfg.appName + ' – спрян вход', 'Входът за потребител ' + u.username + ' е спрян за 15 минути след ' + count + ' неуспешни опита' + (app.ip ? ' (последен IP адрес: ' + app.ip + ')' : '') + '.\n\nАко не сте опитвали вие, сменете паролата си и уведомете администратора.');
      fail('locked', LOCKED);
    }
    badLogin(CFG.MAX_FAILS - count);
  }
  // при двуфакторен вход неуспешните опити се нулират едва след верния код
  if (u.twofa === 'Да') return startCode(app, u);
  await t.clear();
  return openSession(app, u);
}

export async function startCode(app, u) {
  const sent = await throttle(app, 'codesent|' + u.username, 5);
  if (await sent.blocked()) fail('locked', 'Изпратени са твърде много кодове. Опитайте отново след 15 минути.');
  await sent.hit();
  const code = randomCode(), ticket = randomToken();
  await app.store.patch('users', u._id, { codeHash: await hmac(app.env.PEPPER, code + '|' + ticket), codeExp: String(Date.now() + CFG.CODE_MIN * 6e4) });
  await app.kv.put('t:' + (await sha256(ticket)), u.username, { expirationTtl: 900 });
  const ok = await mail(app, u.email, app.cfg.appName + ' – код за вход', 'Код: ' + code + '\n\nКодът важи ' + CFG.CODE_MIN + ' минути и се използва веднъж. Ако не влизате вие, сменете паролата си.');
  if (!ok) fail('mail', 'Кодът не можа да бъде изпратен. Опитайте отново по-късно.');
  return { twofa: true, ticket };
}

async function codeOk(app, u, ticket, code) {
  return /^[0-9a-f]{64}$/.test(ticket) && /^\d{8}$/.test(code) && !!u && !!u.codeHash && Number(u.codeExp) >= Date.now() &&
    sameText(await hmac(app.env.PEPPER, code + '|' + ticket), u.codeHash);
}

export async function loginCode(d, ctx, app) {
  const ticket = str(d.ticket, 64), code = str(d.code, 8);
  if (!/^[0-9a-f]{64}$/.test(ticket)) fail('code', 'Невалиден код.');
  const key = 't:' + (await sha256(ticket)), username = await app.kv.get(key);
  if (!username) fail('code', 'Кодът е изтекъл. Влезте отново.');
  const t = await throttle(app, 'login|' + username);
  if (await t.blocked()) fail('locked', LOCKED);
  const u = await findUser(app, username);
  if (!u || u.active !== 'Да' || !(await codeOk(app, u, ticket, code))) {
    const n = await t.hit();
    if (n >= CFG.MAX_FAILS) fail('locked', LOCKED);
    fail('code', 'Грешен или изтекъл код. Остават ' + (CFG.MAX_FAILS - n) + ' опита.');
  }
  await t.clear();
  await app.kv.delete(key);
  await app.store.patch('users', u._id, { codeHash: '', codeExp: '' });
  return openSession(app, u);
}

export async function openSession(app, u, how) {
  await app.store.patch('users', u._id, { lastLogin: stamp() });
  await recordLogin(app, u.username, how ? 'Успешен (' + how + ')' : 'Успешен');
  await audit(app, u.username, how ? 'Вход с ' + how : 'Вход', '', app.ip);
  const token = randomToken(), exp = Date.now() + sessionMinOf(u) * 6e4;
  await saveSession(app, token, { u: u.username, exp });
  await indexSession(app, u.username, await sha256(token), how);
  try { await knownIp(app, u); } catch (e) { console.error('knownIp: ' + e.message); }
  return { __cookie: token, session: exp, me: meInfo(u) };
}

/* ---------- сесии ---------- */

async function saveSession(app, token, s) {
  await app.kv.put('s:' + (await sha256(token)), JSON.stringify(s), { expirationTtl: Math.max(60, Math.ceil((s.exp - Date.now()) / 1000) + 60) });
}

/* активните сесии на потребителя: списък в KV (без ключовете – само хешовете им) */
const sessKey = username => 'ss:' + username;
async function sessIndex(app, username) {
  try { const a = JSON.parse((await app.kv.get(sessKey(username))) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
async function indexSession(app, username, h, how) {
  const list = (await sessIndex(app, username)).slice(0, 19);
  list.unshift({ h, ip: app.ip, geo: app.geo || '', agent: app.agent, at: stamp(), how: how || 'парола' });
  await app.kv.put(sessKey(username), JSON.stringify(list), { expirationTtl: 30 * 86400 });
}
/* само сесиите, които още важат */
async function liveSessions(app, username) {
  const all = await sessIndex(app, username), live = [];
  for (const x of all) {
    const raw = await app.kv.get('s:' + x.h);
    if (raw && JSON.parse(raw).exp >= Date.now()) live.push(x);
  }
  if (live.length !== all.length) await app.kv.put(sessKey(username), JSON.stringify(live), { expirationTtl: 30 * 86400 });
  return live;
}
/* прекратява всички сесии на потребителя (при спиране на достъпа); except – хеш на сесия, която остава */
export async function endSessions(app, username, except) {
  const list = await sessIndex(app, username);
  for (const x of list) if (x.h !== except) await app.kv.delete('s:' + x.h);
  await app.kv.put(sessKey(username), JSON.stringify(list.filter(x => x.h === except)), { expirationTtl: 30 * 86400 });
  return list.filter(x => x.h !== except).length;
}

/* чужди сесии вижда и прекратява администратор с право „Управлява потребителите“ */
const sessUser = (d, ctx) => {
  const u = str(d.username, 40).toLowerCase();
  if (u && u !== ctx.username && !ctx.perms.users) fail('role', 'Нямате право за това действие.');
  return u || ctx.username;
};

export async function sessionsList(d, ctx, app) {
  const username = sessUser(d, ctx), cur = await sha256(ctx.token);
  return { sessions: (await liveSessions(app, username)).map(x => ({ id: x.h.slice(0, 16), ip: x.ip, geo: x.geo, agent: x.agent, at: x.at, how: x.how, current: x.h === cur })) };
}

export async function sessionsEnd(d, ctx, app) {
  const username = sessUser(d, ctx), cur = await sha256(ctx.token), id = str(d.id, 16);
  if (d.all === true) {
    const n = await endSessions(app, username, username === ctx.username ? cur : '');
    await audit(app, ctx.username, 'Прекратени сесии', username, n + ' бр.');
    return { ended: n };
  }
  const x = (await sessIndex(app, username)).find(s => s.h.slice(0, 16) === id);
  if (!x) fail('notfound', 'Сесията не е намерена или вече е изтекла.');
  if (x.h === cur) fail('value', 'Това е текущата ви сесия – използвайте „Изход“.');
  await app.kv.delete('s:' + x.h);
  await app.kv.put(sessKey(username), JSON.stringify((await sessIndex(app, username)).filter(s => s.h !== x.h)), { expirationTtl: 30 * 86400 });
  await audit(app, ctx.username, 'Прекратена сесия', username, (x.ip || '') + ' · ' + (x.agent || '').slice(0, 80));
  return { ended: 1 };
}

export function cookieToken(req) {
  const m = /(?:^|;\s*)adm_s=([0-9a-f]{64})(?:;|$)/.exec(req.headers.get('Cookie') || '');
  return m ? m[1] : '';
}

const expired = () => fail('session', 'Сесията е изтекла. Влезте отново.');

/* need: user | admin | super */
export async function authenticate(app, token, need) {
  if (!token) expired();
  const raw = await app.kv.get('s:' + (await sha256(token)));
  const s = raw ? JSON.parse(raw) : null;
  if (!s || s.exp < Date.now()) expired();
  const user = await cached(app, 'usr:' + s.u, 120, async () => {
    const u = await findUser(app, s.u);
    return u ? { _id: u._id, username: u.username, active: u.active, role: u.role, name: u.name, email: u.email, perms: u.perms, notify: u.notify, department: u.department, persons: u.persons, sessionMin: u.sessionMin } : null;
  });
  if (!user || user.active !== 'Да') fail('session', 'Достъпът е спрян.');
  if (need === 'admin' && !isAdminRole(user.role)) fail('role', 'Това действие е само за администратор.');
  if (need === 'super' && user.role !== ROLE_SUPER) fail('role', 'Това действие е само за суперадминистратор.');
  // плъзгащ се срок; записва се отново най-много веднъж на 5 минути, за да се пестят записите в KV
  const exp = Date.now() + sessionMinOf(user) * 6e4;
  if (exp - s.exp > 5 * 6e4) { s.exp = exp; await saveSession(app, token, s); }
  return {
    token, username: s.u, userId: user._id, name: user.name, email: user.email, role: user.role,
    admin: isAdminRole(user.role), super: user.role === ROLE_SUPER, access: accessOf(user),
    perms: permsOf(user), notify: notifyOf(user), sessionExp: s.exp, sessionMin: sessionMinOf(user)
  };
}

/* продължителност на сесията без действие: от 30 минути до 3 часа; важи веднага и за текущата сесия */
export async function sessionSave(d, ctx, app) {
  const minutes = Number(d.minutes);
  if (!SESSION_CHOICES.includes(minutes)) fail('value', 'Изберете от 30 минути до 3 часа.');
  const u = await findUser(app, ctx.username);
  await app.store.patch('users', u._id, { sessionMin: String(minutes) });
  await dropUser(app, ctx.username);
  const exp = Date.now() + minutes * 6e4;
  await saveSession(app, ctx.token, { u: ctx.username, exp });
  await audit(app, ctx.username, 'Продължителност на сесията', '', minutes + ' мин.');
  return { sessionMin: minutes, session: exp };
}

export async function me(d, ctx, app) {
  return { me: meInfo(await findUser(app, ctx.username)) };
}

export async function logout(d, ctx, app) {
  const h = await sha256(ctx.token);
  await app.kv.delete('s:' + h);
  await app.kv.put(sessKey(ctx.username), JSON.stringify((await sessIndex(app, ctx.username)).filter(s => s.h !== h)), { expirationTtl: 30 * 86400 });
  await audit(app, ctx.username, 'Изход', '', '');
  return { __cookie: '' };
}

/* ---------- пароли ---------- */

async function checkPassword(app, ctx, preHash) {
  const t = await throttle(app, 'pw|' + ctx.username);
  if (await t.blocked()) fail('locked', 'Твърде много грешни опити. Опитайте отново след 15 минути.');
  const u = await findUser(app, ctx.username);
  if (!PREHASH_RE.test(preHash) || !u.salt || !sameText(await serverHash(app, preHash, u.salt), u.hash)) {
    await t.hit();
    await audit(app, ctx.username, 'Грешна текуща парола', '', '');
    fail('password', 'Текущата парола е грешна.');
  }
  await t.clear();
  return u;
}

export async function changePassword(d, ctx, app) {
  const cur = str(d.current, 64), next = str(d.next, 64);
  if (!PREHASH_RE.test(next)) fail('value', 'Невалидни данни.');
  const u = await checkPassword(app, ctx, cur);
  if (next === cur) fail('password', 'Новата парола трябва да е различна от текущата.');
  await app.store.patch('users', u._id, await setPassword(app, next));
  await audit(app, ctx.username, 'Смяна на парола', '', '');
  return {};
}

const inviteValid = async (u, token) => !!u && u.active === 'Да' && !!u.inviteHash && Number(u.inviteExp) >= Date.now() && sameText(await sha256(token), u.inviteHash);

function linkArgs(d) {
  const username = str(d.username, 40).toLowerCase(), token = str(d.token, 64);
  return { username, token, ok: USER_RE.test(username) && /^[0-9a-f]{64}$/.test(token) };
}

/* при отваряне на връзката: само проверка, която не я изразходва, за да не я затварят скенерите на пощата */
export async function linkCheck(d, ctx, app) {
  const a = linkArgs(d);
  if (!a.ok) return { valid: false };
  const t = await throttle(app, 'linkcheck|' + a.username, 30);
  if (await t.blocked()) return { valid: false };
  await t.hit();
  return { valid: await inviteValid(await findUser(app, a.username), a.token) };
}

export async function activate(d, ctx, app) {
  const a = linkArgs(d), preHash = str(d.hash, 64);
  const invalid = () => fail('invite', 'Връзката е невалидна или изтекла. Поискайте нова от администратора.');
  if (!a.ok || !PREHASH_RE.test(preHash)) invalid();
  const t = await throttle(app, 'activate|' + a.username);
  if (await t.blocked()) fail('locked', 'Твърде много неуспешни опити. Опитайте отново след 15 минути.');
  const u = await findUser(app, a.username);
  if (!(await inviteValid(u, a.token))) { await t.hit(); invalid(); }
  await t.clear();
  await (await throttle(app, 'login|' + a.username)).clear(); // новата парола отменя ограничението за вход
  await app.store.patch('users', u._id, Object.assign(await setPassword(app, preHash), { inviteHash: '', inviteExp: '' }));
  await audit(app, a.username, 'Зададена парола чрез еднократна връзка', '', app.ip);
  return { username: a.username };
}

/* забравена парола: отговорът е еднакъв, за да не се разбира кои потребители съществуват */
export async function forgot(d, ctx, app) {
  const username = str(d.username, 40).toLowerCase();
  if (!USER_RE.test(username)) return {};
  const t = await throttle(app, 'forgot|' + username);
  if (await t.blocked()) return {};
  await t.hit();
  const u = await findUser(app, username);
  if (!u || u.active !== 'Да' || !u.email) return {};
  const inv = await newInvite(CFG.RESET_HOURS);
  await app.store.patch('users', u._id, { inviteHash: inv.hash, inviteExp: inv.exp });
  await audit(app, username, 'Поискана нова парола', '', app.ip);
  await accessMail(app, u.email, username, inviteLink(app, username, inv.token), CFG.RESET_HOURS + ' часа');
  return {};
}

/* ---------- двуфакторен вход с код по имейл ---------- */

export async function twofaStart(d, ctx, app) {
  const u = await checkPassword(app, ctx, str(d.hash, 64));
  if (d.enable === false) {
    await app.store.patch('users', u._id, { twofa: '', codeHash: '', codeExp: '' });
    await dropUser(app, ctx.username);
    await audit(app, ctx.username, 'Изключен двуфакторен вход', '', '');
    return { twofa: false };
  }
  if (!u.email) fail('email', 'Нямате имейл. Помолете администратора да го въведе.');
  return startCode(app, u);
}

export async function twofaConfirm(d, ctx, app) {
  const ticket = str(d.ticket, 64), code = str(d.code, 8);
  const t = await throttle(app, 'twofa|' + ctx.username);
  if (await t.blocked()) fail('locked', 'Твърде много грешни опити. Опитайте отново след 15 минути.');
  const u = await findUser(app, ctx.username);
  if (!(await codeOk(app, u, ticket, code))) { await t.hit(); fail('code', 'Грешен или изтекъл код.'); }
  await t.clear();
  await app.store.patch('users', u._id, { twofa: 'Да', codeHash: '', codeExp: '' });
  await dropUser(app, ctx.username);
  await audit(app, ctx.username, 'Включен двуфакторен вход', '', '');
  return { twofa: true };
}

export async function notifySave(d, ctx, app) {
  const u = await findUser(app, ctx.username);
  const n = { assign: d.assign !== false, deadline: d.deadline !== false, mail: d.mail !== false, status: !!d.status, comments: !!d.comments, all: !!d.all && !!ctx.perms.casesAll };
  await app.store.patch('users', u._id, { notify: JSON.stringify(n) });
  await dropUser(app, ctx.username);
  return { notify: n };
}
