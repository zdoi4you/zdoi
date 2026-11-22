/*
 * Регистър на административните структури (ИИСДА) от Портала за отворени данни:
 * https://data.egov.bg/data/view/fd4218f2-72fa-44f2-853b-79aa1d7d6c2a – „Административни структури“ (Администрация на МС).
 * Наборът получава нов ресурс всеки месец; взема се най-новият през публичния API на портала
 * (POST /api/listResources, POST /api/getResourceData). Списъкът (около 600 структури: наименование, ЕИК/БУЛСТАТ, адрес,
 * имейл, телефон, интернет страница) се пази в KV и се проверява за нов ресурс веднъж на ден.
 * Втори източник: училищата, детските градини и центровете от отворените данни на МОН (вж. по-долу).
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

/* ---------- училища, детски градини и центрове (МОН) ---------- */

/*
 * „Списък на директорите на държавните, общинските и частните детски градини, училища и обслужващи звена, с данни за
 * контакт“ (МОН, data.egov.bg): код по НЕИСПУО, наименование, директор, област, община, населено място, адрес, п.к., сайт.
 * Обновява се в началото на учебната година и при актуализирания списък-образец. Без БУЛСТАТ и имейл – те се добавят
 * с импорт на файл от регистъра на институциите (ri.mon.bg), свързан по кода по НЕИСПУО.
 */
export const DATASET_MON = '9d72ecff-e079-48a4-bc0a-1312bff178f6';
const MON = { key: 'reg:mon', meta: 'reg:mon:meta', extra: 'reg:mon:extra' };

const SCHOOL_KINDS = [['детска градина', 'Детска градина'], ['начално училище', 'Начално училище'], ['основно училище', 'Основно училище'], ['обединено училище', 'Обединено училище'],
  ['средно училище', 'Средно училище'], ['профилирана гимназия', 'Профилирана гимназия'], ['професионална', 'Професионална гимназия или колеж'], ['гимназия', 'Гимназия'],
  ['спортно училище', 'Спортно училище'], ['училище по изкуствата', 'Училище по изкуствата или културата'], ['център за подкрепа', 'Център за подкрепа за личностно развитие'],
  ['център за специална', 'Център за специална образователна подкрепа'], ['регионален център', 'Регионален център за подкрепа на приобщаващото образование'],
  ['обслужващо звено', 'Специализирано обслужващо звено'], ['училище', 'Друго училище']];
