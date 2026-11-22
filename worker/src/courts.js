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
import { audit, mail } from './core.js';
import { canSee, findCase } from './cases.js';
import { reqScope } from './requests.js';
import { allowedCodes, codeOf, DEFAULT_CODE } from './persons.js';
import { assignCheck, usersBrief } from './users.js';
import { notifyOf } from './auth.js';
import { epepSearch, epepFetch, gidOf, caseUrl } from './epep.js';

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
/* делата по ЗДОИ – първите три; останалите са за свързани производства (частна жалба, отмяна, обезщетение, изпълнение) */
export const ZDOI_KINDS = ['Жалба срещу решение', 'Жалба срещу мълчалив отказ', 'Жалба на трето лице срещу предоставяне на достъп'];
export const COURT_KIND = ZDOI_KINDS.concat(['Касационна жалба', 'Частна жалба', 'Искане за отмяна (чл. 239 АПК)',
  'Иск за обезщетение (чл. 203 АПК, ЗОДОВ)', 'Изпълнение на съдебен акт', 'Искова молба (ГПК)', 'Въззивна жалба (ГПК)', 'Касационна жалба (ГПК)', 'Друго']);
/* за новите дела: само административните производства (ГПК се прилага субсидиарно по чл. 144 АПК) */
export const COURT_KIND_NEW = COURT_KIND.filter(k => !/ГПК/.test(k));
/* чл. 40, ал. 3 ЗДОИ: решението на административния съд по жалба по ЗДОИ е окончателно */
export const ZDOI_FINAL = 'Окончателно (чл. 40, ал. 3 ЗДОИ)';
/* ориентировъчни държавни такси (от 01.01.2026 в евро) – проверяват се по указанията на съда */
export const FEE_PRESETS = [
  ['Държавна такса – жалба (гражданин, ЕТ, ЮЛНЦ)', '5.11', 'Тарифа за държавните такси по ГПК, т. 2 (вр. чл. 151, т. 3 АПК)'],
  ['Държавна такса – жалба (търговец, друго юридическо лице)', '25.56', 'Тарифа за държавните такси по ГПК, т. 2 (вр. чл. 151, т. 3 АПК)']
];
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

export const ACT_KINDS = ['Решение', 'Определение', 'Разпореждане', 'Протоколно определение', 'Протокол', 'Изпълнителен лист', 'Тълкувателно решение', 'Друг акт'];
/* резултати, след които органът дължи ново произнасяне */
const RETURNED = ['Отменя и връща преписката на органа', 'Отменя обжалвания акт', 'Обявява нищожност', 'Уважава частично'];
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
  'Трето лице-помагач', 'Прокуратура', 'Адвокат', 'Друго'];
export const FORMATIONS = ['', 'Едноличен', 'Тричленен', 'Петчленен'];
export const EPEP_ACCESS = ['', 'Няма', 'Поискан', 'Предоставен'];

