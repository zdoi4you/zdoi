/*
 * Ръководство и тикети.
 *
 * Ръководството е само в базата (списък „ADM Ръководство“) – не е в кода и не е на публичния сайт; вижда се само след
 * вход. Всеки раздел има „За кого“ (роли; празно – всички) и по желание „Нужно право“: потребителят вижда само
 * разделите за своята роля и права. Редактира се от администратор с право „help“ (и чрез импорт от Markdown файл).
 *
 * Тикети: всеки потребител подава сигнал за проблем, въпрос или заявка (категории – вкл. отворени данни и регистри),
 * вижда своите и пише по тях. С право „tickets“ се виждат всички, сменят се статус, приоритет и отговорник и се пишат
 * вътрешни бележки (не се виждат от подателя). Известия по имейл при нов тикет и при отговор.
 */

import { ROLES } from './config.js';
import { fail, str, line, stamp, oneOf, view, byDesc } from './util.js';
import { audit, mail } from './core.js';
import { permsOf } from './auth.js';

/* ---------- ръководство ---------- */

const MAX_BODY = 60000;
const slug = t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'razdel';
const rolesOf = v => String(v || '').split(',').map(x => x.trim()).filter(x => ROLES.includes(x));

/* вижда ли потребителят раздела: ролята е сред „За кого“ (или няма ограничение) и има нужното право */
export const seesSection = (s, ctx) => {
  const roles = rolesOf(s.audience);
  if (roles.length && !roles.includes(ctx.role)) return false;
  return !s.perm || !!ctx.perms[s.perm];
};
const sectionView = s => ({ _id: s._id, key: s.key, title: s.title, audience: rolesOf(s.audience), perm: s.perm || '', order: Number(s.order) || 0, body: s.body || '', updatedAt: s.updatedAt || s.at || '', by: s.by || '' });
const byOrder = (a, b) => a.order - b.order || a.title.localeCompare(b.title, 'bg');

export async function helpList(d, ctx, app) {
  const rows = (await app.store.list('help')).map(sectionView).sort(byOrder);
  const editor = !!ctx.perms.help;
  // редакторът вижда всички раздели, а с „as“ – както ги вижда дадена роля (само по роля, без отделните права)
  const as = editor && ROLES.includes(d.as) ? d.as : '';
  const visible = editor && !as ? rows : rows.filter(s => as ? !rolesOf(s.audience).length || rolesOf(s.audience).includes(as) : seesSection(s, ctx));
  return { sections: visible, editor, roles: ROLES, total: rows.length };
}

function sectionFields(d) {
  const v = {
    title: line(d.title, 200), audience: rolesOf(Array.isArray(d.audience) ? d.audience.join(',') : d.audience).join(', '),
    perm: line(d.perm, 40), order: String(Math.max(0, Math.min(9999, Math.round(Number(d.order) || 0)))), body: str(d.body, MAX_BODY)
  };
  if (!v.title) fail('required', 'Посочете заглавие.');
  if (v.perm && !/^[a-zA-Z]{2,30}$/.test(v.perm)) fail('value', 'Невалидно право.');
  return v;
}

export async function helpSave(d, ctx, app) {
  const v = sectionFields(d);
  const rows = await app.store.list('help');
  if (d.id) {
    const cur = rows.find(r => r._id === String(d.id));
    if (!cur) fail('notfound', 'Разделът не е намерен.');
    await app.store.patch('help', cur._id, Object.assign(v, { updatedAt: stamp(), by: ctx.username }));
    await audit(app, ctx.username, 'Промяна в ръководството', v.title, '');
    return { id: cur._id };
  }
  let key = slug(v.title), n = 2;
  while (rows.some(r => r.key === key)) key = slug(v.title) + '-' + n++;
  const rec = await app.store.insert('help', Object.assign(v, { key, at: stamp(), updatedAt: stamp(), by: ctx.username }));
  await audit(app, ctx.username, 'Нов раздел в ръководството', v.title, '');
  return { id: rec._id, key };
}

export async function helpDelete(d, ctx, app) {
  const cur = (await app.store.list('help')).find(r => r._id === String(d.id || ''));
  if (!cur) fail('notfound', 'Разделът не е намерен.');
  await app.store.remove('help', cur._id);
  await audit(app, ctx.username, 'Изтрит раздел от ръководството', cur.title, '');
  return {};
}

