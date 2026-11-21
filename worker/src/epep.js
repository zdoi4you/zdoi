/*
 * ЕПЕП – Единен портал за електронно правосъдие (ecase.justice.bg): публичните данни за делата.
 *
 * Порталът няма документиран API за външни системи; използват се публичните адреси, от които собствената му страница
 * на делото зарежда данните (без вход и без лични данни на физически лица – те са с инициали):
 *   POST /Case/LoadData            търсене по номер и година → съд, вид, образуване, отделение, състав, докладчик
 *   POST /Case/HearingsLoadData    заседания (вид, резултат, отменено, секретар, прокурор, зала, видео)
 *   POST /Case/ActsLoadData        съдебни актове (вид, №, подписан, влязъл в сила, съставители и роли)
 *   POST /Case/SidesLoadData       страни (качество, адвокати)
 *   POST /Case/AssignmentsLoadData разпределения (съдия, дата, начин, разпределил)
 *   POST /Case/ConnectedCaseLoadData свързани дела
 * Тялото е { data: JSON.stringify({…}), page, size }. Пълната електронна папка (документи, призовки) изисква вход с КЕП
 * и разрешение от съда – тя не се чете.
 */

export const EPEP_BASE = 'https://ecase.justice.bg';
const GID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
export const gidOf = v => { const m = GID_RE.exec(String(v || '')); return m ? m[1].toLowerCase() : ''; };
export const caseUrl = gid => EPEP_BASE + '/Case/CaseDetail/' + gid;

/* имената на съдилищата в ЕПЕП са с тире („Административен съд - София-град“), при нас – с дълго тире */
export const courtKey = s => String(s || '').toLowerCase().replace(/[‐-―−-]/g, '-').replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();

async function post(env, path, data, size = 100) {
  const f = env.__epep || fetch;
  let r;
  try {
    r = await f(EPEP_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'ADM-ZDOI4You/1.0 (+https://adm.zdoi.eu)' },
      body: JSON.stringify({ data: JSON.stringify(data), page: 1, size })
    });
  } catch (e) { throw new Error('ЕПЕП не отговаря: ' + e.message); }
  if (!r.ok) throw new Error('ЕПЕП отговори с код ' + r.status + '.');
  let j;
  try { j = await r.json(); } catch (_) { throw new Error('ЕПЕП върна неочакван отговор.'); }
  return Array.isArray(j && j.data) ? j.data : [];
}

const day = v => (/^\d{4}-\d{2}-\d{2}/.test(v || '') ? String(v).slice(0, 10) : '');
const hm = v => { const m = /T(\d{2}):(\d{2})/.exec(v || ''); return m && !(m[1] === '00' && m[2] === '00') ? m[1] + ':' + m[2] : ''; };
const txt = v => (v === null || v === undefined ? '' : String(v).trim());

const caseRow = x => ({
  gid: txt(x.gid).toLowerCase(), court: txt(x.courtName), kind: txt(x.caseKindName), no: txt(x.regNumber), year: txt(x.regYear),
  instituted: day(x.formationDate), inNo: txt(x.incommingNumber), reporter: txt(x.judgeReporter), department: txt(x.departmentName), panel: txt(x.panelName),
  left: txt(x.sideLeft), right: txt(x.sideRight), restricted: !!x.restrictedAccess
});

/* търсене по номер и година; court – по желание, сравнява се без значение на тирето */
export async function epepSearch(env, { caseNo, year, court }) {
  const rows = (await post(env, '/Case/LoadData', { RegNumber: String(caseNo || ''), RegYear: String(year || '') }, 200)).map(caseRow)
    .filter(x => x.no === String(caseNo) && x.year === String(year));
  if (!court) return rows;
  const k = courtKey(court);
  return rows.filter(x => courtKey(x.court) === k);
}

/* всичко публично за делото */
export async function epepFetch(env, gid, base) {
  const q = { gid, public: 'True' };
  const [hearings, acts, sides, assignments, connected] = await Promise.all([
    post(env, '/Case/HearingsLoadData', q), post(env, '/Case/ActsLoadData', q), post(env, '/Case/SidesLoadData', q),
    post(env, '/Case/AssignmentsLoadData', q), post(env, '/Case/ConnectedCaseLoadData', q).catch(() => [])
  ]);
  return {
    gid, url: caseUrl(gid), info: base || null,
    hearings: hearings.map(x => ({ gid: txt(x.gid).toLowerCase(), date: day(x.date), time: hm(x.date), type: txt(x.hearingType), result: txt(x.hearingResult), canceled: !!x.isCanceled,
      secretary: txt(x.secretaryName), prosecutor: txt(x.prosecutorName), room: txt(x.courtRoom), video: /^https:\/\//.test(txt(x.videoUrl)) ? txt(x.videoUrl) : '' })).filter(x => x.date),
    acts: acts.map(x => ({ gid: txt(x.gid).toLowerCase(), kind: txt(x.actKindName), no: txt(x.number), date: day(x.dateSigned), inPower: day(x.dateInPower),
      judges: (Array.isArray(x.preparators) ? x.preparators : []).map(p => ({ name: txt(p.judgeName), role: txt(p.judgeRole) })).filter(p => p.name) })).filter(x => x.date),
    sides: sides.map(x => ({ gid: txt(x.gid).toLowerCase(), name: txt(x.subjectName), role: txt(x.sideInvolvementKindName),
      lawyers: (Array.isArray(x.lawyers) ? x.lawyers : []).map(l => txt(l && (l.name || l.fullName || l.lawyerName || l))).filter(Boolean) })).filter(x => x.name),
    assignments: assignments.map(x => ({ date: day(x.date), judge: txt(x.judgeName), type: txt(x.type), by: txt(x.assignor) })),
    connected: connected.map(x => ({ gid: txt(x.gid).toLowerCase(), court: txt(x.courtName), kind: txt(x.caseKindName), no: txt(x.regNumber), year: txt(x.regYear) })).filter(x => x.gid)
  };
}
