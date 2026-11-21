/*
 * Изходящи заявления по ЗДОИ: ЗДОИ4You (от свое име или като пълномощник на клиент) иска информация от задължен субект.
 *   – документи (заявление, уточнение, писмо) с Изх. № ЗДОИ-ГГГГ-NNNN; PDF-ът се създава в браузъра и се пази в SharePoint;
 *   – изпращане по имейл от приемната с адрес за отговор priemna+<етикет>@zdoi.eu;
 *   – входящата поща се разпределя по преписки: по етикета след „+“, по номера в темата или по имейла на субекта.
 */

import { fail, str, line, stamp, todayIso, isoDate, oneOf, intIn, isEmail, validEik, view, byDesc } from './util.js';
import { term, termMonths, daysBetween } from './calendar.js';
import { audit, mail, insertUnique, setting, setSetting } from './core.js';
import { SCHEMA } from './schema.js';
import { notifyOf } from './auth.js';
import { usersBrief, assignCheck } from './users.js';
import { courtView } from './courts.js';
import { getMailbox, plusOf, mailboxAddress, fromB64 } from './mailbox.js';
import { REG_BASIS, allPersons, personOf, codeOf, orgProfile, boxOf, regNoFor, outNoFor, tagFor, allowedCodes, saveDefaultProfile } from './persons.js';

export { REG_BASIS, orgProfile };

export const REQ_STATUS = ['Чернова', 'Изпратено', 'Чака уточняване', 'Уточнено', 'Удължен срок', 'Получен отговор', 'Предоставен достъп', 'Частичен достъп', 'Отказ', 'Мълчалив отказ', 'Обжалвано', 'Приключено'];
export const REQ_WAITING = ['Изпратено', 'Чака уточняване', 'Уточнено', 'Удължен срок'];
export const REQ_KIND = ['Достъп до обществена информация', 'Повторно използване на информация'];
export const REQ_MODE = ['Сдружението', 'Клиент'];
export const REQ_OUTCOME = ['', 'Предоставен достъп', 'Частичен достъп', 'Отказ', 'Препратено (чл. 32)', 'Няма информация (чл. 33)', 'Без разглеждане', 'Мълчалив отказ'];
export const ACCESS_FORMS = [
  'Преглед на информацията – оригинал или копие (чл. 26, ал. 1, т. 1)',
  'Устна справка (чл. 26, ал. 1, т. 2)',
  'Копия на хартиен носител (чл. 26, ал. 1, т. 3)',
  'Копия, предоставени по електронен път, или интернет адрес, на който се съхраняват или са публикувани данните (чл. 26, ал. 1, т. 4)'
];
export const SENT_HOW = ['', 'Имейл', 'Платформа за достъп (чл. 15в)', 'Сигурно електронно връчване', 'Поща', 'Куриер', 'На място'];
/* канали извън имейла от системата: отбелязват се ръчно, с идентификатор и доказателство */
export const CHANNELS = ['Сигурно електронно връчване', 'Поща', 'На място', 'Платформа за достъп (чл. 15в)', 'Куриер', 'Имейл'];
export const POST_KINDS = ['Препоръчано с обратна разписка', 'Препоръчано', 'Обикновено', 'С известие за доставяне (куриер)'];
const PROOF_TYPES = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
export const DOC_KINDS = ['Заявление', 'Уточнение', 'Писмо', 'Промяна на адрес'];
const APPEALABLE = ['Частичен достъп', 'Отказ', 'Без разглеждане', 'Препратено (чл. 32)', 'Няма информация (чл. 33)'];

/* П-2026-0001 → p2026-0001, П-ABC-2026-0001 → pabc-2026-0001 (частта след „+“ в адреса трябва да е на латиница) */
export const tagOf = regNo => 'p' + String(regNo).replace(/^П-/, '').toLowerCase();

/* ---------- срокове от страната на заявителя ---------- */

export function withReqDue(r, today) {
  const o = view(r);
  ['applicant', 'entity', 'points', 'access'].forEach(k => { try { o[k] = JSON.parse(r[k] || (k === 'points' || k === 'access' ? '[]' : '{}')); } catch (_) { o[k] = k === 'points' || k === 'access' ? [] : {}; } });
  o.due = ''; o.dueLabel = ''; o.daysLeft = null; o.ours = false; o.silentBy = ''; o.silentDays = null; o.appealBy = ''; o.appealDays = null;
  const left = iso => daysBetween(today, iso);
  if (r.servedAt && APPEALABLE.includes(r.outcome)) {
    o.appealBy = term(r.servedAt, 14);
    o.appealDays = left(o.appealBy);
  }
  if (!r.sentAt || !(REQ_WAITING.includes(r.status) || r.status === 'Мълчалив отказ')) return o;
  const ext30 = Number(r.ext30) || 0, ext31 = Number(r.ext31) || 0;
  if (r.clarifyAskedAt && !r.clarifySentAt) {
    o.due = term(r.clarifyAskedAt, 30);
    o.dueLabel = 'Наше уточнение (чл. 29, ал. 2 ЗДОИ)';
    o.ours = true;
  } else {
    const base = r.clarifySentAt || r.entityRegDate || r.sentAt;
    o.due = term(base, 14 + ext30 + ext31);
    o.dueLabel = 'Отговор от субекта (чл. 28, ал. 1' + (ext30 ? '; чл. 30' : '') + (ext31 ? '; чл. 31' : '') + ' ЗДОИ)';
    // без решение в срок: мълчалив отказ, който се обжалва в едномесечен срок (чл. 149, ал. 2 АПК)
    o.silentBy = termMonths(o.due, 1);
    o.silentDays = left(o.silentBy);
  }
  o.daysLeft = left(o.due);
  return o;
}

/*
 * Видимост: само преписките на лицата, до които потребителят има достъп; от тях – всички (право „всички преписки“)
 * или възложените на него и въведените от него.
 */
export async function reqScope(app, ctx) {
  const codes = await allowedCodes(app, ctx);
  return r => codes.includes(codeOf(r)) && (!!ctx.perms.casesAll || r.owner === ctx.username || r.createdBy === ctx.username);
}

export async function findReq(app, regNo, ctx) {
  const r = (await app.store.list('requests', { regNo: line(regNo, 40) }))[0];
  if (!r || !(await reqScope(app, ctx))(r)) fail('notfound', 'Преписката не е намерена.');
  return r;
}
const unlocked = r => { if (r.locked === 'Да') fail('caselocked', 'Преписката е заключена от ' + (r.lockedBy || 'администратор') + '.'); };
const event = (app, regNo, user, kind, text) => app.store.insert('events', { regNo, at: stamp(), user, kind, text: String(text).slice(0, 4000) });