// латинските букви, сбъркани с кирилски (o, a, e, c, p, x), се уеднаквяват
const LAT = { o: 'о', a: 'а', e: 'е', c: 'с', p: 'р', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', h: 'н', b: 'в' };
export const schoolKind = name => { const n = String(name || '').toLowerCase().replace(/[oaecpxykmthb]/g, ch => LAT[ch]); const m = SCHOOL_KINDS.find(([k]) => n.includes(k)); return m ? m[1] : 'Друга институция'; };

/* редовете: обекти ({InstId, InstName…} при автоматичното качване) или таблица с ред-заглавие („Код по НЕИСПУО“…) */
export function mapMonRows(data) {
  const list = Array.isArray(data) ? data : Object.keys(data || {}).filter(k => /^row\d+$/.test(k)).map(k => data[k]).concat(Array.isArray(data && data.rows) ? data.rows : []);
  let objs;
  if (list.length && list[0] && !Array.isArray(list[0]) && typeof list[0] === 'object') objs = list;
  else {
    const all = (data && data.headers ? [data.headers] : []).concat(list).filter(Array.isArray);
    const hi = all.findIndex(r => r.some(c => /НЕИСПУО/i.test(t(c))));
    if (hi < 0) throw new Error('Наборът на МОН е с променена структура (липсва колона „Код по НЕИСПУО“).');
    const h = all[hi].map(c => t(c).toLowerCase());
    const col = re => h.findIndex(c => re.test(c));
    const ix = { id: col(/неиспуо/), name: col(/име на институция|наименование/), dir: col(/директор/), reg: col(/област/), mun: col(/община/), town: col(/населено/), addr: col(/адрес/), post: col(/пощенски/), web: col(/сайт|уеб/) };
    objs = all.slice(hi + 1).map(r => ({ InstId: r[ix.id], InstName: r[ix.name], First_LastName_dir: r[ix.dir], InstRegName: r[ix.reg], InstMunName: r[ix.mun], InstTownName: r[ix.town], InstAddress: r[ix.addr], InstPostCode: r[ix.post], Website: r[ix.web] }));
  }
  return objs.filter(o => o && t(o.InstId) && t(o.InstName)).map(o => {
    const town = t(o.InstTownName), addr = t(o.InstAddress);
    return {
      key: 'mon:' + t(o.InstId), code: t(o.InstId).replace(/\D/g, ''), name: t(o.InstName), director: t(o.First_LastName_dir),
      kind: schoolKind(o.InstName), oblast: t(o.InstRegName), muni: t(o.InstMunName),
      address: [t(o.InstPostCode) ? 'п.к. ' + t(o.InstPostCode) : '', town, addr && !addr.toLowerCase().startsWith(town.toLowerCase()) ? addr : addr.slice(town.length).replace(/^[\s,]+/, '') || ''].filter(Boolean).join(', '),
      web: t(o.Website), eik: '', email: '', phone: '', parent: ''
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'bg'));
}

/* ---------- общо за двата източника ---------- */

const SOURCES = {
  iisda: { dataset: DATASET, key: KEY, meta: META, map: mapRows, min: 50, label: 'регистъра на административните структури' },
  mon: { dataset: DATASET_MON, key: MON.key, meta: MON.meta, map: mapMonRows, min: 500, label: 'списъка на училищата и детските градини (МОН)' }
};
const src = s => SOURCES[s] || SOURCES.iisda;

/* най-новият ресурс на набора; force – изтегля и при същия ресурс */
export async function refreshRegistry(app, force, source = 'iisda') {
  const S = src(source);
  const list = await call(app.env, 'listResources', { criteria: { dataset_uri: S.dataset } });
  const res = (list.resources || []).slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || Number(b.id) - Number(a.id))[0];
  if (!res) throw new Error('В набора няма ресурси.');
  const meta = JSON.parse((await app.kv.get(S.meta)) || 'null');
  if (!force && meta && meta.uri === res.uri) return Object.assign({ updated: false }, meta);
  const data = (await call(app.env, 'getResourceData', { resource_uri: res.uri })).data || {};
  const items = S.map(data);
  if (items.length < S.min) throw new Error('Ресурсът съдържа твърде малко записи (' + items.length + ') – не е зареден.');
  const m = { uri: res.uri, name: t(res.name), count: items.length, at: stamp(), source: 'https://data.egov.bg/data/view/' + S.dataset };
  await app.kv.put(S.key, JSON.stringify(items));
  await app.kv.put(S.meta, JSON.stringify(Object.assign({}, meta && meta.extraAt ? { extraAt: meta.extraAt, extraCount: meta.extraCount, extraName: meta.extraName } : {}, m)));
  return Object.assign({ updated: true }, m);
}

/* училищата – с добавените от ri.mon.bg БУЛСТАТ, имейл и телефон */
async function loadRegistry(app, source = 'iisda') {
  const S = src(source);
  let raw = await app.kv.get(S.key);
  if (!raw) { await refreshRegistry(app, true, source); raw = (await app.kv.get(S.key)) || '[]'; }
  const items = JSON.parse(raw);
  if (source !== 'mon') return items;
  const extra = JSON.parse((await app.kv.get(MON.extra)) || '{}');
  return items.map(x => { const e = extra[x.code]; return e ? Object.assign({}, x, { eik: e.b || '', email: e.e || '', phone: e.p || '' }) : x; });
}

/* Cron: веднъж на ден проверява двата набора за нов ресурс */
export async function registryDaily(app, now = new Date()) {
  const key = 'reg:checked:' + todayIso(now);
  if (await app.kv.get(key)) return { skipped: 'вече проверено' };
  await app.kv.put(key, '1', { expirationTtl: 2 * 86400 });
  const out = {};
  for (const s of Object.keys(SOURCES)) {
    try { const r = await refreshRegistry(app, false, s); out[s] = { updated: r.updated, count: r.count }; } catch (e) { out[s] = { error: e.message }; }
  }
  return Object.assign({ updated: Object.values(out).some(x => x.updated) }, out);
}

/* ---------- действия ---------- */

const low = s => String(s || '').toLowerCase().replace(/[„“"']/g, '');

export async function registrySearch(d, ctx, app) {
  const source = d.source === 'mon' ? 'mon' : 'iisda';
  const all = await loadRegistry(app, source);
  const q = low(line(d.q, 120)).trim(), kind = line(d.kind, 120), oblast = line(d.oblast, 80);
  const words = q.split(/\s+/).filter(Boolean);
  const hit = x => (!kind || x.kind === kind) && (!oblast || x.oblast === oblast) &&
    words.every(w => low([x.name, x.eik, x.code, x.email, x.muni, x.parent, x.director].join(' ')).includes(w));
  // първо съвпаденията в наименованието (точно, в началото, навсякъде), после по останалите полета
  const rank = x => { const n = low(x.name); return !q ? 0 : n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : words.every(w => n.includes(w)) ? 3 : 4; };
  const items = all.filter(hit).map(x => [rank(x), x]).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'bg')).map(p => p[1]);
  const limit = Math.min(Math.max(Number(d.limit) || 50, 1), 700);
  return {
    source, items: items.slice(0, limit), total: items.length, all: all.length,
    withEik: source === 'mon' ? all.filter(x => x.eik).length : undefined,
    kinds: d.facets ? [...new Set(all.map(x => x.kind))].sort((a, b) => a.localeCompare(b, 'bg')) : undefined,
    oblasts: d.facets ? [...new Set(all.map(x => x.oblast).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'bg')) : undefined,
    meta: JSON.parse((await app.kv.get(src(source).meta)) || 'null')
  };
}

export async function registryRefresh(d, ctx, app) {
  const source = d.source === 'mon' ? 'mon' : 'iisda';
  const r = await refreshRegistry(app, true, source);
  await audit(app, ctx.username, 'Обновен ' + src(source).label, '', r.name + ' · ' + r.count);
  return r;
}

/*
 * БУЛСТАТ, имейл и телефон на училищата от регистъра на институциите (ri.mon.bg) – файлът се чете в браузъра и тук идват
 * само редовете { code (по НЕИСПУО), bulstat, email, phone }. В регистъра кодът е в колона „ЕИК“, но училищата се
 * регистрират по БУЛСТАТ – записва се като код по БУЛСТАТ. Новият импорт допълва и обновява предишния.
 */
export async function registryMonImport(d, ctx, app) {
  const rows = Array.isArray(d.rows) ? d.rows.slice(0, 20000) : [];
  if (!rows.length) fail('required', 'Файлът не съдържа редове с код по НЕИСПУО.');
  const items = await loadRegistry(app, 'mon'), known = new Set(items.map(x => x.code));
  const extra = JSON.parse((await app.kv.get(MON.extra)) || '{}');
  let matched = 0, unknown = 0, bad = 0;
  for (const r of rows) {
    const code = str(r && r.code, 12).replace(/\D/g, '');
    if (!code) continue;
    if (!known.has(code)) { unknown++; continue; }
    const b = str(r.bulstat, 20).replace(/\D/g, ''), e = line(r.email, 200).toLowerCase().split(/[;,\s]+/)[0] || '', p = line(r.phone, 60);
    const ok = { b: /^(\d{9}|\d{13})$/.test(b) ? b : '', e: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '', p };
    if (b && !ok.b) bad++;
    if (!ok.b && !ok.e && !ok.p) continue;
    extra[code] = Object.assign({}, extra[code] || {}, Object.fromEntries(Object.entries(ok).filter(([, v]) => v)));
    matched++;
  }
  await app.kv.put(MON.extra, JSON.stringify(extra));
  const meta = JSON.parse((await app.kv.get(MON.meta)) || '{}');
  await app.kv.put(MON.meta, JSON.stringify(Object.assign(meta, { extraAt: stamp(), extraCount: Object.keys(extra).length, extraName: line(d.fileName, 200) })));
  await audit(app, ctx.username, 'Импорт от регистъра на институциите (МОН)', '', 'съвпаднали ' + matched + ', непознати ' + unknown + (bad ? ', невалиден БУЛСТАТ ' + bad : ''));
  return { matched, unknown, bad, total: Object.keys(extra).length };
}

/* копира избраните в „Адресати“ на лицето (структурите – по ЕИК/БУЛСТАТ, училищата – по код по НЕИСПУО); до 40 на заявка */
export async function registryImport(d, ctx, app) {
  const source = d.source === 'mon' ? 'mon' : 'iisda';
  const keys = (Array.isArray(d.keys) ? d.keys : Array.isArray(d.eiks) ? d.eiks : []).map(x => str(x, 20)).filter(Boolean).slice(0, 40);
  if (!keys.length) fail('required', 'Изберете поне една институция.');
  const code = await addresseeScope(app, ctx, d.person), map = await addresseePersons(app);
  const all = await loadRegistry(app, source);
  // само адресатите на това лице – всяко лице има свой списък
  const rows = (await app.store.list('addressees')).filter(a => (map[a._id] || DEFAULT_CODE) === code);
  const owned = {};
  let added = 0, updated = 0;
  for (const k of keys) {
    const x = source === 'mon' ? all.find(y => y.key === k || y.code === k.replace(/\D/g, '')) : all.find(y => y.eik === k.replace(/\D/g, ''));
    if (!x) continue;
    const v = { type: 'Задължен субект (орган или организация)', name: x.name.slice(0, 200), regBasis: REG_BASIS[2], eik: x.eik, seat: x.muni || '', address: x.address.slice(0, 400),
      oblast: x.oblast, email: x.email, phone: (x.phone || '').slice(0, 40) };
    const cur = (x.eik && rows.find(a => a.eik === x.eik)) || rows.find(a => a.name === v.name && (a.seat || '') === v.seat) || rows.find(a => a.name === v.name && !v.seat);
    if (cur) {
      const patch = {};
      Object.keys(v).forEach(f => { if (v[f] && v[f] !== (cur[f] || '')) patch[f] = v[f]; });
      if (Object.keys(patch).length) { await app.store.patch('addressees', cur._id, patch); updated++; }
    } else {
      const rec = await app.store.insert('addressees', Object.assign({ by: ctx.username, at: stamp() }, v));
      owned[rec._id] = code;
      rows.push(Object.assign({ _id: rec._id }, v));
      added++;
    }
  }
  if (Object.keys(owned).length && code !== DEFAULT_CODE) await setAddresseePersons(app, owned);
  if (added || updated) await audit(app, ctx.username, 'Адресати от ' + src(source).label, '', 'добавени ' + added + ', обновени ' + updated);
  return { added, updated };
}
