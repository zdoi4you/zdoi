/*
 * Съдебни дела: основни данни, ЕПЕП, съдебен състав, страни, заседания, съдебни актове, книжа, такси и разноски, срокове.
 *
 * Основните полета са колони в списъка „ADM Дела“. Подробностите се пазят като JSON в многоредовата колона „Бележки“
 * ({ v: 2, text, … }), за да не се добавят нови колони в SharePoint; старите бележки (обикновен текст) стават „text“.
 *
 * Процесуалните срокове се изчисляват от датата на съобщаване на акта по реда на делото (АПК или ГПК):
 * в дни и седмици – до съответния ден, в месеци – до същото число; изтичащ в неработен ден срок се мести на
 * следващия работен (чл. 60 ГПК, приложим и по чл. 144 АПК).
 */

import { fail, str, line, stamp, todayIso, isoDate, oneOf, intIn, view, byDesc } from './util.js';
import { term, termMonths, daysBetween } from './calendar.js';
import { audit } from './core.js';
import { canSee, findCase } from './cases.js';
import { reqScope } from './requests.js';

const OBLASTS = ['Благоевград', 'Бургас', 'Варна', 'Велико Търново', 'Видин', 'Враца', 'Габрово', 'Добрич', 'Кърджали', 'Кюстендил', 'Ловеч', 'Монтана', 'Пазарджик', 'Перник', 'Плевен', 'Пловдив', 'Разград', 'Русе', 'Силистра', 'Сливен', 'Смолян', 'Стара Загора', 'Търговище', 'Хасково', 'Шумен', 'Ямбол'];
/* подсказки за съда; може да се въведе и друг */
export const COURTS = [
  ...OBLASTS.slice(0, 21).map(o => 'Административен съд – ' + o), 'Административен съд – София-град', 'Административен съд – София-област', ...OBLASTS.slice(21).map(o => 'Административен съд – ' + o),
  'Върховен административен съд', 'Върховен касационен съд',
  ...['София', 'Пловдив', 'Варна', 'Бургас', 'Велико Търново'].map(o => 'Апелативен съд – ' + o),
  'Софийски градски съд', 'Софийски окръжен съд', ...OBLASTS.map(o => 'Окръжен съд – ' + o),
  'Софийски районен съд', ...OBLASTS.map(o => 'Районен съд – ' + o)
];
export const PROCEDURES = ['АПК', 'ГПК'];
export const COURT_KIND = ['Жалба срещу решение', 'Жалба срещу мълчалив отказ', 'Касационна жалба', 'Частна жалба', 'Искане за отмяна (чл. 239 АПК)',
  'Иск за обезщетение (чл. 203 АПК, ЗОДОВ)', 'Искова молба (ГПК)', 'Въззивна жалба (ГПК)', 'Касационна жалба (ГПК)', 'Изпълнение на съдебен акт', 'Друго'];
export const COURT_INSTANCE = ['Първа инстанция', 'Въззивна инстанция', 'Касационна инстанция'];
const LEGACY_INSTANCE = { 'Административен съд': 'Първа инстанция', 'Върховен административен съд': 'Касационна инстанция' };
export const COURT_STATUS = ['Образувано', 'Оставено без движение', 'Насрочено', 'Отложено', 'Спряно', 'Обявено за решаване', 'Решено', 'Прекратено', 'Обжалвано', 'Влязло в сила'];