export const reqLists = () => ({ reqStatuses: REQ_STATUS, reqKinds: REQ_KIND, reqModes: REQ_MODE, reqOutcomes: REQ_OUTCOME, accessForms: ACCESS_FORMS, regBasis: REG_BASIS, sentHow: SENT_HOW, docKinds: DOC_KINDS, channels: CHANNELS, postKinds: POST_KINDS });

/* ---------- данни на заявителя и субекта ---------- */

function party(d, label, needEmail) {
  const p = {
    type: line(d.type, 80), name: line(d.name, 250), regBasis: oneOf(d.regBasis || '', REG_BASIS, 'Регистрация'), eik: line(d.eik, 13),
    address: line(d.address, 400), oblast: line(d.oblast, 80), email: line(d.email, 200).toLowerCase(), phone: line(d.phone, 40),
    rep: line(d.rep, 160), repPosition: line(d.repPosition, 160), id: line(d.id, 20)
  };
  if (p.eik && !validEik(p.eik)) fail('eik', 'Невалиден ' + (p.regBasis === REG_BASIS[2] ? 'код по БУЛСТАТ' : 'ЕИК') + ' на ' + label + '.');
  if (p.email && !isEmail(p.email)) fail('email', 'Невалиден имейл на ' + label + '.');
  if (needEmail && !p.name) fail('required', 'Посочете ' + label + '.');
  return p;
}

function reqFields(d, person) {
  const mode = oneOf(d.mode || 'Сдружението', REQ_MODE, 'Заявител');
  const applicant = mode === 'Клиент' ? party(d.applicant || {}, 'заявителя', true) : {};
  if (mode === 'Клиент' && !applicant.address && !applicant.email) fail('required', 'Посочете адрес или имейл на заявителя (чл. 25, ал. 1, т. 4).');
  const entity = party(d.entity || {}, 'задължения субект', true);
  const points = (Array.isArray(d.points) ? d.points : []).map(p => str(p, 4000)).filter(Boolean).slice(0, 60);
  const access = (Array.isArray(d.access) ? d.access : []).filter(a => ACCESS_FORMS.includes(a));
  return {
    mode, applicant: JSON.stringify(applicant), applicantName: mode === 'Клиент' ? applicant.name : (person.brand || person.name),
    entity: JSON.stringify(entity), entityId: entity.id, entityName: entity.name, entityEmail: entity.email,
    kind: oneOf(d.kind || REQ_KIND[0], REQ_KIND, 'Вид'), title: line(d.title, 250), points: JSON.stringify(points), motives: str(d.motives, 20000),
    access: JSON.stringify(access), noPublish: d.noPublish === true || d.noPublish === 'Да' ? 'Да' : 'Не'
  };
}

/* ---------- преписки ---------- */

export async function reqList(d, ctx, app) {
  const today = todayIso(), see = await reqScope(app, ctx), only = line(d.person, 10);
  const rows = (await app.store.list('requests')).filter(r => see(r) && (!only || codeOf(r) === only)).map(r => {
    const o = withReqDue(r, today);
    o.person = codeOf(r);
    delete o.motives; delete o.appealNote; delete o.notes;
    o.pointsCount = o.points.length; delete o.points;
    return o;
  }).reverse();
  return { requests: rows };
}

export async function reqGet(d, ctx, app) {
  const r = await findReq(app, d.regNo, ctx);
  const [docs, mails, events, courts] = await Promise.all([
    app.store.list('docs', { regNo: r.regNo }), app.store.list('mail', { regNo: r.regNo }), app.store.list('events', { regNo: r.regNo }), app.store.list('courts')
  ]);
  const person = await personOf(app, codeOf(r)), box = boxOf(app, person);
  return {
    request: Object.assign(withReqDue(r, todayIso()), { person: person.code }), person,
    replyTo: plusOf(box, r.tag || tagOf(r.regNo)), mailbox: box,
    docs: docs.map(x => Object.assign(view(x), { payload: safeJson(x.payload) })).sort(byDesc('at')),
    mail: mails.map(mailView).sort(byDesc('at')), events: events.map(view).reverse(),
    courts: courts.filter(x => x.regNo === r.regNo).map(x => courtView(x))
  };
}

const safeJson = t => { try { return JSON.parse(t || '{}'); } catch (_) { return {}; } };
/* празна колона в SharePoint е null и не се намира с eq '', затова се филтрира тук */
/* boxes: само писмата до тези кутии (тези на лицата, до които потребителят има достъп) */
const unassigned = async (app, boxes) => (await app.store.list('mail'))
  .filter(m => !m.regNo && m.direction === 'Входяща' && (!boxes || boxes.includes(m.box || mailboxAddress(app.env))));
/* кутиите на лицата, до които потребителят има достъп */
async function myBoxes(app, ctx) {
  const codes = await allowedCodes(app, ctx);
  return [...new Set((await allPersons(app)).filter(p => codes.includes(p.code)).map(p => boxOf(app, p)))];
}
/* само кутията на избраното лице (ако е посочено и има достъп до него) */
async function personBoxes(app, ctx, code) {
  const mine = await myBoxes(app, ctx);
  if (!code) return mine;
  const p = (await allPersons(app)).find(x => x.code === code);
  return p ? mine.filter(b => b === boxOf(app, p)) : mine;
}
const mailView = m => Object.assign(view(m), { attachments: safeJson(m.attachments || '[]'), to: m.to, graphId: undefined });

async function checkOwner(app, owner) {
  if (!owner) return '';
  if (!(await usersBrief(app)).some(x => x.username === owner)) fail('value', 'Отговорникът трябва да е активен потребител.');
  return owner;
}

/* лицето, от чието име е новата преписка: трябва потребителят да има достъп до него и то да е активно */
async function personFor(app, ctx, code) {
  const all = await allPersons(app);
  const p = code ? all.find(x => x.code === code) : all.find(x => x.isDefault);
  if (!p || !(await allowedCodes(app, ctx)).includes(p.code)) fail('role', 'Нямате достъп до преписките на това лице.');
  if (!p.active) fail('value', 'Лицето е спряно – не се създават нови преписки от негово име.');
  return p;
}

