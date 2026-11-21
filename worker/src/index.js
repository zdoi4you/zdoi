/*
 * ADM ЗДОИ4You – вътрешна система. Cloudflare Worker на adm.zdoi.eu/api/*.
 *
 * POST /api        { action, data } → { ok, ... }      – всички действия
 * POST /api/setup  заглавка X-Setup-Key                 – създава списъците в SharePoint и първия администратор
 * GET  /api/health                                      – проверка
 * Cron на 5 минути                                      – входяща поща на приемната и напомняния за срокове
 */

import { CFG } from './config.js';
import { AppError, fail, str, line, isEmail, stamp } from './util.js';
import { makeApp, audit } from './core.js';
import { SharePointStore } from './store/sharepoint.js';
import { MemoryStore, MemoryKV } from './store/memory.js';
import { sameText } from './crypto.js';
import * as auth from './auth.js';
import * as users from './users.js';
import * as cases from './cases.js';
import * as reqs from './requests.js';
import * as oauth from './oauth.js';
import * as acme from './acme.js';
import * as kep from './kep.js';
import * as persons from './persons.js';
import { ROLE_SUPER, isAdminRole } from './config.js';
import { SCHEMA_VER } from './schema.js';

/* auth: public | user | admin | super; perm: нужно право (или списък – всички са нужни) */
export const ACTIONS = {
  login: { auth: 'public', fn: auth.login },
  'login.code': { auth: 'public', fn: auth.loginCode },
  activate: { auth: 'public', fn: auth.activate },
  forgot: { auth: 'public', fn: auth.forgot },
  'link.check': { auth: 'public', fn: auth.linkCheck },
  'oauth.providers': { auth: 'public', fn: oauth.providersList },
  'oauth.unlink': { auth: 'user', fn: oauth.oauthUnlink },
  'oauth.settings': { auth: 'admin', perm: 'system', fn: async (d, ctx, app) => ({ providers: await oauth.oauthSystem(app) }) },
  'oauth.save': { auth: 'admin', perm: 'system', fn: oauth.oauthSystemSave },

  me: { auth: 'user', fn: auth.me },
  logout: { auth: 'user', fn: auth.logout },
  password: { auth: 'user', fn: auth.changePassword },
  'twofa.start': { auth: 'user', fn: auth.twofaStart },
  'twofa.confirm': { auth: 'user', fn: auth.twofaConfirm },
  'notify.save': { auth: 'user', fn: auth.notifySave },
  'session.save': { auth: 'user', fn: auth.sessionSave },
  'sessions.list': { auth: 'user', fn: auth.sessionsList },
  'sessions.end': { auth: 'user', fn: auth.sessionsEnd },
  'profile.person': { auth: 'user', fn: persons.defaultPersonSave },
  calendar: { auth: 'user', fn: cases.calendar },

  bootstrap: { auth: 'user', fn: cases.bootstrap },
  dashboard: { auth: 'user', fn: cases.dashboard },
  'case.list': { auth: 'user', perm: 'inReg', fn: cases.caseList },
  'case.get': { auth: 'user', perm: 'inReg', fn: cases.caseGet },
  'case.create': { auth: 'user', perm: ['inReg', 'inRegEdit'], fn: cases.caseCreate },
  'case.update': { auth: 'user', perm: ['inReg', 'inRegEdit'], fn: cases.caseUpdate },
  'case.assign': { auth: 'user', perm: ['inReg', 'inRegEdit'], fn: cases.caseAssign },
  'case.lock': { auth: 'user', perm: ['inReg', 'inRegEdit', 'lock'], fn: cases.caseLock },
  'case.comment': { auth: 'user', perm: ['inReg', 'comment'], fn: cases.caseComment },
  'court.list': { auth: 'user', fn: cases.courtList },
  'court.save': { auth: 'user', perm: 'courts', fn: cases.courtSave },
  'court.delete': { auth: 'user', perm: 'courts', fn: cases.courtDelete },
  'addressee.list': { auth: 'user', fn: cases.addresseeList },
  'addressee.save': { auth: 'user', perm: 'addressees', fn: cases.addresseeSave },
  'addressee.delete': { auth: 'user', perm: 'addressees', fn: cases.addresseeDelete },
  'department.list': { auth: 'user', fn: users.departmentsList },
  'department.save': { auth: 'user', perm: 'departments', fn: users.departmentsSave },
  'log.list': { auth: 'user', perm: 'log', fn: users.logList },
  'logins.list': { auth: 'user', fn: users.loginsList },

  'req.list': { auth: 'user', fn: reqs.reqList },
  'register.list': { auth: 'user', perm: 'outReg', fn: reqs.registerList },
  'req.get': { auth: 'user', fn: reqs.reqGet },
  'req.create': { auth: 'user', perm: 'reqCreate', fn: reqs.reqCreate },
  'req.update': { auth: 'user', perm: 'reqEdit', fn: reqs.reqUpdate },
  'req.assign': { auth: 'user', fn: reqs.reqAssign },
  'req.retag': { auth: 'user', perm: 'reqEdit', fn: reqs.reqRetag },
  'req.lock': { auth: 'user', perm: 'lock', fn: reqs.reqLock },
  'req.comment': { auth: 'user', perm: 'comment', fn: reqs.reqComment },
  'doc.reserve': { auth: 'user', perm: 'docs', fn: reqs.docReserve },
  'doc.file': { auth: 'user', perm: 'docs', big: true, fn: reqs.docFile },
  'doc.download': { auth: 'user', fn: reqs.docDownload },
  'kep.challenge': { auth: 'public', fn: kep.kepChallenge },
  'kep.login': { auth: 'public', fn: kep.kepLogin },
  'kep.linkChallenge': { auth: 'user', fn: kep.kepLinkChallenge },
  'kep.link': { auth: 'user', fn: kep.kepLink },
  'kep.verify': { auth: 'user', big: true, fn: kep.kepVerify },
  'kep.checkCert': { auth: 'user', fn: kep.kepCheckCert },
  'kep.testAuthorize': { auth: 'user', fn: kep.kepTestAuthorize },
  'kep.authorize': { auth: 'user', perm: 'sign', fn: kep.kepAuthorize },
  'kep.complete': { auth: 'user', perm: 'sign', big: true, fn: kep.kepComplete },
  'kep.status': { auth: 'admin', perm: 'system', fn: kep.kepStatus },
  'kep.renew': { auth: 'admin', perm: 'system', fn: kep.kepRenew },
  'mail.send': { auth: 'user', perm: 'mailSend', fn: reqs.mailSend },
  'mail.cancel': { auth: 'user', perm: 'mailSend', fn: reqs.mailCancel },
  'mail.record': { auth: 'user', perm: 'mailRecord', big: true, fn: reqs.mailRecord },
  'mail.inbox': { auth: 'user', perm: 'mailbox', fn: reqs.mailInbox },
  'mail.assign': { auth: 'user', perm: 'mailbox', fn: reqs.mailAssign },
  'mail.attachment': { auth: 'user', fn: reqs.mailAttachment },
  'system.get': { auth: 'admin', perm: 'system', fn: reqs.systemGet },
  'system.save': { auth: 'admin', perm: 'system', fn: reqs.systemSave },
  'system.poll': { auth: 'admin', perm: 'system', fn: reqs.systemPoll },
  'system.schema': { auth: 'admin', perm: 'system', fn: async (d, ctx, app) => {
    let r;
    try { r = await app.store.ensureSchema(); } catch (e) {
      if (e.status === 403) fail('role', 'Приложението може да пише в списъците, но не и да добавя колони (нужно е ниво „manage“ за сайта). Изпълнете „node tools/sp-provision.js“ с администраторски акаунт.');
      throw e;
    }
    await audit(app, ctx.username, 'Обновена структура на базата', '', (r.created || []).join(', ') || 'без промени');
    return { created: r.created || [] };
  } },

  'users.list': { auth: 'admin', perm: 'users', fn: users.usersList },
  'users.save': { auth: 'admin', perm: 'users', fn: users.usersSave },
  'users.invite': { auth: 'admin', perm: 'users', fn: users.usersInvite },

  'persons.list': { auth: 'super', fn: persons.personsList },
  'persons.save': { auth: 'super', fn: persons.personsSave }
};

