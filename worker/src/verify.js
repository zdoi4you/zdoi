/*
 * Проверка по ЕИК/БУЛСТАТ в официалните регистри:
 *  – Търговски регистър и регистър на ЮЛНЦ (Агенция по вписванията): JSON на партидата, както я ползва порталът
 *    portal.registryagency.bg/CR/Reports/ActiveConditionTabResult?uic=…  →  GET /CR/api/Deeds/{ЕИК}
 *    (празен отговор – няма такава партида); надписите на полетата – GET /Api/nomenclatures/labels/bg?prefixes=CR_F_
 *  – Регистър БУЛСТАТ: справката „Справка за субект на БУЛСТАТ“ (BIRT) в изгледа preview (HTML без рамки).
 * Резултатът се пази 12 часа в KV. Само публични данни; лични данни на физически лица не се съхраняват отделно.
 */

import { fail, str, stamp, fetchRetry } from './util.js';
import { audit } from './core.js';

const UA = 'ADM-ZDOI4You/1.0 (+https://adm.zdoi.eu)';
const CR = 'https://portal.registryagency.bg';
const BS = 'https://reports.bulstat.bg/bulstat-ireports';
const BS_REPORT = '__report=https%3A%2F%2Freports.bulstat.bg%2Fbulstat-ireports%2Fv_rpt1.rptdesign';
export const crLink = eik => CR + '/CR/Reports/ActiveConditionTabResult?uic=' + eik;
export const bulstatLink = eik => BS + '/frameset?' + BS_REPORT + '&__format=html&uic=' + eik + '&__overwrite=true&__locale=bg&__svg=true&__designer=false';

const ent = s => String(s || '').replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const text = html => ent(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')).split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

/* ---------- Търговски регистър и регистър на ЮЛНЦ ---------- */

async function crLabels(app) {
  const hit = await app.kv.get('c:crlabels');
  if (hit) return JSON.parse(hit);
  const f = app.env.__cr || fetch;
  const r = await fetchRetry(f, CR + '/Api/nomenclatures/labels/bg?prefixes=CR_F_,CR_APP_IN', { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'bg' } }, 'Търговският регистър (portal.registryagency.bg)', app.env.__cr ? [] : undefined);
  const j = await r.json().catch(() => ({}));
  await app.kv.put('c:crlabels', JSON.stringify(j), { expirationTtl: 30 * 86400 });
  return j;
}

/* партидата: основните полета (без заличените), състоянието и представителите */
export function parseDeed(deed, labels = {}) {
  if (!deed || !deed.uic) return { found: false };
  const general = (deed.sections || []).find(s => /GENERAL_STATUS/.test(s.nameCode || '')) || (deed.sections || [])[0] || {};
  const fields = [];
  for (const sd of general.subDeeds || []) for (const g of sd.groups || []) for (const f of g.fields || []) {
    if (/erasure-text|ui-icon-erased/.test(f.htmlData || '')) continue; // заличено обстоятелство
    const v = text(f.htmlData);
    if (!v) continue;
    fields.push({ code: f.nameCode, label: String(labels[f.nameCode] || f.nameCode).replace(/^\d+[а-я]?\.\s*/, ''), value: v, since: String(f.fieldEntryDate || '').slice(0, 10) });
  }
  const get = n => (fields.find(f => f.code === 'CR_F_' + n + '_L') || {}).value || '';
  const seat = get(5);
  const email = (/Адрес на електронна поща:\s*([^\s\n]+@[^\s\n]+)/.exec(seat) || [])[1] || '';
  const closed = [3, 4].includes(Number(deed.deedStatus));
  // особени състояния: ликвидация, несъстоятелност, прекратяване, заличаване
  const flags = fields.filter(f => /ликвидац|несъстоятелн|прекратяване|заличаване|особен надзор|преобразуване/i.test(f.label)).map(f => f.label + ': ' + f.value.split('\n')[0]);
  // представители и органи на управление – само имената (без текстовете за мандатите), без повторения
  const reps = [...new Set([7, 9, 10, 12, 13, 14].map(get).filter(Boolean).join('\n').split('\n').map(x => x.trim()).filter(x => x && !/^(Начин, по който|мандат)/i.test(x)))].join('\n');
  return {
    found: true, closed, status: closed ? 'заличен' : flags.length ? 'вписан – ' + flags[0] : 'вписан (активен)', flags,
    name: deed.companyName || get(2), fullName: deed.fullName || '', legalForm: get(3),
    seat: seat.replace(/\s*Адрес на електронна поща:.*$/s, '').replace(/\n/g, ', ').replace(/^Държава: БЪЛГАРИЯ,\s*/, ''),
    email, representatives: reps, representation: get(11), owner: get(23), subject: get(6).slice(0, 600),
    fields: fields.slice(0, 60), link: crLink(deed.uic)
  };
}