export async function reqCreate(d, ctx, app) {
  const person = await personFor(app, ctx, line(d.person, 10));
  const v = reqFields(d, person);
  v.owner = await checkOwner(app, line(d.owner, 40));
  assignCheck(ctx, '', v.owner);
  v.person = person.code;
  const y = todayIso().slice(0, 4);
  const rec = await insertUnique(app, 'requests', {}, 'regNo', n => regNoFor(person, y, n),
    Object.assign({ createdAt: stamp(), createdBy: ctx.username, updatedAt: stamp(), status: 'Чернова' }, v));
  await app.store.patch('requests', rec._id, { tag: tagFor(person, rec.regNo) });
  await event(app, rec.regNo, ctx.username, 'Създаване', 'Преписката е създадена.');
  await audit(app, ctx.username, 'Ново заявление (чернова)', rec.regNo, v.entityName);
  return { regNo: rec.regNo };
}

const DATES = ['sentAt', 'entityRegDate', 'clarifyAskedAt', 'clarifySentAt', 'decisionDate', 'servedAt'];

export async function reqUpdate(d, ctx, app) {
  const r = await findReq(app, d.regNo, ctx);
  unlocked(r);
  const person = await personOf(app, codeOf(r));
  const v = d.contentOnly ? reqFields(d, person) : Object.assign(reqFields(d, person), {
    status: oneOf(d.status || r.status, REQ_STATUS, 'Статус'), sentHow: oneOf(d.sentHow || '', SENT_HOW, 'Начин на изпращане'),
    entityRegNo: line(d.entityRegNo, 60), ext30: intIn(d.ext30, 0, 10, 'Удължаване по чл. 30'), ext31: intIn(d.ext31, 0, 14, 'Удължаване по чл. 31'),
    decisionNo: line(d.decisionNo, 60), outcome: oneOf(d.outcome || '', REQ_OUTCOME, 'Резултат'),
    appealed: d.appealed === true || d.appealed === 'Да' ? 'Да' : 'Не', appealNote: str(d.appealNote, 4000), notes: str(d.notes, 8000)
  });
  if (!d.contentOnly) {
    DATES.forEach(k => { v[k] = isoDate(d[k], SCHEMA.requests[1][k][0]); });
    if (v.entityRegDate && v.sentAt && v.entityRegDate < v.sentAt) fail('date', 'Входящата дата при субекта не може да е преди изпращането.');
    if (v.clarifySentAt && !v.clarifyAskedAt) fail('date', 'Въведете кога субектът е поискал уточняване.');
    if (v.servedAt && v.decisionDate && v.servedAt < v.decisionDate) fail('date', 'Решението не може да е получено преди датата му.');
  }
  const changed = Object.keys(v).filter(k => String(v[k]) !== String(r[k] || ''));
  if (!changed.length) return { regNo: r.regNo };
  const patch = { updatedAt: stamp() };
  changed.forEach(k => { patch[k] = v[k]; });
  await app.store.patch('requests', r._id, patch);
  const labels = SCHEMA.requests[1], json = ['applicant', 'entity', 'points', 'access', 'motives', 'appealNote', 'notes'];
  await event(app, r.regNo, ctx.username, 'Промяна', changed.map(k => labels[k][0] + (json.includes(k) ? '' : ': ' + (v[k] || '—'))).join('; '));
  if (patch.status) await notifyOwner(app, ctx, r, 'Нов статус: ' + patch.status);
  return { regNo: r.regNo };
}

/*
 * Нов адрес за отговор: етикетът става във формата с кода на лицето (или се взема кутията на лицето, ако е сменена).
 * Писмата до стария адрес продължават да се разпознават; субектът се уведомява с документ „Промяна на адрес“.
 */
export async function reqRetag(d, ctx, app) {
  const r = await findReq(app, d.regNo, ctx);
  unlocked(r);
  const person = await personOf(app, codeOf(r)), box = boxOf(app, person);
  const oldTag = r.tag || tagOf(r.regNo), newTag = tagFor(person, r.regNo);
  // предишната кутия: от последното изпратено писмо по преписката (ако кутията на лицето е сменена)
  const sent = (await app.store.list('mail', { regNo: r.regNo })).filter(m => m.box && m.direction === 'Изходяща').sort(byDesc('at'))[0];
  const oldReplyTo = plusOf(sent ? sent.box : box, oldTag), replyTo = plusOf(box, newTag);
  if (oldReplyTo === replyTo) return { replyTo, oldReplyTo, changed: false };
  await app.store.patch('requests', r._id, { tag: newTag, updatedAt: stamp() });
  await event(app, r.regNo, ctx.username, 'Адрес за отговор', 'Нов адрес за отговор: ' + replyTo + ' (предишен: ' + oldReplyTo + ' – писмата до него също се разпознават).');
  await audit(app, ctx.username, 'Нов адрес за отговор', r.regNo, replyTo);
  return { replyTo, oldReplyTo, changed: true };
}

export async function reqAssign(d, ctx, app) {
  const r = await findReq(app, d.regNo, ctx);
  unlocked(r);
  const owner = await checkOwner(app, line(d.owner, 40));
  if (owner === r.owner) return { owner };
  if (!ctx.perms.assign && !ctx.perms.reqEdit && !ctx.perms.reqCreate) fail('role', 'Нямате право за това действие.');
  assignCheck(ctx, r.owner || '', owner);
  await app.store.patch('requests', r._id, { owner, updatedAt: stamp() });
  await event(app, r.regNo, ctx.username, 'Отговорник', owner ? 'Отговорник: ' + owner : 'Без отговорник');
  if (owner && owner !== ctx.username) await notifyOwner(app, ctx, Object.assign({}, r, { owner }), 'Определени сте за отговорник.', 'assign');
  return { owner };
}

export async function reqLock(d, ctx, app) {
  const r = await findReq(app, d.regNo, ctx), want = d.locked === true, admin = !!ctx.admin;
  if (want === (r.locked === 'Да')) return { locked: want };
  if (want && !admin && r.owner !== ctx.username) fail('role', 'Заключва отговорникът или администратор.');
  if (!want && !admin && r.lockedBy !== ctx.username) fail('role', 'Отключва заключилият или администратор.');
  await app.store.patch('requests', r._id, want ? { locked: 'Да', lockedBy: ctx.username, lockedAt: stamp() } : { locked: '', lockedBy: '', lockedAt: '' });
  await event(app, r.regNo, ctx.username, want ? 'Заключване' : 'Отключване', line(d.reason, 300) || (want ? 'Заключена.' : 'Отключена.'));
  return { locked: want };
}

export async function reqComment(d, ctx, app) {
  const r = await findReq(app, d.regNo, ctx), text = str(d.text, 4000);
  unlocked(r);
  if (!text) fail('required', 'Напишете текст.');
  await event(app, r.regNo, ctx.username, 'Коментар', text);
  await notifyOwner(app, ctx, r, 'Нов коментар.', 'comments');
  return {};
}

