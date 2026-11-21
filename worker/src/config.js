/* Настройки на ADM ЗДОИ4You – вътрешна система. Стойностите според средата идват от wrangler.toml и тайните на Worker-а. */

export const CFG = {
  TZ: 'Europe/Sofia',
  SESSION_MIN: 30, // по подразбиране; всеки избира в профила си от 30 минути до 3 часа
  SESSION_MAX: 180,
  INVITE_DAYS: 7,
  RESET_HOURS: 2,
  MAX_FAILS: 5,
  MAX_IP_FAILS: 20,
  FAIL_WINDOW_S: 900,
  CODE_MIN: 5,
  MAX_BODY: 300000,
  MAX_BIG_BODY: 12 * 1048576,
  MAINTAINER: 'Вътрешна система на ЗДОИ4You.'
};

/* суперадминистраторът е администратор, който освен това управлява лицата и достъпа до тях */
export const ROLE_SUPER = 'Суперадминистратор';
export const ROLE_ADMIN = 'Администратор';
export const ROLE_STAFF = 'Служител';
export const ROLE_VIEW = 'Наблюдател';
export const ROLES = [ROLE_SUPER, ROLE_ADMIN, ROLE_STAFF, ROLE_VIEW];
export const ADMIN_ROLES = [ROLE_SUPER, ROLE_ADMIN];
export const isAdminRole = role => ADMIN_ROLES.includes(role);

/* продължителност на сесията без действие (минути), избира се в профила */
export const SESSION_CHOICES = [30, 45, 60, 90, 120, 150, 180];
export const sessionMinOf = u => { const n = Number(u && u.sessionMin); return SESSION_CHOICES.includes(n) ? n : CFG.SESSION_MIN; };

/*
 * Права по операции. Групата „Администрация“ важи само за администратори; тези права им ги дава суперадминистраторът.
 * Суперадминистраторът има всички права. Наблюдателят има само правата за преглед.
 */
export const PERM_GROUPS = [
  ['Заявления до институции', [
    ['casesAll', 'Вижда всички преписки на достъпните лица (иначе – само своите)'],
    ['reqCreate', 'Въвежда нови заявления'],
    ['reqEdit', 'Променя искането, хода, сроковете и адреса за отговор'],
    ['docs', 'Изготвя документи (заявление, уточнение, писмо, PDF)'],
    ['sign', 'Подписва документи с КЕП'],
    ['mailSend', 'Изпраща и насрочва писма по имейл'],
    ['mailRecord', 'Отбелязва изпратено и регистрира получено (ССЕВ, поща, на ръка)'],
    ['mailbox', 'Вижда неразпределената поща и я разпределя'],
    ['comment', 'Пише вътрешни коментари'],
    ['lock', 'Заключва своите преписки'],
    ['outReg', 'Вижда изходящия регистър']
  ]],
  ['Входящ регистър', [
    ['inReg', 'Вижда входящия регистър'],
    ['inRegEdit', 'Въвежда и променя входящи заявления']
  ]],
  ['Справочници', [
    ['courts', 'Води съдебни дела'],
    ['addressees', 'Въвежда и променя адресати']
  ]],
  ['Администрация', [
    ['assign', 'Разпределя преписки на други и сменя отговорника'],
    ['users', 'Управлява потребителите (добавя, спира, връзки за парола, сесии)'],
    ['usersPerms', 'Задава роли и права на служителите и наблюдателите'],
    ['logins', 'Вижда входовете и IP адресите на всички'],
    ['log', 'Вижда дневника на действията'],
    ['departments', 'Управлява отделите'],
    ['system', 'Системни настройки (поща, вход, КЕП, номерация)']
  ]]
];
export const PERMS = PERM_GROUPS.flatMap(([, list]) => list.map(([k]) => k));
export const ADMIN_PERMS = PERM_GROUPS.find(([g]) => g === 'Администрация')[1].map(([k]) => k);
export const VIEW_PERMS = ['casesAll', 'outReg', 'inReg'];
const WORK = PERMS.filter(k => !ADMIN_PERMS.includes(k));
export const ROLE_PERMS = {
  [ROLE_SUPER]: PERMS,
  [ROLE_ADMIN]: PERMS,
  [ROLE_STAFF]: WORK,
  [ROLE_VIEW]: VIEW_PERMS
};
/* старите права (до 2026-11-22): „casesEdit“ включваше всички действия по преписките */
export const LEGACY_PERMS = { casesEdit: ['reqCreate', 'reqEdit', 'docs', 'sign', 'mailSend', 'mailRecord', 'mailbox', 'comment', 'lock', 'inRegEdit'] };

export function envCfg(env) {
  const appUrl = String(env.APP_URL || 'https://adm.zdoi.eu/').replace(/\/?$/, '/');
  return {
    appUrl,
    origin: appUrl.replace(/\/$/, ''),
    support: env.SUPPORT || 'support@zdoi.eu',
    appName: env.APP_NAME || 'ADM ЗДОИ4You'
  };
}
