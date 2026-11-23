/*
 * Документи в PDF (pdfmake, MIT): заявление по ЗДОИ, уточнение (чл. 29), писмо и досие на преписка за съда.
 * Бланката на всички лица е с логото на ЗДОИ4You и адреса my.zdoi4you.eu; по желание и с логото на лицето.
 * pdfmake се зарежда само при нужда.
 */

const BLUE = '#0E3A6E', GRAY = '#44546A', LINE = '#1A8FE3';
const fmtDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
const fmtTime = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(iso || ''); return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]} ч.` : (iso || ''); };
const paras = t => String(t || '').split(/\n\s*\n|\r?\n/).map(x => x.trim()).filter(Boolean);
export const idLabel = basis => (/БУЛСТАТ/.test(basis || '') ? 'код по БУЛСТАТ' : /ЕИК/.test(basis || '') ? 'ЕИК' : 'ЕИК/БУЛСТАТ');

/* ---------- зареждане ---------- */

let loading = null, logo = null;
function script(src) {
  return new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => bad(new Error('Неуспешно зареждане на ' + src));
    document.head.append(s);
  });
}
export async function ready() {
  if (!window.pdfMake || !window.pdfMake.vfs) {
    loading = loading || script('vendor/pdfmake.min.js').then(() => script('vendor/vfs_fonts.js'));
    await loading;
  }
  if (!logo) {
    const blob = await (await fetch('assets/logo-pdf.png')).blob();
    logo = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(blob); });
  }
  return logo;
}

/* ---------- общи части ---------- */

const orgLine = o => [o.address, o.email && `имейл: ${o.email}`, o.eik && `${idLabel(o.regBasis)} ${o.eik}`].filter(Boolean).join(' · ');

/* всички лица са с логото на ЗДОИ4You и адреса my.zdoi4you.eu; Сдружението – и с марката ЗДОИ4You, другите – със своето наименование */
const isZdoi = o => o.isDefault !== false;
const brandOf = o => o.brand || (isZdoi(o) ? 'ЗДОИ4You' : o.name);
const webOf = o => o.web || 'my.zdoi4you.eu';

/* логото на лицето: зарежда се от системата при генериране (app.js подава функцията) */
let logoLoader = null;
export const setLogoLoader = fn => { logoLoader = fn; };
const withLogo = (def, o) => Object.assign(def, o && o.logo && o.code ? { _logo: { code: o.code, ver: o.logo } } : {});
async function images(def) {
  const out = { logo: await ready() };
  if (def._logo) {
    const data = logoLoader ? await logoLoader(def._logo.code, def._logo.ver) : null;
    if (!data) throw new Error('Логото на лицето не може да се зареди. Опитайте отново или го качете наново в „Система“.');
    out.plogo = data;
  }
  delete def._logo;
  return out;
}

function letterhead(o) {
  const info = { stack: [
    { text: brandOf(o), bold: true, fontSize: 13, color: BLUE },
    brandOf(o) !== o.name ? { text: o.name, fontSize: 9, color: GRAY } : null,
    { text: orgLine(o), fontSize: 8.5, color: GRAY },
    webOf(o) ? { text: webOf(o), fontSize: 9, color: LINE, bold: true } : null
  ].filter(Boolean), alignment: 'right' };
  // логото на ЗДОИ4You – винаги; логото на лицето (ако е качено) – до него
  const logos = [{ image: 'logo', width: o.logo ? 104 : 120 }];
  if (o.logo) logos.push({ image: 'plogo', fit: [96, 50], width: 96 });
  return [
    { columns: logos.concat([info]), columnGap: 12 },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 495, y2: 0, lineWidth: 1, lineColor: LINE }], margin: [0, 8, 0, 12] }
  ];
}

const outLine = p => ({ text: [{ text: 'Изх. № ', color: GRAY }, { text: p.outNo || '—', bold: true }, { text: ' / ' + (fmtDate(p.date) || '__.__.____') + ' г.', color: GRAY }], margin: [0, 0, 0, 12] });

function addressee(e) {
  return { margin: [260, 0, 0, 16], stack: [
    { text: 'ДО', bold: true },
    { text: e.name || '', bold: true },
    e.address ? { text: e.address } : null,
    e.email ? { text: 'имейл: ' + e.email, color: GRAY } : null
  ].filter(Boolean) };
}

const title = (t, sub) => [{ text: t, bold: true, fontSize: 14, alignment: 'center', color: BLUE, margin: [0, 6, 0, 2] }, sub ? { text: sub, alignment: 'center', margin: [0, 0, 0, 14] } : { text: '', margin: [0, 0, 0, 10] }];
const P = (t, opts) => Object.assign({ text: t, alignment: 'justify', margin: [0, 0, 0, 6] }, opts || {});
const numbered = list => ({ ol: list.map(t => ({ text: t, alignment: 'justify', margin: [0, 0, 0, 4] })), margin: [0, 2, 0, 8] });

/* кой иска: Сдружението или клиентът чрез Сдружението като пълномощник */
function fromBlock(p) {
  const o = p.org, a = p.applicant || {};
  // в официалните реквизити – само наименованието (марката е в бланката)
  const orgText = o.name + (o.eik ? `, ${idLabel(o.regBasis)} ${o.eik}` : '') + (o.address ? `, със седалище и адрес на управление: ${o.address}` : '') + (o.rep ? `, представлявано от ${o.rep}${o.repPosition ? ' – ' + o.repPosition : ''}` : '');
  if (p.mode !== 'Клиент') return P([{ text: 'от ', color: GRAY }, { text: orgText }]);
  const who = a.name + (a.eik ? `, ${idLabel(a.regBasis)} ${a.eik}` : '') + (a.address ? `, адрес: ${a.address}` : '') + (a.rep ? `, представлявано от ${a.rep}${a.repPosition ? ' – ' + a.repPosition : ''}` : '');
  return P([{ text: 'от ', color: GRAY }, { text: who, bold: true }, { text: ', чрез пълномощника ', color: GRAY }, { text: orgText }]);
}

const plural = p => p.mode !== 'Клиент' || (p.applicant && p.applicant.type && p.applicant.type !== 'Гражданин');

function correspondence(p) {
  const a = p.applicant || {};
  const parts = [`имейл: ${p.replyTo}`];
  if (p.mode === 'Клиент' && a.address) parts.push(`адрес на заявителя: ${a.address}`);
  else if (p.org.address) parts.push(`адрес: ${p.org.address}`);
  return P([{ text: 'Адрес за кореспонденция (чл. 25, ал. 1, т. 4 ЗДОИ): ', bold: true }, parts.join('; ') + '.']);
}

function signature(p) {
  const o = p.org, a = p.applicant || {}, electronic = p.signMode === 'electronic';
  // при подписване с КЕП: печат с името от сертификата (самият подпис е вграден в PDF файла)
  const line = p.kep ? { margin: [0, 2, 0, 8], table: { widths: ['*'], body: [[{ stack: [
    { text: 'Подписано с квалифициран електронен подпис', fontSize: 8.5, bold: true, color: BLUE },
    { text: p.kep.name, fontSize: 9 },
    { text: [p.kep.issuer ? 'издател: ' + p.kep.issuer : '', p.kep.at ? ' · ' + fmtTime(p.kep.at) : ''].join(''), fontSize: 7.5, color: GRAY }
  ], margin: [4, 3, 4, 3] }]] }, layout: { hLineColor: () => LINE, vLineColor: () => LINE, hLineWidth: () => 0.8, vLineWidth: () => 0.8 } }
    : electronic ? { text: 'Подписано с квалифициран електронен подпис.', fontSize: 9, color: GRAY, margin: [0, 0, 0, 20] } : { text: '....................................', margin: [0, 10, 0, 0] };
  // без въведен представител се подписва Сдружението, без да се повтаря наименованието
  const signer = o.rep ? [{ text: o.rep, bold: true }, { text: (o.repPosition ? o.repPosition + ', ' : '') + o.name, fontSize: 9, color: GRAY }] : [{ text: o.name, bold: true }];
  const who = p.mode === 'Клиент' ? [{ text: 'За заявителя ' + (a.name || '') + ',' }, { text: 'чрез пълномощник:' }, ...signer] : signer;
  return { margin: [0, 22, 0, 0], unbreakable: true, columns: [
    { width: '*', stack: [{ text: `гр. ${p.place || o.place || 'София'}` }, { text: (fmtDate(p.date) || '__.__.____') + ' г.' }] },
    { width: 230, stack: [{ text: 'С уважение:', margin: [0, 0, 0, 4] }, line, ...who] }
  ] };
}

const attachmentsList = p => (p.attachments && p.attachments.length ? [{ text: 'Приложения:', bold: true, margin: [0, 10, 0, 2] }, numbered(p.attachments)] : []);

function frame(p, content, label) {
  return withLogo({
    pageSize: 'A4', pageMargins: [50, 40, 50, 54],
    info: { title: `${label} ${p.outNo || ''}`.trim(), author: p.org.name, creator: 'ЗДОИ4You · my.zdoi4you.eu' },
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.22, color: '#111827' },
    content,
    footer: (page, count) => ({ margin: [50, 14, 50, 0], fontSize: 8, color: '#5A6B85', columns: [
      { text: [brandOf(p.org), webOf(p.org), p.outNo ? 'Изх. № ' + p.outNo : ''].filter(Boolean).join(' · ') },
      { text: `стр. ${page} от ${count}`, alignment: 'right', width: 70 }
    ] })
  }, p.org);
}

/* ---------- заявление (чл. 24–26 ЗДОИ) ---------- */

export function applicationDef(p) {
  const we = plural(p), reuse = /Повторно/.test(p.reqKind || '');
  const ask = reuse
    ? `На основание чл. 41в и сл. от Закона за достъп до обществена информация (ЗДОИ) ${we ? 'молим да ни бъде предоставена' : 'моля да ми бъде предоставена'} за повторно използване следната информация:`
    : `На основание чл. 24 и чл. 25 от Закона за достъп до обществена информация (ЗДОИ) ${we ? 'молим да ни бъде предоставена' : 'моля да ми бъде предоставена'} следната обществена информация:`;
  const content = [
    ...letterhead(p.org), outLine(p), addressee(p.entity || {}),
    ...title('ЗАЯВЛЕНИЕ', reuse ? 'за повторно използване на информация от обществения сектор' : 'за достъп до обществена информация'),
    fromBlock(p),
    p.title ? P([{ text: 'Относно: ', bold: true }, p.title]) : null,
    P(p.salutation || 'Уважаеми господин/госпожо,', { margin: [0, 6, 0, 6] }),
    P(ask),
    numbered(p.points || []),
    ...(p.motives ? [{ text: 'Мотиви', bold: true, margin: [0, 6, 0, 4] }, ...paras(p.motives).map(t => P(t))] : []),
    { text: `Форма на предоставяне на достъпа (чл. 25, ал. 1, т. 3 и чл. 26, ал. 1 ЗДОИ):`, bold: true, margin: [0, 6, 0, 2] },
    { ul: (p.access && p.access.length ? p.access : ['Копия, предоставени по електронен път']).map(a => a.replace(/\s*\(чл\. 26.*\)$/, '')), margin: [0, 0, 0, 4] },
    p.accessEmail ? P(`${we ? 'Желаем' : 'Желая'} информацията да бъде изпратена на имейл: ${p.accessEmail}.`) : null,
    P(p.noPublish
      ? `${we ? 'Не сме съгласни' : 'Не съм съгласен/съгласна'} исканата информация да бъде публикувана на платформата за достъп до обществена информация (чл. 25, ал. 1, т. 5 ЗДОИ).`
      : `${we ? 'Съгласни сме' : 'Съгласен/съгласна съм'} исканата информация да бъде публикувана на платформата за достъп до обществена информация (чл. 25, ал. 1, т. 5 ЗДОИ).`),
    correspondence(p),
    P(`${we ? 'Молим' : 'Моля'}, при отговор по имейл посочете Изх. № ${p.outNo || ''} и изпращайте кореспонденцията на ${p.replyTo}.`, { fontSize: 9.5, color: GRAY }),
    ...paras(p.extra).map(t => P(t)),
    ...attachmentsList(p),
    signature(p)
  ].filter(Boolean);
  return frame(p, content, 'Заявление');
}

/* ---------- уточнение (чл. 29 ЗДОИ) ---------- */

/* уточнение: по искане на органа (чл. 29, ал. 1 ЗДОИ – срокът тече от получаването му) или по инициатива на заявителя */
export const CLARIFY_BY = ['Искане на органа', 'Инициатива на заявителя'];

export function clarificationDef(p) {
  const we = plural(p), r = p.ref || {}, own = p.clarifyBy === CLARIFY_BY[1];
  const req = `${we ? 'наше' : 'мое'} заявление за достъп до обществена информация` +
    (r.outNo ? ` изх. № ${r.outNo}` + (r.outDate ? ` от ${fmtDate(r.outDate)} г.` : '') : '') +
    (r.entityRegNo ? `, вх. № ${r.entityRegNo}` + (r.entityRegDate ? ` от ${fmtDate(r.entityRegDate)} г.` : '') : '');
  const refText = own
    ? `По ${req}, по собствена инициатива ${we ? 'уточняваме' : 'уточнявам'} исканата информация, както следва:`
    : `Във връзка с ${r.letterNo ? `Ваше писмо изх. № ${r.letterNo}` + (r.letterDate ? ` от ${fmtDate(r.letterDate)} г.` : '') : 'Ваше уведомление'} по ${req}, на основание чл. 29, ал. 1 ЗДОИ ${we ? 'уточняваме' : 'уточнявам'} исканата информация, както следва:`;
  const content = [
    ...letterhead(p.org), outLine(p), addressee(p.entity || {}),
    ...title('УТОЧНЕНИЕ', 'на заявление за достъп до обществена информация' + (own ? '' : ' (чл. 29 ЗДОИ)')),
    fromBlock(p),
    P(p.salutation || 'Уважаеми господин/госпожо,', { margin: [0, 6, 0, 6] }),
    P(refText),
    numbered(p.points || []),
    ...(p.motives ? [{ text: 'Пояснения', bold: true, margin: [0, 6, 0, 4] }, ...paras(p.motives).map(t => P(t))] : []),
    own ? null : P(`${we ? 'Молим' : 'Моля'} срокът по чл. 28, ал. 1 ЗДОИ да се смята от датата на получаване на настоящото уточнение (чл. 29, ал. 1 ЗДОИ).`),
    correspondence(p),
    ...paras(p.extra).map(t => P(t)),
    ...attachmentsList(p),
    signature(p)
  ].filter(Boolean);
  return frame(p, content, 'Уточнение');
}

/* ---------- свободно писмо ---------- */

export function letterDef(p) {
  const content = [
    ...letterhead(p.org), outLine(p), addressee(p.entity || {}),
    p.title ? P([{ text: 'Относно: ', bold: true }, p.title], { margin: [0, 0, 0, 10] }) : null,
    P(p.salutation || 'Уважаеми господин/госпожо,', { margin: [0, 0, 0, 6] }),
    ...paras(p.body).map(t => P(t)),
    p.replyTo ? P(`Кореспонденция: ${p.replyTo}`, { fontSize: 9.5, color: GRAY }) : null,
    ...attachmentsList(p),
    signature(p)
  ].filter(Boolean);
  return frame(p, content, 'Писмо');
}

/* ---------- уведомление за промяна на адреса за кореспонденция (чл. 25, ал. 1, т. 4 ЗДОИ) ---------- */

export function addressChangeDef(p) {
  const we = plural(p), r = p.ref || {};
  const req = `${we ? 'наше' : 'мое'} заявление за ${/Повторно/.test(p.reqKind || '') ? 'повторно използване на информация' : 'достъп до обществена информация'}` +
    (r.outNo ? ` изх. № ${r.outNo}` + (r.outDate ? ` от ${fmtDate(r.outDate)} г.` : '') : '') +
    (r.entityRegNo ? `, вх. № ${r.entityRegNo}` + (r.entityRegDate ? ` от ${fmtDate(r.entityRegDate)} г.` : '') : '') +
    (p.title ? ` (относно: ${p.title})` : '');
  const from = p.effectiveDate ? `считано от ${fmtDate(p.effectiveDate)} г. ` : '';
  const rows = [
    ['Имейл за кореспонденция', p.newReplyTo || p.replyTo || ''],
    p.newAddress ? ['Адрес за кореспонденция', p.newAddress] : null,
    p.oldReplyTo ? ['Досегашен имейл', p.oldReplyTo] : null
  ].filter(Boolean);
  const content = [
    ...letterhead(p.org), outLine(p), addressee(p.entity || {}),
    ...title('УВЕДОМЛЕНИЕ', 'за промяна на адреса за кореспонденция'),
    fromBlock(p),
    P(p.salutation || 'Уважаеми господин/госпожо,', { margin: [0, 6, 0, 6] }),
    P(`Във връзка с ${req} ${we ? 'Ви уведомяваме' : 'Ви уведомявам'}, че ${from}адресът за кореспонденция по преписката (чл. 25, ал. 1, т. 4 ЗДОИ) се променя, както следва:`),
    { table: { widths: [150, '*'], body: rows.map(([k, v]) => [{ text: k, color: GRAY }, { text: v, bold: k !== 'Досегашен имейл' }]) }, layout: 'lightHorizontalLines', margin: [0, 2, 0, 10] },
    P(`${we ? 'Молим' : 'Моля'} всички отговори, решения, уведомления и искания по заявлението занапред да бъдат изпращани на новия адрес.` +
      (p.oldReplyTo ? ` Кореспонденцията, изпратена на досегашния имейл, също ще бъде получена, но ${we ? 'молим' : 'моля'} да не се използва.` : '')),
    P(`При отговор ${we ? 'молим' : 'моля'} да посочвате изх. № на заявлението${r.outNo ? ' (' + r.outNo + ')' : ''} и номера на настоящото уведомление.`, { fontSize: 9.5, color: GRAY }),
    ...paras(p.extra).map(t => P(t)),
    ...attachmentsList(p),
    signature(p)
  ].filter(Boolean);
  return frame(p, content, 'Уведомление');
}

/* ---------- документи за съда (жалби, молби, списък на разноските) ---------- */

/*
 * p: { org, outNo, date, docType, to, via, caseRef, heading, subheading, from, against, salutation, body, costs: [[вид, сума, документ]],
 *      costsTotal, petitumIntro, petitum: [...], extra, attachments, mode, applicant, place, signMode, kep }
 */
export function courtDocDef(p) {
  const addr = [{ text: 'ДО', bold: true }, { text: String(p.to || '').toUpperCase(), bold: true }];
  if (p.via) addr.push({ text: 'ЧРЕЗ ' + String(p.via).toUpperCase(), bold: true, margin: [0, 4, 0, 0] });
  if (p.caseRef) addr.push({ text: p.caseRef, margin: [0, 4, 0, 0] });
  const costs = p.costs && p.costs.length ? [{ margin: [0, 4, 0, 10], table: { headerRows: 1, widths: [18, '*', 80, 120], body: [
    ['№', 'Вид', 'Сума', 'Документ'].map(t => ({ text: t, bold: true, fontSize: 9.5 })),
    ...p.costs.map((c, i) => [String(i + 1), c[0], { text: c[1], alignment: 'right' }, c[2] || '']).map(r => r.map(c => (typeof c === 'string' ? { text: c, fontSize: 9.5 } : Object.assign({ fontSize: 9.5 }, c)))),
    [{ text: '', border: [false, false, false, false] }, { text: 'Общо', bold: true, fontSize: 9.5 }, { text: p.costsTotal || '', bold: true, alignment: 'right', fontSize: 9.5 }, { text: '', fontSize: 9.5 }]
  ] }, layout: 'lightHorizontalLines' }] : [];
  const content = [
    ...letterhead(p.org), outLine(p),
    { stack: addr, margin: [250, 0, 0, 14] },
    ...title(p.heading || 'МОЛБА', p.subheading),
    p.from ? P([{ text: 'от ' }, { text: p.from, bold: true }]) : null,
    p.against ? P([{ text: 'срещу ' }, { text: p.against, bold: true }]) : null,
    P(p.salutation || 'Уважаеми съдии,', { margin: [0, 8, 0, 6] }),
    ...paras(p.body).map(t => P(t)),
    ...costs,
    p.petitum && p.petitum.length ? [{ text: p.petitumIntro || 'Поради изложеното МОЛЯ:', bold: true, margin: [0, 6, 0, 2] }, numbered(p.petitum)] : null,
    ...paras(p.extra).map(t => P(t)),
    ...attachmentsList(p),
    signature(p)
  ].flat().filter(Boolean);
  return frame(p, content, p.heading || 'Документ');
}

/* ---------- протокол за проверка на електронните подписи (доказателство по делото) ---------- */

const IND = { 'TOTAL-PASSED': 'ПОТВЪРДЕН (TOTAL-PASSED)', 'TOTAL-FAILED': 'НЕВАЛИДЕН (TOTAL-FAILED)', INDETERMINATE: 'НЕОПРЕДЕЛЕН (INDETERMINATE)', NO_SIGNATURE: 'НЯМА ЕЛЕКТРОНЕН ПОДПИС', NOT_SUPPORTED: 'НЕПОДДЪРЖАН ФОРМАТ НА ПОДПИСА' };
const SUB = {
  HASH_FAILURE: 'съдържанието е променено след подписването', SIG_CRYPTO_FAILURE: 'подписът не съответства на ключа', REVOKED: 'удостоверението е прекратено/спряно преди подписа',
  REVOKED_NO_POE: 'удостоверението е прекратено след подписа, но липсва удостоверение за време', OUT_OF_BOUNDS_NO_POE: 'удостоверението не е било валидно към декларираното време',
  EXPIRED: 'удостоверението е изтекло', NO_CERTIFICATE_CHAIN_FOUND: 'издателят не е намерен в доверителен списък', REVOCATION_UNKNOWN: 'статусът на удостоверението не може да се провери',
  NO_SIGNING_CERTIFICATE_FOUND: 'липсва удостоверението на подписващия', SIGNED_DATA_NOT_FOUND: 'подписаният файл (към отделния подпис) не е намерен'
};
const yes = v => (v ? 'да' : 'не');
const t = iso => (iso ? new Date(iso).toLocaleString('bg-BG', { timeZone: 'Europe/Sofia', dateStyle: 'short', timeStyle: 'medium' }) + ' ч.' : '—');
const REV = r => (r.status === 'good' ? 'валидно – не е прекратено/спряно' : r.status === 'revoked' ? 'ПРЕКРАТЕНО/СПРЯНО' + (r.revokedAt ? ' на ' + t(r.revokedAt) : '') + (r.reason ? ' (' + r.reason + ')' : '') : 'не е проверено' + (r.note ? ': ' + r.note : ''));
const small = (txt, o) => Object.assign({ text: txt, fontSize: 8.5 }, o || {});
/* дълги низове без интервал (хешове, адреси, Message-ID) не се пренасят и разширяват таблицата извън страницата:
   хешовете – на групи по 8 знака, останалите – на части по 40 */
const breakLong = v => String(v).replace(/\b[0-9A-Fa-f]{24,}\b/g, x => x.match(/.{1,8}/g).join(' ')).replace(/\S{41,}/g, x => x.match(/.{1,40}/g).join(' '));
const mono = txt => ({ text: breakLong(txt || '—'), fontSize: 7.5, font: 'Roboto', characterSpacing: 0.2 });
const kvT = rows => ({ table: { widths: [150, '*'], dontBreakRows: true, body: rows.filter(Boolean).map(([k, v]) => [{ text: k, color: GRAY, fontSize: 8.5 }, typeof v === 'object' && v && !Array.isArray(v) ? v : { text: v === '' || v === null || v === undefined ? '—' : breakLong(Array.isArray(v) ? (v.length ? v.join('\n') : '—') : String(v)), fontSize: 8.5 }]) }, layout: 'lightHorizontalLines', margin: [0, 0, 0, 6] });
const h3 = txt => ({ text: txt, bold: true, fontSize: 10.5, color: BLUE, margin: [0, 10, 0, 4] });

function certRows(c, label) {
  return [
    [label || 'Удостоверение', c.subject],
    ['Издател', c.issuer],
    ['Сериен номер', mono(c.serial)],
    ['Отпечатък SHA-256', mono(c.sha256)],
    ['Валидност', t(c.notBefore) + ' – ' + t(c.notAfter)],
    ['Ключ / алгоритъм на подписа', c.key + ' / ' + c.sigAlg],
    c.keyUsage ? ['Предназначение на ключа', c.keyUsage.join(', ')] : null,
    c.policies && c.policies.length ? ['Политики', c.policies] : null,
    c.qc ? ['QC декларации (ETSI EN 319 412-5)', [c.qc.compliance ? 'QcCompliance – квалифицирано удостоверение' : 'няма QcCompliance', c.qc.sscd ? 'QcSSCD – ключът е в устройство за създаване на квалифициран подпис (QSCD)' : 'няма QcSSCD',
      c.qc.types.length ? 'QcType: ' + c.qc.types.join(', ') : '', c.qc.pds.length ? 'PDS: ' + c.qc.pds.join(', ') : ''].filter(Boolean)] : null,
    c.ski ? ['Идентификатор на ключа (SKI)', mono(c.ski)] : null
  ];
}

export function protocolDef(p) {
  const r = p.report || {}, src = p.source || {}, op = p.operator || {}, doc = r.document || {}, sum = r.summary || {};
  const sigs = (r.signatures || []);
  const content = [...letterhead(p.org), outLine(p), ...title('ПРОТОКОЛ', 'за проверка на електронните подписи в получен документ')];
  content.push(P('Настоящият протокол удостоверява резултата от проверката на електронните подписи в документа, описан по-долу, извършена от ' + (op.name || op.username) + (op.position ? ', ' + op.position : '') +
    ' чрез ' + (r.validator || 'ADM ЗДОИ4You') + ' на ' + t(r.checkedAt) + ' (часова зона Europe/Sofia), по реда на Регламент (ЕС) № 910/2014 и ЗЕДЕУУ.', { fontSize: 9.5 }));

  content.push(h3('1. Проверен документ'));
  content.push(kvT([
    ['Файл', doc.name], ['Формат', doc.format], ['Размер', doc.size + ' байта'], ['SHA-256 на файла', mono(doc.sha256)], ['SHA-512 на файла', mono(doc.sha512)],
    doc.signedFile ? ['Подписан файл (към отделния подпис)', doc.signedFile + ', ' + doc.signedFileSize + ' байта'] : null, doc.signedFile ? ['SHA-256 на подписания файл', mono(doc.signedFileSha256)] : null,
    doc.contentSha256 ? ['Вградено съдържание', (doc.contentType || 'файл') + ', ' + doc.contentSize + ' байта'] : null, doc.contentSha256 ? ['SHA-256 на вграденото съдържание', mono(doc.contentSha256)] : null,
    doc.revisions !== undefined ? ['Версии (ревизии) в PDF', doc.revisions] : null, doc.revisions !== undefined && sigs.length ? ['Последният подпис обхваща целия файл', yes(doc.lastCoversAll)] : null,
    doc.hasDss !== undefined ? ['Данни за дългосрочна проверка (DSS)', yes(doc.hasDss)] : null,
    ['Преписка', src.regNo + (src.entity ? ' – ' + src.entity : '')], ['Получен', (src.channel || '') + (src.receivedAt ? ' на ' + t(src.receivedAt) : '')],
    src.from ? ['Подател', src.from] : null, src.subject ? ['Тема / описание', src.subject] : null, src.ref ? ['Идентификатор (ССЕВ, вх. №)', src.ref] : null,
    src.messageId ? ['Message-ID', mono(src.messageId)] : null
  ]));

  content.push(h3('2. Резултат'));
  content.push(kvT([
    ['Общ резултат', { text: IND[sum.overall] || sum.overall, bold: true, fontSize: 9, color: sum.overall === 'TOTAL-PASSED' ? '#157F3B' : sum.overall === 'TOTAL-FAILED' ? '#B42318' : '#8A5200' }],
    ['Брой подписи / печати за време', (sum.count || 0) + ' / ' + (sum.timestamps || 0)],
    ...sigs.map((s, i) => [`Подпис ${i + 1}`, s.kind === 'docTimestamp' ? 'документен печат за време – ' + (IND[s.indication] || s.indication) + (s.timestamp && s.timestamp.time ? ', ' + t(s.timestamp.time) : '')
      : (s.signer ? s.signer.name + (s.signer.org ? ', ' + s.signer.org : '') : '—') + ' – ' + (IND[s.indication] || s.indication || 'грешка') + (s.subIndication ? ' (' + (SUB[s.subIndication] || s.subIndication) + ')' : '') + '\n' + (s.qualification || s.error || '')])
  ]));
  if (doc.unsupported) content.push(P(doc.unsupported, { fontSize: 9 }));
  if (sum.overall === 'NO_SIGNATURE') content.push(P('Във файла не е открит електронен подпис. Протоколът удостоверява съдържанието на получения файл чрез отпечатъците му (SHA-256 и SHA-512), източника и времето на получаване.', { fontSize: 9 }));
  (r.legal || []).forEach(x => content.push(P(x, { fontSize: 9 })));

  if (sigs.length) content.push(h3('3. Технически данни'));
  sigs.forEach((s, i) => {
    content.push({ text: `Подпис ${i + 1}` + (s.kind === 'docTimestamp' ? ' – документен печат за време' : s.signer ? ' – ' + s.signer.name : ''), bold: true, fontSize: 9.5, margin: [0, 6, 0, 3] });
    if (s.error) content.push(small('Грешка: ' + s.error, { color: '#B42318', margin: [0, 0, 0, 4] }));
    content.push(kvT([
      ['Формат / ниво', (s.level || s.subFilter || '—') + (s.subFilter ? ' (SubFilter ' + s.subFilter + ')' : '')],
      ['ByteRange', (s.byteRange || []).join(' ') + (s.coversAll ? ' – целият файл' : ' – без последните ' + s.unsignedBytes + ' байта')],
      s.signedSha256 ? ['SHA-256 на подписаните байтове', mono(s.signedSha256.toUpperCase())] : null,
      s.kind === 'signature' ? ['Алгоритми', 'хеш ' + (s.digestAlg || '—') + '; подпис ' + (s.sigAlg || '—')] : null,
      s.kind === 'signature' ? ['Цялост (хеш = messageDigest)', yes(s.checks.integrity)] : null,
      s.kind === 'signature' ? ['Криптографска проверка на подписа', yes(s.checks.signature)] : null,
      s.kind === 'signature' ? ['Атрибут signingCertificate (v2)', yes(s.checks.signingCertAttr)] : null,
      s.reason ? ['Основание (Reason)', s.reason] : null, s.location ? ['Място (Location)', s.location] : null,
      s.kind === 'signature' ? ['Декларирано време на подписа', s.claimedTime ? t(s.claimedTime) + ' (' + s.claimedSource + ')' : '—'] : null,
      s.timestamp ? ['Удостоверение за време', s.timestamp.error ? 'грешка: ' + s.timestamp.error : t(s.timestamp.time) + '; издател: ' + (s.timestamp.tsa ? s.timestamp.tsa.subject : '—') +
        '; отпечатък: ' + yes(s.timestamp.imprint) + '; подпис: ' + yes(s.timestamp.signature) + '; квалифициран: ' + yes(s.timestamp.qualified) + '; сериен № ' + (s.timestamp.serial || '—') + '; политика ' + (s.timestamp.policy || '—')] : null,
      s.kind === 'signature' ? ['Време, използвано за проверката', t(s.timeUsed) + ' (' + s.timeUsedSource + ')'] : null,
      s.kind === 'signature' ? ['Валидно към момента на подписа / сега', yes(s.checks.validAtTime) + ' / ' + yes(s.checks.validNow)] : null
    ]));
    if (s.signer) content.push(kvT(certRows(s.signer, 'Подписващ (субект)')));
    (s.chain || []).forEach(c => content.push(kvT(certRows(c, 'Издател – ' + c.role))));
    if (s.trust) content.push(kvT([
      ['Доверителен списък', s.trust.found ? s.trust.tl.cc + ' – ' + (s.trust.tl.operator || '') + '; № ' + s.trust.tl.seq + ', издаден ' + t(s.trust.tl.issued) + ', следващ ' + t(s.trust.tl.next) : (s.trust.error || 'издателят не е намерен в доверителен списък')],
      s.trust.found ? ['Адрес на списъка', mono(s.trust.tl.url)] : null,
      s.trust.found ? ['Доставчик / услуга', s.trust.tsp + ' / ' + s.trust.service + ' (' + s.trust.type + ')'] : null,
      s.trust.found ? ['Статус на услугата към момента на подписа', s.trust.statusAt + (s.trust.statusFrom ? ' (от ' + t(s.trust.statusFrom) + ')' : '') + '; сега: ' + s.trust.statusNow] : null
    ]));
    if (s.revocation) content.push(kvT([
      ['Прекратяване/спиране', REV(s.revocation)], ['Метод и адрес', (s.revocation.method || '—') + (s.revocation.url ? ' – ' + s.revocation.url : '')], ['Проверено на', t(s.revocation.checkedAt)]
    ]));
    if (s.warnings && s.warnings.length) content.push({ ul: s.warnings.map(w => small(w)), margin: [0, 0, 0, 6] });
    if (s.kind === 'signature') content.push(small('Заключение: ' + (IND[s.indication] || s.indication) + (s.subIndication ? ' – ' + (SUB[s.subIndication] || s.subIndication) : '') + '. Вид: ' + s.qualification + '.', { bold: true, margin: [0, 0, 0, 6] }));
  });

  content.push(h3('4. Методика и правно основание'));
  (r.method || []).forEach(x => content.push(P(x, { fontSize: 8.5 })));

  content.push(h3('5. Цялост на протокола'));
  content.push(kvT([
    ['Контролна сума на данните от проверката (SHA-256)', mono(p.reportHash)],
    ['Изготвил', (op.name || op.username) + (op.position ? ', ' + op.position : '') + ' (потребител ' + op.username + ')'],
    ['Формат на данните', r.format]
  ]));
  content.push(P('Протоколът се подписва с квалифицирания електронен подпис на изготвилия го служител. Проверяваният файл се прилага към протокола; съвпадението му се установява по отпечатъка SHA-256 по т. 1.', { fontSize: 9 }));
  content.push(signature(Object.assign({}, p, { org: Object.assign({}, p.org, { rep: op.name || op.username, repPosition: op.position || '' }), mode: '', signMode: 'electronic' })));
  return frame(p, content, 'Протокол за проверка на подписи');
}

export const DEFS = { 'Заявление': applicationDef, 'Уточнение': clarificationDef, 'Писмо': letterDef, 'Промяна на адрес': addressChangeDef, 'Съдебен документ': courtDocDef, 'Протокол за проверка на подпис': protocolDef };

/* ---------- досие на преписка (за съда и при връчвания) ---------- */

const heading = t => ({ text: t, bold: true, fontSize: 12, color: BLUE, margin: [0, 14, 0, 6] });
const kvTable = rows => ({ table: { widths: [150, '*'], body: rows.filter(r => r && r[1] !== undefined).map(([k, v]) => [{ text: k, color: GRAY, fontSize: 9.5 }, { text: v === '' || v === null ? '—' : String(v), fontSize: 9.5 }]) }, layout: 'lightHorizontalLines' });
const grid = (head, rows, widths) => rows.length
  ? { table: { headerRows: 1, dontBreakRows: true, widths, body: [head.map(t => ({ text: t, bold: true, fontSize: 8.5 }))].concat(rows.map(r => r.map(c => ({ text: String(c === undefined || c === null || c === '' ? '—' : c), fontSize: 8.5 })))) }, layout: 'lightHorizontalLines' }
  : { text: 'Няма.', color: GRAY, fontSize: 9.5 };

/* data: { title, subtitle, org, sections: [{ heading, kv?: [[k, v]], table?: { head, rows, widths }, text? }] } */
export function dossierDef(data) {
  const p = { org: data.org, outNo: '' };
  const content = [...letterhead(data.org), ...title(data.title, data.subtitle)];
  data.sections.forEach(s => {
    content.push(heading(s.heading));
    if (s.kv) content.push(kvTable(s.kv));
    if (s.table) content.push(grid(s.table.head, s.table.rows, s.table.widths));
    if (s.text) paras(s.text).forEach(t => content.push(P(t, { fontSize: 9.5 })));
    if (s.blocks) s.blocks.forEach(b => content.push({ margin: [0, 4, 0, 8], stack: [{ text: b.head, bold: true, fontSize: 9.5 }, ...paras(b.text).map(t => P(t, { fontSize: 9 }))] }));
  });
  content.push({ text: `Досието е генерирано на ${fmtTime(data.generatedAt)} от ${data.generatedBy} чрез ADM ЗДОИ4You.`, fontSize: 8.5, color: GRAY, margin: [0, 18, 0, 0] });
  return frame(p, content, data.title);
}

/* ---------- изход ---------- */

export async function blobOf(def) {
  def.images = await images(def);
  return new Promise(ok => window.pdfMake.createPdf(def).getBlob(ok));
}
export async function base64Of(def) {
  def.images = await images(def);
  return new Promise(ok => window.pdfMake.createPdf(def).getBase64(ok));
}
export async function open(def, name) {
  const blob = await blobOf(def);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function preview(def) {
  const blob = await blobOf(def);
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
export { fmtDate, fmtTime };