/* ---------- среда ---------- */

let devStore = null, devKv = null;
export function services(env) {
  if (env.__store) return { store: env.__store, kv: env.__kv };
  if (env.STORE === 'memory') {
    devStore = devStore || new MemoryStore();
    devKv = devKv || new MemoryKV();
    return { store: devStore, kv: env.KV || devKv };
  }
  if (!env.KV) throw new Error('Липсва KV namespace (KV).');
  return { store: new SharePointStore(env), kv: env.KV };
}

const SECURITY = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex'
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({}, SECURITY, extra) });
}

function cookie(app, token) {
  const secure = app.cfg.appUrl.startsWith('https:') ? '; Secure' : '';
  return token
    ? 'adm_s=' + token + '; Path=/api; HttpOnly; SameSite=Strict; Max-Age=' + CFG.SESSION_MAX * 60 * 4 + secure
    : 'adm_s=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0' + secure;
}

/* заявките с бисквитка се приемат само от собствения адрес на системата (защита от CSRF) */
function sameOrigin(req, app) {
  const o = req.headers.get('Origin');
  if (o) return o === app.cfg.origin || (app.env.DEV_ORIGIN && o === app.env.DEV_ORIGIN);
  return req.headers.get('Sec-Fetch-Site') === 'same-origin';
}