/* средства за защита и процесуални срокове: [название, единица (d|w|m), брой, основание]; броят се от съобщаването */
export const REMEDIES = {
  'АПК': [
    ['Касационна жалба', 'd', 14, 'чл. 211, ал. 1 АПК'],
    ['Частна жалба', 'd', 7, 'чл. 230 АПК'],
    ['Отговор на касационна жалба', 'd', 14, 'чл. 213а, ал. 1 АПК'],
    ['Отстраняване на нередовности', 'd', 7, 'чл. 158, ал. 1 АПК'],
    ['Изменение в частта за разноските', 'd', 14, 'чл. 248 ГПК вр. чл. 144 АПК – в срока за обжалване'],
    ['Искане за отмяна на влязъл в сила акт', 'm', 3, 'чл. 240, ал. 1 АПК']
  ],
  'ГПК': [
    ['Въззивна жалба', 'w', 2, 'чл. 259, ал. 1 ГПК'],
    ['Касационна жалба', 'm', 1, 'чл. 283 ГПК'],
    ['Частна жалба', 'w', 1, 'чл. 275, ал. 1 ГПК'],
    ['Отговор на искова молба', 'm', 1, 'чл. 131, ал. 1 ГПК'],
    ['Отговор на въззивна жалба', 'w', 2, 'чл. 263, ал. 1 ГПК'],
    ['Отговор на касационна жалба', 'm', 1, 'чл. 287, ал. 1 ГПК'],
    ['Отстраняване на нередовности', 'w', 1, 'чл. 129, ал. 2 ГПК'],
    ['Изменение в частта за разноските', 'w', 2, 'чл. 248, ал. 1 ГПК – в срока за обжалване'],
    ['Отмяна на влязло в сила решение', 'm', 3, 'чл. 305, ал. 1 ГПК']
  ]
};
export const NO_REMEDY = 'Не подлежи на обжалване';
const remedyNames = [...new Set(Object.values(REMEDIES).flat().map(r => r[0]))];

export const ACT_KINDS = ['Решение', 'Определение', 'Разпореждане', 'Протоколно определение', 'Тълкувателно решение'];
export const ACT_OUTCOMES = ['', 'Отменя обжалвания акт', 'Отменя и връща преписката на органа', 'Обявява нищожност', 'Отхвърля жалбата', 'Уважава частично',
  'Оставя в сила', 'Отменя решението на долната инстанция', 'Оставя без разглеждане', 'Прекратява производството', 'Оставя без движение', 'Насрочва', 'Спира', 'Присъжда разноски', 'Друго'];
export const HEARING_KINDS = ['Открито заседание', 'Закрито заседание'];
export const HEARING_RESULTS = ['', 'Насрочено', 'Даден ход по същество', 'Отложено', 'Обявено за решаване', 'Спряно', 'Прекратено', 'Не е даден ход'];
export const FILING_KINDS = ['Жалба', 'Касационна жалба', 'Частна жалба', 'Искова молба', 'Отговор', 'Молба', 'Становище', 'Писмени бележки', 'Списък на разноските (чл. 80 ГПК)',
  'Доказателства', 'Административна преписка', 'Призовка или съобщение', 'Препис от акт', 'Друго'];
export const FILING_DIR = ['Подадено от нас', 'От другата страна', 'От съда'];
export const FILING_VIA = ['ЕПЕП', 'ССЕВ', 'Поща', 'На място', 'Имейл', 'Чрез органа (чл. 152 АПК)'];
export const FEE_KINDS = ['Държавна такса', 'Депозит за вещо лице', 'Депозит за свидетел', 'Такса за препис или удостоверение', 'Адвокатско възнаграждение',
  'Юрисконсултско възнаграждение', 'Присъдени разноски', 'Глоба', 'Друго'];
export const FEE_STATUS = ['Дължима', 'Платена', 'Присъдена в наша полза', 'Присъдена в наша тежест', 'Събрана', 'Възстановена'];
export const PARTY_ROLES = ['Жалбоподател', 'Ответник', 'Заинтересована страна', 'Касатор', 'Ответник по касация', 'Ищец', 'Ответник по иска', 'Въззивник', 'Въззиваем',
  'Трето лице-помагач', 'Прокуратура', 'Друго'];
export const FORMATIONS = ['', 'Едноличен', 'Тричленен', 'Петчленен'];
export const EPEP_ACCESS = ['', 'Няма', 'Поискан', 'Предоставен'];

export const courtLists = () => ({
  courts: COURTS, courtKinds: COURT_KIND, courtInstances: COURT_INSTANCE, courtStatuses: COURT_STATUS, procedures: PROCEDURES, remedies: REMEDIES, noRemedy: NO_REMEDY,
  actKinds: ACT_KINDS, actOutcomes: ACT_OUTCOMES, hearingKinds: HEARING_KINDS, hearingResults: HEARING_RESULTS, filingKinds: FILING_KINDS, filingDir: FILING_DIR,
  filingVia: FILING_VIA, feeKinds: FEE_KINDS, feeStatus: FEE_STATUS, partyRoles: PARTY_ROLES, formations: FORMATIONS, epepAccess: EPEP_ACCESS
});

/* ---------- подробности (JSON в „Бележки“) ---------- */