export async function checkCR(app, eik) {
  const f = app.env.__cr || fetch;
  const r = await fetchRetry(f, CR + '/CR/api/Deeds/' + eik, { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'bg' } }, 'Търговският регистър (portal.registryagency.bg)', app.env.__cr ? [] : undefined);
  const body = await r.text();
  if (!body.trim()) return { found: false, link: crLink(eik) };
  let deed;
  try { deed = JSON.parse(body); } catch (_) { fail('external', 'Търговският регистър върна неочакван отговор.'); }
  return parseDeed(deed, await crLabels(app).catch(() => ({})));
}

/* ---------- регистър БУЛСТАТ ---------- */

/* редовете на справката: [етикет, стойност, „История“, „Документи“] или раздел [етикет, „История“, „Документи“] + следващи редове */
export function parseBulstat(html) {
  if (/ReportServiceException|Няма намерен субект/.test(html) || !/Код по БУЛСТАТ/.test(ent(html))) return { found: false };
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => text(c[1]).replace(/\n/g, ' ')).filter(Boolean))
    .filter(r => r.length && !/^function /.test(r[0]));
  const out = {};
  let section = null;
  for (const r of rows) {
    const tail = r.slice(-2).join('|') === 'История|Документи';
    const cells = tail ? r.slice(0, -2) : r;
    if (tail && cells.length === 1) { section = cells[0]; out[section] = out[section] || []; continue; }
    if (tail && cells.length >= 2) { section = null; out[cells[0]] = [cells.slice(1).join(' ')]; continue; }
    if (section && cells.length === 1 && !/^(Действителни собственици|Юридически лица|Физически лица|Няма намерен)/.test(cells[0])) out[section].push(cells[0]);
    else section = null;
  }
  const one = k => (out[k] || []).filter(v => !/^\*+$/.test(v)).join('; ');
  const subj = one('Нефизическо лице') || one('Физическо лице');
  const m = /^(.*?), държава: ([^,]+)(?:, правна форма: (.*))?$/.exec(subj) || [];
  return {
    found: true, eik: one('Код по БУЛСТАТ'), name: m[1] || subj, legalForm: m[3] || '', state: one('Състояние'),
    // без вписано състояние (напр. търговец от Търговския регистър) – неизвестно, не „неактивен“
    active: one('Състояние') ? /развиващ дейност/i.test(one('Състояние')) : undefined,
    // адресът е в раздела „Адрес“ или под „Дело“ – търси се по началото „седалище и адрес на управление“
    address: (Object.values(out).flat().find(v => /^седалище и адрес на управление:/i.test(v)) || one('Адрес')).replace(/^седалище и адрес на управление:\s*/i, '').replace(/^БЪЛГАРИЯ,\s*/, ''),
    contacts: one('Комуникации'), management: one('Управление'), owners: one('Участие в собствеността'), parent: one('Принадлежност'),
    activity: one('Икономическа дейност (КИД 2025)') || one('Икономическа дейност (КИД 2008)'),
    fields: Object.entries(out).map(([label, v]) => ({ label, value: v.filter(x => !/^\*+$/.test(x)).join('\n') })).filter(f => f.value && f.label !== 'Действителни собственици').slice(0, 40)
  };
}

