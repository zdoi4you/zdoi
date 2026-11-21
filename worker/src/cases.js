/*
 * Преписки по ЗДОИ, срокове, решения (само отбелязване – документите не се генерират), съдебни дела и адресати.
 */

import { fail, str, line, stamp, todayIso, isoDate, oneOf, intIn, isEmail, validEik, view, byDesc, sofiaHour } from './util.js';
import { term, termMonths, daysBetween } from './calendar.js';
import { audit, mail, insertUnique } from './core.js';
import { SCHEMA } from './schema.js';
import { PERM_GROUPS } from './config.js';
import { notifyOf, permsOf } from './auth.js';
import { usersBrief, assignCheck } from './users.js';
import { reqLists, reqDashboard, orgProfile, REG_BASIS, reqScope, withReqDue, SCHEDULED } from './requests.js';
import { personsFor, codeOf, defaultPersonOf, DEFAULT_CODE } from './persons.js';
import { mailboxAddress } from './mailbox.js';

export const CASE_STATUS = ['Нова', 'В обработка', 'Чака уточняване', 'Чака трето лице', 'Решение издадено', 'Приключена'];
export const CASE_OPEN = ['Нова', 'В обработка', 'Чака уточняване', 'Чака трето лице'];
export const CASE_KIND = ['Достъп до обществена информация', 'Повторно използване на информация'];
export const CASE_CHANNEL = ['Писмено', 'По имейл (чл. 15, ал. 1, т. 4)', 'Платформа за достъп (чл. 15в)', 'Устно запитване', 'Сигурно електронно връчване'];
export const APPLICANT_TYPE = ['Гражданин', 'Юридическо лице', 'Журналист или медия', 'Неправителствена организация'];
export const ADDRESSEE_TYPE = ['Задължен субект (орган или организация)'].concat(APPLICANT_TYPE, 'Орган или друга организация');
export const CASE_OUTCOME = ['', 'Предоставен достъп', 'Частичен достъп', 'Отказ', 'Препратено (чл. 32)', 'Няма информация (чл. 33)', 'Без разглеждане', 'Отказ на заявителя (чл. 36)'];
export const DECISION_OUTCOMES = ['Предоставен достъп', 'Частичен достъп', 'Отказ'];
export const SERVED_HOW = ['', 'Срещу подпис', 'С препоръчано писмо с обратна разписка', 'По имейл', 'Сигурно електронно връчване', 'Чрез платформата по чл. 15в'];
export const COURT_KIND = ['Жалба срещу решение', 'Жалба срещу мълчалив отказ', 'Касационна жалба', 'Друго'];
export const COURT_INSTANCE = ['Административен съд', 'Върховен административен съд'];
export const COURT_STATUS = ['Образувано', 'Насрочено', 'Обявено за решаване', 'Решено', 'Прекратено', 'Обжалвано'];
export const COURTS = ['Административен съд – Благоевград', 'Административен съд – Бургас', 'Административен съд – Варна', 'Административен съд – Велико Търново', 'Административен съд – Видин', 'Административен съд – Враца', 'Административен съд – Габрово', 'Административен съд – Добрич', 'Административен съд – Кърджали', 'Административен съд – Кюстендил', 'Административен съд – Ловеч', 'Административен съд – Монтана', 'Административен съд – Пазарджик', 'Административен съд – Перник', 'Административен съд – Плевен', 'Административен съд – Пловдив', 'Административен съд – Разград', 'Административен съд – Русе', 'Административен съд – Силистра', 'Административен съд – Сливен', 'Административен съд – Смолян', 'Административен съд – София-град', 'Административен съд – София-област', 'Административен съд – Стара Загора', 'Административен съд – Търговище', 'Административен съд – Хасково', 'Административен съд – Шумен', 'Административен съд – Ямбол', 'Върховен административен съд'];

const APPEAL_DAYS = 14;

/* ---------- срокове: изчисляват се само тук ---------- */

