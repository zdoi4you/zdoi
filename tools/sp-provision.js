/*
 * Създава базата данни в SharePoint с вашия акаунт в Microsoft 365 (вход с код за устройство):
 *   1. сайт (частна група в Microsoft 365), ако още няма такъв;
 *   2. списъците „ADM …“ с колоните и индексите (безопасно е да се повтаря);
 *   3. първия администратор на системата с еднократна връзка за парола (само ако няма администратор).
 *
 *   node tools/sp-provision.js [--site bulmaileu.sharepoint.com:/sites/adm-zdoi] [--create] [--username admin] [--manual private/rakovodstvo.md]
 *
 * --manual: качва ръководството (Markdown) в списъка „ADM Ръководство“; раздел със същото заглавие се заменя.
 *
 * Нужни делегирани права: Sites.Manage.All, а при --create и Group.ReadWrite.All.
 */

import { SharePointStore } from '../worker/src/store/sharepoint.js';
import { graph } from '../worker/src/graph.js';
import { newInvite, inviteLink } from '../worker/src/auth.js';
import { stamp } from '../worker/src/util.js';
import { CFG, ROLE_SUPER, isAdminRole } from '../worker/src/config.js';
import { importManual } from '../worker/src/help.js';
import { readFileSync } from 'node:fs';

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const TENANT = arg('tenant', 'bulmail.eu');
const SITE = arg('site', 'bulmaileu.sharepoint.com:/sites/adm-zdoi');
const CREATE = process.argv.includes('--create');
const USERNAME = arg('username', 'admin');
const APP_URL = arg('app', 'https://adm.zdoi.eu/');
const MANUAL = arg('manual', '');
const manualText = MANUAL ? readFileSync(MANUAL, 'utf8') : '';
// Microsoft Graph Command Line Tools – публичен клиент на Microsoft
const CLIENT = arg('client', '14d82eec-204b-4c2f-b7e8-296a70dab67e');
const SCOPES = ['https://graph.microsoft.com/Sites.Manage.All', 'https://graph.microsoft.com/User.Read'].concat(CREATE ? ['https://graph.microsoft.com/Group.ReadWrite.All'] : []).join(' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function deviceLogin() {
  const base = 'https://login.microsoftonline.com/' + encodeURIComponent(TENANT) + '/oauth2/v2.0/';
  const dc = await (await fetch(base + 'devicecode', { method: 'POST', body: new URLSearchParams({ client_id: CLIENT, scope: SCOPES }) })).json();
  if (!dc.device_code) throw new Error('devicecode: ' + JSON.stringify(dc));
  console.log('\n>>> ' + dc.message + '\n');
  const until = Date.now() + dc.expires_in * 1000;
  while (Date.now() < until) {
    await sleep((dc.interval || 5) * 1000);
    const t = await (await fetch(base + 'token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT, device_code: dc.device_code }) })).json();
    if (t.access_token) return t.access_token;
    if (t.error !== 'authorization_pending' && t.error !== 'slow_down') throw new Error(t.error + ': ' + String(t.error_description || '').split('\n')[0]);
  }
  throw new Error('Кодът изтече.');
}

async function findSite(env) {
  try {
    return await graph(env, 'GET', '/sites/' + encodeURI(SITE) + '?$select=id,webUrl,displayName');
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function createSite(env) {
  const nick = SITE.split('/sites/')[1];
  console.log('Създаване на частна група и сайт „' + nick + '“…');
  const g = await graph(env, 'POST', '/groups', {
    displayName: 'ADM ЗДОИ4You', mailNickname: nick, description: 'База данни на вътрешната система ADM ЗДОИ4You (adm.zdoi.eu). Не редактирайте списъците ръчно.',
    groupTypes: ['Unified'], mailEnabled: true, securityEnabled: false, visibility: 'Private'
  });
  // сайтът на групата се създава до няколко минути
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    try { return await graph(env, 'GET', '/groups/' + g.id + '/sites/root?$select=id,webUrl,displayName'); } catch (e) { if (e.status !== 404 && e.status !== 400) throw e; }
    process.stdout.write('.');
  }
  throw new Error('Сайтът на групата още не е готов. Изпълнете скрипта отново след няколко минути (без --create).');
}

const token = await deviceLogin();
const env = { GRAPH_TOKEN: token, SP_SITE: SITE };
const me = await graph(env, 'GET', '/me?$select=displayName,mail,userPrincipalName');
console.log('Влязохте като ' + me.displayName + ' (' + (me.mail || me.userPrincipalName) + ')');

let site = await findSite(env);
if (!site) {
  if (!CREATE) throw new Error('Няма сайт ' + SITE + '. Изпълнете отново с --create.');
  site = await createSite(env);
}
console.log('\nСайт: ' + site.webUrl + '\nID:   ' + site.id);

const store = new SharePointStore(Object.assign({}, env, { SP_SITE: site.id }));
const { created } = await store.ensureSchema();
console.log(created.length ? 'Създадени: ' + created.join(', ') : 'Всички списъци и колони вече съществуват.');

if (manualText) {
  const r = await importManual(store, manualText, 'sp-provision');
  await store.insert('log', { at: stamp(), actor: 'sp-provision', action: 'Импорт на ръководството', ref: '', details: 'нови ' + r.added + ', обновени ' + r.updated });
  console.log('Ръководство: нови ' + r.added + ', обновени ' + r.updated + ' раздела.');
}

const users = await store.list('users');
if (users.some(u => isAdminRole(u.role))) {
  console.log('Администратор вече има – не се създава нов.');
} else {
  const inv = await newInvite(CFG.INVITE_DAYS * 24);
  await store.insert('users', {
    username: USERNAME, name: me.displayName, email: String(me.mail || me.userPrincipalName).toLowerCase(), role: ROLE_SUPER, active: 'Да',
    inviteHash: inv.hash, inviteExp: inv.exp, createdAt: stamp(), createdBy: 'sp-provision'
  });
  await store.insert('log', { at: stamp(), actor: 'sp-provision', action: 'Първи суперадминистратор', ref: USERNAME, details: '' });
  console.log('\nПърви администратор: ' + USERNAME + '\nВръзка за парола (важи ' + CFG.INVITE_DAYS + ' дни, след като Worker-ът е публикуван):\n' + inviteLink({ cfg: { appUrl: APP_URL } }, USERNAME, inv.token));
}
console.log('\nЗа wrangler.toml:  SP_SITE = "' + site.id + '"');