export const courtLists = () => ({
  courts: COURTS, courtKinds: COURT_KIND, courtKindsNew: COURT_KIND_NEW, zdoiKinds: ZDOI_KINDS, zdoiFinal: ZDOI_FINAL, feePresets: FEE_PRESETS, courtInstances: COURT_INSTANCE, courtStatuses: COURT_STATUS, procedures: PROCEDURES, remedies: REMEDIES, noRemedy: NO_REMEDY,
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
  o.owner = typeof o.owner === 'string' ? o.owner : '';
  return o;
}
const isZdoi = (x, det) => ZDOI_KINDS.includes(x.kind) && (det.procedure || 'АПК') === 'АПК';

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
    // отменен отказ: органът дължи ново решение – ориентировъчно 14 дни от влизането в сила (чл. 28, ал. 1 ЗДОИ, указанията на съда по чл. 173, ал. 2 АПК)
    if (a.kind === 'Решение' && RETURNED.includes(a.outcome) && a.finalOn && isZdoi(x, det)) {
      add(term(a.finalOn, 14), 'Изпълнение', 'Органът трябва да се произнесе отново по заявлението (чл. 28, ал. 1 ЗДОИ вр. чл. 173, ал. 2 АПК); при бездействие – чл. 304 АПК', !!det.executedOn, { actId: a.id });
    }
    if (!a.remedy || a.remedy === NO_REMEDY || a.remedy === ZDOI_FINAL) return;
    const r = a.due ? { due: a.due, label: a.remedy + ' (срок, определен от съда)' } : remedyDue(det.procedure, a.remedy, a.served);
    if (r) add(r.due, 'Срок по акт', r.label + ' срещу ' + a.kind.toLowerCase() + (a.no ? ' № ' + a.no : '') + (a.date ? ' от ' + a.date.split('-').reverse().join('.') : ''), !!(a.appealedOn || a.finalOn), { actId: a.id });
  });
  // жалбата се подава чрез органа: той я изпраща на съда в 3-дневен срок след изтичането на сроковете за оспорване (чл. 152, ал. 2 АПК)
  det.filings.filter(f => f.dir === 'Подадено от нас' && /Жалба/.test(f.kind) && /чл\. 152/.test(f.via)).forEach(f => {
    const from = det.appealBy && det.appealBy > f.date ? det.appealBy : f.date;
    add(term(from, 3), 'Срок на органа', 'Органът трябва да изпрати жалбата и преписката на съда (чл. 152, ал. 2 АПК) – проверете дали е образувано дело', !!(det.instituted || det.epep.gid), {});
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
  o.owner = det.owner;
  o.zdoi = isZdoi(x, det);
  o.instituted = det.instituted || '';
  const resp = det.parties.find(p => /^Ответник/.test(p.role));
  o.respondent = resp ? resp.name : '';
  const dec = det.acts.filter(a => a.kind === 'Решение').sort((a, b) => b.date.localeCompare(a.date))[0];
  o.decision = dec ? { date: dec.date, outcome: dec.outcome || '', finalOn: dec.finalOn || '' } : null;
  o.durationDays = det.instituted && dec ? daysBetween(det.instituted, dec.date) : null;
  o.totals = feeTotals(det);
  o.epep = { gid: det.epep.gid || gidOf(det.epep.url), syncedAt: det.epep.syncedAt || '', error: det.epep.error || '' };
  return o;
}

/* ---------- видимост ---------- */

/* делото се вижда, ако се вижда преписката му; дело без преписка – от потребител с право „всички преписки“ */
/*
 * Лицето на делото: на заявлението (П-…), Сдружението – за входящия регистър (ВХ-…), записаното при въвеждане – за дело
 * без преписка. Делото се вижда само при достъп до лицето му и ако се вижда преписката (или потребителят е отговорник
 * или въвел делото без преписка; дело без преписка – и с право „всички преписки“).
 */
async function courtScope(app, ctx) {
  const codes = await allowedCodes(app, ctx);
  const reqs = await app.store.list('requests'), see = await reqScope(app, ctx);
  const reqPerson = new Map(reqs.map(r => [r.regNo, codeOf(r)]));
  const cases = (await app.store.list('cases')).filter(c => canSee(c, ctx)).map(c => c.regNo);
  const regs = new Set(cases.concat(reqs.filter(see).map(r => r.regNo)));
  const personOf = x => (x.regNo ? reqPerson.get(x.regNo) || DEFAULT_CODE : detailsOf(x).person || DEFAULT_CODE);
  const seen = x => codes.includes(personOf(x)) &&
    ((x.regNo ? regs.has(x.regNo) : !!ctx.perms.casesAll) || detailsOf(x).owner === ctx.username || (!x.regNo && x.by === ctx.username));
  // преписките на лицето – за избора при ново дело
  const regsOf = code => [...regs].filter(no => (reqPerson.get(no) || DEFAULT_CODE) === code);
  return { codes, regs, personOf, seen, regsOf };
}

/* only – само делата на това лице (избраното в интерфейса) */
export async function visibleCourts(app, ctx, only) {
  const sc = await courtScope(app, ctx);
  return (await app.store.list('courts')).filter(x => sc.seen(x) && (!only || sc.personOf(x) === only));
}

async function findCourt(app, ctx, id) {
  const x = await app.store.get('courts', str(id, 20));
  if (!x || !(await courtScope(app, ctx)).seen(x)) fail('notfound', 'Делото не е намерено.');
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
  const today = todayIso(), only = line(d.person, 10), sc = await courtScope(app, ctx);
  const rows = (await app.store.list('courts')).filter(x => sc.seen(x) && (!only || sc.personOf(x) === only));
  return {
    courts: rows.map(x => Object.assign(courtView(x, today), { person: sc.personOf(x) })).sort(byDesc('at')),
    cases: only ? sc.regsOf(only) : [...sc.regs]
  };
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
  const sc = await courtScope(app, ctx);
  if (cur && !sc.seen(cur)) fail('notfound', 'Делото не е намерено.');
  const det = detailsOf(cur || {});
  // дело без преписка – към избраното лице (при преписка лицето е нейното)
  if (!v.regNo && (!cur || d.person !== undefined)) {
    const code = line(d.person, 10) || det.person || DEFAULT_CODE;
    if (!sc.codes.includes(code)) fail('role', 'Нямате достъп до делата на това лице.');
    det.person = code;
  }
  if (d.note !== undefined) det.text = str(d.note, 8000);
  if (d.procedure !== undefined) det.procedure = oneOf(d.procedure, PROCEDURES, 'Процесуален ред');
  else if (!cur) det.procedure = /ГПК/.test(v.kind) ? 'ГПК' : 'АПК';
  ['instituted'].forEach(k => { if (d[k] !== undefined) det[k] = isoDate(d[k], 'Образувано на'); });
  if (d.subject !== undefined) det.subject = line(d.subject, 400);
  if (d.appealedAct !== undefined) det.appealedAct = line(d.appealedAct, 300);
  if (d.interest !== undefined) det.interest = line(d.interest, 60);
  if (d.appealBy !== undefined) det.appealBy = isoDate(d.appealBy, 'Срок за обжалване на акта');
  if (d.executedOn !== undefined) det.executedOn = isoDate(d.executedOn, 'Органът се произнесе отново на');
  if (!cur) {
    // отговорник: въвелият или посоченият (с право „Разпределя преписки“); по подразбиране – отговорникът по преписката
    let owner = line(d.owner, 40);
    if (!owner && v.regNo) {
      const linked = (await app.store.list(/^П-/.test(v.regNo) ? 'requests' : 'cases', { regNo: v.regNo }))[0];
      owner = (linked && linked.owner) || '';
      if (owner && owner !== ctx.username && !ctx.perms.assign) owner = '';
    }
    owner = owner || ctx.username;
    if (!(await usersBrief(app)).some(u => u.username === owner)) fail('value', 'Отговорникът трябва да е активен потребител.');
    assignCheck(ctx, '', owner);
    det.owner = owner;
    if (Array.isArray(d.parties)) det.parties = d.parties.slice(0, 20).map(p => Object.assign({ id: newId() }, ITEM.parties(p || {})[0]));
  }
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
  if (det.owner !== ctx.username) await notifyCourt(app, rec, det, 'Определени сте за отговорник по делото.');
  // опит за автоматично свързване с ЕПЕП (по съд, номер и година); грешка не спира записа
  if (d.epep !== false) { try { await syncCourt(app, Object.assign({}, rec, v, { note: v.note }), ctx.username, { quiet: true }); } catch (e) { console.error('epep: ' + e.message); } }
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
    if (remedy && remedy !== NO_REMEDY && remedy !== ZDOI_FINAL && !remedyNames.includes(remedy)) fail('value', 'Невалидно средство за защита.');
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

/* ---------- отговорник ---------- */

export async function courtAssign(d, ctx, app) {
  const x = await findCourt(app, ctx, d.id), det = detailsOf(x), owner = line(d.owner, 40);
  if (owner === det.owner) return { owner };
  if (owner && !(await usersBrief(app)).some(u => u.username === owner)) fail('value', 'Отговорникът трябва да е активен потребител.');
  assignCheck(ctx, det.owner, owner);
  det.owner = owner;
  await app.store.patch('courts', x._id, { note: packDetails(det), updatedAt: stamp() });
  await courtEvent(app, x, ctx.username, 'Отговорник', owner ? 'Отговорник: ' + owner : 'Без отговорник');
  await audit(app, ctx.username, 'Отговорник по дело', courtTitle(x), owner || '—');
  if (owner && owner !== ctx.username) await notifyCourt(app, x, det, 'Определени сте за отговорник по делото.');
  return { owner };
}

/* имейл до отговорника по делото (или по преписката, ако делото няма отговорник) */
async function notifyCourt(app, x, det, text) {
  let owner = det.owner;
  if (!owner && x.regNo) {
    const linked = (await app.store.list(/^П-/.test(x.regNo) ? 'requests' : 'cases', { regNo: x.regNo }))[0];
    owner = linked && linked.owner;
  }
  if (!owner) return false;
  const u = (await app.store.list('users', { username: owner }))[0];
  if (!u || u.active !== 'Да' || !u.email || (!notifyOf(u).deadline && !notifyOf(u).assign)) return false;
  return mail(app, u.email, app.cfg.appName + ' – ' + courtTitle(x), text + '\n\n' + app.cfg.appUrl + '#/court/' + x._id);
}

/* ---------- ЕПЕП ---------- */

const EPEP_HEARING = { 'Открито': 'Открито заседание', 'Закрито': 'Закрито заседание' };
const EPEP_RESULT = [['Отлож', 'Отложено'], ['решаване', 'Обявено за решаване'], ['Спря', 'Спряно'], ['Прекрат', 'Прекратено'], ['същество', 'Даден ход по същество']];
const hearingResultOf = r => { const m = EPEP_RESULT.find(([k]) => new RegExp(k, 'i').test(r || '')); return m ? m[1] : ''; };
const dmy = iso => (iso ? iso.split('-').reverse().join('.') : '');

/*
 * Синхронизиране на делото с ЕПЕП: намира делото (по връзката или по съд, номер и година), прибавя новите заседания,
 * актове и страни, обновява състава и докладчика. Нашите полета (дата на съобщаване, средство за защита, бележки,
 * кой се явява) не се променят. Връща промените; при промени известява отговорника (освен ако той е пуснал проверката).
 */
export async function syncCourt(app, x, by, opts = {}) {
  const det = detailsOf(x);
  let gid = det.epep.gid || gidOf(det.epep.url) || gidOf(opts.gid);
  const found = await epepSearch(app.env, { caseNo: x.caseNo, year: x.year, court: gid ? '' : x.court });
  let info = gid ? found.find(r => r.gid === gid) : null;
  if (!gid) {
    if (found.length !== 1) return { found: found.length, candidates: found.slice(0, 10) };
    info = found[0];
    gid = info.gid;
  }
  const snap = await epepFetch(app.env, gid, info);
  const changes = [];
  const was = JSON.stringify(det);
  // основни данни и състав
  det.epep = Object.assign({}, det.epep, { gid, url: caseUrl(gid), syncedAt: stamp(), checkedAt: todayIso(), error: '', access: det.epep.access || '' });
  if (info) {
    if (info.instituted && det.instituted !== info.instituted) { det.instituted = info.instituted; changes.push('Образувано на ' + dmy(info.instituted)); }
    if (info.inNo) det.inNo = info.inNo;
    const division = [info.department, info.panel].filter(Boolean).join(', ');
    if (division && det.panel.division !== division) { changes.push('Съдебен състав: ' + division); det.panel.division = division; }
    if (info.reporter && det.panel.reporter !== info.reporter) { changes.push((det.panel.reporter ? 'Нов съдия-докладчик: ' : 'Съдия-докладчик: ') + info.reporter); det.panel.reporter = info.reporter; }
    if (info.kind) det.epepKind = info.kind;
  }
  // членове и председател – от последния акт със съставители
  const lastBy = snap.acts.filter(a => a.judges.length > 1).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (lastBy) {
    const chair = lastBy.judges.find(j => /председател/i.test(j.role)), members = lastBy.judges.filter(j => !/председател/i.test(j.role)).map(j => j.name).join(', ');
    if (chair && !det.panel.chair) det.panel.chair = chair.name;
    if (members && det.panel.members !== members) det.panel.members = members;
    det.panel.formation = lastBy.judges.length >= 5 ? 'Петчленен' : lastBy.judges.length >= 3 ? 'Тричленен' : det.panel.formation;
  } else if (snap.acts.length && !det.panel.formation) det.panel.formation = 'Едноличен';
  const lastH = snap.hearings.filter(hg => !hg.canceled).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (lastH && lastH.prosecutor) det.panel.prosecutor = lastH.prosecutor;
  if (lastH && lastH.secretary) det.panel.clerk = lastH.secretary;
  det.assignments = snap.assignments;
  det.connected = snap.connected;
  // заседания
  snap.hearings.forEach(e => {
    const cur = det.hearings.find(hg => hg.epepGid === e.gid) || det.hearings.find(hg => !hg.epepGid && hg.date === e.date && (!hg.time || !e.time || hg.time === e.time));
    const kind = EPEP_HEARING[e.type] || (/закрит/i.test(e.type) ? 'Закрито заседание' : 'Открито заседание');
    const mapped = hearingResultOf(e.result);
    if (!cur) {
      det.hearings.push({ id: newId(), epepGid: e.gid, date: e.date, time: e.time, kind, room: e.room, result: mapped, epepResult: e.result, canceled: e.canceled, video: e.video, attendee: '', note: '' });
      changes.push((e.canceled ? 'Отменено заседание ' : 'Ново заседание ') + dmy(e.date) + (e.time ? ' ' + e.time : '') + ' (' + kind.toLowerCase() + ')' + (e.result ? ' – ' + e.result : ''));
      return;
    }
    if (cur.date !== e.date || (e.time && cur.time !== e.time)) changes.push('Заседанието от ' + dmy(cur.date) + ' е преместено на ' + dmy(e.date) + (e.time ? ' ' + e.time : ''));
    if ((cur.epepResult || '') !== e.result && e.result) changes.push('Заседание ' + dmy(e.date) + ': ' + e.result);
    if (!cur.canceled && e.canceled) changes.push('Заседанието на ' + dmy(e.date) + ' е отменено');
    Object.assign(cur, { epepGid: e.gid, date: e.date, time: e.time || cur.time, kind, room: e.room || cur.room, epepResult: e.result, canceled: e.canceled, video: e.video, result: mapped || cur.result });
  });
  // съдебни актове
  const zdoi = isZdoi(x, det);
  snap.acts.forEach(e => {
    const cur = det.acts.find(a => a.epepGid === e.gid) || det.acts.find(a => !a.epepGid && a.date === e.date && String(a.no || '') === e.no);
    const kind = ACT_KINDS.includes(e.kind) ? e.kind : 'Друг акт';
    const judges = e.judges.map(j => j.name + (j.role ? ' (' + j.role.toLowerCase() + ')' : '')).join(', ');
    if (!cur) {
      det.acts.push({ id: newId(), epepGid: e.gid, kind, epepKind: e.kind, no: e.no, date: e.date, served: '', outcome: '', summary: '', judges,
        remedy: zdoi && kind === 'Решение' && x.instance !== 'Касационна инстанция' ? ZDOI_FINAL : '', due: '', appealedOn: '', finalOn: kind === 'Протокол' ? '' : e.inPower });
      changes.push('Нов акт: ' + e.kind.toLowerCase() + (e.no ? ' № ' + e.no : '') + ' от ' + dmy(e.date) + (e.inPower && kind !== 'Протокол' ? ' (в сила от ' + dmy(e.inPower) + ')' : ''));
      return;
    }
    if (e.inPower && kind !== 'Протокол' && !cur.finalOn) { cur.finalOn = e.inPower; changes.push(e.kind + (e.no ? ' № ' + e.no : '') + ' влезе в сила на ' + dmy(e.inPower)); }
    Object.assign(cur, { epepGid: e.gid, epepKind: e.kind, no: cur.no || e.no, judges });
  });
  // страни
  snap.sides.forEach(e => {
    if (det.parties.some(pt => pt.epepGid === e.gid || (pt.name.toLowerCase() === e.name.toLowerCase()))) return;
    const role = PARTY_ROLES.find(r => r.toLowerCase() === e.role.toLowerCase()) || 'Друго';
    det.parties.push({ id: newId(), epepGid: e.gid, role, epepRole: e.role, name: e.name, rep: e.lawyers.join(', '), contact: '', note: '' });
    changes.push('Страна: ' + e.role.toLowerCase() + ' – ' + e.name);
  });
  ['hearings', 'acts'].forEach(k => det[k].sort((a, b) => String(a.date).localeCompare(String(b.date))));
  // статус
  const patch = { note: packDetails(det), nextHearing: nextHearingOf(det, x.nextHearing), updatedAt: stamp() };
  const dec = det.acts.filter(a => a.kind === 'Решение').sort((a, b) => b.date.localeCompare(a.date))[0];
  if (dec && dec.finalOn && x.status !== 'Влязло в сила') patch.status = 'Влязло в сила';
  else if (dec && ['Образувано', 'Оставено без движение', 'Насрочено', 'Отложено', 'Спряно', 'Обявено за решаване'].includes(x.status)) patch.status = 'Решено';
  else if (!dec && patch.nextHearing && x.status === 'Образувано') patch.status = 'Насрочено';
  if (patch.status) changes.push('Статус: ' + patch.status);
  if (JSON.stringify(det) !== was || patch.status) await app.store.patch('courts', x._id, patch);
  await app.kv.put('epep:' + x._id, JSON.stringify(Object.assign({ at: stamp() }, snap)));
  if (changes.length) {
    await courtEvent(app, x, by, 'ЕПЕП', changes.join('\n'));
    if (x.regNo) await reqEvent(app, x.regNo, by, courtTitle(x) + ' – от ЕПЕП: ' + changes.join('; '));
    if (!opts.quiet && det.owner !== by) await notifyCourt(app, x, det, 'Промени по делото според ЕПЕП:\n\n– ' + changes.join('\n– '));
  }
  return { gid, changes };
}

/* бутон „Обнови от ЕПЕП“ / свързване с избрано дело */
export async function courtEpep(d, ctx, app) {
  const x = await findCourt(app, ctx, d.id);
  if (d.unlink === true) {
    const det = detailsOf(x);
    det.epep = Object.assign({}, det.epep, { gid: '', url: '', syncedAt: '', error: '' });
    await app.store.patch('courts', x._id, { note: packDetails(det), updatedAt: stamp() });
    await app.kv.delete('epep:' + x._id);
    await courtEvent(app, x, ctx.username, 'ЕПЕП', 'Връзката с ЕПЕП е премахната.');
    return { unlinked: true };
  }
  let r;
  try { r = await syncCourt(app, x, ctx.username, { gid: str(d.gid, 80) }); } catch (e) {
    const det = detailsOf(x);
    det.epep.error = e.message.slice(0, 200);
    await app.store.patch('courts', x._id, { note: packDetails(det) });
    fail('epep', e.message);
  }
  if (!r.gid) return r;
  await audit(app, ctx.username, 'Обновено от ЕПЕП', courtTitle(x), r.changes.length + ' промени');
  return r;
}

/* последните сурови данни от ЕПЕП (разпределения, свързани дела) */
export async function courtEpepRaw(d, ctx, app) {
  const x = await findCourt(app, ctx, d.id);
  const raw = await app.kv.get('epep:' + x._id);
  return { epep: raw ? JSON.parse(raw) : null };
}

/*
 * Cron: веднъж дневно (след 7 ч.) проверява в ЕПЕП висящите дела и решените през последните 60 дни.
 * По няколко дела на пускане, за да не се надхвърлят ограниченията на Worker-а; помни докъде е стигнал за деня.
 */
const CLOSED = ['Прекратено', 'Влязло в сила'];
export async function epepDaily(app, now = new Date(), batch = 3) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', hourCycle: 'h23' }).format(now));
  if (hour < 7) return { skipped: 'рано' };
  const today = todayIso(now), key = 'epep:day:' + today;
  const done = JSON.parse((await app.kv.get(key)) || '[]');
  const due = (await app.store.list('courts')).filter(x => !done.includes(x._id) && x.caseNo && x.year &&
    (!CLOSED.includes(x.status) || (x.updatedAt && daysBetween(String(x.updatedAt).slice(0, 10), today) <= 60)));
  const run = { checked: 0, changed: 0, errors: 0, left: Math.max(0, due.length - batch) };
  for (const x of due.slice(0, batch)) {
    done.push(x._id);
    try {
      const r = await syncCourt(app, x, 'ЕПЕП');
      run.checked++;
      if (r.changes && r.changes.length) run.changed++;
    } catch (e) {
      run.errors++;
      console.error('epep ' + x._id + ': ' + e.message);
    }
  }
  await app.kv.put(key, JSON.stringify(done), { expirationTtl: 2 * 86400 });
  return run;
}

export async function courtDelete(d, ctx, app) {
  const cur = await findCourt(app, ctx, d.id);
  if (!ctx.admin && cur.by !== ctx.username) fail('role', 'Делото се изтрива от въвелия го или администратор.');
  await app.store.remove('courts', cur._id);
  await app.kv.delete('epep:' + cur._id);
  const title = courtTitle(cur);
  if (cur.regNo) await reqEvent(app, cur.regNo, ctx.username, 'Изтрито дело: ' + title);
  await audit(app, ctx.username, 'Изтрито дело', title, '');
  return {};
}
