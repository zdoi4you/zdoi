/*
 * Потребители, отдели, дневник и входове. Потребителите се добавят само от администратор – няма регистрация.
 * Ролята „Суперадминистратор“ и достъпът до лицата се дават само от суперадминистратор; ако още няма такъв,
 * администраторът може да назначи първия (и себе си).
 */

import { CFG, ROLE_SUPER, ROLE_VIEW, ROLES, PERMS, PERM_GROUPS, ADMIN_PERMS, VIEW_PERMS, ROLE_PERMS, isAdminRole, sessionMinOf } from './config.js';
import { fail, str, line, stamp, isEmail, oneOf, view, byDesc } from './util.js';
import { audit, mail } from './core.js';
import { USER_RE, newInvite, inviteLink, accessMail, dropUser, findUser, permsOf, storedPerms, notifyOf, accessOf, endSessions } from './auth.js';
import { allPersons, setUserAccess, DEFAULT_CODE } from './persons.js';

const userView = u => Object.assign(view(u), {
  customPerms: !!u.perms, perms: permsOf(u), notify: notifyOf(u), pending: !u.salt, twofa: u.twofa === 'Да',
  access: accessOf(u) || [DEFAULT_CODE], sessionMin: sessionMinOf(u)
});

/*
 * Кой кого управлява:
 *  – суперадминистраторът – всички, включително правата на администраторите;
 *  – администраторът с право „Управлява потребителите“ – служителите и наблюдателите; роли и права им задава
 *    само с право „Задава роли и права“ и само от правата, които има самият той;
 *  – докато няма суперадминистратор, администраторите се управляват от администратор (за първоначалната настройка).
 */
const noSuperIn = users => !users.some(u => u.role === ROLE_SUPER && u.active === 'Да');
const managesAdmins = (ctx, users) => !!ctx.super || noSuperIn(users);
const canEditUser = (ctx, users, u) => !isAdminRole(u.role) || managesAdmins(ctx, users);
const grantable = ctx => (ctx.super ? PERMS : PERMS.filter(k => ctx.perms[k]));

export async function usersList(d, ctx, app) {
  const [users, departments] = await Promise.all([app.store.list('users'), app.store.list('departments')]);
  const persons = (await allPersons(app)).map(p => ({ code: p.code, name: p.name, active: p.active }));
  const noSuper = noSuperIn(users), admins = managesAdmins(ctx, users);
  // ролята „Суперадминистратор“ се дава от суперадминистратор (или от администратор, докато няма такъв), а „Администратор“ – от който управлява администраторите
  const roles = ROLES.filter(r => (r === ROLE_SUPER ? ctx.super || noSuper : isAdminRole(r) ? admins : true));
  return {
    users: users.map(u => Object.assign(userView(u), { canEdit: canEditUser(ctx, users, u), canPerms: canEditUser(ctx, users, u) && !!ctx.perms.usersPerms && (u.username !== ctx.username || !!ctx.super) && u.role !== ROLE_SUPER })),
    departments: departments.filter(x => x.active === 'Да').map(view),
    perms: PERMS, permGroups: PERM_GROUPS, adminPerms: ADMIN_PERMS, viewPerms: VIEW_PERMS, rolePerms: ROLE_PERMS, grantable: grantable(ctx),
    roles, persons, canAccess: !!ctx.super, noSuper, canPerms: !!ctx.perms.usersPerms, managesAdmins: admins
  };
}

/*
 * Отговорник: без право „Разпределя преписки“ потребителят може само да назначи на себе си преписка, която още няма
 * отговорник. Веднъж определен, отговорникът се сменя само от администратор с това право.
 */
export function assignCheck(ctx, current, owner) {
  if (ctx.perms.assign || owner === current) return;
  if (current) fail('role', 'Отговорникът вече е определен – сменя го само администратор.');
  if (owner !== ctx.username) fail('role', 'Можете да назначите преписката само на себе си. На друг потребител я разпределя администратор.');
}

/* активните потребители за избор на отговорник – без лични данни */
export async function usersBrief(app) {
  return (await app.store.list('users')).filter(u => u.active === 'Да').map(u => ({ username: u.username, name: u.name, department: u.department, role: u.role }));
}