async function notifyOwner(app, ctx, r, text, kind = 'status') {
  if (!r.owner || (ctx && r.owner === ctx.username)) return;
  const u = (await app.store.list('users', { username: r.owner }))[0];
  if (!u || u.active !== 'Да' || !u.email || !notifyOf(u)[kind]) return;
  await mail(app, u.email, app.cfg.appName + ' – ' + r.regNo, text + '\n\n' + app.cfg.appUrl + '#/request/' + encodeURIComponent(r.regNo));
}

/* ---------- документи с Изх. № ---------- */

/* запазва съдържанието и дава Изх. № (нов документ) или обновява чернова, която още не е изпратена */
export async function docReserve(d, ctx, app) {
  const r = await findReq(app, d.regNo, ctx);
  unlocked(r);
  const kind = oneOf(d.kind, DOC_KINDS, 'Вид документ');
  const payload = d.payload && typeof d.payload === 'object' ? JSON.stringify(d.payload) : '{}';
  if (payload.length > 60000) fail('size', 'Документът е твърде дълъг.');
  const title = line(d.title || kind, 250);
  if (d.outNo) {
    const doc = (await app.store.list('docs', { outNo: line(d.outNo, 30) }))[0];
    if (!doc || doc.regNo !== r.regNo) fail('notfound', 'Документът не е намерен.');
    if (doc.sentAt) fail('value', 'Документът вече е изпратен и не се променя. Създайте нов.');
    if (/"_sig"\s*:/.test(doc.payload || '')) fail('value', 'Документът е подписан с КЕП и не се променя. Създайте нов.');
    await app.store.patch('docs', doc._id, { payload, title });
    await event(app, r.regNo, ctx.username, 'Документ', 'Редактиран: ' + doc.kind + ' изх. № ' + doc.outNo);
    return { outNo: doc.outNo, date: doc.date };
  }
  const date = todayIso(), y = date.slice(0, 4), person = await personOf(app, codeOf(r));
  // проследяемост: първият документ по преписката получава главния Изх. №, следващите – същия с индекс (…-0005-1, …-0005-2)
  const main = mainOutNo(r, await app.store.list('docs', { regNo: r.regNo }));
  const rec = await insertUnique(app, 'docs', {}, 'outNo', main ? n => main + '-' + n : n => outNoFor(person, y, n),
    { regNo: r.regNo, kind, date, title, payload, by: ctx.username, at: stamp() });
  if (kind === 'Заявление' && !r.outNo) await app.store.patch('requests', r._id, { outNo: rec.outNo, updatedAt: stamp() });
  await event(app, r.regNo, ctx.username, 'Документ', kind + ' изх. № ' + rec.outNo);
  await audit(app, ctx.username, 'Нов документ', rec.outNo, kind + ' по ' + r.regNo);
  return { outNo: rec.outNo, date };
}

/* главният Изх. № на преписката: на заявлението, иначе на първия документ без индекс */
const PLAIN_NO = /^[A-ZА-Я0-9]{2,10}-\d{4}-\d{4}$/;
export function mainOutNo(r, docs) {
  if (r.outNo && PLAIN_NO.test(r.outNo)) return r.outNo;
  const first = docs.filter(x => PLAIN_NO.test(x.outNo || '')).sort((a, b) => Number(a._id) - Number(b._id))[0];
  return first ? first.outNo : '';
}

const MAX_PDF = 8 * 1048576;

