import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ready } from './helpers.js';
import { registryDaily } from '../worker/src/registry.js';
import { makeApp } from '../worker/src/core.js';

const H = ['Вид администрация', 'Вид административна структура', 'Административна структура', 'ЕИК/БУЛСТАТ', 'ИИН', 'На подчинение на', 'Област', 'Община', 'Населено място', 'Район', 'Пощенски код', 'Адрес', 'Код за междуселищно избиране', 'Телефони', 'Факс', 'Електронна поща', 'Интернет страница'];
const row = (i, name, eik, extra = {}) => Object.assign(['Териториална', 'Общинска администрация', name, eik, '', null, 'Търговище', 'Омуртаг', 'Омуртаг', null, '7900', 'ул."Александър Стамболийски" № 2A', '0605', '62311', null, 'kmet@omurtag.egov.bg', 'www.omurtag.bg'], extra);

function fakeEgov(resources, rowsByUri, mon) {
  const calls = [];
  const fn = async (url, init) => {
    const m = new URL(url).pathname.split('/').pop(), body = JSON.parse(init.body);
    calls.push(m);
    const out = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
    if (m === 'listResources') return out({ success: true, resources: body.criteria.dataset_uri === '9d72ecff-e079-48a4-bc0a-1312bff178f6' ? (mon ? [{ uri: 'mon1', name: 'Списък 2026/2027', created_at: '2026-11-09 12:00:00', id: 9 }] : []) : resources });
    if (m === 'getResourceData' && body.resource_uri === 'mon1') return out({ success: true, data: mon });
    if (m === 'getResourceData') { const rows = rowsByUri[body.resource_uri]; const data = { headers: H }; rows.forEach((r, i) => { data['row' + (i + 1)] = r; }); return out({ success: true, data }); }
    return out({ success: false });
  };
  fn.calls = calls;
  return fn;
}
const many = (n, extra) => Array.from({ length: n }, (_, i) => row(i, 'Общинска администрация - Град ' + i, String(100000000 + i), extra && extra(i)));

test('регистър на административните структури: най-новият ресурс, търсене, адресати, ежедневна проверка', async () => {
  const { env, admin } = await ready();
  const rowsA = many(60), rowsB = many(61, i => (i === 0 ? { 15: 'nov@omurtag.egov.bg' } : {}));
  rowsA.push(row(99, 'Общинска администрация - Омуртаг', '000875817'));
  env.__egov = fakeEgov([{ uri: 'a', name: 'към 30.09.2026', created_at: '2026-10-01 10:00:00', id: 1 }, { uri: 'b', name: 'към 31.10.2026', created_at: '2026-11-01 10:00:00', id: 2 }], { a: rowsA, b: rowsB.concat([row(99, 'Общинска администрация - Омуртаг', '000875817')]) });
  const s = await admin.call('registry.search', { q: '000875817', facets: true });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.meta.name, 'към 31.10.2026');
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].eik, '000875817');
  assert.equal(s.items[0].address, 'п.к. 7900, Омуртаг, ул."Александър Стамболийски" № 2A');
  assert.equal(s.items[0].phone, '(0605) 62311');
  assert.ok(s.kinds.includes('Общинска администрация'));
  // в адресатите – без дублиране, второто добавяне обновява
  assert.deepEqual((await admin.call('registry.import', { eiks: ['000875817', '100000000'] })).added, 2);
  const again = await admin.call('registry.import', { eiks: ['000875817'] });
  assert.equal(again.added, 0);
  const list = (await admin.call('addressee.list')).addressees;
  const om = list.find(a => a.eik === '000875817');
  assert.equal(om.type, 'Задължен субект (орган или организация)');
  assert.equal(om.email, 'kmet@omurtag.egov.bg');
  assert.match(om.regBasis, /БУЛСТАТ/);
  // ежедневно: същият ресурс не се тегли отново
  const app = makeApp(env, env.__store, env.__kv, null);
  const n = env.__egov.calls.filter(c => c === 'getResourceData').length;
  const d = await registryDaily(app, new Date('2026-11-23T09:00:00+02:00'));
  assert.equal(d.updated, false);
  assert.equal(env.__egov.calls.filter(c => c === 'getResourceData').length, n);
  assert.equal((await registryDaily(app, new Date('2026-11-23T10:00:00+02:00'))).skipped, 'вече проверено');
});

test('училища и детски градини (МОН): списък, БУЛСТАТ и имейл от файла на ri.mon.bg, адресати', async () => {
  const { env, admin } = await ready();
  const mon = Array.from({ length: 600 }, (_, i) => ({ InstId: 100000 + i, InstName: (i % 2 ? 'Детска градина "Слънце ' : 'Средно училище "Христо Ботев ') + i + '"', First_LastName_dir: 'Иван Петров', InstRegName: 'Благоевград', InstMunName: 'Банско', InstTownName: 'Банско', InstAddress: 'ул. "Неофит Рилски" ' + i, InstPostCode: 2770, Website: 'www.su' + i + '.bg' }));
  env.__egov = fakeEgov([], {}, mon);
  const s = await admin.call('registry.search', { source: 'mon', q: '100000', facets: true });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].kind, 'Средно училище');
  assert.equal(s.items[0].director, 'Иван Петров');
  assert.equal(s.items[0].address, 'п.к. 2770, Банско, ул. "Неофит Рилски" 0');
  assert.equal(s.items[0].eik, '');
  assert.ok(s.kinds.includes('Детска градина'));
  // файлът от ri.mon.bg: „ЕИК“ → БУЛСТАТ; непознат код и невалиден БУЛСТАТ се отчитат
  const r = await admin.call('registry.monImport', { fileName: 'institutions.xlsx', rows: [
    { code: '100000', bulstat: '000024654', email: 'info@su0.bg', phone: '0749 88 123' }, { code: '100001', bulstat: '12', email: 'dg1@abv.bg' }, { code: '999999', bulstat: '000000001' }] });
  assert.deepEqual([r.matched, r.unknown, r.bad], [2, 1, 1]);
  const s2 = await admin.call('registry.search', { source: 'mon', q: '000024654' });
  assert.equal(s2.items[0].email, 'info@su0.bg');
  assert.equal(s2.withEik, 1);
  // в адресатите – като задължен субект с код по БУЛСТАТ
  assert.equal((await admin.call('registry.import', { source: 'mon', keys: ['mon:100000', 'mon:100001'] })).added, 2);
  const list = (await admin.call('addressee.list')).addressees;
  const su = list.find(a => a.eik === '000024654');
  assert.match(su.regBasis, /БУЛСТАТ/);
  assert.equal(su.email, 'info@su0.bg');
  assert.equal(su.seat, 'Банско');
  assert.equal((await admin.call('registry.import', { source: 'mon', keys: ['mon:100001'] })).added, 0);
});
