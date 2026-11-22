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
  // второ пускане същия ден: регистърът на администрациите не се проверява отново, а празният (училищата) – да
  const d2 = await registryDaily(app, new Date('2026-11-23T10:00:00+02:00'));
  assert.equal(d2.iisda, undefined);
  assert.ok(d2.mon && d2.mon.error);
  assert.equal(env.__egov.calls.filter(c => c === 'getResourceData').length, n);
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

test('външни системи: повторен опит при 403 и ясна грешка вместо „Вътрешна грешка“', async () => {
  const { fetchRetry } = await import('../worker/src/util.js');
  let n = 0;
  const flaky = async () => (++n < 3 ? new Response('no', { status: 403 }) : new Response('{}', { status: 200 }));
  const r = await fetchRetry(flaky, 'https://x', {}, 'Тест', [1, 1]);
  assert.equal(r.status, 200);
  assert.equal(n, 3);
  await assert.rejects(fetchRetry(async () => new Response('no', { status: 403 }), 'https://x', {}, 'Порталът', [1]), e => e.code === 'external' && /не отговаря в момента \(код 403\)/.test(e.message));
  // през системата: отказ от портала → грешка „external“ с обяснение
  const { env, admin } = await ready();
  env.__egov = async () => new Response('Forbidden', { status: 403 });
  const s = await admin.call('registry.search', { source: 'mon', q: 'x' });
  assert.equal(s.error, 'external');
  assert.match(s.message, /data\.egov\.bg/);
});

test('регистър на институциите на МОН (ri-api): списък, подробности на порции, БУЛСТАТ и имейл в училищата и адресатите', async () => {
  const { env, admin } = await ready();
  const mon = Array.from({ length: 600 }, (_, i) => ({ InstId: 100000 + i, InstName: 'Средно училище "Отворени данни ' + i + '"', First_LastName_dir: 'Стар директор', InstRegName: 'Благоевград', InstMunName: 'Банско', InstTownName: 'Банско', InstAddress: 'ул. 1', InstPostCode: 2770, Website: '' }));
  env.__egov = fakeEgov([], {}, mon);
  const list = Array.from({ length: 700 }, (_, i) => ({ instid: 100000 + i, name: 'Средно училище "Регистър ' + i + '"', region: 1, municipality: 1, town: 5, detailedSchoolType: 124, transformType: 5, procID: 10 + i }));
  const calls = [];
  env.__ri = async (url, init) => {
    const path = new URL(url).pathname, body = JSON.parse(init.body || '{}');
    calls.push(path);
    const out = data => new Response(JSON.stringify({ status: 1, data }), { headers: { 'Content-Type': 'application/json' } });
    if (path === '/data/get/public-register') return body.isRIActive === 1 ? out({ publicInstitutions: list }) : new Response('{"status":0}');
    if (path === '/data/get/region') return out([{ code: 1, label: 'Благоевград' }]);
    if (path === '/data/get/municipality') return out([{ code: 1, label: 'Банско' }]);
    if (path === '/data/get/town') return out([{ code: 5, label: 'гр. Банско' }]);
    if (path === '/data/get/detailedSchoolTypes') return out([{ code: 124, label: 'средно (I - XII клас)', isValid: true }]);
    if (path === '/data/get/public-transformTypes') return out([{ code: 5, label: 'действаща', isValid: true }]);
    if (path === '/data/get/institution') return out([{ codeNEISPUO: body.instid, bulstat: String(100000000 + body.instid).slice(-9), email: 'info-' + body.instid + '@edu.mon.bg', phoneNumber: '0749/8' + body.instid, website: 'su.bg', staffDirector: 'Нов директор', settlementAddress: 'ул. "Пирин" 1', settlementPostCode: 2770 }]);
    return new Response('{"status":0}');
  };
  const { riTick } = await import('../worker/src/registry.js');
  const app = makeApp(env, env.__store, env.__kv, null);
  const t1 = await riTick(app, new Date('2026-11-23T09:00:00+02:00'), 10);
  assert.equal(t1.list, 700);
  assert.equal(t1.ok, 10);
  assert.equal(t1.left, 690);
  // второ пускане същия ден: без нов списък, следващите 10
  const t2 = await riTick(app, new Date('2026-11-23T09:05:00+02:00'), 10);
  assert.equal(t2.list, undefined);
  assert.equal(t2.left, 680);
  // търсенето: БУЛСТАТ, имейл, директор, адрес от регистъра; институциите само в регистъра също излизат
  const s = await admin.call('registry.search', { source: 'mon', q: '100000' });
  const x = s.items.find(i => i.code === '100000');
  assert.equal(x.eik, '100100000');
  assert.equal(x.email, 'info-100000@edu.mon.bg');
  assert.equal(x.director, 'Нов директор');
  assert.equal(x.address, 'п.к. 2770, гр. Банско, ул. "Пирин" 1');
  assert.equal(x.status, 'действаща');
  assert.ok((await admin.call('registry.search', { source: 'mon', q: 'Регистър 650' })).items.length === 1);
  assert.ok(s.ri.withDetails >= 20);
  // добавяне в адресатите: подробностите на избраното се теглят веднага
  assert.equal((await admin.call('registry.import', { source: 'mon', keys: ['mon:100650'] })).added, 1);
  const a = (await admin.call('addressee.list')).addressees.find(z => z.name === 'Средно училище "Регистър 650"');
  assert.equal(a.eik, '100100650');
  assert.match(a.regBasis, /БУЛСТАТ/);
  assert.equal(a.email, 'info-100650@edu.mon.bg');
});