const PARTS = ['hearings', 'acts', 'filings', 'fees', 'deadlines', 'parties'];

export function detailsOf(x) {
  const t = String((x && x.note) || '');
  let o = null;
  if (t.startsWith('{')) { try { o = JSON.parse(t); } catch (_) { o = null; } }
  if (!o || o.v !== 2) o = { v: 2, text: t };
  PARTS.forEach(k => { if (!Array.isArray(o[k])) o[k] = []; });
  o.panel = o.panel && typeof o.panel === 'object' ? o.panel : {};
  o.epep = o.epep && typeof o.epep === 'object' ? o.epep : {};
  o.procedure = PROCEDURES.includes(o.procedure) ? o.procedure : 'АПК';
  return o;
}

function remedyOf(procedure, name) {
  return (REMEDIES[procedure] || []).find(r => r[0] === name) || Object.values(REMEDIES).flat().find(r => r[0] === name) || null;
}
const UNIT = { d: n => n + (n === 1 ? ' ден' : ' дни'), w: n => n + (n === 1 ? ' седмица' : ' седмици'), m: n => n + (n === 1 ? ' месец' : ' месеца') };
export function remedyDue(procedure, name, served) {
  const r = remedyOf(procedure, name);
  if (!r || !served) return null;
  const due = r[1] === 'm' ? termMonths(served, r[2]) : term(served, r[1] === 'w' ? r[2] * 7 : r[2]);
  return { due, label: r[0] + ' – ' + UNIT[r[1]](r[2]) + ' (' + r[3] + ')' };
}

