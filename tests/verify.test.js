import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ready } from './helpers.js';

const deed = {
  deedStatus: 2, companyName: 'НАПОИТЕЛНИ СИСТЕМИ', fullName: '"НАПОИТЕЛНИ СИСТЕМИ" ЕАД', uic: '831160078', legalForm: 11,
  sections: [{ nameCode: 'CR_GL_GENERAL_STATUS_L', subDeeds: [{ groups: [{ fields: [
    { nameCode: 'CR_F_2_L', htmlData: "<p class='field-text'>НАПОИТЕЛНИ СИСТЕМИ</p>" },
    { nameCode: 'CR_F_3_L', htmlData: "<p class='field-text'>Еднолично акционерно дружество</p>" },
    { nameCode: 'CR_F_5_L', htmlData: "<p class='field-text'>Държава: БЪЛГАРИЯ<br/>Област: София (столица), Община: Столична<br />Населено място: гр. София, п.к. 1186<br/>бул./ул. ЦАР БОРИС ІІІ № 136 Адрес на електронна поща: <a href=\"mailto:office@nps.bg\">office@nps.bg</a></p>" },
    { nameCode: 'CR_F_10_L', htmlData: "<p class='field-text'>СНЕЖИНА ДИНЕВА, Държава: БЪЛГАРИЯ</p>" },
    { nameCode: 'CR_F_11_L', htmlData: "<div class='erasure-text-inline'><i class='ui-icon ui-icon-erased'></i>Заличено обстоятелство.</div>" },
    { nameCode: 'CR_F_26_L', htmlData: "<p class='field-text'>Ликвидация: открита на 01.10.2026</p>" }
  ] }] }] }]
};
const labels = { CR_F_2_L: '2. Фирма/Наименование', CR_F_5_L: '5. Седалище и адрес на управление', CR_F_26_L: '26. Прекратяване и ликвидация' };
const bulstatHtml = `<table><tr><td>Код по БУЛСТАТ</td><td>000403439</td><td>История</td><td>Документи</td></tr>
<tr><td>Нефизическо лице</td><td>ПГЛВ "АЛЕКСАНДЪР СТАМБОЛИЙСКИ", държава: БЪЛГАРИЯ, правна форма: Училище</td><td>История</td><td>Документи</td></tr>
<tr><td>Дело</td><td>История</td><td>Документи</td></tr><tr><td>седалище и адрес на управление: БЪЛГАРИЯ, пощенски код 5800, гр.Плевен, жк.СТОРГОЗИЯ №97</td></tr>
<tr><td>Състояние</td><td>развиващ дейност</td><td>История</td><td>Документи</td></tr>
<tr><td>Управление</td><td>История</td><td>Документи</td></tr><tr><td>ТАНЯ ЦВЕТАНОВА - Директор</td></tr>
<tr><td>Действителни собственици</td></tr></table>`;