export function withDue(c, today) {
  const o = view(c);
  o.due = ''; o.dueLabel = ''; o.daysLeft = null;
  o.thirdInvolved = false; o.thirdBy = ''; o.thirdByDays = null; o.thirdReplyBy = ''; o.thirdReplyDays = null;
  o.appealBy = ''; o.appealDays = null; o.silentBy = '';
  const left = iso => daysBetween(today, iso);
  // обжалване: 14 дни от съобщаването (чл. 149, ал. 1 АПК), затова без дата на връчване срок не се показва
  if (c.decisionDate && c.served) {
    o.appealBy = term(c.served, APPEAL_DAYS);
    o.appealDays = left(o.appealBy);
  }
  if (!CASE_OPEN.includes(c.status) || !c.regDate) return o;
  const ext30 = Number(c.ext30) || 0, ext31 = Number(c.ext31) || 0, base = c.clarifyGot || c.regDate;
  if (c.clarifyAsked && !c.clarifyGot) {
    o.due = term(c.clarifyAsked, 30);
    o.dueLabel = 'Уточняване от заявителя (чл. 29, ал. 2)';
  } else {
    o.due = term(base, 14 + ext30 + ext31);
    o.dueLabel = 'Решение (чл. 28, ал. 1' + (ext30 ? '; чл. 30' : '') + (ext31 ? '; чл. 31' : '') + ')';
    // след изтичане на срока без решение заявителят може да обжалва мълчаливия отказ в едномесечен срок (чл. 149, ал. 2 АПК)
    o.silentBy = termMonths(o.due, 1);
  }
  o.daysLeft = left(o.due);
  // трето лице: съгласието се иска до 7 дни от регистрирането (чл. 31, ал. 2); отговорът – в удължения срок
  o.thirdBy = term(c.regDate, 7);
  o.thirdByDays = c.thirdAsked ? null : left(o.thirdBy);
  o.thirdReplyBy = term(base, 14 + ext30 + (ext31 || 14));
  o.thirdReplyDays = c.thirdGot ? null : left(o.thirdReplyBy);
  o.thirdInvolved = !!(ext31 || c.thirdAsked || c.thirdGot || c.status === 'Чака трето лице');
  return o;
}

/* входящият регистър се вижда с право „Вижда входящия регистър“; без „всички преписки“ – само възложените и въведените от потребителя */
const canSee = (c, ctx) => !!ctx.perms.inReg && (!!ctx.perms.casesAll || c.owner === ctx.username || c.createdBy === ctx.username);

async function findCase(app, regNo, ctx) {
  const c = (await app.store.list('cases', { regNo: line(regNo, 60) }))[0];
  if (!c || !canSee(c, ctx)) fail('notfound', 'Преписката не е намерена.');
  return c;
}

const unlocked = c => { if (c.locked === 'Да') fail('caselocked', 'Преписката е заключена от ' + (c.lockedBy || 'администратор') + '. Отключете я, за да я промените.'); };
const event = (app, regNo, user, kind, text) => app.store.insert('events', { regNo, at: stamp(), user, kind, text: String(text).slice(0, 4000) });

export const lists = () => ({
  statuses: CASE_STATUS, kinds: CASE_KIND, channels: CASE_CHANNEL, applicantTypes: APPLICANT_TYPE, addresseeTypes: ADDRESSEE_TYPE,
  outcomes: CASE_OUTCOME, servedHow: SERVED_HOW, courtKinds: COURT_KIND, courtInstances: COURT_INSTANCE, courtStatuses: COURT_STATUS, courts: COURTS
});

export async function bootstrap(d, ctx, app) {
  const [users, departments] = await Promise.all([usersBrief(app), app.store.list('departments')]);
  return {
    users, departments: departments.filter(x => x.active === 'Да').map(x => x.name), lists: Object.assign(lists(), reqLists()),
    org: await orgProfile(app), mailbox: mailboxAddress(app.env), session: ctx.sessionExp, sessionMin: ctx.sessionMin,
    // лицата, от чието име потребителят може да води преписки (с данните за бланката)
    persons: await personsFor(app, ctx),
    // лицето, с което потребителят отваря системата (избира се в „Моят профил“)
    defaultPerson: await defaultPersonOf(app, ctx.username),
    // каталогът на правата – за надписите в интерфейса
    permGroups: PERM_GROUPS
  };
}

