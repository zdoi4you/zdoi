/*
 * Проверка на електронните подписи в получени документи (PDF, PAdES / PDF PKCS#7) по Регламент (ЕС) № 910/2014
 * (eIDAS, чл. 25, 26, 32, 35, 41, 42), Регламент за изпълнение (ЕС) 2015/1506 и ЗЕДЕУУ (чл. 13) – по процеса на
 * ETSI EN 319 102-1 и квалификацията по ETSI TS 119 615 / TS 119 172-4:
 *   1. цялост – хешът на подписаните байтове (ByteRange) съвпада с messageDigest; обхват на документа;
 *   2. криптографска проверка на подписа с ключа от удостоверението;
 *   3. удостоверение за време (RFC 3161) – отпечатък, подпис на доставчика, време; документен печат за време (B-LTA);
 *   4. удостоверението на подписващия – валидност към момента на подписа, ключ, предназначение, QC декларации, политики;
 *   5. верига до издател, вписан в Доверителния списък на държавата (EU LOTL → национален списък), и статусът на
 *      услугата (CA/QC, TSA/QTST) към момента на подписа (с историята на статусите);
 *   6. прекратяване/спиране – OCSP или CRL на доставчика, сравнено с времето на подписа;
 *   7. заключение TOTAL-PASSED / INDETERMINATE / TOTAL-FAILED и квалификация (КЕП, квалифициран е-печат, УЕП…).
 * Това е техническа проверка от системата – не е квалифицирана услуга по валидиране (чл. 33 от Регламента).
 * Резултатът е данни; протоколът (PDF) се изготвя в браузъра и се подписва с КЕП на служителя.
 */

import * as D from './der.js';
import { fail, line, stamp } from './util.js';
import { cached } from './core.js';
import { checkRevocation, verifySig, findIssuer } from './revocation.js';

export const VALIDATOR = 'ADM ЗДОИ4You – модул за проверка на електронни подписи, версия 1.0';
export const LOTL_URL = 'https://ec.europa.eu/tools/lotl/eu-lotl.xml';

