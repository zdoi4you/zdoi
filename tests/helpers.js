/* Помощни функции за тестовете: Worker с данни в паметта и пощенска кутия, която събира писмата. */

import worker from '../worker/src/index.js';
import { MemoryStore, MemoryKV } from '../worker/src/store/memory.js';

export const ORIGIN = 'https://adm.test';

export function makeEnv() {
  const outbox = [];
  const env = {
    APP_URL: ORIGIN + '/', PEPPER: 'p'.repeat(48), SETUP_KEY: 'setup-key-123',
    __store: new MemoryStore(), __kv: new MemoryKV(),
    __mailer: async (to, subject, text) => { outbox.push({ to, subject, text }); },
    // ЕПЕП: без мрежа в тестовете – празни отговори, освен ако тестът подмени
    __epep: async () => new Response(JSON.stringify({ data: [] }), { headers: { 'Content-Type': 'application/json' } })
  };
  return { env, outbox };
}

/* „PBKDF2“ на браузъра – в тестовете е достатъчен произволен низ във формата на base64 */
export const pre = pw => Buffer.from(('pw:' + pw).padEnd(32, '.')).toString('base64');

export function client(env) {
  let jar = '';
  const call = async (action, data = {}, headers = {}) => {
    const r = await worker.fetch(new Request(ORIGIN + '/api', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.5' }, jar ? { Cookie: jar } : {}, headers),
      body: JSON.stringify({ action, data })
    }), env);
    const set = r.headers.get('Set-Cookie');
    if (set) jar = /adm_s=([^;]*)/.exec(set)[1] ? 'adm_s=' + /adm_s=([^;]*)/.exec(set)[1] : '';
    return r.json();
  };
  return { call, get cookie() { return jar; } };
}

export async function setup(env, body = { username: 'admin', email: 'admin@example.org', name: 'Админ' }) {
  const r = await worker.fetch(new Request(ORIGIN + '/api/setup', {
    method: 'POST', headers: { 'X-Setup-Key': env.SETUP_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }), env);
  return r.json();
}

export const linkParts = text => {
  const m = /#\/activate\/([^/\s]+)\/([0-9a-f]{64})/.exec(text);
  return m ? { username: decodeURIComponent(m[1]), token: m[2] } : null;
};

/* настроена система с активен администратор, влязъл в отделен клиент */
export async function ready() {
  const { env, outbox } = makeEnv();
  const s = await setup(env);
  const admin = client(env);
  const p = linkParts(s.link);
  await admin.call('activate', { username: p.username, token: p.token, hash: pre('admin-pass') });
  const r = await admin.call('login', { username: 'admin', hash: pre('admin-pass') });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { env, outbox, admin };
}

export async function addUser(env, outbox, admin, username, role, extra = {}) {
  const r = await admin.call('users.save', Object.assign({ isNew: true, username, name: username.toUpperCase(), email: username + '@example.org', role }, extra));
  if (!r.ok) throw new Error(JSON.stringify(r));
  const mailItem = outbox.filter(m => m.to === username + '@example.org').pop();
  const p = linkParts(mailItem.text);
  const c = client(env);
  await c.call('activate', { username, token: p.token, hash: pre(username + '-pass') });
  const l = await c.call('login', { username, hash: pre(username + '-pass') });
  if (!l.ok) throw new Error(JSON.stringify(l));
  return c;
}

export const caseData = (over = {}) => Object.assign({
  kind: 'Достъп до обществена информация', regDate: '2026-11-02', channel: 'Писмено', applicantType: 'Гражданин',
  applicantName: 'Иван Иванов', applicantEmail: 'ivan@example.org', subject: 'Договори за почистване 2025 г.'
}, over);