export async function caseList(d, ctx, app) {
  const today = todayIso();
  const rows = (await app.store.list('cases')).filter(c => canSee(c, ctx)).map(c => {
    const o = withDue(c, today);
    ['applicantAddress', 'applicantPhone', 'appealNote', 'grounds'].forEach(k => delete o[k]);
    return o;
  }).reverse();
  return { cases: rows };
}

export async function caseGet(d, ctx, app) {
  const c = await findCase(app, d.regNo, ctx);
  const [events, courts] = await Promise.all([app.store.list('events', { regNo: c.regNo }), app.store.list('courts')]);
  return {
    case: withDue(c, todayIso()),
    events: events.map(view).reverse(),
    courts: courts.filter(x => x.regNo === c.regNo).map(courtView)
  };
}

async function checkOwner(app, owner) {
  if (!owner) return '';
  const u = (await usersBrief(app)).find(x => x.username === owner);
  if (!u) fail('value', 'Отговорникът трябва да е активен потребител.');
  return owner;
}

function caseFields(d) {
  const v = {
    kind: oneOf(d.kind, CASE_KIND, 'Вид заявление'), regDate: isoDate(d.regDate, 'Дата на регистриране'), channel: oneOf(d.channel, CASE_CHANNEL, 'Начин на подаване'),
    applicantType: oneOf(d.applicantType, APPLICANT_TYPE, 'Вид заявител'), applicantName: line(d.applicantName, 200), applicantSeat: line(d.applicantSeat, 120),
    applicantOblast: line(d.applicantOblast, 80), applicantAddress: line(d.applicantAddress, 400), applicantEmail: line(d.applicantEmail, 200).toLowerCase(),
    applicantPhone: line(d.applicantPhone, 40), applicantEik: line(d.applicantEik, 13), subject: str(d.subject, 8000), form: line(d.form, 250),
    noPublish: d.noPublish === true || d.noPublish === 'Да' ? 'Да' : 'Не', department: line(d.department, 160)
  };
  if (!v.regDate) fail('required', 'Посочете дата на регистриране.');
  if (v.regDate > todayIso()) fail('date', 'Датата на регистриране не може да е в бъдещето.');
  if (!v.applicantName) fail('required', 'Посочете заявителя (чл. 25, ал. 1, т. 1).');
  if (!v.subject) fail('required', 'Опишете исканата информация (чл. 25, ал. 1, т. 2).');
  if (!v.applicantAddress && !v.applicantEmail) fail('required', 'Посочете адрес или имейл за кореспонденция (чл. 25, ал. 1, т. 4).');
  if (v.applicantEmail && !isEmail(v.applicantEmail)) fail('email', 'Невалиден имейл на заявителя.');
  if (v.applicantEik && !validEik(v.applicantEik)) fail('eik', 'Невалиден ЕИК/БУЛСТАТ на заявителя.');
  return v;
}

export async function caseCreate(d, ctx, app) {
  const v = caseFields(d);
  v.owner = await checkOwner(app, line(d.owner, 40));
  assignCheck(ctx, '', v.owner);
  let regNo = line(d.regNo, 60);
  const base = { createdAt: stamp(), createdBy: ctx.username, status: 'Нова', outcome: '', updatedAt: stamp() };
  let rec;
  if (regNo) {
    if ((await app.store.list('cases', { regNo })).length) fail('duplicate', 'Вече има преписка с този номер.');
    rec = await app.store.insert('cases', Object.assign(base, v, { regNo }));
  } else {
    const y = v.regDate.slice(0, 4);
    rec = await insertUnique(app, 'cases', {}, 'regNo', n => 'ВХ-' + y + '-' + String(n).padStart(4, '0'), Object.assign(base, v));
    regNo = rec.regNo;
  }
  if (d.saveAddressee === true) await saveAddresseeFromCase(app, ctx, v);
  await event(app, regNo, ctx.username, 'Създаване', 'Преписката е въведена.');
  await audit(app, ctx.username, 'Нова преписка', regNo, '');
  if (v.owner) await notifyAssigned(app, ctx, regNo, v.owner);
  return { regNo };
}

