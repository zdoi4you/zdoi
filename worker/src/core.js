/* Общи услуги за всяка заявка: склад, ключ-стойност, поща, дневник, кеш. */

import { CFG, envCfg } from './config.js';
import { stamp, str, line, fail } from './util.js';
import { sendMail, msConfig } from './graph.js';
import { sha256 } from './crypto.js';

/* app: { env, cfg, store, kv, ip, agent, mailer, outbox } */
export function makeApp(env, store, kv, req) {
  const h = req ? req.headers : new Headers();
  const ip = cleanIp(h.get('CF-Connecting-IP') || '');
  // приблизително място по IP адреса (от Cloudflare) – за дневника на входовете
  const cf = (req && req.cf) || {};
  const geo = [cf.city, cf.country].map(x => line(x, 60)).filter(Boolean).join(', ');
  return {
    env, store, kv, ip, geo,
    cfg: envCfg(env),
    agent: line(h.get('User-Agent'), 200),
    mailer: env.__mailer || null, // тестовете подменят пощата
    deferred: []
  };
}

export const cleanIp = v => { const t = str(v, 45); return /^[0-9a-fA-F:.]{3,45}$/.test(t) && /[.:]/.test(t) ? t : ''; };

/* имейл: през Microsoft Graph; без настройка писмото се записва само в журнала */
export async function mail(app, to, subject, body) {
  const title = line(subject, 200);
  const text = body + '\n\n--\n' + CFG.MAINTAINER + '\nПоддръжка: ' + app.cfg.support;
  if (app.mailer) { await app.mailer(to, title, text); return true; }
  if (!msConfig(app.env) || !app.env.MAIL_SENDER) {
    console.log('mail (не е настроена поща) до ' + to + ': ' + title);
    return false;
  }
  try {
    await sendMail(app.env, to, title, text, app.cfg.support);
    return true;
  } catch (e) {
    console.error('mail: ' + e.message);
    return false;
  }
}

export async function audit(app, actor, action, ref, details) {
  await app.store.insert('log', { at: stamp(), actor, action, ref: ref || '', details: String(details || '').slice(0, 2000), ip: app.ip });
}

/* ---------- кеш в KV ---------- */

export async function cached(app, key, ttl, load) {
  const hit = await app.kv.get('c:' + key);
  if (hit) return JSON.parse(hit);
  const v = await load();
  if (v) await app.kv.put('c:' + key, JSON.stringify(v), { expirationTtl: Math.max(60, ttl) });
  return v;
}
export const dropCache = (app, key) => app.kv.delete('c:' + key);

/* ---------- ограничаване на опитите ---------- */

export async function throttle(app, id, limit, windowS) {
  const key = 'f:' + (await sha256(id));
  const max = limit || CFG.MAX_FAILS;
  return {
    blocked: async () => (Number(await app.kv.get(key)) || 0) >= max,
    hit: async () => {
      const n = (Number(await app.kv.get(key)) || 0) + 1;
      await app.kv.put(key, String(n), { expirationTtl: windowS || CFG.FAIL_WINDOW_S });
      return n;
    },
    clear: () => app.kv.delete(key)
  };
}

/* ---------- настройки ---------- */

export async function setting(app, key, fallback) {
  const r = (await app.store.list('settings', { key }))[0];
  return r ? r.value : fallback;
}
export async function setSetting(app, key, value) {
  const r = (await app.store.list('settings', { key }))[0];
  if (r) await app.store.patch('settings', r._id, { value });
  else await app.store.insert('settings', { key, value });
}

/*
 * Уникален пореден номер без заключване: записът се добавя, после се проверява дали друг е взел същия номер.
 * Идентификаторите в SharePoint растат, затова при съвпадение остава по-ранният запис, а по-късният взема следващ номер.
 */
export async function insertUnique(app, table, scope, field, make, obj) {
  const rows = await app.store.list(table, scope);
  const used = new Set(rows.map(r => r[field]));
  let n = 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    let value = make(n);
    while (used.has(value)) value = make(++n);
    const rec = await app.store.insert(table, Object.assign({}, obj, { [field]: value }));
    const same = await app.store.list(table, Object.assign({}, scope, { [field]: value }));
    if (!same.some(r => Number(r._id) < Number(rec._id))) return rec;
    await app.store.remove(table, rec._id);
    used.add(value);
  }
  fail('busy', 'Системата е заета. Опитайте отново.');
}
