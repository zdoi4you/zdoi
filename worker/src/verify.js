/*
 * Проверка по ЕИК/БУЛСТАТ в официалните регистри:
 *  – Търговски регистър и регистър на ЮЛНЦ (Агенция по вписванията): JSON на партидата, както я ползва порталът
 *    portal.registryagency.bg/CR/Reports/ActiveConditionTabResult?uic=…  →  GET /CR/api/Deeds/{ЕИК}
 *    (празен отговор – няма такава партида); надписите на полетата – GET /Api/nomenclatures/labels/bg?prefixes=CR_F_
 *  – Регистър БУЛСТАТ: справката „Справка за субект на БУЛСТАТ“ (BIRT) в изгледа preview (HTML без рамки).
 * Резултатът се пази 12 часа в KV. Само публични данни; лични данни на физически лица не се съхраняват отделно.
 */

import { fail, str, stamp, fetchRetry } from './util.js';

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
  const r = await fetchRetry(f, CR + '/Api/nomenclatures/labels/bg?prefixes=CR_F_', { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'bg' } }, 'Търговският регистър (portal.registryagency.bg)', app.env.__cr ? [] : undefined);
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

/* ---------- действие ---------- */

const safe = p => p.catch(e => ({ error: e.message }));

export async function verifyEik(d, ctx, app) {
  const eik = str(d.eik, 20).replace(/\D/g, '');
  if (!/^(\d{9}|\d{13})$/.test(eik)) fail('value', 'Въведете ЕИК/БУЛСТАТ от 9 или 13 цифри.');
  const key = 'chk:' + eik;
  if (!d.fresh) { const hit = await app.kv.get(key); if (hit) return Object.assign(JSON.parse(hit), { cached: true }); }
  const [cr, bulstat] = await Promise.all([safe(checkCR(app, eik)), safe(checkBulstat(app, eik))]);
  const warnings = [];
  if (cr.found && cr.closed) warnings.push('Партидата в Търговския регистър е заличена.');
  if (cr.found && cr.flags && cr.flags.length) warnings.push(...cr.flags.map(x => 'Търговски регистър – ' + x));
  if (bulstat.found && bulstat.state && !bulstat.active) warnings.push('Регистър БУЛСТАТ – състояние: ' + bulstat.state);
  if (!cr.found && !bulstat.found && !cr.error && !bulstat.error) warnings.push('Няма субект с този код нито в Търговския регистър, нито в регистър БУЛСТАТ.');
  const res = { eik, at: stamp(), cr, bulstat, warnings };
  if (!cr.error && !bulstat.error) await app.kv.put(key, JSON.stringify(res), { expirationTtl: 12 * 3600 });
  return res;
}