/* всички срокове по делото: от актовете, поставените от съда, таксите и заседанията */
export function courtDeadlines(x, det, today = todayIso()) {
  const out = [];
  const add = (date, kind, label, done, extra) => { if (date) out.push(Object.assign({ date, kind, label, done: !!done, daysLeft: daysBetween(today, date) }, extra || {})); };
  det.acts.forEach(a => {
    if (!a.remedy || a.remedy === NO_REMEDY) return;
    const r = a.due ? { due: a.due, label: a.remedy + ' (срок, определен от съда)' } : remedyDue(det.procedure, a.remedy, a.served);
    if (r) add(r.due, 'Срок по акт', r.label + ' срещу ' + a.kind.toLowerCase() + (a.no ? ' № ' + a.no : '') + (a.date ? ' от ' + a.date.split('-').reverse().join('.') : ''), !!(a.appealedOn || a.finalOn), { actId: a.id });
  });
  det.deadlines.forEach(dl => add(dl.due, 'Срок', dl.label + (dl.basis ? ' (' + dl.basis + ')' : ''), dl.done, { id: dl.id }));
  det.fees.filter(f => f.dueDate && f.status === 'Дължима').forEach(f => add(f.dueDate, 'Внасяне', f.kind + (f.amount ? ' ' + f.amount + ' ' + (f.currency || 'EUR') : ''), false, { feeId: f.id }));
  det.hearings.filter(hg => hg.date >= today).forEach(hg => add(hg.date, 'Заседание', hg.kind + (hg.room ? ', зала ' + hg.room : ''), false, { time: hg.time || '' }));
  return out.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

/* суми по таксите и разноските (в евро; левовете – по фиксирания курс 1,95583) */
export function feeTotals(det) {
  const eur = f => { const n = Number(String(f.amount || '0').replace(',', '.')) || 0; return f.currency === 'BGN' ? n / 1.95583 : n; };
  const sum = list => Math.round(list.reduce((s, f) => s + eur(f), 0) * 100) / 100;
  const paid = det.fees.filter(f => f.status === 'Платена' && !/Присъдени/.test(f.kind));
  return {
    paid: sum(paid), due: sum(det.fees.filter(f => f.status === 'Дължима')),
    awardedFor: sum(det.fees.filter(f => f.status === 'Присъдена в наша полза' || f.status === 'Събрана')),
    awardedAgainst: sum(det.fees.filter(f => f.status === 'Присъдена в наша тежест')),
    collected: sum(det.fees.filter(f => f.status === 'Събрана'))
  };
}

export const courtTitle = x => x.court + ' № ' + x.caseNo + '/' + x.year;

/* за списъците и преписките: без суровия JSON, с най-важното от подробностите */
export function courtView(x, today = todayIso()) {
  const o = view(x), det = detailsOf(x);
  o.instance = LEGACY_INSTANCE[o.instance] || o.instance;
  o.note = det.text || '';
  o.procedure = det.procedure;
  o.reporter = det.panel.reporter || '';
  o.epepUrl = det.epep.url || '';
  const open = courtDeadlines(x, det, today).filter(dl => !dl.done && dl.daysLeft >= 0 && dl.kind !== 'Заседание');
  o.nextDeadline = open[0] || null;
  o.counts = { hearings: det.hearings.length, acts: det.acts.length, filings: det.filings.length, fees: det.fees.length };
  return o;
}

/* ---------- видимост ---------- */

/* делото се вижда, ако се вижда преписката му; дело без преписка – от потребител с право „всички преписки“ */
async function visibleRegNos(app, ctx) {
  const cases = (await app.store.list('cases')).filter(c => canSee(c, ctx)).map(c => c.regNo);
  const reqs = (await app.store.list('requests')).filter(await reqScope(app, ctx)).map(r => r.regNo);
  return new Set(cases.concat(reqs));
}
const seen = (x, regs, ctx) => (x.regNo ? regs.has(x.regNo) : !!ctx.perms.casesAll);

export async function visibleCourts(app, ctx) {
  const regs = await visibleRegNos(app, ctx);
  return (await app.store.list('courts')).filter(x => seen(x, regs, ctx));
}

async function findCourt(app, ctx, id) {
  const x = await app.store.get('courts', str(id, 20));
  if (!x || !seen(x, await visibleRegNos(app, ctx), ctx)) fail('notfound', 'Делото не е намерено.');
  return x;
}

const courtEvent = (app, x, user, kind, text) => app.store.insert('events', { regNo: 'ДЕЛО-' + x._id, at: stamp(), user, kind, text: String(text).slice(0, 4000) });
const reqEvent = (app, regNo, user, text) => regNo ? app.store.insert('events', { regNo, at: stamp(), user, kind: 'Дело', text: String(text).slice(0, 4000) }) : null;

/* следващото заседание – най-ранното от днес нататък; без заседания – въведеното на ръка */
function nextHearingOf(det, manual, today = todayIso()) {
  const next = det.hearings.map(hg => hg.date).filter(dt => dt >= today).sort()[0];
  return next || (det.hearings.length ? '' : manual || '');
}

function packDetails(det) {
  const t = JSON.stringify(det);
  if (t.length > 60000) fail('size', 'Данните по делото са твърде много. Преместете дългите текстове в документи.');
  return t;
}

/* ---------- действия ---------- */

export async function courtList(d, ctx, app) {
  const today = todayIso();
  const rows = await visibleCourts(app, ctx);
  return { courts: rows.map(x => courtView(x, today)).sort(byDesc('at')), cases: [...(await visibleRegNos(app, ctx))] };
}

export async function courtGet(d, ctx, app) {
  const x = await findCourt(app, ctx, d.id), det = detailsOf(x), today = todayIso();
  const acts = det.acts.map(a => Object.assign({}, a, { deadline: a.remedy && a.remedy !== NO_REMEDY ? (a.due ? { due: a.due, label: a.remedy + ' (срок, определен от съда)' } : remedyDue(det.procedure, a.remedy, a.served)) : null }));
  const events = await app.store.list('events', { regNo: 'ДЕЛО-' + x._id });
  return {
    court: courtView(x, today), details: Object.assign({}, det, { acts }),
    deadlines: courtDeadlines(x, det, today), totals: feeTotals(det),
    events: events.map(view).sort(byDesc('at'))
  };
}

const url = (v, label) => {
  const t = line(v, 400);
  if (t && !/^https:\/\/([a-z0-9-]+\.)*justice\.bg(\/|$)/i.test(t)) fail('value', label + ' трябва да е адрес в ЕПЕП (https://ecase.justice.bg/…).');
  return t;
};

export async function courtSave(d, ctx, app) {
  const v = {
    regNo: line(d.regNo, 60), court: line(d.court, 160), caseNo: line(d.caseNo, 40), year: intIn(d.year, 2000, 2100, 'Година'),
    kind: oneOf(d.kind, COURT_KIND, 'Вид'), instance: oneOf(LEGACY_INSTANCE[d.instance] || d.instance, COURT_INSTANCE, 'Инстанция'), status: oneOf(d.status, COURT_STATUS, 'Статус'),
    result: line(d.result, 250)
  };
  if (!v.court) fail('required', 'Посочете съда.');
  if (!v.caseNo || !v.year) fail('required', 'Посочете номер и година на делото.');
  // делото се води и при заключена преписка; връзката е към получено (ВХ-…) или изходящо заявление (П-…)
  if (v.regNo && /^П-/.test(v.regNo)) {
    const r = (await app.store.list('requests', { regNo: v.regNo }))[0];
    if (!r || !(await reqScope(app, ctx))(r)) fail('notfound', 'Преписката не е намерена.');
  } else if (v.regNo) await findCase(app, v.regNo, ctx);
  const rows = await app.store.list('courts');
  if (rows.some(x => x.court === v.court && x.caseNo === v.caseNo && x.year === v.year && x._id !== String(d.id || ''))) fail('duplicate', 'Това дело вече е въведено.');
  const cur = d.id ? rows.find(x => x._id === String(d.id)) : null;
  if (d.id && !cur) fail('notfound', 'Делото не е намерено.');
  if (cur && !seen(cur, await visibleRegNos(app, ctx), ctx)) fail('notfound', 'Делото не е намерено.');
  const det = detailsOf(cur || {});
  if (d.note !== undefined) det.text = str(d.note, 8000);
  if (d.procedure !== undefined) det.procedure = oneOf(d.procedure, PROCEDURES, 'Процесуален ред');
  else if (!cur) det.procedure = /ГПК/.test(v.kind) ? 'ГПК' : 'АПК';
  ['instituted'].forEach(k => { if (d[k] !== undefined) det[k] = isoDate(d[k], 'Образувано на'); });
  if (d.subject !== undefined) det.subject = line(d.subject, 400);
  if (d.appealedAct !== undefined) det.appealedAct = line(d.appealedAct, 300);
  if (d.interest !== undefined) det.interest = line(d.interest, 60);
  v.nextHearing = nextHearingOf(det, isoDate(d.nextHearing, 'Следващо заседание'));
  v.note = packDetails(det);
  const title = courtTitle(v);
  if (cur) {
    await app.store.patch('courts', cur._id, Object.assign(v, { updatedAt: stamp() }));
    await courtEvent(app, cur, ctx.username, 'Промяна', 'Основни данни: ' + v.status + (v.result ? ' – ' + v.result : ''));
    if (v.regNo) await reqEvent(app, v.regNo, ctx.username, 'Променено дело: ' + title + ' – ' + v.status);
    await audit(app, ctx.username, 'Промяна на дело', title, v.status);
    return { id: cur._id };
  }
  const rec = await app.store.insert('courts', Object.assign(v, { by: ctx.username, at: stamp(), updatedAt: stamp() }));
  await courtEvent(app, rec, ctx.username, 'Създаване', 'Ново дело: ' + title);
  if (v.regNo) {
    await reqEvent(app, v.regNo, ctx.username, 'Ново дело: ' + title);
    const c = (await app.store.list('cases', { regNo: v.regNo }))[0];
    if (c && c.appealed !== 'Да' && c.locked !== 'Да') await app.store.patch('cases', c._id, { appealed: 'Да', updatedAt: stamp() });
  }
  await audit(app, ctx.username, 'Ново дело', title, '');
  return { id: rec._id };
}

/* ---------- части на делото ---------- */

const amount = v => {
  const t = str(v, 20).replace(/\s/g, '').replace(',', '.');
  if (!t) return '';
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(t)) fail('value', 'Невалидна сума: ' + t);
  return t;
};
const time = v => { const t = str(v, 5); if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) fail('value', 'Невалиден час: ' + t); return t; };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const ITEM = {
  hearings: d => {
    const o = { date: isoDate(d.date, 'Дата на заседанието'), time: time(d.time), kind: oneOf(d.kind || HEARING_KINDS[0], HEARING_KINDS, 'Вид заседание'), room: line(d.room, 40),
      result: oneOf(d.result || '', HEARING_RESULTS, 'Резултат'), attendee: line(d.attendee, 160), note: str(d.note, 3000) };
    if (!o.date) fail('required', 'Посочете датата на заседанието.');
    return [o, 'заседание ' + o.date.split('-').reverse().join('.') + (o.time ? ' ' + o.time : '') + (o.result ? ' – ' + o.result : '')];
  },
  acts: d => {
    const remedy = str(d.remedy, 80);
    if (remedy && remedy !== NO_REMEDY && !remedyNames.includes(remedy)) fail('value', 'Невалидно средство за защита.');
    const o = { kind: oneOf(d.kind, ACT_KINDS, 'Вид акт'), no: line(d.no, 40), date: isoDate(d.date, 'Дата на акта'), served: isoDate(d.served, 'Съобщено на'),
      outcome: oneOf(d.outcome || '', ACT_OUTCOMES, 'Резултат'), summary: str(d.summary, 4000), remedy, due: isoDate(d.due, 'Срок, определен от съда'),
      appealedOn: isoDate(d.appealedOn, 'Обжалвано на'), finalOn: isoDate(d.finalOn, 'Влязъл в сила на') };
    if (!o.date) fail('required', 'Посочете датата на акта.');
    if (o.served && o.served < o.date) fail('date', 'Актът не може да е съобщен преди датата му.');
    return [o, o.kind.toLowerCase() + (o.no ? ' № ' + o.no : '') + ' от ' + o.date.split('-').reverse().join('.') + (o.outcome ? ' – ' + o.outcome : '')];
  },
  filings: d => {
    const o = { date: isoDate(d.date, 'Дата'), kind: oneOf(d.kind, FILING_KINDS, 'Вид'), dir: oneOf(d.dir || FILING_DIR[0], FILING_DIR, 'Посока'), inNo: line(d.inNo, 40),
      via: oneOf(d.via || FILING_VIA[0], FILING_VIA, 'Начин'), note: str(d.note, 3000) };
    if (!o.date) fail('required', 'Посочете датата.');
    return [o, o.kind.toLowerCase() + ' (' + o.dir.toLowerCase() + ', ' + o.via + ')' + (o.inNo ? ' вх. № ' + o.inNo : '')];
  },
  fees: d => {
    const o = { kind: oneOf(d.kind, FEE_KINDS, 'Вид'), amount: amount(d.amount), currency: oneOf(d.currency || 'EUR', ['EUR', 'BGN'], 'Валута'), status: oneOf(d.status || 'Дължима', FEE_STATUS, 'Състояние'),
      dueDate: isoDate(d.dueDate, 'Срок за внасяне'), date: isoDate(d.date, 'Дата на плащане'), payer: line(d.payer, 160), doc: line(d.doc, 80), basis: line(d.basis, 160), note: str(d.note, 2000) };
    if (!o.amount && o.status !== 'Дължима') fail('required', 'Посочете сумата.');
    return [o, o.kind.toLowerCase() + (o.amount ? ' ' + o.amount + ' ' + o.currency : '') + ' – ' + o.status.toLowerCase()];
  },
  deadlines: d => {
    const o = { label: line(d.label, 200), due: isoDate(d.due, 'Срок'), basis: line(d.basis, 160), done: d.done === true || d.done === 'Да', note: str(d.note, 2000) };
    if (!o.label || !o.due) fail('required', 'Посочете какво и до кога.');
    return [o, 'срок до ' + o.due.split('-').reverse().join('.') + ': ' + o.label + (o.done ? ' (изпълнено)' : '')];
  },
  parties: d => {
    const o = { role: oneOf(d.role, PARTY_ROLES, 'Качество'), name: line(d.name, 250), rep: line(d.rep, 250), contact: line(d.contact, 250), note: line(d.note, 300) };
    if (!o.name) fail('required', 'Посочете името на страната.');
    return [o, o.role.toLowerCase() + ': ' + o.name];
  }
};
const PART_LABEL = { hearings: 'Заседание', acts: 'Съдебен акт', filings: 'Книжа', fees: 'Такса/разноски', deadlines: 'Срок', parties: 'Страна' };

