/* Проверка на подписите в получени PDF (eIDAS, ЗЕДЕУУ): изкуствен доставчик, доверителен списък, OCSP, протокол. */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sign as nodeSign, createHash } from 'node:crypto';
import * as D from '../site/js/der.js';
import { ready } from './helpers.js';
import { makeCert, ocspResponse, fakeProvider } from './pki.js';
import { validatePdf } from '../worker/src/validate.js';
import { makeApp } from '../worker/src/core.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const OCSP = 'http://ocsp.test-tsp.bg/', CAURL = 'http://ca.test-tsp.bg/ca.cer';
const ca = makeCert({ cn: 'Test Qualified CA', ca: true });
const leaf = makeCert({ cn: 'Мария Иванова Петрова', id: 'PNOBG-8001010000', issuer: ca, qualified: true, ocsp: OCSP, caIssuers: CAURL });
const plain = makeCert({ cn: 'Самоподписан' });

const utf16 = t => '\xfe\xff' + [...t].map(ch => String.fromCharCode(ch.charCodeAt(0) >> 8, ch.charCodeAt(0) & 255)).join('');
const pdfNow = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';

/* PDF с един подпис (PAdES): ByteRange и CMS SignedData с подписаните атрибути */
function signedPdf(signer, chain, mutate) {
  const head = '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n2 0 obj << /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /M (D:' + pdfNow() + ') /Reason (' + utf16('Решение по ЗДОИ') + ') /ByteRange [0 AAAAAAAAAA BBBBBBBBBB CCCCCCCCCC] /Contents <';
  const tail = '> >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';
  const HEX = 16000;
  const a = head.length, b = a + HEX + 1;
  const fix = s => s.replace('AAAAAAAAAA', String(a - 1).padStart(10, ' ')).replace('BBBBBBBBBB', String(b).padStart(10, ' ')).replace('CCCCCCCCCC', String(tail.length - 1).padStart(10, ' '));
  const h0 = fix(head), t0 = tail.slice(1);
  const enc = s => Buffer.from(s, 'latin1');
  const prefix = enc(h0.slice(0, -1)), suffix = enc(t0);
  const signed = Buffer.concat([prefix, suffix]);
  const digest = createHash('sha256').update(signed).digest();
  const attrs = D.signedAttrs(new Uint8Array(digest), signer.cert, new Uint8Array(createHash('sha256').update(signer.der).digest()));
  const sig = new Uint8Array(nodeSign('sha256', D.attrsToSign(attrs), signer.key));
  const cms = D.signedData(attrs, sig, chain.map(c => c.der), signer.cert);
  const hex = Buffer.from(cms).toString('hex').padEnd(HEX, '0');
  const pdf = Buffer.concat([prefix, enc('<' + hex + '>'), suffix]);
  if (mutate) mutate(pdf);
  return new Uint8Array(pdf);
}