test('проверка по ЕИК: Търговски регистър (активен, ликвидация, заличени обстоятелства) и БУЛСТАТ; кеш; непознат код', async () => {
  const { env, admin } = await ready();
  const seen = [];
  env.__cr = async (url, init) => {
    seen.push(init.headers['Accept-Language']);
    if (url.includes('/labels/')) return new Response(JSON.stringify(labels));
    return new Response(url.endsWith('/831160078') ? JSON.stringify(deed) : '');
  };
  env.__bulstat = async url => new Response(url.includes('uic=000403439') ? bulstatHtml : '<html>org.eclipse.birt.report.service.api.ReportServiceException</html>');
  const r = await admin.call('verify.eik', { eik: '831160078' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.cr.found, true);
  assert.equal(r.cr.fullName, '"НАПОИТЕЛНИ СИСТЕМИ" ЕАД');
  assert.equal(r.cr.email, 'office@nps.bg');
  assert.match(r.cr.seat, /^Област: София \(столица\), Община: Столична, Населено място: гр\. София, п\.к\. 1186, бул\.\/ул\. ЦАР БОРИС ІІІ № 136$/);
  assert.ok(!r.cr.fields.some(f => f.code === 'CR_F_11_L'));
  assert.match(r.cr.status, /Прекратяване и ликвидация/);
  assert.ok(r.warnings.some(w => /ликвидация/i.test(w)));
  assert.equal(r.bulstat.found, false);
  assert.ok(seen.every(x => x === 'bg'));
  // училище: само в БУЛСТАТ
  const s = await admin.call('verify.eik', { eik: '000403439' });
  assert.equal(s.cr.found, false);
  assert.equal(s.bulstat.state, 'развиващ дейност');
  assert.equal(s.bulstat.address, 'пощенски код 5800, гр.Плевен, жк.СТОРГОЗИЯ №97');
  assert.equal(s.bulstat.management, 'ТАНЯ ЦВЕТАНОВА - Директор');
  assert.equal(s.bulstat.legalForm, 'Училище');
  // кеш 12 часа
  assert.equal((await admin.call('verify.eik', { eik: '000403439' })).cached, true);
  // непознат код и невалиден вход
  const n = await admin.call('verify.eik', { eik: '123456789' });
  assert.ok(n.warnings.some(w => /нито в Търговския регистър/.test(w)));
  assert.equal((await admin.call('verify.eik', { eik: '12' })).error, 'value');
});

test('участие в организации: физическо лице по име и ЕГН (ТР/ЮЛНЦ и БУЛСТАТ), организация по ЕИК; ЕГН не се записва', async () => {
  const { env, admin } = await ready();
  const calls = [];
  env.__cr = async url => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.includes('/labels/')) return new Response(JSON.stringify({ CR_F_10_L: '10. Представители', CR_F_23_L: '23. Едноличен собственик на капитала', CR_APP_IN_LIQUIDATION_L: 'в ликвидация' }));
    if (u.pathname.endsWith('/Subjects')) return new Response(u.searchParams.get('name') || u.searchParams.get('ident') ? JSON.stringify([{ isPhysical: true, ident: 'TOKEN1', name: 'ИВАН ПЕТРОВ ИВАНОВ' }]) : '');
    if (u.pathname.endsWith('/SubjectInFields')) {
      if (u.searchParams.get('type') === '1') return new Response(JSON.stringify([{ companyFullName: '"АЛФА" ЕООД', uic: '111111111', fieldName: 'CR_F_10_L' }, { companyFullName: '"АЛФА" ЕООД', uic: '111111111', fieldName: 'CR_F_23_L' }, { companyFullName: 'Сдружение "Бета"', uic: '222222222', fieldName: 'CR_F_10_L', companyNameSuffixFlag: 'CR_APP_IN_LIQUIDATION_L' }]));
      return new Response(JSON.stringify([{ companyFullName: 'ДКК ЕАД', uic: '121031861', fieldName: 'CR_F_2_L' }, { companyFullName: '"ГАМА" ЕАД', uic: '333333333', fieldName: 'CR_F_23_L' }]));
    }
    return new Response('');
  };
  env.__bulstat = async () => new Response('<html>ReportServiceException</html>');
  const p = await admin.call('verify.person', { name: 'Иван Петров Иванов', egn: '7501010004' });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.people.length, 1);
  const alfa = p.people[0].orgs.find(o => o.uic === '111111111');
  assert.deepEqual(alfa.roles, ['Представители', 'Едноличен собственик на капитала']);
  assert.equal(p.people[0].orgs.find(o => o.uic === '222222222').flag, 'в ликвидация');
  assert.equal(p.bulstat.found, false);
  assert.ok(calls.some(c => c.includes('ident=7501010004')));
  // ЕГН не остава в KV и в дневника
  const kv = JSON.stringify([...env.__kv.m.entries()]);
  assert.ok(kv.length > 10);
  assert.ok(!kv.includes('7501010004'));
  const log = (await admin.call('log.list')).log;
  assert.ok(log.some(l => /участие на физическо лице/.test(l.action) && /75\*{8}/.test(l.details)));
  assert.ok(!JSON.stringify(log).includes('7501010004'));
  // невалидни входни данни
  assert.equal((await admin.call('verify.person', { egn: '7501010005' })).error, 'value');
  assert.equal((await admin.call('verify.person', { name: 'Иван' })).error, 'value');
  assert.equal((await admin.call('verify.person', {})).error, 'required');
  // организация: участие в други (без самата нея)
  const o = await admin.call('verify.eik', { eik: '121031861', fresh: true });
  assert.deepEqual(o.participation.map(x => x.uic), ['333333333']);
  assert.deepEqual(o.participation[0].roles, ['Едноличен собственик на капитала']);
});