const DATE_FIELDS = ['clarifyAsked', 'clarifyGot', 'thirdAsked', 'thirdGot', 'decisionDate', 'served', 'published15c'];

export async function caseUpdate(d, ctx, app) {
  const c = await findCase(app, d.regNo, ctx);
  unlocked(c);
  const v = caseFields(d);
  Object.assign(v, {
    status: oneOf(d.status, CASE_STATUS, 'Статус'), outcome: oneOf(d.outcome || '', CASE_OUTCOME, 'Резултат'),
    ext30: intIn(d.ext30, 0, 10, 'Удължаване по чл. 30'), ext31: intIn(d.ext31, 0, 14, 'Удължаване по чл. 31'),
    decisionNo: line(d.decisionNo, 60), grounds: str(d.grounds, 4000), servedHow: oneOf(d.servedHow || '', SERVED_HOW, 'Начин на връчване'),
    appealed: d.appealed === true || d.appealed === 'Да' ? 'Да' : 'Не', appealNote: str(d.appealNote, 2000)
  });
  DATE_FIELDS.forEach(k => { v[k] = isoDate(d[k], SCHEMA.cases[1][k][0]); });
  // проверки на последователността на датите
  const before = (a, b, msg) => { if (v[a] && (b === 'regDate' ? v.regDate : v[b]) && v[a] < (b === 'regDate' ? v.regDate : v[b])) fail('date', msg); };
  before('clarifyAsked', 'regDate', 'Уточняването не може да е поискано преди регистрирането.');
  before('clarifyGot', 'clarifyAsked', 'Уточняването не може да е получено преди да е поискано.');
  if (v.clarifyGot && !v.clarifyAsked) fail('date', 'Въведете кога е поискано уточняването.');
  before('decisionDate', 'regDate', 'Решението не може да е преди регистрирането.');
  before('served', 'decisionDate', 'Връчването не може да е преди решението.');
  if (v.served && !v.decisionDate) fail('date', 'Въведете дата на решението преди датата на връчване.');
  if (DECISION_OUTCOMES.includes(v.outcome) && v.status === 'Решение издадено' && (!v.decisionNo || !v.decisionDate)) {
    fail('required', 'При издадено решение въведете номер и дата на решението.');
  }
  if (v.outcome === 'Отказ' || v.outcome === 'Частичен достъп') { if (!v.grounds) fail('required', 'Посочете основанията за отказа.'); }
  // след получено уточняване или отговор от трето лице срокът тече отново
  if (v.clarifyGot && !c.clarifyGot && v.status === 'Чака уточняване') v.status = 'В обработка';
  if (v.thirdGot && !c.thirdGot && v.status === 'Чака трето лице') v.status = 'В обработка';
  const changed = Object.keys(v).filter(k => String(v[k]) !== String(c[k] || ''));
  if (!changed.length) return { regNo: c.regNo };
  const patch = {};
  changed.forEach(k => { patch[k] = v[k]; });
  patch.updatedAt = stamp();
  await app.store.patch('cases', c._id, patch);
  const labels = SCHEMA.cases[1], longText = ['subject', 'appealNote', 'grounds', 'applicantAddress'];
  await event(app, c.regNo, ctx.username, 'Промяна', changed.map(k => labels[k][0] + (longText.includes(k) ? '' : ': ' + (v[k] || '—'))).join('; '));
  if (patch.status) await notifyCase(app, ctx, Object.assign({}, c, patch), 'status', 'Нов статус: ' + patch.status);
  return { regNo: c.regNo };
}