export async function usersSave(d, ctx, app) {
  const username = str(d.username, 40).toLowerCase();
  if (!USER_RE.test(username)) fail('value', 'Потребителското име е от 3 до 40 знака: малки латински букви, цифри и . _ -');
  const v = {
    name: line(d.name, 120), position: line(d.position, 120), email: line(d.email, 200).toLowerCase(), phone: line(d.phone, 40),
    role: oneOf(d.role, ROLES, 'Роля'), active: d.active === false ? 'Не' : 'Да', department: line(d.department, 120)
  };
  if (!v.name) fail('required', 'Посочете име.');
  if (!isEmail(v.email)) fail('email', 'Невалиден имейл: на него идват връзките за парола.');
  if (v.department && !(await app.store.list('departments')).some(x => x.active === 'Да' && x.name === v.department)) fail('value', 'Изберете отдел от списъка.');
  const users = await app.store.list('users');
  const cur = users.find(u => u.username === username);
  if (d.isNew && cur) fail('duplicate', 'Вече има такъв потребител.');
  if (!d.isNew && !cur) fail('notfound', 'Потребителят не е намерен.');
  const supers = users.filter(u => u.role === ROLE_SUPER && u.active === 'Да'), noSuper = !supers.length;
  if ((cur && !canEditUser(ctx, users, cur)) || (isAdminRole(v.role) && !managesAdmins(ctx, users))) fail('role', 'Администраторите и техните права се управляват от суперадминистратор.');
  // роля и права: с право „Задава роли и права“; без него – само нов потребител с правата по подразбиране за ролята
  const wantPerms = Array.isArray(d.perms) ? [...new Set(d.perms.map(String))].filter(p => PERMS.includes(p)) : d.perms === null ? null : undefined;
  const roleChanged = cur ? v.role !== cur.role : false;
  const curPerms = cur ? storedPerms(cur) : null;
  const permsChanged = wantPerms !== undefined && JSON.stringify(wantPerms && wantPerms.slice().sort()) !== JSON.stringify(curPerms && curPerms.slice().sort());
  if ((roleChanged || (permsChanged && (cur || wantPerms))) && !ctx.perms.usersPerms) fail('role', 'Нямате право да задавате роли и права.');
  if (permsChanged && username === ctx.username && !ctx.super) fail('role', 'Не можете да променяте собствените си права.');
  if (wantPerms && permsChanged) {
    const own = grantable(ctx), extra = wantPerms.filter(p => !own.includes(p) && !(curPerms || []).includes(p));
    if (extra.length) fail('role', 'Не можете да дадете права, които нямате: ' + extra.join(', ') + '.');
    v.perms = JSON.stringify({ v: 2, p: wantPerms });
  } else if (wantPerms === null && permsChanged) v.perms = '';
  if (v.role === ROLE_SUPER && (!cur || cur.role !== ROLE_SUPER) && !ctx.super && !noSuper) fail('role', 'Роля „Суперадминистратор“ се дава само от суперадминистратор.');
  if (cur && cur.role === ROLE_SUPER && !ctx.super) fail('role', 'Суперадминистратор се променя само от суперадминистратор.');
  if (username === ctx.username && (v.active !== 'Да' || (cur && v.role !== cur.role && !(v.role === ROLE_SUPER && noSuper)))) fail('value', 'Не можете да отнемете собствената си роля или достъп.');
  if (!users.some(u => isAdminRole(u.role) && u.active === 'Да' && u.username !== username) && (!isAdminRole(v.role) || v.active !== 'Да')) {
    fail('value', 'Трябва да има поне един активен администратор.');
  }
  if (cur && cur.role === ROLE_SUPER && !(v.role === ROLE_SUPER && v.active === 'Да') && !supers.some(u => u.username !== username)) {
    fail('value', 'Трябва да има поне един активен суперадминистратор.');
  }
  // от името на кои лица води преписки – само суперадминистраторът определя
  if (ctx.super && Array.isArray(d.persons)) v.persons = await setUserAccess(app, d.persons.map(String));
  if (cur) {
    const changed = Object.keys(v).filter(k => v[k] !== (cur[k] || ''));
    if (!changed.length) return { username };
    if (cur.email && v.email !== cur.email) {
      await mail(app, cur.email, app.cfg.appName + ' – сменен имейл', 'Имейлът на потребител ' + username + ' е сменен на ' + v.email + ' от ' + ctx.username + '. Ако това е грешка, свържете се с администратора.');
    }
    await app.store.patch('users', cur._id, v);
    await dropUser(app, username);
    if (v.active !== 'Да' && cur.active === 'Да') await endSessions(app, username);
    await audit(app, ctx.username, 'Промяна на потребител', username, changed.join(', '));
    return { username };
  }
  const inv = await newInvite(CFG.INVITE_DAYS * 24);
  await app.store.insert('users', Object.assign({ username, createdAt: stamp(), createdBy: ctx.username, inviteHash: inv.hash, inviteExp: inv.exp }, v));
  await audit(app, ctx.username, 'Нов потребител', username, v.role);
  const mailed = await accessMail(app, v.email, username, inviteLink(app, username, inv.token), CFG.INVITE_DAYS + ' дни');
  return { username, mailed };
}