/*
 * Импорт от Markdown: всеки раздел започва с „## Заглавие“; веднага след него по желание редове
 * „За: Роля, Роля“ и „Право: ключ“. Раздел със същото заглавие се заменя, новите се добавят; подредбата следва файла.
 */
export function parseManual(md) {
  const out = [];
  let cur = null;
  for (const raw of String(md || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(raw);
    if (m && !/^###/.test(raw)) { cur = { title: m[1], audience: '', perm: '', lines: [], head: true }; out.push(cur); continue; }
    if (!cur) continue;
    const meta = cur.head && /^(За|Право):\s*(.*)$/i.exec(raw.trim());
    if (meta) { if (/^за$/i.test(meta[1])) cur.audience = meta[2]; else cur.perm = meta[2].trim(); continue; }
    if (cur.head && !raw.trim()) continue;
    cur.head = false;
    cur.lines.push(raw);
  }
  return out.map((s, i) => ({ title: s.title, audience: s.audience, perm: s.perm, order: (i + 1) * 10, body: s.lines.join('\n').trim() }));
}

/* записва разделите от Markdown в списъка (и от tools/sp-provision.js --manual): същото заглавие – замяна, иначе – нов */
export async function importManual(store, markdown, by) {
  const list = parseManual(str(markdown, 600000));
  if (!list.length) fail('value', 'Във файла няма раздели („## Заглавие“).');
  if (list.length > 200) fail('value', 'Твърде много раздели (до 200).');
  const rows = await store.list('help');
  let added = 0, updated = 0;
  for (const s of list) {
    const v = sectionFields(s);
    const cur = rows.find(r => r.title === v.title);
    if (cur) { await store.patch('help', cur._id, Object.assign(v, { updatedAt: stamp(), by })); updated++; continue; }
    let key = slug(v.title), n = 2;
    while (rows.some(r => r.key === key)) key = slug(v.title) + '-' + n++;
    rows.push(Object.assign(await store.insert('help', Object.assign(v, { key, at: stamp(), updatedAt: stamp(), by })), { key, title: v.title }));
    added++;
  }
  return { added, updated };
}

export async function helpImport(d, ctx, app) {
  const r = await importManual(app.store, d.markdown, ctx.username);
  await audit(app, ctx.username, 'Импорт на ръководството', '', 'нови ' + r.added + ', обновени ' + r.updated);
  return r;
}

/* ---------- тикети ---------- */

export const TICKET_CATEGORIES = ['Проблем / грешка', 'Въпрос как се работи', 'Заявка за нова функция', 'Достъп и права', 'Отворени данни', 'Регистри и проверки', 'Поща, ССЕВ и КЕП', 'Съдебни дела и ЕПЕП', 'Друго'];
export const TICKET_PRIORITIES = ['Нисък', 'Нормален', 'Висок', 'Спешен'];
export const TICKET_STATUSES = ['Нов', 'В работа', 'Чака отговор', 'Решен', 'Затворен'];
export const TICKET_OPEN = ['Нов', 'В работа', 'Чака отговор'];

const handler = ctx => !!ctx.perms.tickets;
const ticketLink = (app, no) => app.cfg.appUrl + '#/ticket/' + encodeURIComponent(no);

async function findTicket(app, no) {
  const t = (await app.store.list('tickets', { no: line(no, 30) }))[0];
  if (!t) fail('notfound', 'Тикетът не е намерен.');
  return t;
}
function mayOpen(t, ctx) {
  if (!handler(ctx) && t.createdBy !== ctx.username) fail('role', 'Нямате достъп до този тикет.');
}
const ticketView = t => view(t);

/* получатели: активните потребители с право „tickets“ и имейл (без автора на действието) */
async function handlers(app, except) {
  return (await app.store.list('users')).filter(u => u.active === 'Да' && u.email && u.username !== except && permsOf(u).tickets);
}
async function userEmail(app, username) {
  const u = (await app.store.list('users', { username }))[0];
  return u && u.active === 'Да' ? u.email : '';
}

async function nextNo(app) {
  const year = stamp().slice(0, 4);
  const rows = await app.store.list('tickets');
  const max = rows.map(r => /^T-(\d{4})-(\d+)$/.exec(r.no || '')).filter(m => m && m[1] === year).reduce((a, m) => Math.max(a, Number(m[2])), 0);
  return 'T-' + year + '-' + String(max + 1).padStart(4, '0');
}

export async function ticketList(d, ctx, app) {
  const all = handler(ctx) && d.mine !== true;
  const rows = (await app.store.list('tickets')).filter(t => all || t.createdBy === ctx.username).sort(byDesc('updatedAt'));
  return { tickets: rows.map(ticketView), handler: handler(ctx), categories: TICKET_CATEGORIES, priorities: TICKET_PRIORITIES, statuses: TICKET_STATUSES };
}

/* брояч в менюто: за обработващите – новите; за подателя – чакащите неговия отговор */
export async function ticketCount(d, ctx, app) {
  const rows = await app.store.list('tickets');
  const mine = rows.filter(t => t.createdBy === ctx.username && t.status === 'Чака отговор').length;
  return { count: handler(ctx) ? rows.filter(t => t.status === 'Нов').length + mine : mine };
}

export async function ticketGet(d, ctx, app) {
  const t = await findTicket(app, d.no);
  mayOpen(t, ctx);
  const msgs = (await app.store.list('ticketMsgs', { no: t.no })).filter(m => handler(ctx) || m.internal !== 'Да').sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { ticket: ticketView(t), messages: msgs.map(view), handler: handler(ctx), categories: TICKET_CATEGORIES, priorities: TICKET_PRIORITIES, statuses: TICKET_STATUSES };
}

export async function ticketCreate(d, ctx, app) {
  const v = {
    title: line(d.title, 200), body: str(d.body, 20000), category: oneOf(d.category, TICKET_CATEGORIES, 'Категория'),
    priority: oneOf(d.priority || 'Нормален', TICKET_PRIORITIES, 'Приоритет'), page: line(d.page, 250)
  };
  if (!v.title) fail('required', 'Посочете кратко заглавие.');
  if (!v.body) fail('required', 'Опишете проблема или заявката.');
  const no = await nextNo(app), at = stamp();
  await app.store.insert('tickets', Object.assign(v, { no, status: 'Нов', createdAt: at, createdBy: ctx.username, updatedAt: at, lastBy: ctx.username, assignee: '' }));
  await audit(app, ctx.username, 'Нов тикет', no, v.category + ' · ' + v.title);
  for (const u of await handlers(app, ctx.username)) {
    await mail(app, u.email, app.cfg.appName + ' – нов тикет ' + no + ': ' + v.title,
      (ctx.name || ctx.username) + ' подаде тикет.\n\nКатегория: ' + v.category + '\nПриоритет: ' + v.priority + (v.page ? '\nСтраница: ' + v.page : '') + '\n\n' + v.body + '\n\nОтворете: ' + ticketLink(app, no));
  }
  return { no };
}

export async function ticketReply(d, ctx, app) {
  const t = await findTicket(app, d.no);
  mayOpen(t, ctx);
  const text = str(d.text, 20000);
  if (!text) fail('required', 'Напишете съобщение.');
  const internal = handler(ctx) && d.internal === true;
  const mine = t.createdBy === ctx.username;
  const at = stamp();
  await app.store.insert('ticketMsgs', { no: t.no, at, user: ctx.username, text, internal: internal ? 'Да' : 'Не' });
  const patch = { updatedAt: at, lastBy: ctx.username };
  // отговор на подателя връща тикета в работа (и отваря наново решен/затворен); отговор на обработващ – „Чака отговор“ по избор
  if (!internal && mine && t.status !== 'В работа' && t.status !== 'Нов') patch.status = 'В работа';
  if (!internal && !mine && handler(ctx)) {
    if (d.status && TICKET_STATUSES.includes(d.status)) patch.status = d.status;
    else if (t.status === 'Нов') patch.status = 'В работа';
    if (!t.assignee) patch.assignee = ctx.username;
  }
  if (patch.status && !TICKET_OPEN.includes(patch.status)) patch.closedAt = at;
  await app.store.patch('tickets', t._id, patch);
  await audit(app, ctx.username, internal ? 'Вътрешна бележка по тикет' : 'Отговор по тикет', t.no, patch.status ? 'статус: ' + patch.status : '');
  if (!internal) {
    const subject = app.cfg.appName + ' – отговор по тикет ' + t.no + ': ' + t.title;
    const body = (ctx.name || ctx.username) + ' написа:\n\n' + text + (patch.status ? '\n\nСтатус: ' + patch.status : '') + '\n\nОтворете: ' + ticketLink(app, t.no);
    if (!mine) { const to = await userEmail(app, t.createdBy); if (to) await mail(app, to, subject, body); }
    else {
      const to = t.assignee && t.assignee !== ctx.username ? [await userEmail(app, t.assignee)].filter(Boolean) : (await handlers(app, ctx.username)).map(u => u.email);
      for (const e of to) await mail(app, e, subject, body);
    }
  }
  return { status: patch.status || t.status };
}

/* обработващият: статус, приоритет, категория, отговорник; подателят може само да затвори своя тикет */
export async function ticketUpdate(d, ctx, app) {
  const t = await findTicket(app, d.no);
  mayOpen(t, ctx);
  const patch = {};
  if (handler(ctx)) {
    if (d.status !== undefined) patch.status = oneOf(d.status, TICKET_STATUSES, 'Статус');
    if (d.priority !== undefined) patch.priority = oneOf(d.priority, TICKET_PRIORITIES, 'Приоритет');
    if (d.category !== undefined) patch.category = oneOf(d.category, TICKET_CATEGORIES, 'Категория');
    if (d.assignee !== undefined) {
      const a = line(d.assignee, 60);
      if (a && !(await handlers(app, '')).some(u => u.username === a)) fail('value', 'Отговорникът трябва да е потребител с право да обработва тикети.');
      patch.assignee = a;
    }
  } else {
    if (d.status !== 'Затворен' || Object.keys(d).some(k => !['no', 'status'].includes(k))) fail('role', 'Можете само да затворите своя тикет.');
    patch.status = 'Затворен';
  }
  const changed = Object.keys(patch).filter(k => patch[k] !== (t[k] || ''));
  if (!changed.length) return { changed: [] };
  const at = stamp();
  Object.assign(patch, { updatedAt: at, lastBy: ctx.username });
  if (patch.status && !TICKET_OPEN.includes(patch.status) && TICKET_OPEN.includes(t.status)) patch.closedAt = at;
  await app.store.patch('tickets', t._id, patch);
  const note = changed.map(k => ({ status: 'Статус', priority: 'Приоритет', category: 'Категория', assignee: 'Отговорник' }[k] + ': ' + (patch[k] || '—'))).join('; ');
  await app.store.insert('ticketMsgs', { no: t.no, at, user: ctx.username, text: note, internal: 'Не', kind: 'Промяна' });
  await audit(app, ctx.username, 'Промяна на тикет', t.no, note);
  if (changed.includes('status') && t.createdBy !== ctx.username) {
    const to = await userEmail(app, t.createdBy);
    if (to) await mail(app, to, app.cfg.appName + ' – тикет ' + t.no + ': ' + patch.status, 'Статусът на тикета „' + t.title + '“ е „' + patch.status + '“.\n\nОтворете: ' + ticketLink(app, t.no));
  }
  return { changed };
}

/* ---------- опити за печат, снимка на екрана и копиране – в дневника ---------- */

export const GUARD_KINDS = ['снимка на екрана', 'печат', 'копиране на ръководството'];

/* браузърът съобщава опита; в дневника – потребител, страница, начин и IP (до 30 записа на 10 минути на потребител) */
export async function guardReport(d, ctx, app) {
  const kind = oneOf(d.kind, GUARD_KINDS, 'Вид');
  const key = 'gr:' + ctx.username;
  const n = Number(await app.kv.get(key)) || 0;
  if (n >= 30) return { logged: false };
  await app.kv.put(key, String(n + 1), { expirationTtl: 600 });
  await audit(app, ctx.username, 'Опит за ' + kind, line(d.page, 200), line(d.how, 120));
  return { logged: true };
}