test('търсене на организация по наименование: ТР/ЮЛНЦ (Summary, общ брой от заглавката) и БУЛСТАТ (rpt2); кеш; невалиден вход', async () => {
  const { env, admin } = await ready();
  const urls = [];
  env.__cr = async url => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/Summary')) return new Response(JSON.stringify([{ isPhysical: false, ident: '176652928', name: 'Ветеринари в действие', companyFullName: '"Ветеринари в действие" Сдружение' }, { isPhysical: true, ident: '', name: 'ЛИЦЕ' }]), { headers: { count: '29' } });
    return new Response('');
  };
  env.__bulstat = async url => {
    urls.push(url);
    return new Response(`<table><tr><th>Субект</th></tr>
<tr valign="top" id="__TOC_0"><td><div><a href="https://reports.bulstat.bg/bulstat-ireports/preview?__report=x&amp;subjectId=230048583" target="_blank">ФОНД &quot;ЕДИНЕНИЕ&quot;</a></div></td><td><div><div style="visibility:hidden">&#xa0;</div></div></td><td><div></div></td></tr>
<tr valign="top" id="__TOC_1"><td><div><a href="https://x/?subjectId=201493" target="_blank">СДРУЖЕНИЕ "ИЗКУСТВО В ДЕЙСТВИЕ"</a></div></td><td><div>000682647</div></td><td><div>123</div></td></tr>
<tr><td colspan="3"><table><tr><td><div>Общо:</div></td><td><div class="style_23">85</div></td></tr></table></td></tr></table>`);
  };
  const r = await admin.call('verify.name', { name: '  в  действие ' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.name, 'в действие');
  assert.equal(r.cr.total, 29);
  assert.deepEqual(r.cr.items.map(x => x.eik), ['176652928']);
  assert.match(r.cr.items[0].link, /uic=176652928$/);
  assert.equal(r.bulstat.total, 85);
  assert.deepEqual(r.bulstat.items.map(x => [x.eik, x.name]), [['', 'ФОНД "ЕДИНЕНИЕ"'], ['000682647', 'СДРУЖЕНИЕ "ИЗКУСТВО В ДЕЙСТВИЕ"']]);
  assert.equal(r.bulstat.items[0].link, 'https://reports.bulstat.bg/bulstat-ireports/preview?__report=x&subjectId=230048583');
  assert.equal(r.bulstat.items[1].old, '123');
  assert.ok(urls.some(u => /Summary\?.*pageSize=25.*selectedSearchFilter=1/.test(u)));
  assert.ok(urls.some(u => /rpt2\.rptdesign.*fullName=%D0%B2%20%D0%B4/.test(u)));
  const n = urls.length;
  assert.equal((await admin.call('verify.name', { name: 'В ДЕЙСТВИЕ' })).cached, true);
  assert.equal(urls.length, n);
  assert.equal((await admin.call('verify.name', { name: 'а-' })).error, 'value');
  assert.equal((await admin.call('verify.name', {})).error, 'required');
});