/* отговорникът се определя от потребител с право да променя преписки */
export async function caseAssign(d, ctx, app) {
  const c = await findCase(app, d.regNo, ctx);
  unlocked(c);
  const owner = await checkOwner(app, line(d.owner, 40));
  if (owner === c.owner) return { owner };
  assignCheck(ctx, c.owner || '', owner);
  await app.store.patch('cases', c._id, { owner, updatedAt: stamp() });
  await event(app, c.regNo, ctx.username, 'Отговорник', owner ? 'Отговорник: ' + owner : 'Без отговорник');
  await audit(app, ctx.username, 'Смяна на отговорник', c.regNo, owner || '—');
  if (owner) await notifyAssigned(app, ctx, c.regNo, owner);
  return { owner };
}

/* заключва отговорникът или администратор; отключва заключилият или администратор */
export async function caseLock(d, ctx, app) {
  const c = await findCase(app, d.regNo, ctx), want = d.locked === true, admin = !!ctx.admin;
  if (want === (c.locked === 'Да')) return { locked: want };
  if (want && !admin && c.owner !== ctx.username) fail('role', 'Преписката се заключва от отговорника или администратор.');
  if (!want && !admin && c.lockedBy !== ctx.username) fail('role', 'Преписката се отключва от заключилия я или администратор.');
  const reason = line(d.reason, 300);
  await app.store.patch('cases', c._id, want ? { locked: 'Да', lockedBy: ctx.username, lockedAt: stamp(), updatedAt: stamp() } : { locked: '', lockedBy: '', lockedAt: '', updatedAt: stamp() });
  await event(app, c.regNo, ctx.username, want ? 'Заключване' : 'Отключване', (want ? 'Преписката е заключена.' : 'Преписката е отключена.') + (reason ? ' Причина: ' + reason : ''));
  await audit(app, ctx.username, want ? 'Заключена преписка' : 'Отключена преписка', c.regNo, reason);
  return { locked: want };
}

export async function caseComment(d, ctx, app) {
  const c = await findCase(app, d.regNo, ctx), text = str(d.text, 4000);
  unlocked(c);
  if (!text) fail('required', 'Напишете текст.');
  await event(app, c.regNo, ctx.username, 'Коментар', text);
  await notifyCase(app, ctx, c, 'comments', 'Добавен е вътрешен коментар.');
  return {};
}

/* ---------- известия по имейл: без данни за заявителя и текст на искането ---------- */

async function notifyAssigned(app, ctx, regNo, owner) {
  if (owner === ctx.username) return;
  const u = (await app.store.list('users', { username: owner }))[0];
  if (!u || u.active !== 'Да' || !u.email || !notifyOf(u).assign) return;
  await mail(app, u.email, app.cfg.appName + ' – определен сте за отговорник по ' + regNo,
    ctx.name + ' ви определи за отговорник по преписка ' + regNo + '.\n\n' + app.cfg.appUrl + '#/case/' + encodeURIComponent(regNo));
}

async function notifyCase(app, ctx, c, kind, text) {
  const users = (await app.store.list('users')).filter(u => u.active === 'Да' && u.email && u.username !== ctx.username);
  for (const u of users) {
    const n = notifyOf(u);
    if (!n[kind]) continue;
    const mine = u.username === c.owner;
    if (!mine && !(n.all && permsOf(u).casesAll)) continue;
    await mail(app, u.email, app.cfg.appName + ' – преписка ' + c.regNo, text + '\n\n' + app.cfg.appUrl + '#/case/' + encodeURIComponent(c.regNo));
  }
}

/* ---------- табло ---------- */