export async function docFile(d, ctx, app) {
  const doc = (await app.store.list('docs', { outNo: line(d.outNo, 30) }))[0];
  if (!doc) fail('notfound', 'Документът не е намерен.');
  await findReq(app, doc.regNo, ctx);
  const bytes = fromB64(String(d.pdf || ''));
  if (bytes.length < 100 || bytes.length > MAX_PDF || String.fromCharCode(...bytes.slice(0, 4)) !== '%PDF') fail('value', 'Невалиден PDF файл.');
  const f = await app.store.uploadFile(doc.regNo + '/' + doc.outNo + ' ' + doc.kind + '.pdf', bytes, 'application/pdf');
  await app.store.patch('docs', doc._id, { fileId: f.id, fileUrl: f.webUrl });
  return { fileUrl: f.webUrl };
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function docDownload(d, ctx, app) {
  const doc = (await app.store.list('docs', { outNo: line(d.outNo, 30) }))[0];
  if (!doc || !doc.fileId) fail('notfound', 'Файлът не е намерен.');
  await findReq(app, doc.regNo, ctx);
  return { name: doc.outNo + '.pdf', data: b64(await app.store.downloadFile(doc.fileId)) };
}

/* ---------- поща ---------- */

const mailList = v => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map(x => line(x, 200).toLowerCase()).filter(Boolean);

/* проверка на писмото; docs – документите с PDF по преписката */
async function mailInput(app, r, d) {
  const to = mailList(d.to), cc = mailList(d.cc), subject = line(d.subject, 250), text = str(d.text, 30000);
  if (!to.length) fail('required', 'Посочете получател.');
  [...to, ...cc].forEach(a => { if (!isEmail(a)) fail('email', 'Невалиден адрес: ' + a); });
  if (!subject || !text) fail('required', 'Попълнете тема и текст.');
  const docs = [];
  for (const no of (Array.isArray(d.docs) ? d.docs : String(d.docs || '').split(/,\s*/).filter(Boolean)).slice(0, 10)) {
    const doc = (await app.store.list('docs', { outNo: line(no, 30) }))[0];
    if (!doc || doc.regNo !== r.regNo || !doc.fileId) fail('value', 'Документът ' + no + ' няма запазен PDF.');
    docs.push(doc);
  }
  let reply = null;
  if (d.replyTo) {
    reply = await app.store.get('mail', str(d.replyTo, 20));
    if (!reply || reply.regNo !== r.regNo) fail('notfound', 'Писмото не е намерено.');
  }
  return { to, cc, subject, text, docs, reply };
}

/* изпращане от кутията на лицето с адрес за отговор с етикета на преписката; записва писмото и движи сроковете */
async function deliver(app, r, m, by) {
  const attachments = [];
  for (const doc of m.docs) attachments.push({ name: doc.outNo + ' ' + doc.kind + '.pdf', contentType: 'application/pdf', bytes: await app.store.downloadFile(doc.fileId) });
  const box = boxOf(app, await personOf(app, codeOf(r)));
  const replyTo = plusOf(box, r.tag || tagOf(r.regNo));
  try {
    await getMailbox(app.env, box).send({ to: m.to, cc: m.cc, subject: m.subject, text: m.text, replyTo, attachments, replyToGraphId: m.reply ? m.reply.graphId : '' });
  } catch (e) {
    console.error('mail.send: ' + e.message);
    fail('mail', 'Писмото не е изпратено: ' + e.message.slice(0, 200));
  }
  const at = stamp();
  await app.store.insert('mail', {
    regNo: r.regNo, direction: 'Изходяща', channel: 'Имейл', box, at, from: box, to: m.to.join(', '), cc: m.cc.join(', '), subject: m.subject, body: m.text,
    attachments: JSON.stringify(attachments.map(a => ({ name: a.name, size: a.bytes.length }))), docOutNo: m.docs.map(x => x.outNo).join(', '), by, messageId: 'out:' + r.regNo + ':' + Date.now()
  });
  await markSent(app, r, m.docs, at, 'Имейл', m.to.join(', '));
  await event(app, r.regNo, by, 'Изходящо писмо', 'До ' + m.to.join(', ') + ': ' + m.subject + (m.docs.length ? ' (приложени: ' + m.docs.map(x => x.outNo).join(', ') + ')' : ''));
  await audit(app, by, 'Изпратено писмо', r.regNo, m.to.join(', '));
  return replyTo;
}

/* sendAt (по желание): дата и час в София (ГГГГ-ММ-ДДTЧЧ:ММ) – писмото се изпраща тогава (Cron, до 5 минути по-късно) */
export async function mailSend(d, ctx, app) {
  const r = await findReq(app, d.regNo, ctx);
  unlocked(r);
  const m = await mailInput(app, r, d);
  if (d.sendAt) {
    const mm = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(d.sendAt));
    if (!mm) fail('date', 'Невалидни дата и час на изпращане.');
    const at = mm[1] + 'T' + mm[2] + ':' + mm[3] + ':00';
    if (at <= stamp()) fail('date', 'Изберете бъдещ момент за изпращане.');
    if (at > stamp(new Date(Date.now() + 366 * 864e5))) fail('date', 'Писмото се насрочва до една година напред.');
    const box = boxOf(app, await personOf(app, codeOf(r)));
    const rec = await app.store.insert('mail', {
      regNo: r.regNo, direction: SCHEDULED, channel: 'Имейл', box, at, from: box, to: m.to.join(', '), cc: m.cc.join(', '), subject: m.subject, body: m.text,
      attachments: '[]', docOutNo: m.docs.map(x => x.outNo).join(', '), ref: m.reply ? m.reply._id : '', by: ctx.username, messageId: 'sched:' + r.regNo + ':' + Date.now()
    });
    const when = at.slice(8, 10) + '.' + at.slice(5, 7) + '.' + at.slice(0, 4) + ' ' + at.slice(11, 16);
    await event(app, r.regNo, ctx.username, 'Насрочено писмо', 'За ' + when + ' до ' + m.to.join(', ') + ': ' + m.subject + (m.docs.length ? ' (приложени: ' + m.docs.map(x => x.outNo).join(', ') + ')' : ''));
    await audit(app, ctx.username, 'Насрочено писмо', r.regNo, when + ' · ' + m.to.join(', '));
    return { scheduled: true, at, id: rec._id };
  }
  return { sent: true, replyTo: await deliver(app, r, m, ctx.username) };
}

export const SCHEDULED = 'Насрочена';

/* отмяна на насрочено писмо (още неизпратено) */
export async function mailCancel(d, ctx, app) {
  const m = await app.store.get('mail', str(d.id, 20));
  if (!m || m.direction !== SCHEDULED) fail('notfound', 'Насроченото писмо не е намерено или вече е изпратено.');
  const r = await findReq(app, m.regNo, ctx);
  unlocked(r);
  await app.store.remove('mail', m._id);
  await event(app, r.regNo, ctx.username, 'Отменено писмо', 'Отменено насрочено писмо до ' + m.to + ': ' + m.subject);
  return {};
}

/* Cron: насрочените писма, чийто момент е настъпил; при грешка писмото остава с бележка и отговорникът се уведомява */
export async function sendScheduled(app) {
  const now = stamp(), due = (await app.store.list('mail', { direction: SCHEDULED })).filter(m => m.at && m.at <= now);
  const run = { due: due.length, sent: 0, failed: 0 };
  for (const s of due) {
    const r = (await app.store.list('requests', { regNo: s.regNo }))[0];
    try {
      if (!r) fail('notfound', 'Преписката не е намерена.');
      if (r.locked === 'Да') fail('caselocked', 'Преписката е заключена.');
      const m = await mailInput(app, r, { to: s.to, cc: s.cc, subject: s.subject, text: s.body, docs: s.docOutNo, replyTo: s.ref });
      // отбелязва се преди изпращането, за да не се изпрати два пъти, ако следващото пускане на Cron дойде по-рано
      await app.store.patch('mail', s._id, { direction: 'Изпраща се' });
      await deliver(app, r, m, s.by || 'насрочено');
      await app.store.remove('mail', s._id);
      run.sent++;
    } catch (e) {
      run.failed++;
      const note = String(e.message || e).slice(0, 300);
      await app.store.patch('mail', s._id, { direction: 'Неизпратена', body: (s.body || '') + '\n\n[Неизпратено на ' + now.replace('T', ' ').slice(0, 16) + ': ' + note + ']' });
      if (r) {
        await event(app, r.regNo, 'поща', 'Неизпратено писмо', 'Насроченото писмо до ' + s.to + ' не е изпратено: ' + note);
        await notifyOwner(app, null, r, 'Насроченото писмо „' + s.subject + '“ не е изпратено: ' + note, 'mail');
      }
    }
  }
  return run;
}

