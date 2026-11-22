/*
 * Регистър на административните структури (ИИСДА) от Портала за отворени данни:
 * https://data.egov.bg/data/view/fd4218f2-72fa-44f2-853b-79aa1d7d6c2a – „Административни структури“ (Администрация на МС).
 * Наборът получава нов ресурс всеки месец; взема се най-новият през публичния API на портала
 * (POST /api/listResources, POST /api/getResourceData). Списъкът (около 600 структури: наименование, ЕИК/БУЛСТАТ, адрес,
 * имейл, телефон, интернет страница) се пази в KV и се проверява за нов ресурс веднъж на ден.
 */

import { fail, str, line, stamp, todayIso } from './util.js';
import { audit } from './core.js';
import { REG_BASIS, DEFAULT_CODE, addresseePersons, setAddresseePersons, addresseeScope } from './persons.js';

export const DATASET = 'fd4218f2-72fa-44f2-853b-79aa1d7d6c2a';
const API = 'https://data.egov.bg/api/';
const KEY = 'reg:iisda', META = 'reg:iisda:meta';

async function call(env, method, body) {
  const f = env.__egov || fetch;
  let r;
  try {
    r = await f(API + method, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ADM-ZDOI4You/1.0 (+https://adm.zdoi.eu)' }, body: JSON.stringify(body) });
  } catch (e) { throw new Error('Порталът за отворени данни не отговаря: ' + e.message); }
  if (!r.ok) throw new Error('Порталът за отворени данни отговори с код ' + r.status + '.');
  const j = await r.json().catch(() => null);
  if (!j || j.success === false) throw new Error('Порталът за отворени данни върна грешка' + (j && j.error ? ': ' + (j.error.message || j.error) : '.'));
  return j;
}

const t = v => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
const phone = (code, list) => {
  const p = t(list);
  if (!p) return '';
  return code && !/^\(?0/.test(p) ? '(' + t(code) + ') ' + p : p;
};
/* пълен адрес: п.к., населено място, улица (ако в адреса от регистъра още няма населеното място) */
function fullAddress(r) {
  const place = t(r[8]);
  let addr = t(r[11]).replace(/^гр\.\s*/i, '');
  if (place && addr.toLowerCase().startsWith(place.toLowerCase())) addr = addr.slice(place.length).replace(/^[\s,]+/, '');
  return [t(r[10]) ? 'п.к. ' + t(r[10]) : '', place, t(r[9]) ? 'р-н ' + t(r[9]) : '', addr].filter(Boolean).join(', ');
}

/* редовете на ресурса → кратки записи */
export function mapRows(data) {
  const headers = data.headers || [];
  const idx = name => headers.findIndex(h => t(h).toLowerCase() === name.toLowerCase());
  // колоните се търсят по име, за да не се счупи при разместване
  const col = { admin: idx('Вид администрация'), kind: idx('Вид административна структура'), name: idx('Административна структура'), eik: idx('ЕИК/БУЛСТАТ'),
    parent: idx('На подчинение на'), oblast: idx('Област'), muni: idx('Община'), place: idx('Населено място'), district: idx('Район'), post: idx('Пощенски код'),
    address: idx('Адрес'), code: idx('Код за междуселищно избиране'), phones: idx('Телефони'), email: idx('Електронна поща'), web: idx('Интернет страница') };
  if (col.name < 0 || col.eik < 0) throw new Error('Наборът е с променена структура (липсват колони „Административна структура“ или „ЕИК/БУЛСТАТ“).');
  const rows = Object.keys(data).filter(k => /^row\d+$/.test(k)).map(k => data[k]).concat(Array.isArray(data.rows) ? data.rows : []);
  const g = (r, k) => (col[k] >= 0 ? r[col[k]] : '');
  return rows.filter(r => Array.isArray(r) && t(g(r, 'name'))).map(r => {
    const norm = [g(r, 'admin'), g(r, 'kind'), g(r, 'name'), g(r, 'eik'), '', g(r, 'parent'), g(r, 'oblast'), g(r, 'muni'), g(r, 'place'), g(r, 'district'), g(r, 'post'), g(r, 'address')];
    return {
      name: t(g(r, 'name')), eik: t(g(r, 'eik')).replace(/\D/g, ''), admin: t(g(r, 'admin')), kind: t(g(r, 'kind')), parent: t(g(r, 'parent')),
      oblast: t(g(r, 'oblast')), muni: t(g(r, 'muni')), address: fullAddress(norm), phone: phone(g(r, 'code'), g(r, 'phones')),
      email: t(g(r, 'email')).toLowerCase().split(/[;,\s]+/)[0] || '', web: t(g(r, 'web'))
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'bg'));
}

/* най-новият ресурс на набора; force – изтегля и при същия ресурс */
export async function refreshRegistry(app, force) {
  const list = await call(app.env, 'listResources', { criteria: { dataset_uri: DATASET } });
  const res = (list.resources || []).slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id) - Number(a.id))[0];
  if (!res) throw new Error('В набора няма ресурси.');
  const meta = JSON.parse((await app.kv.get(META)) || 'null');
  if (!force && meta && meta.uri === res.uri) return Object.assign({ updated: false }, meta);
  const data = (await call(app.env, 'getResourceData', { resource_uri: res.uri })).data || {};
  const items = mapRows(data);
  if (items.length < 50) throw new Error('Ресурсът съдържа твърде малко записи (' + items.length + ') – не е зареден.');
  const m = { uri: res.uri, name: t(res.name), count: items.length, at: stamp(), source: 'https://data.egov.bg/data/view/' + DATASET };
  await app.kv.put(KEY, JSON.stringify(items));
  await app.kv.put(META, JSON.stringify(m));
  return Object.assign({ updated: true }, m);
}

async function loadRegistry(app) {
  const raw = await app.kv.get(KEY);
  if (raw) return JSON.parse(raw);
  await refreshRegistry(app, true);
  return JSON.parse((await app.kv.get(KEY)) || '[]');
}

/* Cron: веднъж на ден проверява за нов месечен ресурс */
export async function registryDaily(app, now = new Date()) {
  const key = 'reg:checked:' + todayIso(now);
  if (await app.kv.get(key)) return { skipped: 'вече проверено' };
  await app.kv.put(key, '1', { expirationTtl: 2 * 86400 });
  const r = await refreshRegistry(app, false);
  return { updated: r.updated, name: r.name, count: r.count };
}

/* ---------- действия ---------- */

const low = s => String(s || '').toLowerCase().replace(/[„“"']/g, '');

export async function registrySearch(d, ctx, app) {
  const all = await loadRegistry(app);
  const q = low(line(d.q, 120)).trim(), kind = line(d.kind, 120), oblast = line(d.oblast, 80);
  const words = q.split(/\s+/).filter(Boolean);
  const hit = x => (!kind || x.kind === kind) && (!oblast || x.oblast === oblast) &&
    words.every(w => low(x.name + ' ' + x.eik + ' ' + x.email + ' ' + x.muni + ' ' + x.parent).includes(w));
  // първо съвпаденията в наименованието (точно, в началото, навсякъде), после по подчинение, имейл и община
  const rank = x => { const n = low(x.name); return !q ? 0 : n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : words.every(w => n.includes(w)) ? 3 : 4; };
  const items = all.filter(hit).map(x => [rank(x), x]).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'bg')).map(p => p[1]);
  const limit = Math.min(Math.max(Number(d.limit) || 50, 1), 700);
  return {
    items: items.slice(0, limit), total: items.length, all: all.length,
    kinds: d.facets ? [...new Set(all.map(x => x.kind))].sort((a, b) => a.localeCompare(b, 'bg')) : undefined,
    oblasts: d.facets ? [...new Set(all.map(x => x.oblast).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'bg')) : undefined,
    meta: JSON.parse((await app.kv.get(META)) || 'null')
  };
}

export async function registryRefresh(d, ctx, app) {
  const r = await refreshRegistry(app, true);
  await audit(app, ctx.username, 'Обновен регистър на административните структури', '', r.name + ' · ' + r.count);
  return r;
}

/* копира избраните структури в „Адресати“ (по ЕИК/БУЛСТАТ; съществуващите се обновяват); до 40 на заявка */
export async function registryImport(d, ctx, app) {
  const eiks = (Array.isArray(d.eiks) ? d.eiks : []).map(x => str(x, 13).replace(/\D/g, '')).filter(Boolean).slice(0, 40);
  if (!eiks.length) fail('required', 'Изберете поне една структура.');
  const code = await addresseeScope(app, ctx, d.person), map = await addresseePersons(app);
  const all = await loadRegistry(app);
  // само адресатите на това лице – всяко лице има свой списък
  const rows = (await app.store.list('addressees')).filter(a => (map[a._id] || DEFAULT_CODE) === code);
  const owned = {};
  let added = 0, updated = 0;
  for (const eik of eiks) {
    const x = all.find(y => y.eik === eik);
    if (!x) continue;
    const v = { type: 'Задължен субект (орган или организация)', name: x.name.slice(0, 200), regBasis: REG_BASIS[2], eik: x.eik, seat: x.muni || '', address: x.address.slice(0, 400),
      oblast: x.oblast, email: x.email, phone: x.phone.slice(0, 40) };
    const cur = rows.find(a => a.eik === x.eik && a.type === v.type) || rows.find(a => a.name === v.name);
    if (cur) {
      const patch = {};
      Object.keys(v).forEach(k => { if (v[k] && v[k] !== (cur[k] || '')) patch[k] = v[k]; });
      if (Object.keys(patch).length) { await app.store.patch('addressees', cur._id, patch); updated++; }
    } else {
      const rec = await app.store.insert('addressees', Object.assign({ by: ctx.username, at: stamp() }, v));
      owned[rec._id] = code;
      rows.push(Object.assign({ _id: rec._id }, v));
      added++;
    }
  }
  if (Object.keys(owned).length && code !== DEFAULT_CODE) await setAddresseePersons(app, owned);
  if (added || updated) await audit(app, ctx.username, 'Адресати от регистъра на администрациите', '', 'добавени ' + added + ', обновени ' + updated);
  return { added, updated };
}