export async function dispatch(app, req, body) {
  const name = String(body && body.action);
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) fail('action', 'Непознато действие.');
  const a = ACTIONS[name];
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const ctx = a.auth === 'public' ? null : await auth.authenticate(app, auth.cookieToken(req), a.auth);
  if (a.perm && ![].concat(a.perm).every(p => ctx.perms[p])) fail('role', 'Нямате право за това действие.');
  const result = (await a.fn(data, ctx, app)) || {};
  return { ctx, result };
}

async function handleApi(req, env) {
  const { store, kv } = services(env);
  const app = makeApp(env, store, kv, req);
  if (req.method !== 'POST') return json({ ok: false, error: 'method', message: 'Използвайте POST.' }, 405);
  if (!sameOrigin(req, app)) return json({ ok: false, error: 'origin', message: 'Заявката не е от системата.' }, 403);
  if (!/^application\/json/.test(req.headers.get('Content-Type') || '')) return json({ ok: false, error: 'bad', message: 'Невалидна заявка.' }, 415);
  let body;
  try {
    const raw = await req.text();
    if (raw.length > CFG.MAX_BIG_BODY) return json({ ok: false, error: 'size', message: 'Данните са твърде големи.' }, 413);
    body = JSON.parse(raw);
    const a = ACTIONS[String(body && body.action)];
    if (raw.length > CFG.MAX_BODY && !(a && a.big)) return json({ ok: false, error: 'size', message: 'Данните са твърде големи.' }, 413);
  } catch (_) {
    return json({ ok: false, error: 'bad', message: 'Невалидна заявка.' }, 400);
  }
  try {
    const { result } = await dispatch(app, req, body);
    const headers = {};
    if ('__cookie' in result) { headers['Set-Cookie'] = cookie(app, result.__cookie); delete result.__cookie; }
    return json(Object.assign({ ok: true, now: Date.now() }, result), 200, headers);
  } catch (err) {
    if (err instanceof AppError) {
      const headers = err.code === 'session' ? { 'Set-Cookie': cookie(app, '') } : {};
      return json({ ok: false, error: err.code, message: err.message }, 200, headers);
    }
    console.error(err && err.stack || err);
    return json({ ok: false, error: 'server', message: 'Вътрешна грешка. Опитайте отново.' }, 500);
  }
}