export async function dashboard(d, ctx, app) {
  const today = todayIso();
  const cases = (await app.store.list('cases')).filter(c => canSee(c, ctx)).map(c => withDue(c, today));
  const byStatus = {};
  CASE_STATUS.forEach(s => { byStatus[s] = 0; });
  cases.forEach(c => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
  const brief = c => ({ regNo: c.regNo, applicantName: c.applicantName, status: c.status, owner: c.owner, due: c.due, dueLabel: c.dueLabel, daysLeft: c.daysLeft, appealBy: c.appealBy, appealDays: c.appealDays, locked: c.locked });
  const open = cases.filter(c => CASE_OPEN.includes(c.status));
  const hearings = (await app.store.list('courts')).filter(x => x.nextHearing && x.nextHearing >= today && daysBetween(today, x.nextHearing) <= 30)
    .filter(x => !x.regNo || cases.some(c => c.regNo === x.regNo)).map(courtView).sort((a, b) => a.nextHearing.localeCompare(b.nextHearing));
  return Object.assign(await reqDashboard(app, ctx, line(d.person, 10)), {
    byStatus, total: cases.length, open: open.length,
    overdue: open.filter(c => c.daysLeft !== null && c.daysLeft < 0).map(brief),
    soon: open.filter(c => c.daysLeft !== null && c.daysLeft >= 0 && c.daysLeft <= 3).map(brief).sort((a, b) => a.daysLeft - b.daysLeft),
    mine: open.filter(c => c.owner === ctx.username).map(brief).sort((a, b) => (a.due || '9').localeCompare(b.due || '9')),
    unassigned: open.filter(c => !c.owner).map(brief),
    appeals: cases.filter(c => c.appealDays !== null && c.appealDays >= 0 && c.appealDays <= 7).map(brief),
    hearings
  });
}

/* ---------- календар ---------- */

/* срокове по заявленията и входящите преписки, заседания по делата и насрочени писма – за избраното лице */
export async function calendar(d, ctx, app) {
  const today = todayIso(), only = line(d.person, 10), see = await reqScope(app, ctx);
  const events = [];
  const add = (at, kind, ref, text, href, cls) => {
    if (!/^\d{4}-\d{2}-\d{2}/.test(at || '')) return;
    events.push({ date: at.slice(0, 10), time: at.length > 10 ? at.slice(11, 16) : '', kind, ref, text: text || '', href, cls: cls || '' });
  };
  const reqs = (await app.store.list('requests')).filter(r => see(r) && (!only || codeOf(r) === only)).map(r => withReqDue(r, today));
  const reqHref = no => '#/request/' + encodeURIComponent(no);
  reqs.forEach(r => {
    if (r.due) add(r.due, r.ours ? 'Наш срок' : 'Срок за отговор от субекта', r.regNo, r.entityName, reqHref(r.regNo), r.daysLeft < 0 ? 'bad' : 'warn');
    if (r.silentBy && r.daysLeft !== null && r.daysLeft < 0) add(r.silentBy, 'Обжалване на мълчалив отказ', r.regNo, r.entityName, reqHref(r.regNo), 'bad');
    if (r.appealBy) add(r.appealBy, 'Обжалване на решението', r.regNo, r.entityName, reqHref(r.regNo), 'bad');
  });
  const visible = new Set(reqs.map(r => r.regNo));
  if (ctx.perms.inReg && (!only || only === DEFAULT_CODE)) {
    (await app.store.list('cases')).filter(c => canSee(c, ctx)).map(c => withDue(c, today)).forEach(c => {
      visible.add(c.regNo);
      const href = '#/case/' + encodeURIComponent(c.regNo);
      if (c.due && CASE_OPEN.includes(c.status)) add(c.due, c.dueLabel || 'Срок за решение', c.regNo, c.applicantName, href, c.daysLeft < 0 ? 'bad' : 'warn');
      if (c.appealBy) add(c.appealBy, 'Срок за обжалване (входящо)', c.regNo, c.applicantName, href, '');
    });
  }
  (await app.store.list('courts')).filter(x => x.nextHearing && (visible.has(x.regNo) || (!x.regNo && ctx.perms.casesAll)))
    .forEach(x => add(x.nextHearing, 'Съдебно заседание', String(x.court || '').replace('Административен съд – ', 'АС ') + ' № ' + x.caseNo + '/' + x.year, x.kind, '#/courts', 'info'));
  (await app.store.list('mail', { direction: SCHEDULED })).filter(m => visible.has(m.regNo))
    .forEach(m => add(m.at, 'Насрочено писмо', m.regNo, m.subject + ' → ' + m.to, reqHref(m.regNo), 'info'));
  return { events: events.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)) };
}

/* ---------- съдебни дела ---------- */

const courtView = x => view(x);