/*
 * Промяна на част: { id, part, item } добавя или променя (item.id), { id, part, remove: itemId } премахва,
 * { id, part, items: [...] } добавя няколко (при попълване от ЕПЕП); part „panel“ / „epep“ – обект.
 */
export async function courtPart(d, ctx, app) {
  const x = await findCourt(app, ctx, d.id), det = detailsOf(x), part = str(d.part, 20);
  const changes = [];
  if (part === 'panel') {
    const p = d.item || {};
    det.panel = { formation: oneOf(p.formation || '', FORMATIONS, 'Състав'), division: line(p.division, 120), chair: line(p.chair, 120), members: line(p.members, 300),
      reporter: line(p.reporter, 120), prosecutor: line(p.prosecutor, 160), clerk: line(p.clerk, 120) };
    changes.push('Съдебен състав: ' + [det.panel.formation, det.panel.division, det.panel.reporter ? 'докладчик ' + det.panel.reporter : ''].filter(Boolean).join(', '));
  } else if (part === 'epep') {
    const p = d.item || {};
    det.epep = { url: url(p.url, 'Връзката'), id: line(p.id, 80), access: oneOf(p.access || '', EPEP_ACCESS, 'Достъп'), profile: line(p.profile, 160),
      eserve: p.eserve === true || p.eserve === 'Да', checkedAt: isoDate(p.checkedAt, 'Проверено в ЕПЕП на') };
    changes.push('ЕПЕП: ' + [det.epep.access ? 'достъп – ' + det.epep.access.toLowerCase() : '', det.epep.eserve ? 'електронни съобщения' : ''].filter(Boolean).join(', '));
  } else if (PARTS.includes(part)) {
    const list = det[part];
    if (d.remove) {
      const i = list.findIndex(it => it.id === str(d.remove, 20));
      if (i < 0) fail('notfound', 'Записът не е намерен.');
      changes.push('Премахнато: ' + PART_LABEL[part].toLowerCase());
      list.splice(i, 1);
    } else {
      const items = Array.isArray(d.items) ? d.items.slice(0, 50) : [d.item || {}];
      for (const raw of items) {
        const [o, text] = ITEM[part](raw || {});
        const id = str(raw && raw.id, 20), i = id ? list.findIndex(it => it.id === id) : -1;
        if (id && i < 0) fail('notfound', 'Записът не е намерен.');
        if (i >= 0) { list[i] = Object.assign({ id }, o); changes.push(PART_LABEL[part] + ' (промяна): ' + text); } else { list.push(Object.assign({ id: newId() }, o)); changes.push(PART_LABEL[part] + ': ' + text); }
      }
    }
    const order = { hearings: 'date', acts: 'date', filings: 'date', fees: 'dueDate', deadlines: 'due' }[part];
    if (order) list.sort((a, b) => String(a[order] || a.date || '').localeCompare(String(b[order] || b.date || '')));
  } else fail('value', 'Невалидна част на делото.');
  const patch = { note: packDetails(det), updatedAt: stamp() };
  if (part === 'hearings') patch.nextHearing = nextHearingOf(det, x.nextHearing);
  // статусът следва заседанията и актовете, ако не е сменен на ръка
  if (part === 'hearings' && d.item && d.item.result === 'Обявено за решаване') patch.status = 'Обявено за решаване';
  if (part === 'hearings' && d.item && d.item.result === 'Отложено' && x.status !== 'Отложено') patch.status = 'Отложено';
  if (part === 'acts' && d.item && d.item.kind === 'Решение' && !['Обжалвано', 'Влязло в сила'].includes(x.status)) patch.status = d.item.finalOn ? 'Влязло в сила' : d.item.appealedOn ? 'Обжалвано' : 'Решено';
  await app.store.patch('courts', x._id, patch);
  for (const c of changes) await courtEvent(app, x, ctx.username, PART_LABEL[part] || 'Промяна', c);
  if (x.regNo && ['hearings', 'acts'].includes(part) && !d.remove) await reqEvent(app, x.regNo, ctx.username, courtTitle(x) + ': ' + changes.join('; '));
  await audit(app, ctx.username, 'Дело: ' + (PART_LABEL[part] || part), courtTitle(x), changes.join('; ').slice(0, 500));
  return { ok: true };
}

export async function courtDelete(d, ctx, app) {
  const cur = await findCourt(app, ctx, d.id);
  if (!ctx.admin && cur.by !== ctx.username) fail('role', 'Делото се изтрива от въвелия го или администратор.');
  await app.store.remove('courts', cur._id);
  const title = courtTitle(cur);
  if (cur.regNo) await reqEvent(app, cur.regNo, ctx.username, 'Изтрито дело: ' + title);
  await audit(app, ctx.username, 'Изтрито дело', title, '');
  return {};
}