const eq = (x, y) => !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]);
const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');
const HASH = { '2.16.840.1.101.3.4.2.1': 'SHA-256', '2.16.840.1.101.3.4.2.2': 'SHA-384', '2.16.840.1.101.3.4.2.3': 'SHA-512', '1.3.14.3.2.26': 'SHA-1' };
const digest = async (alg, data) => new Uint8Array(await crypto.subtle.digest(alg, data));
const sha256hex = async data => hex(await digest('SHA-256', data));
const OIDS = {
  rsa: '1.2.840.113549.1.1.1', pss: '1.2.840.113549.1.1.10', tstInfo: '1.2.840.113549.1.9.16.1.4', tst: '1.2.840.113549.1.9.16.2.14',
  signingTime: '1.2.840.113549.1.9.5', signingCert: '1.2.840.113549.1.9.16.2.12', ski: '2.5.29.14', aki: '2.5.29.35', policies: '2.5.29.32',
  eku: '2.5.29.37', qcType: '0.4.0.1862.1.6', qcPds: '0.4.0.1862.1.5', qcLimit: '0.4.0.1862.1.2', qcRetention: '0.4.0.1862.1.3', qcCC: '0.4.0.1862.1.7',
  semantics2: '0.4.0.194121.1.2', revocationRefs: '1.2.840.113549.1.9.16.2.22', adbeRevInfo: '1.2.840.113583.1.1.8'
};
const SIG_NAMES = {
  '1.2.840.113549.1.1.11': 'RSA (PKCS#1 v1.5) с SHA-256', '1.2.840.113549.1.1.12': 'RSA (PKCS#1 v1.5) с SHA-384', '1.2.840.113549.1.1.13': 'RSA (PKCS#1 v1.5) с SHA-512',
  '1.2.840.113549.1.1.5': 'RSA (PKCS#1 v1.5) с SHA-1', '1.2.840.113549.1.1.10': 'RSASSA-PSS', '1.2.840.10045.4.3.2': 'ECDSA с SHA-256', '1.2.840.10045.4.3.3': 'ECDSA с SHA-384',
  '1.2.840.10045.4.3.4': 'ECDSA с SHA-512', '1.2.840.113549.1.1.1': 'RSA'
};
const RSA_BY_HASH = { 'SHA-256': '1.2.840.113549.1.1.11', 'SHA-384': '1.2.840.113549.1.1.12', 'SHA-512': '1.2.840.113549.1.1.13', 'SHA-1': '1.2.840.113549.1.1.5' };
const POLICY_NAMES = {
  '0.4.0.194112.1.0': 'QCP-n (квалифицирано удостоверение за физическо лице)', '0.4.0.194112.1.1': 'QCP-l (квалифицирано удостоверение за юридическо лице – печат)',
  '0.4.0.194112.1.2': 'QCP-n-qscd (квалифицирано, ключ в QSCD – физическо лице)', '0.4.0.194112.1.3': 'QCP-l-qscd (квалифицирано, ключ в QSCD – юридическо лице)',
  '0.4.0.194112.1.4': 'QCP-w (уебсайт)', '0.4.0.2042.1.1': 'NCP', '0.4.0.2042.1.2': 'NCP+', '0.4.0.2042.1.3': 'LCP'
};
const QC_TYPES = { '0.4.0.1862.1.6.1': 'esign – електронен подпис', '0.4.0.1862.1.6.2': 'eseal – електронен печат', '0.4.0.1862.1.6.3': 'web – уебсайт' };
const DN_NAMES = { '2.5.4.3': 'CN', '2.5.4.5': 'SERIALNUMBER', '2.5.4.42': 'G', '2.5.4.4': 'SN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.97': 'organizationIdentifier', '1.2.840.113549.1.9.1': 'E', '2.5.4.12': 'T', '2.5.4.9': 'STREET', '2.5.4.17': 'PostalCode' };
const KU_NAMES = ['digitalSignature', 'nonRepudiation (contentCommitment)', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'];

/* личните идентификатори (PNOBG-…, IDCBG-…) се показват изцяло – така са в удостоверението и така се доказва подписващият */
function dnString(raw) {
  const n = D.read(raw), parts = [];
  for (const rdn of n.children || []) for (const atv of rdn.children || []) {
    const id = D.oidStr(atv.children[0].body), v = atv.children[1];
    const val = new TextDecoder(v.tag === 0x1e ? 'utf-16be' : 'utf-8').decode(v.body);
    parts.push((DN_NAMES[id] || id) + '=' + val);
  }
  return parts.join(', ');
}

/* разширенията на удостоверението: oid → { critical, value } */
function extensions(der) {
  const tbs = D.read(der).children[0];
  const node = tbs.children.find(x => x.tag === 0xa3);
  const out = {};
  if (node) for (const e of node.children[0].children) {
    out[D.oidStr(e.children[0].body)] = { critical: e.children.length === 3 && e.children[1].tag === 0x01 && e.children[1].body[0] !== 0, value: e.children[e.children.length - 1].body };
  }
  return out;
}

function keyInfo(cert) {
  try {
    const spki = D.read(cert.spki), bits = spki.children[1].body.subarray(1);
    if (cert.keyAlg === D.OID.ec) return 'EC ' + (cert.curve === D.OID.p384 ? 'P-384' : cert.curve === D.OID.p256 ? 'P-256' : cert.curve) + ' (' + (cert.curve === D.OID.p384 ? 384 : 256) + ' бита)';
    const rsa = D.read(bits);
    let mod = rsa.children[0].body;
    while (mod.length && mod[0] === 0) mod = mod.subarray(1);
    return 'RSA ' + (mod.length * 8) + ' бита';
  } catch (_) { return cert.keyAlg; }
}

/* подробни данни за удостоверение – за протокола */
export async function certDetails(cert) {
  const ext = extensions(cert.der);
  const policies = [];
  if (ext[OIDS.policies]) for (const p of D.read(ext[OIDS.policies].value).children) { const id = D.oidStr(p.children[0].body); policies.push(id + (POLICY_NAMES[id] ? ' – ' + POLICY_NAMES[id] : '')); }
  const qc = { compliance: false, sscd: false, types: [], pds: [], other: [] };
  if (ext[D.OID.qcStatements]) for (const st of D.read(ext[D.OID.qcStatements].value).children) {
    const id = D.oidStr(st.children[0].body);
    if (id === D.OID.qcCompliance) qc.compliance = true;
    else if (id === D.OID.qcSscd) qc.sscd = true;
    else if (id === OIDS.qcType && st.children[1]) for (const t of st.children[1].children || []) qc.types.push(QC_TYPES[D.oidStr(t.body)] || D.oidStr(t.body));
    else if (id === OIDS.qcPds && st.children[1]) for (const loc of st.children[1].children || []) { const u = loc.children && loc.children[0]; if (u) qc.pds.push(new TextDecoder().decode(u.body)); }
    else if (id === OIDS.qcCC && st.children[1]) qc.other.push('държава: ' + new TextDecoder().decode(st.children[1].body));
    else if (id !== OIDS.semantics2) qc.other.push(id);
  }
  const ku = [];
  if (ext[D.OID.keyUsage]) { const b = D.read(ext[D.OID.keyUsage].value).body; const v = (b[1] || 0) << 8 | (b[2] || 0); KU_NAMES.forEach((n, i) => { if (v & (0x8000 >> i)) ku.push(n); }); }
  const ski = ext[OIDS.ski] ? hex(D.read(ext[OIDS.ski].value).body) : '';
  let aki = '';
  if (ext[OIDS.aki]) { const k = (D.read(ext[OIDS.aki].value).children || []).find(x => x.tag === 0x80); if (k) aki = hex(k.body); }
  return {
    subject: dnString(cert.subjectRaw), issuer: dnString(cert.issuerRaw), name: cert.name, org: cert.org, id: cert.id,
    serial: hex(cert.serial).toUpperCase(), sha256: (await sha256hex(cert.der)).toUpperCase(), spkiSha256: await sha256hex(cert.spki),
    notBefore: cert.notBefore ? cert.notBefore.toISOString() : '', notAfter: cert.notAfter ? cert.notAfter.toISOString() : '',
    key: keyInfo(cert), sigAlg: SIG_NAMES[cert.sigAlg] || cert.sigAlg, keyUsage: ku, policies, qc, ski, aki,
    crl: cert.crl, ocsp: cert.ocsp, caIssuers: cert.caIssuers, country: (cert.subject[D.OID.country] || cert.issuer[D.OID.country] || '').toUpperCase()
  };
}

/* ---------- CMS: SignerInfo с подписаните и неподписаните атрибути ---------- */

export function parseCms(der) {
  const ci = D.read(der), sd = ci.children[1].children[0], parts = sd.children;
  const enc = parts[2];
  const eContentType = D.oidStr(enc.children[0].body);
  const eContent = enc.children[1] ? enc.children[1].children[0].body : null;
  const certsNode = parts.find(x => x.tag === 0xa0);
  const certs = certsNode ? certsNode.children.filter(x => x.tag === 0x30).map(x => x.raw) : [];
  const head = { eContentType, eContent, certs };
  // всеки SignerInfo (съподписи в CAdES); първият – и в самия обект, както досега
  const signers = parts[parts.length - 1].children.map(si => Object.assign({}, head, signerInfo(si)));
  return Object.assign({ signers }, signers[0] || head);
}

function signerInfo(si) {
  const f = si.children;
  const sid = f[1];
  const digestAlg = D.oidStr(f[2].children[0].body);
  let i = 3, attrsNode = null;
  if (f[3].tag === 0xa0) { attrsNode = f[3]; i = 4; }
  const sigAlg = D.oidStr(f[i].children[0].body), signature = f[i + 1].body;
  const unsignedNode = f[i + 2] && f[i + 2].tag === 0xa1 ? f[i + 2] : null;
  const attrs = {}, unsigned = {};
  if (attrsNode) for (const a of attrsNode.children) attrs[D.oidStr(a.children[0].body)] = a.children[1].children[0];
  if (unsignedNode) for (const a of unsignedNode.children) unsigned[D.oidStr(a.children[0].body)] = a.children[1].children;
  return {
    digestAlg, sigAlg, signature, attrs, unsigned,
    sidSerial: sid.tag === 0x30 ? sid.children[1].body : null, sidSki: sid.tag === 0x80 ? sid.body : null,
    attrsDer: attrsNode ? D.concat([Uint8Array.of(0x31), attrsNode.raw.subarray(1)]) : null
  };
}

function signerCert(c) {
  for (const der of c.certs) {
    try {
      const x = D.parseCert(der);
      if (c.sidSerial && eq(x.serial, c.sidSerial)) return x;
      if (c.sidSki) { const e = extensions(der)[OIDS.ski]; if (e && eq(D.read(e.value).body, c.sidSki)) return x; }
    } catch (_) { /* следващият */ }
  }
  return null;
}

/* алгоритъмът за verifySig: в CMS често е само „rsaEncryption“ – хешът е отделно */
const verifyAlg = (cert, c) => (c.sigAlg === OIDS.rsa ? RSA_BY_HASH[HASH[c.digestAlg]] : cert.keyAlg === D.OID.ec && !/^1\.2\.840\.10045\.4\.3/.test(c.sigAlg) ? (HASH[c.digestAlg] === 'SHA-384' ? D.OID.ecdsaSha384 : D.OID.ecdsaSha256) : c.sigAlg);

const genTime = n => {
  const s = new TextDecoder().decode(n.body);
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[.,](\d+))?Z$/.exec(s);
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], Number(('0.' + (m[7] || '0'))) * 1000)) : null;
};
const asnTime = n => {
  if (n.tag === 0x18) return genTime(n);
  const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(new TextDecoder().decode(n.body));
  return m ? new Date(Date.UTC((+m[1] < 50 ? 2000 : 1900) + +m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
};

/* ---------- Доверителни списъци (EU LOTL → национален списък) ---------- */

const tag = (s, name) => { const m = new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?' + name + '>').exec(s); return m ? m[1] : ''; };
const tags = (s, name) => [...s.matchAll(new RegExp('<(?:\\w+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?' + name + '>', 'g'))].map(m => m[1]);
const xmlText = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
const nameIn = (s, lang) => { const all = [...s.matchAll(/<(?:\w+:)?Name xml:lang="([a-z]{2})"[^>]*>([^<]*)</g)]; const x = all.find(a => a[1] === lang) || all.find(a => a[1] === 'en') || all[0]; return x ? xmlText(x[2]) : ''; };

async function getText(app, url) {
  const f = app.env.__tl || fetch;
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await f(url, { headers: { 'User-Agent': 'ADM-ZDOI4You/1.0 (+https://adm.zdoi.eu)', Accept: 'application/xml, text/xml' }, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

/* LOTL: адресите на националните списъци (XML) по държави; кеш 7 дни */
async function tlPointers(app) {
  return cached(app, 'tl:lotl', 7 * 86400, async () => {
    const xml = await getText(app, LOTL_URL);
    const out = {};
    for (const p of tags(xml, 'OtherTSLPointer')) {
      const cc = xmlText(tag(p, 'SchemeTerritory')).toUpperCase(), url = xmlText(tag(p, 'TSLLocation')), mime = xmlText(tag(p, 'MimeType'));
      if (cc && url && cc !== 'EU' && (/tsl\+xml/.test(mime) || /\.(xml|xtsl)$/i.test(url) || /xml$/i.test(url)) && !/\.pdf$/i.test(url)) out[cc] = url;
    }
    return out;
  });
}

/* националният списък – доставчиците, услугите (тип, статус, история) и отпечатъците на ключовете им; кеш 1 ден */
export async function trustedList(app, cc) {
  const code = String(cc || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  if (!code) return null;
  return cached(app, 'tl:' + code, 86400, async () => {
    const url = (await tlPointers(app))[code === 'GR' ? 'EL' : code];
    if (!url) return { cc: code, error: 'Няма доверителен списък на държавата в EU LOTL.', services: [] };
    const xml = await getText(app, url);
    const services = [];
    for (const tsp of tags(xml, 'TrustServiceProvider')) {
      const tspName = nameIn(tag(tsp, 'TSPName'), 'bg');
      for (const svc of tags(tsp, 'TSPService')) {
        const info = tag(svc, 'ServiceInformation');
        const keys = [];
        for (const b64 of tags(tag(info, 'ServiceDigitalIdentity'), 'X509Certificate')) {
          try { const c = D.parseCert(D.unb64(xmlText(b64))); keys.push({ spki: await sha256hex(c.spki), cn: c.name || c.issuerName }); } catch (_) { /* повреден запис */ }
        }
        const skis = tags(tag(info, 'ServiceDigitalIdentity'), 'X509SKI').map(x => { try { return hex(D.unb64(xmlText(x))); } catch (_) { return ''; } }).filter(Boolean);
        if (!keys.length && !skis.length) continue;
        const history = tags(tag(svc, 'ServiceHistory'), 'ServiceHistoryInstance').map(h => ({ status: xmlText(tag(h, 'ServiceStatus')).split('/').pop(), from: xmlText(tag(h, 'StatusStartingTime')) }));
        services.push({
          tsp: tspName, name: nameIn(tag(info, 'ServiceName'), 'bg'), type: xmlText(tag(info, 'ServiceTypeIdentifier')).replace('http://uri.etsi.org/TrstSvc/Svctype/', ''),
          status: xmlText(tag(info, 'ServiceStatus')).split('/').pop(), from: xmlText(tag(info, 'StatusStartingTime')), history, keys, skis
        });
      }
    }
    return {
      cc: code, url, seq: xmlText(tag(xml, 'TSLSequenceNumber')), issued: xmlText(tag(xml, 'ListIssueDateTime')),
      next: xmlText(tag(tag(xml, 'NextUpdate'), 'dateTime')), operator: nameIn(tag(xml, 'SchemeOperatorName'), 'bg'), services
    };
  });
}

const QUALIFIED_STATUS = ['granted', 'undersupervision', 'accredited', 'supervisionincessation'];
/* статусът на услугата към даден момент – по текущия статус и историята */
function statusAt(svc, at) {
  const all = [{ status: svc.status, from: svc.from }].concat(svc.history || []).filter(x => x.from).sort((a, b) => b.from.localeCompare(a.from));
  const t = (at || new Date()).toISOString();
  return (all.find(x => x.from <= t) || { status: 'не е вписана към този момент', from: '' });
}

/* услугата в списъка за ключа на издателя (или на неговия издател): тип по шаблон, статус към момента */
async function tlLookup(app, certs, typeRe, at) {
  for (const c of certs.filter(Boolean)) {
    const cc = (c.subject[D.OID.country] || '').toUpperCase();
    let tl;
    try { tl = await trustedList(app, cc); } catch (e) { return { found: false, error: 'Доверителният списък (' + cc + ') не може да се зареди: ' + e.message }; }
    if (!tl) continue;
    if (tl.error) return { found: false, error: tl.error, tl: { cc: tl.cc } };
    const spki = await sha256hex(c.spki);
    let ski = '';
    try { const e = extensions(c.der)[OIDS.ski]; if (e) ski = hex(D.read(e.value).body); } catch (_) { /* без SKI */ }
    const hits = tl.services.filter(s => typeRe.test(s.type) && (s.keys.some(k => k.spki === spki) || (ski && s.skis.includes(ski))));
    if (hits.length) {
      // при няколко записа за същия ключ – този със статус „квалифициран“ към момента
      const ranked = hits.map(s => Object.assign({ at: statusAt(s, at) }, s)).sort((a, b) => Number(QUALIFIED_STATUS.includes(b.at.status)) - Number(QUALIFIED_STATUS.includes(a.at.status)));
      const s = ranked[0];
      return {
        found: true, tsp: s.tsp, service: s.name, type: s.type, statusAt: s.at.status, statusFrom: s.at.from, statusNow: s.status,
        qualified: QUALIFIED_STATUS.includes(s.at.status), matchedCert: c.name || c.issuerName,
        tl: { cc: tl.cc, url: tl.url, seq: tl.seq, issued: tl.issued, next: tl.next, operator: tl.operator }
      };
    }
  }
  return { found: false };
}

/* ---------- удостоверение за време (RFC 3161) ---------- */

export async function checkTimestamp(app, tstDer, imprintOf) {
  const out = { ok: false };
  try {
    const c = parseCms(tstDer);
    if (c.eContentType !== OIDS.tstInfo || !c.eContent) throw new Error('не е удостоверение за време');
    const info = D.read(c.eContent).children;
    const mi = info[2], alg = HASH[D.oidStr(mi.children[0].children[0].body)];
    out.policy = D.oidStr(info[1].body);
    out.serial = hex(info[3].body).toUpperCase();
    const t = genTime(info[4]);
    out.time = t ? t.toISOString() : '';
    out.hashAlg = alg || D.oidStr(mi.children[0].children[0].body);
    out.imprint = alg && imprintOf ? eq(await digest(alg, imprintOf), mi.children[1].body) : false;
    const tsa = signerCert(c);
    if (!tsa) throw new Error('липсва удостоверението на доставчика');
    out.tsa = await certDetails(tsa);
    const contentOk = c.attrs[D.OID.messageDigest] && HASH[c.digestAlg] ? eq(await digest(HASH[c.digestAlg], c.eContent), c.attrs[D.OID.messageDigest].body) : false;
    out.signature = contentOk && !!c.attrsDer && await verifySig(tsa.spki, verifyAlg(tsa, c), c.signature, c.attrsDer);
    const issuer = await findIssuer(tsa, c.certs).catch(() => null);
    out.trust = await tlLookup(app, [tsa, issuer], /^TSA\/QTST$|^TSA$|TSA/, t || new Date());
    out.qualified = !!(out.trust.found && out.trust.qualified && /QTST/.test(out.trust.type));
    out.ok = !!(out.imprint && out.signature && t);
    out.date = t;
  } catch (e) { out.error = String(e.message || e).slice(0, 200); }
  return out;
}

/* ---------- подписите в PDF ---------- */

function pdfDate(win) {
  const m = /\/M\s*\(((?:[^)\\]|\\.)*)\)/.exec(win);
  if (!m) return null;
  const s = m[1].replace(/\\([0-7]{1,3})/g, (x, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\(.)/g, '$1');
  const d = /D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}'?\d{2})?/.exec(s);
  if (!d) return null;
  const tz = !d[7] || d[7] === 'Z' ? 'Z' : d[7].slice(0, 3) + ':' + d[7].replace("'", '').slice(3, 5);
  const t = new Date(`${d[1]}-${d[2]}-${d[3]}T${d[4]}:${d[5]}:${d[6]}${tz}`);
  return isNaN(t) ? null : t;
}
/* текстов низ от речника на подписа: (литерал) с escape-и или <hex>; UTF-16BE с BOM, иначе PDFDocEncoding/latin1 */
function pdfStr(win, key) {
  let raw = '';
  const lit = new RegExp('\\/' + key + '\\s*\\(((?:[^)\\\\]|\\\\.)*)\\)').exec(win);
  if (lit) raw = lit[1].replace(/\\([0-7]{1,3})/g, (x, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\([nrtbf])/g, (x, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c])).replace(/\\(.)/g, '$1');
  else { const hx = new RegExp('\\/' + key + '\\s*<([0-9A-Fa-f\\s]*)>').exec(win); if (hx) raw = (hx[1].replace(/\s+/g, '').match(/../g) || []).map(b => String.fromCharCode(parseInt(b, 16))).join(''); }
  if (raw.charCodeAt(0) === 0xfe && raw.charCodeAt(1) === 0xff) { let o = ''; for (let i = 2; i + 1 < raw.length; i += 2) o += String.fromCharCode(raw.charCodeAt(i) << 8 | raw.charCodeAt(i + 1)); raw = o; }
  return raw.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
}

/* ниво по ETSI EN 319 142-1 (PAdES baseline) */
function levelOf(s, hasDss, docTsAfter) {
  if (s.subFilter === 'ETSI.RFC3161') return 'документен печат за време (PAdES)';
  const pades = s.subFilter === 'ETSI.CAdES.detached';
  const base = pades ? 'PAdES-BASELINE-' : 'PDF подпис (' + (s.subFilter || 'PKCS#7') + '), съответно ниво ';
  if (docTsAfter && hasDss) return base + 'LTA';
  if (hasDss && (s.timestamp && s.timestamp.ok)) return base + 'LT';
  if (s.timestamp && s.timestamp.ok) return base + 'T';
  return base + 'B';
}

const fmtBg = d => (d ? d.toLocaleString('bg-BG', { timeZone: 'Europe/Sofia', dateStyle: 'short', timeStyle: 'medium' }) : '');

/* един подпис: от ByteRange до заключението */
async function checkOne(app, pdf, latin, m, now) {
  const [a, b, c, len] = m.slice(1).map(Number);
  const s = { byteRange: [a, b, c, len], warnings: [], checks: {} };
  if (b >= c || c + len > pdf.length || a !== 0) { s.error = 'невалиден ByteRange'; return s; }
  s.coversAll = c + len === pdf.length;
  s.unsignedBytes = pdf.length - (c + len);
  const win = latin.slice(Math.max(0, Math.min(m.index, b) - 3000), b) + latin.slice(c, c + 3000);
  s.subFilter = (/\/SubFilter\s*\/([A-Za-z0-9.]+)/.exec(win) || [])[1] || '';
  s.reason = pdfStr(win, 'Reason'); s.location = pdfStr(win, 'Location'); s.fieldName = pdfStr(win, 'Name');
  const hexStr = latin.slice(b + 1, c - 1).replace(/(00)+$/, '');
  const cmsBytes = new Uint8Array(hexStr.length / 2 | 0);
  for (let i = 0; i < cmsBytes.length; i++) cmsBytes[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  const signed = D.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + len)]);
  s.signedSha256 = await sha256hex(signed);
  let cms;
  try { cms = parseCms(D.read(cmsBytes).raw); } catch (_) { s.error = 'подписът (CMS) не може да бъде разчетен'; return s; }

  // документен печат за време (PAdES-LTA): отпечатъкът е на подписаните байтове
  if (s.subFilter === 'ETSI.RFC3161' || cms.eContentType === OIDS.tstInfo) {
    s.kind = 'docTimestamp';
    s.timestamp = await checkTimestamp(app, D.read(cmsBytes).raw, signed);
    s.indication = s.timestamp.ok ? 'TOTAL-PASSED' : 'INDETERMINATE';
    s.qualification = s.timestamp.qualified ? 'квалифициран електронен времеви печат (чл. 42 от Регламента)' : 'електронен времеви печат';
    delete s.timestamp.date;
    return s;
  }
  return checkSigner(app, s, cms, signed, pdfDate(win), now);
}

/* подписващият (SignerInfo): цялост, подпис, време, удостоверение, доверителен списък, прекратяване, заключение */
async function checkSigner(app, s, cms, signed, fallbackTime, now) {
  s.kind = 'signature';
  const alg = HASH[cms.digestAlg];
  s.digestAlg = alg || cms.digestAlg;
  s.sigAlg = SIG_NAMES[cms.sigAlg] || cms.sigAlg;
  const cert = signerCert(cms);
  if (!cert) { s.error = 'липсва удостоверението на подписващия'; s.indication = 'INDETERMINATE'; s.subIndication = 'NO_SIGNING_CERTIFICATE_FOUND'; return s; }
  if (cms.attrsDer) {
    s.checks.integrity = !signed ? null : !!(alg && cms.attrs[D.OID.messageDigest] && eq(await digest(alg, signed), cms.attrs[D.OID.messageDigest].body));
    s.checks.signature = await verifySig(cert.spki, verifyAlg(cert, cms), cms.signature, cms.attrsDer).catch(() => false);
  } else {
    // без подписани атрибути (стар PKCS#7): подписът е направо върху съдържанието
    s.checks.signature = signed ? await verifySig(cert.spki, verifyAlg(cert, cms), cms.signature, signed).catch(() => false) : null;
    s.checks.integrity = s.checks.signature;
  }
  s.checks.signingCertAttr = !!(cms.attrs[D.OID.signingCertV2] || cms.attrs[OIDS.signingCert]);
  s.signer = await certDetails(cert);

  // време: удостоверение за време (доказателство), иначе декларираното
  const stAttr = cms.attrs[OIDS.signingTime];
  const claimed = stAttr ? asnTime(stAttr) : fallbackTime;
  s.claimedTime = claimed ? claimed.toISOString() : '';
  s.claimedSource = stAttr ? 'атрибут signingTime' : claimed ? 'поле /M на подписа (часовник на подписващия)' : '';
  if (cms.unsigned[OIDS.tst] && cms.unsigned[OIDS.tst][0]) s.timestamp = await checkTimestamp(app, cms.unsigned[OIDS.tst][0].raw, cms.signature);
  const poe = s.timestamp && s.timestamp.ok ? s.timestamp.date : null;
  if (s.timestamp) { if (s.timestamp.error || !s.timestamp.ok) s.warnings.push('Удостоверението за време не е потвърдено' + (s.timestamp.error ? ': ' + s.timestamp.error : '') + ' – ползва се декларираното време.'); delete s.timestamp.date; }
  const T = poe || claimed || now;
  s.timeUsed = T.toISOString();
  s.timeUsedSource = poe ? 'удостоверение за време' : claimed ? 'декларирано време (без доказателство за съществуване)' : 'момент на проверката';
  s.checks.validAtTime = !!(cert.notBefore && cert.notAfter && cert.notBefore <= T && cert.notAfter >= T);
  s.checks.validNow = !!(cert.notBefore && cert.notAfter && cert.notBefore <= now && cert.notAfter >= now);

  // верига и Доверителен списък
  const issuer = await findIssuer(cert, cms.certs).catch(() => null);
  s.chain = [];
  if (issuer) {
    s.chain.push(Object.assign({ role: 'издател на удостоверението' }, await certDetails(issuer)));
    const root = await findIssuer(issuer, cms.certs).catch(() => null);
    if (root && !eq(root.spki, issuer.spki)) s.chain.push(Object.assign({ role: 'горен издател' }, await certDetails(root)));
    s.trust = await tlLookup(app, [issuer, root], /^CA\/QC$/, T);
    if (!s.trust.found) { const nq = await tlLookup(app, [issuer, root], /^CA\//, T); if (nq.found) s.trust = nq; }
  } else s.trust = { found: false, error: 'издателят на удостоверението не е намерен (няма го в подписа и на адреса AIA)' };

  // прекратяване/спиране
  const rev = await checkRevocation(cert, cms.certs).catch(e => ({ status: 'unknown', note: e.message }));
  s.revocation = { status: rev.status, method: rev.method || '', url: rev.url || '', checkedAt: rev.at || now.toISOString(), reason: rev.reason || '', revokedAt: rev.revokedAt ? new Date(rev.revokedAt).toISOString() : '', note: rev.note || '' };
  const revokedAt = rev.revokedAt ? new Date(rev.revokedAt) : null;

  // заключение (ETSI EN 319 102-1)
  let ind = 'TOTAL-PASSED', sub = '';
  const set = (i, x) => { if (ind === 'TOTAL-FAILED') return; if (i === 'TOTAL-FAILED' || ind === 'TOTAL-PASSED') { ind = i; sub = x; } };
  if (s.checks.integrity === false) set('TOTAL-FAILED', 'HASH_FAILURE');
  if (s.checks.signature === false) set('TOTAL-FAILED', 'SIG_CRYPTO_FAILURE');
  if (s.checks.integrity === null) set('INDETERMINATE', 'SIGNED_DATA_NOT_FOUND');
  if (rev.status === 'revoked' && (!revokedAt || revokedAt <= T)) set('TOTAL-FAILED', 'REVOKED');
  if (rev.status === 'revoked' && revokedAt && revokedAt > T && !poe) set('INDETERMINATE', 'REVOKED_NO_POE');
  if (!s.checks.validAtTime) set(poe ? 'TOTAL-FAILED' : 'INDETERMINATE', poe ? 'EXPIRED' : 'OUT_OF_BOUNDS_NO_POE');
  if (!s.trust.found) set('INDETERMINATE', 'NO_CERTIFICATE_CHAIN_FOUND');
  if (rev.status === 'unknown') set('INDETERMINATE', 'REVOCATION_UNKNOWN');
  s.indication = ind; s.subIndication = sub;
  if (s.coversAll === false) s.warnings.push('След този подпис във файла има добавени ' + s.unsignedBytes + ' байта (следващ подпис, печат за време или промяна) – те не са обхванати от него.');
  if (rev.status === 'revoked' && revokedAt && revokedAt > T) s.warnings.push('Удостоверението е прекратено/спряно на ' + fmtBg(revokedAt) + ' – след момента на подписа.');
  if (!s.checks.validNow && s.checks.validAtTime) s.warnings.push('Удостоверението вече е изтекло, но е било валидно към момента на подписа.');
  if (s.trust.found && s.trust.statusNow !== s.trust.statusAt) s.warnings.push('Статусът на услугата в Доверителния списък сега е „' + s.trust.statusNow + '“ (към момента на подписа – „' + s.trust.statusAt + '“).');

  // квалификация (ETSI TS 119 615 / чл. 3, т. 12 и т. 27 от Регламента)
  const qcCert = s.signer.qc.compliance && s.trust.found && s.trust.qualified && /^CA\/QC$/.test(s.trust.type);
  const seal = s.signer.qc.types.some(t => /^eseal/.test(t)) || (!s.signer.qc.types.length && /QCP-l/.test(s.signer.policies.join(' ')));
  if (ind !== 'TOTAL-PASSED') s.qualification = ind === 'TOTAL-FAILED' ? 'невалиден подпис' : 'не може да се определи (неопределен резултат)';
  else if (qcCert && s.signer.qc.sscd) s.qualification = seal ? 'квалифициран електронен печат (QESeal)' : 'квалифициран електронен подпис (QES, КЕП)';
  else if (qcCert) s.qualification = seal ? 'усъвършенстван електронен печат с квалифицирано удостоверение (AdESeal/QC)' : 'усъвършенстван електронен подпис с квалифицирано удостоверение (AdESig/QC)';
  else s.qualification = seal ? 'усъвършенстван електронен печат (AdESeal)' : 'усъвършенстван електронен подпис (AdESig)';
  s.qes = /^квалифициран/.test(s.qualification);
  s.seal = seal;
  return s;
}

const LEGAL = {
  qesig: 'Квалифицираният електронен подпис има правното действие на саморъчен подпис (чл. 25, пар. 2 от Регламент (ЕС) № 910/2014; чл. 13, ал. 4 ЗЕДЕУУ) и се признава във всички държави членки (чл. 25, пар. 3).',
  qeseal: 'Квалифицираният електронен печат се ползва с презумпция за целостта на данните и за правилността на произхода им (чл. 35, пар. 2 от Регламент (ЕС) № 910/2014).',
  ades: 'На електронния подпис (печат) не може да се отказва правно действие и допустимост като доказателство само поради електронната му форма (чл. 25, пар. 1 и чл. 35, пар. 1 от Регламент (ЕС) № 910/2014).',
  qtst: 'Квалифицираният електронен времеви печат се ползва с презумпция за точността на датата и часа и за целостта на данните (чл. 41, пар. 2 от Регламент (ЕС) № 910/2014).'
};
export const METHOD = [
  'Регламент (ЕС) № 910/2014 (eIDAS) – чл. 3, 25, 26, 32, 35, 36, 41 и 42; Регламент за изпълнение (ЕС) 2015/1506; Регламент за изпълнение (ЕС) 2015/1505 (доверителни списъци).',
  'Закон за електронния документ и електронните удостоверителни услуги (ЗЕДЕУУ) – чл. 3 (писмена форма на електронния документ) и чл. 13.',
  'ETSI EN 319 102-1 (процедури за проверка на AdES), ETSI EN 319 142-1 (PAdES), ETSI TS 119 615 (доверителни списъци), ETSI TS 119 172-4 (квалификация), RFC 5652 (CMS), RFC 3161 (удостоверения за време), RFC 6960 (OCSP), RFC 5280 (CRL).',
  'Доверителният списък на държавата на доставчика се взема от официалния адрес в списъка на Европейската комисия (EU LOTL) по HTTPS; квалификацията на услугата се определя по статуса ѝ към момента на подписа (с историята на статусите).',
  'Проверката е техническа, извършена от системата и потвърдена с квалифицирания електронен подпис на служителя, изготвил протокола. Тя не е квалифицирана услуга по валидиране по чл. 33 от Регламента; при спор може да се поиска и проверка от квалифициран доставчик.'
];

const isPdfBytes = b => b && b.length > 4 && String.fromCharCode(...b.slice(0, 4)) === '%PDF';

/* целият PDF: данни за файла, всеки подпис, обобщение */
export async function validatePdf(app, pdf, meta = {}) {
  if (!isPdfBytes(pdf) || pdf.length < 100) fail('value', 'Файлът не е PDF.');
  const now = new Date();
  const latin = new TextDecoder('latin1').decode(pdf);
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  const found = [];
  let m;
  while ((m = re.exec(latin))) found.push(m);
  const sigs = [];
  for (const x of found) sigs.push(await checkOne(app, pdf, latin, x, now));
  const hasDss = /\/DSS\s/.test(latin) || /\/Type\s*\/DSS/.test(latin);
  sigs.forEach((s, i) => { if (s.kind === 'signature') s.level = levelOf(s, hasDss, sigs.slice(i + 1).some(y => y.kind === 'docTimestamp' && y.timestamp && y.timestamp.ok)); });
  const last = sigs[sigs.length - 1];
  return finish(sigs, pdf, meta, now, {
    format: sigs.length ? 'PDF с вграден подпис (PAdES / PDF PKCS#7)' : 'PDF без електронен подпис',
    revisions: (latin.match(/%%EOF/g) || []).length, lastCoversAll: !!(last && last.coversAll), hasDss
  });
}

/* CMS от файл: DER, PEM („-----BEGIN PKCS7-----“) или base64 */
function cmsFrom(bytes) {
  const tryDer = b => { try { const n = D.read(b); if (n.tag === 0x30 && n.end <= b.length + 2 && D.oidStr(n.children[0].body) === D.OID.signedData) return n.raw; } catch (_) { /* не е CMS */ } return null; };
  if (bytes[0] === 0x30) return tryDer(bytes);
  const txt = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 20 * 1048576)));
  const pem = /-----BEGIN (?:PKCS7|CMS|SIGNED DATA)-----([\s\S]*?)-----END/.exec(txt);
  const b64 = pem ? pem[1] : /^[A-Za-z0-9+/=\s]+$/.test(txt.slice(0, 4000)) && txt.length > 100 ? txt : '';
  if (!b64) return null;
  try { return tryDer(D.unb64(b64)); } catch (_) { return null; }
}

/*
 * Всеки файл: PDF (PAdES); CAdES – .p7m/.p7s с вградено съдържание или отделен .p7s към друг файл (related: файловете
 * от същото писмо – търси се този, чийто хеш съвпада с подписания); XML с подпис (XAdES) и ASiC – отбелязват се като
 * неподдържан формат; всичко останало – без електронен подпис (протоколът пак удостоверява отпечатъците на файла).
 */
export async function validateFile(app, bytes, meta = {}, related) {
  const now = new Date();
  const name = String(meta.name || '');
  if (!bytes || !bytes.length) fail('value', 'Файлът е празен.');
  if (isPdfBytes(bytes)) return validatePdf(app, bytes, meta);
  const der = cmsFrom(bytes);
  if (der) {
    let cms;
    try { cms = parseCms(der); } catch (_) { return finish([{ kind: 'signature', error: 'подписът (CMS) не може да бъде разчетен', indication: 'INDETERMINATE', warnings: [], checks: {} }], bytes, meta, now, { format: 'CAdES (повреден)' }); }
    let content = cms.eContent, detachedOf = null;
    if (!content && typeof related === 'function') {
      // отделен подпис: файлът, чийто хеш съвпада с messageDigest на първия подписващ
      const s0 = cms.signers[0], alg = s0 && HASH[s0.digestAlg], md = s0 && s0.attrs[D.OID.messageDigest];
      for (const f of await related()) {
        if (!f.bytes || f.bytes === bytes) continue;
        if (alg && md && eq(await digest(alg, f.bytes), md.body)) { content = f.bytes; detachedOf = f; break; }
      }
      if (!content) {
        const base = name.replace(/\.(p7s|sig|p7m)$/i, '');
        const byName = (await related()).find(f => f.name === base);
        if (byName) { content = byName.bytes; detachedOf = byName; }
      }
    }
    const sigs = [];
    for (const signer of cms.signers) {
      const s = { warnings: [], checks: {}, subFilter: '' };
      await checkSigner(app, s, Object.assign({}, signer), content, null, now);
      if (!content) s.warnings.push('Отделен подпис (.p7s): подписаният файл не е намерен сред файловете в писмото – целостта не може да се провери. Регистрирайте подписания файл в същото писмо и проверете отново.');
      if (detachedOf) s.signedFile = detachedOf.name;
      s.level = 'CAdES-BASELINE-' + (s.timestamp && s.timestamp.ok ? 'T' : 'B') + (cms.eContent ? ' (с вградено съдържание)' : ' (отделен подпис)');
      sigs.push(s);
    }
    const doc = { format: cms.eContent ? 'CAdES с вградено съдържание (.p7m)' : 'CAdES – отделен подпис (.p7s)' };
    if (cms.eContent) Object.assign(doc, { contentSize: cms.eContent.length, contentSha256: (await sha256hex(cms.eContent)).toUpperCase(), contentType: isPdfBytes(cms.eContent) ? 'PDF' : '' });
    if (detachedOf) Object.assign(doc, { signedFile: detachedOf.name, signedFileSize: detachedOf.bytes.length, signedFileSha256: (await sha256hex(detachedOf.bytes)).toUpperCase() });
    return finish(sigs, bytes, meta, now, doc);
  }
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 200000)));
  if (/^\s*(<\?xml|<)/.test(head) && /<(\w+:)?Signature[\s>][\s\S]*SignedInfo/.test(head)) {
    return finish([], bytes, meta, now, { format: 'XML с електронен подпис (XMLDSig/XAdES)', unsupported: 'Подписът е във формат XAdES – системата още не го проверява. Проверете го в програмата на доставчика или при квалифициран доставчик на услуга по валидиране.' });
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && /META-INF\/(signatures|.*\.p7s|.*\.xml)/i.test(new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4 * 1048576))))) {
    return finish([], bytes, meta, now, { format: 'ASiC контейнер (подписан ZIP)', unsupported: 'Контейнерът ASiC още не се проверява от системата. Отворете го в програмата на доставчика.' });
  }
  return finish([], bytes, meta, now, { format: 'файл без електронен подпис' + (meta.contentType ? ' (' + meta.contentType + ')' : '') });
}