export async function usersInvite(d, ctx, app) {
  const u = await findUser(app, str(d.username, 40).toLowerCase());
  if (!u) fail('notfound', 'Потребителят не е намерен.');
  if (u.active !== 'Да') fail('value', 'Потребителят е спрян.');
  if (!u.email) fail('email', 'Потребителят няма имейл.');
  const hours = CFG.INVITE_DAYS * 24, inv = await newInvite(hours);
  await app.store.patch('users', u._id, { inviteHash: inv.hash, inviteExp: inv.exp });
  await audit(app, ctx.username, 'Изпратена връзка за парола', u.username, '');
  const mailed = await accessMail(app, u.email, u.username, inviteLink(app, u.username, inv.token), CFG.INVITE_DAYS + ' дни');
  if (!mailed) fail('mail', 'Писмото не можа да бъде изпратено. Проверете настройката на пощата.');
  return { mailed };
}

/* ---------- отдели ---------- */

export async function departmentsList(d, ctx, app) {
  return { departments: (await app.store.list('departments')).map(view) };
}

export async function departmentsSave(d, ctx, app) {
  const v = { name: line(d.name, 160), head: line(d.head, 120), position: line(d.position, 120), email: line(d.email, 200).toLowerCase(), active: d.active === false ? 'Не' : 'Да' };
  if (!v.name) fail('required', 'Посочете наименование.');
  if (v.email && !isEmail(v.email)) fail('email', 'Невалиден имейл.');
  const rows = await app.store.list('departments');
  if (rows.some(r => r.name === v.name && r._id !== String(d.id || ''))) fail('duplicate', 'Вече има отдел с това наименование.');
  if (d.id) {
    const cur = rows.find(r => r._id === String(d.id));
    if (!cur) fail('notfound', 'Отделът не е намерен.');
    await app.store.patch('departments', cur._id, v);
    await audit(app, ctx.username, 'Промяна на отдел', v.name, '');
    return { id: cur._id };
  }
  const rec = await app.store.insert('departments', Object.assign({ by: ctx.username, at: stamp() }, v));
  await audit(app, ctx.username, 'Нов отдел', v.name, '');
  return { id: rec._id };
}

/* ---------- дневник и входове ---------- */

export async function logList(d, ctx, app) {
  return { log: (await app.store.list('log')).sort(byDesc('at')).slice(0, 1000).map(view) };
}

export async function loginsList(d, ctx, app) {
  const user = str(d.username, 40).toLowerCase();
  // всеки вижда своите входове; с право „Вижда входовете“ – на всички
  const all = !!ctx.perms.logins;
  const rows = (await app.store.list('logins')).filter(r => all ? (!user || r.username === user) : r.username === ctx.username);
  return { logins: rows.sort(byDesc('at')).slice(0, 2000).map(view), all };
}