/* еднократна настройка: списъците в SharePoint и първият администратор; безопасно е да се повтаря */
export async function setup(app, d) {
  if (!app.env.PEPPER || app.env.PEPPER.length < 32) fail('setup', 'Задайте тайната PEPPER (поне 32 знака): wrangler secret put PEPPER');
  const schema = await app.store.ensureSchema();
  const all = await app.store.list('users');
  if (all.some(u => isAdminRole(u.role))) return { schema, admin: 'вече има администратор' };
  const username = str(d.username || 'admin', 40).toLowerCase(), email = line(d.email, 200).toLowerCase(), name = line(d.name || 'Суперадминистратор', 120);
  if (!auth.USER_RE.test(username) || !isEmail(email)) fail('value', 'Посочете username и валиден email на първия администратор.');
  const inv = await auth.newInvite(CFG.INVITE_DAYS * 24);
  await app.store.insert('users', { username, name, email, role: ROLE_SUPER, active: 'Да', inviteHash: inv.hash, inviteExp: inv.exp, createdAt: stamp(), createdBy: 'настройка' });
  await audit(app, 'настройка', 'Първи суперадминистратор', username, '');
  const link = auth.inviteLink(app, username, inv.token);
  await auth.accessMail(app, email, username, link, CFG.INVITE_DAYS + ' дни');
  return { schema, admin: username, link };
}

async function handleSetup(req, env) {
  const { store, kv } = services(env);
  const app = makeApp(env, store, kv, req);
  const key = req.headers.get('X-Setup-Key') || '';
  if (req.method !== 'POST' || !env.SETUP_KEY || !sameText(key, env.SETUP_KEY)) return json({ ok: false, error: 'forbidden' }, 403);
  try {
    let d = {};
    try { d = await req.json(); } catch (_) { d = {}; }
    return json(Object.assign({ ok: true }, await setup(app, d)));
  } catch (err) {
    console.error(err && err.stack || err);
    return json({ ok: false, error: err.code || 'server', message: err.message }, 500);
  }
}

/* след обновяване на системата: липсващите списъци и колони в SharePoint се добавят веднъж за версията */
async function upgradeSchema(app) {
  if ((await app.kv.get('schemaVer')) === SCHEMA_VER) return;
  try {
    const r = await app.store.ensureSchema();
    await app.kv.put('schemaVer', SCHEMA_VER);
    console.log('структура на базата', JSON.stringify(r.created || []));
  } catch (e) { console.error('структура на базата: ' + e.message); }
}

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    if (path === '/api/health') return json({ ok: true, service: 'adm-zdoi', store: env.STORE === 'memory' ? 'memory' : 'sharepoint' });
    if (path === '/api/setup') return handleSetup(req, env);
    if (path === '/api') return handleApi(req, env);
    if (path.startsWith('/.well-known/acme-challenge/')) {
      const { store, kv } = services(env);
      return acme.challenge(makeApp(env, store, kv, req), path.split('/').pop());
    }
    if (path.startsWith('/api/oauth/')) {
      const { store, kv } = services(env);
      return oauth.handleOAuth(req, makeApp(env, store, kv, req), cookie);
    }
    // сайтът: файл, който не съществува – страницата 404 (самите файлове се сервират преди Worker-а)
    if (env.ASSETS && req.method === 'GET' && !path.startsWith('/api')) {
      const page = await env.ASSETS.fetch(new Request(new URL('/404.html', req.url)));
      return new Response(page.body, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    return json({ ok: false, error: 'notfound' }, 404);
  },
  async scheduled(event, env, ctx) {
    const { store, kv } = services(env);
    const app = makeApp(env, store, kv, null);
    // пощата на приемната – на всеки 5 минути; напомнянията – веднъж на ден след 8:00 ч.
    ctx.waitUntil(upgradeSchema(app).then(() => reqs.sendScheduled(app)).then(r => { if (r.due) console.log('насрочени писма', JSON.stringify(r)); }, e => console.error('насрочени писма: ' + e.message)).then(() => reqs.pollMail(app)).then(r => console.log('поща', JSON.stringify(r)))
      .then(() => cases.remindDeadlines(app)).then(r => console.log('напомняния', JSON.stringify(r)))
      .then(() => acme.ensureCert(app)).then(r => console.log('сертификат за КЕП', JSON.stringify(r))));
  }
};