/* общото: обобщение, правно действие, данни за файла */
async function finish(sigs, bytes, meta, now, docExtra) {
  const real = sigs.filter(s => s.kind === 'signature');
  const overall = !real.length ? (docExtra.unsupported ? 'NOT_SUPPORTED' : 'NO_SIGNATURE') : real.some(s => s.indication === 'TOTAL-FAILED') ? 'TOTAL-FAILED' : real.every(s => s.indication === 'TOTAL-PASSED') ? 'TOTAL-PASSED' : 'INDETERMINATE';
  const legal = [];
  if (real.some(s => s.qes && !s.seal)) legal.push(LEGAL.qesig);
  if (real.some(s => s.qes && s.seal)) legal.push(LEGAL.qeseal);
  if (real.some(s => s.indication === 'TOTAL-PASSED' && !s.qes)) legal.push(LEGAL.ades);
  if (sigs.some(s => s.timestamp && s.timestamp.qualified)) legal.push(LEGAL.qtst);
  return {
    format: 'zdoi-sigcheck/1', validator: VALIDATOR, checkedAt: now.toISOString(), checkedAtLocal: stamp(now),
    document: Object.assign({
      name: line(meta.name || 'документ', 200), size: bytes.length, sha256: (await sha256hex(bytes)).toUpperCase(),
      sha512: hex(await digest('SHA-512', bytes)).toUpperCase()
    }, docExtra),
    signatures: sigs,
    summary: {
      count: real.length, timestamps: sigs.length - real.length, overall,
      qes: real.filter(s => s.qes).length, passed: real.filter(s => s.indication === 'TOTAL-PASSED').length,
      signers: real.map(s => (s.signer ? s.signer.name + (s.signer.org ? ' (' + s.signer.org + ')' : '') : '—'))
    },
    legal, method: METHOD
  };
}

/* кратко – за отметката до прикачения файл */
export const summaryOf = r => ({
  at: r.checkedAt, overall: r.summary.overall, count: r.summary.count, qes: r.summary.qes, passed: r.summary.passed,
  signers: r.summary.signers.slice(0, 5), quals: r.signatures.filter(s => s.kind === 'signature').map(s => s.qualification).slice(0, 5)
});
