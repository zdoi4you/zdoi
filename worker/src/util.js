/* Грешки, стойности и проверки. */

import { CFG } from './config.js';

export class AppError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function fail(code, message) {
  throw new AppError(code, message);
}

/* дата и час в София като „2026-11-16T21:05:00“ */
export function stamp(d = new Date()) {
  const p = sofiaParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

export const todayIso = (d = new Date()) => stamp(d).slice(0, 10);
export const sofiaHour = (d = new Date()) => Number(sofiaParts(d).hour);

function sofiaParts(d) {
  const out = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: CFG.TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).forEach(x => { out[x.type] = x.value; });
  return out;
}

export const str = (v, max) => String(v === null || v === undefined ? '' : v)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max || 500);
export const line = (v, max) => str(v, max).replace(/\s*[\r\n]+\s*/g, ' ');
export const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 200;
export const yes = v => v === true || v === 'Да';

export function isoDate(v, label) {
  const t = str(v, 10);
  if (!t) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const bad = () => fail('date', 'Невалидна дата' + (label ? ' „' + label + '“' : '') + ': ' + t);
  if (!m) bad();
  const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== m[2] - 1 || d.getUTCDate() !== +m[3] || +m[1] < 2000 || +m[1] > 2100) bad();
  return t;
}

export function oneOf(v, list, label) {
  const t = str(v, 200);
  if (!list.includes(t)) fail('value', 'Невалидна стойност за „' + label + '“.');
  return t;
}

export function intIn(v, min, max, label) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail('value', '„' + label + '“ трябва да е от ' + min + ' до ' + max + '.');
  return n ? String(n) : '';
}

/* ЕИК/БУЛСТАТ: 9 или 13 цифри с контролни цифри */
export function validEik(raw) {
  const v = String(raw || '');
  if (!/^(\d{9}|\d{13})$/.test(v)) return false;
  const d = v.split('').map(Number);
  const sum = (w, from) => w.reduce((a, x, i) => a + x * d[from + i], 0);
  let c = sum([1, 2, 3, 4, 5, 6, 7, 8], 0) % 11;
  if (c === 10) { c = sum([3, 4, 5, 6, 7, 8, 9, 10], 0) % 11; if (c === 10) c = 0; }
  if (c !== d[8]) return false;
  if (v.length === 9) return true;
  c = sum([2, 7, 3, 5], 8) % 11;
  if (c === 10) { c = sum([4, 9, 5, 7], 8) % 11; if (c === 10) c = 0; }
  return c === d[12];
}

/* полета, които не излизат от сървъра */
const SECRET = ['_etag', 'salt', 'hash', 'inviteHash', 'inviteExp', 'codeHash', 'codeExp', 'payload'];
export function view(row) {
  const o = Object.assign({}, row);
  SECRET.forEach(k => delete o[k]);
  return o;
}

export const byDesc = key => (a, b) => String(b[key] || '').localeCompare(String(a[key] || ''));

/*
 * Заявка към външна система (data.egov.bg, ЕПЕП) с до 3 опита: някои сайтове понякога отказват (403, 429, 5xx) на
 * заявките от мрежата на Cloudflare. При неуспех – ясна грешка за потребителя (не „Вътрешна грешка“).
 */
export async function fetchRetry(f, url, init, label, waits = [400, 1500]) {
  let last = '';
  for (let i = 0; i <= waits.length; i++) {
    try {
      const r = await f(url, init);
      if (r.ok) return r;
      last = 'код ' + r.status;
      if (![403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 524].includes(r.status)) break;
    } catch (e) { last = e.message; }
    if (i < waits.length) await new Promise(ok => setTimeout(ok, waits[i]));
  }
  fail('external', label + ' не отговаря в момента (' + last + '). Опитайте отново след малко.');
}