/* изпратени документи: отбелязва ги и движи сроковете на преписката (заявлението и уточнението) */
async function markSent(app, r, docs, at, how, to, extra = {}) {
  const date = at.slice(0, 10);
  for (const doc of docs) {
    const desc = how + (to ? ': ' + to : '');
    await app.store.patch('docs', doc._id, doc.sentAt
      ? { sentTo: ((doc.sentTo ? doc.sentTo + '; ' : '') + desc).slice(0, 250) }
      : { sentAt: at, sentHow: how, sentTo: desc.slice(0, 250) });
  }
  // сроковете тръгват от първото изпращане; повторното (напр. и по пощата) не ги мести
  const fresh = docs.filter(x => !x.sentAt);
  const patch = { updatedAt: stamp() };
  if (fresh.some(x => x.kind === 'Заявление') && !r.sentAt) Object.assign(patch, { sentAt: date, sentHow: how, status: r.status === 'Чернова' ? 'Изпратено' : r.status });
  if (docs.some(x => x.kind === 'Заявление')) {
    // при подаване на място входящият номер е известен веднага; срокът по чл. 28 тече от регистрирането
    if (extra.entityRegNo && !r.entityRegNo) patch.entityRegNo = extra.entityRegNo;
    if (extra.entityRegDate && !r.entityRegDate) patch.entityRegDate = extra.entityRegDate;
  }
  // само уточнението по искане на органа (чл. 29, ал. 1) рестартира срока; по инициатива на заявителя – не
  const byOrgan = x => x.kind === 'Уточнение' && !/"clarifyBy"\s*:\s*"Инициатива на заявителя"/.test(x.payload || '');
  if (fresh.some(byOrgan)) Object.assign(patch, { clarifySentAt: date, status: 'Уточнено' });
  await app.store.patch('requests', r._id, patch);
}

/*
 * Ръчно отбелязване на кореспонденция извън имейла на системата:
 *   изходяща – изпратено през ССЕВ, по пощата, подадено лично в деловодството, през платформата и др.;
 *   входяща – получено писмо или решение по същите канали (сканирано копие се прилага).
 */
export async function mailRecord(d, ctx, app) {
  const r = await findReq(app, d.regNo, ctx);
  unlocked(r);
  const out = d.direction !== 'Входяща';
  const channel = oneOf(d.channel, CHANNELS, 'Начин');
  const date = isoDate(d.date, 'Дата');
  if (!date) fail('required', 'Посочете датата.');
  const today = todayIso();
  if (date > today) fail('date', 'Датата не може да е в бъдещето.');
  const ref = line(d.ref, 120), party = line(d.party, 400), note = str(d.note, 8000);
  const postKind = channel === 'Поща' || channel === 'Куриер' ? oneOf(d.postKind || '', ['', ...POST_KINDS], 'Вид пратка') : '';
  const entityRegNo = out ? line(d.entityRegNo, 60) : '', entityRegDate = out ? isoDate(d.entityRegDate, 'Вх. дата при субекта') : '';
  if (entityRegDate && entityRegDate < date) fail('date', 'Входящата дата при субекта не може да е преди изпращането.');
  if (entityRegDate && entityRegDate > today) fail('date', 'Входящата дата при субекта не може да е в бъдещето.');
  const docs = [];
  if (out) {
    for (const no of (Array.isArray(d.docs) ? d.docs : []).slice(0, 10)) {
      const doc = (await app.store.list('docs', { outNo: line(no, 30) }))[0];
      if (!doc || doc.regNo !== r.regNo) fail('value', 'Документът ' + no + ' не е от тази преписка.');
      docs.push(doc);
    }
  }
  const subject = line(d.subject, 250) || (docs.length ? docs.map(x => x.kind + ' изх. № ' + x.outNo).join(', ') : '');
  if (!subject) fail('required', 'Посочете относно какво е писмото или изберете документ.');

  // доказателство: обратна разписка, известие от ССЕВ, копие с входящ печат, сканирано писмо
  const atts = [];
  if (d.file && d.file.data) {
    const type = String(d.file.contentType || '');
    if (!PROOF_TYPES[type]) fail('value', 'Файлът трябва да е PDF, JPG или PNG.');
    const bytes = fromB64(String(d.file.data));
    if (bytes.length < 50 || bytes.length > MAX_PDF) fail('size', 'Файлът трябва да е до 8 MB.');
    let name = line(d.file.name, 120).replace(/[\\/]/g, '_') || (out ? 'доказателство' : 'писмо') + PROOF_TYPES[type];
    if (!/\.[a-z0-9]{2,4}$/i.test(name)) name += PROOF_TYPES[type];
    const f = await app.store.uploadFile(r.regNo + '/' + (out ? 'Изходящи' : 'Входящи') + '/' + date + ' ' + name, bytes, type);
    atts.push({ name, size: bytes.length, contentType: type, fileId: f.id, url: f.webUrl });
  }

  const at = date === today ? stamp() : date + 'T00:00:00';
  const who = out ? party || (r.entityName || '') : '';
  const person = await personOf(app, codeOf(r)), org = person.name;
  const body = [postKind, ref ? (channel === 'Сигурно електронно връчване' ? 'Идентификатор в ССЕВ: ' : channel === 'Поща' || channel === 'Куриер' ? '№ на пратката: ' : out ? 'Идентификатор: ' : 'Изх. № на подателя: ') + ref : '',
    entityRegNo ? 'Вх. № при субекта: ' + entityRegNo + (entityRegDate ? ' от ' + entityRegDate.split('-').reverse().join('.') : '') : '', note].filter(Boolean).join('\n');
  const rec = await app.store.insert('mail', {
    regNo: r.regNo, direction: out ? 'Изходяща' : 'Входяща', channel, ref, at, subject, body, box: boxOf(app, person),
    from: out ? org : party || (r.entityName || ''), to: out ? who : org, cc: '',
    attachments: JSON.stringify(atts), docOutNo: docs.map(x => x.outNo).join(', '), by: ctx.username, messageId: 'rec:' + r.regNo + ':' + Date.now()
  });
  if (out) await markSent(app, r, docs, at, channel, ref || who, { entityRegNo, entityRegDate });
  const text = (out ? 'Изпратено (' : 'Получено (') + channel + (postKind ? ', ' + postKind.toLowerCase() : '') + ') на ' + date.split('-').reverse().join('.') + ': ' + subject +
    (ref ? ' · ' + ref : '') + (entityRegNo ? ' · вх. № ' + entityRegNo : '') + (atts.length ? ' · приложено: ' + atts[0].name : '');
  await event(app, r.regNo, ctx.username, out ? 'Изходящо писмо' : 'Входящо писмо', text);
  await audit(app, ctx.username, out ? 'Отбелязано изпращане' : 'Регистрирано получено писмо', r.regNo, channel + (ref ? ' ' + ref : ''));
  if (!out) await notifyOwner(app, ctx, r, 'Получено писмо (' + channel + '): ' + subject, 'mail');
  return { id: rec._id };
}

export async function mailInbox(d, ctx, app) {
  const boxes = await personBoxes(app, ctx, line(d.person, 10));
  return { mail: (await unassigned(app, boxes)).map(mailView).sort(byDesc('at')), boxes };
}