const lotl = `<?xml version="1.0"?><TrustServiceStatusList><SchemeInformation><PointersToOtherTSL>
<OtherTSLPointer><TSLLocation>https://tl.test/TSL_BG.xml</TSLLocation><AdditionalInformation><OtherInformation><SchemeTerritory>BG</SchemeTerritory></OtherInformation><OtherInformation><MimeType>application/vnd.etsi.tsl+xml</MimeType></OtherInformation></AdditionalInformation></OtherTSLPointer>
</PointersToOtherTSL></SchemeInformation></TrustServiceStatusList>`;
const tl = `<?xml version="1.0"?><TrustServiceStatusList><SchemeInformation><TSLSequenceNumber>77</TSLSequenceNumber><SchemeOperatorName><Name xml:lang="bg">КРС</Name></SchemeOperatorName>
<ListIssueDateTime>2026-11-01T00:00:00Z</ListIssueDateTime><NextUpdate><dateTime>2027-05-01T00:00:00Z</dateTime></NextUpdate></SchemeInformation>
<TrustServiceProviderList><TrustServiceProvider><TSPInformation><TSPName><Name xml:lang="bg">Тест ДКУУ АД</Name></TSPName></TSPInformation><TSPServices><TSPService><ServiceInformation>
<ServiceTypeIdentifier>http://uri.etsi.org/TrstSvc/Svctype/CA/QC</ServiceTypeIdentifier><ServiceName><Name xml:lang="bg">Тест квалифицирани удостоверения</Name></ServiceName>
<ServiceDigitalIdentity><DigitalId><X509Certificate>${Buffer.from(ca.der).toString('base64')}</X509Certificate></DigitalId></ServiceDigitalIdentity>
<ServiceStatus>http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/granted</ServiceStatus><StatusStartingTime>2019-01-01T00:00:00Z</StatusStartingTime></ServiceInformation>
<ServiceHistory><ServiceHistoryInstance><ServiceStatus>http://uri.etsi.org/TrstSvc/TrustedList/Svcstatus/withdrawn</ServiceStatus><StatusStartingTime>2010-01-01T00:00:00Z</StatusStartingTime></ServiceHistoryInstance></ServiceHistory>
</TSPService></TSPServices></TrustServiceProvider></TrustServiceProviderList></TrustServiceStatusList>`;
const tlFetch = async url => new Response(String(url).includes('lotl') ? lotl : String(url).includes('TSL_BG') ? tl : 'x', { status: String(url).includes('lotl') || String(url).includes('TSL_BG') ? 200 : 404 });

test('проверка на подпис: КЕП с квалифициран доставчик в доверителния списък – TOTAL-PASSED и QES; подправен файл – TOTAL-FAILED', async () => {
  const calls = fakeProvider({ [OCSP]: () => ({ body: ocspResponse(ca, leaf, 'good') }), [CAURL]: () => ({ body: ca.der }) }, realFetch);
  const { env } = await ready();
  env.__tl = tlFetch;
  const app = makeApp(env, env.__store, env.__kv, new Request('https://adm.test/api'));
  const rep = await validatePdf(app, signedPdf(leaf, [leaf]), { name: 'Решение 12.pdf' });
  assert.equal(rep.summary.count, 1);
  const s = rep.signatures[0];
  assert.equal(s.indication, 'TOTAL-PASSED', JSON.stringify(s, null, 1).slice(0, 3000));
  assert.deepEqual([s.checks.integrity, s.checks.signature, s.checks.validAtTime, s.coversAll], [true, true, true, true]);
  assert.equal(s.trust.found, true);
  assert.equal(s.trust.tsp, 'Тест ДКУУ АД');
  assert.equal(s.trust.statusAt, 'granted');
  assert.equal(s.trust.tl.seq, '77');
  assert.equal(s.revocation.status, 'good');
  assert.equal(s.revocation.method, 'OCSP');
  assert.match(s.qualification, /^квалифициран електронен подпис/);
  assert.equal(s.qes, true);
  assert.equal(s.level, 'PAdES-BASELINE-B');
  assert.equal(s.reason, 'Решение по ЗДОИ');
  assert.match(s.signer.subject, /SERIALNUMBER=PNOBG-8001010000/);
  assert.equal(s.signer.id, 'PNOBG-8001010000');
  assert.equal(s.chain[0].name, 'Test Qualified CA');
  assert.equal(rep.summary.overall, 'TOTAL-PASSED');
  assert.ok(rep.legal.some(x => /саморъчен подпис/.test(x)));
  assert.match(rep.document.sha256, /^[0-9A-F]{64}$/);
  assert.ok(calls.includes(OCSP));

  const bad = await validatePdf(app, signedPdf(leaf, [leaf], pdf => { pdf[40] ^= 1; }), { name: 'x.pdf' });
  assert.equal(bad.signatures[0].indication, 'TOTAL-FAILED');
  assert.equal(bad.signatures[0].subIndication, 'HASH_FAILURE');
  assert.equal(bad.summary.overall, 'TOTAL-FAILED');
});

