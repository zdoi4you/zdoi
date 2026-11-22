/* ADM ЗДОИ4You – интерфейс. Всички данни се вмъкват с textContent; innerHTML само за вградените иконки (константи). */

import { term, termMonths, daysBetween, dayInfo, nextWorkday } from './calendar.js';
import * as Docs from './docs.js';
import { addressPicker } from './address.js';
import * as Kep from './kep.js';

const API = '/api';
const logoCache = {};
Docs.setLogoLoader(async (code, ver) => {
  const k = code + ':' + ver;
  if (!logoCache[k]) logoCache[k] = api('person.logo', { person: code }).then(r => (r.logo ? 'data:' + r.logo.type + ';base64,' + r.logo.data : null)).catch(() => { delete logoCache[k]; return null; });
  return logoCache[k];
});
const SESSION_MIN = 30; // по подразбиране; всеки избира в „Моят профил“ (до 3 часа)
const sessionMin = () => (me && me.sessionMin) || SESSION_MIN;
const ROLE_HINT = {
  'Суперадминистратор': 'всички права, лицата, достъпът до тях и правата на администраторите',
  'Администратор': 'правата, дадени от суперадминистратора',
  'Служител': 'работа по преписките според дадените права',
  'Наблюдател': 'само преглед'
};

/* ---------- помощни ---------- */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([k, v]) => {
    if (v === null || v === undefined || v === false) return;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  });
  kids.flat(Infinity).forEach(c => { if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c)); });
  return el;
}
const $ = id => document.getElementById(id);
const setView = (...nodes) => { const v = $('view') || $('app'); v.replaceChildren(...nodes.flat(Infinity).filter(n => n !== null && n !== undefined && n !== false)); window.scrollTo(0, 0); };
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3500);
}
const fmtDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : '—'; };
const fmtTime = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(iso || ''); return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}` : (iso || '—'); };
const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
const pair = o => (Array.isArray(o) ? o : [o, o || '—']);
const userName = u => { const x = (boot && boot.users || []).find(y => y.username === u); return x ? x.name : (u || '—'); };

function dueText(days) {
  if (days === null || days === undefined) return '';
  if (days < 0) return 'изтекъл преди ' + -days + (days === -1 ? ' ден' : ' дни');
  if (days === 0) return 'изтича днес';
  return 'остават ' + days + (days === 1 ? ' ден' : ' дни');
}
const dueClass = days => (days === null || days === undefined ? '' : days < 0 ? 'due-bad' : days <= 3 ? 'due-warn' : 'due-ok');
function statusPill(s) {
  const cls = { 'Нова': 'info', 'В обработка': 'info', 'Чака уточняване': 'warn', 'Чака трето лице': 'warn', 'Решение издадено': 'ok', 'Приключена': '' }[s] || '';
  return h('span', { class: 'pill ' + cls }, s || '—');
}

/* роли: суперадминистраторът е и администратор */
const isAdmin = () => !!me && (me.role === 'Администратор' || me.role === 'Суперадминистратор');
const isSuper = () => !!me && me.role === 'Суперадминистратор';
/* права по операции (идват от сървъра); без право бутонът и формулярът не се показват */
const can = k => !!me && !!me.perms && !!me.perms[k];
const canAny = (...ks) => ks.some(can);
function permLabel(k) {
  for (const [, list] of (boot && boot.permGroups) || []) { const x = list.find(p => p[0] === k); if (x) return x[1]; }
  return k;
}
/* страница „Нямате достъп“ – вместо формуляр, за който потребителят няма право */
function noAccess(...perms) {
  return setView(h('div', { class: 'card stack no-access' }, h('span', { class: 'na-ico' }, icon('key')), h('h1', null, 'Нямате достъп'),
    h('p', { class: 'muted' }, 'За тази страница е нужно право: ' + perms.map(k => '„' + permLabel(k) + '“').join(' или ') + '.'),
    h('p', { class: 'small muted' }, 'Правата се дават от администратор в „Потребители“.'),
    h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/dashboard' }, 'Към таблото'))));
}
/* отговорник: всички активни потребители (с право „Разпределя преписки“) или само самият потребител */
const ownerOptions = () => can('assign')
  ? [['', '— без отговорник —']].concat(boot.users.filter(u => u.role !== 'Наблюдател').map(u => [u.username, u.name]))
  : [['', '— без отговорник —'], [me.username, me.name + ' (аз)']];
function ownerCard(rec, action, mayEdit, reload) {
  const assign = can('assign') && mayEdit;
  const users = boot.users.filter(u => u.role !== 'Наблюдател');
  const save = async owner => { try { await api(action, { regNo: rec.regNo, owner }); toast(owner === me.username ? 'Поехте преписката.' : 'Отговорникът е записан.'); reload(); } catch (e) { toast(e.message); } };
  if (assign) {
    const sel = h('select', { 'aria-label': 'Отговорник' }, h('option', { value: '' }, '— без отговорник —'), users.map(u => h('option', { value: u.username }, u.name)));
    sel.value = rec.owner || '';
    return h('section', { class: 'card stack' }, h('h2', null, 'Отговорник'), sel, h('div', { class: 'actions' },
      h('button', { class: 'btn primary sm', onclick: () => save(sel.value) }, 'Запази'),
      rec.owner !== me.username ? h('button', { class: 'btn sm', onclick: () => save(me.username) }, 'Поеми') : null));
  }
  return h('section', { class: 'card stack' }, h('h2', null, 'Отговорник'),
    rec.owner ? h('div', { class: 'owner-line' }, h('span', { class: 'avatar sm' }, initials(userName(rec.owner))), h('b', null, userName(rec.owner))) : h('p', { class: 'muted' }, '— без отговорник —'),
    !rec.owner && mayEdit ? h('div', { class: 'actions' }, h('button', { class: 'btn primary sm', onclick: () => save(me.username) }, 'Назначи на мен')) : null,
    h('p', { class: 'small muted' }, rec.owner ? 'Отговорникът се сменя само от администратор.' : 'Можете да поемете преписката сами. На друг потребител я разпределя администратор.'));
}
/* лицата, от чието име потребителят води преписки; Сдружението е първото */
const personsAll = () => (boot && boot.persons) || [];
const personName = code => { const p = personsAll().find(x => x.code === code); return p ? p.name : code || '—'; };
const manyPersons = () => personsAll().length > 1;
let curCode = null;
const curKey = () => 'person:' + (me ? me.username : '');
const curPerson = () => personsAll().find(p => p.code === curCode) || null;
const isDefaultCur = () => { const p = curPerson(); return !p || !!p.isDefault; };
function setCur(code) {
  curCode = code;
  try { sessionStorage.setItem(curKey(), code); } catch (_) { /* без памет */ }
  searchCache = null; countsAt = 0;
}
/* при отваряне: запомненото за раздела или единственото лице; иначе – избор */
function ensureCur() {
  if (curCode && curPerson()) return true;
  let saved = null;
  try { saved = sessionStorage.getItem(curKey()); } catch (_) { /* без памет */ }
  if (saved && personsAll().some(p => p.code === saved)) { curCode = saved; return true; }
  // основното лице от „Моят профил“
  const def = boot && boot.defaultPerson;
  if (def && personsAll().some(p => p.code === def)) { setCur(def); return true; }
  if (personsAll().length === 1) { curCode = personsAll()[0].code; return true; }
  if (!personsAll().length) return true;
  return false;
}

/* ---------- сървър ---------- */

let me = null, boot = null, expAt = 0, timerId = null;

async function api(action, data) {
  let r, res;
  try {
    r = await fetch(API, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, data: data || {} }) });
  } catch (e) { throw new Error('Няма връзка със сървъра. Проверете интернет връзката и опитайте отново.'); }
  try { res = await r.json(); } catch (e) {
    // отговорът не е от системата: сървърът (Worker) не е публикуван или е недостъпен
    throw new Error('Сървърът на системата не отговаря (код ' + r.status + '). Опитайте по-късно или пишете на поддръжката.');
  }
  if (res.ok) {
    if (me) expAt = Date.now() + sessionMin() * 6e4;
    return res;
  }
  if (res.error === 'session' && me) { endSession(res.message); }
  throw Object.assign(new Error(res.message || 'Възникна грешка.'), { code: res.error });
}

/* PBKDF2 в браузъра: паролата не напуска устройството */
async function preHash(username, password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: enc.encode(`zdoi-adm:v1:${username}`) }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

function strongEnough(pw) {
  if (pw.length < 12) return 'Паролата трябва да е поне 12 знака.';
  if (!/[A-Za-zА-Яа-я]/.test(pw) || !/\d/.test(pw)) return 'Паролата трябва да съдържа букви и цифри.';
  return '';
}

function endSession(msg) {
  me = null; boot = null; curCode = null; clearInterval(timerId);
  location.hash = '#/login';
  route();
  if (msg) toast(msg);
}

async function startSession(m) {
  me = m;
  expAt = Date.now() + sessionMin() * 6e4;
  boot = await api('bootstrap');
  clearInterval(timerId);
  timerId = setInterval(tick, 1000);
}

/* сега в София: { iso: 'ГГГГ-ММ-ДД', time: 'ЧЧ:ММ', weekday } */
function sofiaNow(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(x => [x.type, x.value]));
  return { iso: parts.year + '-' + parts.month + '-' + parts.day, time: parts.hour + ':' + parts.minute, weekday: new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', weekday: 'long' }).format(d) };
}
let clockKey = '';
function drawClock() {
  const el = $('clock');
  if (!el) return;
  const n = sofiaNow(), key = n.iso + n.time;
  if (key === clockKey && el.childNodes.length) return;
  clockKey = key;
  const info = dayInfo(n.iso);
  el.className = 'clock ' + (info.workday ? 'work' : 'off');
  el.title = (info.workday ? 'Работен ден' : 'Неработен ден: ' + info.label) + ' (по българския календар с официалните празници)';
  el.title = n.weekday.charAt(0).toUpperCase() + n.weekday.slice(1) + ', ' + fmtDate(n.iso) + ' – ' + el.title;
  el.replaceChildren(h('b', null, n.time), h('span', { class: 'clock-day' }, n.weekday.slice(0, 3) + ', ' + fmtDate(n.iso).slice(0, 5)), h('span', { class: 'clock-kind' }, info.workday ? 'работен ден' : /^празник/.test(info.label) ? info.label : 'почивен ден'));
}

function tick() {
  drawClock();
  const el = $('timer'), txt = $('timer-text');
  const left = Math.max(0, Math.round((expAt - Date.now()) / 1000));
  if (el && txt) {
    const hh = Math.floor(left / 3600), mm = Math.floor(left % 3600 / 60), ss = left % 60;
    txt.textContent = (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
    el.classList.toggle('warn', left < 120);
  }
  if (left === 0 && me) endSession('Сесията изтече поради бездействие.');
}

/* ---------- форми ---------- */

/* def: { k, label, type, options, req, full, hint, max, min, placeholder } */
function field(def, value) {
  let input;
  const v = value === undefined || value === null ? '' : value;
  if (def.type === 'select') {
    input = h('select', { name: def.k, required: !!def.req, disabled: !!def.disabled }, (def.options || []).map(o => { const [val, text] = pair(o); return h('option', { value: val }, text); }));
    input.value = v;
    if (input.selectedIndex < 0 && input.options.length) input.selectedIndex = 0;
  } else if (def.type === 'textarea') {
    input = h('textarea', { name: def.k, required: !!def.req, maxlength: def.max || 8000, rows: def.rows || 4, disabled: !!def.disabled });
    input.value = v;
  } else if (def.type === 'checkbox') {
    return h('label', { class: 'check' + (def.full ? ' full' : '') }, h('input', { type: 'checkbox', name: def.k, checked: v === true || v === 'Да', disabled: !!def.disabled }), h('span', null, def.label));
  } else {
    input = h('input', {
      name: def.k, type: def.type || 'text', required: !!def.req, maxlength: def.max || null, min: def.min, max: def.maxValue,
      placeholder: def.placeholder || null, autocomplete: def.autocomplete || 'off', pattern: def.pattern || null, list: def.list || null, disabled: !!def.disabled
    });
    input.value = v;
  }
  return h('label', { class: 'field' + (def.full ? ' full' : '') },
    h('span', null, def.label, def.req ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null), input, def.hint ? h('small', null, def.hint) : null);
}

function formValues(form) {
  const out = {};
  [...form.elements].forEach(el => {
    if (!el.name || el.disabled) return;
    out[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
  });
  return out;
}

/* изпраща формата и показва грешката в нея */
function onSubmit(form, fn) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]'), err = form.querySelector('.err');
    if (err) err.remove();
    if (btn) btn.disabled = true;
    try { await fn(formValues(form)); }
    catch (ex) { form.append(h('p', { class: 'err', role: 'alert' }, ex.message)); }
    finally { if (btn) btn.disabled = false; }
  });
}

function dialog(title, body, { wide } = {}) {
  const d = h('dialog', { class: wide ? 'wide' : '' }, h('h2', null, title), body);
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

function formDialog(title, fields, values, submitText, fn, opts = {}) {
  const form = h('form', null,
    h('div', { class: 'form-grid' }, fields.map(f => field(f, values[f.k]))),
    opts.extra || null,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => d.close() }, 'Отказ'), h('button', { type: 'submit', class: 'btn primary' }, submitText)));
  const d = dialog(title, form, opts);
  onSubmit(form, async v => { await fn(v, form); d.close(); });
  return d;
}

const table = (head, rows, empty) => rows.length
  ? h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, head.map(x => h('th', null, x)))), h('tbody', null, rows)))
  : h('p', { class: 'empty' }, empty || 'Няма записи.');

const kv = pairs => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v === '' || v === null || v === undefined ? '—' : v)]));

/* ---------- оформление ---------- */

/* ---------- обвивка: странично меню, горна лента, търсене ---------- */

/* иконки (константи, вмъкват се с innerHTML) – 24×24, контур */
const ICON = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  send: '<path d="M21 3 10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>',
  book: '<path d="M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3z"/><path d="M4 17a3 3 0 0 1 3-3h11"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  scale: '<path d="M12 3v18"/><path d="M5 7h14"/><path d="m5 7-3 7a3 3 0 0 0 6 0z"/><path d="m19 7-3 7a3 3 0 0 0 6 0z"/><path d="M8 21h8"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14a6 6 0 0 1 3.5 6"/>',
  contacts: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7.5 17a4.5 4.5 0 0 1 9 0"/>',
  calc: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8"/><path d="M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01"/>',
  org: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m17 6 3 3"/>',
  building: '<path d="M4 21V5l8-3 8 3v16"/><path d="M9 21v-4h6v4"/><path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  fold: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m15 10-2 2 2 2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17h.01"/>',
  ticket: '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 6v2M14 11v2M14 16v2"/>'
};
function icon(name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'ico' + (cls ? ' ' + cls : ''));
  s.innerHTML = ICON[name] || '';
  return s;
}

/* групи в страничното меню; [адрес, текст, иконка, видим, ключ за брояч]; третият елемент на групата – свива ли се */
const NAV = () => [
  ['Работа', [
    ['#/dashboard', 'Табло', 'home', true],
    ['#/requests', 'Заявления', 'send', true, 'requests'],
    ['#/cases', 'Входящ регистър', 'inbox', isDefaultCur() && can('inReg'), 'cases'],
    ['#/mail', 'Поща', 'mail', can('mailbox'), 'mail'],
    ['#/calendar', 'Календар', 'calendar', true],
    ['#/courts', 'Съдебни дела', 'scale', true],
    ['#/register', 'Изходящ регистър', 'book', can('outReg')]
  ], false],
  ['Справочници', [
    ['#/addressees', 'Адресати', 'contacts', true],
    ['#/verify', 'Проверки в регистрите', 'search', true],
    ['#/calc', 'Калкулатор на срокове', 'calc', true],
    ['#/kep', 'Проверка на КЕП', 'key', true],
    ['#/departments', 'Отдели', 'org', true]
  ], true],
  ['Администрация', [
    ['#/users', 'Потребители и права', 'users', can('users')],
    ['#/persons', 'Лица и достъп', 'building', isSuper()],
    ['#/system', 'Система', 'gear', can('system')],
    ['#/logins/*', 'Входове и сесии', 'clock', can('logins')],
    ['#/log', 'Дневник', 'list', can('log')]
  ], true]
].map(([g, items, fold]) => [g, items.filter(x => x[3]), fold]).filter(([, items]) => items.length);
const NAV_FOOT = [['#/help', 'Ръководство', 'help'], ['#/tickets', 'Тикети', 'ticket', 'tickets']];

/* какво е свито (групи и цялото меню) – запомня се в браузъра; по подразбиране „Администрация“ е свита */
const navPref = (() => {
  let v = {};
  try { v = JSON.parse(localStorage.getItem('nav') || '{}') || {}; } catch (_) { v = {}; }
  return Object.assign({ rail: false, closed: { 'Администрация': true } }, v);
})();
const navSave = () => { try { localStorage.setItem('nav', JSON.stringify(navPref)); } catch (_) { /* без памет */ } };
const railOn = () => navPref.rail && window.matchMedia('(min-width: 1001px)').matches;
function setRail(on) {
  navPref.rail = on; navSave();
  document.body.classList.toggle('nav-rail', railOn());
  closeFly();
}

/* в свитото меню групата се отваря встрани (над съдържанието) */
let flyEl = null;
function closeFly() { if (flyEl) { flyEl.remove(); flyEl = null; } }
function openFly(btn, title, items) {
  const again = flyEl && flyEl.dataset.group === title;
  closeFly();
  if (again) return;
  const r = btn.getBoundingClientRect();
  flyEl = h('div', { class: 'nav-fly', 'data-group': title, style: 'top:' + Math.max(8, Math.min(r.top, window.innerHeight - 60 - items.length * 40)) + 'px;left:' + (r.right + 8) + 'px' },
    h('div', { class: 'nav-title' }, title), items.map(a => { const c = a.cloneNode(true); c.addEventListener('click', closeFly); return c; }));
  document.body.append(flyEl);
}
document.addEventListener('click', e => { if (flyEl && !flyEl.contains(e.target) && !e.target.closest('.nav-fold')) closeFly(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFly(); });
window.addEventListener('resize', () => { document.body.classList.toggle('nav-rail', railOn()); closeFly(); });

function navLink([href, text, ico, , key]) {
  return h('a', { href, title: text }, icon(ico), h('span', { class: 'nav-text' }, text), key ? h('span', { class: 'nav-count', 'data-count': key, hidden: true }) : null);
}
function navGroup([group, items, fold]) {
  const links = items.map(navLink);
  const list = h('div', { class: 'nav-items' }, links);
  if (!fold) return h('div', { class: 'nav-group' }, h('div', { class: 'nav-title' }, group), list);
  const wrap = h('div', { class: 'nav-group fold' + (navPref.closed[group] ? ' closed' : '') });
  const hint = h('span', { class: 'nav-hint' }, String(items.length));
  const btn = h('button', { type: 'button', class: 'nav-title nav-fold', 'aria-expanded': String(!navPref.closed[group]), title: group, onclick: () => {
    if (document.body.classList.contains('nav-rail')) return openFly(btn, group, links);
    const closed = !wrap.classList.contains('closed');
    wrap.classList.toggle('closed', closed);
    btn.setAttribute('aria-expanded', String(!closed));
    navPref.closed[group] = closed; navSave();
  } }, icon('chevron', 'sm nav-arrow'), icon(group === 'Администрация' ? 'gear' : 'contacts', 'nav-gico'), h('span', { class: 'nav-text' }, group), hint);
  wrap.append(btn, list);
  return wrap;
}

function themeSelect() {
  const cur = document.documentElement.getAttribute('data-theme');
  const s = h('select', { class: 'theme', 'aria-label': 'Тема', onchange: e => {
    document.documentElement.setAttribute('data-theme', e.target.value);
    try { localStorage.setItem('theme', e.target.value); } catch (_) { /* без памет */ }
  } }, [['light', 'Светла тема'], ['dark', 'Тъмна тема'], ['blue', 'Синя тема']].map(([v, t]) => h('option', { value: v }, t)));
  s.value = cur;
  return s;
}

const initials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

/* падащо меню: бутон + панел; затваря се при клик навън и с Esc */
function dropdown(button, panel) {
  const wrap = h('div', { class: 'dd' }, button, panel);
  panel.hidden = true;
  const close = () => { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  button.setAttribute('aria-haspopup', 'true'); button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', e => { e.stopPropagation(); const open = panel.hidden; document.querySelectorAll('.dd-panel').forEach(p => { p.hidden = true; }); panel.hidden = !open; button.setAttribute('aria-expanded', String(open)); });
  panel.addEventListener('click', e => { if (e.target.closest('a,button')) close(); });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  return wrap;
}

function shell() {
  if ($('view')) { markNav(); return; }
  const side = h('aside', { class: 'side', id: 'side' },
    h('div', { class: 'side-top' },
      h('a', { class: 'side-brand', href: '#/dashboard' }, h('span', { class: 'logo-plate mini' }, h('img', { src: 'assets/logo-site.png', alt: 'ЗДОИ4You' })), h('span', { class: 'side-name' }, h('b', null, 'ADM'), h('small', null, 'ЗДОИ4You'))),
      h('button', { type: 'button', class: 'icon-btn side-rail', 'aria-label': 'Свий или разгъни менюто', title: 'Свий / разгъни менюто', onclick: () => setRail(!navPref.rail) }, icon('fold'))),
    can('reqCreate') ? h('a', { class: 'btn primary side-new', href: '#/request/new', title: 'Ново заявление' }, icon('plus'), h('span', { class: 'nav-text' }, 'Ново заявление')) : null,
    h('nav', { id: 'nav', 'aria-label': 'Основно меню' }, NAV().map(navGroup)),
    h('div', { class: 'side-foot' },
      h('nav', { class: 'foot-links', 'aria-label': 'Помощ' }, NAV_FOOT.map(x => navLink([x[0], x[1], x[2], true, x[3]]))),
      h('div', { id: 'clock', class: 'clock', role: 'status' })));
  const scrim = h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') });

  const newItems = [
    can('reqCreate') ? h('a', { href: '#/request/new' }, icon('send'), 'Заявление до институция') : null,
    can('inRegEdit') && can('inReg') && isDefaultCur() ? h('a', { href: '#/case/new' }, icon('inbox'), 'Входящо заявление') : null,
    can('courts') ? h('a', { href: '#/courts' }, icon('scale'), 'Съдебно дело') : null,
    can('addressees') ? h('a', { href: '#/addressees' }, icon('contacts'), 'Адресат') : null].filter(Boolean);
  const newMenu = newItems.length ? dropdown(h('button', { class: 'btn primary sm' }, icon('plus'), h('span', { class: 'hide-sm' }, 'Ново'), icon('chevron', 'sm')),
    h('div', { class: 'dd-panel' }, newItems)) : null;

  const userMenu = dropdown(h('button', { class: 'user-chip', title: 'Оставащо време на сесията се избира в „Моят профил“' }, h('span', { class: 'avatar' }, initials(me.name)),
    h('span', { class: 'who hide-sm' }, h('b', null, me.name), h('small', { id: 'timer' }, 'сесия ', h('span', { id: 'timer-text' }, ''))), icon('chevron', 'sm')),
    h('div', { class: 'dd-panel right' },
      h('div', { class: 'dd-head' }, h('b', null, me.name), h('div', { class: 'small muted' }, me.username + ' · ' + me.role)),
      h('a', { href: '#/profile' }, icon('user'), 'Моят профил'),
      h('a', { href: '#/logins' }, icon('clock'), 'Моите входове и сесии'),
      h('button', { type: 'button', onclick: () => ticketDialog() }, icon('ticket'), 'Подай сигнал от тази страница'),
      h('div', { class: 'dd-row' }, themeSelect()),
      h('button', { type: 'button', onclick: async () => { try { await api('logout'); } catch (_) { /* изтекла */ } endSession('Излязохте от системата.'); } }, icon('logout'), 'Изход')));

  const top = h('header', { class: 'topbar' },
    h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Меню', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu')),
    personSwitch(),
    searchBox(),
    h('div', { class: 'top-right' },
      newMenu,
      userMenu));
  $('app').replaceChildren(h('div', { class: 'layout' }, side, scrim, h('div', { class: 'content' }, top, h('main', { id: 'view' }))));
  document.body.classList.toggle('nav-rail', railOn());
  markNav();
  tick();
  refreshCounts();
}

function markNav() {
  const cur = location.hash.split('?')[0].split('/').slice(0, 2).join('/');
  const alias = { '#/ticket': '#/tickets', '#/court': '#/courts', '#/case': '#/cases', '#/request': '#/requests', '#/logins': can('logins') ? '#/logins/*' : '' };
  document.querySelectorAll('#nav a, .foot-links a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === (alias[cur] || cur)));
  closeFly();
  document.body.classList.remove('nav-open');
}

/* броячи в менюто: изтекли срокове и неразпределена поща (най-много веднъж на 2 минути) */
let countsAt = 0;
async function refreshCounts(force) {
  if (!me || (!force && Date.now() - countsAt < 120000)) return;
  countsAt = Date.now();
  try {
    const [d, tk] = await Promise.all([api('dashboard', { person: curCode || '' }), api('ticket.count').catch(() => ({ count: 0 }))]);
    const set = (key, n, cls) => document.querySelectorAll('[data-count="' + key + '"]').forEach(el => { el.textContent = n > 99 ? '99+' : String(n); el.hidden = !n; el.className = 'nav-count ' + (cls || ''); });
    set('requests', d.reqSilent.length, 'bad');
    set('mail', d.unassignedMail, 'warn');
    set('cases', d.overdue.length, 'bad');
    set('tickets', tk.count, 'warn');
  } catch (_) { /* броячите не са важни */ }
}

/* ---------- търсене навсякъде (Ctrl+K или „/“) ---------- */

let searchCache = null;
async function searchData() {
  if (searchCache && Date.now() - searchCache.at < 60000) return searchCache;
  const [r, c] = await Promise.all([api('req.list', { person: curCode || '' }).catch(() => ({ requests: [] })), isDefaultCur() ? api('case.list').catch(() => ({ cases: [] })) : { cases: [] }]);
  searchCache = { at: Date.now(), requests: r.requests || [], cases: c.cases || [] };
  return searchCache;
}

function searchBox() {
  const input = h('input', { type: 'search', placeholder: 'Търсене: номер, субект, заявител…', 'aria-label': 'Търсене', autocomplete: 'off' });
  const list = h('div', { class: 'search-results', role: 'listbox', hidden: true });
  let items = [], sel = -1, timer = null;
  const go = it => { if (!it) return; list.hidden = true; input.value = ''; input.blur(); location.hash = it.href; };
  const paint = () => list.querySelectorAll('a').forEach((a, i) => a.classList.toggle('on', i === sel));
  const run = async () => {
    const t = input.value.trim().toLowerCase();
    if (t.length < 2) { list.hidden = true; return; }
    const d = await searchData();
    const hit = (...xs) => xs.join(' ').toLowerCase().includes(t);
    items = [
      ...d.requests.filter(r => hit(r.regNo, r.entityName, r.applicantName, r.title, r.outNo)).slice(0, 7).map(r => ({ href: '#/request/' + encodeURIComponent(r.regNo), no: r.regNo, text: r.entityName + (r.title ? ' – ' + r.title : ''), kind: 'Заявление', status: r.status })),
      ...d.cases.filter(c => hit(c.regNo, c.applicantName, c.subject)).slice(0, 7).map(c => ({ href: '#/case/' + encodeURIComponent(c.regNo), no: c.regNo, text: c.applicantName + (c.subject ? ' – ' + c.subject : ''), kind: 'Входящо', status: c.status }))
    ];
    sel = items.length ? 0 : -1;
    list.replaceChildren(...(items.length ? items.map(it => h('a', { href: it.href, role: 'option', onclick: e => { e.preventDefault(); go(it); } },
      h('span', { class: 'sr-kind' }, it.kind), h('span', { class: 'sr-main' }, h('b', { class: 'mono' }, it.no), h('span', null, it.text)), h('span', { class: 'pill' }, it.status || '—')))
      : [h('div', { class: 'empty' }, 'Няма резултати за „' + input.value.trim() + '“.')]));
    list.hidden = false; paint();
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run().catch(() => {}), 150); });
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2) run().catch(() => {}); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); go(items[sel]); }
    else if (e.key === 'Escape') { list.hidden = true; input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  return h('div', { class: 'search' }, icon('search'), input, h('kbd', { class: 'hide-sm' }, 'Ctrl K'), list);
}

document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
  if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
    const s = document.querySelector('.search input');
    if (s) { e.preventDefault(); s.focus(); s.select(); }
  }
});

const head = (title, ...actions) => h('div', { class: 'head' }, h('h1', null, title), h('div', { class: 'actions' }, actions));
const loading = () => setView(h('p', { class: 'loading' }, 'Зареждане…'));
const failView = e => setView(h('p', { class: 'err' }, e.message));

/* ---------- публични страници ---------- */

function gate(title, sub, ...body) {
  $('app').replaceChildren(h('div', { class: 'gate' },
    h('span', { class: 'logo-plate' }, h('img', { src: 'assets/logo-site.png', alt: 'ЗДОИ4You' })),
    h('div', { class: 'card gate-card' }, h('h1', null, title), sub ? h('p', { class: 'muted' }, sub) : null, body),
    h('p', { class: 'gate-foot' }, 'ADM ЗДОИ4You – вътрешна система. Достъпът е само за упълномощени служители.')));
}

const PROVIDER_ICON = {
  google: '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>',
  microsoft: '<svg viewBox="0 0 21 21" width="18" height="18" aria-hidden="true"><path fill="#f25022" d="M1 1h9v9H1z"/><path fill="#7fba00" d="M11 1h9v9h-9z"/><path fill="#00a4ef" d="M1 11h9v9H1z"/><path fill="#ffb900" d="M11 11h9v9h-9z"/></svg>',
  kep: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2" fill="none" stroke="#1A8FE3" stroke-width="1.8"/><rect x="5" y="9" width="5" height="4" rx="0.8" fill="#E0B341"/><path d="M13 10h6M13 13h4" stroke="#1A8FE3" stroke-width="1.6" stroke-linecap="round"/></svg>',
  discord: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#5865F2" d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.4 18.4 0 0 0-5.5 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.7.1 18.2a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.8 19.8 0 0 0 6-3c.5-5.2-.9-9.8-3.6-13.8zM8 15.4c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4z"/></svg>'
};
const providerIcon = p => { const s = h('span', { class: 'oauth-ico' }); s.innerHTML = PROVIDER_ICON[p] || ''; return s; };

function loginView(error) {
  const external = h('div', { class: 'stack oauth-box', hidden: true });
  const form = h('form', { autocomplete: 'on' },
    error ? h('p', { class: 'err', role: 'alert' }, error) : null,
    h('div', { class: 'stack' },
      field({ k: 'username', label: 'Потребител', req: true, autocomplete: 'username', max: 40 }),
      field({ k: 'password', label: 'Парола', type: 'password', req: true, autocomplete: 'current-password', max: 200 })),
    h('button', { type: 'submit', class: 'btn primary block' }, 'Вход'),
    external,
    h('div', { class: 'gate-links' }, h('a', { href: '#/forgot' }, 'Забравена парола'), h('a', { href: '#/calc' }, 'Калкулатор на срокове')));
  gate('Вход', 'Влезте с потребителското име и паролата си.', form);
  form.username.focus();
  api('oauth.providers').then(r => {
    if (!r.providers.length) return;
    external.replaceChildren(h('div', { class: 'or small muted' }, 'или'),
      ...r.providers.map(p => p.id === 'kep'
        ? h('button', { type: 'button', class: 'btn block oauth-btn', onclick: () => kepFlow('login') }, providerIcon('kep'), 'Вход с КЕП')
        : h('a', { class: 'btn block oauth-btn', href: '/api/oauth/' + p.id + '/start' }, providerIcon(p.id), 'Вход с ' + p.label)));
    external.hidden = false;
  }).catch(() => { /* без външен вход */ });
  onSubmit(form, async v => {
    const username = v.username.toLowerCase();
    const r = await api('login', { username, hash: await preHash(username, form.password.value) });
    if (r.twofa) return codeView(r.ticket);
    await startSession(r.me);
    location.hash = '#/dashboard';
    route();
  });
}

function codeView(ticket) {
  const form = h('form', null,
    field({ k: 'code', label: 'Код от 8 цифри', req: true, pattern: '\\d{8}', max: 8, autocomplete: 'one-time-code' }),
    h('button', { type: 'submit', class: 'btn primary block' }, 'Потвърди'),
    h('div', { class: 'gate-links' }, h('a', { href: '#/login', onclick: () => setTimeout(route) }, 'Назад')));
  gate('Код за вход', 'Изпратихме код на имейла ви. Той важи 5 минути.', form);
  form.code.focus();
  onSubmit(form, async v => {
    const r = await api('login.code', { ticket, code: v.code });
    await startSession(r.me);
    location.hash = '#/dashboard';
    route();
  });
}

function forgotView() {
  const form = h('form', null, field({ k: 'username', label: 'Потребител', req: true, autocomplete: 'username' }),
    h('button', { type: 'submit', class: 'btn primary block' }, 'Изпрати връзка'),
    h('div', { class: 'gate-links' }, h('a', { href: '#/login' }, 'Към входа')));
  gate('Забравена парола', 'Ще изпратим еднократна връзка на имейла, записан за потребителя.', form);
  onSubmit(form, async v => {
    await api('forgot', { username: v.username.toLowerCase() });
    gate('Проверете пощата', null, h('p', null, 'Ако потребителят съществува и има имейл, ще получите връзка за нова парола. Тя важи 2 часа.'), h('div', { class: 'gate-links' }, h('a', { href: '#/login' }, 'Към входа')));
  });
}

async function activateView(username, token) {
  gate('Нова парола', null, h('p', { class: 'loading' }, 'Проверка на връзката…'));
  let valid = false;
  try { valid = (await api('link.check', { username, token })).valid; } catch (_) { valid = false; }
  if (!valid) return gate('Връзката е невалидна', 'Връзката е използвана, изтекла или грешна. Поискайте нова от администратора или от „Забравена парола“.', h('div', { class: 'gate-links' }, h('a', { href: '#/login' }, 'Към входа'), h('a', { href: '#/forgot' }, 'Забравена парола')));
  const form = h('form', null,
    h('div', { class: 'stack' },
      field({ k: 'u', label: 'Потребител', value: username, disabled: true }, username),
      field({ k: 'password', label: 'Нова парола', type: 'password', req: true, autocomplete: 'new-password', hint: 'Поне 12 знака, с букви и цифри.' }),
      field({ k: 'again', label: 'Повторете паролата', type: 'password', req: true, autocomplete: 'new-password' })),
    h('button', { type: 'submit', class: 'btn primary block' }, 'Запази паролата'));
  gate('Нова парола', 'Изберете парола. Тя не се изпраща към сървъра – там се пази само производна стойност.', form);
  onSubmit(form, async v => {
    const weak = strongEnough(v.password);
    if (weak) throw new Error(weak);
    if (v.password !== v.again) throw new Error('Паролите не съвпадат.');
    await api('activate', { username, token, hash: await preHash(username, v.password) });
    toast('Паролата е зададена. Влезте.');
    location.hash = '#/login';
  });
}

/* ---------- табло ---------- */

async function dashboardView() {
  loading();
  try {
    const d = await api('dashboard', { person: curCode || '' });
    const cp = curPerson(), own = isDefaultCur() && can('inReg');
    const tile = (n, label, href, cls) => h('a', { class: 'card tile ' + (cls || ''), href }, h('b', null, n), h('span', { class: 'muted' }, label));
    const reqRows = (list, empty) => list.length ? h('ul', { class: 'list-plain' }, list.map(r => h('li', null,
      h('a', { href: '#/request/' + encodeURIComponent(r.regNo) }, r.regNo + ' – ' + r.entityName),
      h('span', { class: dueClass(r.daysLeft) }, (r.ours ? 'наше уточнение ' : '') + fmtDate(r.due) + ' · ' + dueText(r.daysLeft))))) : h('p', { class: 'empty' }, empty);
    const caseRows = (list, empty, withDue = true) => list.length ? h('ul', { class: 'list-plain' }, list.map(c => h('li', null,
      h('a', { href: '#/case/' + encodeURIComponent(c.regNo) }, c.regNo + ' – ' + c.applicantName),
      withDue ? h('span', { class: dueClass(c.daysLeft) }, c.due ? fmtDate(c.due) + ' · ' + dueText(c.daysLeft) : '—')
        : h('span', { class: dueClass(c.appealDays) }, fmtDate(c.appealBy) + ' · ' + dueText(c.appealDays))))) : h('p', { class: 'empty' }, empty);
    setView(
      head('Табло', can('reqCreate') ? h('a', { class: 'btn primary', href: '#/request/new' }, 'Ново заявление') : null, can('inRegEdit') && own ? h('a', { class: 'btn', href: '#/case/new' }, 'Входящо заявление') : null, h('a', { class: 'btn', href: '#/calendar' }, icon('calendar', 'sm'), ' Календар')),
      manyPersons() && cp ? h('p', { class: 'small muted mb-12' }, 'Данни за ', h('b', null, cp.name), ' · номера ' + (cp.isDefault ? 'П-ГГГГ-NNNN' : 'П-' + cp.code.toUpperCase() + '-ГГГГ-NNNN') + ', Изх. № ' + cp.outPrefix + '-ГГГГ-NNNN') : null,
      h('h2', { class: 'mb-12' }, 'Заявления до институции'),
      h('div', { class: 'tiles' },
        tile(d.reqWaiting.length, 'Чакат отговор или уточнение', '#/requests'),
        tile(d.reqSilent.length, 'Без отговор в срок', '#/requests?f=overdue', d.reqSilent.length ? 'bad' : ''),
        tile(d.reqDrafts, 'Чернови', '#/requests?f=draft'),
        can('mailbox') ? tile(d.unassignedMail, 'Неразпределени писма', '#/mail', d.unassignedMail ? 'warn' : '') : null,
        tile(d.reqTotal, 'Всички заявления', '#/requests')),
      h('div', { class: 'grid2 mb-16' },
        h('section', { class: 'card stack' }, h('h2', null, 'Срокове по заявления'), reqRows(d.reqWaiting.slice(0, 12), 'Няма заявления, които чакат отговор.')),
        h('section', { class: 'card stack' }, h('h2', null, 'За обжалване'), d.reqSilent.length || d.reqAppeals.length ? h('ul', { class: 'list-plain' },
          d.reqSilent.map(r => h('li', null, h('a', { href: '#/request/' + encodeURIComponent(r.regNo) }, r.regNo + ' – ' + r.entityName), h('span', { class: dueClass(r.silentDays) }, 'мълчалив отказ до ' + fmtDate(r.silentBy)))),
          d.reqAppeals.map(r => h('li', null, h('a', { href: '#/request/' + encodeURIComponent(r.regNo) }, r.regNo + ' – ' + r.entityName), h('span', { class: dueClass(r.appealDays) }, 'решение до ' + fmtDate(r.appealBy))))) : h('p', { class: 'empty' }, 'Няма срокове за обжалване.'))),
      own ? h('h2', { class: 'mb-12' }, 'Входящ регистър') : null,
      own ? h('div', { class: 'tiles' },
        tile(d.open, 'Отворени преписки', '#/cases'),
        tile(d.overdue.length, 'С изтекъл срок', '#/cases?f=overdue', d.overdue.length ? 'bad' : ''),
        tile(d.soon.length, 'Изтичат до 3 дни', '#/cases?f=soon', d.soon.length ? 'warn' : ''),
        tile(d.mine.length, 'Възложени на мен', '#/cases?f=mine'),
        tile(d.unassigned.length, 'Без отговорник', '#/cases?f=none'),
        tile(d.total, 'Всички преписки', '#/cases')) : null,
      own ? h('div', { class: 'grid2' },
        h('section', { class: 'card stack' }, h('h2', null, 'Изтекли срокове'), caseRows(d.overdue, 'Няма преписки с изтекъл срок.')),
        h('section', { class: 'card stack' }, h('h2', null, 'Изтичат скоро'), caseRows(d.soon, 'Няма срокове в следващите 3 дни.')),
        h('section', { class: 'card stack' }, h('h2', null, 'Моите преписки'), caseRows(d.mine, 'Нямате възложени преписки.')),
        h('section', { class: 'card stack' }, h('h2', null, 'Срок за обжалване (до 7 дни)'), caseRows(d.appeals, 'Няма решения с изтичащ срок за обжалване.', false)),
        h('section', { class: 'card stack' }, h('h2', null, 'Срокове по дела (14 дни)'), (d.courtDue || []).length ? h('ul', { class: 'list-plain' }, d.courtDue.map(dl => h('li', null,
          h('span', null, h('a', { href: '#/court/' + dl.courtId }, dl.title.replace('Административен съд – ', 'АС ')), h('br'), h('span', { class: 'small muted' }, dl.label)), deadlineBadge(dl)))) : h('p', { class: 'empty' }, 'Няма изтичащи процесуални срокове.')),
        h('section', { class: 'card stack' }, h('h2', null, 'Заседания (30 дни)'), d.hearings.length ? h('ul', { class: 'list-plain' }, d.hearings.map(x => h('li', null,
          h('a', { href: '#/court/' + x._id }, x.court.replace('Административен съд – ', 'АС ') + ' № ' + x.caseNo + '/' + x.year),
          h('span', null, fmtDate(x.nextHearing))))) : h('p', { class: 'empty' }, 'Няма насрочени заседания.')),
        h('section', { class: 'card stack' }, h('h2', null, 'По статус'), h('ul', { class: 'list-plain' }, Object.entries(d.byStatus).map(([s, n]) => h('li', null, statusPill(s), h('b', null, n)))))) : null);
  } catch (e) { failView(e); }
}

/* ---------- преписки ---------- */

async function casesView(query) {
  loading();
  try {
    const { cases } = await api('case.list');
    const preset = new URLSearchParams(query || '').get('f') || '';
    const q = h('input', { type: 'search', placeholder: 'Търсене: номер, заявител, описание…', 'aria-label': 'Търсене' });
    const st = h('select', { 'aria-label': 'Статус' }, h('option', { value: '' }, 'Всички статуси'), h('option', { value: 'open' }, 'Отворени'), boot.lists.statuses.map(s => h('option', { value: s }, s)));
    const own = h('select', { 'aria-label': 'Отговорник' }, h('option', { value: '' }, 'Всички отговорници'), h('option', { value: 'mine' }, 'Моите'), h('option', { value: 'none' }, 'Без отговорник'), boot.users.map(u => h('option', { value: 'u:' + u.username }, u.name)));
    const due = h('select', { 'aria-label': 'Срок' }, h('option', { value: '' }, 'Всички срокове'), h('option', { value: 'overdue' }, 'Изтекъл срок'), h('option', { value: 'soon' }, 'До 3 дни'));
    if (preset === 'mine' || preset === 'none') own.value = preset;
    if (preset === 'overdue' || preset === 'soon') due.value = preset;
    const body = h('div');
    const draw = () => {
      const text = q.value.trim().toLowerCase();
      const rows = cases.filter(c => {
        if (text && ![c.regNo, c.applicantName, c.subject, c.decisionNo].join(' ').toLowerCase().includes(text)) return false;
        if (st.value === 'open' && c.due === '' && !['Нова', 'В обработка', 'Чака уточняване', 'Чака трето лице'].includes(c.status)) return false;
        if (st.value && st.value !== 'open' && c.status !== st.value) return false;
        if (own.value === 'mine' && c.owner !== me.username) return false;
        if (own.value === 'none' && c.owner) return false;
        if (own.value.startsWith('u:') && c.owner !== own.value.slice(2)) return false;
        if (due.value === 'overdue' && !(c.daysLeft !== null && c.daysLeft < 0)) return false;
        if (due.value === 'soon' && !(c.daysLeft !== null && c.daysLeft >= 0 && c.daysLeft <= 3)) return false;
        return true;
      });
      body.replaceChildren(h('p', { class: 'small muted' }, 'Показани: ' + rows.length + ' от ' + cases.length),
        table(['Рег. №', 'Регистрирана', 'Заявител', 'Описание', 'Статус', 'Отговорник', 'Срок'], rows.map(c => h('tr', { class: 'link', onclick: () => { location.hash = '#/case/' + encodeURIComponent(c.regNo); } },
          h('td', { class: 'mono' }, c.regNo, c.locked === 'Да' ? ' 🔒' : ''), h('td', null, fmtDate(c.regDate)), h('td', null, c.applicantName),
          h('td', { class: 'subject' }, c.subject), h('td', null, statusPill(c.status)), h('td', null, c.owner ? userName(c.owner) : h('span', { class: 'muted' }, '—')),
          h('td', null, c.due ? h('span', { class: dueClass(c.daysLeft) }, fmtDate(c.due), h('br'), h('span', { class: 'small' }, dueText(c.daysLeft))) : (c.appealBy ? h('span', { class: 'small muted' }, 'обжалване до ' + fmtDate(c.appealBy)) : '—')))),
        'Няма преписки по тези условия.'));
    };
    [q, st, own, due].forEach(x => x.addEventListener('input', draw));
    setView(head('Входящ регистър', can('inRegEdit') ? h('a', { class: 'btn primary', href: '#/case/new' }, 'Нова преписка') : null),
      h('div', { class: 'card' }, h('div', { class: 'filters' }, q, st, own, due), body));
    draw();
  } catch (e) { failView(e); }
}

const APPLICANT_FIELDS = () => [
  { k: 'kind', label: 'Вид заявление', type: 'select', options: boot.lists.kinds, req: true },
  { k: 'regDate', label: 'Дата на регистриране', type: 'date', req: true },
  { k: 'channel', label: 'Начин на подаване', type: 'select', options: boot.lists.channels, req: true },
  { k: 'applicantType', label: 'Вид заявител', type: 'select', options: boot.lists.applicantTypes, req: true },
  { k: 'applicantName', label: 'Заявител (име или наименование)', req: true, max: 200 },
  { k: 'applicantEik', label: 'ЕИК/БУЛСТАТ', max: 13, pattern: '\\d{9}|\\d{13}', hint: 'Само за юридически лица.' },
  { k: 'applicantSeat', label: 'Седалище', max: 120 },
  { k: 'applicantOblast', label: 'Област', max: 80 },
  { k: 'applicantAddress', label: 'Адрес за кореспонденция', max: 400, full: true },
  { k: 'applicantEmail', label: 'Имейл', type: 'email', max: 200 },
  { k: 'applicantPhone', label: 'Телефон', type: 'tel', max: 40 },
  { k: 'subject', label: 'Описание на исканата информация', type: 'textarea', req: true, full: true },
  { k: 'form', label: 'Предпочитана форма на достъп', max: 250 },
  { k: 'department', label: 'Отдел', type: 'select', options: [['', '—']].concat(boot.departments) },
  { k: 'noPublish', label: 'Заявителят не е съгласен информацията да се публикува (чл. 25, ал. 1, т. 5)', type: 'checkbox', full: true }
];

async function newCaseView() {
  if (!can('inRegEdit') || !can('inReg')) return noAccess('inRegEdit');
  let addressees = [];
  try { addressees = (await api('addressee.list', { person: curCode || '' })).addressees; } catch (_) { addressees = []; }
  const fields = [{ k: 'regNo', label: 'Рег. № (по желание)', max: 60, hint: 'Празно – номерът се дава автоматично (ЗДОИ-ГГГГ-0001).' }]
    .concat(APPLICANT_FIELDS(), [
      { k: 'owner', label: 'Отговорник', type: 'select', options: ownerOptions(), hint: can('assign') ? '' : 'Можете да назначите само себе си; на друг потребител преписката се разпределя от администратор.' },
      { k: 'saveAddressee', label: 'Запази заявителя в „Адресати“', type: 'checkbox' }
    ]);
  const form = h('form', null, h('div', { class: 'form-grid' }, fields.map(f => field(f, f.k === 'regDate' ? todayIso() : f.k === 'owner' ? me.username : ''))),
    h('div', { class: 'actions mt-16' }, h('a', { class: 'btn', href: '#/cases' }, 'Отказ'), h('button', { type: 'submit', class: 'btn primary' }, 'Въведи преписката')));
  const pick = addressees.length ? h('label', { class: 'field' }, h('span', null, 'Попълни от адресат'),
    h('select', { onchange: e => {
      const a = addressees.find(x => x._id === e.target.value);
      if (!a) return;
      const set = (k, v) => { if (form.elements[k] && v) form.elements[k].value = v; };
      if (boot.lists.applicantTypes.includes(a.type)) set('applicantType', a.type);
      set('applicantName', a.name); set('applicantEik', a.eik); set('applicantSeat', a.seat); set('applicantOblast', a.oblast);
      set('applicantAddress', a.address); set('applicantEmail', a.email); set('applicantPhone', a.phone);
    } }, h('option', { value: '' }, '— изберете —'), addressees.map(a => h('option', { value: a._id }, a.name + (a.email ? ' · ' + a.email : ''))))) : null;
  setView(head('Нова преписка'), h('div', { class: 'card' }, pick ? h('div', { class: 'mb-14 w-420', }, pick) : null, form));
  onSubmit(form, async v => {
    const r = await api('case.create', v);
    toast('Преписката е въведена: ' + r.regNo);
    location.hash = '#/case/' + encodeURIComponent(r.regNo);
  });
}

const PROGRESS_FIELDS = () => [
  { k: 'status', label: 'Статус', type: 'select', options: boot.lists.statuses, req: true },
  { k: 'outcome', label: 'Резултат', type: 'select', options: boot.lists.outcomes.map(o => [o, o || '—']) },
  { k: 'clarifyAsked', label: 'Поискано уточняване (чл. 29)', type: 'date' },
  { k: 'clarifyGot', label: 'Получено уточняване', type: 'date' },
  { k: 'ext30', label: 'Удължаване по чл. 30 (дни, до 10)', type: 'number', min: 0, maxValue: 10 },
  { k: 'ext31', label: 'Удължаване по чл. 31 (дни, до 14)', type: 'number', min: 0, maxValue: 14 },
  { k: 'thirdAsked', label: 'Поискано съгласие от трето лице', type: 'date' },
  { k: 'thirdGot', label: 'Отговор от трето лице', type: 'date' },
  { k: 'decisionNo', label: 'Решение №', max: 60 },
  { k: 'decisionDate', label: 'Дата на решението', type: 'date' },
  { k: 'grounds', label: 'Правни основания (при отказ или частичен достъп)', type: 'textarea', full: true, max: 4000, rows: 3 },
  { k: 'served', label: 'Връчено на', type: 'date' },
  { k: 'servedHow', label: 'Начин на връчване', type: 'select', options: boot.lists.servedHow.map(o => [o, o || '—']) },
  { k: 'published15c', label: 'Публикувано на платформата (чл. 15в)', type: 'date' },
  { k: 'appealed', label: 'Решението е обжалвано', type: 'checkbox' },
  { k: 'appealNote', label: 'Бележка за обжалването', type: 'textarea', full: true, max: 2000, rows: 2 }
];

async function caseView(regNo) {
  loading();
  let d;
  try { d = await api('case.get', { regNo }); } catch (e) { return failView(e); }
  const c = d.case, locked = c.locked === 'Да', edit = can('inRegEdit') && !locked, canComment = can('comment') && !locked;
  const reload = () => caseView(regNo);

  const editData = () => formDialog('Данни на преписката', APPLICANT_FIELDS(), c, 'Запази', async v => {
    await api('case.update', Object.assign({}, c, v, { regNo: c.regNo }));
    toast('Запазено.'); reload();
  }, { wide: true });
  const editProgress = () => formDialog('Ход и решение', PROGRESS_FIELDS(), c, 'Запази', async v => {
    await api('case.update', Object.assign({}, c, v, { regNo: c.regNo }));
    toast('Запазено.'); reload();
  }, { wide: true, extra: h('p', { class: 'note mt-12' }, 'Документите (писма и решения) не се създават в системата – тук се отбелязват само номерът, датата и резултатът.') });

  const dueCard = h('section', { class: 'card stack' }, h('h2', null, 'Срокове'),
    c.due ? [h('div', null, h('div', { class: 'small muted' }, c.dueLabel), h('div', { class: 'bigdue ' + dueClass(c.daysLeft) }, fmtDate(c.due)), h('div', { class: dueClass(c.daysLeft) }, dueText(c.daysLeft))),
      c.silentBy ? h('p', { class: 'small muted' }, 'При липса на решение заявителят може да обжалва мълчаливия отказ до ' + fmtDate(c.silentBy) + ' (чл. 149, ал. 2 АПК).') : null]
      : h('p', { class: 'muted' }, 'Няма текущ срок за произнасяне.'),
    c.thirdInvolved ? h('div', { class: 'small' }, 'Трето лице: съгласие се иска до ', h('b', null, fmtDate(c.thirdBy)), c.thirdAsked ? ' (поискано ' + fmtDate(c.thirdAsked) + ')' : '', '; отговор до ', h('b', null, fmtDate(c.thirdReplyBy)), c.thirdGot ? ' (получен ' + fmtDate(c.thirdGot) + ')' : '') : null,
    c.appealBy ? h('div', null, h('div', { class: 'small muted' }, 'Срок за обжалване на решението (чл. 149, ал. 1 АПК)'), h('b', { class: dueClass(c.appealDays) }, fmtDate(c.appealBy) + ' · ' + dueText(c.appealDays)))
      : (c.decisionDate ? h('p', { class: 'small muted' }, 'Въведете датата на връчване, за да се изчисли срокът за обжалване.') : null));

  const owner = ownerCard(c, 'case.assign', edit, reload);

  const canLock = can('inRegEdit') && can('lock') && (isAdmin() || (!locked && c.owner === me.username) || (locked && c.lockedBy === me.username));
  const lockCard = h('section', { class: 'card stack' }, h('h2', null, 'Заключване'),
    h('p', { class: 'small muted' }, locked ? 'Заключена от ' + userName(c.lockedBy) + ' на ' + fmtTime(c.lockedAt) + '. Промени, коментари и смяна на отговорника не се приемат, докато не бъде отключена. Делата се водят и при заключена преписка.' : 'Заключената преписка се чете, но не се променя. Заключва отговорникът или администратор.'),
    canLock ? h('button', { class: 'btn sm', onclick: () => formDialog(locked ? 'Отключване' : 'Заключване', [{ k: 'reason', label: 'Причина (по желание)', max: 300, full: true }], {}, locked ? 'Отключи' : 'Заключи', async v => {
      await api('case.lock', { regNo: c.regNo, locked: !locked, reason: v.reason }); toast(locked ? 'Отключена.' : 'Заключена.'); reload();
    }) }, locked ? 'Отключи' : 'Заключи') : null);

  const courtCard = h('section', { class: 'card stack' }, h('div', { class: 'head m-0' }, h('h2', null, 'Съдебни дела'), me.perms.courts ? h('button', { class: 'btn sm', onclick: () => courtDialog({ regNo: c.regNo, procedure: 'АПК' }, reload) }, 'Добави дело') : null),
    d.courts.length ? h('ul', { class: 'list-plain' }, d.courts.map(x => h('li', null,
      h('span', null, x.court.replace('Административен съд – ', 'АС '), ' № ', x.caseNo, '/', x.year, h('br'), h('span', { class: 'small muted' }, x.status + (x.nextHearing ? ' · заседание ' + fmtDate(x.nextHearing) : ''))),
      h('a', { class: 'btn sm', href: '#/court/' + x._id }, 'Отвори')))) : h('p', { class: 'empty' }, 'Няма дела.'));

  const comment = h('form', null, field({ k: 'text', label: 'Вътрешен коментар', type: 'textarea', rows: 3, max: 4000, req: true, full: true }), h('div', { class: 'actions mt-8' }, h('button', { type: 'submit', class: 'btn sm primary' }, 'Добави')));
  onSubmit(comment, async v => { await api('case.comment', { regNo: c.regNo, text: v.text }); toast('Коментарът е добавен.'); reload(); });
  const history = h('section', { class: 'card stack' }, h('h2', null, 'Коментари и история'), canComment ? comment : null,
    h('ul', { class: 'timeline' }, d.events.map(e => h('li', null, h('div', { class: 'small muted' }, fmtTime(e.at) + ' · ' + userName(e.user) + ' · ' + e.kind), h('div', { class: 'pre' }, e.text)))));

  setView(
    head(c.regNo + (locked ? ' 🔒' : ''), statusPill(c.status), h('button', { class: 'btn', onclick: () => caseDossier(d) }, 'Досие (PDF)'), edit ? h('button', { class: 'btn', onclick: editData }, 'Данни') : null, edit ? h('button', { class: 'btn primary', onclick: editProgress }, 'Ход и решение') : null),
    locked ? h('p', { class: 'warnbox mb-16' }, 'Преписката е заключена.') : null,
    h('div', { class: 'split' },
      h('div', { class: 'stack' },
        h('section', { class: 'card stack' }, h('h2', null, 'Заявление'), kv([
          ['Вид', c.kind], ['Регистрирано', fmtDate(c.regDate)], ['Начин на подаване', c.channel], ['Заявител', c.applicantName + ' (' + c.applicantType + ')'],
          c.applicantEik ? ['ЕИК/БУЛСТАТ', c.applicantEik] : null, ['Седалище', [c.applicantSeat, c.applicantOblast].filter(Boolean).join(', ')],
          ['Адрес', c.applicantAddress], ['Имейл', c.applicantEmail], ['Телефон', c.applicantPhone], ['Отдел', c.department],
          ['Предпочитана форма', c.form], ['Съгласие за публикуване', c.noPublish === 'Да' ? 'Не' : 'Да'],
          ['Въведена', fmtTime(c.createdAt) + ' от ' + userName(c.createdBy)]
        ]), h('div', null, h('div', { class: 'small muted' }, 'Искана информация'), h('p', { class: 'pre' }, c.subject))),
        h('section', { class: 'card stack' }, h('h2', null, 'Ход и решение'), kv([
          ['Статус', c.status], ['Резултат', c.outcome], ['Уточняване', c.clarifyAsked ? 'поискано ' + fmtDate(c.clarifyAsked) + (c.clarifyGot ? ', получено ' + fmtDate(c.clarifyGot) : '') : ''],
          ['Удължаване', [c.ext30 ? 'чл. 30: ' + c.ext30 + ' дни' : '', c.ext31 ? 'чл. 31: ' + c.ext31 + ' дни' : ''].filter(Boolean).join('; ')],
          ['Решение', c.decisionNo ? '№ ' + c.decisionNo + ' от ' + fmtDate(c.decisionDate) : ''], ['Основания', c.grounds],
          ['Връчено', c.served ? fmtDate(c.served) + (c.servedHow ? ' – ' + c.servedHow : '') : ''], ['Публикувано (чл. 15в)', c.published15c ? fmtDate(c.published15c) : ''],
          ['Обжалвано', c.appealed === 'Да' ? 'Да' + (c.appealNote ? ' – ' + c.appealNote : '') : 'Не']
        ])),
        history),
      h('div', { class: 'stack' }, dueCard, owner, lockCard, courtCard)));
}

/* ---------- дела ---------- */

const courtShort = x => String(x.court || '').replace('Административен съд – ', 'АС ').replace('Върховен административен съд', 'ВАС').replace('Върховен касационен съд', 'ВКС') + ' № ' + x.caseNo + '/' + x.year;
const money = n => (Math.round(Number(n || 0) * 100) / 100).toLocaleString('bg-BG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const deadlineBadge = dl => dl.done ? h('span', { class: 'pill ok' }, 'изпълнено') : h('span', { class: 'pill ' + (dl.daysLeft < 0 ? 'bad' : dl.daysLeft <= 3 ? 'warn' : 'info') }, fmtDate(dl.date) + ' · ' + dueText(dl.daysLeft));

/* основни данни на делото (нови и съществуващи) */
/* съдът по седалището на органа (чл. 133, ал. 1 АПК) – предложение по областта на задължения субект */
function suggestCourt(ent) {
  const o = String((ent && ent.oblast) || '').replace(/^обл(аст)?\.?\s*/i, '').trim();
  if (!o) return 'Административен съд – София-град';
  if (/столица|София-град|София \(град\)/i.test(o) || o === 'София') return 'Административен съд – София-град';
  if (/София/.test(o)) return 'Административен съд – София-област';
  const c = 'Административен съд – ' + o;
  return boot.lists.courts.includes(c) ? c : 'Административен съд – София-град';
}
/* ново дело по заявление: вид, обжалван акт, страни, срок за обжалване, отговорник */
function courtFromRequest(d) {
  const r = d.request, ent = r.entity || {}, org = d.person || boot.org, silent = r.status === 'Мълчалив отказ' || (!r.decisionNo && r.daysLeft !== null && r.daysLeft < 0);
  const applicant = r.mode === 'Клиент' ? (r.applicant || {}).name : org.name;
  return {
    regNo: r.regNo, procedure: 'АПК', instance: 'Първа инстанция', status: 'Образувано', court: suggestCourt(ent), owner: r.owner || me.username,
    kind: silent ? 'Жалба срещу мълчалив отказ' : 'Жалба срещу решение',
    appealedAct: silent ? 'Мълчалив отказ на ' + (ent.name || '') + ' по заявление ' + (r.outNo || r.regNo) : 'Решение № ' + (r.decisionNo || '__') + ' от ' + fmtDate(r.decisionDate) + ' на ' + (ent.name || ''),
    subject: 'Достъп до обществена информация: ' + (r.title || ''), appealBy: silent ? (r.silentBy || '') : (r.appealBy || ''),
    parties: [{ role: 'Жалбоподател', name: applicant || '', rep: r.mode === 'Клиент' ? org.name : '' }, { role: 'Ответник', name: ent.name || '' }].filter(p => p.name)
  };
}

function courtDialog(x, done) {
  const fields = [
    { k: 'regNo', label: 'Преписка (рег. №)', max: 60, list: 'case-nos', hint: 'ВХ-… (входящ регистър) или П-… (заявление до институция).' },
    x.procedure === 'ГПК' ? { k: 'procedure', label: 'Процесуален ред', type: 'select', options: boot.lists.procedures, req: true } : null,
    !x._id ? { k: 'owner', label: 'Отговорник по делото', type: 'select', options: ownerOptions().filter(o => o[0]), hint: can('assign') ? 'Получава известията от ЕПЕП и за сроковете.' : 'Вие сте отговорник; на друг потребител делото се разпределя от администратор.' } : null,
    { k: 'court', label: 'Съд', req: true, max: 160, list: 'court-names', full: true },
    { k: 'instance', label: 'Инстанция', type: 'select', options: boot.lists.courtInstances, req: true },
    { k: 'kind', label: 'Вид производство', type: 'select', options: boot.lists.courtKindsNew.includes(x.kind) || !x.kind ? boot.lists.courtKindsNew : boot.lists.courtKindsNew.concat([x.kind]), req: true },
    { k: 'caseNo', label: '№ на дело', req: true, max: 40 },
    { k: 'year', label: 'Година', type: 'number', req: true, min: 2000, maxValue: 2100 },
    { k: 'instituted', label: 'Образувано на', type: 'date' },
    { k: 'status', label: 'Статус', type: 'select', options: boot.lists.courtStatuses, req: true },
    { k: 'subject', label: 'Предмет на делото', max: 400, full: true, hint: 'Напр. „Жалба срещу Решение № 15/10.11.2026 на кмета на Столична община за отказ по ЗДОИ“.' },
    { k: 'appealedAct', label: 'Обжалван акт / искане', max: 300, full: true },
    { k: 'interest', label: 'Цена на иска / материален интерес', max: 60, hint: 'При неоценяеми искове (ЗДОИ) – празно.' },
    { k: 'appealBy', label: 'Срок за обжалване на акта на органа', type: 'date', hint: '14 дни от съобщаването на решението (чл. 149, ал. 1 АПК), 1 месец при мълчалив отказ (чл. 149, ал. 2 АПК).' },
    x._id ? { k: 'executedOn', label: 'Органът се произнесе отново на', type: 'date', hint: 'След отмяна на отказа – датата на новото решение.' } : null,
    { k: 'nextHearing', label: 'Следващо заседание', type: 'date', hint: 'Попълва се от ЕПЕП и от „Заседания“.' },
    { k: 'result', label: 'Резултат (кратко)', max: 250, full: true },
    { k: 'note', label: 'Бележки', type: 'textarea', full: true, max: 8000, rows: 3 }
  ].filter(Boolean);
  const values = Object.assign({ year: new Date().getFullYear(), court: 'Административен съд – София-град', procedure: 'АПК', instance: 'Първа инстанция', status: 'Образувано', owner: me.username }, x);
  const del = x._id ? h('button', { type: 'button', class: 'btn danger mr-auto', onclick: async () => {
    if (!confirm('Да се изтрие ли делото с всички заседания, актове, такси и срокове?')) return;
    try { await api('court.delete', { id: x._id }); d.close(); toast('Делото е изтрито.'); done(true); } catch (e) { toast(e.message); }
  } }, 'Изтрий') : null;
  const d = formDialog(x._id ? 'Основни данни на делото' : 'Ново дело', fields, values, 'Запази', async v => {
    const r = await api('court.save', Object.assign(v, { id: x._id || '', procedure: v.procedure || x.procedure || 'АПК' }, x._id ? {} : { parties: x.parties || [], person: curCode || '' }));
    toast(x._id ? 'Делото е записано.' : 'Делото е записано. Търси се в ЕПЕП…');
    if (!x._id) location.hash = '#/court/' + r.id; else done();
  }, { wide: true, extra: h('datalist', { id: 'court-names' }, boot.lists.courts.map(n => h('option', { value: n }))) });
  if (del) d.querySelector('.actions').prepend(del);
}

async function courtsView(query) {
  loading();
  try {
    const { courts, cases } = await api('court.list', { person: curCode || '' });
    const list = h('datalist', { id: 'case-nos' }, cases.map(n => h('option', { value: n })));
    const q = h('input', { type: 'search', placeholder: 'Търсене: съд, №, докладчик, ответник, преписка…', 'aria-label': 'Търсене' });
    const st = h('select', { 'aria-label': 'Статус' }, h('option', { value: '' }, 'Всички статуси'), h('option', { value: 'open' }, 'Висящи'), boot.lists.courtStatuses.map(x => h('option', { value: x }, x)));
    st.value = query === 'stats' ? '' : 'open';
    const own = h('select', { 'aria-label': 'Отговорник' }, h('option', { value: '' }, 'Всички отговорници'), h('option', { value: 'mine' }, 'Моите дела'), boot.users.filter(u => u.role !== 'Наблюдател').map(u => h('option', { value: 'u:' + u.username }, u.name)));
    const body = h('div'), stats = h('div');
    const closed = ['Решено', 'Прекратено', 'Влязло в сила'];
    const filtered = () => {
      const t = q.value.trim().toLowerCase();
      return courts.filter(x => (!st.value || (st.value === 'open' ? !closed.includes(x.status) : x.status === st.value)) &&
        (!own.value || (own.value === 'mine' ? x.owner === me.username : x.owner === own.value.slice(2))) &&
        (!t || [x.court, x.caseNo + '/' + x.year, x.reporter, x.regNo, x.kind, x.result, x.respondent].join(' ').toLowerCase().includes(t)));
    };
    const draw = () => {
      const rows = filtered();
      body.replaceChildren(table(['Дело', 'Ответник', 'Статус', 'Заседание', 'Следващ срок', 'Отговорник', 'ЕПЕП'], rows.map(x => h('tr', { class: 'row-link', onclick: e => { if (!e.target.closest('a')) location.hash = '#/court/' + x._id; } },
        h('td', null, h('a', { href: '#/court/' + x._id }, h('b', null, courtShort(x))), h('div', { class: 'small muted' }, x.kind + (x.reporter ? ' · докл. ' + x.reporter : '')),
          x.regNo ? h('div', { class: 'small' }, h('a', { href: (/^П-/.test(x.regNo) ? '#/request/' : '#/case/') + encodeURIComponent(x.regNo) }, x.regNo)) : null),
        h('td', { class: 'small' }, x.respondent || '—'),
        h('td', null, h('span', { class: 'pill' }, x.status), x.decision && x.decision.outcome ? h('div', { class: 'small muted' }, x.decision.outcome) : null),
        h('td', null, x.nextHearing ? fmtDate(x.nextHearing) : '—'),
        h('td', null, x.nextDeadline ? [deadlineBadge(x.nextDeadline), h('div', { class: 'small muted' }, x.nextDeadline.label)] : '—'),
        h('td', { class: 'small' }, x.owner ? userName(x.owner) : '—'),
        h('td', null, x.epep.gid ? h('span', { class: 'pill ' + (x.epep.error ? 'warn' : 'ok'), title: x.epep.error || ('Обновено ' + fmtTime(x.epep.syncedAt)) }, x.epep.error ? 'грешка' : '✓') : h('span', { class: 'muted small' }, 'не е свързано')))), 'Няма дела по тези условия.'));
      drawStats(rows);
    };
    // справки: по ответници и съдилища, резултати, продължителност, разноски
    const drawStats = rows => {
      const group = key => { const m = new Map(); rows.forEach(x => { const k = key(x) || '—'; m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10); };
      const dur = rows.map(x => x.durationDays).filter(n => n !== null && n !== undefined);
      const sum = k => rows.reduce((a, x) => a + (x.totals ? x.totals[k] : 0), 0);
      const list = (title, pairs) => h('section', { class: 'card stack' }, h('h2', null, title), pairs.length ? h('ul', { class: 'list-plain' }, pairs.map(([k, n]) => h('li', null, h('span', null, k), h('b', null, n)))) : h('p', { class: 'empty' }, 'Няма данни.'));
      stats.replaceChildren(
        h('div', { class: 'tiles' },
          h('div', { class: 'card tile' }, h('b', null, rows.length), h('span', { class: 'muted' }, 'Дела')),
          h('div', { class: 'card tile' }, h('b', null, rows.filter(x => x.decision && /Отменя|нищожност|частично/i.test(x.decision.outcome)).length), h('span', { class: 'muted' }, 'Спечелени (отменен акт)')),
          h('div', { class: 'card tile' }, h('b', null, rows.filter(x => x.decision && /Отхвърля|без разглеждане|Прекратява/i.test(x.decision.outcome)).length), h('span', { class: 'muted' }, 'Загубени или прекратени')),
          h('div', { class: 'card tile' }, h('b', null, dur.length ? Math.round(dur.reduce((a, b) => a + b, 0) / dur.length) + ' дни' : '—'), h('span', { class: 'muted' }, 'Средно от образуване до решение')),
          h('div', { class: 'card tile' }, h('b', null, money(sum('paid'))), h('span', { class: 'muted' }, 'Платени такси и разноски')),
          h('div', { class: 'card tile' }, h('b', null, money(sum('awardedFor'))), h('span', { class: 'muted' }, 'Присъдени в наша полза')),
          h('div', { class: 'card tile' }, h('b', null, money(sum('collected'))), h('span', { class: 'muted' }, 'Събрани'))),
        h('div', { class: 'grid2' }, list('По ответници (задължени субекти)', group(x => x.respondent)), list('По съдилища', group(x => x.court)),
          list('По резултат', group(x => (x.decision && x.decision.outcome) || (x.decision ? 'решение без въведен резултат' : 'без решение'))), list('По вид', group(x => x.kind))));
    };
    const tabs = h('div', { class: 'seg' }, h('button', { class: 'btn sm' + (query === 'stats' ? '' : ' primary'), onclick: () => { location.hash = '#/courts'; } }, 'Списък'), h('button', { class: 'btn sm' + (query === 'stats' ? ' primary' : ''), onclick: () => { location.hash = '#/courts?stats'; } }, 'Справки'));
    [q, st, own].forEach(x => x.addEventListener('input', draw));
    setView(head('Съдебни дела', tabs, can('courts') ? h('button', { class: 'btn primary', onclick: () => courtDialog({}, courtsView) }, 'Ново дело') : null), list,
      manyPersons() && curPerson() ? h('p', { class: 'small muted mb-4' }, 'Дела на ', h('b', null, curPerson().name), ' – по заявленията от негово име' + (isDefaultCur() ? ' и по входящия регистър' : '') + '. Смяна на лицето – от горната лента.') : null,
      h('p', { class: 'small muted mb-12' }, 'Делата по ЗДОИ се разглеждат от административния съд по реда на АПК; решението му е окончателно (чл. 40, ал. 3 ЗДОИ). Данните за състава, заседанията и актовете се обновяват от ЕПЕП всеки ден.'),
      h('div', { class: 'card' }, h('div', { class: 'filters' }, q, st, own), query === 'stats' ? stats : body));
    draw();
  } catch (e) { failView(e); }
}

/* ---------- документи за съда ---------- */

const COURT_DOCS = ['Жалба срещу отказ', 'Жалба срещу мълчалив отказ', 'Частна жалба', 'Молба за достъп до ЕПЕП', 'Списък на разноските', 'Молба за изпълнителен лист'];

function docMenu(x, det, d, reload) {
  return dropdown(h('button', { class: 'btn' }, 'Документ за съда', icon('chevron', 'sm')),
    h('div', { class: 'dd-panel right' }, COURT_DOCS.map(t => h('button', { type: 'button', onclick: () => courtDocDialog({ type: t, court: x, det, totals: d.totals, reload }) }, t))));
}

const amountText = n => (Math.round(Number(n || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' €';

/* текстовете по подразбиране; всичко се редактира преди записа */
function courtDocTemplate(type, c) {
  const x = c.court || {}, det = c.det || {}, r = c.req, org = c.org, ent = (r && r.entity) || {};
  const entity = ent.name || x.respondent || '[задължен субект]';
  const iso = v => (fmtDate(v) === '—' ? '__.__.____' : fmtDate(v));
  const client = r && r.mode === 'Клиент' && r.applicant ? r.applicant : null;
  const from = client
    ? [client.name, client.eik ? Docs.idLabel(client.regBasis) + ' ' + client.eik : '', client.address ? 'адрес: ' + client.address : '', 'чрез пълномощника ' + org.name].filter(Boolean).join(', ')
    : [org.name, org.eik ? Docs.idLabel(org.regBasis) + ' ' + org.eik : '', org.address ? 'седалище и адрес на управление: ' + org.address : '', org.rep ? 'представлявано от ' + org.rep : ''].filter(Boolean).join(', ');
  const reqRef = r ? 'заявление за достъп до обществена информация' + (r.outNo ? ' изх. № ' + r.outNo : '') + (r.sentAt ? ' от ' + iso(r.sentAt) + ' г.' : '') + (r.entityRegNo ? ', вх. № ' + r.entityRegNo + (r.entityRegDate ? ' от ' + iso(r.entityRegDate) + ' г.' : '') : '') : 'заявление за достъп до обществена информация [изх. №, дата, вх. №]';
  const points = r && r.points && r.points.length ? r.points.map((t, i) => (i + 1) + '. ' + t).join('\n') : '[исканата информация]';
  const caseRef = x.caseNo ? 'по адм. дело № ' + x.caseNo + '/' + x.year + (det.panel && det.panel.division ? ', ' + det.panel.division : '') : '';
  const decision = r && r.decisionNo ? 'Решение № ' + r.decisionNo + ' от ' + iso(r.decisionDate) + ' г.' : 'Решение № [__] от [__.__.____] г.';
  const partial = r && r.outcome === 'Частичен достъп';
  const court = x.court || '[административен съд]';
  const attach = extra => extra.concat(client ? ['Пълномощно'] : []);
  const base = { to: court, from, salutation: 'Уважаеми административни съдии,' };
  if (type === 'Жалба срещу отказ') return Object.assign(base, {
    heading: 'ЖАЛБА', subheading: 'по чл. 40, ал. 1 ЗДОИ във връзка с чл. 145 и сл. АПК', via: entity,
    against: decision + ' на ' + entity + ', с което е ' + (partial ? 'предоставен частичен достъп' : 'отказан достъп') + ' до обществена информация по ' + reqRef,
    body: 'С ' + reqRef + ' поискахме да ни бъде предоставена следната обществена информация:\n' + points + '\n' +
      'С обжалваното решение, съобщено ни на ' + iso(r && r.servedAt) + ' г., органът ' + (partial ? 'предостави само частичен достъп' : 'отказа достъп') + '. Считаме решението за незаконосъобразно – издадено при съществено нарушение на административнопроизводствените правила, в противоречие с материалния закон и в несъответствие с целта на закона (чл. 146, т. 3–5 АПК).\n' +
      '[Изложете конкретните доводи: защо исканата информация е обществена по смисъла на чл. 2, ал. 1 ЗДОИ; защо посоченото основание за отказ не е налице или не е мотивирано; наличие на надделяващ обществен интерес (§ 1, т. 6 от ДР на ЗДОИ); дали е следвало да се предостави частичен достъп.]\n' +
      'Жалбата е подадена в срока по чл. 149, ал. 1 АПК от лице с правен интерес срещу акт, подлежащ на съдебен контрол, и е допустима.',
    petitum: ['да отмените обжалваното решение като незаконосъобразно;', 'да върнете преписката на ' + entity + ' за ново произнасяне по заявлението при задължителни указания по тълкуването и прилагането на закона (чл. 173, ал. 2 АПК);', 'да ни присъдите направените по делото разноски (чл. 143, ал. 1 АПК).'],
    petitumIntro: 'Поради изложеното МОЛЯ да:', attachments: attach(['Копие от заявлението', 'Копие от обжалваното решение', 'Документ за платена държавна такса'])
  });
  if (type === 'Жалба срещу мълчалив отказ') return Object.assign(base, {
    heading: 'ЖАЛБА', subheading: 'срещу мълчалив отказ по чл. 40, ал. 1 ЗДОИ във връзка с чл. 145 и сл. АПК', via: entity,
    against: 'мълчалив отказ на ' + entity + ' по ' + reqRef,
    body: 'С ' + reqRef + ' поискахме да ни бъде предоставена следната обществена информация:\n' + points + '\n' +
      'В срока по чл. 28, ал. 1 ЗДОИ' + (r && (r.ext30 || r.ext31) ? ' (с удължаването по ' + [r.ext30 ? 'чл. 30' : '', r.ext31 ? 'чл. 31' : ''].filter(Boolean).join(' и ') + ' ЗДОИ)' : '') + ', изтекъл на ' + iso(r && r.due) + ' г., органът не се произнесе с решение и не ни уведоми за решението си. Непроизнасянето в срок съставлява мълчалив отказ, който е незаконосъобразен поради неизпълнение на задължението на органа да се произнесе с мотивирано писмено решение по заявлението.\n' +
      'Жалбата е подадена в едномесечния срок по чл. 149, ал. 2 АПК и е допустима.',
    petitum: ['да отмените мълчаливия отказ като незаконосъобразен;', 'да върнете преписката на ' + entity + ' с указания да се произнесе с изрично мотивирано решение по заявлението в законния срок (чл. 173, ал. 2 АПК);', 'да ни присъдите направените по делото разноски (чл. 143, ал. 1 АПК).'],
    petitumIntro: 'Поради изложеното МОЛЯ да:', attachments: attach(['Копие от заявлението', 'Доказателство за подаването и регистрирането на заявлението', 'Документ за платена държавна такса'])
  });
  if (type === 'Частна жалба') {
    const act = (det.acts || []).filter(a => a.kind === 'Определение' || a.kind === 'Протоколно определение').sort((a, b) => b.date.localeCompare(a.date))[0] || {};
    return Object.assign(base, {
      to: 'Върховен административен съд', via: court, caseRef, heading: 'ЧАСТНА ЖАЛБА', subheading: 'по чл. 229 и сл. АПК', salutation: 'Уважаеми върховни съдии,',
      against: (act.kind || 'Определение') + ' № ' + (act.no || '[__]') + ' от ' + iso(act.date) + ' г., постановено ' + (caseRef || 'по адм. дело № [__]') + ' по описа на ' + court,
      body: 'Обжалваното определение ни е съобщено на ' + iso(act.served) + ' г. Считаме го за неправилно, тъй като [изложете доводите].\nЧастната жалба е подадена в 7-дневния срок по чл. 230 АПК и е допустима.',
      petitum: ['да отмените обжалваното определение;', 'да върнете делото на ' + court + ' за продължаване на съдопроизводствените действия;', 'да ни присъдите направените разноски.'],
      petitumIntro: 'Поради изложеното МОЛЯ да:', attachments: attach(['Документ за платена държавна такса'])
    });
  }
  if (type === 'Молба за достъп до ЕПЕП') return Object.assign(base, {
    caseRef, heading: 'МОЛБА', subheading: 'за достъп до електронното дело в Единния портал за електронно правосъдие',
    body: 'В качеството на ' + (client ? 'пълномощник на жалбоподателя' : 'жалбоподател') + ' ' + (caseRef || 'по делото') + ' молим да ни бъде предоставен достъп до електронната папка на делото в Единния портал за електронно правосъдие (ЕПЕП) чрез профила на ' + ((det.epep && det.epep.profile) || org.name) + '.\n' +
      'Изразяваме съгласие призовките, съобщенията и съдебните книжа по делото да ни бъдат връчвани по електронен път чрез ЕПЕП.',
    petitum: [], attachments: attach([])
  });
  if (type === 'Списък на разноските') {
    const fees = ((det.fees) || []).filter(f => f.status === 'Платена' && !/Присъдени/.test(f.kind));
    const eur = f => { const n = Number(String(f.amount || '0').replace(',', '.')) || 0; return f.currency === 'BGN' ? n / 1.95583 : n; };
    return Object.assign(base, {
      caseRef, heading: 'СПИСЪК НА РАЗНОСКИТЕ', subheading: 'по чл. 80 ГПК във връзка с чл. 144 АПК',
      body: 'Представяме списък на разноските, направени от нас по делото, и молим да ни бъдат присъдени съгласно чл. 143, ал. 1 АПК:',
      costs: fees.map(f => [f.kind, amountText(eur(f)), [f.doc, f.date ? 'от ' + iso(f.date) + ' г.' : ''].filter(Boolean).join(' ')]), costsTotal: amountText(fees.reduce((a, f) => a + eur(f), 0)),
      petitum: [], attachments: attach(['Доказателства за извършените плащания'])
    });
  }
  // молба за изпълнителен лист
  const dec = ((det.acts) || []).filter(a => a.kind === 'Решение').sort((a, b) => b.date.localeCompare(a.date))[0] || {};
  const owed = c.totals ? c.totals.awardedFor - c.totals.collected : 0;
  return Object.assign(base, {
    caseRef, heading: 'МОЛБА', subheading: 'за издаване на изпълнителен лист',
    body: 'С Решение № ' + (dec.no || '[__]') + ' от ' + iso(dec.date) + ' г. ' + (caseRef || '') + ', влязло в сила на ' + iso(dec.finalOn) + ' г., ' + (x.respondent || entity) + ' е осъден да ни заплати направените по делото разноски в размер на ' + amountText(owed) + '. Сумата не е заплатена доброволно.',
    petitum: ['да ни издадете изпълнителен лист срещу ' + (x.respondent || entity) + ' за сумата от ' + amountText(owed) + ', представляваща присъдени разноски по делото (чл. 406 ГПК във връзка с чл. 144 АПК).'],
    petitumIntro: 'Поради изложеното МОЛЯ да:', attachments: attach([])
  });
}

/*
 * Редактор на документ за съда. Ако делото е по преписка (П-…), документът получава Изх. № по нея (индексиран към
 * главния номер) и може да се подпише с КЕП и изпрати оттам; иначе само се отваря като PDF.
 */
async function courtDocDialog(o) {
  let d = null;
  const regNo = o.regNo || (o.court && /^П-/.test(o.court.regNo || '') ? o.court.regNo : '');
  try { if (regNo) d = await api('req.get', { regNo }); } catch (e) { return toast(e.message); }
  const org = (d && d.person) || curPerson() || boot.org;
  const t = o.payload || courtDocTemplate(o.type, { court: o.court, det: o.det, req: d && d.request, org, totals: o.totals });
  const type = o.payload ? o.payload.docType : o.type;
  const fields = [
    { k: 'to', label: 'До', req: true, max: 200, full: true }, { k: 'via', label: 'Чрез', max: 200, full: true }, { k: 'caseRef', label: 'По дело', max: 200, full: true },
    { k: 'heading', label: 'Заглавие', req: true, max: 80 }, { k: 'subheading', label: 'Подзаглавие', max: 200 },
    { k: 'from', label: 'От', type: 'textarea', rows: 2, max: 1000, full: true }, { k: 'against', label: 'Срещу', type: 'textarea', rows: 2, max: 1000, full: true },
    { k: 'salutation', label: 'Обръщение', max: 120, full: true },
    { k: 'body', label: 'Текст (абзаците – на нов ред; заменете текста в [ ])', type: 'textarea', rows: 12, max: 30000, full: true },
    { k: 'petitum', label: 'Искания към съда (по едно на ред)', type: 'textarea', rows: 4, max: 6000, full: true },
    { k: 'attachments', label: 'Приложения (по едно на ред)', type: 'textarea', rows: 3, max: 2000, full: true },
    { k: 'place', label: 'Място', max: 80 }, { k: 'signMode', label: 'Подпис', type: 'select', options: [['electronic', 'Квалифициран електронен подпис'], ['manual', 'Саморъчен подпис']] }
  ];
  const vals = Object.assign({ place: org.place || 'София', signMode: 'electronic' }, t, { petitum: (t.petitum || []).join('\n'), attachments: (t.attachments || []).join('\n') });
  const build = v => Object.assign({}, t, v, {
    docType: type, org, mode: d ? d.request.mode : 'Сдружението', applicant: d ? d.request.applicant : {},
    petitum: String(v.petitum || '').split('\n').map(z => z.trim()).filter(Boolean), attachments: String(v.attachments || '').split('\n').map(z => z.trim()).filter(Boolean)
  });
  const dlg = formDialog(type + (o.existing ? ' – ' + o.existing.outNo : ''), fields, vals, regNo ? 'Запиши (Изх. №) и отвори' : 'Отвори PDF', async v => {
    const p = build(v);
    if (!regNo) { await Docs.open(Docs.DEFS['Съдебен документ'](Object.assign(p, { outNo: '', date: todayIso() })), type + '.pdf'); return; }
    const res = await api('doc.reserve', { regNo, kind: 'Съдебен документ', title: type, payload: p, outNo: o.existing ? o.existing.outNo : '' });
    Object.assign(p, { outNo: res.outNo, date: res.date });
    await api('doc.file', { outNo: res.outNo, pdf: await Docs.base64Of(Docs.DEFS['Съдебен документ'](p)) });
    if (o.court && o.court._id && !o.existing) await api('court.part', { id: o.court._id, part: 'filings', item: { date: res.date, kind: /Жалба/.test(type) ? (type === 'Частна жалба' ? 'Частна жалба' : 'Жалба') : type === 'Списък на разноските' ? 'Списък на разноските (чл. 80 ГПК)' : 'Молба', dir: 'Подадено от нас', via: /Жалба срещу/.test(type) ? 'Чрез органа (чл. 152 АПК)' : 'ЕПЕП', note: type + ' изх. № ' + res.outNo + ' (изготвен – отбележете датата на подаване)' } }).catch(() => {});
    toast(type + ' изх. № ' + res.outNo + ' е записан в преписката ' + regNo + '. Подписва се с КЕП и се изпраща оттам.');
    await Docs.open(Docs.DEFS['Съдебен документ'](p), res.outNo + ' ' + type + '.pdf');
    if (o.reload) o.reload();
  }, { wide: true, extra: h('div', { class: 'actions mt-8' }, h('button', { type: 'button', class: 'btn sm', onclick: async e => {
    try { await Docs.preview(Docs.DEFS['Съдебен документ'](Object.assign(build(formValues(e.target.closest('form'))), { outNo: o.existing ? o.existing.outNo : '(чернова)', date: todayIso() }))); } catch (ex) { toast(ex.message); }
  } }, 'Преглед'), h('span', { class: 'small muted' }, regNo ? 'Ще получи Изх. № по преписката ' + regNo + '.' : 'Делото не е по заявление до институция – документът се отваря без Изх. №.')) });
  return dlg;
}

/* страница на делото */
async function courtPage(id) {
  loading();
  let d;
  try { d = await api('court.get', { id }); } catch (e) { return failView(e); }
  const x = d.court, det = d.details, edit = can('courts'), L = boot.lists;
  const reload = () => courtPage(id);
  const part = async (name, data, msg) => { await api('court.part', Object.assign({ id, part: name }, data)); toast(msg || 'Записано.'); reload(); };
  const remove = (name, it, what) => async () => { if (!confirm('Да се премахне ли ' + what + '?')) return; try { await part(name, { remove: it.id }, 'Премахнато.'); } catch (e) { toast(e.message); } };
  const users = boot.users.filter(u => u.role !== 'Наблюдател').map(u => u.name);
  const fromEpep = it => it.epepGid ? h('span', { class: 'pill info ml-4', title: 'Данни от ЕПЕП' }, 'ЕПЕП') : null;
  const remedies = [['', '— без срок —'], [L.noRemedy, L.noRemedy]].concat(x.zdoi ? [[L.zdoiFinal, L.zdoiFinal]] : [], (L.remedies[det.procedure] || []).map(r => [r[0], r[0] + ' – ' + (r[1] === 'd' ? r[2] + ' дни' : r[1] === 'w' ? r[2] + (r[2] === 1 ? ' седмица' : ' седмици') : r[2] + (r[2] === 1 ? ' месец' : ' месеца')) + ' (' + r[3] + ')']));
  const sec = (title, add, ...body) => h('section', { class: 'card stack' }, h('div', { class: 'head m-0' }, h('h2', null, title), edit && add ? h('button', { class: 'btn sm', onclick: add }, '+ Добави') : null), ...body);
  const rowBtns = (onEdit, onDel) => edit ? h('div', { class: 'actions' }, h('button', { class: 'btn sm', onclick: onEdit }, 'Промени'), h('button', { class: 'btn sm danger', onclick: onDel }, '✕')) : null;

  /* заседания */
  const hearingDlg = it => formDialog(it.id ? 'Заседание' : 'Ново заседание', [
    { k: 'date', label: 'Дата', type: 'date', req: true }, { k: 'time', label: 'Час', type: 'time' },
    { k: 'kind', label: 'Вид', type: 'select', options: L.hearingKinds }, { k: 'room', label: 'Зала', max: 40 },
    { k: 'result', label: 'Резултат', type: 'select', options: L.hearingResults.map(o => [o, o || '— предстои —']) },
    { k: 'attendee', label: 'Явява се от наша страна', max: 160, list: 'att-names' },
    { k: 'note', label: 'Бележки (доказателства, указания, следващи действия)', type: 'textarea', full: true, rows: 3, max: 3000 }
  ], Object.assign({ kind: 'Открито заседание' }, it), 'Запази', v => part('hearings', { item: Object.assign({ id: it.id || '' }, v) }), { wide: true, extra: h('datalist', { id: 'att-names' }, users.map(n => h('option', { value: n }))) });
  const today = todayIso();
  const hearings = sec('Заседания', () => hearingDlg({}), det.hearings.length ? table(['Дата и час', 'Вид', 'Зала', 'Резултат', 'Явява се', ''], det.hearings.map(it => h('tr', { class: (it.date >= today && !it.canceled ? 'upcoming' : '') + (it.canceled ? ' canceled' : '') },
    h('td', null, h('b', null, fmtDate(it.date)), it.time ? ' ' + it.time : '', fromEpep(it), h('div', { class: 'small muted' }, dayInfo(it.date).workday ? '' : dayInfo(it.date).label)),
    h('td', null, it.kind), h('td', null, it.room || '—'),
    h('td', null, it.canceled ? h('span', { class: 'pill bad' }, 'отменено') : (it.result || it.epepResult) ? h('span', { class: 'pill ' + (it.result === 'Отложено' ? 'warn' : 'info') }, it.epepResult || it.result) : h('span', { class: 'muted' }, it.date >= today ? 'предстои' : '—'),
      it.video ? h('div', null, h('a', { href: it.video, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'Видеовръзка')) : null, it.note ? h('div', { class: 'small pre' }, it.note) : null),
    h('td', null, it.attendee || '—'), h('td', null, rowBtns(() => hearingDlg(it), remove('hearings', it, 'заседанието')))))) : h('p', { class: 'empty' }, 'Няма въведени заседания.'));

  /* съдебни актове и срокове за обжалване */
  const actDlg = it => formDialog(it.id ? 'Съдебен акт' : 'Нов съдебен акт', [
    { k: 'kind', label: 'Вид', type: 'select', options: L.actKinds, req: true }, { k: 'no', label: '№', max: 40 },
    { k: 'date', label: 'Дата на акта', type: 'date', req: true }, { k: 'served', label: 'Съобщен на (връчен / изтеглен от ЕПЕП)', type: 'date', hint: 'От тази дата тече срокът.' },
    { k: 'outcome', label: 'Резултат', type: 'select', options: L.actOutcomes.map(o => [o, o || '—']), full: true },
    { k: 'remedy', label: 'Подлежи на', type: 'select', options: remedies, full: true },
    { k: 'due', label: 'Друг срок, определен от съда', type: 'date', hint: 'Само ако съдът е дал различен срок (напр. за отстраняване на нередовности).' },
    { k: 'appealedOn', label: 'Обжалван от нас на', type: 'date' }, { k: 'finalOn', label: 'Влязъл в сила на', type: 'date' },
    { k: 'summary', label: 'Диспозитив / кратко съдържание', type: 'textarea', full: true, rows: 3, max: 4000 }
  ], Object.assign({ kind: 'Решение' }, it), 'Запази', v => part('acts', { item: Object.assign({ id: it.id || '' }, v) }), { wide: true });
  const acts = sec('Съдебни актове и обжалване', () => actDlg({}), det.acts.length ? table(['Акт', 'Резултат', 'Съобщен', 'Срок за обжалване / действие', ''], det.acts.map(it => h('tr', null,
    h('td', null, h('b', null, (it.epepKind || it.kind) + (it.no ? ' № ' + it.no : '')), fromEpep(it), h('div', { class: 'small muted' }, fmtDate(it.date)), it.judges ? h('div', { class: 'small muted' }, it.judges) : null),
    h('td', null, it.outcome || '—', it.summary ? h('details', null, h('summary', { class: 'small' }, 'Текст'), h('div', { class: 'small pre' }, it.summary)) : null),
    h('td', null, it.served ? fmtDate(it.served) : h('span', { class: 'warn-text small' }, 'не е съобщен')),
    h('td', null, it.remedy === L.noRemedy || it.remedy === L.zdoiFinal ? [h('span', { class: 'muted' }, it.remedy === L.zdoiFinal ? 'окончателно (чл. 40, ал. 3 ЗДОИ)' : 'не подлежи на обжалване'), it.finalOn ? h('div', { class: 'small muted' }, 'в сила от ' + fmtDate(it.finalOn)) : null] : it.deadline
      ? [h('div', { class: 'small' }, it.deadline.label), it.appealedOn ? h('span', { class: 'pill ok' }, 'обжалван ' + fmtDate(it.appealedOn)) : it.finalOn ? h('span', { class: 'pill' }, 'в сила от ' + fmtDate(it.finalOn)) : deadlineBadge({ date: it.deadline.due, daysLeft: daysBetween(today, it.deadline.due) })]
      : it.remedy ? h('span', { class: 'small muted' }, it.remedy + ' – въведете датата на съобщаване') : '—', it.finalOn && it.appealedOn ? h('div', { class: 'small muted' }, 'в сила от ' + fmtDate(it.finalOn)) : null),
    h('td', null, rowBtns(() => actDlg(it), remove('acts', it, 'акта')))))) : h('p', { class: 'empty' }, 'Няма въведени съдебни актове.'));

  /* книжа */
  const filingDlg = it => formDialog(it.id ? 'Книжа' : 'Нови книжа', [
    { k: 'date', label: 'Дата', type: 'date', req: true }, { k: 'kind', label: 'Вид', type: 'select', options: L.filingKinds, req: true },
    { k: 'dir', label: 'Посока', type: 'select', options: L.filingDir }, { k: 'via', label: 'Начин', type: 'select', options: L.filingVia },
    { k: 'inNo', label: 'Вх. № в съда', max: 40 }, { k: 'note', label: 'Съдържание / бележки', type: 'textarea', full: true, rows: 3, max: 3000 }
  ], Object.assign({ date: today, kind: 'Молба', dir: 'Подадено от нас', via: 'ЕПЕП' }, it), 'Запази', v => part('filings', { item: Object.assign({ id: it.id || '' }, v) }), { wide: true });
  const filings = sec('Книжа (молби, становища, доказателства)', () => filingDlg({}), det.filings.length ? table(['Дата', 'Вид', 'От / до', 'Вх. №', ''], det.filings.slice().reverse().map(it => h('tr', null,
    h('td', null, fmtDate(it.date)), h('td', null, it.kind, it.note ? h('div', { class: 'small muted pre' }, it.note) : null), h('td', { class: 'small' }, it.dir + ' · ' + it.via), h('td', { class: 'mono' }, it.inNo || '—'),
    h('td', null, rowBtns(() => filingDlg(it), remove('filings', it, 'записа')))))) : h('p', { class: 'empty' }, 'Няма въведени книжа.'));

  /* такси и разноски */
  const feeDlg = it => formDialog(it.id ? 'Такса или разноски' : 'Нова такса или разноски', [
    { k: 'kind', label: 'Вид', type: 'select', options: L.feeKinds, req: true }, { k: 'status', label: 'Състояние', type: 'select', options: L.feeStatus },
    { k: 'amount', label: 'Сума', max: 12, hint: 'Напр. 25,56' }, { k: 'currency', label: 'Валута', type: 'select', options: [['EUR', 'евро'], ['BGN', 'лева (преди 2026 г.)']] },
    { k: 'dueDate', label: 'Срок за внасяне', type: 'date' }, { k: 'date', label: 'Дата на плащане', type: 'date' },
    { k: 'payer', label: 'Платец / задължено лице', max: 160 }, { k: 'doc', label: 'Платежен документ №', max: 80 },
    { k: 'basis', label: 'Основание', max: 160, full: true, hint: 'Напр. Тарифа за държавните такси по ГПК (вр. чл. 151, т. 3 АПК), чл. 143 АПК, чл. 78 ГПК, Наредба № 1/2004 за адв. възнаграждения.' },
    { k: 'note', label: 'Бележки', type: 'textarea', full: true, rows: 2, max: 2000 }
  ], Object.assign({ kind: 'Държавна такса', status: 'Дължима', currency: 'EUR' }, it), 'Запази', v => part('fees', { item: Object.assign({ id: it.id || '' }, v) }), { wide: true,
    extra: it.id ? null : h('div', { class: 'actions mt-8' }, h('span', { class: 'small muted' }, 'Попълни:'), L.feePresets.map(([label, amount, basis]) => h('button', { type: 'button', class: 'btn sm', onclick: e => {
      const f = e.target.closest('form'); f.elements.kind.value = 'Държавна такса'; f.elements.amount.value = amount.replace('.', ','); f.elements.currency.value = 'EUR'; f.elements.basis.value = basis;
    } }, label + ' – ' + amount.replace('.', ',') + ' €')), h('div', { class: 'small muted' }, 'Ориентировъчни суми от 01.01.2026; проверете указанията на съда.')) });
  const tt = d.totals;
  const fees = sec('Такси и разноски', () => feeDlg({}),
    h('div', { class: 'fee-sum' }, [['Платени от нас', tt.paid], ['Дължими', tt.due, tt.due ? 'warn' : ''], ['Присъдени в наша полза', tt.awardedFor, 'ok'], ['Присъдени в наша тежест', tt.awardedAgainst, tt.awardedAgainst ? 'bad' : ''], ['Събрани', tt.collected]]
      .map(([l, v, c]) => h('div', { class: 'fee-box ' + (c || '') }, h('small', { class: 'muted' }, l), h('b', null, money(v))))),
    det.fees.length ? table(['Вид', 'Сума', 'Състояние', 'Дати', ''], det.fees.map(it => h('tr', null,
      h('td', null, it.kind, it.basis ? h('div', { class: 'small muted' }, it.basis) : null, it.payer ? h('div', { class: 'small muted' }, it.payer) : null),
      h('td', { class: 'num' }, it.amount ? it.amount.replace('.', ',') + ' ' + (it.currency === 'BGN' ? 'лв.' : '€') : '—'),
      h('td', null, h('span', { class: 'pill ' + ({ 'Дължима': 'warn', 'Платена': 'ok', 'Присъдена в наша полза': 'ok', 'Присъдена в наша тежест': 'bad', 'Събрана': 'ok' }[it.status] || '') }, it.status)),
      h('td', { class: 'small' }, it.dueDate ? 'до ' + fmtDate(it.dueDate) : '', it.date ? h('div', null, 'платено ' + fmtDate(it.date) + (it.doc ? ' · ' + it.doc : '')) : null),
      h('td', null, rowBtns(() => feeDlg(it), remove('fees', it, 'записа')))))) : h('p', { class: 'empty' }, 'Няма въведени такси и разноски.'),
    h('p', { class: 'small muted' }, 'Разноските се искат със списък по чл. 80 ГПК до края на последното заседание; изменение на решението в частта за разноските – по чл. 248 ГПК (вр. чл. 144 АПК). Размерът на таксите – по Тарифата за държавните такси, събирани от съдилищата по ГПК.'));

  /* срокове */
  const dlDlg = it => formDialog(it.id ? 'Срок' : 'Нов срок, определен от съда', [
    { k: 'label', label: 'Какво трябва да се направи', req: true, max: 200, full: true }, { k: 'due', label: 'До', type: 'date', req: true },
    { k: 'basis', label: 'Основание', max: 160, hint: 'Напр. разпореждане от 12.11.2026, чл. 158 АПК' }, { k: 'done', label: 'Изпълнено', type: 'checkbox' },
    { k: 'note', label: 'Бележки', type: 'textarea', full: true, rows: 2, max: 2000 }
  ], it, 'Запази', v => part('deadlines', { item: Object.assign({ id: it.id || '' }, v, { done: !!v.done }) }), { wide: true });
  const dls = d.deadlines.filter(dl => dl.kind !== 'Заседание');
  const deadlines = sec('Срокове', () => dlDlg({}), dls.length ? h('ul', { class: 'list-plain dl-list' }, dls.map(dl => h('li', { class: dl.done ? 'done' : '' },
    h('span', null, h('span', { class: 'small muted' }, dl.kind), h('br'), dl.label), h('span', { class: 'stack-r' }, deadlineBadge(dl),
      edit && dl.id ? h('button', { class: 'btn sm', onclick: () => dlDlg(det.deadlines.find(z => z.id === dl.id)) }, 'Промени') : null))))
    : h('p', { class: 'empty' }, 'Няма срокове. Сроковете за обжалване се изчисляват от съдебните актове (по ' + det.procedure + '), а тези, които дава съдът – добавете тук.'));

  /* състав */
  const pn = det.panel;
  const panelDlg = () => formDialog('Съдебен състав', [
    { k: 'formation', label: 'Състав', type: 'select', options: L.formations.map(o => [o, o || '—']) }, { k: 'division', label: 'Отделение / колегия / състав №', max: 120 },
    { k: 'reporter', label: 'Съдия-докладчик', max: 120 }, { k: 'chair', label: 'Председател', max: 120 },
    { k: 'members', label: 'Членове', max: 300, full: true }, { k: 'prosecutor', label: det.procedure === 'АПК' ? 'Прокурор (чл. 192 АПК)' : 'Прокурор', max: 160 },
    { k: 'clerk', label: 'Съдебен секретар', max: 120 }
  ], pn, 'Запази', v => part('panel', { item: v }), { wide: true });
  const panel = h('section', { class: 'card stack' }, h('div', { class: 'head m-0' }, h('h2', null, 'Съдебен състав'), edit ? h('button', { class: 'btn sm', onclick: panelDlg }, 'Промени') : null),
    Object.values(pn).some(Boolean) ? kv([['Състав', [pn.formation, pn.division].filter(Boolean).join(', ')], ['Съдия-докладчик', pn.reporter], ['Председател', pn.chair], ['Членове', pn.members], ['Прокурор', pn.prosecutor], ['Секретар', pn.clerk]])
      : h('p', { class: 'empty' }, 'Не е въведен.'));

  /* ЕПЕП */
  const ep = det.epep;
  const sync = async btn => {
    if (btn) btn.disabled = true;
    try {
      const r = await api('court.epep', { id });
      if (r.candidates) {
        if (!r.candidates.length) { toast('В ЕПЕП няма дело № ' + x.caseNo + '/' + x.year + ' в ' + x.court + '. Проверете номера и съда или поставете връзката от ЕПЕП.'); return epepDlg(); }
        return dialog('Изберете делото в ЕПЕП', h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Намерени са няколко дела с този номер и година.'),
          h('ul', { class: 'list-plain' }, r.candidates.map(c => h('li', null, h('span', null, h('b', null, c.court), h('br'), h('span', { class: 'small muted' }, c.kind + ' · образувано ' + fmtDate(c.instituted) + (c.reporter ? ' · ' + c.reporter : ''))),
            h('button', { class: 'btn sm primary', onclick: async () => { try { const z = await api('court.epep', { id, gid: c.gid }); document.querySelector('dialog[open]').close(); toast('Свързано с ЕПЕП. Промени: ' + z.changes.length + '.'); reload(); } catch (e) { toast(e.message); } } }, 'Това е'))))));
      }
      toast(r.changes.length ? 'От ЕПЕП: ' + r.changes.length + ' промени.' : 'Няма нови данни в ЕПЕП.'); reload();
    } catch (e) { toast(e.message); if (btn) btn.disabled = false; }
  };
  const epepDlg = () => formDialog('ЕПЕП – Единен портал за електронно правосъдие', [
    { k: 'url', label: 'Връзка към делото в ЕПЕП', type: 'url', max: 400, full: true, hint: 'Ако делото не се намира само: отворете го в ecase.justice.bg и копирайте адреса.' },
    { k: 'access', label: 'Достъп до пълната папка', type: 'select', options: L.epepAccess.map(o => [o, o || '—']) },
    { k: 'profile', label: 'Чрез профил на', max: 160, hint: 'Лицето или пълномощникът, на чийто профил е даден достъпът.' },
    { k: 'eserve', label: 'Съгласие за електронни съобщения и призовки чрез ЕПЕП', type: 'checkbox', full: true }
  ], Object.assign({}, ep, { eserve: ep.eserve ? 'Да' : '' }), 'Запази', async v => {
    await api('court.part', { id, part: 'epep', item: Object.assign({}, ep, v, { eserve: !!v.eserve }) });
    if (v.url && v.url !== ep.url) { const z = await api('court.epep', { id, gid: v.url }); toast('Свързано с ЕПЕП. Промени: ' + (z.changes || []).length + '.'); }
    reload();
  }, { wide: true });
  const linked = !!(ep.gid || ep.url);
  const epep = h('section', { class: 'card stack' }, h('div', { class: 'head m-0' }, h('h2', null, 'ЕПЕП'), edit ? h('div', { class: 'actions' },
      h('button', { class: 'btn sm primary', onclick: e => sync(e.target) }, linked ? 'Обнови от ЕПЕП' : 'Намери в ЕПЕП'), h('button', { class: 'btn sm', onclick: epepDlg }, 'Настройки')) : null),
    linked ? h('p', { class: 'small' }, h('span', { class: 'pill ' + (ep.error ? 'warn' : 'ok') }, ep.error ? 'грешка при обновяване' : 'свързано'), ' ', ep.syncedAt ? 'обновено ' + fmtTime(ep.syncedAt) : '', ep.error ? h('div', { class: 'small warn-text' }, ep.error) : null)
      : h('p', { class: 'small muted' }, 'Делото още не е свързано с ЕПЕП. „Намери в ЕПЕП“ го търси по съд, номер и година.'),
    kv([['Вид в ЕПЕП', det.epepKind], ['Входящ №', det.inNo], ['Достъп до папката', ep.access || '—'], ['Профил', ep.profile], ['Електронни съобщения', ep.eserve ? 'Да' : 'Не']]),
    (det.assignments || []).length ? h('details', null, h('summary', { class: 'small' }, 'Разпределения (' + det.assignments.length + ')'), h('ul', { class: 'list-plain small' }, det.assignments.map(a => h('li', null, h('span', null, a.judge, h('br'), h('span', { class: 'muted' }, a.type + (a.by ? ' · ' + a.by : ''))), h('b', null, fmtDate(a.date)))))) : null,
    (det.connected || []).length ? h('details', { open: true }, h('summary', { class: 'small' }, 'Свързани дела'), h('ul', { class: 'list-plain small' }, det.connected.map(c => h('li', null, h('a', { href: 'https://ecase.justice.bg/Case/CaseDetail/' + c.gid, target: '_blank', rel: 'noopener noreferrer' }, c.court + ' № ' + c.no + '/' + c.year), h('span', { class: 'muted' }, c.kind))))) : null,
    h('div', { class: 'actions' }, h('a', { class: 'btn sm', href: ep.url || 'https://ecase.justice.bg/Case', target: '_blank', rel: 'noopener noreferrer' }, ep.url ? 'Отвори делото в ЕПЕП' : 'Отвори ЕПЕП'),
      edit && linked ? h('button', { class: 'btn sm danger', onclick: async () => { if (!confirm('Да се премахне ли връзката с ЕПЕП? Въведените данни остават.')) return; try { await api('court.epep', { id, unlink: true }); reload(); } catch (e) { toast(e.message); } } }, 'Премахни връзката') : null),
    h('p', { class: 'small muted' }, 'Обновява се автоматично всеки ден; при нов акт, ново или отменено заседание или смяна на състава отговорникът получава имейл. Пълната папка (документи, призовки) е само с вход с КЕП в ЕПЕП – датата на съобщаване на акта въведете при акта.'));

  /* страни */
  const partyDlg = it => formDialog(it.id ? 'Страна' : 'Нова страна', [
    { k: 'role', label: 'Качество', type: 'select', options: L.partyRoles, req: true }, { k: 'name', label: 'Име / наименование', req: true, max: 250 },
    { k: 'rep', label: 'Процесуален представител', max: 250 }, { k: 'contact', label: 'Адрес / имейл за призоваване', max: 250 }, { k: 'note', label: 'Бележка', max: 300, full: true }
  ], Object.assign({ role: det.procedure === 'ГПК' ? 'Ищец' : 'Жалбоподател' }, it), 'Запази', v => part('parties', { item: Object.assign({ id: it.id || '' }, v) }), { wide: true });
  const parties = sec('Страни', () => partyDlg({}), det.parties.length ? h('ul', { class: 'list-plain' }, det.parties.map(it => h('li', null,
    h('span', null, h('span', { class: 'small muted' }, it.role), h('br'), h('b', null, it.name), it.rep ? h('div', { class: 'small muted' }, 'представител: ' + it.rep) : null, it.contact ? h('div', { class: 'small muted' }, it.contact) : null),
    rowBtns(() => partyDlg(it), remove('parties', it, 'страната'))))) : h('p', { class: 'empty' }, 'Няма въведени страни.'));

  const ownerBox = (() => {
    const users2 = boot.users.filter(u => u.role !== 'Наблюдател');
    const save = async owner => { try { await api('court.assign', { id, owner }); toast('Отговорникът е записан.'); reload(); } catch (e) { toast(e.message); } };
    if (edit && can('assign')) {
      const sel = h('select', { 'aria-label': 'Отговорник' }, h('option', { value: '' }, '— без отговорник —'), users2.map(u => h('option', { value: u.username }, u.name)));
      sel.value = det.owner || '';
      return h('section', { class: 'card stack' }, h('h2', null, 'Отговорник по делото'), sel, h('div', { class: 'actions' }, h('button', { class: 'btn primary sm', onclick: () => save(sel.value) }, 'Запази')),
        h('p', { class: 'small muted' }, 'Получава известията от ЕПЕП и напомнянията за сроковете.'));
    }
    return h('section', { class: 'card stack' }, h('h2', null, 'Отговорник по делото'),
      det.owner ? h('div', { class: 'owner-line' }, h('span', { class: 'avatar sm' }, initials(userName(det.owner))), h('b', null, userName(det.owner))) : h('p', { class: 'muted' }, '— без отговорник —'),
      !det.owner && edit ? h('div', { class: 'actions' }, h('button', { class: 'btn primary sm', onclick: () => save(me.username) }, 'Назначи на мен')) : null,
      h('p', { class: 'small muted' }, det.owner ? 'Сменя се само от администратор.' : 'Можете да поемете делото сами.'));
  })();

  const history = h('section', { class: 'card stack' }, h('h2', null, 'История'),
    d.events.length ? h('ul', { class: 'timeline' }, d.events.slice(0, 60).map(e => h('li', null, h('div', { class: 'small muted' }, fmtTime(e.at) + ' · ' + userName(e.user) + ' · ' + e.kind), h('div', { class: 'pre small' }, e.text)))) : h('p', { class: 'empty' }, 'Няма записи.'));

  const report = async () => {
    try {
      await Docs.open(Docs.dossierDef(Object.assign({
        org: boot.org, title: 'СПРАВКА ПО ДЕЛО ' + x.caseNo + '/' + x.year, subtitle: x.court + ' · ' + x.instance + ' · ' + det.procedure,
        sections: [
          { heading: 'Дело', kv: [['Вид', x.kind], ['Предмет', det.subject], ['Обжалван акт', det.appealedAct], ['Образувано на', fmtDate(det.instituted)], ['Статус', x.status], ['Резултат', x.result], ['Преписка', x.regNo],
            ['Съдебен състав', [pn.formation, pn.division, pn.reporter ? 'докладчик ' + pn.reporter : '', pn.chair ? 'председател ' + pn.chair : '', pn.members ? 'членове ' + pn.members : '', pn.prosecutor ? 'прокурор ' + pn.prosecutor : ''].filter(Boolean).join('; ')],
            ['ЕПЕП', [ep.access ? 'достъп – ' + ep.access : '', ep.eserve ? 'електронни съобщения' : '', ep.url].filter(Boolean).join('; ')]] },
          det.parties.length ? { heading: 'Страни', table: { head: ['Качество', 'Име', 'Представител'], rows: det.parties.map(p => [p.role, p.name, p.rep || '']), widths: [90, '*', 150] } } : null,
          { heading: 'Заседания', table: { head: ['Дата', 'Час', 'Вид', 'Резултат'], rows: det.hearings.map(p => [fmtDate(p.date), p.time || '', p.kind, p.result || '']), widths: [60, 40, '*', 120] } },
          { heading: 'Съдебни актове', table: { head: ['Акт', 'Дата', 'Съобщен', 'Резултат', 'Срок'], rows: d.details.acts.map(a => [a.kind + (a.no ? ' № ' + a.no : ''), fmtDate(a.date), fmtDate(a.served), a.outcome || '', a.deadline ? fmtDate(a.deadline.due) + ' – ' + a.deadline.label : (a.remedy || '')]), widths: [80, 55, 55, 110, '*'] } },
          det.filings.length ? { heading: 'Книжа', table: { head: ['Дата', 'Вид', 'Посока', 'Вх. №'], rows: det.filings.map(f => [fmtDate(f.date), f.kind, f.dir + ' · ' + f.via, f.inNo || '']), widths: [60, '*', 140, 60] } } : null,
          det.fees.length ? { heading: 'Такси и разноски', table: { head: ['Вид', 'Сума', 'Състояние', 'Дата'], rows: det.fees.map(f => [f.kind, f.amount ? f.amount + ' ' + f.currency : '', f.status, fmtDate(f.date || f.dueDate)]), widths: ['*', 70, 110, 60] } } : null,
          dls.length ? { heading: 'Срокове', table: { head: ['До', 'Срок', 'Състояние'], rows: dls.map(dl => [fmtDate(dl.date), dl.label, dl.done ? 'изпълнено' : dueText(dl.daysLeft)]), widths: [60, '*', 90] } } : null,
          det.text ? { heading: 'Бележки', text: det.text } : null
        ].filter(Boolean)
      }, generated())), 'Дело ' + x.caseNo + '-' + x.year + '.pdf');
    } catch (e) { toast(e.message); }
  };

  const open = d.deadlines.filter(dl => !dl.done && dl.kind !== 'Заседание' && dl.daysLeft >= 0)[0];
  const nextH = d.deadlines.filter(dl => dl.kind === 'Заседание')[0];
  setView(
    head(courtShort(x), h('span', { class: 'pill' }, x.status), h('span', { class: 'pill info' }, det.procedure),
      edit ? h('button', { class: 'btn', onclick: () => courtDialog(Object.assign({}, x, { instituted: det.instituted, subject: det.subject, appealedAct: det.appealedAct, interest: det.interest, note: det.text, appealBy: det.appealBy, executedOn: det.executedOn }), reload) }, 'Основни данни') : null,
      edit ? docMenu(x, det, d, reload) : null,
      h('button', { class: 'btn primary', onclick: report }, 'Справка (PDF)')),
    x.zdoi ? h('p', { class: 'note mb-12' }, 'Дело по ЗДОИ: решението на административния съд е окончателно (чл. 40, ал. 3 ЗДОИ). При отменен отказ органът дължи ново решение по заявлението – срокът се показва след въвеждане на датата на влизане в сила.') : null,
    h('p', { class: 'small muted mb-12' }, h('a', { href: '#/courts' }, '← Всички дела'), x.regNo ? [' · преписка ', h('a', { href: (/^П-/.test(x.regNo) ? '#/request/' : '#/case/') + encodeURIComponent(x.regNo) }, x.regNo)] : null),
    h('div', { class: 'tiles' },
      h('div', { class: 'card tile' }, h('b', null, nextH ? fmtDate(nextH.date) : '—'), h('span', { class: 'muted' }, 'Следващо заседание' + (nextH && nextH.time ? ' · ' + nextH.time : ''))),
      h('div', { class: 'card tile ' + (open && open.daysLeft <= 3 ? 'warn' : '') }, h('b', null, open ? fmtDate(open.date) : '—'), h('span', { class: 'muted' }, open ? open.label : 'Няма текущ срок')),
      h('div', { class: 'card tile' }, h('b', null, det.acts.length), h('span', { class: 'muted' }, 'Съдебни акта')),
      h('div', { class: 'card tile' }, h('b', null, money(tt.paid)), h('span', { class: 'muted' }, 'Платени такси и разноски'))),
    h('div', { class: 'split' },
      h('div', { class: 'stack' },
        h('section', { class: 'card stack' }, h('h2', null, 'Дело'), kv([
          ['Съд', x.court], ['Инстанция', x.instance], ['Процесуален ред', det.procedure === 'АПК' ? 'Административнопроцесуален кодекс' : 'Граждански процесуален кодекс'],
          ['Вид производство', x.kind], ['Предмет', det.subject], ['Обжалван акт', det.appealedAct], ['Образувано на', det.instituted ? fmtDate(det.instituted) : ''],
          ['Срок за обжалване на акта на органа', det.appealBy ? fmtDate(det.appealBy) : ''], ['Органът се произнесе отново на', det.executedOn ? fmtDate(det.executedOn) : ''],
          ['Материален интерес', det.interest], ['Резултат', x.result], ['Бележки', det.text], ['Въведено', fmtTime(x.at) + ' от ' + userName(x.by)]])),
        hearings, acts, filings, fees),
      h('div', { class: 'stack' }, deadlines, ownerBox, epep, panel, parties, history)));
}

/* ---------- адресати ---------- */

const ADDRESSEE_FIELDS = () => [
  { k: 'type', label: 'Вид', type: 'select', options: boot.lists.addresseeTypes, req: true },
  { k: 'name', label: 'Име или наименование', req: true, max: 200 },
  { k: 'regBasis', label: 'Регистрация', type: 'select', options: boot.lists.regBasis.map(o => [o, o || '— (физическо лице или без регистрация)']) },
  { k: 'eik', label: 'ЕИК/БУЛСТАТ', max: 13, pattern: '\\d{9}|\\d{13}' },
  { k: 'seat', label: 'Седалище', max: 120 },
  { k: 'oblast', label: 'Област', max: 80 },
  { k: 'address', label: 'Адрес', max: 400, full: true },
  { k: 'email', label: 'Имейл', type: 'email', max: 200 },
  { k: 'phone', label: 'Телефон', type: 'tel', max: 40 }
];

/*
 * Регистри за адресати: административните структури (ИИСДА) и училищата, детските градини и центровете (МОН).
 * И двата се теглят от data.egov.bg; при училищата БУЛСТАТ и имейл се добавят с файл от ri.mon.bg.
 */
const REG_SOURCES = {
  iisda: { title: 'Администрации (ИИСДА)', what: 'структури', placeholder: 'Търсене: наименование, БУЛСТАТ, имейл, община…' },
  mon: { title: 'Училища и детски градини (МОН)', what: 'институции', placeholder: 'Търсене: наименование, код по НЕИСПУО, БУЛСТАТ, директор, община…' },
  appk: { title: 'Публични предприятия (АППК)', what: 'предприятия', placeholder: 'Търсене: наименование, ЕИК, министерство, управител, община…' }
};
const regHash = k => '#/addressees?registry' + (k === 'iisda' ? '' : '-' + k);
const regKey = (source, x) => (source === 'iisda' ? x.eik : x.key);

/* файл от регистъра на институциите (ri.mon.bg): CSV или Excel; колоните се разпознават по заглавията */
async function readMonFile(file) {
  const buf = await file.arrayBuffer();
  let rows;
  if (/\.csv$|text\/csv/i.test(file.name + ' ' + file.type)) {
    let text = new TextDecoder('utf-8').decode(buf);
    if (/�/.test(text)) text = new TextDecoder('windows-1251').decode(buf);
    const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : text.includes('\t') ? '\t' : ',';
    rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(c => c.trim()); });
  } else {
    if (!window.XLSX) await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = 'vendor/xlsx.full.min.js'; s.onload = ok; s.onerror = () => bad(new Error('Библиотеката за Excel не се зареди.')); document.head.append(s); });
    const wb = window.XLSX.read(buf, { type: 'array' });
    rows = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
  }
  const hi = rows.findIndex(r => r.some(c => /неиспуо|код по/i.test(String(c))) && r.some(c => /еик|булстат|e-?mail|имейл|поща/i.test(String(c))));
  if (hi < 0) throw new Error('Не са открити колони „Код по НЕИСПУО“ и „ЕИК/БУЛСТАТ“ или „Имейл“. Изтеглете списъка от ri.mon.bg без промени.');
  const head = rows[hi].map(c => String(c).toLowerCase());
  const col = re => head.findIndex(c => re.test(c));
  const ix = { code: col(/неиспуо/) >= 0 ? col(/неиспуо/) : col(/^код/), bulstat: col(/еик|булстат/), email: col(/e-?mail|имейл|електронна поща/), phone: col(/телефон/) };
  return rows.slice(hi + 1).map(r => ({ code: String(r[ix.code] || '').trim(), bulstat: ix.bulstat >= 0 ? String(r[ix.bulstat] || '').trim() : '', email: ix.email >= 0 ? String(r[ix.email] || '').trim() : '', phone: ix.phone >= 0 ? String(r[ix.phone] || '').trim() : '' }))
    .filter(r => /\d/.test(r.code));
}

async function registryView(addressees, tabs, source) {
  source = REG_SOURCES[source] ? source : 'iisda';
  const S = REG_SOURCES[source];
  const r0 = await api('registry.search', { source, q: '', limit: 1, facets: true });
  const q = h('input', { type: 'search', placeholder: S.placeholder, 'aria-label': 'Търсене' });
  const kind = h('select', { 'aria-label': 'Вид' }, h('option', { value: '' }, 'Всички видове'), r0.kinds.map(k => h('option', { value: k }, k)));
  const obl = h('select', { 'aria-label': 'Област' }, h('option', { value: '' }, 'Всички области'), r0.oblasts.map(k => h('option', { value: k }, k)));
  const body = h('div'), info = h('p', { class: 'small muted' });
  // вече в адресатите на лицето: по БУЛСТАТ, а училищата без БУЛСТАТ – по наименование и община
  const have = x => addressees.some(a => (x.eik && a.eik === x.eik) || (a.name === x.name && (!x.muni || (a.seat || '') === x.muni)));
  let shown = [], timer = null;
  const add = async (list, btn) => {
    if (btn) btn.disabled = true;
    let added = 0, updated = 0;
    try {
      for (let i = 0; i < list.length; i += 40) {
        const r = await api('registry.import', { source, keys: list.slice(i, i + 40).map(x => regKey(source, x)), person: curCode || '' });
        added += r.added; updated += r.updated;
        if (btn) btn.textContent = 'Добавяне… ' + Math.min(i + 40, list.length) + '/' + list.length;
      }
      addressees = (await api('addressee.list', { person: curCode || '' })).addressees;
      toast('Адресати: добавени ' + added + ', обновени ' + updated + '.');
      draw();
    } catch (e) { toast(e.message); if (btn) btn.disabled = false; }
  };
  const run = async () => {
    const r = await api('registry.search', { source, q: q.value, kind: kind.value, oblast: obl.value, limit: 700 });
    shown = r.items;
    info.replaceChildren('Намерени: ' + r.total + ' от ' + r.all + ' ' + S.what + '.' + (source !== 'iisda' ? ' С ' + (source === 'appk' ? 'ЕИК' : 'БУЛСТАТ') + ' и имейл: ' + (r.withEik || 0) + '.' : ''));
    draw();
  };
  const contact = x => [x.email ? h('a', { href: 'mailto:' + x.email }, x.email) : h('span', { class: 'muted' }, 'без имейл'), x.phone ? h('div', { class: 'muted' }, x.phone) : null,
    x.web ? h('div', null, h('a', { href: /^https?:/.test(x.web) ? x.web : 'https://' + x.web, target: '_blank', rel: 'noopener noreferrer' }, x.web)) : null];
  const draw = () => {
    const head = source === 'mon' ? ['Институция', 'НЕИСПУО / БУЛСТАТ', 'Адрес', 'Имейл, телефон, сайт', ''] : source === 'appk' ? ['Предприятие', 'ЕИК/БУЛСТАТ', 'Седалище и адрес', 'Имейл, телефон, сайт', ''] : ['Структура', 'ЕИК/БУЛСТАТ', 'Адрес', 'Имейл и телефон', ''];
    body.replaceChildren(table(head, shown.slice(0, 300).map(x => h('tr', null,
      h('td', null, h('b', null, x.name), h('div', { class: 'small muted' }, (x.type || x.kind) + (x.parent ? ' · към ' + x.parent : '') + (x.director ? (source === 'appk' ? ' · управление: ' : ' · директор: ') + x.director : '') + (x.share ? ' · държавно участие: ' + x.share : '') + (x.status && !['действаща', 'активно'].includes(x.status) ? ' · ' + x.status : ''))),
      source === 'mon' ? h('td', { class: 'mono small' }, x.code, h('br'), x.eik ? x.eik : h('span', { class: 'muted' }, 'без БУЛСТАТ')) : h('td', { class: 'mono' }, x.eik || h('span', { class: 'muted small' }, source === 'appk' ? 'зарежда се' : '—')),
      h('td', { class: 'small' }, x.address || '—', x.oblast ? h('div', { class: 'muted' }, 'обл. ' + x.oblast) : null),
      h('td', { class: 'small' }, contact(x)),
      h('td', null, have(x) ? h('span', { class: 'pill ok' }, 'в адресатите') : can('addressees') ? h('button', { class: 'btn sm', onclick: e => add([x], e.target) }, 'Добави') : null))),
      'Няма ' + S.what + ' по тези условия.'), ...(shown.length > 300 ? [h('p', { class: 'small muted' }, 'Показани са първите 300 – стеснете търсенето.')] : []));
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run().catch(e => toast(e.message)), 200); });
  [kind, obl].forEach(x => x.addEventListener('input', () => run().catch(e => toast(e.message))));
  const m = r0.meta || {};
  const srcTabs = h('div', { class: 'seg' }, Object.entries(REG_SOURCES).map(([k, v]) => h('button', { class: 'btn sm' + (k === source ? ' primary' : ''), onclick: () => { location.hash = regHash(k); } }, v.title)));
  // училища: файл от ri.mon.bg с БУЛСТАТ и имейл
  const monFile = h('input', { type: 'file', accept: '.csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hidden: true, onchange: async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const rows = await readMonFile(f);
      if (!rows.length) throw new Error('Във файла няма редове с код по НЕИСПУО.');
      const r = await api('registry.monImport', { rows, fileName: f.name });
      toast('От файла: свързани ' + r.matched + (r.unknown ? ', непознати кодове ' + r.unknown : '') + (r.bad ? ', невалиден БУЛСТАТ ' + r.bad : '') + '. Общо с данни: ' + r.total + '.');
      addresseesView('registry-mon');
    } catch (ex) { toast(ex.message); }
    e.target.value = '';
  } });
  setView(head('Адресати', tabs,
      can('addressees') ? h('button', { class: 'btn', onclick: e => {
        const list = shown.filter(x => !have(x));
        if (!list.length) return toast('Всички показани вече са в адресатите.');
        if (confirm('Да се добавят ли ' + list.length + ' ' + S.what + ' в адресатите?')) add(list, e.target);
      } }, 'Добави показаните в адресати') : null,
      can('addressees') ? h('button', { class: 'btn', onclick: async e => { e.target.disabled = true; try { const r = await api('registry.refresh', { source }); toast('Обновено: ' + r.name + ' (' + r.count + ').'); addresseesView(regHash(source).split('?')[1]); } catch (ex) { toast(ex.message); e.target.disabled = false; } } }, 'Обнови') : null),
    h('div', { class: 'mb-12' }, srcTabs),
    manyPersons() && curPerson() ? h('p', { class: 'small muted mb-4' }, '„Добави“ ги записва в адресатите на ', h('b', null, curPerson().name), '.') : null,
    source === 'mon'
      ? h('div', { class: 'stack mb-12' },
        h('p', { class: 'small muted' }, 'Училищата, детските градини, центровете за подкрепа за личностно развитие и специализираните обслужващи звена – код по НЕИСПУО, наименование, директор, адрес и сайт. Източник на списъка: ',
          h('a', { href: m.source || 'https://data.egov.bg/data/view/9d72ecff-e079-48a4-bc0a-1312bff178f6', target: '_blank', rel: 'noopener noreferrer' }, 'отворените данни на МОН'),
          m.name ? ' – ' + m.name + ' (заредено ' + fmtTime(m.at) + ').' : '.', ' Обновява се автоматично при нов списък.'),
        (() => {
          const ri = r0.ri || {};
          return h('div', { class: 'note' }, h('b', null, 'БУЛСТАТ, имейл, телефон и директор – от регистъра на институциите на МОН. '),
            'Взимат се автоматично от ', h('a', { href: 'https://ri.mon.bg/active-institutions', target: '_blank', rel: 'noopener noreferrer' }, 'ri.mon.bg'),
            ' (кодът, посочен там като „ЕИК“, е кодът по БУЛСТАТ на институцията и се записва като БУЛСТАТ). Списъкът се проверява всеки ден, а подробностите се изтеглят на порции и се обновяват на 30 дни.',
            ri.count ? h('div', { class: 'small mt-8' }, 'Активни в регистъра: ' + ri.count + ' · с изтеглени данни: ' + (ri.withDetails || 0) + (ri.left ? ' · остават: ' + ri.left + ' (зареждат се автоматично, по 25 на всеки 5 минути)' : ' · всички са актуални') + (ri.detAt ? ' · последно: ' + fmtTime(ri.detAt) : '')) : h('div', { class: 'small mt-8' }, 'Регистърът още не е зареден – ще се зареди автоматично до няколко минути.'),
            h('div', { class: 'small muted mt-8' }, 'При „Добави“ данните на избраната институция се изтеглят веднага. Ако регистърът е недостъпен, може да заредите изтеглен от ri.mon.bg файл (Excel/CSV).',
              m.extraAt ? ' Последен файл: ' + (m.extraName || '—') + ' · ' + fmtTime(m.extraAt) + '.' : ''),
            can('addressees') ? h('div', { class: 'actions mt-8' }, monFile, h('button', { class: 'btn sm', onclick: () => monFile.click() }, 'Зареди файл (по желание)')) : null);
        })())
      : source === 'appk'
      ? (() => {
        const ri = r0.ri || {};
        return h('div', { class: 'note mb-12' }, 'Публичните предприятия от ', h('a', { href: 'https://reports.appk.government.bg/Public/Public/Companies', target: '_blank', rel: 'noopener noreferrer' }, 'Електронно-информационната система за публичните предприятия'),
          ' на Агенцията за публичните предприятия и контрол – ЕИК/БУЛСТАТ, вид и правна форма, седалище и адрес, органът, упражняващ правата на държавата, управлението, телефон, имейл и сайт. Списъкът се проверява всеки ден, подробностите се теглят на порции и се обновяват на 30 дни.',
          ri.count ? h('div', { class: 'small mt-8' }, 'В регистъра: ' + ri.count + ' · с изтеглени данни: ' + (ri.withDetails || 0) + (ri.left ? ' · остават: ' + ri.left + ' (по 15 на всеки 5 минути)' : ' · всички са актуални') + (ri.detAt ? ' · последно: ' + fmtTime(ri.detAt) : '')) : null);
      })()
      : h('p', { class: 'small muted mb-12' }, 'Административните структури от Интегрираната информационна система на държавната администрация (ИИСДА) – наименование, ЕИК/БУЛСТАТ, адрес, имейл, телефон. Източник: ',
        h('a', { href: m.source || 'https://data.egov.bg/data/view/fd4218f2-72fa-44f2-853b-79aa1d7d6c2a', target: '_blank', rel: 'noopener noreferrer' }, 'Портал за отворени данни'),
        m.name ? ' – ' + m.name + ' (заредено ' + fmtTime(m.at) + ').' : '.', ' Обновява се автоматично при нов месечен ресурс. При ново заявление субектът се търси и оттук.'),
    h('div', { class: 'card' }, h('div', { class: 'filters' }, q, kind, obl), info, body));
  await run();
}

async function addresseesView(query) {
  loading();
  try {
    const { addressees } = await api('addressee.list', { person: curCode || '' });
    const tabs = h('div', { class: 'seg' }, h('button', { class: 'btn sm' + (/^registry/.test(query || '') ? '' : ' primary'), onclick: () => { location.hash = '#/addressees'; } }, 'Моите адресати'),
      h('button', { class: 'btn sm' + (/^registry/.test(query || '') ? ' primary' : ''), onclick: () => { location.hash = '#/addressees?registry'; } }, 'Регистри'));
    if (/^registry/.test(query || '')) return await registryView(addressees, tabs, (query || '').split('-')[1] || 'iisda');
    const edit = a => enhanceParty(formDialog(a._id ? 'Адресат' : 'Нов адресат', ADDRESSEE_FIELDS(), a, 'Запази', async v => {
      await api('addressee.save', Object.assign(v, { id: a._id || '', person: curCode || '' })); toast('Запазено.'); addresseesView();
    }, { wide: true }));
    const q = h('input', { type: 'search', placeholder: 'Търсене…', 'aria-label': 'Търсене' });
    const body = h('div');
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      const rows = addressees.filter(a => !t || [a.name, a.eik, a.email, a.address].join(' ').toLowerCase().includes(t));
      body.replaceChildren(table(['Име', 'Вид', 'ЕИК/БУЛСТАТ', 'Имейл', 'Адрес', ''], rows.map(a => h('tr', null,
        h('td', null, a.name), h('td', null, a.type), h('td', { class: 'mono' }, a.eik || '—'), h('td', null, a.email || '—'), h('td', null, a.address || '—'),
        h('td', null, me.perms.addressees ? h('div', { class: 'actions' },
          h('button', { class: 'btn sm', onclick: () => edit(a) }, 'Промени'),
          h('button', { class: 'btn sm danger', onclick: async () => { if (!confirm('Да се изтрие ли ' + a.name + '?')) return; try { await api('addressee.delete', { id: a._id }); toast('Изтрит.'); addresseesView(); } catch (e) { toast(e.message); } } }, 'Изтрий')) : null))), 'Няма адресати.'));
    };
    q.addEventListener('input', draw);
    setView(head('Адресати', tabs, me.perms.addressees ? h('button', { class: 'btn primary', onclick: () => edit({ type: 'Гражданин' }) }, 'Нов адресат') : null),
      h('p', { class: 'small muted mb-12' }, (manyPersons() && curPerson() ? 'Адресатите на ' + curPerson().name + ' – всяко лице има свой списък (смяна на лицето от горната лента). ' : '') + 'Заявители, трети лица и органи. Избират се при нова преписка.'),
      h('div', { class: 'card' }, h('div', { class: 'filters' }, q), body));
    draw();
  } catch (e) { failView(e); }
}

/* ---------- отдели ---------- */

async function departmentsView() {
  loading();
  try {
    const { departments } = await api('department.list');
    const fields = [
      { k: 'name', label: 'Наименование', req: true, max: 160, full: true }, { k: 'head', label: 'Ръководител', max: 120 },
      { k: 'position', label: 'Длъжност', max: 120 }, { k: 'email', label: 'Имейл', type: 'email', max: 200 }, { k: 'active', label: 'Активен', type: 'checkbox' }
    ];
    const edit = x => formDialog(x._id ? 'Отдел' : 'Нов отдел', fields, x, 'Запази', async v => {
      await api('department.save', Object.assign(v, { id: x._id || '' })); toast('Запазено.'); boot = await api('bootstrap'); departmentsView();
    });
    setView(head('Отдели', me.perms.departments ? h('button', { class: 'btn primary', onclick: () => edit({ active: 'Да' }) }, 'Нов отдел') : null),
      h('div', { class: 'card' }, table(['Наименование', 'Ръководител', 'Имейл', 'Състояние', ''], departments.map(x => h('tr', null,
        h('td', null, x.name), h('td', null, [x.head, x.position].filter(Boolean).join(', ') || '—'), h('td', null, x.email || '—'),
        h('td', null, h('span', { class: 'pill ' + (x.active === 'Да' ? 'ok' : '') }, x.active === 'Да' ? 'Активен' : 'Неактивен')),
        h('td', null, me.perms.departments ? h('button', { class: 'btn sm', onclick: () => edit(x) }, 'Промени') : null))), 'Няма въведени отдели.')));
  } catch (e) { failView(e); }
}

/* ---------- потребители ---------- */

/* браузър и ОС от User-Agent – само за показване */
function uaShort(ua) {
  const t = String(ua || '');
  if (!t) return '—';
  const b = /Edg\//.test(t) ? 'Edge' : /OPR\/|Opera/.test(t) ? 'Opera' : /Firefox\//.test(t) ? 'Firefox' : /Chrome\//.test(t) ? 'Chrome' : /Safari\//.test(t) ? 'Safari' : t.split(/[ /]/)[0];
  const o = /Windows/.test(t) ? 'Windows' : /Android/.test(t) ? 'Android' : /iPhone|iPad/.test(t) ? 'iOS' : /Mac OS X/.test(t) ? 'macOS' : /Linux/.test(t) ? 'Linux' : '';
  return b + (o ? ' · ' + o : '');
}

/*
 * Редактор на правата: по групи, с отметки за всяка операция. Администраторските права се виждат само при роля
 * „Администратор“. Права, които редактиращият няма, не може да даде (отметката е заключена).
 */
function permEditor(d, u, roleSel) {
  const custom = h('input', { type: 'checkbox', name: '_custom', checked: !!u.customPerms, disabled: !u.canPerms && !!u.username });
  const box = h('div', { class: 'perm-groups' });
  const state = {};
  const roleNow = () => roleSel ? roleSel.value : u.role;
  const defaults = () => d.rolePerms[roleNow()] || [];
  Object.keys(u.perms || {}).forEach(k => { state[k] = true; });
  const draw = () => {
    const role = roleNow(), isAdm = role === 'Администратор' || role === 'Суперадминистратор', viewer = role === 'Наблюдател';
    const useRole = !custom.checked || role === 'Суперадминистратор';
    const locked = (!u.canPerms && !!u.username) || (!u.username && !d.canPerms);
    box.replaceChildren(...d.permGroups.filter(([g]) => g !== 'Администрация' || isAdm).map(([g, list]) => h('fieldset', { class: 'perm-group' + (g === 'Администрация' ? ' admin' : '') },
      h('legend', null, g === 'Администрация' ? [icon('shield', 'sm'), ' Администрация – дава ги суперадминистраторът'] : g),
      h('div', { class: 'perm-list' }, list.map(([k, label]) => {
        const on = role === 'Суперадминистратор' || (useRole ? defaults().includes(k) : !!state[k]);
        const blocked = useRole || locked || (viewer && !d.viewPerms.includes(k)) || (!d.grantable.includes(k) && !on);
        const cb = h('input', { type: 'checkbox', checked: on && !(viewer && !d.viewPerms.includes(k)), disabled: blocked, onchange: e => { state[k] = e.target.checked; } });
        return h('label', { class: 'check perm' + (blocked ? ' dim' : '') }, cb, h('span', null, label, viewer && !d.viewPerms.includes(k) ? h('small', { class: 'muted' }, ' – не и за наблюдател') : null));
      })))));
  };
  custom.addEventListener('change', () => {
    if (custom.checked && !Object.keys(state).length) defaults().forEach(k => { state[k] = true; });
    draw();
  });
  if (roleSel) roleSel.addEventListener('change', draw);
  draw();
  const note = u.role === 'Суперадминистратор' ? 'Суперадминистраторът има всички права.'
    : !d.canPerms ? 'Нямате право да задавате роли и права – само суперадминистратор или администратор с право „Задава роли и права“.'
    : u.username && !u.canPerms ? (u.username === me.username ? 'Собствените си права не можете да променяте.' : 'Правата на администраторите се задават от суперадминистратор.')
    : 'Отметнатото е разрешено. Без право потребителят не вижда съответните бутони и формуляри и сървърът отказва действието.';
  return {
    el: h('div', { class: 'stack' }, h('p', { class: 'small muted' }, note),
      h('label', { class: 'check' }, custom, h('span', null, h('b', null, 'Подробни права'), ' (иначе – правата по подразбиране за ролята)')), box),
    value: () => (!custom.checked ? null : d.perms.filter(k => state[k]))
  };
}

async function userSessions(username, box) {
  try {
    const { sessions } = await api('sessions.list', { username });
    box.replaceChildren(sessions.length ? h('ul', { class: 'list-plain' }, sessions.map(x => h('li', null,
      h('span', null, h('b', { class: 'mono' }, x.ip || '—'), x.geo ? ' · ' + x.geo : '', h('br'), h('span', { class: 'small muted' }, uaShort(x.agent) + ' · от ' + fmtTime(x.at) + ' · ' + x.how)),
      x.current ? h('span', { class: 'pill ok' }, 'текуща') : h('button', { class: 'btn sm danger', onclick: async () => {
        try { await api('sessions.end', { username, id: x.id }); toast('Сесията е прекратена.'); userSessions(username, box); } catch (e) { toast(e.message); }
      } }, 'Прекрати')))) : h('p', { class: 'empty' }, 'Няма активни сесии.'));
  } catch (e) { box.replaceChildren(h('p', { class: 'err' }, e.message)); }
}

async function usersView() {
  loading();
  try {
    const d = await api('users.list');
    const edit = u => {
      const isNew = !u.username;
      if (!isNew && !u.canEdit) return toast('Администраторите се управляват от суперадминистратор.');
      const roleLocked = !d.canPerms && !isNew;
      const fields = [
        { k: 'username', label: 'Потребителско име', req: true, max: 40, pattern: '[a-z0-9._\\-]{3,40}', disabled: !isNew, hint: 'Малки латински букви, цифри и . _ -' },
        { k: 'name', label: 'Имена', req: true, max: 120 }, { k: 'position', label: 'Длъжност', max: 120 },
        { k: 'email', label: 'Имейл', type: 'email', req: true, max: 200, hint: 'На него идват връзките за парола.' }, { k: 'phone', label: 'Телефон', type: 'tel', max: 40 },
        { k: 'role', label: 'Роля', type: 'select', options: (d.roles.includes(u.role) || !u.role ? d.roles : d.roles.concat([u.role])).map(r => [r, r + ' – ' + ROLE_HINT[r]]), req: true, disabled: roleLocked, hint: roleLocked ? 'Ролята се сменя с право „Задава роли и права“.' : '' },
        { k: 'department', label: 'Отдел', type: 'select', options: [['', '—']].concat(d.departments.map(x => x.name)) },
        { k: 'active', label: 'Активен', type: 'checkbox' }
      ];
      // от името на кои лица води преписки: избира суперадминистраторът; останалите само виждат
      const access = u.access === '*' ? '*' : (u.access || ['zdoi']);
      const personBoxes = h('div', { class: 'perm-grid' }, d.persons.map(p => h('label', { class: 'check' },
        h('input', { type: 'checkbox', name: 'per_' + p.code, checked: access === '*' || access.includes(p.code), disabled: !d.canAccess || access === '*' }),
        h('span', null, p.name + (p.active ? '' : ' (спряно)')))));
      let pe = null;
      const sessBox = h('div', null, h('p', { class: 'loading' }, 'Зареждане…'));
      const extra = h('div', null,
        h('div', { id: 'perm-slot' }),
        h('fieldset', { class: 'mt-16' }, h('legend', null, 'Лица – от чието име води преписки'),
          h('p', { class: 'small muted mb-8' }, access === '*' ? 'Суперадминистраторът има достъп до всички лица.' : d.canAccess ? 'Потребителят вижда и води само преписките на отбелязаните лица.' : 'Достъпът до лицата се дава от суперадминистратор.'),
          personBoxes),
        !isNew ? h('fieldset', { class: 'mt-16' }, h('legend', null, 'Активни сесии'), sessBox,
          h('div', { class: 'actions mt-8' }, h('button', { type: 'button', class: 'btn sm danger', onclick: async () => {
            if (!confirm('Да се прекратят ли всички сесии на ' + u.username + '?')) return;
            try { const r = await api('sessions.end', { username: u.username, all: true }); toast('Прекратени: ' + r.ended + '.'); userSessions(u.username, sessBox); } catch (e) { toast(e.message); }
          } }, 'Прекрати всички'), h('a', { class: 'btn sm', href: '#/logins/' + encodeURIComponent(u.username) }, 'История на входовете'))) : null);
      const dlg = formDialog(isNew ? 'Нов потребител' : 'Потребител ' + u.username, fields, Object.assign({ active: 'Да', role: d.roles.includes('Служител') ? 'Служител' : d.roles[0] }, u), isNew ? 'Създай и изпрати връзка' : 'Запази', async (v, form) => {
        const data = Object.assign({}, v, { isNew, username: isNew ? v.username.toLowerCase() : u.username, role: v.role || u.role });
        if (d.canPerms && u.role !== 'Суперадминистратор' && (isNew || u.canPerms)) data.perms = pe.value();
        if (d.canAccess) data.persons = d.persons.filter(p => form.elements['per_' + p.code].checked).map(p => p.code);
        Object.keys(data).filter(k => k.startsWith('per_') || k === '_custom').forEach(k => delete data[k]);
        const r = await api('users.save', data);
        toast(isNew ? (r.mailed ? 'Потребителят е създаден. Връзката за парола е изпратена.' : 'Потребителят е създаден, но писмото не е изпратено – проверете пощата.') : 'Запазено.');
        boot = await api('bootstrap');
        usersView();
      }, { wide: true, extra });
      const form = (dlg && dlg.querySelector && dlg.querySelector('form')) || document.querySelector('dialog[open] form');
      const roleSel = form && form.elements.role;
      pe = permEditor(d, Object.assign({ perms: {}, canPerms: d.canPerms }, u, isNew ? { canPerms: d.canPerms } : {}), roleSel);
      const slot = (form || document).querySelector('#perm-slot');
      if (slot) slot.replaceWith(h('fieldset', { class: 'mt-16' }, h('legend', null, 'Права по операции'), pe.el));
      if (!isNew) userSessions(u.username, sessBox);
    };
    // докато няма суперадминистратор, администраторът може да стане такъв (лицата и достъпът до тях)
    const self = d.users.find(u => u.username === me.username);
    const becomeSuper = d.noSuper && self && isAdmin() ? h('div', { class: 'card stack mb-12' },
      h('b', null, 'В системата още няма суперадминистратор.'),
      h('p', { class: 'small muted' }, 'Суперадминистраторът управлява лицата, достъпа до тях и правата на администраторите. Вие като администратор можете да станете първият.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async e => {
        if (!confirm('Да станете ли суперадминистратор?')) return;
        e.target.disabled = true;
        try {
          await api('users.save', Object.assign({}, self, { isNew: false, role: 'Суперадминистратор', active: true }));
          me = (await api('me')).me; boot = await api('bootstrap');
          $('app').replaceChildren(); shell(); toast('Вече сте суперадминистратор.'); usersView();
        } catch (ex) { toast(ex.message); e.target.disabled = false; }
      } }, 'Стани суперадминистратор'))) : null;
    const q = h('input', { type: 'search', placeholder: 'Търсене: потребител, име, имейл…', 'aria-label': 'Търсене' });
    const roleF = h('select', { 'aria-label': 'Роля' }, h('option', { value: '' }, 'Всички роли'), ['Суперадминистратор', 'Администратор', 'Служител', 'Наблюдател'].map(r => h('option', { value: r }, r)));
    const body = h('div');
    const permCount = u => Object.keys(u.perms || {}).length;
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      const rows = d.users.filter(u => (!roleF.value || u.role === roleF.value) && (!t || [u.username, u.name, u.email, u.position].join(' ').toLowerCase().includes(t)));
      body.replaceChildren(table(['Потребител', 'Име', 'Роля и права', 'Лица', 'Състояние', 'Последен вход', ''], rows.map(u => h('tr', null,
        h('td', { class: 'mono' }, u.username), h('td', null, u.name, u.position ? h('div', { class: 'small muted' }, u.position) : null, u.department ? h('div', { class: 'small muted' }, u.department) : null),
        h('td', null, h('span', { class: 'pill ' + (u.role === 'Суперадминистратор' ? 'bad' : u.role === 'Администратор' ? 'warn' : u.role === 'Служител' ? 'info' : '') }, u.role),
          h('div', { class: 'small muted', title: Object.keys(u.perms || {}).map(permLabel).join('\n') }, u.role === 'Суперадминистратор' ? 'всички права' : permCount(u) + ' от ' + d.perms.length + ' права' + (u.customPerms ? ' · подробни' : ' · по роля'))),
        h('td', { class: 'small' }, u.access === '*' ? 'всички' : d.persons.filter(p => (u.access || []).includes(p.code)).map(p => p.name).join(', ') || '—'),
        h('td', null, u.active !== 'Да' ? h('span', { class: 'pill' }, 'Спрян') : u.pending ? h('span', { class: 'pill warn' }, 'Без парола') : h('span', { class: 'pill ok' }, 'Активен'), u.twofa ? h('span', { class: 'pill info ml-4' }, '2FA') : null),
        h('td', null, fmtTime(u.lastLogin)),
        h('td', null, h('div', { class: 'actions' }, u.canEdit ? h('button', { class: 'btn sm', onclick: () => edit(u) }, 'Промени') : h('span', { class: 'small muted', title: 'Администраторите се управляват от суперадминистратор.' }, '🔒'),
          u.canEdit && u.active === 'Да' ? h('button', { class: 'btn sm', onclick: async () => { if (!confirm('Да се изпрати ли нова връзка за парола на ' + u.email + '?')) return; try { await api('users.invite', { username: u.username }); toast('Връзката е изпратена.'); } catch (e) { toast(e.message); } } }, 'Връзка за парола') : null,
          can('logins') ? h('a', { class: 'btn sm', href: '#/logins/' + encodeURIComponent(u.username) }, 'Входове') : null))))));
    };
    [q, roleF].forEach(x => x.addEventListener('input', draw));
    setView(head('Потребители и права', h('button', { class: 'btn primary', onclick: () => edit({}) }, 'Нов потребител')), becomeSuper,
      h('div', { class: 'card' }, h('div', { class: 'filters' }, q, roleF), body,
        h('p', { class: 'small muted mt-12' }, 'Паролите не се изпращат. Потребителят задава паролата си сам чрез еднократна връзка, която важи 7 дни. ' +
          (isSuper() ? 'Като суперадминистратор задавате и правата на администраторите.' : 'Администраторите (🔒) се управляват от суперадминистратор.'))));
    draw();
  } catch (e) { failView(e); }
}

/* ---------- дневник и входове ---------- */

async function logView() {
  loading();
  try {
    const { log } = await api('log.list');
    const q = h('input', { type: 'search', placeholder: 'Търсене: потребител, действие, обект…', 'aria-label': 'Търсене' });
    const body = h('div');
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      body.replaceChildren(table(['Време', 'Потребител', 'Действие', 'Обект', 'Подробности', 'IP'], log.filter(r => !t || [r.actor, r.action, r.ref, r.details].join(' ').toLowerCase().includes(t)).slice(0, 500).map(r => h('tr', null,
        h('td', null, fmtTime(r.at)), h('td', null, r.actor), h('td', null, r.action), h('td', null, r.ref || '—'), h('td', { class: 'pre small' }, r.details || ''), h('td', { class: 'mono small' }, r.ip || '')))));
    };
    q.addEventListener('input', draw);
    setView(head('Дневник'), h('div', { class: 'card' }, h('div', { class: 'filters' }, q), body));
    draw();
  } catch (e) { failView(e); }
}

async function loginsView(username, all) {
  loading();
  try {
    const target = username || (all ? '' : me.username);
    const [{ logins }, sess] = await Promise.all([api('logins.list', { username: target }), !all ? api('sessions.list', { username: target }).catch(() => ({ sessions: [] })) : { sessions: [] }]);
    const ok = r => /^Успешен/.test(r.result);
    const ipOf = r => String(r.ip || '').split(' (')[0];
    // първа поява на IP адрес за потребителя (по времето) – отбелязва се като „нов“
    const seen = new Map();
    logins.slice().reverse().forEach(r => { if (ok(r)) { const k = r.username + '|' + ipOf(r); if (!seen.has(k)) seen.set(k, r); } });
    const q = h('input', { type: 'search', placeholder: 'Търсене: потребител, IP, браузър…', 'aria-label': 'Търсене' });
    const res = h('select', { 'aria-label': 'Резултат' }, h('option', { value: '' }, 'Всички опити'), h('option', { value: 'ok' }, 'Успешни'), h('option', { value: 'bad' }, 'Неуспешни'));
    const per = h('select', { 'aria-label': 'Период' }, [['1', 'Последните 24 часа'], ['7', 'Последните 7 дни'], ['30', 'Последните 30 дни'], ['', 'Всички']].map(([v, t]) => h('option', { value: v }, t)));
    per.value = '30';
    const body = h('div'), stats = h('div', { class: 'tiles' });
    const draw = () => {
      const t = q.value.trim().toLowerCase(), from = per.value ? new Date(Date.now() - Number(per.value) * 864e5).toISOString().slice(0, 16) : '';
      const rows = logins.filter(r => (!from || r.at >= from) && (!res.value || (res.value === 'ok') === ok(r)) && (!t || [r.username, r.ip, r.agent, r.result].join(' ').toLowerCase().includes(t)));
      const tile = (n, label, cls) => h('div', { class: 'card tile ' + (cls || '') }, h('b', null, n), h('span', { class: 'muted' }, label));
      const bad = rows.filter(r => !ok(r)).length;
      stats.replaceChildren(tile(rows.filter(ok).length, 'Успешни входа'), tile(bad, 'Неуспешни опита', bad ? 'bad' : ''),
        tile(new Set(rows.map(ipOf).filter(Boolean)).size, 'Различни IP адреса'), all ? tile(new Set(rows.map(r => r.username)).size, 'Потребители') : tile(sess.sessions.length, 'Активни сесии'));
      body.replaceChildren(table(['Време', 'Потребител', 'Резултат', 'IP адрес и място', 'Браузър'], rows.slice(0, 500).map(r => h('tr', null,
        h('td', null, fmtTime(r.at)), h('td', null, all ? h('a', { href: '#/logins/' + encodeURIComponent(r.username) }, r.username) : r.username),
        h('td', null, h('span', { class: 'pill ' + (ok(r) ? 'ok' : 'bad') }, r.result)),
        h('td', null, h('span', { class: 'mono' }, ipOf(r) || '—'), /\(/.test(r.ip || '') ? h('span', { class: 'small muted' }, ' ' + r.ip.slice(r.ip.indexOf('('))) : null,
          ok(r) && seen.get(r.username + '|' + ipOf(r)) === r && logins.some(x => x.username === r.username && ok(x) && x.at < r.at) ? h('span', { class: 'pill warn ml-4', title: 'Първи вход от този адрес' }, 'нов IP') : null),
        h('td', { class: 'small login-agent', title: r.agent || '' }, uaShort(r.agent)))), 'Няма входове по тези условия.'));
    };
    [q, res, per].forEach(x => x.addEventListener('input', draw));
    const sessBox = h('div');
    const title = all ? 'Входове и сесии – всички потребители' : username && username !== me.username ? 'Входове – ' + userName(username) + ' (' + username + ')' : 'Моите входове и сесии';
    setView(head(title, all || (username && username !== me.username) ? h('a', { class: 'btn', href: '#/users' }, 'Потребители') : null),
      stats,
      !all ? h('section', { class: 'card stack mb-16' }, h('div', { class: 'head m-0' }, h('h2', null, 'Активни сесии'),
        h('button', { class: 'btn sm danger', onclick: async () => {
          if (!confirm('Да се прекратят ли всички други сесии?')) return;
          try { const r = await api('sessions.end', { username: target, all: true }); toast('Прекратени: ' + r.ended + '.'); userSessions(target, sessBox); } catch (e) { toast(e.message); }
        } }, target === me.username ? 'Прекрати всички други' : 'Прекрати всички')), sessBox,
        h('p', { class: 'small muted' }, 'При вход от IP адрес, от който не сте влизали досега, получавате писмо. Ако не разпознавате сесия – прекратете я и сменете паролата си.')) : null,
      h('div', { class: 'card' }, h('div', { class: 'filters' }, q, res, per), body));
    if (!all) userSessions(target, sessBox);
    draw();
  } catch (e) { failView(e); }
}

/* ---------- календар ---------- */

const MONTHS = ['Януари', 'Февруари', 'Март', 'Април', 'Май', 'Юни', 'Юли', 'Август', 'Септември', 'Октомври', 'Ноември', 'Декември'];
const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
async function calendarView(query) {
  loading();
  let d;
  try { d = await api('calendar', { person: curCode || '' }); } catch (e) { return failView(e); }
  const q = new URLSearchParams(query || ''), today = todayIso();
  let ym = /^\d{4}-\d{2}$/.test(q.get('m') || '') ? q.get('m') : today.slice(0, 7), sel = /^\d{4}-\d{2}-\d{2}$/.test(q.get('d') || '') ? q.get('d') : today;
  const byDay = {};
  d.events.forEach(e => { (byDay[e.date] = byDay[e.date] || []).push(e); });
  const grid = h('div', { class: 'cal-grid' }), side = h('section', { class: 'card stack cal-day' }), title = h('h2', { class: 'm-0' });
  const kindF = h('select', { 'aria-label': 'Вид' }, h('option', { value: '' }, 'Всички събития'), [...new Set(d.events.map(e => e.kind))].map(k => h('option', { value: k }, k)));
  const shown = list => (list || []).filter(e => !kindF.value || e.kind === kindF.value);
  const pad = n => String(n).padStart(2, '0');
  const evLine = e => h('a', { class: 'cal-ev ' + e.cls, href: e.href, title: e.kind + ' · ' + e.ref + (e.text ? ' – ' + e.text : '') }, e.time ? h('b', null, e.time + ' ') : null, e.ref);
  const drawDay = () => {
    const info = dayInfo(sel), list = shown(byDay[sel]);
    side.replaceChildren(h('h2', null, new Date(sel + 'T12:00:00').toLocaleDateString('bg-BG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
      h('span', { class: 'pill ' + (info.workday ? 'ok' : 'warn') }, info.workday ? 'работен ден' : info.label),
      list.length ? h('ul', { class: 'list-plain cal-list' }, list.map(e => h('li', null, h('span', null, h('span', { class: 'pill ' + e.cls }, e.kind), h('br'), h('a', { href: e.href }, h('b', { class: 'mono' }, e.ref)), e.text ? ' – ' + e.text : ''), e.time ? h('b', null, e.time) : null)))
        : h('p', { class: 'empty' }, 'Няма срокове и събития.'),
      h('p', { class: 'small muted' }, 'Сроковете са изчислени по ЗДОИ и АПК: ако последният ден е неработен, срокът изтича в първия следващ работен ден.'));
  };
  const draw = () => {
    const [y, mo] = ym.split('-').map(Number);
    title.textContent = MONTHS[mo - 1] + ' ' + y;
    const first = new Date(Date.UTC(y, mo - 1, 1)), startWd = (first.getUTCDay() + 6) % 7, days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < startWd; i++) cells.push(h('div', { class: 'cal-cell empty' }));
    let work = 0;
    for (let n = 1; n <= days; n++) {
      const iso = y + '-' + pad(mo) + '-' + pad(n), info = dayInfo(iso), list = shown(byDay[iso]);
      if (info.workday) work++;
      cells.push(h('div', { class: 'cal-cell' + (info.workday ? '' : ' off') + (iso === today ? ' today' : '') + (iso === sel ? ' sel' : ''), tabindex: 0, role: 'button', 'aria-label': fmtDate(iso) + ', ' + (info.workday ? 'работен ден' : info.label) + (list.length ? ', ' + list.length + ' събития' : ''),
        onclick: () => { sel = iso; draw(); }, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel = iso; draw(); } } },
        h('div', { class: 'cal-num' }, h('b', null, n), /^(празник|почивен)/.test(info.label) ? h('small', { class: 'cal-hol', title: info.label }, info.label.replace(/^празник: /, '')) : null),
        list.slice(0, 3).map(evLine), list.length > 3 ? h('small', { class: 'muted' }, '+' + (list.length - 3) + ' още') : null));
    }
    grid.replaceChildren(...WD.map((w, i) => h('div', { class: 'cal-wd' + (i > 4 ? ' off' : '') }, w)), ...cells);
    stat.textContent = work + ' работни дни · ' + d.events.filter(e => e.date.startsWith(ym)).length + ' събития през месеца';
    history.replaceState(null, '', '#/calendar?m=' + ym + '&d=' + sel);
    drawDay();
  };
  const stat = h('span', { class: 'small muted' });
  const move = k => { const [y, mo] = ym.split('-').map(Number), t = new Date(Date.UTC(y, mo - 1 + k, 1)); ym = t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1); sel = ym + '-01'; draw(); };
  kindF.addEventListener('input', draw);
  const upcoming = d.events.filter(e => e.date >= today).slice(0, 8);
  setView(head('Календар', h('button', { class: 'btn', onclick: () => { ym = today.slice(0, 7); sel = today; draw(); } }, 'Днес')),
    h('div', { class: 'cal-wrap' },
      h('section', { class: 'card stack' },
        h('div', { class: 'cal-head' }, h('button', { class: 'icon-btn', 'aria-label': 'Предишен месец', onclick: () => move(-1) }, '‹'), title, h('button', { class: 'icon-btn', 'aria-label': 'Следващ месец', onclick: () => move(1) }, '›'), stat, h('span', { class: 'grow' }), kindF),
        grid,
        h('div', { class: 'cal-legend small muted' }, h('span', { class: 'cal-ev bad' }, 'изтекъл / обжалване'), h('span', { class: 'cal-ev warn' }, 'срок'), h('span', { class: 'cal-ev info' }, 'заседание / насрочено писмо'), h('span', { class: 'cal-key off' }, 'неработен ден'))),
      h('div', { class: 'stack' }, side,
        h('section', { class: 'card stack' }, h('h2', null, 'Предстоящи'), upcoming.length ? h('ul', { class: 'list-plain' }, upcoming.map(e => h('li', null, h('span', null, h('a', { href: e.href }, e.ref), h('br'), h('span', { class: 'small muted' }, e.kind)), h('b', { class: e.cls === 'bad' ? 'due-bad' : '' }, fmtDate(e.date) + (e.time ? ' ' + e.time : ''))))) : h('p', { class: 'empty' }, 'Няма предстоящи срокове.')))));
  draw();
}

/* ---------- профил ---------- */

async function profileView() {
  loading();
  let m;
  try { m = (await api('me')).me; } catch (e) { return failView(e); }
  const pw = h('form', null, h('div', { class: 'stack' },
    field({ k: 'current', label: 'Текуща парола', type: 'password', req: true, autocomplete: 'current-password' }),
    field({ k: 'next', label: 'Нова парола', type: 'password', req: true, autocomplete: 'new-password', hint: 'Поне 12 знака, с букви и цифри.' }),
    field({ k: 'again', label: 'Повторете новата парола', type: 'password', req: true, autocomplete: 'new-password' })),
  h('button', { type: 'submit', class: 'btn primary block' }, 'Смени паролата'));
  onSubmit(pw, async v => {
    const weak = strongEnough(v.next);
    if (weak) throw new Error(weak);
    if (v.next !== v.again) throw new Error('Новите пароли не съвпадат.');
    await api('password', { current: await preHash(m.username, v.current), next: await preHash(m.username, v.next) });
    pw.reset(); toast('Паролата е сменена.');
  });

  const twofa = h('form', null, h('p', { class: 'small muted mb-10' }, m.twofa
    ? 'Включен: при вход след паролата въвеждате код от 8 цифри, изпратен на ' + (m.email || 'имейла ви') + '.'
    : 'При включване след паролата ще въвеждате код, изпратен на ' + (m.email || 'имейла ви') + '.'),
  field({ k: 'password', label: 'Парола за потвърждение', type: 'password', req: true, autocomplete: 'current-password' }),
  h('button', { type: 'submit', class: 'btn block' + (m.twofa ? ' danger' : ' primary') }, m.twofa ? 'Изключи двуфакторния вход' : 'Включи двуфакторния вход'));
  onSubmit(twofa, async v => {
    const hash = await preHash(m.username, v.password);
    if (m.twofa) { await api('twofa.start', { hash, enable: false }); toast('Двуфакторният вход е изключен.'); return profileView(); }
    const st = await api('twofa.start', { hash });
    formDialog('Потвърдете кода', [{ k: 'code', label: 'Код от имейла', req: true, pattern: '\\d{8}', max: 8, full: true }], {}, 'Потвърди', async c => {
      await api('twofa.confirm', { ticket: st.ticket, code: c.code }); toast('Двуфакторният вход е включен.'); profileView();
    });
  });

  const n = m.notify;
  const notify = h('form', null, h('div', { class: 'stack' },
    field({ k: 'assign', label: 'Когато ме определят за отговорник', type: 'checkbox' }, n.assign),
    field({ k: 'deadline', label: 'Напомняния за срокове (3 дни, 1 ден, в деня и ден след)', type: 'checkbox' }, n.deadline),
    field({ k: 'mail', label: 'Входящо писмо по моя преписка', type: 'checkbox' }, n.mail),
    field({ k: 'status', label: 'Промяна на статуса', type: 'checkbox' }, n.status),
    field({ k: 'comments', label: 'Нов коментар', type: 'checkbox' }, n.comments),
    me.perms.casesAll ? field({ k: 'all', label: 'Статус и коментари за всички преписки, не само моите', type: 'checkbox' }, n.all) : null),
  h('button', { type: 'submit', class: 'btn block' }, 'Запази известията'));
  onSubmit(notify, async v => { await api('notify.save', v); toast('Известията са запазени.'); });

  // продължителност на сесията без действие: от 30 минути до 3 часа
  const minLabel = n => n < 60 ? n + ' минути' : n % 60 ? Math.floor(n / 60) + ' ч. и ' + (n % 60) + ' мин.' : n / 60 + (n === 60 ? ' час' : ' часа');
  const sess = h('form', null, h('p', { class: 'small muted mb-10' }, 'След толкова време без действие системата ви изписва. По подразбиране – 30 минути.'),
    field({ k: 'minutes', label: 'Изход след бездействие', type: 'select', options: (m.sessionChoices || [30]).map(n => [String(n), minLabel(n) + (n === 30 ? ' (по подразбиране)' : '')]), req: true }, String(m.sessionMin || 30)),
    h('button', { type: 'submit', class: 'btn block' }, 'Запази'));
  onSubmit(sess, async v => {
    const r = await api('session.save', { minutes: Number(v.minutes) });
    me.sessionMin = r.sessionMin; expAt = r.session;
    toast('Сесията вече е ' + minLabel(r.sessionMin) + '.');
  });

  const linkedCard = h('section', { class: 'card stack' }, h('h2', null, 'Вход с външни профили'), h('p', { class: 'loading' }, 'Зареждане…'));

  // лицето (организацията), от чието име действа потребителят
  const persons = personsAll();
  const defSel = h('select', { name: 'def', 'aria-label': 'При отваряне' }, h('option', { value: '' }, 'Питай при всяко отваряне'), persons.map(p => h('option', { value: p.code }, p.name)));
  defSel.value = (boot && boot.defaultPerson) || '';
  const personCard = h('section', { class: 'card stack' }, h('h2', null, 'Лице, от чието име действате'),
    h('p', { class: 'small muted' }, 'Таблото, заявленията, регистрите, пощата и календарът се показват за избраното лице; новите заявления са с неговата бланка, номерация и поща.'),
    h('div', { class: 'person-pick' }, persons.map(p => h('label', { class: 'person-opt' + (p.code === curCode ? ' on' : '') + (p.active ? '' : ' off') },
      h('input', { type: 'radio', name: 'cur', value: p.code, checked: p.code === curCode, onchange: () => {
        setCur(p.code); $('app').replaceChildren(); shell(); profileView(); toast('Действате от името на ' + p.name + '.');
      } }),
      h('span', { class: 'person-ico' }, icon('building')),
      h('span', null, h('b', null, p.name), h('small', { class: 'muted' }, [p.brand && p.brand !== p.name ? p.brand : '', p.eik ? 'ЕИК ' + p.eik : '', p.active ? '' : 'спряно'].filter(Boolean).join(' · ') || ' '))))),
    persons.length > 1 ? h('label', { class: 'field' }, h('span', null, 'При отваряне на системата'), defSel) : null,
    persons.length > 1 ? h('button', { class: 'btn block', onclick: async () => {
      try { const r = await api('profile.person', { code: defSel.value }); boot.defaultPerson = r.defaultPerson; toast(r.defaultPerson ? 'Системата ще се отваря с ' + personName(r.defaultPerson) + '.' : 'При отваряне ще избирате лицето.'); } catch (e) { toast(e.message); }
    } }, 'Запази') : null);

  // правата – по групи, само за преглед
  const permsCard = h('section', { class: 'card stack' }, h('h2', null, 'Моите права'),
    h('p', { class: 'small muted' }, 'Роля: ' + m.role + '. Правата се дават от администратор' + (isAdmin() ? ' (на администраторите – от суперадминистратор)' : '') + '.'),
    ((boot && boot.permGroups) || []).map(([g, list]) => {
      const mine = list.filter(([k]) => m.perms[k]);
      return mine.length ? h('div', null, h('div', { class: 'small muted' }, g), h('ul', { class: 'perm-mine' }, mine.map(([, label]) => h('li', null, '✓ ' + label)))) : null;
    }));
  setView(head('Моят профил'), h('div', { class: 'grid2' },
    h('section', { class: 'card stack' }, h('h2', null, 'Данни'), kv([['Потребител', m.username], ['Име', m.name], ['Роля', m.role], ['Длъжност', m.position], ['Отдел', m.department], ['Имейл', m.email], ['Телефон', m.phone],
      ['Лица', personsAll().map(p => p.name).join('; ')]]), h('p', { class: 'small muted' }, 'Данните се променят от администратор.'), h('a', { href: '#/logins' }, 'Моите входове и активни сесии')),
    personCard,
    permsCard,
    h('section', { class: 'card stack' }, h('h2', null, 'Парола'), pw),
    h('section', { class: 'card stack' }, h('h2', null, 'Двуфакторен вход'), twofa),
    h('section', { class: 'card stack' }, h('h2', null, 'Известия по имейл'), notify),
    h('section', { class: 'card stack' }, h('h2', null, 'Продължителност на сесията'), sess),
    linkedCard));
  // свързани профили за вход
  api('oauth.providers').then(r => {
    const linked = m.linked || {};
    const ids = new Set(r.providers.map(p => p.id).concat(Object.keys(linked)));
    const label = id => (r.providers.find(p => p.id === id) || {}).label || ({ google: 'Google', microsoft: 'Microsoft', discord: 'Discord', kep: 'КЕП' })[id] || id;
    linkedCard.replaceChildren(h('h2', null, 'Вход с външни профили'),
      h('p', { class: 'small muted' }, 'Свържете профил, за да влизате с него без парола. Двуфакторният вход (ако е включен) важи и тук.'),
      ids.size ? h('ul', { class: 'list-plain' }, [...ids].map(id => {
        const x = linked[id], on = r.providers.some(p => p.id === id);
        return h('li', null, h('span', { class: 'oauth-line' }, providerIcon(id), h('span', null, h('b', null, label(id)), h('br'),
          h('span', { class: 'small muted' }, x ? 'свързан' + (id === 'kep' && x.name ? ' – ' + x.name + (x.email ? ' (' + x.email + ')' : '') : x.email ? ' – ' + x.email : '') + (x.at ? ' · ' + fmtTime(x.at) : '') : on ? 'не е свързан' : 'изключен от администратора'))),
          x ? h('button', { class: 'btn sm', onclick: async () => {
            if (!confirm('Да се премахне входът с ' + label(id) + '?')) return;
            try { await api('oauth.unlink', { provider: id }); toast('Премахнато.'); profileView(); } catch (e) { toast(e.message); }
          } }, 'Премахни') : on ? (id === 'kep' ? h('button', { class: 'btn sm primary', onclick: () => kepFlow('link') }, 'Свържи') : h('a', { class: 'btn sm primary', href: '/api/oauth/' + id + '/start?link=1' }, 'Свържи')) : null);
      })) : h('p', { class: 'empty' }, 'Външният вход е изключен.'));
  }).catch(e => linkedCard.replaceChildren(h('p', { class: 'err' }, e.message)));
}

/* ---------- калкулатор на срокове (работи и без вход) ---------- */

function calcView() {
  const form = h('form', null, h('div', { class: 'form-grid' },
    field({ k: 'regDate', label: 'Дата на регистриране', type: 'date', req: true }, todayIso()),
    field({ k: 'ext30', label: 'Удължаване по чл. 30 (дни)', type: 'number', min: 0, maxValue: 10 }, ''),
    field({ k: 'ext31', label: 'Удължаване по чл. 31 (дни)', type: 'number', min: 0, maxValue: 14 }, ''),
    field({ k: 'clarifyAsked', label: 'Поискано уточняване', type: 'date' }, ''),
    field({ k: 'clarifyGot', label: 'Получено уточняване', type: 'date' }, ''),
    field({ k: 'served', label: 'Връчено решение', type: 'date' }, '')));
  const out = h('div', { class: 'calc-out' });
  const row = (label, iso, extra) => h('div', null, h('div', { class: 'small muted' }, label), h('b', { class: dueClass(daysBetween(todayIso(), iso)) }, fmtDate(iso) + ' · ' + dueText(daysBetween(todayIso(), iso))), extra ? h('div', { class: 'small muted' }, extra) : null);
  const draw = () => {
    const v = formValues(form), items = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(v.regDate)) {
      const e30 = Math.min(10, Math.max(0, Number(v.ext30) || 0)), e31 = Math.min(14, Math.max(0, Number(v.ext31) || 0));
      if (v.clarifyAsked && !v.clarifyGot) items.push(row('Срок за уточняване от заявителя (чл. 29, ал. 2) – 30 дни', term(v.clarifyAsked, 30)));
      const base = v.clarifyGot || v.regDate, due = term(base, 14 + e30 + e31);
      items.push(row('Срок за решение (чл. 28, ал. 1' + (e30 ? '; чл. 30' : '') + (e31 ? '; чл. 31' : '') + ')', due, 'Броят се от ' + (v.clarifyGot ? 'получаване на уточнението' : 'регистрирането') + '; ако изтича в неработен ден, се мести на следващия работен.'));
      items.push(row('Съгласие от трето лице се иска до (чл. 31, ал. 2)', term(v.regDate, 7)));
      items.push(row('Мълчалив отказ може да се обжалва до (чл. 149, ал. 2 АПК)', termMonths(due, 2)));
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(v.served)) items.push(row('Срок за обжалване на решението (14 дни, чл. 149, ал. 1 АПК)', term(v.served, 14)));
    out.replaceChildren(...items);
  };
  form.addEventListener('input', draw);
  const card = h('div', { class: 'card' }, form, out,
    h('p', { class: 'small muted mt-14' }, 'Отчитат се официалните празници и почивните дни по чл. 154 КТ. Изчислението е помощно и не е правна консултация.'));
  if (me) setView(head('Калкулатор на срокове'), card);
  else gate('Калкулатор на срокове', 'Срокове по ЗДОИ и АПК.', card, h('div', { class: 'gate-links' }, h('a', { href: '#/login' }, 'Към входа')));
  if (!me) document.querySelector('.gate-card').classList.add('wide');
  draw();
}

/* ---------- общи: регистрация (ЕИК по ТЗ / код по БУЛСТАТ по ЗРБ), адрес от списък ---------- */

const REGISTRY_TR = 'https://portal.registryagency.bg/CR/bg/Reports/VerificationPersonOrg';
const REGISTRY_BULSTAT = 'https://reports.bulstat.bg/bulstat-ireports/report.jsf?x_rpt=rpt2';
const capital = t => t.charAt(0).toUpperCase() + t.slice(1);

/* полетата на страна (адресат, заявител, субект) с представка: етикетът на ЕИК/БУЛСТАТ следва регистрацията, а адресът има избор от списък */
/* организации с ролите на лицето в тях (Търговски регистър и регистър на ЮЛНЦ) */
function orgList(orgs) {
  return orgs.length ? h('ul', { class: 'list-plain' }, orgs.map(o => h('li', null,
    h('span', null, h('a', { href: o.link, target: '_blank', rel: 'noopener noreferrer' }, o.name), o.flag ? h('span', { class: 'pill bad ml-4' }, o.flag) : null, h('br'),
      h('span', { class: 'small muted' }, o.roles.join(' · '))),
    h('a', { class: 'btn sm', href: '#/verify?eik=' + o.uic, title: 'Проверка на организацията' }, o.uic)))) : h('p', { class: 'empty' }, 'Няма участия.');
}

/* резултатът от проверката в Търговския регистър и регистър БУЛСТАТ */
function verifyResult(r) {
  const card = (title, x, body) => h('section', { class: 'card stack verify-card' },
    h('div', { class: 'head m-0' }, h('h2', null, title), x.error ? h('span', { class: 'pill warn' }, 'недостъпен') : x.found ? h('span', { class: 'pill ' + (x.closed || x.active === false ? 'bad' : 'ok') }, x.status || x.state || 'вписан (без отбелязано състояние)') : h('span', { class: 'pill' }, 'няма запис')),
    x.error ? h('p', { class: 'warn-text small' }, x.error) : x.found ? body : h('p', { class: 'muted small' }, 'Няма субект с този код в този регистър.'),
    x.link ? h('a', { class: 'small', href: x.link, target: '_blank', rel: 'noopener noreferrer' }, 'Отвори справката в регистъра') : null);
  const c = r.cr || {}, b = r.bulstat || {};
  const lines = v => String(v || '').split('\n').filter(Boolean).map(t => h('div', null, t));
  return h('div', { class: 'stack' },
    (r.warnings || []).length ? h('div', { class: 'warnbox' }, r.warnings.map(w => h('div', null, '⚠ ' + w))) : null,
    h('div', { class: 'grid2' },
      card('Търговски регистър и регистър на ЮЛНЦ', c, kv([['Наименование', c.fullName || c.name], ['Правна форма', c.legalForm], ['Седалище и адрес', c.seat], ['Имейл', c.email],
        ['Представители и органи', lines(c.representatives)], ['Начин на представляване', c.representation], ['Едноличен собственик', c.owner], ['Особени обстоятелства', (c.flags || []).join('; ')]])),
      card('Регистър БУЛСТАТ', b, kv([['Наименование', b.name], ['Правна форма', b.legalForm], ['Състояние', b.state], ['Адрес', b.address], ['Комуникации', b.contacts],
        ['Управление', b.management], ['Принадлежност', b.parent], ['Собственост', b.owners], ['Дейност', b.activity]]))),
    r.participation ? h('section', { class: 'card stack' }, h('h2', null, 'Участие в други организации (' + r.participation.length + ')'),
      h('p', { class: 'small muted' }, 'Дружества и сдружения, в които организацията е собственик, съдружник, член на органите на управление или контрол – по Търговския регистър и регистъра на ЮЛНЦ.'),
      r.participationError ? h('p', { class: 'warn-text small' }, r.participationError) : orgList(r.participation)) : null,
    h('p', { class: 'small muted' }, 'Проверено ' + fmtTime(r.at) + (r.cached ? ' (от последните 12 часа)' : '') + '. Източници: Агенция по вписванията и регистър БУЛСТАТ.'));
}

/* проверка по ЕИК/БУЛСТАТ; fill(данни) – попълва формата, от която е отворена */
async function verifyDialog(eik, fill) {
  const box = h('div', null, h('p', { class: 'loading' }, 'Проверка в Търговския регистър и регистър БУЛСТАТ…'));
  const dlg = dialog('Проверка на ' + eik, h('div', { class: 'stack' }, box,
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Затвори'))), { wide: true });
  try {
    const r = await api('verify.eik', { eik });
    const c = r.cr || {}, b = r.bulstat || {};
    const data = c.found || b.found ? {
      name: (c.fullName || c.name || b.name || '').replace(/^"([^"]+)"\s*(.*)$/, (m, n, f) => (f ? n + ' ' + f : n)),
      regBasis: c.found ? boot.lists.regBasis[1] : boot.lists.regBasis[2], address: c.seat || b.address || '', email: c.email || '',
      rep: ((c.representatives || b.management || '').split('\n')[0] || '').replace(/, Държава: .*$/, '').replace(/\s*-\s*[^-]+$/, '')
    } : null;
    box.replaceChildren(verifyResult(r), fill && data ? h('div', { class: 'actions mt-8' }, h('button', { type: 'button', class: 'btn primary', onclick: () => { fill(data); dlg.close(); toast('Данните са попълнени от регистъра – проверете ги.'); } }, 'Попълни данните от регистъра'),
      h('span', { class: 'small muted' }, 'Попълва наименованието, вида регистрация, адреса' + (data.email ? ', имейла' : '') + ' и представителя (ако има такова поле).')) : null);
  } catch (e) { box.replaceChildren(h('p', { class: 'err' }, e.message)); }
}

/* страница „Проверки в регистрите“: организация по ЕИК/БУЛСТАТ или физическо лице по име и ЕГН */
function verifyView(query) {
  const q = new URLSearchParams(query || '');
  const mode = q.get('mode') === 'person' ? 'person' : 'org';
  const tabs = h('div', { class: 'seg mb-12' }, [['org', 'Организация (ЕИК/БУЛСТАТ)'], ['person', 'Физическо лице (име, ЕГН)']].map(([k, label]) =>
    h('button', { class: 'btn sm' + (k === mode ? ' primary' : ''), onclick: () => { location.hash = '#/verify' + (k === 'person' ? '?mode=person' : ''); } }, label)));
  const out = h('div');
  if (mode === 'person') {
    const name = h('input', { type: 'text', maxlength: 120, placeholder: 'Име (поне собствено и фамилно)', 'aria-label': 'Име', autocomplete: 'off' });
    const egn = h('input', { type: 'password', inputmode: 'numeric', maxlength: 10, placeholder: 'ЕГН (по желание)', 'aria-label': 'ЕГН', autocomplete: 'off' });
    const birth = h('input', { type: 'date', min: '1900-01-01', max: todayIso(), 'aria-label': 'Дата на раждане (по желание)', title: 'Дата на раждане (по желание) – стеснява търсенето в регистър БУЛСТАТ' });
    const hist = h('input', { type: 'checkbox' });
    const run = async () => {
      out.replaceChildren(h('p', { class: 'loading' }, 'Търсене в Търговския регистър, регистъра на ЮЛНЦ и регистър БУЛСТАТ…'));
      try {
        const r = await api('verify.person', { name: name.value, egn: egn.value, birth: birth.value, history: hist.checked });
        const b = r.bulstat, bp = r.bulstatPeople || { people: [], total: 0 };
        const relRow = x => h('tr', { class: x.active ? '' : 'muted' },
          h('td', null, x.eik ? h('a', { class: 'btn sm', href: '#/verify?eik=' + x.eik, title: 'Проверка на организацията' }, x.eik) : '—'),
          h('td', null, x.name, x.legalForm ? h('div', { class: 'small muted' }, x.legalForm) : null),
          h('td', null, [x.position, x.role].filter(Boolean).join(' · ') || '—', x.body ? h('div', { class: 'small muted' }, x.body) : null),
          h('td', { class: 'nowrap' }, (x.from || '…') + ' – ' + (x.to || 'досега')),
          h('td', null, h('span', { class: 'pill ' + (x.active ? 'ok' : '') }, x.active ? 'настоящо' : 'минало')));
        const shownRel = g => g.rows.filter(x => x.active || hist.checked);
        const withRel = bp.people.filter(p => p.groups.some(g => shownRel(g).length)), noRel = bp.people.filter(p => !withRel.includes(p));
        const bsCard = h('section', { class: 'card stack' },
          h('div', { class: 'head m-0' }, h('h2', null, 'Регистър БУЛСТАТ – свързаност на физическо лице'), bp.error ? h('span', { class: 'pill warn' }, 'недостъпен') : h('span', { class: 'pill' }, bp.total + ' съвпадения')),
          bp.error ? h('p', { class: 'warn-text small' }, bp.error) : null,
          bp.total > bp.people.length ? h('p', { class: 'small muted' }, 'Проверени са първите ' + bp.people.length + ' – добавете дата на раждане или ЕГН, за да стесните търсенето.') : null,
          withRel.map(p => h('div', { class: 'stack person-hit' },
            h('div', null, h('b', null, p.name), h('span', { class: 'small muted' }, [p.birthDate ? ' · роден(а) ' + p.birthDate : '', p.code ? ' · код по БУЛСТАТ ' + p.code : '', p.citizenship ? ' · ' + p.citizenship : ''].join('')),
              ' ', h('a', { class: 'small', href: p.link, target: '_blank', rel: 'noopener noreferrer' }, 'справката в БУЛСТАТ')),
            p.groups.filter(g => shownRel(g).length).map(g => h('div', { class: 'stack' }, h('div', { class: 'small muted' }, g.title),
              table(['Код', 'Субект', 'Длъжност / роля', 'Период', ''], shownRel(g).map(relRow)))))),
          noRel.length ? h('p', { class: 'small muted' }, (withRel.length ? 'Още ' : '') + noRel.length + (noRel.length === 1 ? ' лице' : ' лица') + ' без ' + (hist.checked ? '' : 'настоящо ') + 'участие в управлението на субекти: ',
            noRel.map((p, i) => [i ? ', ' : '', h('a', { href: p.link, target: '_blank', rel: 'noopener noreferrer' }, p.name + (p.code ? ' (' + p.code + ')' : ''))])) : null,
          !bp.error && !bp.total ? h('p', { class: 'empty' }, 'Няма лице с тези данни в регистър БУЛСТАТ.') : null);
        out.replaceChildren(h('div', { class: 'stack' },
          r.crError ? h('p', { class: 'warnbox' }, r.crError) : null,
          h('section', { class: 'card stack' }, h('div', { class: 'head m-0' }, h('h2', null, 'Търговски регистър и регистър на ЮЛНЦ'), h('span', { class: 'pill' }, r.total + ' съвпадения')),
            r.total > r.shown ? h('p', { class: 'small muted' }, 'Показани са първите ' + r.shown + ' – уточнете името или въведете ЕГН.') : null,
            r.people.length ? r.people.map(x => h('div', { class: 'stack person-hit' }, h('b', null, x.name), x.error ? h('p', { class: 'warn-text small' }, x.error) : orgList(x.orgs)))
              : h('p', { class: 'empty' }, 'Няма вписано лице с тези данни.')),
          bsCard,
          b ? h('section', { class: 'card stack' }, h('div', { class: 'head m-0' }, h('h2', null, 'Регистър БУЛСТАТ – самостоятелно вписване (по ЕГН)'), h('span', { class: 'pill ' + (b.found ? 'ok' : '') }, b.found ? (b.state || 'вписано') : 'няма запис')),
            b.error ? h('p', { class: 'warn-text small' }, b.error) : b.found ? kv([['Наименование', b.name], ['Правна форма', b.legalForm], ['Състояние', b.state], ['Адрес', b.address], ['Дейност', b.activity]])
              : h('p', { class: 'muted small' }, 'Лицето не е вписано самостоятелно в регистър БУЛСТАТ (напр. като свободна професия или занаятчия).')) : null,
          h('p', { class: 'small muted' }, 'Проверено ' + fmtTime(r.at) + (r.history ? ', включително заличените обстоятелства' : '') + '. ЕГН се изпраща само към регистрите и не се записва в системата.')));
      } catch (e) { out.replaceChildren(h('p', { class: 'err' }, e.message)); }
    };
    [name, egn, birth].forEach(x => x.addEventListener('keydown', e => { if (e.key === 'Enter') run(); }));
    setView(head('Проверки в регистрите'), tabs,
      h('p', { class: 'small muted mb-12' }, 'В кои дружества и сдружения участва лицето – като управител, представител, съдружник, едноличен собственик, член на органите (Търговски регистър и регистър на ЮЛНЦ), и в управлението на кои субекти е вписано в регистър БУЛСТАТ (училища, читалища, сдружения, клонове и др.), с длъжност и период. Търсенето по име може да върне съименници – датата на раждане или ЕГН ги разграничава.'),
      h('div', { class: 'card stack mb-16' }, h('div', { class: 'filters m-0' }, name, birth, egn, h('button', { class: 'btn primary', onclick: run }, 'Търси')),
        h('label', { class: 'check' }, hist, h('span', null, 'Включи и минали участия (заличени обстоятелства)'))),
      out);
    return;
  }
  const input = h('input', { type: 'text', maxlength: 120, placeholder: 'ЕИК/код по БУЛСТАТ (9 или 13 цифри) или наименование', 'aria-label': 'ЕИК/БУЛСТАТ или наименование', value: q.get('eik') || q.get('name') || '' });
  const run = async fresh => {
    const v = input.value.trim(), eik = v.replace(/[\s-]/g, '');
    out.replaceChildren(h('p', { class: 'loading' }, 'Проверка…'));
    if (/^\d+$/.test(eik)) {
      if (!/^(\d{9}|\d{13})$/.test(eik)) { out.replaceChildren(); return toast('ЕИК/БУЛСТАТ е от 9 или 13 цифри.'); }
      history.replaceState(null, '', '#/verify?eik=' + eik);
      try { out.replaceChildren(verifyResult(await api('verify.eik', { eik, fresh: !!fresh }))); } catch (e) { out.replaceChildren(h('p', { class: 'err' }, e.message)); }
      return;
    }
    if (v.replace(/[^\p{L}\p{N}]/gu, '').length < 3) { out.replaceChildren(); return toast('Въведете поне 3 букви от наименованието.'); }
    history.replaceState(null, '', '#/verify?name=' + encodeURIComponent(v));
    try { out.replaceChildren(nameResult(await api('verify.name', { name: v, fresh: !!fresh }))); } catch (e) { out.replaceChildren(h('p', { class: 'err' }, e.message)); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  setView(head('Проверки в регистрите'), tabs,
    h('p', { class: 'small muted mb-12' }, 'Актуално състояние в Търговския регистър и регистъра на ЮЛНЦ (Агенция по вписванията) и в регистър БУЛСТАТ: наименование, правна форма, седалище и адрес, имейл, представители, състояние (вписан, заличен, в ликвидация, несъстоятелност), принадлежност и участие в други организации. Търси се по ЕИК/БУЛСТАТ или по част от наименованието – от списъка изберете организацията за пълна проверка.'),
    h('div', { class: 'card stack mb-16' }, h('div', { class: 'filters m-0' }, input, h('button', { class: 'btn primary', onclick: () => run() }, 'Провери'), h('button', { class: 'btn', title: 'Без запомнения резултат', onclick: () => run(true) }, 'Провери наново'))),
    out);
  if (input.value) run();
}

/* резултат от търсене по наименование: съвпаденията в ТР/ЮЛНЦ и в БУЛСТАТ, всяко – към проверката по ЕИК */
function nameResult(r) {
  const card = (title, x, more) => h('section', { class: 'card stack' },
    h('div', { class: 'head m-0' }, h('h2', null, title), x.error ? h('span', { class: 'pill warn' }, 'недостъпен') : h('span', { class: 'pill' }, x.total + ' съвпадения')),
    x.error ? h('p', { class: 'warn-text small' }, x.error) : (x.items || []).length ? h('div', { class: 'stack' },
      x.total > x.items.length ? h('p', { class: 'small muted' }, 'Показани са първите ' + x.items.length + ' – уточнете наименованието' + more + '.') : null,
      h('ul', { class: 'list-plain' }, x.items.map(o => h('li', null,
        h('span', null, h('a', { href: o.link, target: '_blank', rel: 'noopener noreferrer' }, o.name), o.old ? h('span', { class: 'small muted' }, ' · стар код ' + o.old) : null),
        o.eik ? h('a', { class: 'btn sm', href: '#/verify?eik=' + o.eik, title: 'Проверка на организацията' }, o.eik) : h('span', { class: 'small muted' }, 'без код')))))
      : h('p', { class: 'empty' }, 'Няма организация с такова наименование.'));
  return h('div', { class: 'stack' },
    h('div', { class: 'grid2' },
      card('Търговски регистър и регистър на ЮЛНЦ', r.cr || {}, ''),
      card('Регистър БУЛСТАТ', r.bulstat || {}, ' (търси се по пълното наименование)')),
    h('p', { class: 'small muted' }, 'Търсено „' + r.name + '“ ' + fmtTime(r.at) + (r.cached ? ' (от последните 12 часа)' : '') + '. Източници: Агенция по вписванията и регистър БУЛСТАТ.'));
}

function enhanceParty(root, prefix = '') {
  const el = n => root.querySelector(`[name="${prefix}${n}"]`);
  const basis = el('regBasis'), eik = el('eik'), addr = el('address'), obl = el('oblast');
  if (basis && eik) {
    const span = eik.closest('label').querySelector('span');
    const links = h('small', null);
    const sync = () => {
      span.firstChild.textContent = capital(Docs.idLabel(basis.value));
      links.replaceChildren(/БУЛСТАТ/.test(basis.value) ? h('a', { href: REGISTRY_BULSTAT, target: '_blank', rel: 'noopener' }, 'Справка в регистър БУЛСТАТ')
        : /ЕИК/.test(basis.value) ? h('a', { href: REGISTRY_TR, target: '_blank', rel: 'noopener' }, 'Справка в Търговския регистър') : '');
    };
    basis.addEventListener('change', sync);
    // проверка в регистрите и попълване на данните
    const set = (n, v) => { const x = el(n); if (x && v) { x.value = v; x.dispatchEvent(new Event('change')); } };
    const check = h('button', { type: 'button', class: 'btn sm verify-btn', onclick: () => {
      const v = eik.value.replace(/\D/g, '');
      if (!/^(\d{9}|\d{13})$/.test(v)) return toast('Въведете ЕИК/БУЛСТАТ (9 или 13 цифри).');
      verifyDialog(v, d => { set('name', d.name); set('regBasis', d.regBasis); set('address', d.address); set('email', d.email); set('rep', d.rep); });
    } }, 'Провери в регистрите');
    eik.closest('label').append(links, check);
    sync();
  }
  if (addr) addr.closest('label').after(addressPicker(h, addr, obl));
  return root;
}

function downloadB64(name, b64, type) {
  const raw = atob(b64), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const reqPill = s => h('span', { class: 'pill ' + ({ 'Чернова': '', 'Изпратено': 'info', 'Чака уточняване': 'warn', 'Уточнено': 'info', 'Удължен срок': 'info', 'Получен отговор': 'ok', 'Предоставен достъп': 'ok', 'Частичен достъп': 'warn', 'Отказ': 'bad', 'Мълчалив отказ': 'bad', 'Обжалвано': 'warn', 'Приключено': '' }[s] || '') }, s || '—');

/* редактор на точки: добавяне, изтриване и подреждане */
function pointsEditor(points, label) {
  const list = h('ol', { class: 'points' });
  const row = text => {
    const ta = h('textarea', { rows: 2, maxlength: 4000, 'aria-label': 'Точка' });
    ta.value = text || '';
    const li = h('li', { class: 'point' }, ta, h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn sm', title: 'Нагоре', onclick: () => li.previousElementSibling && list.insertBefore(li, li.previousElementSibling) }, '↑'),
      h('button', { type: 'button', class: 'btn sm', title: 'Надолу', onclick: () => li.nextElementSibling && list.insertBefore(li.nextElementSibling, li) }, '↓'),
      h('button', { type: 'button', class: 'btn sm danger', title: 'Изтрий', onclick: () => li.remove() }, '✕')));
    return li;
  };
  (points && points.length ? points : ['']).forEach(p => list.append(row(p)));
  const add = h('button', { type: 'button', class: 'btn sm', onclick: () => { const li = row(''); list.append(li); li.querySelector('textarea').focus(); } }, '+ Добави точка');
  const wrap = h('div', { class: 'field full' }, h('span', null, label || 'Искана информация (по точки)', h('span', { class: 'req' }, ' *')), list, add);
  wrap.values = () => [...list.querySelectorAll('textarea')].map(t => t.value.trim()).filter(Boolean);
  return wrap;
}

/* ---------- заявления: списък ---------- */

async function requestsView(query) {
  loading();
  try {
    const { requests } = await api('req.list', { person: curCode || '' });
    const preset = new URLSearchParams(query || '').get('f') || '';
    const q = h('input', { type: 'search', placeholder: 'Търсене: номер, субект, заявител, предмет…', 'aria-label': 'Търсене' });
    const st = h('select', { 'aria-label': 'Статус' }, h('option', { value: '' }, 'Всички статуси'), boot.lists.reqStatuses.map(s => h('option', { value: s }, s)));
    const per = h('select', { 'aria-label': 'Лице', hidden: true }, h('option', { value: '' }, 'Всички лица'), personsAll().map(p => h('option', { value: p.code }, p.name)));
    const due = h('select', { 'aria-label': 'Срок' }, h('option', { value: '' }, 'Всички'), h('option', { value: 'overdue' }, 'Без отговор в срок'), h('option', { value: 'ours' }, 'Чака наше уточнение'), h('option', { value: 'mine' }, 'Моите'));
    if (preset === 'draft') st.value = 'Чернова';
    if (preset === 'overdue') due.value = 'overdue';
    const body = h('div');
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      const rows = requests.filter(r => {
        if (t && ![r.regNo, r.entityName, r.applicantName, r.title, r.outNo].join(' ').toLowerCase().includes(t)) return false;
        if (st.value && r.status !== st.value) return false;
        if (per.value && r.person !== per.value) return false;
        if (due.value === 'overdue' && !(r.due && !r.ours && r.daysLeft < 0)) return false;
        if (due.value === 'ours' && !r.ours) return false;
        if (due.value === 'mine' && r.owner !== me.username) return false;
        return true;
      });
      body.replaceChildren(h('p', { class: 'small muted' }, 'Показани: ' + rows.length + ' от ' + requests.length),
        table(['№', 'Задължен субект', 'Заявител', 'Предмет', 'Статус', 'Изх. №', 'Срок'], rows.map(r => h('tr', { class: 'link', onclick: () => { location.hash = '#/request/' + encodeURIComponent(r.regNo); } },
          h('td', { class: 'mono' }, r.regNo, r.locked === 'Да' ? ' 🔒' : ''), h('td', null, r.entityName), h('td', null, r.mode === 'Клиент' ? [r.applicantName, manyPersons() ? h('div', { class: 'small muted' }, 'чрез ' + personName(r.person)) : null] : h('span', { class: 'muted' }, personName(r.person))),
          h('td', { class: 'subject' }, r.title || '—'), h('td', null, reqPill(r.status)), h('td', { class: 'mono' }, r.outNo || '—'),
          h('td', null, r.due ? h('span', { class: dueClass(r.daysLeft) }, (r.ours ? 'наше уточнение: ' : '') + fmtDate(r.due), h('br'), h('span', { class: 'small' }, dueText(r.daysLeft))) : r.appealBy ? h('span', { class: 'small ' + dueClass(r.appealDays) }, 'обжалване до ' + fmtDate(r.appealBy)) : '—'))),
        'Няма заявления по тези условия.'));
    };
    [q, st, per, due].forEach(x => x.addEventListener('input', draw));
    setView(head('Заявления до институции', can('reqCreate') ? h('a', { class: 'btn primary', href: '#/request/new' }, 'Ново заявление') : null),
      h('p', { class: 'small muted mb-12' }, 'Заявления по ЗДОИ от името на ' + (manyPersons() ? 'лицата, до които имате достъп,' : 'Сдружението') + ' или като пълномощник на клиент. Отговорите идват на адреса за отговор на преписката (кутия+<№ на преписката>) и се разпределят автоматично.'),
      h('div', { class: 'card' }, h('div', { class: 'filters' }, q, st, per, due), body));
    draw();
  } catch (e) { failView(e); }
}

/* ---------- заявление: съдържание (ново или редакция) ---------- */

const PARTY_FIELDS = (prefix, opts = {}) => [
  opts.type ? { k: prefix + 'type', label: 'Вид', type: 'select', options: boot.lists.applicantTypes } : null,
  { k: prefix + 'name', label: opts.nameLabel || 'Име или наименование', req: !!opts.req, max: 250 },
  { k: prefix + 'regBasis', label: 'Регистрация', type: 'select', options: boot.lists.regBasis.map(o => [o, o || '— (физическо лице или без регистрация)']) },
  { k: prefix + 'eik', label: 'ЕИК/БУЛСТАТ', max: 13, pattern: '\\d{9}|\\d{13}' },
  { k: prefix + 'address', label: 'Адрес', max: 400, full: true },
  { k: prefix + 'oblast', label: 'Област', max: 80 },
  { k: prefix + 'email', label: 'Имейл', type: 'email', max: 200 },
  { k: prefix + 'phone', label: 'Телефон', type: 'tel', max: 40 },
  opts.rep ? { k: prefix + 'rep', label: 'Представляван от', max: 160 } : null,
  opts.rep ? { k: prefix + 'repPosition', label: 'Качество (длъжност)', max: 160 } : null
].filter(Boolean);

const pick = (v, prefix) => { const o = {}; Object.keys(v).filter(k => k.startsWith(prefix)).forEach(k => { o[k.slice(prefix.length)] = v[k]; }); return o; };
const prefixed = (obj, prefix) => { const o = {}; Object.keys(obj || {}).forEach(k => { o[prefix + k] = obj[k]; }); return o; };

/* търсене на задължения субект: първо адресатите, после регистърът на административните структури (ИИСДА) */
function entitySearch(addressees, pick) {
  const input = h('input', { type: 'search', placeholder: 'Наименование, БУЛСТАТ или имейл – адресати и регистър на администрациите', autocomplete: 'off', 'aria-label': 'Търсене на субект' });
  const list = h('div', { class: 'search-results in-form', role: 'listbox', hidden: true });
  let timer = null;
  const low = v => String(v || '').toLowerCase();
  const run = async () => {
    const t = low(input.value.trim());
    if (t.length < 2) { list.hidden = true; return; }
    const own = addressees.filter(a => [a.name, a.eik, a.email].some(v => low(v).includes(t))).slice(0, 6);
    let reg = [];
    try {
      const [a, b, c] = await Promise.all([api('registry.search', { q: input.value.trim(), limit: 6 }), api('registry.search', { source: 'mon', q: input.value.trim(), limit: 5 }).catch(() => ({ items: [] })),
        api('registry.search', { source: 'appk', q: input.value.trim(), limit: 5 }).catch(() => ({ items: [] }))]);
      reg = a.items.map(x => Object.assign({ src: 'ИИСДА' }, x)).concat(b.items.map(x => Object.assign({ src: 'МОН' }, x)), c.items.map(x => Object.assign({ src: 'АППК' }, x))).filter(x => !own.some(o => (o.eik && o.eik === x.eik) || o.name === x.name));
    } catch (_) { reg = []; }
    const row = (kind, name, sub, onPick) => h('a', { href: '#', role: 'option', onclick: e => { e.preventDefault(); onPick(); list.hidden = true; input.value = ''; } },
      h('span', { class: 'sr-kind' }, kind), h('span', { class: 'sr-main' }, h('b', null, name), h('span', null, sub)));
    const items = own.map(a => row('Адресат', a.name, [a.eik, a.email].filter(Boolean).join(' · '), () => pick(a, false)))
      .concat(reg.map(x => row(x.src, x.name, [x.eik, x.email, x.muni || x.oblast].filter(Boolean).join(' · '), () => pick({ name: x.name, regBasis: boot.lists.regBasis[2], eik: x.eik, address: x.address, oblast: x.oblast, email: x.email, phone: x.phone }, true))));
    list.replaceChildren(...(items.length ? items : [h('div', { class: 'empty' }, 'Няма намерени. Попълнете данните ръчно.')]));
    list.hidden = false;
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 200); });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') list.hidden = true; if (e.key === 'Enter') { e.preventDefault(); const a = list.querySelector('a'); if (a) a.click(); } });
  document.addEventListener('click', e => { if (!input.parentNode || !input.parentNode.contains(e.target)) list.hidden = true; });
  return h('label', { class: 'field full entity-search' }, h('span', null, 'Търсене на субекта'), h('div', { class: 'search-wrap' }, input, list),
    h('small', null, 'Администрациите са от ИИСДА, училищата – от МОН, публичните предприятия – от АППК. Проверете имейла за заявления по ЗДОИ на сайта на субекта.'));
}

async function requestEditView(regNo) {
  if (!regNo && !can('reqCreate')) return noAccess('reqCreate');
  if (regNo && !can('reqEdit')) return noAccess('reqEdit');
  loading();
  let r = null, addressees = [];
  try {
    if (regNo) r = (await api('req.get', { regNo })).request;
    addressees = (await api('addressee.list', { person: curCode || '' })).addressees;
  } catch (e) { return failView(e); }
  const v = r ? Object.assign({ mode: r.mode, kind: r.kind, title: r.title, motives: r.motives, noPublish: r.noPublish, person: r.person }, prefixed(r.applicant, 'a_'), prefixed(r.entity, 'e_'))
    : { mode: 'Сдружението', kind: boot.lists.reqKinds[0], e_regBasis: boot.lists.regBasis[2], person: curCode || (personsAll().find(p => p.active) || {}).code };
  // лицето определя бланката, номерацията и пощенската кутия, затова се избира само при създаване
  const usable = personsAll().filter(p => p.active || p.code === v.person);
  // лицето е избраното при отваряне (смяна – от горната лента)
  const personSel = !r && manyPersons() ? h('div', { class: 'field full' }, h('span', null, 'Лице (бланка, регистър и поща)'), h('div', { class: 'note' }, (curPerson() || {}).name || '—', h('span', { class: 'small' }, ' · смяна от горната лента'))) : null;
  if (!r && curPerson() && !curPerson().active) return setView(h('p', { class: 'err' }, 'Лицето „' + curPerson().name + '“ е спряно – не се създават нови заявления от негово име.'));
  let form = null;
  const selPerson = () => personsAll().find(p => p.code === ((form && form.elements.person && form.elements.person.value) || v.person)) || personsAll()[0] || { name: 'Сдружението' };
  const modeOpts = () => { const p = selPerson(), n = p.brand || p.name; return [['Сдружението', p.isDefault ? 'Сдружението (' + n + ')' : n], ['Клиент', 'Клиент – ' + n + ' е пълномощник']]; };
  const modeSel = field({ k: 'mode', label: 'Заявлението е от името на', type: 'select', options: modeOpts(), req: true }, v.mode);
  const applicantBox = h('fieldset', null, h('legend', null, 'Заявител (клиент)'), h('div', { class: 'form-grid' }, PARTY_FIELDS('a_', { type: true, rep: true, req: true, nameLabel: 'Имена или наименование' }).map(f => field(f, v[f.k]))),
    h('p', { class: 'small muted mt-8' }, 'Приложете пълномощно към заявлението (в документа – „Приложения“).'));
  const entityPick = entitySearch(addressees, (a, fromRegistry) => {
    ['name', 'regBasis', 'eik', 'address', 'oblast', 'email', 'phone'].forEach(k => { const el = form.elements['e_' + k]; if (el) { el.value = a[k] || ''; el.dispatchEvent(new Event('change')); } });
    form.elements.e_id.value = fromRegistry ? '' : a._id;
  });
  const points = pointsEditor(r ? r.points : [], 'Искана информация (по точки)');
  const accessBox = h('div', { class: 'field full' }, h('span', null, 'Форма на достъп (чл. 26, ал. 1 ЗДОИ)'),
    boot.lists.accessForms.map((a, i) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'acc_' + i, checked: r ? r.access.includes(a) : i === 3 }), h('span', null, a))));
  form = h('form', null,
    h('fieldset', null, h('legend', null, 'Заявител'), h('div', { class: 'form-grid' }, personSel, modeSel,
      field({ k: 'kind', label: 'Вид заявление', type: 'select', options: boot.lists.reqKinds, req: true }, v.kind),
      !r ? field({ k: 'owner', label: 'Отговорник', type: 'select', options: ownerOptions(), hint: can('assign') ? '' : 'Можете да назначите само себе си; на друг потребител преписката се разпределя от администратор.' }, me.username) : null)),
    applicantBox,
    h('fieldset', null, h('legend', null, 'Задължен субект'), entityPick, h('div', { class: 'form-grid' }, PARTY_FIELDS('e_', { req: true, nameLabel: 'Наименование' }).map(f => field(f, v[f.k])),
      h('input', { type: 'hidden', name: 'e_id', value: v.e_id || '' }))),
    h('fieldset', null, h('legend', null, 'Искане'), h('div', { class: 'form-grid' },
      field({ k: 'title', label: 'Предмет (кратко)', max: 250, full: true, placeholder: 'Например: договори за сметопочистване 2025 г.' }, v.title),
      points,
      field({ k: 'motives', label: 'Допълнителни мотиви (по желание)', type: 'textarea', rows: 5, max: 20000, full: true, hint: 'Законът не изисква мотиви. Полезни са при надделяващ обществен интерес (§ 1, т. 6 ДР ЗДОИ) или при повторно използване.' }, v.motives),
      accessBox,
      field({ k: 'noPublish', label: 'Заявителят не е съгласен информацията да се публикува на платформата (чл. 25, ал. 1, т. 5)', type: 'checkbox', full: true }, v.noPublish))),
    h('div', { class: 'actions mt-16' }, h('a', { class: 'btn', href: r ? '#/request/' + encodeURIComponent(r.regNo) : '#/requests' }, 'Отказ'), h('button', { type: 'submit', class: 'btn primary' }, r ? 'Запази' : 'Създай чернова')));
  const syncMode = () => { applicantBox.hidden = form.elements.mode.value !== 'Клиент'; applicantBox.querySelectorAll('[name="a_name"]').forEach(x => { x.required = !applicantBox.hidden; }); };
  form.elements.mode.addEventListener('change', syncMode);
  if (form.elements.person) form.elements.person.addEventListener('change', () => {
    const sel = form.elements.mode, keep = sel.value;
    sel.replaceChildren(...modeOpts().map(([val, t]) => h('option', { value: val }, t)));
    sel.value = keep;
  });
  setView(head(r ? 'Редакция на ' + r.regNo : 'Ново заявление'), h('div', { class: 'card' }, form));
  enhanceParty(form, 'a_'); enhanceParty(form, 'e_');
  syncMode();
  onSubmit(form, async val => {
    const data = {
      regNo: r ? r.regNo : undefined, contentOnly: true, person: r ? undefined : (val.person || v.person), mode: val.mode, kind: val.kind, title: val.title, motives: val.motives, noPublish: val.noPublish, owner: val.owner,
      applicant: val.mode === 'Клиент' ? pick(val, 'a_') : {}, entity: pick(val, 'e_'), points: points.values(),
      access: boot.lists.accessForms.filter((a, i) => form.elements['acc_' + i].checked)
    };
    if (!data.points.length) throw new Error('Добавете поне една точка с исканата информация.');
    const res = await api(r ? 'req.update' : 'req.create', data);
    toast(r ? 'Запазено.' : 'Създадена е чернова ' + res.regNo + '.');
    location.hash = '#/request/' + encodeURIComponent(res.regNo);
  });
}

/* ---------- заявление: страница на преписката ---------- */

const PROGRESS_REQ_FIELDS = () => [
  { k: 'status', label: 'Статус', type: 'select', options: boot.lists.reqStatuses, req: true },
  { k: 'sentAt', label: 'Изпратено на', type: 'date' },
  { k: 'sentHow', label: 'Начин на изпращане', type: 'select', options: boot.lists.sentHow.map(o => [o, o || '—']) },
  { k: 'entityRegNo', label: 'Вх. № при субекта', max: 60 },
  { k: 'entityRegDate', label: 'Вх. дата при субекта', type: 'date', hint: 'Срокът по чл. 28 тече от регистрирането.' },
  { k: 'clarifyAskedAt', label: 'Субектът поиска уточняване на', type: 'date' },
  { k: 'clarifySentAt', label: 'Изпратено уточнение на', type: 'date' },
  { k: 'ext30', label: 'Удължаване по чл. 30 (дни, до 10)', type: 'number', min: 0, maxValue: 10 },
  { k: 'ext31', label: 'Удължаване по чл. 31 (дни, до 14)', type: 'number', min: 0, maxValue: 14 },
  { k: 'decisionNo', label: 'Решение №', max: 60 },
  { k: 'decisionDate', label: 'Дата на решението', type: 'date' },
  { k: 'outcome', label: 'Резултат', type: 'select', options: boot.lists.reqOutcomes.map(o => [o, o || '—']) },
  { k: 'servedAt', label: 'Решението е получено на', type: 'date', hint: 'От тази дата тече 14-дневният срок за обжалване.' },
  { k: 'appealed', label: 'Обжалвано', type: 'checkbox' },
  { k: 'appealNote', label: 'Бележка за обжалването', type: 'textarea', full: true, rows: 2, max: 4000 },
  { k: 'notes', label: 'Вътрешни бележки', type: 'textarea', full: true, rows: 3, max: 8000 }
];

async function requestView(regNo) {
  loading();
  let d;
  try { d = await api('req.get', { regNo }); } catch (e) { return failView(e); }
  const r = d.request, locked = r.locked === 'Да', edit = can('reqEdit') && !locked;
  // отделните операции – всяка с право
  const may = k => can(k) && !locked;
  const org = d.person || boot.org;
  const reload = () => requestView(regNo);
  const full = () => Object.assign({}, r, { applicant: r.applicant, entity: r.entity, points: r.points, access: r.access });

  const progress = () => formDialog('Ход и решение', PROGRESS_REQ_FIELDS(), r, 'Запази', async v => {
    await api('req.update', Object.assign(full(), v, { regNo: r.regNo }));
    toast('Запазено.'); reload();
  }, { wide: true });

  const dueCard = h('section', { class: 'card stack' }, h('h2', null, 'Срокове'),
    r.due ? h('div', null, h('div', { class: 'small muted' }, r.dueLabel), h('div', { class: 'bigdue ' + dueClass(r.daysLeft) }, fmtDate(r.due)), h('div', { class: dueClass(r.daysLeft) }, dueText(r.daysLeft)))
      : h('p', { class: 'muted' }, r.status === 'Чернова' ? 'Сроковете започват след изпращането.' : 'Няма текущ срок.'),
    r.silentBy && r.daysLeft !== null && r.daysLeft < 0 ? h('div', null, h('div', { class: 'small muted' }, 'Обжалване на мълчалив отказ (едномесечен срок, чл. 149, ал. 2 АПК)'), h('b', { class: dueClass(r.silentDays) }, fmtDate(r.silentBy) + ' · ' + dueText(r.silentDays))) : null,
    r.appealBy ? h('div', null, h('div', { class: 'small muted' }, 'Обжалване на решението (14 дни, чл. 149, ал. 1 АПК)'), h('b', { class: dueClass(r.appealDays) }, fmtDate(r.appealBy) + ' · ' + dueText(r.appealDays))) : null,
    h('div', { class: 'reply-box' }, h('div', { class: 'small muted' }, 'Адрес за отговор'), h('b', { class: 'wrap-any' }, d.replyTo),
      h('div', { class: 'actions mt-8' },
        h('button', { class: 'btn sm', title: 'Копирай адреса', onclick: async () => { try { await navigator.clipboard.writeText(d.replyTo); toast('Копирано.'); } catch (_) { toast('Копирането не е разрешено.'); } } }, 'Копирай'),
        edit && can('docs') ? h('button', { class: 'btn sm', title: 'Адрес с вътрешния идентификатор на лицето и уведомление до субекта (PDF)', onclick: () => changeReplyTo(d) }, 'Смени адреса…') : null)));

  const owner = ownerCard(r, 'req.assign', canAny('reqEdit', 'reqCreate') && !locked, reload);
  const canLock = can('lock') && (isAdmin() || (!locked && r.owner === me.username) || (locked && r.lockedBy === me.username));
  const lockCard = h('section', { class: 'card stack' }, h('h2', null, 'Заключване'),
    h('p', { class: 'small muted' }, locked ? 'Заключена от ' + userName(r.lockedBy) + ' на ' + fmtTime(r.lockedAt) + '.' : 'Заключената преписка се чете, но не се променя.'),
    canLock ? h('button', { class: 'btn sm', onclick: async () => { try { await api('req.lock', { regNo: r.regNo, locked: !locked }); reload(); } catch (e) { toast(e.message); } } }, locked ? 'Отключи' : 'Заключи') : null);
  const courtCard = h('section', { class: 'card stack' }, h('div', { class: 'head m-0' }, h('h2', null, 'Съдебни дела'), me.perms.courts ? h('button', { class: 'btn sm', onclick: () => courtDialog(courtFromRequest(d), reload) }, 'Добави дело') : null),
    d.courts.length ? h('ul', { class: 'list-plain' }, d.courts.map(x => h('li', null, h('span', null, x.court.replace('Административен съд – ', 'АС '), ' № ', x.caseNo, '/', x.year, h('br'), h('span', { class: 'small muted' }, x.status + (x.nextHearing ? ' · заседание ' + fmtDate(x.nextHearing) : ''))),
      h('a', { class: 'btn sm', href: '#/court/' + x._id }, 'Отвори')))) : h('p', { class: 'empty' }, 'Няма дела.'));

  /* документи */
  const docRows = d.docs.map(x => h('tr', null,
    h('td', { class: 'mono' }, x.outNo), h('td', null, x.kind), h('td', null, fmtDate(x.date)),
    h('td', null, x.sentAt ? h('span', { class: 'small' }, whenOf(x.sentAt), h('br'), x.sentTo) : h('span', { class: 'pill' }, 'неизпратен'),
      x.payload._sig ? [h('br'), h('span', { class: 'pill ok', title: 'Издател: ' + x.payload._sig.issuer + (x.payload._sig.qualified ? ' · квалифициран' : '') + ' · ' + fmtTime(x.payload._sig.at) + (x.payload._sig.rev ? ' · регистър: ' + (x.payload._sig.rev.status === 'good' ? 'валидно (' + x.payload._sig.rev.method + ')' : 'не е проверено') : '') }, '✍ КЕП: ' + x.payload._sig.name)] : null),
    h('td', null, h('div', { class: 'actions' },
      h('button', { class: 'btn sm', onclick: () => regenerate(x) }, 'PDF'),
      may('docs') && !x.sentAt && !x.payload._sig ? h('button', { class: 'btn sm', onclick: () => x.kind === 'Съдебен документ' ? courtDocDialog({ payload: x.payload, existing: x, regNo: r.regNo, reload }) : docEditor(d, x.kind, x) }, 'Редактирай') : null,
      may('sign') && !x.sentAt && !x.payload._sig && x.fileId && x.kind !== 'Досие' ? h('button', { class: 'btn sm', onclick: () => kepSign(d, x) }, '✍ Подпиши с КЕП') : null,
      may('mailSend') && x.fileId ? h('button', { class: 'btn sm primary', onclick: () => composeDialog(d, { docs: [x.outNo] }) }, 'Изпрати по имейл') : null,
      may('mailRecord') && x.fileId ? h('button', { class: 'btn sm', title: 'Подаване от профила на ' + org.name + ' в ССЕВ (edelivery.egov.bg)', onclick: () => ssevDialog(d, x) }, 'Подай през ССЕВ') : null,
      may('mailRecord') ? h('button', { class: 'btn sm', title: 'ССЕВ, поща, лично в деловодството, платформата по чл. 15в', onclick: () => recordDialog(d, 'Изходяща', [x.outNo]) }, 'Друг начин…') : null))));
  const regenerate = async x => {
    try {
      // подписаният файл се сваля такъв, какъвто е – новото генериране би премахнало подписа
      if (x.payload._sig) { const f = await api('doc.download', { outNo: x.outNo }); return downloadB64(x.outNo + ' ' + x.kind + ' (подписан).pdf', f.data, 'application/pdf'); }
      const p = Object.assign({}, x.payload, { outNo: x.outNo, date: x.date });
      await Docs.open(Docs.DEFS[x.kind](p), x.outNo + ' ' + x.kind + '.pdf');
    } catch (e) { toast(e.message); }
  };
  const docsCard = h('section', { class: 'card stack' }, h('div', { class: 'head m-0' }, h('h2', null, 'Документи'),
    may('docs') ? h('div', { class: 'actions' }, boot.lists.docKinds.filter(k => k !== 'Съдебен документ').map(k => h('button', { class: 'btn sm', onclick: () => docEditor(d, k) }, '+ ' + k)),
      dropdown(h('button', { class: 'btn sm' }, '+ За съда', icon('chevron', 'sm')), h('div', { class: 'dd-panel right' }, COURT_DOCS.map(t => h('button', { type: 'button', onclick: () => courtDocDialog({ type: t, regNo: r.regNo, court: d.courts[0] || { regNo: r.regNo }, reload }) }, t))))) : null),
    table(['Изх. №', 'Вид', 'Дата', 'Изпратен', ''], docRows, 'Няма документи. Създайте заявлението с „+ Заявление“.'));

  /* кореспонденция */
  const mailCard = h('section', { class: 'card stack' }, h('div', { class: 'head m-0' }, h('h2', null, 'Кореспонденция'), canAny('mailSend', 'mailRecord') && !locked ? h('div', { class: 'actions' },
      may('mailSend') ? h('button', { class: 'btn sm', onclick: () => composeDialog(d, {}) }, 'Ново писмо') : null,
      may('mailRecord') ? h('button', { class: 'btn sm', title: 'Изпратено през ССЕВ, по пощата, лично в деловодството…', onclick: () => recordDialog(d, 'Изходяща', []) }, 'Отбележи изпратено') : null,
      may('mailRecord') ? h('button', { class: 'btn sm', title: 'Получено по пощата, през ССЕВ, на ръка…', onclick: () => recordDialog(d, 'Входяща', []) }, 'Регистрирай получено') : null) : null),
    d.mail.length ? h('div', { class: 'stack' }, d.mail.map(m => h('div', { class: 'msg' + (m.direction === 'Изходяща' ? ' op' : '') + (PENDING.includes(m.direction) ? ' sched' : '') },
      h('div', { class: 'small muted' }, h('span', { class: 'pill ' + ({ 'Входяща': 'info', 'Насрочена': 'warn', 'Изпраща се': 'warn', 'Неизпратена': 'bad' }[m.direction] || '') }, m.direction === 'Насрочена' ? '⏰ Насрочено за ' + fmtTime(m.at) : m.direction), ' ',
      m.direction === 'Насрочена' ? h('span', { class: dayInfo(m.at.slice(0, 10)).workday ? '' : 'warn-text' }, '(' + dayInfo(m.at.slice(0, 10)).label + ') ') : null,
        chanOf(m) ? [h('span', { class: 'pill warn' }, chanOf(m)), ' '] : null,
        whenOf(m.at), ' · ', m.direction === 'Входяща' ? 'от ' + m.from : 'до ' + m.to, m.ref ? ' · ' + m.ref : '', m.docOutNo ? ' · ' + m.docOutNo : '', m.matched ? ' · разпределено: ' + m.matched : ''),
      h('div', null, h('b', null, m.subject || '(без тема)')),
      h('details', null, h('summary', { class: 'small' }, 'Текст'), h('div', { class: 'pre small' }, m.body)),
      m.attachments.length ? h('div', { class: 'attach-chips' }, m.attachments.map((a, i) => a.fileId ? h('button', { class: 'btn sm', onclick: async () => { try { const f = await api('mail.attachment', { id: m._id, index: i }); downloadB64(f.name, f.data, f.contentType); } catch (e) { toast(e.message); } } }, '📎 ' + a.name) : h('span', { class: 'small muted' }, '📎 ' + a.name + (a.skipped ? ' (' + a.skipped + ')' : '')))) : null,
      may('mailSend') && m.direction === 'Входяща' && (!m.channel || m.channel === 'Имейл') ? h('div', { class: 'actions mt-8' }, h('button', { class: 'btn sm', onclick: () => composeDialog(d, { reply: m }) }, 'Отговори')) : null,
      may('mailSend') && (m.direction === 'Насрочена' || m.direction === 'Неизпратена') ? h('div', { class: 'actions mt-8' }, h('button', { class: 'btn sm danger', onclick: async () => {
        if (!confirm(m.direction === 'Насрочена' ? 'Да се отмени ли насроченото писмо?' : 'Да се премахне ли неизпратеното писмо?')) return;
        try { await api('mail.cancel', { id: m._id }); toast('Отменено.'); reload(); } catch (e) { toast(e.message); }
      } }, m.direction === 'Насрочена' ? 'Отмени' : 'Премахни'),
        m.direction === 'Неизпратена' ? h('button', { class: 'btn sm', onclick: () => composeDialog(d, {}) }, 'Ново писмо') : null) : null))) : h('p', { class: 'empty' }, 'Няма писма.'));

  const comment = h('form', null, field({ k: 'text', label: 'Вътрешен коментар', type: 'textarea', rows: 2, max: 4000, req: true, full: true }), h('div', { class: 'actions mt-8' }, h('button', { type: 'submit', class: 'btn sm primary' }, 'Добави')));
  onSubmit(comment, async v => { await api('req.comment', { regNo: r.regNo, text: v.text }); toast('Добавено.'); reload(); });
  const history = h('section', { class: 'card stack' }, h('h2', null, 'Коментари и история'), may('comment') ? comment : null,
    h('ul', { class: 'timeline' }, d.events.map(e => h('li', null, h('div', { class: 'small muted' }, fmtTime(e.at) + ' · ' + userName(e.user) + ' · ' + e.kind), h('div', { class: 'pre' }, e.text)))));

  const ent = r.entity, ap = r.applicant;
  setView(
    head(r.regNo + (locked ? ' 🔒' : ''), reqPill(r.status),
      edit ? h('a', { class: 'btn', href: '#/request/' + encodeURIComponent(r.regNo) + '/edit' }, 'Редактирай искането') : null,
      edit ? h('button', { class: 'btn', onclick: progress }, 'Ход и решение') : null,
      h('button', { class: 'btn primary', onclick: () => reqDossier(d) }, 'Досие за съда (PDF)')),
    h('div', { class: 'split' },
      h('div', { class: 'stack' },
        h('section', { class: 'card stack' }, h('h2', null, 'Искане'), kv([
          ['Вид', r.kind], ['Предмет', r.title],
          ['Задължен субект', [ent.name, ent.eik ? capital(Docs.idLabel(ent.regBasis)) + ' ' + ent.eik : '', ent.address, ent.email].filter(Boolean).join(' · ')],
          ['Заявител', r.mode === 'Клиент' ? [ap.name, ap.eik ? capital(Docs.idLabel(ap.regBasis)) + ' ' + ap.eik : '', ap.address, ap.email].filter(Boolean).join(' · ') + ' (чрез ' + (org.brand || org.name) + ' като пълномощник)' : org.name + (org.brand && org.brand !== org.name ? ' (' + org.brand + ')' : '')],
          manyPersons() ? ['Лице (регистър и поща)', org.name + ' · ' + d.mailbox] : null,
          ['Изх. № на заявлението', r.outNo], mainNo(d) && mainNo(d) !== r.outNo ? ['Главен Изх. №', mainNo(d) + ' (документите са ' + mainNo(d) + '-1, -2…)'] : null, ['Изпратено', r.sentAt ? fmtDate(r.sentAt) + (r.sentHow ? ' – ' + (r.sentHow === 'На място' ? 'лично в деловодството' : r.sentHow) : '') : ''],
          ['Вх. № при субекта', r.entityRegNo ? r.entityRegNo + (r.entityRegDate ? ' от ' + fmtDate(r.entityRegDate) : '') : ''],
          ['Уточняване', r.clarifyAskedAt ? 'поискано ' + fmtDate(r.clarifyAskedAt) + (r.clarifySentAt ? ', изпратено ' + fmtDate(r.clarifySentAt) : '') : ''],
          ['Решение', r.decisionNo ? '№ ' + r.decisionNo + (r.decisionDate ? ' от ' + fmtDate(r.decisionDate) : '') : ''], ['Резултат', r.outcome],
          ['Получено решение', r.servedAt ? fmtDate(r.servedAt) : ''], ['Обжалвано', r.appealed === 'Да' ? 'Да' + (r.appealNote ? ' – ' + r.appealNote : '') : 'Не']
        ]), h('div', null, h('div', { class: 'small muted' }, 'Искана информация'), h('ol', null, r.points.map(p => h('li', { class: 'pre' }, p)))),
        r.motives ? h('details', null, h('summary', null, 'Мотиви'), h('p', { class: 'pre' }, r.motives)) : null,
        r.notes ? h('div', null, h('div', { class: 'small muted' }, 'Вътрешни бележки'), h('p', { class: 'pre' }, r.notes)) : null),
        docsCard, mailCard, history),
      h('div', { class: 'stack' }, dueCard, owner, lockCard, courtCard)));
}

/* нов адрес за отговор: етикетът с кода на лицето; после уведомление до субекта (документ с Изх. №) */
function changeReplyTo(d) {
  const r = d.request;
  const target = d.mailbox.replace('@', '+' + ((d.person && d.person.tagId) || 'p') + '-' + r.regNo.slice(-9) + '@');
  const already = target === d.replyTo;
  const body = h('div', { class: 'stack' },
    already ? h('p', null, 'Адресът за отговор вече е с вътрешния идентификатор на лицето: ', h('b', { class: 'mono' }, d.replyTo), '. Можете да подготвите уведомление до субекта (напр. ако преди е получил друг адрес).')
      : [h('p', null, 'Адресът за отговор по преписката става с вътрешния идентификатор на лицето, за да не се смесват отговорите по преписки на различни лица:'),
        h('p', { class: 'mono' }, d.replyTo, ' → ', h('b', null, target)),
        h('p', { class: 'small muted' }, 'Писмата до стария адрес продължават да се разпознават. След смяната се отваря уведомлението до субекта („Промяна на адрес“) – запишете го и го изпратете.')],
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Отказ'),
      h('button', { type: 'button', class: 'btn' + (already ? ' primary' : ''), onclick: () => { dlg.close(); docEditor(d, 'Промяна на адрес', null, { oldReplyTo: '' }); } }, already ? 'Подготви уведомление' : 'Само уведомление'),
      already ? null : h('button', { type: 'button', class: 'btn primary', onclick: async e => {
        e.target.disabled = true;
        try {
          const t = await api('req.retag', { regNo: r.regNo });
          dlg.close();
          if (!t.changed) toast('Адресът вече е с вътрешния идентификатор на лицето.');
          const fresh = await api('req.get', { regNo: r.regNo });
          docEditor(fresh, 'Промяна на адрес', null, { oldReplyTo: t.changed ? t.oldReplyTo : '', newReplyTo: t.replyTo });
        } catch (ex) { toast(ex.message); e.target.disabled = false; }
      } }, 'Смени и подготви уведомление')));
  const dlg = dialog('Адрес за отговор – ' + r.regNo, body);
}

/* главният Изх. № на преписката (както на сървъра): на заявлението, иначе на първия документ без индекс */
const PLAIN_NO = /^[A-ZА-Я0-9]{2,10}-\d{4}-\d{4}$/;
function mainNo(d) {
  const r = d.request;
  if (r.outNo && PLAIN_NO.test(r.outNo)) return r.outNo;
  const first = d.docs.filter(x => PLAIN_NO.test(x.outNo || '')).sort((a, b) => Number(a._id) - Number(b._id))[0];
  return first ? first.outNo : '';
}

/* ---------- документ: заявление, уточнение, писмо, промяна на адрес ---------- */

/* preset: начални стойности (напр. стария адрес при „Промяна на адрес“) */
function docEditor(d, kind, existing, preset) {
  const r = d.request, prev = Object.assign({}, preset || {}, existing ? existing.payload : {}), org = d.person || boot.org;
  const isAddr = kind === 'Промяна на адрес';
  const base = {
    org, mode: r.mode, applicant: r.applicant, entity: r.entity, reqKind: r.kind, replyTo: d.replyTo, title: r.title,
    points: r.points, motives: r.motives, access: r.access, noPublish: r.noPublish === 'Да', accessEmail: d.replyTo, place: org.place, signMode: 'electronic'
  };
  const p0 = Object.assign({}, base, kind === 'Заявление' ? {} : { points: [], motives: '', title: kind === 'Писмо' ? '' : r.title }, prev);
  if ((kind === 'Уточнение' || isAddr) && !prev.ref) {
    const app = d.docs.find(x => x.kind === 'Заявление');
    p0.ref = { outNo: r.outNo || (app && app.outNo) || '', outDate: (app && app.date) || r.sentAt || '', entityRegNo: r.entityRegNo, entityRegDate: r.entityRegDate, letterNo: '', letterDate: r.clarifyAskedAt || '' };
  }
  const points = kind === 'Писмо' || isAddr ? null : pointsEditor(p0.points, kind === 'Уточнение' ? 'Уточнение (по точки)' : 'Искана информация (по точки)');
  const accessBox = kind === 'Заявление' ? h('div', { class: 'field full' }, h('span', null, 'Форма на достъп'),
    boot.lists.accessForms.map((a, i) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'acc_' + i, checked: (p0.access || []).includes(a) }), h('span', null, a)))) : null;
  const ref = p0.ref || {};
  const fields = h('div', { class: 'form-grid' },
    kind !== 'Уточнение' ? field({ k: 'title', label: kind === 'Писмо' ? 'Относно' : 'Предмет (Относно)', max: 250, full: true }, p0.title) : null,
    kind === 'Уточнение' ? [
      field({ k: 'clarifyBy', label: 'Уточнението е', type: 'select', full: true, options: [[Docs.CLARIFY_BY[0], 'По искане на органа (чл. 29, ал. 1 ЗДОИ) – срокът тече от получаването му'], [Docs.CLARIFY_BY[1], 'По инициатива на заявителя – сроковете не се променят']] },
        p0.clarifyBy || (r.clarifyAskedAt ? Docs.CLARIFY_BY[0] : Docs.CLARIFY_BY[1])),
      field({ k: 'ref_letterNo', label: 'Писмо на субекта – изх. №', max: 60 }, ref.letterNo), field({ k: 'ref_letterDate', label: 'от дата', type: 'date' }, ref.letterDate),
      field({ k: 'ref_outNo', label: 'Наше заявление – Изх. №', max: 30 }, ref.outNo), field({ k: 'ref_outDate', label: 'от дата', type: 'date' }, ref.outDate),
      field({ k: 'ref_entityRegNo', label: 'Вх. № при субекта', max: 60 }, ref.entityRegNo), field({ k: 'ref_entityRegDate', label: 'от дата', type: 'date' }, ref.entityRegDate)] : null,
    isAddr ? [
      field({ k: 'ref_outNo', label: 'Заявление – Изх. №', max: 30 }, ref.outNo), field({ k: 'ref_outDate', label: 'от дата', type: 'date' }, ref.outDate),
      field({ k: 'ref_entityRegNo', label: 'Вх. № при субекта', max: 60 }, ref.entityRegNo), field({ k: 'ref_entityRegDate', label: 'от дата', type: 'date' }, ref.entityRegDate),
      field({ k: 'newReplyTo', label: 'Нов имейл за кореспонденция', type: 'email', req: true, max: 200 }, p0.newReplyTo || d.replyTo),
      field({ k: 'oldReplyTo', label: 'Досегашен имейл', type: 'email', max: 200 }, p0.oldReplyTo || ''),
      field({ k: 'newAddress', label: 'Адрес за кореспонденция (по желание)', max: 400, full: true }, p0.newAddress !== undefined ? p0.newAddress : (r.mode === 'Клиент' ? (r.applicant.address || '') : (org.address || ''))),
      field({ k: 'effectiveDate', label: 'Считано от', type: 'date' }, p0.effectiveDate || todayIso())] : null,
    field({ k: 'salutation', label: 'Обръщение', max: 120, full: true }, p0.salutation || 'Уважаеми господин/госпожо,'),
    points,
    kind === 'Писмо' ? field({ k: 'body', label: 'Текст', type: 'textarea', rows: 10, max: 30000, full: true, req: true }, p0.body) : null,
    kind !== 'Писмо' && !isAddr ? field({ k: 'motives', label: kind === 'Уточнение' ? 'Пояснения (по желание)' : 'Допълнителни мотиви (по желание)', type: 'textarea', rows: 5, max: 20000, full: true }, p0.motives) : null,
    accessBox,
    kind === 'Заявление' ? field({ k: 'accessEmail', label: 'Имейл за получаване на информацията', type: 'email', max: 200 }, p0.accessEmail) : null,
    kind === 'Заявление' ? field({ k: 'noPublish', label: 'Несъгласие с публикуване на платформата (чл. 25, ал. 1, т. 5)', type: 'checkbox' }, p0.noPublish) : null,
    field({ k: 'extra', label: 'Допълнителен текст преди подписа (по желание)', type: 'textarea', rows: 2, max: 8000, full: true }, p0.extra),
    field({ k: 'attachments', label: 'Приложения (по едно на ред)', type: 'textarea', rows: 2, max: 2000, full: true, hint: r.mode === 'Клиент' ? 'Например: Пълномощно.' : '' }, (p0.attachments || (r.mode === 'Клиент' && kind === 'Заявление' ? ['Пълномощно'] : [])).join('\n')),
    field({ k: 'place', label: 'Място', max: 80 }, p0.place),
    field({ k: 'signMode', label: 'Подпис', type: 'select', options: [['electronic', 'Квалифициран електронен подпис'], ['manual', 'Саморъчен подпис']] }, p0.signMode));
  const collect = form => {
    const v = formValues(form);
    const p = Object.assign({}, base, { title: v.title || '', salutation: v.salutation, motives: v.motives || '', extra: v.extra || '', place: v.place, signMode: v.signMode,
      attachments: String(v.attachments || '').split('\n').map(x => x.trim()).filter(Boolean) });
    if (points) p.points = points.values();
    if (kind === 'Заявление') Object.assign(p, { accessEmail: v.accessEmail, noPublish: !!v.noPublish, access: boot.lists.accessForms.filter((a, i) => form.elements['acc_' + i].checked) });
    if (kind === 'Уточнение') p.clarifyBy = v.clarifyBy;
    if (kind === 'Уточнение') p.ref = { letterNo: v.ref_letterNo, letterDate: v.ref_letterDate, outNo: v.ref_outNo, outDate: v.ref_outDate, entityRegNo: v.ref_entityRegNo, entityRegDate: v.ref_entityRegDate };
    if (kind === 'Писмо') p.body = v.body;
    if (isAddr) {
      Object.assign(p, { newReplyTo: v.newReplyTo, oldReplyTo: v.oldReplyTo, newAddress: v.newAddress, effectiveDate: v.effectiveDate, replyTo: v.newReplyTo,
        ref: { outNo: v.ref_outNo, outDate: v.ref_outDate, entityRegNo: v.ref_entityRegNo, entityRegDate: v.ref_entityRegDate } });
      if (!p.title) p.title = r.title || '';
    }
    if (points && !p.points.length) throw new Error('Добавете поне една точка.');
    return p;
  };
  const status = h('p', { class: 'small muted' }, existing ? 'Изх. № ' + existing.outNo + ' се запазва.' : mainNo(d) ? 'Изх. № ' + mainNo(d) + '-N (главният номер на преписката с пореден индекс) се дава при записване.' : 'Главният Изх. № на преписката (' + (org.outPrefix || 'ЗДОИ') + '-ГГГГ-NNNN) се дава при записване; следващите документи ще са със същия номер и индекс.');
  const save = async (form, then) => {
    const p = collect(form);
    status.textContent = 'Записване…';
    const res = await api('doc.reserve', { regNo: r.regNo, kind, title: isAddr ? 'Промяна на адреса за кореспонденция' : (p.title || kind), payload: p, outNo: existing ? existing.outNo : '' });
    Object.assign(p, { outNo: res.outNo, date: res.date });
    status.textContent = 'Генериране на PDF…';
    const pdf = await Docs.base64Of(Docs.DEFS[kind](p));
    await api('doc.file', { outNo: res.outNo, pdf });
    toast(kind + ' изх. № ' + res.outNo + ' е записано.');
    dlg.close();
    if (then === 'send') { const fresh = await api('req.get', { regNo: r.regNo }); composeDialog(fresh, { docs: [res.outNo] }); requestView(r.regNo); }
    else { await Docs.open(Docs.DEFS[kind](p), res.outNo + ' ' + kind + '.pdf'); requestView(r.regNo); }
  };
  const form = h('form', null, fields, status, h('div', { class: 'actions' },
    h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Отказ'),
    h('button', { type: 'button', class: 'btn', onclick: async () => { try { const p = collect(form); await Docs.preview(Docs.DEFS[kind](Object.assign(p, { outNo: existing ? existing.outNo : '(чернова)', date: todayIso() }))); } catch (e) { toast(e.message); } } }, 'Преглед'),
    h('button', { type: 'submit', class: 'btn' }, 'Запиши и свали PDF'),
    h('button', { type: 'button', class: 'btn primary', onclick: async e => { e.target.disabled = true; try { await save(form, 'send'); } catch (ex) { toast(ex.message); status.textContent = ex.message; } finally { e.target.disabled = false; } } }, 'Запиши и изпрати')));
  const dlg = dialog((existing ? 'Редакция: ' : 'Ново: ') + kind + (existing ? ' ' + existing.outNo : ''), form, { wide: true });
  // по инициатива на заявителя няма писмо на субекта
  if (kind === 'Уточнение') {
    const sync = () => { const own = form.elements.clarifyBy.value === Docs.CLARIFY_BY[1]; ['ref_letterNo', 'ref_letterDate'].forEach(n => { form.elements[n].closest('label').hidden = own; form.elements[n].disabled = own; }); };
    form.elements.clarifyBy.addEventListener('change', sync); sync();
  }
  onSubmit(form, async () => { await save(form, 'download'); });
}

/* ---------- подпис с КЕП (смарт карта през B-Trust BISS) ---------- */

const BISS_URL = 'https://www.b-trust.bg/services/software';

const bissMissing = () => h('div', { class: 'stack' },
  h('p', null, 'За КЕП на смарт карта е нужна безплатната програма B-Trust BISS. Тя работи и с карти на InfoNotary, StampIT и други доставчици.'),
  h('ol', { class: 'small' }, h('li', null, 'Изтеглете и инсталирайте BISS (нужни са администраторски права).'), h('li', null, 'Включете четеца с картата и стартирайте BISS (иконка до часовника).'),
    h('li', null, 'Ако картата не е от B-Trust, инсталирайте и удостоверителните вериги на вашия доставчик.'), h('li', null, 'Ако браузърът попита за достъп до устройства в локалната мрежа – разрешете.')),
  h('a', { class: 'btn primary', href: BISS_URL, target: '_blank', rel: 'noopener' }, 'Изтегли BISS'));

/* вход (mode 'login') или свързване към профила ('link') с КЕП */
async function kepFlow(mode) {
  const login = mode === 'login';
  const status = h('p', { class: 'small muted' }, 'Търсене на BISS на този компютър…');
  const body = h('div', { class: 'stack' }, status);
  const dlg = dialog(login ? 'Вход с КЕП' : 'Свързване на КЕП', h('div', null, body, h('div', { class: 'actions mt-12' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Затвори'))), {});
  try {
    const biss = await Kep.findBiss();
    if (!biss) { body.replaceChildren(h('p', { class: 'err' }, 'Не е намерена програмата за подписване BISS.'), bissMissing()); return; }
    status.textContent = 'Изберете сертификата от картата в прозореца на BISS…';
    const signer = await Kep.chooseSigner(biss.port);
    status.textContent = signer.cert.name + ' (' + signer.cert.issuerName + ') – въведете ПИН кода в прозореца на BISS…';
    const ch = await api(login ? 'kep.challenge' : 'kep.linkChallenge');
    const proof = await Kep.signChallenge(biss.port, signer, ch);
    status.textContent = 'Проверка на удостоверението при доставчика…';
    const r = await api(login ? 'kep.login' : 'kep.link', proof);
    dlg.close();
    if (login) { await startSession(r.me); location.hash = '#/dashboard'; route(); }
    else { toast('КЕП на ' + r.name + ' е свързан.'); profileView(); }
  } catch (e) { body.replaceChildren(h('p', { class: 'err' }, e.name === 'AbortError' ? 'BISS не отговори навреме.' : e.message)); }
}

async function kepSign(d, x) {
  const r = d.request;
  const status = h('p', { class: 'small muted' }, 'Търсене на BISS на този компютър…');
  const body = h('div', { class: 'stack' }, status);
  const close = h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Затвори');
  const dlg = dialog('Подпис с КЕП – ' + x.kind + ' изх. № ' + x.outNo, h('div', null, body, h('div', { class: 'actions mt-12' }, close)), {});
  const fail = (msg, extra) => { body.replaceChildren(h('p', { class: 'err' }, msg), extra || ''); };
  try {
    const biss = await Kep.findBiss();
    if (!biss) {
      return fail('Не е намерена програмата за подписване BISS.', bissMissing());
    }
    status.textContent = 'BISS ' + biss.version + ' е намерен. Изберете сертификата от картата в прозореца на BISS…';
    const signer = await Kep.chooseSigner(biss.port);
    const c = signer.cert;
    const go = h('button', { type: 'button', class: 'btn primary' }, '✍ Подпиши');
    body.replaceChildren(kv([
      ['Подписващ', c.name], c.org ? ['Организация', c.org] : null, ['Издател', c.issuerName],
      ['Вид', c.qualified ? 'Квалифициран електронен подпис' : 'Електронен подпис (не е отбелязан като квалифициран)'],
      ['Валиден до', c.notAfter ? c.notAfter.toLocaleDateString('bg-BG') : '—']
    ]), c.qualified ? null : h('p', { class: 'note' }, 'Сертификатът не съдържа отметка за квалифициран подпис. Проверете дали е избран правилният сертификат.'),
    h('p', { class: 'small muted' }, 'В PDF-а ще бъде поставен печат с името от сертификата, а подписът ще бъде вграден във файла (PAdES). След подписване документът не може да се редактира.'), h('div', { class: 'actions' }, go));
    go.onclick = async () => {
      go.disabled = true;
      const step = h('p', { class: 'small' }, '');
      body.append(step);
      try {
        step.textContent = 'Генериране на документа с печата…';
        const p = Object.assign({}, x.payload, { outNo: x.outNo, date: x.date, kep: { name: c.name + (c.org ? ', ' + c.org : ''), issuer: c.issuerName, at: new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Sofia' }).replace(' ', 'T') } });
        const pdfBytes = new Uint8Array(await (await Docs.blobOf(Docs.DEFS[x.kind](p))).arrayBuffer());
        const signed = await Kep.signPdf({
          port: biss.port, signer, pdfBytes, outNo: x.outNo, onStep: t => { step.textContent = t; },
          authorize: content => api('kep.authorize', { outNo: x.outNo, content })
        });
        step.textContent = 'Проверка на подписа и в регистъра на доставчика (OCSP/CRL)…';
        let bin = '';
        for (let i = 0; i < signed.length; i += 0x8000) bin += String.fromCharCode.apply(null, signed.subarray(i, i + 0x8000));
        const res = await api('kep.complete', { outNo: x.outNo, pdf: btoa(bin) });
        dlg.close();
        const rv = res.signature.rev || {};
        toast('Подписано от ' + res.signature.name + '.' + (rv.status === 'good' ? ' Удостоверението е валидно според ' + rv.method + ' на доставчика.' : ' Статусът в регистъра на доставчика не е проверен.'));
        requestView(r.regNo);
      } catch (e) { step.className = 'err'; step.textContent = e.message; go.disabled = false; }
    };
  } catch (e) { fail(e.name === 'AbortError' ? 'BISS не отговори навреме.' : e.message); }
}

/* ---------- подаване през ССЕВ от профила на Сдружението (без API: файлът и текстът се подготвят, номерът се записва) ---------- */

const SSEV_URL = 'https://edelivery.egov.bg/';

function ssevDialog(d, x) {
  const r = d.request, ent = r.entity || {}, sig = x.payload._sig, org = d.person || boot.org;
  const subject = '[' + r.regNo + '] ' + x.kind + ' изх. № ' + x.outNo + (r.title ? ' – ' + r.title : '');
  const text = 'Уважаеми господин/госпожо,\n\nПриложено подаваме ' + x.kind.toLowerCase() + ' изх. № ' + x.outNo +
    (r.mode === 'Клиент' ? ' от името на ' + (r.applicant.name || '') + ' чрез ' + org.name + ' като пълномощник' : '') + '.\n\n' +
    'Молим отговорите и решенията по преписката да бъдат изпращани чрез ССЕВ до профила на ' + org.name + ' или на имейл ' + d.replyTo + '.\n\n' +
    'С уважение,\n' + (org.rep ? org.rep + '\n' : '') + org.name;
  const copy = (val, label) => h('button', { type: 'button', class: 'btn sm', onclick: async () => {
    try { await navigator.clipboard.writeText(val); toast(label + ' е копиран.'); } catch (_) { toast('Копирането не е разрешено – маркирайте текста ръчно.'); }
  } }, 'Копирай');
  const idText = ent.eik ? Docs.idLabel(ent.regBasis) + ' ' + ent.eik : '';
  const pdfName = x.outNo + ' ' + x.kind + (sig ? ' (подписан)' : '') + '.pdf';
  const steps = h('ol', { class: 'stack ssev-steps' },
    h('li', null, h('b', null, 'Свалете документа'), h('br'), sig ? h('span', { class: 'small muted' }, 'Подписан с КЕП от ' + sig.name + '.') : h('span', { class: 'small warn-text' }, 'Документът не е подписан с КЕП. Съобщението в ССЕВ е от профила на ' + org.name + ', но подписаният файл е по-сигурен като доказателство.'),
      h('div', { class: 'actions mt-8' }, h('button', { type: 'button', class: 'btn sm primary', onclick: async () => { try { const f = await api('doc.download', { outNo: x.outNo }); downloadB64(pdfName, f.data, 'application/pdf'); } catch (e) { toast(e.message); } } }, 'Свали ' + pdfName),
        !sig ? h('button', { type: 'button', class: 'btn sm', onclick: () => { dlg.close(); kepSign(d, x); } }, '✍ Първо подпиши с КЕП') : null)),
    h('li', null, h('b', null, 'Влезте в ССЕВ с КЕП и изберете профила на ' + org.name), h('div', { class: 'actions mt-8' }, h('a', { class: 'btn sm', href: SSEV_URL, target: '_blank', rel: 'noopener' }, 'Отвори edelivery.egov.bg'))),
    h('li', null, h('b', null, 'Ново съобщение до получателя'), h('br'), h('span', null, ent.name || '—'), idText ? [h('br'), h('span', { class: 'mono small' }, idText), ' ', copy(ent.eik, 'Номерът')] : h('span', { class: 'small muted' }, ' (без ЕИК/БУЛСТАТ в преписката – потърсете по наименование)')),
    h('li', null, h('b', null, 'Тема и текст'), h('div', { class: 'pre small ssev-box' }, subject), h('div', { class: 'actions mt-8' }, copy(subject, 'Темата')),
      h('div', { class: 'pre small ssev-box' }, text), h('div', { class: 'actions mt-8' }, copy(text, 'Текстът'))),
    h('li', null, h('b', null, 'Прикачете свалeния PDF и изпратете')));
  const form = h('form', null, steps,
    h('h3', { class: 'mt-16' }, 'След изпращането'),
    h('div', { class: 'form-grid' },
      field({ k: 'ref', label: 'Номер (идентификатор) на съобщението в ССЕВ', req: true, max: 120 }),
      field({ k: 'date', label: 'Дата на изпращане', type: 'date', req: true, maxValue: todayIso() }, todayIso())),
    h('p', { class: 'note' }, 'Отговорите идват по имейл: ССЕВ изпраща известие на имейла на профила, системата го разпознава и отбелязва в преписката. Задайте ' + d.mailbox + ' като имейл за известия в профила.'),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Затвори'), h('button', { type: 'submit', class: 'btn primary' }, 'Отбележи като подадено')));
  const dlg = dialog('Подаване през ССЕВ – ' + x.kind + ' ' + x.outNo, form, { wide: true });
  onSubmit(form, async v => {
    await api('mail.record', { regNo: r.regNo, direction: 'Изходяща', channel: 'Сигурно електронно връчване', date: v.date, ref: v.ref, party: ent.name + (idText ? ', ' + idText : ''),
      subject, note: 'Подадено от профила на ' + org.name + ' в ССЕВ.', docs: [x.outNo] });
    dlg.close();
    toast('Подаването през ССЕВ е отбелязано.');
    requestView(r.regNo);
  });
}

/* ---------- страница „Проверка на КЕП“: сертификатът от картата, тестов подпис, проверка на подписан PDF ---------- */

const yes = (ok, text, warn) => h('span', { class: 'pill ' + (ok === true ? 'ok' : ok === false ? 'bad' : 'warn') }, (ok === true ? '✔ ' : ok === false ? '✖ ' : '! ') + text + (warn ? '' : ''));
const isoDay = s => (s ? fmtDate(s) : '—');

function revPill(r) {
  if (!r) return yes(null, 'не е проверено');
  if (r.status === 'good') return yes(true, 'валидно според ' + r.method + ' на доставчика');
  if (r.status === 'revoked') return yes(false, 'ПРЕКРАТЕНО/СПРЯНО' + (r.reason ? ' (' + r.reason + ')' : '') + (r.revokedAt ? ' от ' + fmtTime(r.revokedAt) : '') + ' – ' + r.method);
  return yes(null, 'не е проверено' + (r.note ? ': ' + r.note : ''));
}

function certTable(c) {
  return kv([
    ['Титуляр', c.name + (c.org ? ' · ' + c.org : '')],
    c.id ? ['Идентификатор', c.id] : null,
    ['Издател', c.issuer],
    ['Валидност', h('span', null, isoDay(c.notBefore) + ' – ' + isoDay(c.notAfter) + ' ', yes(c.inDate, c.inDate ? 'в срок' : 'извън срока'))],
    ['Квалифициран (QcCompliance)', yes(c.qualified, c.qualified ? 'да' : 'не е отбелязан')],
    ['Квалифицирано устройство (QSCD)', yes(c.sscd ? true : null, c.sscd ? 'да' : 'не е отбелязано')],
    ['Регистър на доставчика', revPill(c.rev)],
    ['Ключ', c.keyAlg]
  ]);
}

function sigReport(list) {
  if (!list.length) return h('p', { class: 'err' }, 'Във файла няма електронен подпис.');
  return h('div', { class: 'stack' }, list.map((s, i) => h('section', { class: 'card stack' },
    h('div', { class: 'head m-0' }, h('h3', { class: 'm-0' }, 'Подпис ' + (i + 1) + (s.cert ? ': ' + s.cert.name : '')),
      !s.ok ? yes(false, 'невалиден или с проблем') : s.cert.qualified ? yes(true, 'валиден КЕП') : yes(null, 'валиден подпис, но не е квалифициран (КЕП)')),
    s.error ? h('p', { class: 'err' }, s.error) : [
      kv([
        ['Документът не е променян', yes(s.checks.integrity, s.checks.integrity ? 'хешът съвпада' : 'съдържанието е променено след подписа')],
        ['Подпис', yes(s.checks.signature, s.checks.signature ? 'математически валиден' : 'невалиден')],
        ['Обхват', yes(s.checks.coversAll ? true : null, s.checks.coversAll ? 'целият файл' : 'версията до този подпис (файлът е допълван след него)')],
        ['Време на подписване', s.time ? fmtTime(s.time) + ' · ' + s.timeSource : '—'],
        ['Формат', s.subFilter || '—']
      ]),
      h('h4', { class: 'm-0' }, 'Сертификат'), certTable(s.cert)
    ])));
}

async function kepView() {
  const certOut = h('div', { class: 'stack' }), testOut = h('div', { class: 'stack' }), fileOut = h('div', { class: 'stack' });
  const findBiss = async out => {
    out.replaceChildren(h('p', { class: 'small muted' }, 'Търсене на BISS…'));
    const b = await Kep.findBiss();
    if (!b) { out.replaceChildren(h('p', { class: 'err' }, 'Не е намерена програмата за подписване BISS.'), bissMissing()); return null; }
    return b;
  };
  const busy = async (btn, out, fn) => { btn.disabled = true; try { await fn(); } catch (e) { out.replaceChildren(h('p', { class: 'err' }, e.name === 'AbortError' ? 'BISS не отговори навреме.' : e.message)); } finally { btn.disabled = false; } };

  const certBtn = h('button', { class: 'btn primary', onclick: () => busy(certBtn, certOut, async () => {
    const b = await findBiss(certOut); if (!b) return;
    certOut.replaceChildren(h('p', { class: 'small muted' }, 'Изберете сертификата в прозореца на BISS…'));
    const signer = await Kep.chooseSigner(b.port);
    certOut.replaceChildren(h('p', { class: 'small muted' }, 'Проверка при доставчика (OCSP/CRL)…'));
    const r = await api('kep.checkCert', { chain: signer.chain.map(x => btoaBytes(x)) });
    certOut.replaceChildren(h('p', { class: 'small muted' }, 'BISS ' + b.version + ' · без въвеждане на ПИН'), certTable(r.cert));
  }) }, 'Провери сертификата от картата');

  const testBtn = h('button', { class: 'btn primary', onclick: () => busy(testBtn, testOut, async () => {
    const b = await findBiss(testOut); if (!b) return;
    testOut.replaceChildren(h('p', { class: 'small muted' }, 'Изберете сертификата в прозореца на BISS…'));
    const signer = await Kep.chooseSigner(b.port);
    const c = signer.cert, at = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Sofia' }).replace(' ', 'T');
    const def = Docs.DEFS['Писмо'](Object.assign({ org: boot.org, entity: { name: 'Тестов получател' }, title: 'Тестово подписване с КЕП', outNo: 'ТЕСТ', date: at.slice(0, 10), signMode: 'electronic',
      body: 'Това е тестов документ, създаден в ADM ЗДОИ4You за проверка на подписването с квалифициран електронен подпис. Той не е официален документ и не се пази в системата.',
      kep: { name: c.name + (c.org ? ', ' + c.org : ''), issuer: c.issuerName, at } }));
    const pdfBytes = new Uint8Array(await (await Docs.blobOf(def)).arrayBuffer());
    const step = h('p', { class: 'small muted' }, '');
    testOut.replaceChildren(step);
    const signed = await Kep.signPdf({ port: b.port, signer, pdfBytes, outNo: 'ТЕСТ', onStep: t => { step.textContent = t; }, authorize: content => api('kep.testAuthorize', { content }) });
    step.textContent = 'Проверка на подписания файл…';
    const r = await api('kep.verify', { pdf: btoaBytes(signed) });
    testOut.replaceChildren(h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => downloadB64('Тестов документ (подписан).pdf', btoaBytes(signed), 'application/pdf') }, 'Свали подписания тестов документ')),
      h('p', { class: 'small muted' }, 'Може да го отворите и в Adobe Reader или да го качите по-долу за повторна проверка.'), sigReport(r.signatures));
  }) }, '✍ Подпиши тестов документ');

  const fileIn = h('input', { type: 'file', accept: 'application/pdf' });
  const fileBtn = h('button', { class: 'btn primary', onclick: () => busy(fileBtn, fileOut, async () => {
    const f = fileIn.files[0];
    if (!f) throw new Error('Изберете PDF файл.');
    if (f.size > 8 * 1048576) throw new Error('Файлът е по-голям от 8 MB.');
    fileOut.replaceChildren(h('p', { class: 'small muted' }, 'Проверка на подписите и в регистрите на доставчиците…'));
    const r = await api('kep.verify', { pdf: await readFile64(f) });
    fileOut.replaceChildren(h('p', { class: 'small muted' }, f.name + ' · ' + Math.round(r.size / 1024) + ' KB · подписи: ' + r.signatures.length), sigReport(r.signatures));
  }) }, 'Провери');

  setView(head('Проверка на КЕП'), h('div', { class: 'stack' },
    h('p', { class: 'muted' }, 'Проверките не записват нищо в преписките. Регистърът на доставчика се проверява към днешна дата.'),
    h('div', { class: 'grid2' },
      h('section', { class: 'card stack' }, h('h2', null, 'Моят КЕП'), h('p', { class: 'small muted' }, 'Чете сертификата от картата през BISS и проверява срока, квалифицирания статус и регистъра на доставчика. Не изисква ПИН.'), h('div', { class: 'actions' }, certBtn), certOut),
      h('section', { class: 'card stack' }, h('h2', null, 'Тестово подписване'), h('p', { class: 'small muted' }, 'Подписва примерен документ с картата (ПИН в BISS) и веднага проверява резултата. Документът не се пази.'), h('div', { class: 'actions' }, testBtn), testOut)),
    h('section', { class: 'card stack' }, h('h2', null, 'Проверка на подписан PDF'), h('p', { class: 'small muted' }, 'Всеки PDF с електронен подпис (PAdES), например получено решение или подписан от нас документ.'),
      h('div', { class: 'actions' }, fileIn, fileBtn), fileOut)));
}

function btoaBytes(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ---------- имейл от приемната ---------- */

function composeDialog(d, { docs = [], reply = null } = {}) {
  const r = d.request;
  const withFile = d.docs.filter(x => x.fileId);
  const kinds = withFile.filter(x => docs.includes(x.outNo)).map(x => x.kind + ' изх. № ' + x.outNo);
  const fromAddr = reply ? (/[^\s(]+@[^\s)]+/.exec(reply.from) || [''])[0] : (r.entity.email || '');
  const subject = reply ? (/^re:/i.test(reply.subject) ? reply.subject : 'RE: ' + reply.subject) + (reply.subject.includes(r.regNo) ? '' : ' [' + r.regNo + ']')
    : `[${r.regNo}] ${kinds.length ? kinds.join(', ') : 'Кореспонденция'}${r.title ? ' – ' + r.title : ''}`;
  const org = d.person || boot.org;
  const sign = `\n\nС уважение,\n${org.rep ? org.rep + '\n' : ''}${org.brand ? org.brand + ' · ' : ''}${org.name}${org.web ? '\n' + org.web : ''}`;
  const text = reply ? `Уважаеми господин/госпожо,\n\n` + sign
    : kinds.length ? `Уважаеми господин/госпожо,\n\nПриложено изпращаме ${kinds.join(' и ')}${r.mode === 'Клиент' ? ' от името на ' + r.applicant.name : ''}.\n\nМолим отговорите и решенията по преписката да бъдат изпращани на ${d.replyTo}.` + sign
      : `Уважаеми господин/госпожо,\n\n` + sign;
  const docBoxes = withFile.length ? h('div', { class: 'field full' }, h('span', null, 'Прикачи документи (PDF)'),
    withFile.map(x => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'doc_' + x.outNo, checked: docs.includes(x.outNo) }), h('span', null, x.outNo + ' – ' + x.kind + (x.sentAt ? ' (изпратен ' + fmtDate(x.sentAt) + ')' : ''))))) : null;
  // кога: веднага или насрочено (дата и час в София); показва дали денят е работен
  const now = sofiaNow();
  const whenSel = h('select', { name: '_when', 'aria-label': 'Кога' }, h('option', { value: 'now' }, 'Веднага'), h('option', { value: 'later' }, 'Насрочи за дата и час'));
  const nextWd = nextWorkday(now.iso);
  const atIn = h('input', { type: 'datetime-local', name: '_at', min: now.iso + 'T' + now.time, value: nextWd + 'T09:00', step: 300 });
  const dayNote = h('small', { class: 'day-note' });
  const quick = (label, iso, hm) => h('button', { type: 'button', class: 'btn sm', onclick: () => { atIn.value = iso + 'T' + hm; syncWhen(); } }, label);
  const atBox = h('div', { class: 'stack when-box', hidden: true },
    h('label', { class: 'field' }, h('span', null, 'Дата и час на изпращане (софийско време)'), atIn, dayNote),
    h('div', { class: 'actions' }, quick('Следващия работен ден 9:00', nextWd, '09:00'), quick('След 3 работни дни 9:00', nextWorkday(nextWorkday(nextWd)), '09:00'),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { const dd = (atIn.value || '').slice(0, 10); if (dd) { atIn.value = nextWorkday(dd, true) + 'T' + ((atIn.value || '').slice(11, 16) || '09:00'); syncWhen(); } } }, 'Към работен ден')),
    h('p', { class: 'small muted' }, 'Писмото се записва като „Насрочено“ в кореспонденцията и се изпраща автоматично в избрания момент (до 5 минути по-късно). Може да се отмени дотогава. Сроковете тръгват от действителното изпращане.'));
  const syncWhen = () => {
    const later = whenSel.value === 'later';
    atBox.hidden = !later;
    const btn = dlgEl && dlgEl.querySelector('button[type=submit]');
    if (btn) btn.textContent = later ? 'Насрочи' : 'Изпрати';
    const v = atIn.value || '', info = v ? dayInfo(v.slice(0, 10)) : null;
    dayNote.textContent = info ? (info.workday ? '✔ ' : '⚠ ') + fmtDate(v.slice(0, 10)) + ' е ' + info.label + (info.workday ? '' : ' – субектът ще го получи в неработен ден; сроковете не се влияят от това.') : '';
    dayNote.className = 'day-note ' + (info && !info.workday ? 'warn-text' : 'muted');
  };
  whenSel.addEventListener('change', syncWhen); atIn.addEventListener('input', syncWhen);
  let dlgEl = null;
  dlgEl = formDialog(reply ? 'Отговор' : 'Писмо по ' + r.regNo, [
    { k: 'to', label: 'До', req: true, max: 600, full: true, hint: 'Няколко адреса се разделят със запетая.' },
    { k: 'cc', label: 'Копие', max: 600, full: true },
    { k: 'subject', label: 'Тема', req: true, max: 250, full: true },
    { k: 'text', label: 'Текст', type: 'textarea', rows: 12, req: true, max: 30000, full: true }
  ], { to: fromAddr, subject, text }, 'Изпрати', async (v, form) => {
    const chosen = withFile.filter(x => form.elements['doc_' + x.outNo] && form.elements['doc_' + x.outNo].checked).map(x => x.outNo);
    const later = whenSel.value === 'later';
    if (later && !atIn.value) throw new Error('Изберете дата и час на изпращане.');
    const res = await api('mail.send', { regNo: r.regNo, to: v.to, cc: v.cc, subject: v.subject, text: v.text, docs: chosen, replyTo: reply ? reply._id : '', sendAt: later ? atIn.value : '' });
    toast(res.scheduled ? 'Насрочено за ' + fmtTime(res.at) + '.' : 'Изпратено. Отговорите идват на ' + res.replyTo + '.');
    requestView(r.regNo);
  }, { wide: true, extra: h('div', { class: 'stack mt-12' }, docBoxes, h('div', { class: 'field' }, h('span', null, 'Кога да се изпрати'), whenSel), atBox, h('p', { class: 'note' }, 'Изпраща се от ' + d.mailbox + ' с адрес за отговор ' + d.replyTo + '. Копие остава в „Изпратени“ на кутията.')) });
}

/* ---------- изпращане и получаване извън имейла: ССЕВ, поща, лично в деловодството ---------- */

/* писма, които още не са изпратени (насрочени, в процес или неуспешни) */
const PENDING = ['Насрочена', 'Изпраща се', 'Неизпратена'];
const CHANNEL_SHORT = { 'Сигурно електронно връчване': 'ССЕВ', 'Поща': 'Поща', 'Куриер': 'Куриер', 'На място': 'Лично в деловодството', 'Платформа за достъп (чл. 15в)': 'Платформа', 'Имейл': 'Имейл (друг адрес)' };
const CHANNEL_LABEL = { 'На място': 'Лично в деловодството (на място)', 'Имейл': 'Имейл от друг адрес (не през системата)', 'Сигурно електронно връчване': 'ССЕВ – Система за сигурно електронно връчване' };
/* въведените ръчно записи имат само дата (без час) */
const whenOf = iso => /T00:00:00$/.test(iso || '') ? fmtDate(iso) : fmtTime(iso);
/* каналът на записа; празно за обикновен имейл през системата */
const chanOf = m => (!m.channel || (m.channel === 'Имейл' && !String(m.messageId || '').startsWith('rec:'))) ? '' : CHANNEL_SHORT[m.channel] || m.channel;

function readFile64(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).replace(/^data:[^,]*,/, ''));
    fr.onerror = () => rej(new Error('Файлът не може да се прочете.'));
    fr.readAsDataURL(file);
  });
}

function recordDialog(d, direction, docs) {
  const r = d.request, out = direction === 'Изходяща', ent = r.entity || {};
  const refLabel = {
    'Сигурно електронно връчване': ['Идентификатор на съобщението в ССЕВ', 'От потвърждението в edelivery.egov.bg.'],
    'Поща': ['№ на пратката', 'Баркод от разписката, напр. RR123456789BG.'],
    'Куриер': ['№ на товарителницата', ''],
    'На място': [out ? 'Име на служителя, приел документа' : 'Изх. № на писмото', ''],
    'Платформа за достъп (чл. 15в)': [out ? '№ на заявлението в платформата' : '№ в платформата', ''],
    'Имейл': [out ? 'Изпратено от адрес' : 'Изх. № на писмото', '']
  };
  const chSel = field({ k: 'channel', label: out ? 'Начин на изпращане' : 'Получено чрез', type: 'select', req: true, options: boot.lists.channels.map(c => [c, CHANNEL_LABEL[c] || c]) }, out ? 'Сигурно електронно връчване' : 'Поща');
  const postSel = field({ k: 'postKind', label: 'Вид пратка', type: 'select', options: boot.lists.postKinds }, boot.lists.postKinds[0]);
  const refField = field({ k: 'ref', label: '', max: 120 });
  const regNo = out ? field({ k: 'entityRegNo', label: 'Вх. № при субекта', max: 60 }) : null;
  const regDate = out ? field({ k: 'entityRegDate', label: 'Вх. дата при субекта', type: 'date', hint: 'Срокът по чл. 28 ЗДОИ тече от регистрирането.' }) : null;
  const fileIn = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png' });
  const all = d.docs;
  const docBoxes = out && all.length ? h('div', { class: 'field full' }, h('span', null, 'Изпратени документи'),
    all.map(x => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'doc_' + x.outNo, checked: docs.includes(x.outNo) }),
      h('span', null, x.outNo + ' – ' + x.kind + (x.sentAt ? ' (вече изпратен ' + whenOf(x.sentAt) + ' – ' + (x.sentHow || '') + ')' : ''))))) : null;
  const form = h('form', null,
    h('div', { class: 'form-grid' },
      chSel, field({ k: 'date', label: out ? 'Дата на изпращане / подаване' : 'Дата на получаване', type: 'date', req: true, maxValue: todayIso() }, todayIso()),
      postSel, refField, regNo, regDate,
      field({ k: 'party', label: out ? 'Адресат' : 'Подател', max: 400, full: true, hint: out ? 'Наименование и адрес, ако е по пощата.' : '' },
        out ? [ent.name, ent.address].filter(Boolean).join(', ') : ent.name || ''),
      field({ k: 'subject', label: 'Относно', max: 250, full: true, req: !out, hint: out ? 'Ако е празно – видът и Изх. № на избраните документи.' : 'Напр. „Решение № 12 от 10.11.2026 г.“ или „Искане за уточняване“.' }),
      field({ k: 'note', label: 'Бележка', type: 'textarea', rows: 2, max: 8000, full: true }),
      docBoxes,
      h('label', { class: 'field full' }, h('span', null, out ? 'Доказателство (по желание)' : 'Сканирано писмо (по желание)'), fileIn,
        h('small', null, out ? 'Обратна разписка, потвърждение от ССЕВ, копие с входящ печат – PDF, JPG или PNG до 8 MB.' : 'PDF, JPG или PNG до 8 MB.'))),
    h('p', { class: 'note' }, out ? 'Отбелязаното заявление или уточнение става „изпратено“ и сроковете тръгват от посочената дата. Ако документът вече е изпратен (напр. и по имейл), сроковете не се местят.'
      : 'Писмото се записва в кореспонденцията на преписката. Решение, искане за уточняване или удължаване на срока въведете и в „Ход и решение“.'),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Отказ'), h('button', { type: 'submit', class: 'btn primary' }, 'Запиши')));
  const sync = () => {
    const ch = form.elements.channel.value, [lab, hint] = refLabel[ch] || ['Идентификатор', ''];
    refField.querySelector('span').textContent = lab;
    const sm = refField.querySelector('small') || refField.appendChild(h('small'));
    sm.textContent = hint;
    postSel.hidden = !(ch === 'Поща' || ch === 'Куриер');
    form.elements.postKind.disabled = postSel.hidden;
  };
  form.elements.channel.addEventListener('change', sync);
  sync();
  const dlg = dialog((out ? 'Отбелязване на изпращане – ' : 'Получено писмо – ') + r.regNo, form, { wide: true });
  onSubmit(form, async v => {
    const chosen = all.filter(x => form.elements['doc_' + x.outNo] && form.elements['doc_' + x.outNo].checked).map(x => x.outNo);
    if (out && !chosen.length && !v.subject) throw new Error('Изберете документ или попълнете „Относно“.');
    let file = null;
    const f = fileIn.files[0];
    if (f) {
      if (f.size > 8 * 1048576) throw new Error('Файлът е по-голям от 8 MB.');
      file = { name: f.name, contentType: f.type, data: await readFile64(f) };
    }
    await api('mail.record', { regNo: r.regNo, direction, channel: v.channel, date: v.date, postKind: v.postKind || '', ref: v.ref, party: v.party, subject: v.subject, note: v.note,
      entityRegNo: v.entityRegNo || '', entityRegDate: v.entityRegDate || '', docs: chosen, file });
    toast(out ? 'Изпращането е отбелязано.' : 'Писмото е регистрирано.');
    dlg.close();
    requestView(r.regNo);
  });
}

/* ---------- досие за съда ---------- */

const generated = () => ({ generatedAt: new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Sofia' }).replace(' ', 'T'), generatedBy: me.name + ' (' + me.username + ')' });

async function reqDossier(d) {
  const r = d.request, ent = r.entity, ap = r.applicant, org = d.person || boot.org;
  try {
    await Docs.open(Docs.dossierDef(Object.assign({
      org, title: 'ДОСИЕ НА ПРЕПИСКА ' + r.regNo, subtitle: (r.kind || '') + (r.title ? ' – ' + r.title : ''),
      sections: [
        { heading: 'Страни', kv: [
          ['Заявител', r.mode === 'Клиент' ? [ap.name, ap.eik ? Docs.idLabel(ap.regBasis) + ' ' + ap.eik : '', ap.address, ap.email].filter(Boolean).join(', ') + ' – чрез пълномощник ' + org.name : org.name + (org.eik ? ', ' + Docs.idLabel(org.regBasis) + ' ' + org.eik : '')],
          ['Задължен субект', [ent.name, ent.eik ? Docs.idLabel(ent.regBasis) + ' ' + ent.eik : '', ent.address, ent.email].filter(Boolean).join(', ')],
          ['Адрес за кореспонденция', d.replyTo]] },
        { heading: 'Искана информация', table: { head: ['№', 'Точка'], rows: r.points.map((p, i) => [i + 1, p]), widths: [20, '*'] } },
        r.motives ? { heading: 'Мотиви', text: r.motives } : null,
        { heading: 'Ход и срокове', kv: [
          ['Статус', r.status], ['Изх. № на заявлението', r.outNo], ['Изпратено', r.sentAt ? fmtDate(r.sentAt) + (r.sentHow ? ' – ' + (r.sentHow === 'На място' ? 'лично в деловодството' : r.sentHow) : '') : ''],
          ['Вх. № при субекта', r.entityRegNo ? r.entityRegNo + (r.entityRegDate ? ' от ' + fmtDate(r.entityRegDate) : '') : ''],
          ['Поискано уточняване', fmtDate(r.clarifyAskedAt)], ['Изпратено уточнение', fmtDate(r.clarifySentAt)],
          ['Удължаване', [r.ext30 ? 'чл. 30: ' + r.ext30 + ' дни' : '', r.ext31 ? 'чл. 31: ' + r.ext31 + ' дни' : ''].filter(Boolean).join('; ')],
          ['Срок за отговор', r.due ? fmtDate(r.due) + ' (' + r.dueLabel + ')' : ''],
          ['Мълчалив отказ – обжалване до', r.silentBy && r.daysLeft < 0 ? fmtDate(r.silentBy) : ''],
          ['Решение', r.decisionNo ? '№ ' + r.decisionNo + ' от ' + fmtDate(r.decisionDate) : ''], ['Резултат', r.outcome],
          ['Решението е получено (връчено) на', fmtDate(r.servedAt)], ['Срок за обжалване', r.appealBy ? fmtDate(r.appealBy) : ''],
          ['Обжалвано', r.appealed === 'Да' ? 'Да' + (r.appealNote ? ' – ' + r.appealNote : '') : 'Не']] },
        { heading: 'Документи', table: { head: ['Изх. №', 'Вид', 'Дата', 'Изпратен на', 'Начин и получател'], rows: d.docs.slice().reverse().map(x => [x.outNo, x.kind, fmtDate(x.date), x.sentAt ? whenOf(x.sentAt) : 'неизпратен', x.sentTo || '']), widths: [80, 60, 55, 70, '*'] } },
        { heading: 'Кореспонденция (връчвания и отговори)', blocks: d.mail.filter(m => !PENDING.includes(m.direction)).sort((a, b) => String(a.at).localeCompare(String(b.at))).map(m => ({
          head: `${m.direction} · ${chanOf(m) || 'Имейл'} · ${whenOf(m.at)} · от ${m.from} до ${m.to}${m.ref ? ' · ' + m.ref : ''} · ${m.subject}`,
          text: (m.body || '').slice(0, 6000) + (m.attachments.length ? '\nПрикачени: ' + m.attachments.map(a => a.name).join(', ') : '') + (m.docOutNo ? '\nДокументи: ' + m.docOutNo : '') })) },
        { heading: 'Съдебни дела', table: { head: ['Съд', 'Дело', 'Вид', 'Статус', 'Заседание'], rows: d.courts.map(x => [x.court, x.caseNo + '/' + x.year, x.kind, x.status, fmtDate(x.nextHearing)]), widths: ['*', 50, 90, 70, 60] } },
        { heading: 'История', table: { head: ['Време', 'Потребител', 'Действие', 'Описание'], rows: d.events.slice().reverse().map(e => [fmtTime(e.at), e.user, e.kind, e.text]), widths: [70, 60, 70, '*'] } }
      ].filter(Boolean)
    }, generated())), 'Досие ' + r.regNo + '.pdf');
  } catch (e) { toast(e.message); }
}

async function caseDossier(d) {
  const c = d.case;
  try {
    await Docs.open(Docs.dossierDef(Object.assign({
      org: boot.org, title: 'ДОСИЕ НА ПРЕПИСКА ' + c.regNo, subtitle: 'Получено заявление – ' + c.kind,
      sections: [
        { heading: 'Заявление', kv: [['Регистрирано', fmtDate(c.regDate)], ['Начин на подаване', c.channel], ['Заявител', c.applicantName + ' (' + c.applicantType + ')'], ['ЕИК/БУЛСТАТ', c.applicantEik], ['Адрес', c.applicantAddress], ['Имейл', c.applicantEmail], ['Отговорник', userName(c.owner)]] },
        { heading: 'Искана информация', text: c.subject },
        { heading: 'Ход и решение', kv: [['Статус', c.status], ['Резултат', c.outcome], ['Уточняване', c.clarifyAsked ? 'поискано ' + fmtDate(c.clarifyAsked) + (c.clarifyGot ? ', получено ' + fmtDate(c.clarifyGot) : '') : ''],
          ['Решение', c.decisionNo ? '№ ' + c.decisionNo + ' от ' + fmtDate(c.decisionDate) : ''], ['Основания', c.grounds], ['Връчено', c.served ? fmtDate(c.served) + (c.servedHow ? ' – ' + c.servedHow : '') : ''],
          ['Срок за обжалване', c.appealBy ? fmtDate(c.appealBy) : ''], ['Обжалвано', c.appealed === 'Да' ? 'Да' + (c.appealNote ? ' – ' + c.appealNote : '') : 'Не']] },
        { heading: 'Съдебни дела', table: { head: ['Съд', 'Дело', 'Вид', 'Статус', 'Заседание'], rows: d.courts.map(x => [x.court, x.caseNo + '/' + x.year, x.kind, x.status, fmtDate(x.nextHearing)]), widths: ['*', 50, 90, 70, 60] } },
        { heading: 'История', table: { head: ['Време', 'Потребител', 'Действие', 'Описание'], rows: d.events.slice().reverse().map(e => [fmtTime(e.at), e.user, e.kind, e.text]), widths: [70, 60, 70, '*'] } }
      ]
    }, generated())), 'Досие ' + c.regNo + '.pdf');
  } catch (e) { toast(e.message); }
}

/* ---------- неразпределена поща ---------- */

async function mailInboxView() {
  loading();
  try {
    const [{ mail, boxes }, { requests }] = await Promise.all([api('mail.inbox', { person: curCode || '' }), api('req.list', { person: curCode || '' })]);
    const list = h('datalist', { id: 'req-nos' }, requests.map(r => h('option', { value: r.regNo }, r.regNo + ' – ' + r.entityName)));
    setView(head('Неразпределена поща'), list,
      h('p', { class: 'small muted mb-12' }, 'Писмата до ' + (boxes && boxes.length ? boxes.join(', ') : boot.mailbox) + ' се разпределят автоматично по етикета след „+“, по номера на преписката или Изх. № в темата, или по имейла на субекта. Тук са писмата, които не са разпознати.'),
      mail.length ? h('div', { class: 'stack' }, mail.map(m => {
        const input = h('input', { list: 'req-nos', placeholder: 'П-ГГГГ-NNNN', 'aria-label': 'Преписка' });
        return h('div', { class: 'card stack' },
          h('div', { class: 'small muted' }, fmtTime(m.at) + ' · от ' + m.from + ' · до ' + m.to + (boxes && boxes.length > 1 && m.box ? ' · кутия ' + m.box : '')),
          h('b', null, m.subject || '(без тема)'),
          h('details', null, h('summary', { class: 'small' }, 'Текст'), h('div', { class: 'pre small' }, m.body)),
          m.attachments.length ? h('div', { class: 'attach-chips' }, m.attachments.map((a, i) => a.fileId ? h('button', { class: 'btn sm', onclick: async () => { try { const f = await api('mail.attachment', { id: m._id, index: i }); downloadB64(f.name, f.data, f.contentType); } catch (e) { toast(e.message); } } }, '📎 ' + a.name) : h('span', { class: 'small muted' }, '📎 ' + a.name))) : null,
          can('mailbox') ? h('div', { class: 'filters m-0' }, input, h('button', { class: 'btn primary', onclick: async () => { try { await api('mail.assign', { id: m._id, regNo: input.value.trim() }); toast('Разпределено.'); mailInboxView(); } catch (e) { toast(e.message); } } }, 'Разпредели')) : null);
      })) : h('div', { class: 'card' }, h('p', { class: 'empty' }, 'Няма неразпределени писма.')));
  } catch (e) { failView(e); }
}

/* ---------- системни процеси ---------- */

/* КЕП: сертификатът, с който системата разрешава заявките към BISS (Let's Encrypt, подновява се сам) */
function kepCard() {
  const card = h('section', { class: 'card stack' }, h('h2', null, 'Подпис с КЕП'), h('p', { class: 'loading' }, 'Зареждане…'));
  const render = s => card.replaceChildren(h('h2', null, 'Подпис с КЕП'), kv([
    ['Програма на компютрите', 'B-Trust BISS (работи с карти на всички български доставчици)'],
    ['Сертификат на системата', s.has ? 'валиден до ' + fmtDate(s.notAfter) + ' (Let’s Encrypt, подновява се автоматично)' : 'още не е издаден'],
    ['Последен опит', s.last ? fmtTime(s.last.at.replace('Z', '')) + (s.last.error ? ' – грешка: ' + s.last.error : ' – успешен') : '—']
  ]), h('p', { class: 'small muted' }, 'С него системата потвърждава пред BISS, че заявката за подпис идва от adm.zdoi.eu. Подписът на документите е с картата на служителя.'),
  h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: async e => {
    e.target.disabled = true;
    try { const r = await api('kep.renew'); toast(r.error ? 'Грешка: ' + r.error : 'Сертификатът е подновен до ' + fmtDate(r.notAfter) + '.'); render(r); } catch (ex) { toast(ex.message); } finally { e.target.disabled = false; }
  } }, 'Поднови сега')));
  api('kep.status').then(render).catch(e => card.replaceChildren(h('h2', null, 'Подпис с КЕП'), h('p', { class: 'err' }, e.message)));
  return card;
}

/* настройки за вход с Google, Microsoft и Discord */
function oauthCard() {
  const card = h('section', { class: 'card stack' }, h('h2', null, 'Вход с външни профили'), h('p', { class: 'loading' }, 'Зареждане…'));
  api('oauth.settings').then(({ providers }) => {
    const list = providers.filter(p => p.id !== '_autoLink'), auto = providers.find(p => p.id === '_autoLink');
    const form = h('form', null, h('div', { class: 'stack' },
      list.map(p => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: p.id, checked: p.on && p.configured, disabled: !p.configured }),
        h('span', { class: 'oauth-line' }, providerIcon(p.id), h('span', null, p.label + (p.configured ? '' : ' (не е настроен)'), h('br'), h('span', { class: 'small muted mono' }, p.redirect))))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'autoLink', checked: auto.on }),
        h('span', null, 'Автоматично свързване по имейл', h('br'), h('span', { class: 'small muted' }, 'При първи вход профилът се свързва с потребителя, чийто имейл в системата съвпада с потвърдения имейл в профила.')))),
    h('p', { class: 'note mt-12' }, 'Нови потребители не се създават – външният вход пуска само активни служители, добавени от администратор.'),
    h('div', { class: 'actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Запази')));
    onSubmit(form, async v => { await api('oauth.save', Object.assign({}, ...list.map(p => ({ [p.id]: p.configured ? !!v[p.id] : true })), { autoLink: !!v.autoLink })); toast('Запазено.'); });
    card.replaceChildren(h('h2', null, 'Вход с външни профили'), form);
  }).catch(e => card.replaceChildren(h('h2', null, 'Вход с външни профили'), h('p', { class: 'err' }, e.message)));
  return card;
}

async function systemView() {
  loading();
  let s;
  try { s = await api('system.get', { person: curCode || '' }); } catch (e) { return failView(e); }
  const o = s.org, pn = s.person || {}, who = pn.name || 'Сдружението';
  const orgFields = [
    { k: 'name', label: 'Наименование', req: true, max: 250, full: true },
    { k: 'brand', label: 'Марка в бланката', max: 60 },
    { k: 'regBasis', label: 'Регистрация', type: 'select', options: boot.lists.regBasis.map(x => [x, x || '—']) },
    { k: 'eik', label: 'ЕИК/БУЛСТАТ', max: 13, pattern: '\\d{9}|\\d{13}' },
    { k: 'address', label: 'Седалище и адрес на управление', max: 400, full: true },
    { k: 'oblast', label: 'Област', max: 80 },
    { k: 'rep', label: 'Представлява се от', max: 160 },
    { k: 'repPosition', label: 'Качество', max: 160 },
    { k: 'phone', label: 'Телефон', max: 40 },
    { k: 'email', label: 'Имейл в бланката', type: 'email', max: 200 },
    { k: 'web', label: 'Интернет адрес в бланката', max: 120 },
    { k: 'place', label: 'Място по подразбиране', max: 80 }
  ];
  const orgForm = h('form', null, h('div', { class: 'form-grid' }, orgFields.map(f => field(f, o[f.k]))), h('button', { type: 'submit', class: 'btn primary mt-12' }, 'Запази профила'));
  // лого на лицето – по желание, до логото на ЗДОИ4You в бланката
  const logoBox = h('div', { class: 'logo-box' });
  const drawLogo = async () => {
    const ver = pn.logo;
    let img = null;
    if (ver) { try { const r = await api('person.logo', { person: pn.code }); if (r.logo) img = h('img', { src: 'data:' + r.logo.type + ';base64,' + r.logo.data, alt: 'Лого на ' + who }); } catch (_) { img = null; } }
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true, onchange: async e => {
      const f = e.target.files[0];
      if (!f) return;
      if (!['image/png', 'image/jpeg'].includes(f.type)) return toast('Изберете PNG или JPEG.');
      if (f.size > 400 * 1024) return toast('Логото е твърде голямо (до 400 KB).');
      try {
        const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => bad(new Error('Файлът не може да се прочете.')); r.readAsDataURL(f); });
        const r = await api('person.logo.save', { person: pn.code, type: f.type, data });
        pn.logo = r.logo; boot = await api('bootstrap'); toast('Логото е качено.'); drawLogo();
      } catch (ex) { toast(ex.message); }
    } });
    logoBox.replaceChildren(
      h('div', { class: 'logo-row' }, h('span', { class: 'logo-plate' }, h('img', { src: 'assets/logo-site.png', alt: 'ЗДОИ4You' })), img ? h('span', { class: 'logo-plate own' }, img) : h('span', { class: 'logo-empty small muted' }, 'без лого на лицето')),
      h('div', { class: 'actions' }, file, h('button', { type: 'button', class: 'btn sm', onclick: () => file.click() }, img ? 'Смени логото' : 'Качи лого на лицето'),
        img ? h('button', { type: 'button', class: 'btn sm danger', onclick: async () => { if (!confirm('Да се премахне ли логото на ' + who + '?')) return; try { await api('person.logo.save', { person: pn.code, remove: true }); pn.logo = ''; boot = await api('bootstrap'); toast('Логото е премахнато.'); drawLogo(); } catch (ex) { toast(ex.message); } } }, 'Премахни') : null),
      h('p', { class: 'small muted' }, 'PNG или JPEG до 400 KB, за предпочитане с прозрачен фон. Излиза в бланката до логото на ЗДОИ4You.'));
  };
  drawLogo();
  onSubmit(orgForm, async v => { await api('system.save', { org: v, person: pn.code }); boot = await api('bootstrap'); toast('Профилът на ' + v.name + ' е запазен.'); });
  const run = s.mailLastRun || {};
  const poll = h('input', { type: 'checkbox', checked: s.mailPoll });
  poll.addEventListener('change', async () => { try { await api('system.save', { mailPoll: poll.checked, person: pn.code }); toast(poll.checked ? 'Автоматичното четене е включено.' : 'Автоматичното четене е спряно.'); } catch (e) { toast(e.message); poll.checked = !poll.checked; } });
  setView(head('Системни настройки', manyPersons() ? h('span', { class: 'pill info' }, who) : null),
    manyPersons() ? h('p', { class: 'small muted mb-12' }, 'Настройките на ', h('b', null, who), ' – бланка, поща и номерация. Смяна на лицето – от горната лента. Входът, КЕП и базата данни са общи за системата.') : null,
    h('div', { class: 'grid2' },
    h('section', { class: 'card stack' }, h('h2', null, who + ' – заявител и бланка'), logoBox, h('p', { class: 'small muted' }, pn.isDefault === false ? 'Данните излизат в бланката на документите на ' + who + ' (с логото на ЗДОИ4You и my.zdoi4you.eu, както при Сдружението) и като заявител в неговите заявления.' : 'Данните излизат в бланката на документите (с логото на ЗДОИ4You и ' + (o.web || 'my.zdoi4you.eu') + ') и като заявител, когато заявлението е от името на Сдружението.'), orgForm),
    h('div', { class: 'stack' },
      h('section', { class: 'card stack' }, h('h2', null, 'Поща на ' + who), kv([
        ['Кутия', s.mailbox + (s.sharedBox && !pn.isDefault ? ' (общата кутия – отговорите се разпознават по етикета на лицето)' : '')], ['Адрес за отговор (пример)', s.sampleReplyTo], ['Последна проверка', run.at ? fmtTime(run.at) : '—'],
        ['Резултат', run.at ? `прочетени ${run.fetched}, нови ${run.saved}, разпределени ${run.matched}` + (run.boxes && run.boxes.length > 1 ? ' (кутии: ' + run.boxes.length + ')' : '') : '—'], ['Грешка', run.error || '—'],
        ['Неразпределени писма', String(s.unassigned)]]),
        h('label', { class: 'check' }, poll, h('span', null, 'Автоматично четене на всеки 5 минути')),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: async e => { e.target.disabled = true; try { const r = (await api('system.poll', { person: pn.code })).run; toast(r.error ? 'Грешка: ' + r.error : `Нови писма: ${r.saved}, разпределени: ${r.matched}.`); systemView(); } catch (ex) { toast(ex.message); } finally { e.target.disabled = false; } } }, 'Провери пощата сега'),
          h('a', { class: 'btn', href: '#/mail' }, 'Неразпределени'))),
      h('h2', { class: 'section-title' }, 'Общи за системата'),
      oauthCard(),
      kepCard(),
      h('section', { class: 'card stack' }, h('h2', null, 'Номерация и срокове'), kv([
        ['Следващ Изх. №', s.nextOutNo], ['Номер на преписка', s.regNoFormat + (pn.isDefault ? ' (изходящи), ВХ-ГГГГ-NNNN (входящ регистър)' : '')],
        ['Напомняния за срокове', 'всеки ден след 8:00 ч. (днес: ' + s.lastReminder + ')']]),
        (s.registers || []).length > 1 ? h('div', { class: 'small muted' }, 'Всички лица (суперадминистратор):') : null,
        (s.registers || []).length > 1 ? table(['Лице', 'Преписки', 'Следващ Изх. №', 'Кутия'], s.registers.map(x => h('tr', null,
          h('td', null, x.name, x.active ? null : h('span', { class: 'pill ml-4' }, 'спряно')), h('td', { class: 'mono small' }, x.regNo), h('td', { class: 'mono small' }, x.nextOutNo), h('td', { class: 'small' }, x.box)))) : null,
        isSuper() ? h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/persons' }, 'Лица и достъп')) : null),
      h('section', { class: 'card stack' }, h('h2', null, 'Данни и достъп'), kv([
        ['База данни', 'SharePoint – списъци „ADM …“, файлове в „Документи/ADM“'], ['Потребители', 'меню „Потребители“'], ['Дневник', 'меню „Дневник“']]),
        h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/users' }, 'Потребители'), h('a', { class: 'btn', href: '#/log' }, 'Дневник'), h('a', { class: 'btn', href: '#/departments' }, 'Отдели'),
          h('button', { class: 'btn', title: 'Добавя в SharePoint липсващите списъци и колони след обновяване на системата', onclick: async e => {
            e.target.disabled = true;
            try { const r = await api('system.schema'); toast(r.created.length ? 'Добавени: ' + r.created.join(', ') : 'Структурата е актуална.'); } catch (ex) { toast(ex.message); } finally { e.target.disabled = false; }
          } }, 'Обнови структурата на базата'))))));
  enhanceParty(orgForm);
}

/* ---------- лица (суперадминистратор): от чието име се подават заявления ---------- */

async function personsView() {
  loading();
  let d;
  try { d = await api('persons.list'); } catch (e) { return failView(e); }
  const edit = p => {
    const isNew = !p.code;
    const fields = [
      { k: 'name', label: 'Наименование', req: true, max: 250, full: true },
      { k: 'code', label: 'Код (латиница)', req: true, max: 10, pattern: '[a-z][a-z0-9]{1,9}', disabled: !isNew, hint: isNew ? 'Напр. abc – в номерата на преписките: П-ABC-ГГГГ-NNNN. Не се сменя.' : 'Не се сменя.' },
      { k: 'outPrefix', label: 'Префикс на Изх. №', max: 10, pattern: '[A-ZА-Я0-9]{2,10}', disabled: p.isDefault, hint: 'Напр. АБВ → АБВ-ГГГГ-NNNN. Не се сменя след първия документ.' },
      { k: 'brand', label: 'Марка в бланката', max: 60 },
      { k: 'regBasis', label: 'Регистрация', type: 'select', options: d.regBasis.map(x => [x, x || '—']) },
      { k: 'eik', label: 'ЕИК/БУЛСТАТ', max: 13, pattern: '\\d{9}|\\d{13}' },
      { k: 'address', label: 'Седалище и адрес на управление', max: 400, full: true },
      { k: 'oblast', label: 'Област', max: 80 },
      { k: 'rep', label: 'Представлява се от', max: 160 },
      { k: 'repPosition', label: 'Качество', max: 160 },
      { k: 'phone', label: 'Телефон', max: 40 },
      { k: 'email', label: 'Имейл в бланката', type: 'email', max: 200 },
      { k: 'web', label: 'Интернет адрес в бланката', max: 120 },
      { k: 'place', label: 'Място по подразбиране', max: 80 },
      { k: 'mailbox', label: 'Пощенска кутия', type: 'email', max: 200, full: true, hint: 'Празно – писмата се изпращат и получават през ' + d.defaultBox + ' (с етикета на преписката). Собствена кутия трябва да е добавена към правата на приложението в Exchange.' },
      p.isDefault ? null : { k: 'active', label: 'Активно (създават се нови преписки)', type: 'checkbox' }
    ].filter(Boolean);
    const users = d.users.filter(u => u.access !== '*');
    const userBoxes = h('fieldset', { class: 'mt-16' }, h('legend', null, 'Достъп – кои потребители водят преписки от името на лицето'),
      h('p', { class: 'small muted mb-8' }, 'Суперадминистраторите имат достъп до всички лица. Правата на потребителя (вижда всички или само своите преписки, променя ли) са според ролята му.'),
      users.length ? h('div', { class: 'perm-grid' }, users.map(u => h('label', { class: 'check' },
        h('input', { type: 'checkbox', name: 'u_' + u.username, checked: !isNew && u.access.includes(p.code) }),
        h('span', null, u.name + ' (' + u.role.toLowerCase() + ')')))) : h('p', { class: 'empty' }, 'Няма други активни потребители.'));
    formDialog(isNew ? 'Ново лице' : p.name, fields, Object.assign({ active: 'Да', regBasis: d.regBasis[2] }, p, { active: p.active === false ? 'Не' : 'Да' }), isNew ? 'Добави' : 'Запази', async (v, form) => {
      const data = Object.assign({}, v, { isNew, code: isNew ? String(v.code || '').toLowerCase() : p.code, outPrefix: p.isDefault ? p.outPrefix : v.outPrefix, active: p.isDefault ? true : v.active !== false && v.active !== 'Не' });
      data.users = users.filter(u => form.elements['u_' + u.username] && form.elements['u_' + u.username].checked).map(u => u.username);
      Object.keys(data).filter(k => k.startsWith('u_')).forEach(k => delete data[k]);
      await api('persons.save', data);
      boot = await api('bootstrap');
      toast(isNew ? 'Лицето е добавено.' : 'Запазено.');
      personsView();
    }, { wide: true, extra: userBoxes });
  };
  setView(head('Лица', h('button', { class: 'btn primary', onclick: () => edit({}) }, 'Ново лице')),
    h('p', { class: 'small muted mb-12' }, 'От името на тези лица се подават заявления. Всяко има свои данни за бланката, отделен регистър (номерация на преписките и Изх. №) и пощенска кутия за проследяване на отговорите.'),
    h('div', { class: 'card' }, table(['Лице', 'Номера', 'Пощенска кутия', 'Преписки', 'Достъп', 'Състояние', ''], d.persons.map(p => h('tr', null,
      h('td', null, h('b', null, p.name), p.isDefault ? h('span', { class: 'pill info ml-4' }, 'по подразбиране') : null, p.eik ? h('div', { class: 'small muted' }, Docs.idLabel(p.regBasis) + ' ' + p.eik) : null),
      h('td', { class: 'mono small' }, (p.isDefault ? 'П-ГГГГ-NNNN' : 'П-' + p.code.toUpperCase() + '-ГГГГ-NNNN'), h('br'), p.outPrefix + '-ГГГГ-NNNN'),
      h('td', { class: 'small' }, p.box, h('div', { class: 'muted mono' }, 'отговори: ' + p.box.replace('@', '+' + (p.tagId || '…') + '-ГГГГ-NNNN@')), p.mailbox ? null : h('div', { class: 'muted' }, 'обща кутия')),
      h('td', null, String(p.requests)),
      h('td', { class: 'small' }, d.users.filter(u => u.access !== '*' && u.access.includes(p.code)).map(u => u.name).join(', ') || '—'),
      h('td', null, p.active ? h('span', { class: 'pill ok' }, 'Активно') : h('span', { class: 'pill' }, 'Спряно')),
      h('td', null, h('div', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => edit(p) }, 'Промени'), h('a', { class: 'btn sm', href: '#/register/' + encodeURIComponent(p.code) }, 'Регистър'))))))));
}

/* ---------- изходящ регистър на лице: документите с Изх. № ---------- */

async function registerView(code) {
  loading();
  let d;
  try { d = await api('register.list', { person: code || '' }); } catch (e) { return failView(e); }
  const sel = h('select', { 'aria-label': 'Лице', hidden: !manyPersons(), onchange: e => { location.hash = '#/register/' + encodeURIComponent(e.target.value); } }, personsAll().map(p => h('option', { value: p.code }, p.name)));
  sel.value = d.person.code;
  const q = h('input', { type: 'search', placeholder: 'Търсене: Изх. №, преписка, субект, заглавие…', 'aria-label': 'Търсене' });
  const body = h('div');
  const draw = () => {
    const t = q.value.trim().toLowerCase();
    const rows = d.docs.filter(x => !t || [x.outNo, x.regNo, x.entityName, x.title, x.kind].join(' ').toLowerCase().includes(t));
    body.replaceChildren(h('p', { class: 'small muted' }, 'Документи: ' + rows.length + ' · преписки: ' + d.requests),
      table(['Изх. №', 'Дата', 'Вид', 'Заглавие', 'Преписка', 'Задължен субект', 'Изпратен'], rows.map(x => h('tr', { class: 'link', onclick: () => { location.hash = '#/request/' + encodeURIComponent(x.regNo); } },
        h('td', { class: 'mono' }, x.outNo), h('td', null, fmtDate(x.date)), h('td', null, x.kind, x.signed ? h('span', { class: 'pill ok ml-4' }, 'КЕП') : null), h('td', { class: 'subject' }, x.title || '—'),
        h('td', { class: 'mono' }, x.regNo), h('td', null, x.entityName || '—'),
        h('td', { class: 'small' }, x.sentAt ? whenOf(x.sentAt) + (x.sentHow ? ' · ' + x.sentHow : '') : h('span', { class: 'pill' }, 'неизпратен')))), 'Няма документи в регистъра.'));
  };
  q.addEventListener('input', draw);
  setView(head('Изходящ регистър – ' + d.person.name),
    h('p', { class: 'small muted mb-12' }, 'Номерация: преписки ' + (d.person.isDefault ? 'П-ГГГГ-NNNN' : 'П-' + d.person.code.toUpperCase() + '-ГГГГ-NNNN') + ', документи ' + d.person.outPrefix + '-ГГГГ-NNNN. Показани са документите по преписките, които виждате.'),
    h('div', { class: 'card' }, h('div', { class: 'filters' }, sel, q), body));
  draw();
}

/* ---------- избор на лице при отваряне ---------- */

function personChooser() {
  const all = personsAll();
  $('app').replaceChildren(h('div', { class: 'gate' },
    h('span', { class: 'logo-plate' }, h('img', { src: 'assets/logo-site.png', alt: 'ЗДОИ4You' })),
    h('div', { class: 'card gate-card wide stack' },
      h('div', null, h('h1', null, 'Изберете лице'), h('p', { class: 'muted' }, 'Здравейте, ' + me.name + '. Изберете от името на кое лице ще работите – таблото, заявленията, регистърът и пощата се показват само за него. Лицето се сменя от горната лента.')),
      h('div', { class: 'person-grid' }, all.map(p => h('button', { type: 'button', class: 'person-card' + (p.active ? '' : ' off'), onclick: () => { setCur(p.code); $('app').replaceChildren(); if (!/^#\/(dashboard)?$/.test(location.hash)) location.hash = '#/dashboard'; route(); } },
        h('span', { class: 'person-ico' }, icon('building')),
        h('span', { class: 'person-body' }, h('b', null, p.name), h('small', null, [p.brand && p.brand !== p.name ? p.brand : '', p.eik ? 'ЕИК ' + p.eik : '', 'номера ' + (p.isDefault ? 'П-ГГГГ' : 'П-' + p.code.toUpperCase() + '-ГГГГ')].filter(Boolean).join(' · ')),
          p.active ? null : h('span', { class: 'pill' }, 'спряно')))))),
    h('p', { class: 'gate-foot' }, h('button', { type: 'button', class: 'btn sm', onclick: async () => { try { await api('logout'); } catch (_) { /* изтекла */ } endSession('Излязохте от системата.'); } }, 'Изход'))));
}

/* смяна на лицето от горната лента */
function personSwitch() {
  if (!manyPersons()) return null;
  const p = curPerson();
  return dropdown(h('button', { class: 'person-chip', title: 'Лице – смяна' }, icon('building'), h('span', { class: 'person-name' }, p ? (p.brand && !p.isDefault ? p.brand : p.name) : 'Изберете лице'), icon('chevron', 'sm')),
    h('div', { class: 'dd-panel' }, h('div', { class: 'dd-head small muted' }, 'Работите от името на'),
      personsAll().map(x => h('button', { type: 'button', class: x.code === curCode ? 'on' : '', onclick: () => {
        if (x.code === curCode) return;
        setCur(x.code); $('app').replaceChildren(); route(); toast('Лице: ' + x.name);
      } }, icon('building'), h('span', null, x.name, x.active ? null : ' (спряно)')))));
}

/* ---------- ръководство (само в базата, според ролята и правата) ---------- */

/* кратък Markdown: ### заглавия, списъци (-, 1.), > бележка, ``` код, **удебелено**, `код`, [текст](#/… или https://…) – без innerHTML */
function mdInline(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(((?:#\/|https:\/\/)[^)\s]*)\)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('b', null, m[1]));
    else if (m[2]) out.push(h('code', null, m[2]));
    else out.push(h('a', m[4].startsWith('#') ? { href: m[4] } : { href: m[4], target: '_blank', rel: 'noopener noreferrer' }, m[3]));
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function mdRender(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [], list = null, quote = null, code = null;
  const flush = () => {
    if (para.length) { out.push(h('p', null, mdInline(para.join(' ')))); para = []; }
    if (list) { out.push(list); list = null; }
    if (quote) { out.push(h('div', { class: 'md-note' }, quote.map(q => h('p', null, mdInline(q))))); quote = null; }
  };
  for (const raw of lines) {
    if (code) { if (/^```/.test(raw)) { out.push(h('pre', null, h('code', null, code.join('\n')))); code = null; } else code.push(raw); continue; }
    if (/^```/.test(raw)) { flush(); code = []; continue; }
    const t = raw.trim();
    let m;
    if (!t) { flush(); continue; }
    if ((m = /^(#{3,4})\s+(.+)$/.exec(t))) { flush(); out.push(h(m[1].length === 3 ? 'h3' : 'h4', null, mdInline(m[2]))); continue; }
    if ((m = /^>\s?(.*)$/.exec(t))) { if (para.length || list) flush(); (quote = quote || []).push(m[1]); continue; }
    if ((m = /^(?:[-*]|(\d+)\.)\s+(.+)$/.exec(t))) {
      if (para.length || quote) flush();
      const tag = m[1] ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) { if (list) out.push(list); list = h(tag, null); }
      list.append(h('li', null, mdInline(m[2])));
      continue;
    }
    if (list && /^\s{2,}/.test(raw)) { list.lastChild.append(' ', ...mdInline(t)); continue; }
    if (list || quote) flush();
    para.push(t);
  }
  if (code) out.push(h('pre', null, h('code', null, code.join('\n'))));
  flush();
  return h('div', { class: 'md' }, out);
}

/*
 * Защита в цялата система (след вход): печатът и „Печат в PDF“ дават празна страница, PrintScreen и известните
 * клавиши за снимка на екрана се спират, а при излизане от прозореца (инструментите за снимка го правят) съдържанието
 * се размазва. Всеки опит се записва в дневника (потребител, страница, начин, IP).
 * В ръководството освен това текстът не се маркира и копира, а върху него има воден знак с потребителя и часа.
 * Браузърът не може напълно да спре снимка с външна програма или телефон.
 * Изтеглянето на документите (PDF по преписките) не е засегнато.
 */
const GUARD_MSG = 'Печатът и снимките на екрана в системата не са разрешени. Опитът е записан в дневника.';
const GUARD_HELP = 'Ръководството е само за преглед в системата: копиране, печат и снимки на екрана не са разрешени. Опитът е записан в дневника.';
function guard(on) {
  document.body.classList.toggle('guard', !!on);
  document.body.classList.toggle('sys-guard', !!me);
  if (!me) document.body.classList.remove('shield');
}
const guarded = () => document.body.classList.contains('guard');
const sysGuarded = () => !!me && document.body.classList.contains('sys-guard');
const shield = on => { if (sysGuarded()) document.body.classList.toggle('shield', on); };
const flash = () => { shield(true); setTimeout(() => { if (document.hasFocus()) shield(false); }, 1500); };
/* съобщава опита на сървъра – един и същ вид най-много веднъж на 5 секунди */
const reported = {};
function reportTry(kind, how) {
  if (!me) return;
  const now = Date.now();
  if (reported[kind] && now - reported[kind] < 5000) return;
  reported[kind] = now;
  const hash = location.hash || '#/dashboard';
  api('guard.report', { kind, how, page: pageLabel(hash) + ' · ' + hash }).catch(() => { /* без мрежа – само предупреждението */ });
}
document.addEventListener('keydown', e => {
  if (!sysGuarded()) return;
  const k = (e.key || '').toLowerCase(), mod = e.ctrlKey || e.metaKey;
  const combo = [e.ctrlKey ? 'Ctrl' : '', e.metaKey ? 'Win/Cmd' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', (e.key || '').length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join('+');
  let kind = '';
  if (k === 'printscreen') kind = 'снимка на екрана';
  else if (mod && !e.shiftKey && k === 'p') kind = 'печат';
  else if ((e.metaKey && e.shiftKey && ['3', '4', '5', 's'].includes(k)) || (e.ctrlKey && e.shiftKey && k === 's')) kind = 'снимка на екрана';
  else if (guarded() && mod && ['s', 'c', 'x', 'a', 'u'].includes(k) && !e.target.closest('input, textarea, select, dialog')) kind = ['c', 'x', 's'].includes(k) ? 'копиране на ръководството' : 'блок';
  if (!kind) return;
  e.preventDefault(); e.stopPropagation();
  if (kind === 'снимка на екрана') flash();
  if (kind !== 'блок') reportTry(kind, combo);
  toast(guarded() ? GUARD_HELP : GUARD_MSG);
}, true);
document.addEventListener('keyup', e => {
  if (!sysGuarded() || (e.key || '').toLowerCase() !== 'printscreen') return;
  // на Windows PrintScreen често стига само като keyup: снимката вече е в клипборда – заменя се с текст
  try { navigator.clipboard.writeText(GUARD_MSG).catch(() => {}); } catch (_) { /* без достъп до клипборда */ }
  flash();
  reportTry('снимка на екрана', 'PrintScreen');
  toast(GUARD_MSG);
}, true);
['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'].forEach(ev => document.addEventListener(ev, e => {
  if (!(guarded() && e.target.closest && e.target.closest('.protected'))) return;
  e.preventDefault();
  if (ev === 'copy' || ev === 'cut') reportTry('копиране на ръководството', ev === 'copy' ? 'копиране' : 'изрязване');
  if (ev !== 'selectstart') toast(GUARD_HELP);
}, true));
/* печат от менюто на браузъра („Печат“, „Запази като PDF“) – страницата излиза празна (CSS), опитът се записва */
window.addEventListener('beforeprint', () => { if (sysGuarded()) { reportTry('печат', 'меню на браузъра'); toast(GUARD_MSG); } });
window.addEventListener('blur', () => shield(true));
window.addEventListener('focus', () => setTimeout(() => shield(false), 300));
document.addEventListener('visibilitychange', () => shield(document.hidden));
/* воден знак: потребител и време, повторен по диагонал */
function watermark() {
  const t = (me.name || me.username) + ' · ' + me.username + ' · ' + fmtTime(new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Sofia' }).replace(' ', 'T'));
  const esc = t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="220"><text x="20" y="130" transform="rotate(-24 210 110)" font-family="sans-serif" font-size="15" fill="#7a8699" fill-opacity=".16">' + esc + '</text></svg>';
  return h('div', { class: 'wm', 'aria-hidden': 'true', style: 'background-image:url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")' });
}

async function helpView(query) {
  loading();
  const q = new URLSearchParams(query || '');
  try {
    const as = q.get('as') || '';
    const r = await api('help.list', as ? { as } : {});
    const find = h('input', { type: 'search', placeholder: 'Търсене в ръководството', 'aria-label': 'Търсене в ръководството', value: q.get('q') || '' });
    const toc = h('nav', { class: 'help-toc card', 'aria-label': 'Съдържание' });
    const body = h('div', { class: 'stack help-body' });
    const permOpts = [['', '— без —']].concat(((boot && boot.permGroups) || []).flatMap(([, list]) => list.map(([k, label]) => [k, label])));
    const edit = s => {
      const roleBoxes = r.roles.map(role => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: role, checked: (s.audience || []).includes(role) }), h('span', null, role)));
      const extra = h('fieldset', { class: 'perm-group' }, h('legend', null, 'За кого (без отметка – за всички)'), h('div', { class: 'perm-list' }, roleBoxes));
      formDialog(s._id ? 'Раздел от ръководството' : 'Нов раздел', [
        { k: 'title', label: 'Заглавие', req: true, max: 200, full: true },
        { k: 'order', label: 'Подредба (по-малкото – по-напред)', type: 'number', min: 0, maxValue: 9999 },
        { k: 'perm', label: 'Само с право', type: 'select', options: permOpts },
        { k: 'body', label: 'Текст', type: 'textarea', rows: 18, max: 60000, full: true, hint: '### подзаглавие · - списък · 1. стъпки · > бележка · **удебелено** · `код` · [текст](#/requests)' }
      ], s, 'Запази', async v => {
        await api('help.save', Object.assign(v, { id: s._id || '', audience: roleBoxes.map(l => l.querySelector('input')).filter(i => i.checked).map(i => i.value) }));
        toast('Запазено.'); helpView(query);
      }, { wide: true, extra });
    };
    const del = async s => {
      if (!confirm('Да се изтрие ли разделът „' + s.title + '“?')) return;
      try { await api('help.delete', { id: s._id }); toast('Изтрит.'); helpView(query); } catch (e) { toast(e.message); }
    };
    const importFile = () => {
      const inp = h('input', { type: 'file', accept: '.md,.txt,text/markdown,text/plain', onchange: async () => {
        const f = inp.files[0];
        if (!f) return;
        try { const x = await api('help.import', { markdown: await f.text() }); toast('Импорт: нови ' + x.added + ', обновени ' + x.updated + '.'); helpView(query); } catch (e) { toast(e.message); }
      } });
      inp.click();
    };
    const draw = () => {
      const needle = find.value.trim().toLowerCase();
      const list = r.sections.filter(s => !needle || (s.title + '\n' + s.body).toLowerCase().includes(needle));
      toc.replaceChildren(h('div', { class: 'small muted mb-8' }, 'Съдържание'), list.length ? h('ol', null, list.map(s => h('li', null, h('a', { href: '#help-' + s.key, onclick: e => { e.preventDefault(); document.getElementById('help-' + s.key).scrollIntoView({ behavior: 'smooth' }); } }, s.title)))) : h('p', { class: 'small muted' }, '—'));
      body.replaceChildren(...(list.length ? list.map(s => h('section', { class: 'card stack help-sec', id: 'help-' + s.key },
        h('div', { class: 'head m-0' }, h('h2', null, s.title), r.editor ? h('div', { class: 'actions' },
          s.audience.length ? s.audience.map(x => h('span', { class: 'pill' }, x)) : h('span', { class: 'pill' }, 'за всички'),
          s.perm ? h('span', { class: 'pill info', title: permLabel(s.perm) }, 'право: ' + s.perm) : null,
          h('button', { class: 'btn sm', onclick: () => edit(s) }, 'Промени'), h('button', { class: 'btn sm', onclick: () => del(s) }, 'Изтрий')) : null),
        mdRender(s.body),
        r.editor && s.updatedAt ? h('p', { class: 'small muted' }, 'Променено ' + fmtTime(s.updatedAt) + (s.by ? ' от ' + userName(s.by) : '')) : null))
        : [h('div', { class: 'card' }, h('p', { class: 'empty' }, r.total ? 'Няма раздел, който съвпада с търсенето.' : r.editor ? 'Ръководството е празно. Добавете раздел или импортирайте файл (Markdown).' : 'Ръководството още не е попълнено.'))]));
    };
    find.addEventListener('input', draw);
    const asSel = r.editor ? h('select', { 'aria-label': 'Преглед като', onchange: e => { location.hash = '#/help' + (e.target.value ? '?as=' + encodeURIComponent(e.target.value) : ''); } },
      h('option', { value: '' }, 'Всички раздели (редактор)'), r.roles.map(x => h('option', { value: x }, 'Както го вижда: ' + x))) : null;
    if (asSel) asSel.value = as;
    setView(head('Ръководство', r.editor ? [asSel, h('button', { class: 'btn', onclick: importFile, title: 'Файл .md: всеки раздел започва с „## Заглавие“, после по желание „За: Роля, Роля“ и „Право: ключ“' }, 'Импорт от файл'), h('button', { class: 'btn primary', onclick: () => edit({ order: (r.sections.length + 1) * 10 }) }, 'Нов раздел')] : null,
      h('button', { class: 'btn', onclick: () => ticketDialog() }, 'Подай сигнал')),
      h('p', { class: 'small muted mb-12' }, 'Как се работи със системата – показват се разделите за вашата роля (' + me.role + ') и права. Ръководството се пази в базата и се вижда само след вход. Не намирате отговор? „Подай сигнал“ отваря тикет към администраторите.'),
      h('div', { class: 'filters mb-12' }, find),
      h('div', { class: 'help-layout protected' }, toc, body, watermark()));
    guard(true);
    draw();
  } catch (e) { failView(e); }
}

/* ---------- тикети: проблеми, въпроси, заявки ---------- */

const TICKET_PILL = { 'Нов': 'info', 'В работа': 'info', 'Чака отговор': 'warn', 'Решен': 'ok', 'Затворен': '' };
const PRIO_PILL = { 'Нисък': '', 'Нормален': '', 'Висок': 'warn', 'Спешен': 'bad' };
let ticketLists = null;
async function ticketMeta() {
  if (!ticketLists) { const r = await api('ticket.list', { mine: true }); ticketLists = { categories: r.categories, priorities: r.priorities, statuses: r.statuses }; }
  return ticketLists;
}

/* имената на страниците – за тикетите („от коя страница“) */
const PAGE_NAMES = {
  dashboard: 'Табло', requests: 'Заявления', request: 'Заявление', cases: 'Входящ регистър', case: 'Входяща преписка', mail: 'Поща',
  calendar: 'Календар', courts: 'Съдебни дела', court: 'Съдебно дело', register: 'Изходящ регистър', addressees: 'Адресати',
  verify: 'Проверки в регистрите', calc: 'Калкулатор на срокове', kep: 'Проверка на КЕП', departments: 'Отдели', users: 'Потребители и права',
  persons: 'Лица и достъп', system: 'Система', logins: 'Входове и сесии', log: 'Дневник', profile: 'Моят профил', help: 'Ръководство', tickets: 'Тикети', ticket: 'Тикет'
};
function pageLabel(hash) {
  const [path, query] = String(hash || '').replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch (_) { return x; } });
  const name = PAGE_NAMES[parts[0] || 'dashboard'] || parts[0] || 'Табло';
  const id = parts[1] && parts[1] !== '*' ? ' ' + (parts[1] === 'new' ? '(ново)' : parts[1]) : '';
  const q = new URLSearchParams(query || '');
  const extra = q.get('eik') ? ' – ЕИК ' + q.get('eik') : q.get('name') ? ' – „' + q.get('name') + '“' : '';
  return name + id + (parts[2] === 'edit' ? ' (редакция)' : '') + extra;
}
/* записаната страница на тикета: „Име · #/адрес“ (или стар запис – само адрес) */
const ticketPageView = v => {
  const m = /(#\/\S*)$/.exec(String(v || ''));
  if (!m) return v;
  const label = String(v).slice(0, m.index).replace(/\s*·\s*$/, '') || pageLabel(m[1]);
  return h('a', { href: m[1] }, label);
};
/* последната работна страница (не ръководство и тикети) – по подразбиране за „от коя страница“ */
let lastWorkPage = '';

/* нов тикет – от всяка страница; страницата се избира (по подразбиране – тази, от която е отворен) */
async function ticketDialog(preset = {}) {
  let L;
  try { L = await ticketMeta(); } catch (e) { return toast(e.message); }
  const here = /^#\/(help|tickets?)(\/|\?|$)/.test(location.hash) ? lastWorkPage : location.hash || '#/dashboard';
  const seen = new Set();
  const opts = [];
  const add = (hash, text) => { if (hash && !seen.has(hash)) { seen.add(hash); opts.push([hash, text]); } };
  if (here) add(here, 'Тази страница: ' + pageLabel(here));
  NAV().forEach(([, items]) => items.forEach(([href, text]) => add(href, text)));
  NAV_FOOT.forEach(([href, text]) => add(href, text));
  add('#/profile', 'Моят профил');
  opts.push(['', '— не е свързано с конкретна страница —']);
  const page = preset.page !== undefined ? preset.page : here;
  formDialog('Нов тикет', [
    { k: 'category', label: 'Категория', type: 'select', req: true, options: L.categories },
    { k: 'priority', label: 'Приоритет', type: 'select', options: L.priorities },
    { k: 'title', label: 'Кратко заглавие', req: true, max: 200, full: true, placeholder: 'напр. Не се зарежда регистърът на училищата' },
    { k: 'body', label: 'Описание', type: 'textarea', req: true, rows: 8, max: 20000, full: true, hint: 'Какво направихте, какво очаквахте и какво стана (точния текст на грешката). Без ЕГН и пароли.' },
    { k: 'page', label: 'От коя страница е проблемът', type: 'select', options: opts, full: true, hint: 'По подразбиране – страницата, от която отворихте сигнала (с номера на преписката, ако има). Сменете я, ако проблемът е другаде.' }
  ], { category: preset.category || L.categories[0], priority: 'Нормален', page }, 'Подай', async v => {
    v.page = v.page ? pageLabel(v.page) + ' · ' + v.page : '';
    const r = await api('ticket.create', v);
    toast('Тикет ' + r.no + ' е подаден.'); countsAt = 0;
    location.hash = '#/ticket/' + encodeURIComponent(r.no);
  }, { wide: true });
}

async function ticketsView(query) {
  loading();
  const q = new URLSearchParams(query || '');
  try {
    const mine = q.get('mine') === '1';
    const r = await api('ticket.list', { mine });
    ticketLists = { categories: r.categories, priorities: r.priorities, statuses: r.statuses };
    const st = h('select', { 'aria-label': 'Статус' }, h('option', { value: 'open' }, 'Отворени'), h('option', { value: '' }, 'Всички статуси'), r.statuses.map(s => h('option', { value: s }, s)));
    st.value = q.get('status') === null ? 'open' : q.get('status');
    const cat = h('select', { 'aria-label': 'Категория' }, h('option', { value: '' }, 'Всички категории'), r.categories.map(s => h('option', { value: s }, s)));
    cat.value = q.get('cat') || '';
    const find = h('input', { type: 'search', placeholder: 'Търсене по №, заглавие, подател', 'aria-label': 'Търсене' });
    const box = h('div', { class: 'card' });
    const open = ['Нов', 'В работа', 'Чака отговор'];
    const all = r.handler && !mine;
    const draw = () => {
      const n = find.value.trim().toLowerCase();
      const rows = r.tickets.filter(t => (st.value === 'open' ? open.includes(t.status) : !st.value || t.status === st.value) && (!cat.value || t.category === cat.value)
        && (!n || [t.no, t.title, userName(t.createdBy), t.createdBy].join(' ').toLowerCase().includes(n)));
      box.replaceChildren(table(['№', 'Заглавие', 'Страница', 'Категория', 'Приоритет', 'Статус', all ? 'Подал' : null, 'Отговорник', 'Последна промяна'].filter(Boolean), rows.map(t => h('tr', { class: 'clickable', onclick: () => { location.hash = '#/ticket/' + encodeURIComponent(t.no); } },
        h('td', null, h('a', { href: '#/ticket/' + encodeURIComponent(t.no) }, t.no)), h('td', null, t.title),
        h('td', { class: 'small', onclick: e => e.stopPropagation() }, t.page ? ticketPageView(t.page) : '—'), h('td', null, t.category),
        h('td', null, h('span', { class: 'pill ' + (PRIO_PILL[t.priority] || '') }, t.priority)), h('td', null, h('span', { class: 'pill ' + (TICKET_PILL[t.status] || '') }, t.status)),
        all ? h('td', null, userName(t.createdBy)) : null, h('td', null, t.assignee ? userName(t.assignee) : '—'), h('td', null, fmtTime(t.updatedAt)))),
        r.tickets.length ? 'Няма тикети по този филтър.' : 'Още няма тикети. „Нов тикет“ – при проблем, въпрос или заявка.'));
    };
    [st, cat].forEach(x => x.addEventListener('change', draw));
    find.addEventListener('input', draw);
    const tabs = r.handler ? h('div', { class: 'seg mb-12' }, [['', 'Всички тикети'], ['1', 'Моите']].map(([k, label]) =>
      h('button', { class: 'btn sm' + ((mine ? '1' : '') === k ? ' primary' : ''), onclick: () => { location.hash = '#/tickets' + (k ? '?mine=1' : ''); } }, label))) : null;
    setView(head('Тикети', h('a', { class: 'btn', href: '#/help' }, 'Ръководство'), h('button', { class: 'btn primary', onclick: () => ticketDialog() }, 'Нов тикет')),
      tabs,
      h('p', { class: 'small muted mb-12' }, all ? 'Всички подадени тикети. Новите се отбелязват в менюто; подателят получава имейл при отговор и при смяна на статуса.' : 'Вашите сигнали за проблеми, въпроси и заявки (вкл. отворени данни и регистри). Получавате имейл при отговор.'),
      h('div', { class: 'filters mb-12' }, find, st, cat), box);
    draw();
  } catch (e) { failView(e); }
}

async function ticketPage(no) {
  loading();
  try {
    const r = await api('ticket.get', { no });
    const t = r.ticket, mine = t.createdBy === me.username;
    const reload = () => { countsAt = 0; ticketPage(no); };
    const msgs = r.messages.map(m => h('div', { class: 'ticket-msg' + (m.internal === 'Да' ? ' internal' : '') + (m.kind === 'Промяна' ? ' change' : '') + (m.user === t.createdBy ? ' author' : '') },
      h('div', { class: 'small muted' }, h('b', null, userName(m.user)), ' · ' + fmtTime(m.at), m.internal === 'Да' ? h('span', { class: 'pill warn ml-4' }, 'вътрешно') : null),
      m.kind === 'Промяна' ? h('div', { class: 'small' }, m.text) : h('div', { class: 'pre' }, m.text)));
    const text = h('textarea', { rows: 5, maxlength: 20000, 'aria-label': 'Съобщение', placeholder: mine ? 'Допълнение или отговор на въпроса…' : 'Отговор до подателя…' });
    const internal = r.handler ? h('input', { type: 'checkbox' }) : null;
    const nextSt = r.handler && !mine ? h('select', { 'aria-label': 'Статус след отговора' }, h('option', { value: '' }, 'Статус: без промяна'), r.statuses.map(s => h('option', { value: s }, 'Статус: ' + s))) : null;
    if (nextSt) nextSt.value = t.status === 'Нов' ? 'В работа' : '';
    const send = async () => {
      try { await api('ticket.reply', { no: t.no, text: text.value, internal: internal ? internal.checked : false, status: nextSt && !(internal && internal.checked) ? nextSt.value : '' }); toast('Изпратено.'); reload(); } catch (e) { toast(e.message); }
    };
    const sel = (k, list, val) => { const s = h('select', { name: k }, list.map(o => { const [v, tx] = pair(o); return h('option', { value: v }, tx); })); s.value = val || ''; return s; };
    let manage = null;
    if (r.handler) {
      const staff = (boot.users || []).filter(u => u.role === 'Администратор' || u.role === 'Суперадминистратор');
      const fs = { status: sel('status', r.statuses, t.status), priority: sel('priority', r.priorities, t.priority), category: sel('category', r.categories, t.category),
        assignee: sel('assignee', [['', '— без отговорник —']].concat(staff.map(u => [u.username, u.name])), t.assignee) };
      manage = h('section', { class: 'card stack' }, h('h2', null, 'Обработка'),
        h('div', { class: 'form-grid' }, [['Статус', fs.status], ['Приоритет', fs.priority], ['Категория', fs.category], ['Отговорник', fs.assignee]].map(([l, s]) => h('label', { class: 'field' }, h('span', null, l), s))),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary sm', onclick: async () => {
          try { const x = await api('ticket.update', { no: t.no, status: fs.status.value, priority: fs.priority.value, category: fs.category.value, assignee: fs.assignee.value }); toast(x.changed.length ? 'Запазено.' : 'Няма промени.'); reload(); } catch (e) { toast(e.message); }
        } }, 'Запази'), t.assignee !== me.username ? h('button', { class: 'btn sm', onclick: async () => { try { await api('ticket.update', { no: t.no, assignee: me.username, status: t.status === 'Нов' ? 'В работа' : t.status }); toast('Поехте тикета.'); reload(); } catch (e) { toast(e.message); } } }, 'Поеми') : null));
    }
    setView(head(t.no + ' · ' + t.title, h('a', { class: 'btn', href: '#/tickets' }, 'Всички тикети'),
      mine && !r.handler && t.status !== 'Затворен' ? h('button', { class: 'btn', onclick: async () => { if (!confirm('Да се затвори ли тикетът?')) return; try { await api('ticket.update', { no: t.no, status: 'Затворен' }); toast('Затворен.'); reload(); } catch (e) { toast(e.message); } } }, 'Затвори тикета') : null),
      h('div', { class: 'grid2 ticket-grid' },
        h('div', { class: 'stack' },
          h('section', { class: 'card stack' }, h('div', { class: 'head m-0' }, h('h2', null, 'Описание'), h('span', { class: 'pill ' + (TICKET_PILL[t.status] || '') }, t.status)),
            h('div', { class: 'pre' }, t.body),
            t.page ? h('p', { class: 'small muted' }, 'От страница: ', ticketPageView(t.page)) : null),
          h('section', { class: 'card stack' }, h('h2', null, 'Разговор'), msgs.length ? h('div', { class: 'stack' }, msgs) : h('p', { class: 'empty' }, 'Още няма отговори.'),
            t.status === 'Затворен' && !r.handler ? h('p', { class: 'small muted' }, 'Тикетът е затворен. Ново съобщение ще го отвори отново.') : null,
            text, h('div', { class: 'actions' }, internal ? h('label', { class: 'check' }, internal, h('span', null, 'Вътрешна бележка (подателят не я вижда)')) : null, nextSt,
              h('button', { class: 'btn primary', onclick: send }, 'Изпрати')))),
        h('div', { class: 'stack' },
          h('section', { class: 'card stack' }, h('h2', null, 'Данни'), kv([['Категория', t.category], ['Приоритет', h('span', { class: 'pill ' + (PRIO_PILL[t.priority] || '') }, t.priority)], ['Подал', userName(t.createdBy)],
            ['Подаден', fmtTime(t.createdAt)], ['Отговорник', t.assignee ? userName(t.assignee) : '—'], ['Последна промяна', fmtTime(t.updatedAt)], t.closedAt ? ['Решен/затворен', fmtTime(t.closedAt)] : null])),
          manage)));
  } catch (e) { failView(e); }
}

/* ---------- маршрути ---------- */

async function route() {
  const raw = location.hash.slice(1) || '/dashboard';
  const [path, query] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const page = parts[0] || 'dashboard';
  guard(false);
  if (me && !['help', 'tickets', 'ticket', 'login', 'activate', 'forgot', 'code'].includes(page)) lastWorkPage = '#' + raw;
  if (!me) {
    if (page === 'activate') return activateView(parts[1] || '', parts[2] || '');
    if (page === 'forgot') return forgotView();
    if (page === 'calc') return calcView();
    if (page === 'code' && /^[0-9a-f]{64}$/.test(parts[1] || '')) { history.replaceState(null, '', '#/login'); return codeView(parts[1]); }
    if (page !== 'login') { history.replaceState(null, '', '#/login'); }
    return loginView(new URLSearchParams(query || '').get('err'));
  }
  if (['login', 'activate', 'forgot', 'code'].includes(page)) { location.hash = '#/dashboard'; return; }
  if (!ensureCur()) return personChooser();
  shell();
  refreshCounts();
  const q = new URLSearchParams(query || '');
  if (page === 'profile' && (q.get('ok') || q.get('err'))) { toast(q.get('ok') || q.get('err')); history.replaceState(null, '', '#/profile'); }
  switch (page) {
    case 'dashboard': return dashboardView();
    case 'cases': return can('inReg') ? casesView(query) : noAccess('inReg');
    case 'case': return !can('inReg') ? noAccess('inReg') : parts[1] === 'new' ? newCaseView() : caseView(parts[1]);
    case 'calendar': return calendarView(query);
    case 'courts': return courtsView(query);
    case 'court': return courtPage(parts[1]);
    case 'addressees': return addresseesView(query);
    case 'departments': return departmentsView();
    case 'users': return can('users') ? usersView() : noAccess('users');
    case 'log': return can('log') ? logView() : noAccess('log');
    case 'logins': return parts[1] && parts[1] !== me.username && !can('logins') ? noAccess('logins') : loginsView(parts[1] === '*' ? '' : parts[1], parts[1] === '*');
    case 'profile': return profileView();
    case 'calc': return calcView();
    case 'kep': return kepView();
    case 'verify': return verifyView(query);
    case 'help': return helpView(query);
    case 'tickets': return ticketsView(query);
    case 'ticket': return ticketPage(parts[1]);
    case 'requests': return requestsView(query);
    case 'request': return parts[1] === 'new' ? requestEditView(null) : parts[2] === 'edit' ? requestEditView(parts[1]) : requestView(parts[1]);
    case 'mail': return can('mailbox') ? mailInboxView() : noAccess('mailbox');
    case 'persons': return isSuper() ? personsView() : failView(new Error('Само за суперадминистратор.'));
    case 'register': return can('outReg') ? registerView(parts[1] || curCode) : noAccess('outReg');
    case 'system': return can('system') ? systemView() : noAccess('system');
    default: return setView(h('p', { class: 'err' }, 'Страницата не е намерена.'));
  }
}

window.addEventListener('hashchange', route);

/* при отваряне: ако бисквитката е валидна, сесията продължава */
(async () => {
  if (!/^#\/(activate|forgot|calc)/.test(location.hash)) {
    try {
      const r = await api('me');
      await startSession(r.me);
    } catch (_) { me = null; }
  }
  route();
})();