export async function mailAssign(d, ctx, app) {
  const m = await app.store.get('mail', str(d.id, 20));
  if (!m || !(await myBoxes(app, ctx)).includes(m.box || mailboxAddress(app.env))) fail('notfound', 'Писмото не е намерено.');
  const r = await findReq(app, d.regNo, ctx);
  await app.store.patch('mail', m._id, { regNo: r.regNo, matched: 'ръчно (' + ctx.username + ')' });
  await event(app, r.regNo, ctx.username, 'Входящо писмо', 'Разпределено ръчно: ' + m.from + ' – ' + m.subject);
  return {};
}

export async function mailAttachment(d, ctx, app) {
  const m = await app.store.get('mail', str(d.id, 20));
  if (!m) fail('notfound', 'Писмото не е намерено.');
  if (m.regNo) await findReq(app, m.regNo, ctx);
  else if (!ctx.perms.mailbox || !(await myBoxes(app, ctx)).includes(m.box || mailboxAddress(app.env))) fail('notfound', 'Писмото не е намерено.');
  const a = safeJson(m.attachments || '[]')[Number(d.index)];
  if (!a || !a.fileId) fail('notfound', 'Файлът не е намерен.');
  return { name: a.name, contentType: a.contentType || 'application/octet-stream', data: b64(await app.store.downloadFile(a.fileId)) };
}

/* ---------- автоматично разпределяне на входящата поща ---------- */

/* известие от ССЕВ (edelivery.egov.bg) за ново съобщение в профила на Сдружението */
export const isSsev = msg => /(^|[@.])(e-?gov\.bg)$/i.test(String(msg.from || '').split('@')[1] || '') &&
  /edelivery|ССЕВ|сигурно електронно връчване/i.test([msg.from, msg.fromName, msg.subject, String(msg.body || '').slice(0, 3000)].join(' '));