test('проверка на подпис: издател извън доверителните списъци – INDETERMINATE; прекратено удостоверение – TOTAL-FAILED', async () => {
  fakeProvider({ [OCSP]: () => ({ body: ocspResponse(ca, leaf, 'revoked') }), [CAURL]: () => ({ body: ca.der }) }, realFetch);
  const { env } = await ready();
  env.__tl = tlFetch;
  const app = makeApp(env, env.__store, env.__kv, new Request('https://adm.test/api'));
  const rev = await validatePdf(app, signedPdf(leaf, [leaf]), {});
  assert.equal(rev.signatures[0].indication, 'TOTAL-FAILED');
  assert.equal(rev.signatures[0].subIndication, 'REVOKED');
  const self = await validatePdf(app, signedPdf(plain, [plain]), {});
  assert.equal(self.signatures[0].indication, 'INDETERMINATE');
  assert.match(self.signatures[0].qualification, /не може да се определи/);
});

test('кореспонденция: автоматична проверка на получен PDF, отметка към файла, протокол с Изх. № (не се редактира)', async () => {
  fakeProvider({ [OCSP]: () => ({ body: ocspResponse(ca, leaf, 'good') }), [CAURL]: () => ({ body: ca.der }) }, realFetch);
  const { env, admin } = await ready();
  env.__tl = tlFetch;
  const { regNo } = await admin.call('req.create', { mode: 'Сдружението', title: 'Тест', entity: { name: 'Община Тест', email: 'a@example.org' }, points: ['Точка 1'] });
  const pdf = signedPdf(leaf, [leaf]);
  const f = await env.__store.uploadFile(regNo + '/Входящи/решение.pdf', pdf, 'application/pdf');
  const m = await env.__store.insert('mail', { regNo, direction: 'Входяща', at: '2026-11-20T10:30:00', from: 'obshtina@example.org', subject: 'Решение по заявление', body: 'Приложено',
    attachments: JSON.stringify([{ name: 'решение.pdf', size: pdf.length, contentType: 'application/pdf', fileId: f.id }, { name: 'бележка.txt', contentType: 'text/plain', fileId: 'nope' }]) });
  const c = await admin.call('sig.check', { id: m._id, index: 0 });
  assert.equal(c.ok, true, JSON.stringify(c).slice(0, 500));
  assert.equal(c.summary.overall, 'TOTAL-PASSED');
  assert.equal(c.summary.qes, 1);
  // резултатът е записан към файла
  const g = await admin.call('req.get', { regNo });
  const att = g.mail.find(x => x._id === m._id).attachments[0];
  assert.equal(att.sig.overall, 'TOTAL-PASSED');
  assert.equal((await admin.call('sig.check', { id: m._id, index: 9 })).error, 'notfound');
  // протокол – документ по преписката, данните са от сървъра
  const p = await admin.call('sig.protocol', { id: m._id, index: 0 });
  assert.equal(p.ok, true, JSON.stringify(p).slice(0, 500));
  assert.match(p.outNo, /^ЗДОИ-\d{4}-\d{4}/);
  assert.equal(p.payload.source.file, 'решение.pdf');
  assert.equal(p.payload.operator.username, 'admin');
  assert.match(p.payload.reportHash, /^[0-9A-F]{64}$/);
  const g2 = await admin.call('req.get', { regNo });
  const doc = g2.docs.find(x => x.outNo === p.outNo);
  assert.equal(doc.kind, 'Протокол за проверка на подпис');
  assert.equal(doc.payload.report.summary.overall, 'TOTAL-PASSED');
  assert.ok(g2.events.some(e => e.kind === 'Проверка на подпис'));
  assert.equal((await admin.call('doc.reserve', { regNo, kind: 'Писмо', outNo: p.outNo, payload: { report: {} } })).error, 'value');
  const log = (await admin.call('log.list')).log;
  assert.ok(log.some(l => l.action === 'Проверка на подписите'));
});