export async function courtList(d, ctx, app) {
  const cases = (await app.store.list('cases')).filter(c => canSee(c, ctx)).map(c => c.regNo)
    .concat((await app.store.list('requests')).filter(await reqScope(app, ctx)).map(r => r.regNo));
  const rows = (await app.store.list('courts')).filter(x => !x.regNo || cases.includes(x.regNo) || ctx.perms.casesAll);
  return { courts: rows.map(courtView).sort(byDesc('at')), cases };
}

export async function courtSave(d, ctx, app) {
  const v = {
    regNo: line(d.regNo, 60), court: oneOf(d.court, COURTS, 'Съд'), caseNo: line(d.caseNo, 40), year: intIn(d.year, 2000, 2100, 'Година'),
    kind: oneOf(d.kind, COURT_KIND, 'Вид'), instance: oneOf(d.instance, COURT_INSTANCE, 'Инстанция'), status: oneOf(d.status, COURT_STATUS, 'Статус'),
    nextHearing: isoDate(d.nextHearing, 'Следващо заседание'), result: line(d.result, 250), note: str(d.note, 4000)
  };
  if (!v.caseNo || !v.year) fail('required', 'Посочете номер и година на делото.');
  // делото се води и при заключена преписка; връзката е към получено (ВХ-…) или изходящо заявление (П-…)
  if (v.regNo && /^П-/.test(v.regNo)) {
    const r = (await app.store.list('requests', { regNo: v.regNo }))[0];
    if (!r || !(await reqScope(app, ctx))(r)) fail('notfound', 'Преписката не е намерена.');
  } else if (v.regNo) await findCase(app, v.regNo, ctx);
  const rows = await app.store.list('courts');
  if (rows.some(x => x.court === v.court && x.caseNo === v.caseNo && x.year === v.year && x._id !== String(d.id || ''))) fail('duplicate', 'Това дело вече е въведено.');
  const title = v.court + ' № ' + v.caseNo + '/' + v.year;
  if (d.id) {
    const cur = rows.find(x => x._id === String(d.id));
    if (!cur) fail('notfound', 'Делото не е намерено.');
    await app.store.patch('courts', cur._id, Object.assign(v, { updatedAt: stamp() }));
    if (v.regNo) await event(app, v.regNo, ctx.username, 'Дело', 'Променено дело: ' + title + ' – ' + v.status);
    await audit(app, ctx.username, 'Промяна на дело', title, v.status);
    return { id: cur._id };
  }
  const rec = await app.store.insert('courts', Object.assign(v, { by: ctx.username, at: stamp(), updatedAt: stamp() }));
  if (v.regNo) {
    await event(app, v.regNo, ctx.username, 'Дело', 'Ново дело: ' + title);
    const c = (await app.store.list('cases', { regNo: v.regNo }))[0];
    if (c && c.appealed !== 'Да' && c.locked !== 'Да') await app.store.patch('cases', c._id, { appealed: 'Да', updatedAt: stamp() });
  }
  await audit(app, ctx.username, 'Ново дело', title, '');
  return { id: rec._id };
}

export async function courtDelete(d, ctx, app) {
  const cur = await app.store.get('courts', str(d.id, 20));
  if (!cur) fail('notfound', 'Делото не е намерено.');
  if (!ctx.admin && cur.by !== ctx.username) fail('role', 'Делото се изтрива от въвелия го или администратор.');
  await app.store.remove('courts', cur._id);
  const title = cur.court + ' № ' + cur.caseNo + '/' + cur.year;
  if (cur.regNo) await event(app, cur.regNo, ctx.username, 'Дело', 'Изтрито дело: ' + title);
  await audit(app, ctx.username, 'Изтрито дело', title, '');
  return {};
}

/* ---------- адресати ---------- */