export async function checkBulstat(app, eik) {
  const f = app.env.__bulstat || fetch;
  const r = await fetchRetry(f, BS + '/preview?' + BS_REPORT + '&__format=html&uic=' + eik + '&__locale=bg', { headers: { 'User-Agent': UA, Accept: 'text/html' } },
    'Регистър БУЛСТАТ (reports.bulstat.bg)', app.env.__bulstat ? [] : undefined);
  return Object.assign(parseBulstat(await r.text()), { link: bulstatLink(eik) });
}

/* ---------- участие в организации (справка „Проверка на лице/организация“ на Агенцията по вписванията) ---------- */

/*
 * GET /CR/api/Deeds/Subjects?name&ident(ЕГН)&selectedSearchFilter=0  – физически лица (кодиран идентификатор)
 * GET /CR/api/Deeds/Summary?name&ident(ЕИК)&selectedSearchFilter=1   – юридически лица
 * GET /CR/api/Deeds/SubjectInFields?uid&name&searchInHistory&type     – партидите и полетата, в които лицето е вписано
 * Обхваща Търговския регистър и регистъра на ЮЛНЦ. ЕГН се ползва само за заявката – не се пази в кеша и в дневника.
 */
async function crGet(app, path) {
  const f = app.env.__cr || fetch;
  const r = await fetchRetry(f, CR + '/CR/api/Deeds/' + path, { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'bg' } },
    'Търговският регистър (portal.registryagency.bg)', app.env.__cr ? [] : undefined);
  const body = await r.text();
  if (!body.trim()) return [];
  try { return JSON.parse(body); } catch (_) { fail('external', 'Търговският регистър върна неочакван отговор.'); }
}
const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

/* партидите, в които субектът участва, групирани по дружество/организация */
async function participation(app, uid, name, physical, history) {
  const labels = await crLabels(app).catch(() => ({}));
  const rows = await crGet(app, 'SubjectInFields?' + qs({ uid, name: physical ? name : '', searchInHistory: history ? 'true' : 'false', type: physical ? 1 : 0 }));
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r.uic) continue;
    const o = map.get(r.uic) || { uic: r.uic, name: t(r.companyFullName), roles: [], flag: '', link: crLink(r.uic) };
    const role = String(labels[r.fieldName] || r.fieldName || '').replace(/^\d+[а-я]?\.\s*/, '');
    if (role && !o.roles.includes(role)) o.roles.push(role);
    if (r.companyNameSuffixFlag) o.flag = labels[r.companyNameSuffixFlag] || (/LIQUIDATION/.test(r.companyNameSuffixFlag) ? 'в ликвидация' : /BANKRUPT|INSOLV/.test(r.companyNameSuffixFlag) ? 'в несъстоятелност' : r.companyNameSuffixFlag);
    map.set(r.uic, o);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'bg'));
}

/* ЕГН: 10 цифри, валидна дата и контролна цифра */
export function egnValid(egn) {
  if (!/^\d{10}$/.test(egn)) return false;
  let y = Number(egn.slice(0, 2)), m = Number(egn.slice(2, 4));
  const d = Number(egn.slice(4, 6));
  if (m > 40) { m -= 40; y += 2000; } else if (m > 20) { m -= 20; y += 1800; } else y += 1900;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  const w = [2, 4, 8, 5, 10, 9, 7, 3, 6];
  const c = w.reduce((s, k, i) => s + k * Number(egn[i]), 0) % 11;
  return (c === 10 ? 0 : c) === Number(egn[9]);
}
const t = v => String(v || '').replace(/\s+/g, ' ').trim();