/* CAdES: подписаните атрибути върху съдържанието; enveloping – съдържанието е вътре (.p7m), иначе – отделен (.p7s) */
function cades(content, signer, enveloping) {
  const attrs = D.signedAttrs(new Uint8Array(createHash('sha256').update(content).digest()), signer.cert, new Uint8Array(createHash('sha256').update(signer.der).digest()));
  const sig = new Uint8Array(nodeSign('sha256', D.attrsToSign(attrs), signer.key));
  const si = D.seq(D.int(1), D.seq(signer.cert.issuerRaw, signer.cert.serialRaw), D.algo(D.OID.sha256), D.tlv(0xa0, D.read(D.setOf(...attrs)).body), D.algo(D.OID.rsa), D.octets(sig));
  const enc = enveloping ? D.seq(D.oid(D.OID.data), D.ctx(0, D.octets(content))) : D.seq(D.oid(D.OID.data));
  return D.seq(D.oid(D.OID.signedData), D.ctx(0, D.seq(D.int(1), D.set(D.algo(D.OID.sha256)), enc, D.ctx(0, signer.der), D.set(si))));
}

test('всеки файл: CAdES .p7m (вградено съдържание), отделен .p7s към файла от писмото, файл без подпис, XAdES – неподдържан', async () => {
  fakeProvider({ [OCSP]: () => ({ body: ocspResponse(ca, leaf, 'good') }), [CAURL]: () => ({ body: ca.der }) }, realFetch);
  const { env, admin } = await ready();
  env.__tl = tlFetch;
  const { regNo } = await admin.call('req.create', { mode: 'Сдружението', title: 'Тест', entity: { name: 'Община Тест', email: 'a@example.org' }, points: ['Точка 1'] });
  const doc = new TextEncoder().encode('Решение № 5 от 20.11.2026 г. – предоставя се достъп.');
  const up = async (name, bytes, type) => Object.assign({ name, size: bytes.length, contentType: type }, { fileId: (await env.__store.uploadFile(regNo + '/' + name, bytes, type)).id });
  const atts = [
    await up('решение.docx', doc, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    await up('решение.docx.p7s', cades(doc, leaf, false), 'application/pkcs7-signature'),
    await up('писмо.p7m', cades(doc, leaf, true), 'application/pkcs7-mime'),
    await up('отговор.xml', new TextEncoder().encode('<?xml version="1.0"?><doc><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo/></ds:Signature></doc>'), 'text/xml'),
    await up('самотен.p7s', cades(new TextEncoder().encode('друго'), leaf, false), 'application/pkcs7-signature')
  ];
  const m = await env.__store.insert('mail', { regNo, direction: 'Входяща', at: '2026-11-20T10:30:00', from: 'obshtina@example.org', subject: 'Решение', body: '', attachments: JSON.stringify(atts) });
  const chk = async i => { const r = await admin.call('sig.check', { id: m._id, index: i }); assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400)); return r; };
  const none = await chk(0);
  assert.equal(none.summary.overall, 'NO_SIGNATURE');
  assert.match(none.report.document.format, /без електронен подпис/);
  const det = await chk(1);
  assert.equal(det.summary.overall, 'TOTAL-PASSED', JSON.stringify(det.report.signatures[0]).slice(0, 1500));
  assert.equal(det.report.document.signedFile, 'решение.docx');
  assert.match(det.report.signatures[0].level, /^CAdES-BASELINE-B \(отделен/);
  assert.equal(det.summary.qes, 1);
  const env1 = await chk(2);
  assert.equal(env1.summary.overall, 'TOTAL-PASSED');
  assert.match(env1.report.document.format, /\.p7m/);
  assert.equal(env1.report.document.contentSize, doc.length);
  const x = await chk(3);
  assert.equal(x.summary.overall, 'NOT_SUPPORTED');
  const lone = await chk(4);
  assert.equal(lone.report.signatures[0].indication, 'INDETERMINATE');
  assert.equal(lone.report.signatures[0].subIndication, 'SIGNED_DATA_NOT_FOUND');
  // протокол и за файл без подпис – удостоверява отпечатъците
  const p = await admin.call('sig.protocol', { id: m._id, index: 0 });
  assert.equal(p.ok, true, JSON.stringify(p).slice(0, 300));
  assert.equal(p.payload.report.summary.overall, 'NO_SIGNATURE');
  assert.match(p.payload.report.document.sha256, /^[0-9A-F]{64}$/);
});