function addresseeFields(d) {
  const v = {
    type: oneOf(d.type, ADDRESSEE_TYPE, 'Вид'), name: line(d.name, 200), regBasis: oneOf(d.regBasis || '', REG_BASIS, 'Регистрация'), eik: line(d.eik, 13), seat: line(d.seat, 120),
    address: line(d.address, 400), oblast: line(d.oblast, 80), email: line(d.email, 200).toLowerCase(), phone: line(d.phone, 40)
  };
  if (!v.name) fail('required', 'Посочете име или наименование.');
  if (v.email && !isEmail(v.email)) fail('email', 'Невалиден имейл.');
  if (v.eik && !validEik(v.eik)) fail('eik', 'Невалиден ЕИК/БУЛСТАТ.');
  return v;
}

/* без право „всички преписки“ потребителят вижда само своите адресати */
export async function addresseeList(d, ctx, app) {
  const rows = (await app.store.list('addressees')).filter(a => ctx.perms.casesAll || a.by === ctx.username);
  return { addressees: rows.map(view).sort((a, b) => a.name.localeCompare(b.name, 'bg')) };
}

export async function addresseeSave(d, ctx, app) {
  const v = addresseeFields(d);
  if (d.id) {
    const cur = await app.store.get('addressees', str(d.id, 20));
    if (!cur || (!ctx.perms.casesAll && cur.by !== ctx.username)) fail('notfound', 'Адресатът не е намерен.');
    await app.store.patch('addressees', cur._id, v);
    await audit(app, ctx.username, 'Промяна на адресат', v.name, '');
    return { id: cur._id };
  }
  const rec = await app.store.insert('addressees', Object.assign(v, { by: ctx.username, at: stamp() }));
  await audit(app, ctx.username, 'Нов адресат', v.name, '');
  return { id: rec._id };
}

export async function addresseeDelete(d, ctx, app) {
  const cur = await app.store.get('addressees', str(d.id, 20));
  if (!cur || (!ctx.perms.casesAll && cur.by !== ctx.username)) fail('notfound', 'Адресатът не е намерен.');
  await app.store.remove('addressees', cur._id);
  await audit(app, ctx.username, 'Изтрит адресат', cur.name, '');
  return {};
}

async function saveAddresseeFromCase(app, ctx, v) {
  const rows = await app.store.list('addressees');
  if (rows.some(a => a.name === v.applicantName && (a.email || '') === v.applicantEmail)) return;
  await app.store.insert('addressees', {
    type: v.applicantType, name: v.applicantName, eik: v.applicantEik, seat: v.applicantSeat, address: v.applicantAddress,
    oblast: v.applicantOblast, email: v.applicantEmail, phone: v.applicantPhone, by: ctx.username, at: stamp()
  });
}

/* ---------- напомняния за срокове (Cron на Worker-а, всеки час) ---------- */

const REMIND_AT = [3, 1, 0, -1];

export async function remindDeadlines(app, now = new Date()) {
  if (sofiaHour(now) < 8) return { skipped: 'рано' };
  const today = todayIso(now), key = 'remind:' + today;
  if (await app.kv.get(key)) return { skipped: 'вече изпратено' };
  await app.kv.put(key, '1', { expirationTtl: 3 * 86400 });
  const users = (await app.store.list('users')).filter(u => u.active === 'Да' && u.email && notifyOf(u).deadline);
  const cases = (await app.store.list('cases')).map(c => withDue(c, today)).filter(c => CASE_OPEN.includes(c.status) && c.owner && REMIND_AT.includes(c.daysLeft));
  let sent = 0;
  for (const u of users) {
    const mine = cases.filter(c => c.owner === u.username);
    if (!mine.length) continue;
    const lines = mine.map(c => c.regNo + ' – ' + c.dueLabel + ': ' + c.due.split('-').reverse().join('.') +
      (c.daysLeft < 0 ? ' (изтекъл)' : c.daysLeft === 0 ? ' (днес)' : ' (след ' + c.daysLeft + (c.daysLeft === 1 ? ' ден)' : ' дни)')));
    if (await mail(app, u.email, app.cfg.appName + ' – срокове по преписки', 'Срокове по вашите преписки:\n\n' + lines.join('\n') + '\n\n' + app.cfg.appUrl + '#/cases')) sent++;
  }
  return { sent };
}