const norm = s => String(s || '').toLowerCase().replace(/[„“"'«»]/g, '').replace(/\s+/g, ' ').trim();

/* в известието от ССЕВ подателят е институцията: търси се по наименованието ѝ сред чакащите преписки */
function matchSsev(msg, requests) {
  const text = norm(msg.subject + ' ' + String(msg.body || '').slice(0, 6000));
  const open = requests.filter(x => x.entityName && norm(x.entityName).length > 4 && text.includes(norm(x.entityName)) &&
    (REQ_WAITING.includes(x.status) || x.status === 'Мълчалив отказ'));
  const viaSsev = open.filter(x => x.sentHow === 'Сигурно електронно връчване');
  const pick = viaSsev.length === 1 ? viaSsev : open;
  return pick.length === 1 ? [pick[0], 'ССЕВ: ' + pick[0].entityName] : [null, ''];
}

/* box: кутията, в която е получено писмото; requests: преписките на лицата с тази кутия */
export async function matchRequest(app, msg, requests, box) {
  const local = String(box || mailboxAddress(app.env)).split('@')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const plus = new RegExp('^' + local + '\\+([a-z0-9-]+)@', 'i');
  for (const a of [...msg.to, ...msg.cc]) {
    const m = plus.exec(a);
    if (m) { const t = m[1].toLowerCase(), r = requests.find(x => x.tag === t || tagOf(x.regNo) === t); if (r) return [r, 'етикет +' + m[1]]; }
  }
  let m = /П-(?:([A-Z][A-Z0-9]{1,9})-)?(\d{4})-(\d{4})/.exec(msg.subject);
  if (m) { const no = 'П-' + (m[1] ? m[1] + '-' : '') + m[2] + '-' + m[3]; const r = requests.find(x => x.regNo === no); if (r) return [r, 'номер в темата']; }
  // Изх. № на документ: префиксът е на лицето (ЗДОИ-2026-0001, АБВ-2026-0001…)
  const outNos = [...new Set((msg.subject + ' ' + msg.body.slice(0, 4000)).match(/(?<![A-ZА-Я0-9-])[A-ZА-Я0-9]{2,10}-\d{4}-\d{4}/g) || [])].slice(0, 5);
  for (const no of outNos) {
    const doc = (await app.store.list('docs', { outNo: no }))[0];
    const r = doc && requests.find(x => x.regNo === doc.regNo);
    if (r) return [r, 'Изх. № ' + doc.outNo];
  }
  const from = msg.from.toLowerCase(), byEmail = requests.filter(x => x.entityEmail && x.entityEmail === from && REQ_WAITING.includes(x.status));
  if (byEmail.length === 1) return [byEmail[0], 'имейл на субекта'];
  if (isSsev(msg)) return matchSsev(msg, requests);
  return [null, ''];
}

/* кутията на приемната пази старото име на настройката; другите – със суфикс */
const markKey = (app, box) => box === mailboxAddress(app.env) ? 'mailWatermark' : 'mailWatermark:' + box;

/* всички кутии: тази на приемната и собствените кутии на активните лица */
export async function pollMail(app, { manual } = {}) {
  if (!manual && (await setting(app, 'mailPoll', 'Да')) !== 'Да') return { skipped: 'изключено' };
  const persons = await allPersons(app);
  const boxes = [...new Set([mailboxAddress(app.env)].concat(persons.filter(p => p.active).map(p => boxOf(app, p))))];
  const requests = await app.store.list('requests');
  const run = { at: stamp(), fetched: 0, saved: 0, matched: 0, error: '', boxes: [] };
  for (const box of boxes) {
    const codes = persons.filter(p => boxOf(app, p) === box).map(p => p.code);
    const one = await pollBox(app, box, requests.filter(r => codes.includes(codeOf(r))));
    ['fetched', 'saved', 'matched'].forEach(k => { run[k] += one[k]; });
    if (one.error) run.error = (run.error ? run.error + '; ' : '') + (boxes.length > 1 ? box + ': ' : '') + one.error;
    run.boxes.push(Object.assign({ box }, one));
  }
  await setSetting(app, 'mailLastRun', JSON.stringify(run));
  return run;
}

async function pollBox(app, box, requests) {
  const key = markKey(app, box);
  const since = (await setting(app, key, '')) || new Date(Date.now() - 86400000).toISOString();
  const run = { fetched: 0, saved: 0, matched: 0, error: '' };
  try {
    const msgs = await getMailbox(app.env, box).fetchSince(since);
    run.fetched = msgs.length;
    let mark = since;
    for (const msg of msgs) {
      if (msg.at > mark) mark = msg.at;
      if ((await app.store.list('mail', { messageId: msg.messageId })).length) continue;
      if (msg.from.toLowerCase() === box) continue; // собствените писма
      const [r, how] = await matchRequest(app, msg, requests, box);
      const folder = (r ? r.regNo : 'Неразпределени') + '/' + msg.at.slice(0, 10);
      const atts = [];
      for (const a of msg.attachments.slice(0, 20)) {
        if (a.bytes.length > 25 * 1048576) { atts.push({ name: a.name, size: a.bytes.length, skipped: 'твърде голям' }); continue; }
        const f = await app.store.uploadFile(folder + '/' + a.name, a.bytes, a.contentType);
        atts.push({ name: a.name, size: a.bytes.length, contentType: a.contentType, fileId: f.id, url: f.webUrl });
      }
      await app.store.insert('mail', {
        regNo: r ? r.regNo : '', messageId: msg.messageId, direction: 'Входяща', box, at: stamp(new Date(msg.at)), from: msg.from + (msg.fromName ? ' (' + msg.fromName + ')' : ''),
        to: msg.to.join(', '), cc: msg.cc.join(', '), subject: msg.subject, body: msg.body.slice(0, 60000), graphId: msg.graphId,
        attachments: JSON.stringify(atts), matched: how, channel: isSsev(msg) ? 'Сигурно електронно връчване' : 'Имейл'
      });
      run.saved++;
      if (r) {
        run.matched++;
        const ssev = isSsev(msg);
        await event(app, r.regNo, 'поща', ssev ? 'Съобщение в ССЕВ' : 'Входящо писмо', ssev
          ? 'Ново съобщение в ССЕВ от ' + r.entityName + ' – прочетете го в edelivery.egov.bg (профила, от който е подадено заявлението) и го регистрирайте („Регистрирай получено“).'
          : msg.from + ': ' + msg.subject + (atts.length ? ' (' + atts.length + ' прикачени)' : ''));
        await notifyOwner(app, null, r, ssev ? 'Ново съобщение в ССЕВ от ' + r.entityName + '. Отворете edelivery.egov.bg (профила, от който е подадено заявлението).' : 'Получено писмо от ' + msg.from + ': ' + msg.subject, 'mail');
      }
    }
    await setSetting(app, key, mark);
  } catch (e) {
    run.error = String(e.message || e).slice(0, 300);
    console.error('pollMail ' + box + ': ' + run.error);
  }
  return run;
}

/* ---------- системни процеси (администратор) ---------- */

export async function systemGet(d, ctx, app) {
  const docs = await app.store.list('docs');
  const y = todayIso().slice(0, 4), used = new Set(docs.map(x => x.outNo));
  const next = p => { let n = 1; while (used.has(outNoFor(p, y, n))) n++; return outNoFor(p, y, n); };
  const persons = await allPersons(app), def = persons.find(p => p.isDefault);
  return {
    org: await orgProfile(app), mailbox: mailboxAddress(app.env), sampleReplyTo: plusOf(boxOf(app, def), tagFor(def, 'П-' + y + '-0001')),
    mailPoll: (await setting(app, 'mailPoll', 'Да')) === 'Да', mailWatermark: await setting(app, 'mailWatermark', ''),
    mailLastRun: safeJson(await setting(app, 'mailLastRun', '{}')), nextOutNo: next(def),
    registers: persons.map(p => ({ code: p.code, name: p.name, active: p.active, box: boxOf(app, p), nextOutNo: next(p), regNo: regNoFor(p, y, 1).replace(/0001$/, 'NNNN'), replyTo: plusOf(boxOf(app, p), tagFor(p, regNoFor(p, y, 1))) })),
    unassigned: (await unassigned(app)).length,
    lastReminder: await app.kv.get('remind:' + todayIso()) ? 'днес' : 'не днес'
  };
}

export async function systemSave(d, ctx, app) {
  if (d.org) await saveDefaultProfile(app, ctx, d.org);
  if (typeof d.mailPoll === 'boolean') {
    await setSetting(app, 'mailPoll', d.mailPoll ? 'Да' : 'Не');
    await audit(app, ctx.username, d.mailPoll ? 'Включено автоматично четене на пощата' : 'Спряно автоматично четене на пощата', '', '');
  }
  return systemGet(d, ctx, app);
}

export async function systemPoll(d, ctx, app) {
  const r = await pollMail(app, { manual: true });
  await audit(app, ctx.username, 'Ръчна проверка на пощата', '', JSON.stringify(r));
  return { run: r };
}

/* ---------- табло ---------- */

export async function reqDashboard(app, ctx, only) {
  const today = todayIso(), see = await reqScope(app, ctx);
  const rows = (await app.store.list('requests')).filter(r => see(r) && (!only || codeOf(r) === only)).map(r => withReqDue(r, today));
  const brief = r => ({ regNo: r.regNo, entityName: r.entityName, status: r.status, due: r.due, dueLabel: r.dueLabel, daysLeft: r.daysLeft, ours: r.ours, silentBy: r.silentBy, silentDays: r.silentDays, appealBy: r.appealBy, appealDays: r.appealDays });
  return {
    reqTotal: rows.length, reqDrafts: rows.filter(r => r.status === 'Чернова').length,
    reqWaiting: rows.filter(r => r.due).map(brief).sort((a, b) => a.due.localeCompare(b.due)),
    reqSilent: rows.filter(r => r.due && !r.ours && r.daysLeft < 0 && r.silentDays >= 0).map(brief),
    reqAppeals: rows.filter(r => r.appealDays !== null && r.appealDays >= 0).map(brief),
    unassignedMail: ctx.perms.mailbox ? (await unassigned(app, await personBoxes(app, ctx, only))).length : 0
  };
}

/* ---------- изходящ регистър на лицето: всички документи с Изх. № ---------- */

export async function registerList(d, ctx, app) {
  const codes = await allowedCodes(app, ctx);
  const code = line(d.person, 10) || codes[0];
  if (!codes.includes(code)) fail('role', 'Нямате достъп до регистъра на това лице.');
  const see = await reqScope(app, ctx);
  const reqs = new Map((await app.store.list('requests')).filter(r => codeOf(r) === code && see(r)).map(r => [r.regNo, r]));
  const docs = (await app.store.list('docs')).filter(x => reqs.has(x.regNo)).map(x => {
    const r = reqs.get(x.regNo);
    return { outNo: x.outNo, date: x.date, kind: x.kind, title: x.title, regNo: x.regNo, entityName: r.entityName, sentAt: x.sentAt, sentHow: x.sentHow, sentTo: x.sentTo, signed: /"_sig"\s*:/.test(x.payload || ''), by: x.by };
  }).sort((a, b) => String(b.outNo).localeCompare(String(a.outNo)));
  return { person: await personOf(app, code), docs, requests: reqs.size };
}