/* физическо лице: по име и/или ЕГН */
export async function verifyPerson(d, ctx, app) {
  const name = t(str(d.name, 120));
  const egn = str(d.egn, 12).replace(/\D/g, '');
  if (!name && !egn) fail('required', 'Въведете име или ЕГН.');
  if (name && (!/^[А-Яа-яA-Za-z' -]+$/.test(name) || name.split(' ').length < 2)) fail('value', 'Въведете поне собствено и фамилно име (само букви).');
  if (egn && !egnValid(egn)) fail('value', 'Невалидно ЕГН.');
  const history = d.history === true;
  const [subjects, bulstat] = await Promise.all([
    crGet(app, 'Subjects?' + qs({ page: 1, pageSize: 20, name, ident: egn, includeHistory: history ? 'true' : 'false', selectedSearchFilter: 0 })).catch(e => ({ error: e.message })),
    egn ? checkBulstat(app, egn).catch(e => ({ error: e.message })) : Promise.resolve(null)
  ]);
  let people = [];
  if (Array.isArray(subjects)) {
    // до 8 съвпадения по име – за всяко партидите, в които участва
    for (const s of subjects.slice(0, 8)) {
      try { people.push({ name: t(s.name), orgs: await participation(app, s.ident, s.name, true, history) }); } catch (e) { people.push({ name: t(s.name), error: e.message }); }
    }
  }
  if (bulstat && bulstat.found) bulstat.link = ''; // справката по ЕГН не се отваря с връзка (би показала ЕГН в адреса)
  await audit(app, ctx.username, 'Проверка на участие на физическо лице', '', (name || '—') + (egn ? ' · ЕГН ' + egn.slice(0, 2) + '********' : ''));
  return {
    at: stamp(), name, egnGiven: !!egn, history, total: Array.isArray(subjects) ? subjects.length : 0, shown: people.length,
    people, crError: subjects && subjects.error ? subjects.error : '', bulstat: bulstat ? (bulstat.found ? bulstat : { found: false, error: bulstat.error }) : null
  };
}

/* юридическо лице: в кои други организации участва (собственик, съдружник, член на органи) */
export async function orgParticipation(app, eik, history) {
  const orgs = await participation(app, eik, '', false, history);
  return orgs.filter(o => o.uic !== eik);
}

/* ---------- действие ---------- */

const safe = p => p.catch(e => ({ error: e.message }));

export async function verifyEik(d, ctx, app) {
  const eik = str(d.eik, 20).replace(/\D/g, '');
  if (!/^(\d{9}|\d{13})$/.test(eik)) fail('value', 'Въведете ЕИК/БУЛСТАТ от 9 или 13 цифри.');
  const key = 'chk:' + eik;
  if (!d.fresh) { const hit = await app.kv.get(key); if (hit) return Object.assign(JSON.parse(hit), { cached: true }); }
  const [cr, bulstat, part] = await Promise.all([safe(checkCR(app, eik)), safe(checkBulstat(app, eik)), safe(orgParticipation(app, eik, false))]);
  const warnings = [];
  if (cr.found && cr.closed) warnings.push('Партидата в Търговския регистър е заличена.');
  if (cr.found && cr.flags && cr.flags.length) warnings.push(...cr.flags.map(x => 'Търговски регистър – ' + x));
  if (bulstat.found && bulstat.state && !bulstat.active) warnings.push('Регистър БУЛСТАТ – състояние: ' + bulstat.state);
  if (!cr.found && !bulstat.found && !cr.error && !bulstat.error) warnings.push('Няма субект с този код нито в Търговския регистър, нито в регистър БУЛСТАТ.');
  const res = { eik, at: stamp(), cr, bulstat, warnings, participation: Array.isArray(part) ? part : [], participationError: part && part.error ? part.error : '' };
  if (!cr.error && !bulstat.error) await app.kv.put(key, JSON.stringify(res), { expirationTtl: 12 * 3600 });
  return res;
}
