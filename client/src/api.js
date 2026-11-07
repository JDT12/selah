import { clientId } from './live.js';

// Asked to confirm it's you (password, and code) before a sensitive change; set by the workspace. Resolves true once
// confirmed, and the request is sent again.
let confirmIdentity = null;
export const setConfirmIdentity = (fn) => { confirmIdentity = fn; };

export async function request(method, url, body, retried = false) {
  const opts = { method, headers: { 'X-Client-Id': clientId } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401 && !/^\/api\/(login|password|security\/confirm)/.test(url)) {
    window.dispatchEvent(new Event('noteapp:unauthorized'));
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 403 && data?.reauth && !retried && confirmIdentity && await confirmIdentity()) {
    return request(method, url, body, true);
  }
  if (!res.ok) throw Object.assign(new Error(data?.error || `${res.status} ${res.statusText}`), { status: res.status, data });
  return data;
}

function xhrUpload(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('X-Client-Id', clientId);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status === 401) window.dispatchEvent(new Event('noteapp:unauthorized'));
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new Error(xhr.response?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(formData);
  });
}

const qs = (params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  session: () => request('GET', '/api/session'),
  version: () => request('GET', '/api/version'),
  notice: () => request('GET', '/api/notice'),
  login: (password, app, login) => request('POST', '/api/login', { password, app, login }),
  loginCode: (ticket, code, recovery = false) => request('POST', '/api/login/code', { ticket, code, recovery }),
  logout: () => request('POST', '/api/logout'),
  changePassword: (current, next, code) => request('POST', '/api/password', { current, next, code }),

  // A tenant's setup link (SetupPage), and Settings → Account.
  setupCheck: (token) => request('POST', '/api/setup/check', { token }),
  setupTwoStep: (token) => request('POST', '/api/setup/two-step', { token }),
  setupFinish: (token, body) => request('POST', '/api/setup/finish', { token, ...body }),
  // 10.0: the username and email you sign in with, and the reminders to choose them and to turn on two-step sign-in.
  identity: () => request('GET', '/api/account/identity'),
  setIdentity: (who) => request('PUT', '/api/account/identity', who),
  identityLater: () => request('POST', '/api/account/identity/later'),
  twoStepNudgeOff: () => request('POST', '/api/account/two-step-nudge/off'),
  account: () => request('GET', '/api/account'),
  deleteAccount: (confirm) => request('POST', '/api/account/delete', { confirm }),

  // Sharing between tenants (8.0, server/sharing.js).
  sharing: () => request('GET', '/api/sharing'),
  addContact: (slug) => request('POST', '/api/sharing/contacts', { slug }),
  acceptContact: (slug) => request('POST', `/api/sharing/contacts/${encodeURIComponent(slug)}/accept`),
  removeContact: (slug) => request('DELETE', `/api/sharing/contacts/${encodeURIComponent(slug)}`),
  shareOf: (kind, id) => request('GET', `/api/sharing/item${qs({ kind, id })}`),
  shareItem: (body) => request('PUT', '/api/sharing/item', body),
  stopShare: (id) => request('DELETE', `/api/sharing/out/${id}`),
  shared: (id) => request('GET', `/api/shared/${id}`),
  sharedSeen: (id) => request('POST', `/api/shared/${id}/seen`),
  sharedNote: (id, key) => request('GET', `/api/shared/${id}/notes/${key}`),
  copyShared: (id, key = null) => request('POST', `/api/shared/${id}/copy`, { key }),
  commentShared: (id, body) => request('POST', `/api/shared/${id}/comments`, body),
  noteShareComments: (id) => request('GET', `/api/notes/${id}/share-comments`),
  noteShareCommentsSeen: (id) => request('POST', `/api/notes/${id}/share-comments/seen`),
  replyThread: (thread, body) => request('POST', `/api/sharing/threads/${thread}/reply`, { body }),
  resolveThread: (thread, resolved) => request('POST', `/api/sharing/threads/${thread}/resolve`, { resolved }),
  deleteShareComment: (id) => request('DELETE', `/api/sharing/comments/${id}`),

  security: () => request('GET', '/api/security'),
  securityLog: (limit) => request('GET', `/api/security/log${qs({ limit })}`),
  confirmIdentity: (password, code, recovery = false) => request('POST', '/api/security/confirm', { password, code, recovery }),
  saveSecuritySettings: (settings) => request('PUT', '/api/security/settings', settings),
  startTwoStep: () => request('POST', '/api/security/two-step/start'),
  enableTwoStep: (code) => request('POST', '/api/security/two-step/enable', { code }),
  disableTwoStep: () => request('POST', '/api/security/two-step/disable'),
  newRecoveryCodes: () => request('POST', '/api/security/recovery-codes'),
  signOutDevice: (id) => request('DELETE', `/api/security/sessions/${id}`),
  signOutOthers: () => request('POST', '/api/security/sessions/others'),

  tree: () => request('GET', '/api/tree'),

  createStack: (name, notebookIds = []) => request('POST', '/api/stacks', { name, notebookIds }),
  renameStack: (id, name) => request('PATCH', `/api/stacks/${id}`, { name }),
  deleteStack: (id) => request('DELETE', `/api/stacks/${id}`),

  createNotebook: (name, stack_id = null) => request('POST', '/api/notebooks', { name, stack_id }),
  updateNotebook: (id, patch) => request('PATCH', `/api/notebooks/${id}`, patch),
  deleteNotebook: (id) => request('DELETE', `/api/notebooks/${id}`),
  mergeNotebook: (id, into) => request('POST', `/api/notebooks/${id}/merge`, { into }),

  zotero: () => request('GET', '/api/zotero'),
  connectZotero: (apiKey) => request('PUT', '/api/zotero', { apiKey }),
  disconnectZotero: () => request('DELETE', '/api/zotero'),
  zoteroSearch: (q) => request('GET', `/api/zotero/search${qs({ q })}`),
  /** CSL-JSON of cited sources: get some by id, save newly cited ones, re-read all from Zotero. */
  sources: (ids) => request('GET', `/api/sources${qs({ ids: ids.join(',') })}`),
  recentSources: () => request('GET', '/api/sources/recent'),
  saveSources: (list) => request('POST', '/api/sources', list),
  refreshSources: () => request('POST', '/api/sources/refresh'),

  scriptureSummary: () => request('GET', '/api/scripture/summary'),
  dailyWalk: (date, today) => request('GET', `/api/daily-walk${qs({ date, today })}`),
  setDailyWalkRead: (body) => request('PUT', '/api/daily-walk/read', body),
  dailyWalkBooks: () => request('GET', '/api/daily-walk/books'),
  addDailyWalkBook(file, today, onProgress) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return xhrUpload(`/api/daily-walk/books${qs({ today })}`, fd, onProgress);
  },
  updateDailyWalkBook: (id, body) => request('PATCH', `/api/daily-walk/books/${id}`, body),
  deleteDailyWalkBook: (id) => request('DELETE', `/api/daily-walk/books/${id}`),
  dailyWalkJournal: (date, notebookId) => request('POST', '/api/daily-walk/journal', { date, notebook_id: notebookId }),
  setPrayed: (body) => request('PUT', '/api/daily-walk/prayed', body),
  // 11.0: attendance (Plan → Attendance)
  attendance: () => request('GET', '/api/attendance'),
  attendanceEvents: () => request('GET', '/api/attendance/events'),
  attendanceGroup: (id) => request('GET', `/api/attendance/groups/${id}`),
  createAttendanceGroup: (body) => request('POST', '/api/attendance/groups', body),
  updateAttendanceGroup: (id, patch) => request('PATCH', `/api/attendance/groups/${id}`, patch),
  deleteAttendanceGroup: (id) => request('DELETE', `/api/attendance/groups/${id}`),
  addAttendancePerson: (groupId, body) => request('POST', `/api/attendance/groups/${groupId}/people`, body),
  updateAttendancePerson: (id, patch) => request('PATCH', `/api/attendance/people/${id}`, patch),
  deleteAttendancePerson: (id) => request('DELETE', `/api/attendance/people/${id}`),
  saveMeeting: (groupId, date, body) => request('PUT', `/api/attendance/groups/${groupId}/meetings/${date}`, body),
  markAttendance: (groupId, date, personId, present) => request('POST', `/api/attendance/groups/${groupId}/meetings/${date}/mark`, { person_id: personId, present }),
  deleteMeeting: (groupId, date) => request('DELETE', `/api/attendance/groups/${groupId}/meetings/${date}`),
  followUp: (personId, task = true) => request('POST', `/api/attendance/people/${personId}/follow-up`, { task }),
  // 10.2: reading plans
  planCatalog: () => request('GET', '/api/plans/catalog'),
  plans: (today) => request('GET', `/api/plans${qs({ today })}`),
  plan: (id, today) => request('GET', `/api/plans/${id}${qs({ today })}`),
  createPlan: (body) => request('POST', '/api/plans', body),
  updatePlan: (id, body) => request('PATCH', `/api/plans/${id}`, body),
  deletePlan: (id) => request('DELETE', `/api/plans/${id}`),
  setPlanRead: (id, body) => request('PUT', `/api/plans/${id}/read`, body),
  shiftPlan: (id, today) => request('POST', `/api/plans/${id}/shift`, { today }),
  restartPlan: (id, today) => request('POST', `/api/plans/${id}/restart`, { today }),
  prayer: (today) => request('GET', `/api/prayer${qs({ today })}`),
  addPrayer: (body) => request('POST', '/api/prayer', body),
  updatePrayer: (id, body) => request('PATCH', `/api/prayer/${id}`, body),
  deletePrayer: (id, today) => request('DELETE', `/api/prayer/${id}${qs({ today })}`),
  addPrayerUpdate: (id, body) => request('POST', `/api/prayer/${id}/updates`, body),
  deletePrayerUpdate: (id) => request('DELETE', `/api/prayer/updates/${id}`),
  setPrayerPerDay: (perDay, today) => request('PUT', '/api/prayer/settings', { perDay, today }),
  esvStatus: () => request('GET', '/api/esv'),
  connectEsv: (apiKey) => request('PUT', '/api/esv', { apiKey }),
  disconnectEsv: () => request('DELETE', '/api/esv'),
  esvUsage: () => request('GET', '/api/esv/usage'),
  esvStored: () => request('GET', '/api/esv/stored'),
  forgetEsv: (ref) => request('DELETE', `/api/esv/stored${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`),
  esvPassage: (q) => request('GET', `/api/esv/passage${qs({ q })}`),
  bibleStatus: () => request('GET', '/api/bible'),
  setBibleFavorite: (id) => request('PUT', '/api/bible/favorite', { id }),
  verseOfTheDay: () => request('GET', '/api/votd'),
  biblePassage: (q, t = '') => request('GET', `/api/bible/passage${qs({ q, t })}`),
  bibleUsage: () => request('GET', '/api/bible/usage'),
  forgetBible: (t) => request('DELETE', `/api/bible/stored${qs({ t })}`),
  connectNlt: (apiKey) => request('PUT', '/api/bible/nlt', { apiKey }),
  disconnectNlt: () => request('DELETE', '/api/bible/nlt'),
  connectApiBible: (apiKey) => request('PUT', '/api/bible/apibible', { apiKey }),
  apiBibles: () => request('GET', '/api/bible/apibible/bibles'),
  chooseApiBibles: (bibles) => request('PUT', '/api/bible/apibible/chosen', { bibles }),
  disconnectApiBible: () => request('DELETE', '/api/bible/apibible'),
  /** params: { q } (a passage) or { book, chapter } */
  scriptureNotes: (params) => request('GET', `/api/scripture/notes${qs(params)}`),
  versePassage: (q, t = '') => request('GET', `/api/verses/passage${qs({ q, t })}`),
  /** params: { ref } (the verse notes on a passage) */
  verseNotes: (params) => request('GET', `/api/verse-notes${qs(params)}`),
  addVerseNote: (body) => request('POST', '/api/verse-notes', body),
  bibleStudies: () => request('GET', '/api/bible-studies'),
  createBibleStudy: (body) => request('POST', '/api/bible-studies', body),
  updateBibleStudy: (id, body) => request('PATCH', `/api/bible-studies/${id}`, body),
  removeBibleStudy: (id) => request('DELETE', `/api/bible-studies/${id}`),
  noteBibleStudy: (noteId) => request('GET', `/api/notes/${noteId}/bible-study`),
  makeBibleStudy: (noteId) => request('POST', `/api/notes/${noteId}/bible-study`),
  writeBibleStudy: (noteId, body) => request('PUT', `/api/notes/${noteId}/bible-study`, body),
  studyToLesson: (id, body) => request('POST', `/api/bible-studies/${id}/lesson`, body),
  studyToWriting: (id, body) => request('POST', `/api/bible-studies/${id}/writing`, body),
  studyForward: (id, body) => request('POST', `/api/bible-studies/${id}/forward`, body),
  noteFromStudies: (noteId) => request('GET', `/api/notes/${noteId}/from-studies`),
  studyReview: (days) => request('GET', `/api/bible-studies/review${qs({ days })}`),
  wordStudies: () => request('GET', '/api/word-studies'),
  backgroundStudy: (ref) => request('GET', `/api/background-studies${qs({ ref })}`),
  langVerse: (ref) => request('GET', `/api/lang/verse${qs({ ref })}`),
  langSearch: (q) => request('GET', `/api/lang/search${qs({ q })}`),
  langWord: (code, ref = '', all = false) => request('GET', `/api/lang/word/${encodeURIComponent(code)}${qs({ ref, all: all ? 1 : '' })}`),
  memoryVerses: () => request('GET', '/api/memory-verses'),
  addMemoryVerse: (ref) => request('POST', '/api/memory-verses', { ref }),
  orderMemoryVerses: (ids) => request('POST', '/api/memory-verses/order', { ids }),
  practicedMemoryVerse: (id) => request('POST', `/api/memory-verses/${id}/practiced`),
  deleteMemoryVerse: (id) => request('DELETE', `/api/memory-verses/${id}`),
  noteScripture: (id) => request('GET', `/api/scripture/note/${id}`),

  listTags: () => request('GET', '/api/tags'),
  /** patch: { name, color, merge } — with merge, renaming onto an existing tag merges the two. */
  updateTag: (id, patch) => request('PATCH', `/api/tags/${id}`, patch),
  mergeTag: (id, into) => request('POST', `/api/tags/${id}/merge`, { into }),
  deleteTag: (id) => request('DELETE', `/api/tags/${id}`),
  /** body: { tag_id } or { name }, add: [note ids], remove: [note ids] */
  applyTag: (body) => request('POST', '/api/tags/apply', body),

  getPref: (key) => request('GET', `/api/prefs/${key}`).then((r) => r.value),
  setPref: (key, value) => request('PUT', `/api/prefs/${key}`, { value }),

  addShortcut: (kind, target_id) => request('POST', '/api/shortcuts', { kind, target_id }),
  reorderShortcuts: (ids) => request('PUT', '/api/shortcuts/order', { ids }),
  removeShortcut: (id) => request('DELETE', `/api/shortcuts/${id}`),

  listNotes: (params) => request('GET', `/api/notes${qs(params)}`),
  getNote: (id) => request('GET', `/api/notes/${id}`),
  inbox: () => request('GET', '/api/inbox'),
  studies: () => request('GET', '/api/studies'),
  study: (id) => request('GET', `/api/studies/${id}`),
  createStudy: (body) => request('POST', '/api/studies', body),
  updateStudy: (id, body) => request('PATCH', `/api/studies/${id}`, body),
  deleteStudy: (id) => request('DELETE', `/api/studies/${id}`),
  addStudyItems: (id, items) => request('POST', `/api/studies/${id}/items`, { items }),
  updateStudyItem: (id, body) => request('PATCH', `/api/study-items/${id}`, body),
  deleteStudyItem: (id) => request('DELETE', `/api/study-items/${id}`),
  studyItemNote: (id, body) => request('POST', `/api/study-items/${id}/note`, body),
  createCourse: (body) => request('POST', '/api/courses', body),
  course: (id) => request('GET', `/api/courses/${id}`),
  updateCourse: (id, body) => request('PATCH', `/api/courses/${id}`, body),
  skipClass: (id, date, skip = true) => request('POST', `/api/courses/${id}/skip`, { date, skip }),
  addCourseWeek: (id, body) => request('POST', `/api/courses/${id}/weeks`, body),
  orderCourseWeeks: (id, ids) => request('POST', `/api/courses/${id}/weeks/order`, { ids }),
  deleteCourseWeek: (itemId) => request('DELETE', `/api/course-weeks/${itemId}`),
  setWeekStudy: (itemId, noteId) => request('PUT', `/api/course-weeks/${itemId}/study`, { note_id: noteId }),
  setWeekReflection: (itemId, body) => request('PUT', `/api/course-weeks/${itemId}/reflection`, body),
  teachAgain: (id, body) => request('POST', `/api/courses/${id}/teach-again`, body),
  courseGuide: (id) => request('GET', `/api/courses/${id}/guide`),
  lesson: (noteId) => request('GET', `/api/notes/${noteId}/lesson`),
  noteMethod: (noteId) => request('GET', `/api/notes/${noteId}/method`),
  setNoteMethod: (noteId, method) => request('PUT', `/api/notes/${noteId}/method`, { method }),
  writeLesson: (noteId, body) => request('PUT', `/api/notes/${noteId}/lesson`, body),
  noteComplete: (noteId) => request('GET', `/api/notes/${noteId}/complete`),
  setNoteComplete: (noteId, complete) => request('PUT', `/api/notes/${noteId}/complete`, { complete }),
  addStudyNote: (id, body) => request('POST', `/api/studies/${id}/notes`, body),
  removeStudyNote: (id, noteId) => request('DELETE', `/api/studies/${id}/notes/${noteId}`),
  noteStudies: (noteId) => request('GET', `/api/notes/${noteId}/studies`),
  syncStudy: (id) => request('POST', `/api/studies/${id}/sync`),
  planLectures: (id) => request('POST', `/api/classes/${id}/lectures`),
  startPaper: (itemId, body) => request('POST', `/api/study-items/${itemId}/paper`, body ?? {}),
  classesDue: (days) => request('GET', `/api/classes/due${qs({ days })}`),
  deskHome: () => request('GET', '/api/desk/home'),
  work: (passage) => request('GET', passage ? `/api/work?passage=${encodeURIComponent(passage)}` : '/api/work'),
  shelveClass: (id) => request('POST', `/api/classes/${id}/shelve`),
  // 11.0: a class's syllabus PDF, kept with the class (not in a note).
  uploadSyllabusPdf(id, file, onProgress) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return xhrUpload(`/api/classes/${id}/syllabus-pdf`, fd, onProgress);
  },
  removeSyllabusPdf: (id) => request('DELETE', `/api/classes/${id}/syllabus-pdf`),
  addChapter: (id, body) => request('POST', `/api/studies/${id}/chapters`, body),
  updateChapter: (id, noteId, body) => request('PATCH', `/api/studies/${id}/chapters/${noteId}`, body),
  writingBoard: () => request('GET', '/api/writing/board'),
  orderChapters: (id, ids) => request('POST', `/api/studies/${id}/chapters/order`, { ids }),
  studyManuscript: (id) => request('GET', `/api/studies/${id}/manuscript`),
  studySources: (id) => request('GET', `/api/studies/${id}/sources`),
  syncSeries: (id) => request('POST', `/api/studies/${id}/series/sync`),
  syncNoteSeries: (noteId) => request('POST', `/api/notes/${noteId}/series/sync`),
  openGuide: () => request('POST', '/api/guide'),
  openMaintenanceGuide: () => request('POST', '/api/guide/maintenance'),
  sermons: () => request('GET', '/api/sermons'),
  sermon: (id) => request('GET', `/api/sermons/${id}`),
  createSermon: (body) => request('POST', '/api/sermons', body),
  updateSermon: (id, body) => request('PATCH', `/api/sermons/${id}`, body),
  removeSermon: (id) => request('DELETE', `/api/sermons/${id}`),
  noteSermon: (noteId) => request('GET', `/api/notes/${noteId}/sermon`),
  slides: (noteId) => request('GET', `/api/notes/${noteId}/slides`),
  saveSlides: (noteId, deck) => request('PUT', `/api/notes/${noteId}/slides`, { deck }),
  slidesLive: (state) => request('PUT', '/api/slides/live', state),
  /** Sent with keepalive, so it still goes when the window is closing. */
  endSlidesLive: (noteId) => fetch(`/api/slides/live?note=${noteId}`, { method: 'DELETE', keepalive: true, headers: { 'X-Client-Id': clientId } }).catch(() => {}),
  getSlidesLive: () => request('GET', '/api/slides/live'),
  slidesCommand: (note, cmd) => request('POST', '/api/slides/live/command', { note, cmd }),
  remoteQr: () => request('GET', '/api/slides/remote-qr'),
  // 11.0: the church brand and the slide media library.
  slideBrand: () => request('GET', '/api/slides/brand'),
  saveSlideBrand: (patch) => request('PUT', '/api/slides/brand', patch),
  uploadBrandLogo(file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return xhrUpload('/api/slides/brand/logo', fd);
  },
  removeBrandLogo: () => request('DELETE', '/api/slides/brand/logo'),
  slideMedia: () => request('GET', '/api/slides/media'),
  uploadSlideMedia(file, onProgress) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return xhrUpload('/api/slides/media', fd, onProgress);
  },
  deleteSlideMedia: (id) => request('DELETE', `/api/slides/media/${id}`),
  makeSermon: (noteId) => request('POST', `/api/notes/${noteId}/sermon`),
  writeSermon: (noteId, body) => request('PUT', `/api/notes/${noteId}/sermon`, body),
  preachings: () => request('GET', '/api/preachings'),
  logPreaching: (noteId, body) => request('POST', `/api/notes/${noteId}/preached`, body),
  updatePreaching: (id, body) => request('PATCH', `/api/preachings/${id}`, body),
  deletePreaching: (id) => request('DELETE', `/api/preachings/${id}`),
  importSermons: (body) => request('POST', '/api/sermons/import', body),
  sermonBank: () => request('GET', '/api/sermon-bank'),
  addToBank: (body) => request('POST', '/api/sermon-bank', body),
  updateBankItem: (id, body) => request('PATCH', `/api/sermon-bank/${id}`, body),
  removeBankItem: (id) => request('DELETE', `/api/sermon-bank/${id}`),
  usedBankItem: (id, sermonId) => request('POST', `/api/sermon-bank/${id}/uses`, { sermon_id: sermonId }),
  archivePreview: (noteId, { weeks = true, clean = true } = {}) => request('GET', `/api/studies/archive/preview/${noteId}${qs({ weeks: weeks ? undefined : 0, clean: clean ? undefined : 0 })}`),
  archiveClasses: (classes) => request('POST', '/api/studies/archive', { classes }),
  capture: (body) => request('POST', '/api/capture', body),
  claimShare: (token) => request('POST', `/api/share/${token}/claim`),
  clipPairing: () => request('POST', '/api/clip/pairing'),
  clipInfo: () => request('GET', '/api/clip/info'),
  clipBank: (body) => request('POST', '/api/clip/bank', body),
  clipDevices: () => request('GET', '/api/clip/devices'),
  revokeClipDevice: (id) => request('DELETE', `/api/clip/devices/${id}`),
  notePreview: (id) => request('GET', `/api/notes/${id}/preview`),
  noteConnections: (id) => request('GET', `/api/notes/${id}/connections`),
  linkMention: (id, from) => request('POST', `/api/notes/${id}/mentions/${from}/link`),
  noteVersions: (id) => request('GET', `/api/notes/${id}/versions`),
  noteVersion: (id, vid) => request('GET', `/api/notes/${id}/versions/${vid}`),
  snapshotNote: (id, reason) => request('POST', `/api/notes/${id}/versions`, { reason }),
  restoreVersion: (id, vid) => request('POST', `/api/notes/${id}/versions/${vid}/restore`),
  createNote: (notebook_id) => request('POST', '/api/notes', { notebook_id, html: '<p></p>' }),
  updateNote: (id, patch, keepalive = false) =>
    keepalive
      ? fetch(`/api/notes/${id}`, {
          method: 'PATCH', keepalive: true,
          headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId }, body: JSON.stringify(patch),
        })
      : request('PATCH', `/api/notes/${id}`, patch),
  trashNote: (id) => request('DELETE', `/api/notes/${id}`),
  deleteNoteForever: (id) => request('DELETE', `/api/notes/${id}?permanent=1`),
  restoreNote: (id, notebookId = null) => request('POST', `/api/notes/${id}/restore`, notebookId ? { notebook_id: notebookId } : {}),
  restoreNotes: (ids, notebookId = null) => request('POST', '/api/trash/restore', { ids, notebook_id: notebookId }),
  trashSettings: () => request('GET', '/api/trash/settings'),
  setTrashDays: (days) => request('PUT', '/api/trash/settings', { days }),

  // Restore from a backup (server/restorepoints.js).
  restoreSources: () => request('GET', '/api/restore/sources'),
  restoreOffsiteList: () => request('GET', '/api/restore/offsite'),
  restoreOpen: (source) => request('POST', '/api/restore/open', { source }),
  restoreList: (token, params) => request('GET', `/api/restore/${token}/notes${qs(params)}`),
  restorePreview: (token, id) => request('GET', `/api/restore/${token}/notes/${id}`),
  restoreRun: (token, body) => request('POST', `/api/restore/${token}/restore`, body),
  restoreClose: (token) => request('DELETE', `/api/restore/${token}`),
  /** body: { notebook_id, title, asTemplate }. From a template, a new note; otherwise a duplicate. */
  copyNote: (id, body = {}) => request('POST', `/api/notes/${id}/copy`, body),
  eventCategories: () => request('GET', '/api/event-categories'),
  createEventCategory: (body) => request('POST', '/api/event-categories', body),
  updateEventCategory: (id, body) => request('PATCH', `/api/event-categories/${id}`, body),
  deleteEventCategory: (id) => request('DELETE', `/api/event-categories/${id}`),
  orderEventCategories: (ids) => request('PUT', '/api/event-categories/order', { ids }),
  setDefaultEventCategory: (id) => request('PUT', '/api/event-categories/default', { id }),
    exportSummary: (scope) => request('GET', `/api/export/summary${qs(scope)}`),
  exportUrl: (format, scope) => `/api/export${qs({ format, ...scope })}`,
  mergeNotes: (body) => request('POST', '/api/notes/merge', body),
  splitNote: (id, body) => request('POST', `/api/notes/${id}/split`, body),
  emptyTrash: () => request('DELETE', '/api/trash'),

  dashboard: () => request('GET', '/api/dashboard'),
  // Selah Desktop (12.0): automatic backups and replacing the library (server/desktopbackup.js).
  desktopBackups: () => request('GET', '/api/desktop/backups'),
  saveDesktopBackups: (patch) => request('PUT', '/api/desktop/backups', patch),
  runDesktopBackup: () => request('POST', '/api/desktop/backups/run', {}),
  desktopRestore: (body) => request('POST', '/api/desktop/restore', body),
  dismissDesktopRestored: () => request('DELETE', '/api/desktop/restored'),
  // The library in a sync folder (server/desktopsync.js).
  desktopSync: () => request('GET', '/api/desktop/sync'),
  setDesktopSync: (folder, use) => request('PUT', '/api/desktop/sync', { folder, use }),
  stopDesktopSync: () => request('DELETE', '/api/desktop/sync'),
  saveDesktopSync: () => request('POST', '/api/desktop/sync/save', {}),
  desktopSyncTakeOver: (force) => request('POST', '/api/desktop/sync/take-over', { force }),
  desktopSyncConflictSeen: () => request('DELETE', '/api/desktop/sync/conflict'),
  calendar: (from, to) => request('GET', `/api/calendar${qs({ from, to })}`),
  createEvent: (body) => request('POST', '/api/events', body),
  updateEvent: (id, body) => request('PATCH', `/api/events/${id}`, body),
  deleteEvent: (id, scope, occurrence) => request('DELETE', `/api/events/${id}${qs({ scope, occurrence })}`),

  listTasks: (status) => request('GET', `/api/tasks${qs({ status })}`),
  createTask: (body) => request('POST', '/api/tasks', body),
  updateTask: (id, body) => request('PATCH', `/api/tasks/${id}`, body),
  deleteTask: (id) => request('DELETE', `/api/tasks/${id}`),
  deleteCompletedTasks: () => request('DELETE', '/api/tasks/completed'),
  completeTask: (id) => request('POST', `/api/tasks/${id}/complete`),
  uncompleteTask: (id, nextId) => request('POST', `/api/tasks/${id}/uncomplete`, nextId ? { next_id: nextId } : {}),
  bulkTasks: (body) => request('POST', '/api/tasks/bulk', body),
  restoreTasks: (tasks) => request('POST', '/api/tasks/restore', { tasks }),
  listTaskLists: () => request('GET', '/api/task-lists'),
  createTaskList: (body) => request('POST', '/api/task-lists', body),
  updateTaskList: (id, body) => request('PATCH', `/api/task-lists/${id}`, body),
  deleteTaskList: (id, deleteTasks) => request('DELETE', `/api/task-lists/${id}${deleteTasks ? '?tasks=delete' : ''}`),

  storage: () => request('GET', '/api/storage'),

  offsite: () => request('GET', '/api/offsite'),
  // body: { provider: 'onedrive', connected | token } or { provider: 's3' | 'webdav', …fields }, plus passphrase
  setupOffsite: (body) => request('PUT', '/api/offsite', body),
  testOffsite: (body) => request('POST', '/api/offsite/test', body),
  backupDownloadInfo: () => request('GET', '/api/backup/download'),
  startBackupDownload: (encrypt, passphrase) => request('POST', '/api/backup/download', { encrypt, passphrase }),
  offsiteConnectStart: () => request('POST', '/api/offsite/connect/start'),
  offsiteConnectFinish: (url) => request('POST', '/api/offsite/connect/finish', { url }),
  disconnectOffsite: () => request('DELETE', '/api/offsite'),
  runOffsite: (kind) => request('POST', '/api/offsite/run', { kind }),
  checkOffsitePassphrase: (passphrase) => request('POST', '/api/offsite/check-passphrase', { passphrase }),

  wordpress: () => request('GET', '/api/wordpress'),
  connectWordpress: (site, username, password) => request('PUT', '/api/wordpress', { site, username, password }),
  disconnectWordpress: () => request('DELETE', '/api/wordpress'),
  wordpressOptions: (opts) => request('PATCH', '/api/wordpress', opts),
  wordpressStats: (fresh) => request('GET', `/api/wordpress/stats${fresh ? '?fresh=1' : ''}`),
  wordpressSchema: () => request('GET', '/api/wordpress/schema'),
  wordpressPosts: (params) => request('GET', `/api/wordpress/posts${qs(params)}`),
  deleteWordpressPost: (id, permanent) => request('DELETE', `/api/wordpress/posts/${id}${permanent ? '?permanent=1' : ''}`),
  parseScripture: (refs) => request('GET', `/api/wordpress/parse${qs({ refs })}`),
  updateWordpressPost: (id, body) => request('PATCH', `/api/wordpress/posts/${id}`, body),
  wordpressCalendar: (from, to) => request('GET', `/api/wordpress/calendar${qs({ from, to })}`),
  wordpressPipeline: () => request('GET', '/api/wordpress/pipeline'),
  wordpressArchive: (fresh) => request('GET', `/api/wordpress/archive${fresh ? '?fresh=1' : ''}`),
  wordpressComments: (params) => request('GET', `/api/wordpress/comments${qs(params)}`),
  setWordpressComment: (id, status) => request('PATCH', `/api/wordpress/comments/${id}`, { status }),
  deleteWordpressComment: (id, permanent) => request('DELETE', `/api/wordpress/comments/${id}${permanent ? '?permanent=1' : ''}`),
  replyWordpressComment: (body) => request('POST', '/api/wordpress/comments', body),
  wordpressTerms: (taxonomy) => request('GET', `/api/wordpress/terms${qs({ taxonomy })}`),
  addWordpressTerm: (body) => request('POST', '/api/wordpress/terms', body),
  updateWordpressTerm: (id, body) => request('PATCH', `/api/wordpress/terms/${id}`, body),
  deleteWordpressTerm: (id, taxonomy) => request('DELETE', `/api/wordpress/terms/${id}${qs({ taxonomy })}`),
  mergeWordpressTerms: (body) => request('POST', '/api/wordpress/terms/merge', body),
  wordpressMedia: (params) => request('GET', `/api/wordpress/media${qs(params)}`),
  wordpressMediaUsage: (fresh) => request('GET', `/api/wordpress/media-usage${fresh ? '?fresh=1' : ''}`),
  deleteWordpressMedia: (id) => request('DELETE', `/api/wordpress/media/${id}`),
  importWordpressPost: (id, notebookId) => request('POST', `/api/wordpress/posts/${id}/import`, { notebook_id: notebookId }),
  wordpressMediaFromAttachment: (attachmentId) => request('POST', '/api/wordpress/media', { attachmentId }),
  wordpressMediaFromPng(blob, name) {
    const fd = new FormData();
    fd.append('file', blob, name);
    return xhrUpload('/api/wordpress/media', fd);
  },
  notePost: (id) => request('GET', `/api/notes/${id}/wordpress`),
  saveNotePost: (id, body) => request('PUT', `/api/notes/${id}/wordpress`, body),
  uploadBanner(file, onProgress) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return xhrUpload('/api/banner', fd, onProgress);
  },
  setBannerPosition: (y) => request('PATCH', '/api/banner', { y }),
  removeBanner: () => request('DELETE', '/api/banner'),

  deleteAttachment: (id) => request('DELETE', `/api/attachments/${id}`),
  upload(noteId, file, onProgress, { recording = false, append = false } = {}) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return xhrUpload(`/api/notes/${noteId}/attachments${qs({ recording: recording ? 1 : null, append: append ? 1 : null })}`, fd, onProgress);
  },
  /** Handwriting/print → text (server/ocr.js); image is a prepared page (PNG blob). */
  ocr(image) {
    const fd = new FormData();
    fd.append('file', image, 'page.png');
    return xhrUpload('/api/ocr', fd);
  },
  attachments: (params) => request('GET', `/api/attachments${qs(params)}`),
  attachment: (id) => request('GET', `/api/attachments/${id}`),
  scanAttachments: () => request('POST', '/api/attachments/scan'),
  renameAttachment: (id, filename) => request('PATCH', `/api/attachments/${id}`, { filename }),
  moveAttachments: (ids, noteId) => request('POST', '/api/attachments/move', { ids, note_id: noteId }),
  deleteAttachments: (ids) => request('POST', '/api/attachments/delete', { ids }),
  importEnex(files, params, onProgress) {
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    return xhrUpload(`/api/import/enex${qs(params)}`, fd, onProgress);
  },
  importNotebookFile(file, params, onProgress) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return xhrUpload(`/api/import/selahnb${qs(params)}`, fd, onProgress);
  },
  /** files: [{ file, path }] (path relative to the chosen folder, or just the file name). */
  importMarkdown(files, params, onProgress) {
    const fd = new FormData();
    fd.append('mtimes', JSON.stringify(Object.fromEntries(files.map((f) => [f.path, f.file.lastModified]))));
    // Referenced files go first so the server has them when it converts the notes.
    const isMd = (f) => /\.(md|markdown|mdown|mkd)$/i.test(f.path);
    for (const f of [...files.filter((f) => !isMd(f)), ...files.filter(isMd)]) fd.append('file', f.file, f.path);
    return xhrUpload(`/api/import/markdown${qs(params)}`, fd, onProgress);
  },
};

export const fileUrl = (id) => `/api/files/${id}`;
export const pdfViewerUrl = (id) => `/pdfjs/web/viewer.html?file=${encodeURIComponent(fileUrl(id))}`;

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDate(ms) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}