test('БУЛСТАТ – свързаност на физическо лице (rpt3 → v_rpt3): съвпадения, участия в управлението, настоящи и минали', async () => {
  const { env, admin } = await ready();
  const urls = [];
  env.__cr = async url => new Response(new URL(url).pathname.includes('/labels/') ? '{}' : '');
  env.__bulstat = async url => {
    urls.push(url);
    if (url.includes('rpt3.rptdesign') && !url.includes('v_rpt3')) return new Response(`<table><tr><th>Субект</th><th>Дата на раждане</th><th>Гражданство</th></tr>
<tr valign="top"><td><div><a href="https://reports.bulstat.bg/bulstat-ireports/preview?__report=x%2Fv_rpt3.rptdesign&amp;__format=html&amp;subjectId=111&amp;__locale=bg">ИВАН ПЕТРОВ ИВАНОВ</a></div></td><td></td><td><div>БЪЛГАРИЯ</div></td></tr>
<tr valign="top"><td><div><a href="https://reports.bulstat.bg/bulstat-ireports/preview?__report=x%2Fv_rpt3.rptdesign&amp;subjectId=222">ИВАН ПЕТРОВ ИВАНОВ</a></div></td><td></td><td><div>БЪЛГАРИЯ</div></td></tr>
<tr><td colspan="3"><table><tr><td><div>Общо:</div></td><td><div class="s">140</div></td></tr></table></td></tr></table>`);
    if (url.includes('subjectId=111')) return new Response(`<table><tr><th colspan="2"><div>Основни данни</div></th></tr>
<tr><td><div>Имена на кирилица</div></td><td><div>ИВАН ПЕТРОВ ИВАНОВ</div></td></tr><tr><td><div>Код по БУЛСТАТ</div></td><td><div></div></td></tr></table>
<table><tr><th colspan="8"><div>Участва в управлението на следните субекти</div></th></tr>
<tr><th>Код по БУЛСТАТ</th><th>Пълно наименование</th><th>Длъжност</th><th>Роля</th><th>Вид на колективен орган</th><th>От</th><th>До</th><th>Представлява в управлението</th></tr>
<tr><td><div>119535427</div></td><td><div>БЪЛГАРИЯ, СДРУЖЕНИЕ "КЛУБ", правна форма: Сдружение, юридическо лице</div></td><td><div>Председател</div></td><td><div>управляващ</div></td><td></td><td><div>16.09.1996</div></td><td><div>06.03.2001</div></td><td></td></tr>
<tr><td><div>000403439</div></td><td><div>БЪЛГАРИЯ, ПГЛВ "АЛЕКСАНДЪР СТАМБОЛИЙСКИ", правна форма: Училище</div></td><td><div>Директор</div></td><td><div>управляващ</div></td><td></td><td><div>01.09.2020</div></td><td></td><td><div>Да</div></td></tr></table>`);
    return new Response('<table><tr><th colspan="2"><div>Основни данни</div></th></tr><tr><td><div>Код по БУЛСТАТ</div></td><td><div>179751899</div></td></tr></table>');
  };
  const r = await admin.call('verify.person', { name: 'Иван Петров Иванов', birth: '1975-01-01' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const bp = r.bulstatPeople;
  assert.equal(bp.total, 140);
  assert.equal(bp.people.length, 2);
  const rows = bp.people[0].groups[0].rows;
  assert.deepEqual(rows.map(x => [x.eik, x.name, x.legalForm, x.active]), [['119535427', 'СДРУЖЕНИЕ "КЛУБ"', 'Сдружение', false], ['000403439', 'ПГЛВ "АЛЕКСАНДЪР СТАМБОЛИЙСКИ"', 'Училище', true]]);
  assert.equal(rows[1].position, 'Директор');
  assert.equal(bp.people[1].code, '179751899');
  assert.ok(urls.some(u => /rpt3\.rptdesign&cyrNames=%D0%98%D0%92%D0%90%D0%9D%20.*&birthDate=1975-01-01/.test(u)));
  assert.equal((await admin.call('verify.person', { name: 'Иван Петров', birth: '1975-13-01' })).error, 'value');
});
