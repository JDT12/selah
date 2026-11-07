import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { startLive, stopLive } from './live.js';
import { isDesktopApp, notify, startReminders } from './desktop.js';
import { api, setConfirmIdentity } from './api.js';
import { useStoredState } from './useStoredState.js';
import { focusOn, toggleFocus, useFocusMode } from './focus.js';
import { orderedPageKeys, useFocusPages, useHiddenPages, usePageOrder } from './sidebarPages.js';
import { useDialog } from './components/Dialogs.jsx';
import Sidebar, { NOTES_SECTIONS } from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import NoteList from './components/NoteList.jsx';
import NoteEditor from './components/NoteEditor.jsx';
import { useNoteActions } from './components/useNoteActions.jsx';
import { BulkTagDialog } from './components/TagDialogs.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import Icon from './components/Icon.jsx';
import Login from './components/Login.jsx';
import { ConfirmIdentityDialog } from './components/SecuritySettings.jsx';
import HomePage from './pages/HomePage.jsx';
import CalendarPage from './pages/CalendarPage.jsx';
import TasksPage from './pages/TasksPage.jsx';
import NotebooksPage from './pages/NotebooksPage.jsx';
import TagsPage from './pages/TagsPage.jsx';
import ScripturePage from './pages/ScripturePage.jsx';
import DailyWalkPage from './pages/DailyWalkPage.jsx';
import PrayerPage from './pages/PrayerPage.jsx';
import PlansPage from './pages/PlansPage.jsx';
import AttendancePage from './pages/AttendancePage.jsx';
import WordPressPage from './pages/WordPressPage.jsx';
import AttachmentsPage from './pages/AttachmentsPage.jsx';
import MediaPage from './components/SlideMedia.jsx';
import { installVerseCards } from './esv.js';
import { installNoteCards } from './noteCards.js';
import { setTimeZone } from './time.js';
import { setServerInfo } from './mode.js';
import UpdateBanner from './components/UpdateBanner.jsx';
import NoticeBanner from './components/NoticeBanner.jsx';
import { WhatsNewCard, WhatsNewDialog } from './components/WhatsNew.jsx';
import CommandPalette, { rememberNote } from './components/CommandPalette.jsx';
import SidebarDialog from './components/SidebarDialog.jsx';
import TaskDialog from './components/TaskDialog.jsx';
import EventDialog from './components/EventDialog.jsx';
import InboxPage from './pages/InboxPage.jsx';
import DeskPage, { showCourse, showDeskTab, showStudy } from './pages/DeskPage.jsx';
import SermonsPage from './pages/SermonsPage.jsx';
import SharedPage from './pages/SharedPage.jsx';
import { startCourse } from './pages/CoursesPage.jsx';
import { NewSermonDialog } from './components/SermonDialogs.jsx';
import { openSermonBuilder } from './components/SermonBuilder.jsx';
import BuilderPage from './components/BuilderPage.jsx';
import { useIdentityQuestion } from './components/IdentityDialogs.jsx';
import { BUILDER_TYPE, openBuilderPage } from './builderPages.js';
import { startStudy } from './components/StudyReview.jsx';
import QuickCapture, { recordVoiceMemo } from './components/QuickCapture.jsx';
import { openExport } from './components/ExportDialog.jsx';
import BackupRestoreDialog from './components/BackupRestoreDialog.jsx';
import { MergeDialog } from './components/NoteToolsDialogs.jsx';
import { ClipperDialog } from './components/ClipperSettings.jsx';
import Tour from './components/Tour.jsx';

function useTheme() {
  const [theme, setTheme] = useStoredState('noteapp.theme', 'system');
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    // The installed app's title bar follows the chosen theme too.
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      const dark = theme === 'system' ? meta.media.includes('dark') : theme === 'dark';
      meta.content = dark ? '#121921' : '#fbfaf7';
    }
  }, [theme]);
  return [theme, setTheme];
}

export default function App() {
  const [auth, setAuth] = useState('loading');
  const [passwordSet, setPasswordSet] = useState(true);
  const [signInName, setSignInName] = useState(false); // 10.0: the sign-in page asks for the username or email
  const [cert, setCert] = useState(null);
  const [signInNotice, setSignInNotice] = useState(null); // { failed, recoveryLeft } from signing in
  const themeState = useTheme();

  useEffect(() => {
    api.session()
      .then((s) => {
        setTimeZone(s.timeZone);
        setServerInfo(s);
        setPasswordSet(s.passwordSet);
        setSignInName(!!s.signInName);
        setCert(s.cert);
        setAuth(s.authenticated ? 'ok' : 'login');
      })
      .catch(() => setAuth('login'));
    const onUnauthorized = () => setAuth('login');
    window.addEventListener('noteapp:unauthorized', onUnauthorized);
    return () => window.removeEventListener('noteapp:unauthorized', onUnauthorized);
  }, []);

  // Signed out (or the session ran out): whether to ask for the username or email may have changed since the app opened.
  useEffect(() => {
    if (auth === 'login') api.session().then((s) => setSignInName(!!s.signInName)).catch(() => {});
  }, [auth]);

  if (auth === 'loading') return null;
  if (auth === 'login') return <Login passwordSet={passwordSet} signInName={signInName} cert={cert} onDone={(r) => { setSignInNotice(r); setAuth('ok'); }} />;
  return <Workspace themeState={themeState} cert={cert} signInNotice={signInNotice}
    onLogout={async () => { await api.logout().catch(() => {}); setAuth('login'); }} />;
}

const SECTIONS = ['dashboard', 'inbox', 'calendar', 'tasks', 'attendance', 'notebooks', 'tags', 'dailywalk', 'plans', 'prayer', 'scripture', 'wordpress', 'attachments', 'media', 'desk', 'sermons', 'shared', 'notes', 'build'];
// Pages focus mode keeps you on when it's turned on; from any other page it goes to Daily Walk.
const FOCUS_PAGES = ['dailywalk', 'plans', 'prayer', 'desk', 'sermons', 'scripture'];
// Studies and Courses became Desk's tabs in 5.14; old links and bookmarks still land there.
const OLD_SECTIONS = { studies: 'desk', courses: 'desk', library: 'dashboard' };
/**
 * 11.0: browser-style tabs. 10.x's tabs that were kept open (not previews) come along the first time, as tabs of
 * their own beside the main tab.
 */
const OLD_TABS = (() => {
  try {
    const old = JSON.parse(localStorage.getItem('noteapp.openTabs') ?? '[]');
    return Array.isArray(old) ? old.filter((t) => t?.id && !t.preview && t.kind !== 'book')
      .map((t, i) => ({ uid: `t${Date.now().toString(36)}${i}`, kind: t.kind, id: t.id, type: t.type, builder: t.builder, course: t.course, title: t.title ?? '', color: t.color, pinned: !!t.pinned })) : [];
  } catch { return []; }
})();
let tabSeq = 0;
const newUid = () => `t${Date.now().toString(36)}${(tabSeq += 1)}`;
/** Whether a tab shows the place you're at (a note, a builder, a study or course on Desk). */
const tabShows = (t, p) => !!p && ((t.kind === 'note' && p.note === t.id) || (t.kind === 'builder' && p.build?.id === t.id) || (t.kind === 'study' && p.study?.id === t.id)
  // 11.0: a page (the rail's, or a Utility page: Attachments, Tags, Media, Templates).
  || (t.kind === 'page' && (t.view ? p.view === t.view : !p.note && !p.study && !p.build && p.section === t.section && !p.view)));
const PAGE_NAMES = { dashboard: 'Home', calendar: 'Plan', tasks: 'Tasks', attendance: 'Attendance', inbox: 'Inbox', dailywalk: 'Daily Walk', plans: 'Reading plans', prayer: 'Prayer', scripture: 'Bible', desk: 'Desk', sermons: 'Preach', wordpress: 'WordPress site', attachments: 'Attachments', media: 'Media', tags: 'Tags', notebooks: 'Notebooks', shared: 'Shared with me', notes: 'My notes' };
const VIEW_NAMES = { templates: 'Templates', trash: 'Trash' };
const sameView = (a, b) => a.type === b.type && (a.id ?? null) === (b.id ?? null);
/** '#note/12' -> { section: 'notes', note: 12 }; '#build/sermon/12' -> a builder's page (10.0); '#calendar' -> { section: 'calendar' }. */
function parseHash() {
  const m = /^#note\/(\d+)$/.exec(location.hash);
  if (m) return { section: 'notes', note: Number(m[1]) };
  const b = /^#build\/(sermon|study|background|word|lesson)\/(\d+)$/.exec(location.hash);
  if (b) return { section: 'build', build: { builder: b[1], id: Number(b[2]) } };
  const s = OLD_SECTIONS[location.hash.slice(1)] ?? location.hash.slice(1);
  return SECTIONS.includes(s) && s !== 'build' ? { section: s } : null;
}

function Workspace({ themeState, cert, signInNotice, onLogout }) {
  const dialog = useDialog();
  useEffect(() => { installVerseCards(); installNoteCards(); }, []);
  // 10.0: a Selah from before usernames asks for one (and an email) once.
  useIdentityQuestion();
  // 7.3: once per browser, empty the cache of attachments kept for a year before (a reused attachment number could
  // show an old file; server/routes.js FILE_CACHE).
  useEffect(() => {
    const KEY = 'noteapp.cacheCleared';
    try {
      if (localStorage.getItem(KEY) === '7.3') return;
      fetch('/api/clear-cache', { cache: 'no-store' }).then((r) => r.ok && localStorage.setItem(KEY, '7.3')).catch(() => {});
    } catch { /* storage unavailable: nothing kept to clear */ }
  }, []);
  // Sensitive changes ask for the password (and code) again; see api.js.
  useEffect(() => {
    setConfirmIdentity(() => dialog.open((c) => <ConfirmIdentityDialog close={c} />));
    return () => setConfirmIdentity(null);
  }, [dialog]);
  // After signing in: failed attempts since last time, or recovery codes running low.
  useEffect(() => {
    if (signInNotice?.failed) {
      dialog.toast(`${signInNotice.failed} failed sign-in attempt${signInNotice.failed === 1 ? '' : 's'} since you last signed in. Settings → Security → Activity shows where from.`, 'error', 10000);
    }
    if (signInNotice?.recoveryLeft != null) {
      dialog.toast(`Recovery code used; ${signInNotice.recoveryLeft} left. If you've lost your phone, set up two-step sign-in again in Settings → Security.`, 'info', 10000);
    }
  }, [signInNotice, dialog]);
  const [theme, setTheme] = themeState;
  const [tree, setTree] = useState(null);
  const [view, setView] = useStoredState('noteapp.view', { type: 'all' });
  const [sort, setSort] = useStoredState('noteapp.sort', 'updated');
  // The tabs along the top (11.0: like a browser's): the main tab, then the ones opened in a new tab. See pickTab below.
  const [tabs, setTabs] = useStoredState('noteapp.tabs', OLD_TABS);
  const [activeUid, setActiveUid] = useState('main');
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState([]);
  // Opening the app (no #section in the address) always starts on Home (the 'dashboard' section); a reload keeps the page it was on.
  const [section, setSectionState] = useState(() => parseHash()?.section ?? 'dashboard');
  const [selectedId, setSelectedId] = useState(() => parseHash()?.note ?? null);
  // The builder open on the builder page (10.0): { id, builder, startAt? }.
  const [buildOpen, setBuildOpen] = useState(() => parseHash()?.build ?? null);
  const [editorEpoch, setEditorEpoch] = useState(0); // bumped to reload the open note (after restoring a version)
  const [headingTarget, setHeadingTarget] = useState(null); // { id, heading, n }: scroll the open note to a heading
  const [pane, setPane] = useState(() => (parseHash()?.note ? 'editor' : 'list')); // mobile layout
  // Full-screen note: the note list is hidden and the note fills the space next to the sidebar.
  const [fullNote, setFullNote] = useStoredState('noteapp.fullNote', false);
  const setSection = useCallback((s) => {
    setSectionState(s);
    setPane('list');
  }, []);

  // Keeps the tree object when nothing changed, so background checks don't re-render the app.
  const treeJson = useRef('');
  const applyTree = useCallback((t) => {
    const json = JSON.stringify(t);
    if (json === treeJson.current) return;
    treeJson.current = json;
    setTree(t);
  }, []);
  const refreshTree = useCallback(() => api.tree().then(applyTree).catch((e) => dialog.toast(e.message, 'error')), [dialog, applyTree]);
  const [pageEpoch, setPageEpoch] = useState(0); // bumped by Refresh to reload the open page
  // Turning on focus mode (or opening Selah in it) stays on Daily Walk, Prayer, Desk, Sermons or Scripture and otherwise
  // goes to Daily Walk (or the first page focus shows); turning it off goes to Home. After that, a hidden
  // page opened on purpose (Ctrl+K) stays open.
  const focus = useFocusMode();
  const [focusHidden] = useFocusPages();
  const [hiddenPages] = useHiddenPages();
  const [pageOrder] = usePageOrder();
  const sectionRef = useRef(section);
  sectionRef.current = section;
  const wasFocus = useRef(null);
  useEffect(() => {
    const was = wasFocus.current;
    wasFocus.current = focus;
    const unavailable = [...hiddenPages, ...(tree?.wordpress ? [] : ['wordpress'])];
    const firstShown = (out) => orderedPageKeys(pageOrder).find((k) => !out.includes(k)) ?? 'notes';
    if (!focus) {
      if (was) setSection(unavailable.includes('dashboard') ? firstShown(unavailable) : 'dashboard');
      return;
    }
    const out = [...unavailable, ...focusHidden];
    if (was === focus && !focusHidden.includes(sectionRef.current)) return; // only the focus pages changed
    if (FOCUS_PAGES.includes(sectionRef.current) && !out.includes(sectionRef.current)) return;
    setSection(out.includes('dailywalk') ? firstShown(out) : 'dailywalk');
  }, [focus, focusHidden]); // eslint-disable-line react-hooks/exhaustive-deps

  // Past 80% of a Bible translation's lookups (esv.js): the ESV's hourly or daily, the NLT's daily, API.Bible's monthly.
  useEffect(() => {
    const MESSAGES = {
      'ESV:day': 'Over 80% of today’s ESV lookups are used (5,000 a day).',
      'ESV:hour': 'Over 80% of this hour’s ESV lookups are used (1,000 an hour).',
      'NLT:day': 'Over 80% of today’s NLT lookups are used (5,000 a day).',
    };
    const onNear = (e) => {
      const { limit, translation } = e.detail ?? {};
      const message = MESSAGES[`${translation}:${limit}`] ?? `Over 80% of this month’s API.Bible lookups are used (5,000 a month, for ${translation} and your other API.Bible translations).`;
      dialog.toast(`${message} Passages already looked up still work. Usage: Settings → Connections → Bible.`, 'info', 9000);
    };
    window.addEventListener('noteapp:esv-near-limit', onNear);
    return () => window.removeEventListener('noteapp:esv-near-limit', onNear);
  }, [dialog]);
  // Connecting or disconnecting WordPress adds or removes its page in the sidebar.
  useEffect(() => {
    window.addEventListener('noteapp:wordpress', refreshTree);
    return () => window.removeEventListener('noteapp:wordpress', refreshTree);
  }, [refreshTree]);

  const listParams = useMemo(() => {
    const p = { sort, q: query };
    if (view.type === 'all') p.mynotes = 1; // 10.1: My notes, everything but the Inbox
    if (view.type === 'files') { p.mynotes = 1; p.files = 1; }
    if (view.type === 'notebook') p.notebook = view.id;
    if (view.type === 'stack') p.stack = view.id;
    if (view.type === 'tag') p.tag = view.id;
    if (view.type === 'templates') p.templates = 1;
    if (view.type === 'untagged') p.untagged = 1;
    if (view.type === 'trash') p.trash = 1;
    return p;
  }, [view, sort, query]);

  const refreshNotes = useCallback(() => api.listNotes(listParams).then((list) => {
    setNotes(list);
    return list;
  }).catch((e) => dialog.toast(e.message, 'error')), [listParams, dialog]);

  useEffect(() => { refreshTree(); }, [refreshTree]);
  // Signed in on the way to a page of its own (the phone remote): go back to it.
  useEffect(() => {
    try {
      const to = sessionStorage.getItem('noteapp.afterSignIn');
      if (!to) return;
      sessionStorage.removeItem('noteapp.afterSignIn');
      location.replace(to);
      location.reload();
    } catch { /* storage unavailable */ }
  }, []);

  // Notes can arrive from outside this window (the web clipper, email, another device). The server says so live
  // (live.js); the counts and the note list are also checked when the app comes back into view and every minute.
  const listParamsRef = useRef(listParams);
  listParamsRef.current = listParams;
  useEffect(() => {
    let last = Date.now();
    const notesJson = { current: '' };
    const check = (force) => {
      if (document.visibilityState !== 'visible' || (!force && Date.now() - last < 2_000)) return;
      last = Date.now();
      api.tree().then(applyTree).catch(() => {});
      const params = listParamsRef.current;
      api.listNotes(params).then((list) => {
        const json = JSON.stringify(list);
        if (params !== listParamsRef.current || json === notesJson.current) return;
        notesJson.current = json;
        setNotes(list);
      }).catch(() => {});
    };
    const onShow = () => check(false);
    // A live message (a change anywhere: this window, another device, the clipper) checks again right away.
    // Several changes in a row (a bulk edit) make one check.
    let soon = null;
    const onLive = () => {
      clearTimeout(soon);
      soon = setTimeout(() => { last = 0; check(true); }, 300);
    };
    startLive();
    startReminders();
    const timer = setInterval(() => check(true), 60_000);
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    window.addEventListener('noteapp:live', onLive);
    window.addEventListener('noteapp:live-reconnect', onLive);
    return () => {
      clearInterval(timer);
      clearTimeout(soon);
      stopLive();
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onShow);
      window.removeEventListener('noteapp:live', onLive);
      window.removeEventListener('noteapp:live-reconnect', onLive);
    };
  }, [applyTree]);

  // The sidebar's Refresh button reloads the counts, the note list and the open page without reloading the whole
  // app (the installed app has no reload button), so an open note keeps any typing in progress.
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshTree(), refreshNotes()]);
    setPageEpoch((n) => n + 1);
    dialog.toast('Refreshed');
  }, [refreshTree, refreshNotes, dialog]);

  useEffect(() => {
    const t = setTimeout(refreshNotes, query ? 200 : 0);
    return () => clearTimeout(t);
  }, [refreshNotes, query]);

  // If the current view points at something that was deleted, fall back to All notes.
  useEffect(() => {
    if (!tree) return;
    // 10.1: notebooks and shelves are no longer views of their own; they open My notes.
    const gone = view.type === 'notebook' || view.type === 'stack'
      || (view.type === 'tag' && !tree.tags.some((t) => t.id === view.id));
    if (gone) setView({ type: 'all' });
  }, [tree, view, setView]);

  // Select the first note when nothing is selected (desktop).
  useEffect(() => {
    if (section === 'notes' && selectedId == null && notes.length && window.innerWidth > 800) setSelectedId(notes[0].id);
  }, [notes, selectedId, section]);

  // Keep the section / note in the URL (#calendar, #note/12) so it can be bookmarked or linked.
  useEffect(() => {
    const want = section === 'build' ? (buildOpen ? `#build/${buildOpen.builder}/${buildOpen.id}` : '#dashboard')
      : section !== 'notes' ? `#${section}` : selectedId ? `#note/${selectedId}` : '#notes';
    if (location.hash !== want) history.replaceState(null, '', want);
  }, [section, selectedId, buildOpen]);
  useEffect(() => {
    const onHash = () => {
      const h = parseHash();
      if (!h) return;
      if (h.build) setBuildOpen(h.build);
      setSectionState(h.section);
      if (!h.note && !h.build && location.hash !== `#${h.section}`) history.replaceState(null, '', `#${h.section}`); // #studies -> #desk
      if (h.note) { setSelectedId(h.note); setPane('editor'); setFullNote(true); } // a link to a note opens it in full view
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const select = (id) => { setSelectedId(id); setPane('editor'); };
  const changeView = (v) => {
    setSection('notes');
    setView(v);
    setQuery('');
    // Clear the old list so the first note of the *new* view gets auto-selected once it loads.
    if (!sameView(v, view)) setNotes([]);
    setSelectedId(null);
    setPane('list');
    setFullNote(false); // picking a notebook, tag etc. means you want to see its list
  };
  // The Scripture page, optionally searching a passage (e.g. from a reference in a note).
  const [scriptureQuery, setScriptureQuery] = useState(null);
  const openScripture = (q) => { setScriptureQuery(q ?? null); setSection('scripture'); };

  // A note opened over the current page (from a study) instead of leaving it. Resolves when it closes.
  const [peek, setPeek] = useState(null); // { id, heading, n }
  const peekDone = useRef(null);
  const peekNote = useCallback((id, heading = null) => new Promise((done) => {
    peekDone.current?.();
    peekDone.current = done;
    setPeek({ id, heading, n: Date.now() });
  }), []);
  const closePeek = useCallback(() => {
    setPeek(null);
    const done = peekDone.current;
    peekDone.current = null;
    done?.();
  }, []);

  // Open a note from the dashboard, calendar or tasks.
  // Opened from anywhere but the note list (dashboard, Ctrl+K, links, studies…), a note opens in full view.
  const openNote = (id) => {
    closePeek();
    setFullNote(true);
    setSection('notes');
    setView({ type: 'all' });
    setQuery('');
    setSelectedId(id);
    setPane('editor');
  };

  /**
   * 10.1: a new note goes to My notes. Made while a tag is open, it gets that tag and the list stays on it;
   * from anywhere else, My notes opens. (Captures land in the Inbox instead.)
   */
  const newNote = async (notebookId) => {
    if (!notebookId && view.type === 'templates') return newTemplate();
    const nb = notebookId ?? tree.myNotes ?? tree.notebooks[0]?.id;
    if (!nb) return dialog.toast('Create a notebook first', 'error');
    const { id } = await api.createNote(nb);
    const tag = section === 'notes' && view.type === 'tag' ? tree.tags.find((t) => t.id === view.id) : null;
    if (tag) await api.updateNote(id, { tags: [tag.name] });
    setSection('notes');
    if (!tag && view.type !== 'all') setView({ type: 'all' });
    setQuery('');
    await refreshNotes();
    refreshTree();
    select(id);
  };

  const newTemplate = async () => {
    const nb = tree.myNotes ?? tree.notebooks[0]?.id;
    if (!nb) return dialog.toast('Create a notebook first', 'error');
    const { id } = await api.createNote(nb);
    await api.updateNote(id, { is_template: 1 });
    await refreshNotes();
    refreshTree();
    select(id);
  };

  /** Show a note that was just made (a duplicate or from a template), switching to its notebook if needed. */
  const showCreated = (id, { notebook_id: nb, is_template: template }) => {
    setSection('notes');
    const visible = template ? view.type === 'templates' : view.type === 'all' && nb !== tree.inbox?.id;
    if (!visible) setView(template ? { type: 'templates' } : { type: 'all' });
    setQuery('');
    refreshNotes();
    refreshTree();
    select(id);
  };
  // The notebook you're in, to suggest for a note from a template.
  const currentNotebook = () => (section === 'notes' && view.type === 'notebook' ? view.id : undefined);

  // Live updates from the editor (title/snippet) without refetching.
  const onChanged = useCallback((id, patch) => {
    setNotes((list) => list.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    // A title typed in the editor reaches its tab too.
    if ('title' in patch) setTabs((list) => (list.some((t) => t.kind === 'note' && t.id === id && t.title !== patch.title) ? list.map((t) => (t.kind === 'note' && t.id === id ? { ...t, title: patch.title } : t)) : list));
  }, [setTabs]);

  const onSaved = useCallback((id, patch) => {
    setNotes((list) => {
      let next = list.map((n) => (n.id === id ? { ...n, ...patch } : n));
      if (patch.updated_at && sort === 'updated') {
        const item = next.find((n) => n.id === id);
        if (item && !item.pinned) next = [...next.filter((n) => n.pinned), item, ...next.filter((n) => !n.pinned && n.id !== id)];
      }
      if ('notebook_id' in patch && view.type === 'notebook' && patch.notebook_id !== view.id) {
        next = next.filter((n) => n.id !== id);
      }
      return next;
    });
    if ('tags' in patch || 'notebook_id' in patch) refreshTree();
    if ('pinned' in patch) refreshNotes();
    if ('is_template' in patch) { refreshNotes(); refreshTree(); }
    if ('tags' in patch) refreshNotes(); // the list shows each note's tags
  }, [sort, view, refreshTree, refreshNotes]);

  const noteActions = useNoteActions({ tree, onChange: onSaved, onCreated: showCreated });

  // ---- multi-select: Ctrl/⌘-click toggles, Shift-click selects a range, "Select" mode makes taps toggle ----
  const [checked, setChecked] = useState(() => new Set());
  const [selectMode, setSelectMode] = useState(false);
  const anchor = useRef(null);
  const clearChecked = useCallback(() => { setChecked(new Set()); setSelectMode(false); }, []);
  useEffect(() => { clearChecked(); }, [view, clearChecked]);
  useEffect(() => {
    if (!checked.size && !selectMode) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.modal-backdrop, .context-menu')) clearChecked();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [checked, selectMode, clearChecked]);

  const clickNote = (id, e) => {
    const from = anchor.current ?? selectedId;
    if (e?.shiftKey && from != null) {
      const ids = notes.map((n) => n.id);
      const a = ids.indexOf(from);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        setChecked(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)));
        return;
      }
    }
    anchor.current = id;
    if (e?.ctrlKey || e?.metaKey || selectMode) {
      // Only notes you click are selected (the open note may have been opened for you, e.g. the first in the Trash).
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      return;
    }
    if (checked.size) setChecked(new Set());
    select(id);
  };

  const checkedNotes = notes.filter((n) => checked.has(n.id));
  const plural = (n) => `${n} note${n === 1 ? '' : 's'}`;
  /** Runs fn on each selected note, then clears the selection and refreshes. */
  const runBulk = async (fn, done) => {
    const list = checkedNotes;
    let ok = 0;
    try {
      for (const n of list) { await fn(n); ok += 1; }
      if (done) dialog.toast(done(plural(ok)));
    } catch (e) {
      dialog.toast(`${e.message} (${ok} of ${list.length} done)`, 'error');
    }
    clearChecked();
    refreshNotes();
    refreshTree();
    return list;
  };
  const leaves = (list) => { if (list.some((n) => n.id === selectedId)) setSelectedId(null); };
  const bulk = {
    move: async () => {
      const into = await dialog.choose({
        title: `Move ${plural(checkedNotes.length)} to…`,
        options: tree.notebooks.map((nb) => ({ value: nb.id, label: nb.name })),
        okLabel: 'Move',
      });
      if (!into) return;
      await runBulk((n) => api.updateNote(n.id, { notebook_id: into }), (c) => `Moved ${c} to ${notebookName(into)}`);
      if (selectedId && checked.has(selectedId)) { const id = selectedId; setSelectedId(null); setTimeout(() => setSelectedId(id)); }
    },
    tag: async () => {
      const r = await dialog.open((close) => <BulkTagDialog count={checkedNotes.length} tags={tree.tags} close={close} />);
      if (!r) return;
      const ids = checkedNotes.map((n) => n.id);
      const tag = tree.tags.find((t) => t.name.toLowerCase() === r.name.toLowerCase());
      try {
        await api.applyTag(r.remove ? { tag_id: tag.id, remove: ids } : { ...(tag ? { tag_id: tag.id } : { name: r.name }), add: ids });
        dialog.toast(`${r.remove ? 'Removed' : 'Added'} #${tag?.name ?? r.name} ${r.remove ? 'from' : 'to'} ${plural(ids.length)}`);
      } catch (e) {
        dialog.toast(e.message, 'error');
      }
      clearChecked();
      refreshNotes();
      refreshTree();
      // The open note's tag box reloads with the note.
      if (selectedId && ids.includes(selectedId)) { const id = selectedId; setSelectedId(null); setTimeout(() => setSelectedId(id)); }
    },
    patch: (patch, done) => runBulk((n) => api.updateNote(n.id, patch), done)
      .then((list) => { if ('is_template' in patch) leaves(list); }),
    trash: () => runBulk((n) => api.trashNote(n.id), (c) => `${c} moved to Trash`).then(leaves),
    restore: () => restoreMany(checkedNotes.map((n) => n.id)),
    restoreTo: async () => {
      const into = await dialog.choose({
        title: `Restore ${plural(checkedNotes.length)} to…`,
        options: tree.notebooks.map((nb) => ({ value: nb.id, label: nb.name })),
        okLabel: 'Restore',
      });
      if (into) restoreMany(checkedNotes.map((n) => n.id), into);
    },
    export: () => openExport(dialog, {
      scope: { notes: checkedNotes.map((n) => n.id) }, title: plural(checkedNotes.length),
      word: { noteIds: checkedNotes.map((n) => n.id) },
    }),
    merge: async () => {
      const id = await dialog.open((close) => <MergeDialog notes={checkedNotes} tree={tree} close={close} />);
      if (!id) return;
      dialog.toast(`Merged ${plural(checkedNotes.length)} into one`);
      clearChecked();
      refreshTree();
      await refreshNotes();
      setSelectedId(id);
      setPane('editor');
    },
    deleteForever: async () => {
      const ok = await dialog.confirm({
        title: `Delete ${plural(checkedNotes.length)} forever?`,
        message: 'They and their attachments will be permanently deleted. This cannot be undone.',
        okLabel: 'Delete forever', danger: true,
      });
      if (ok) runBulk((n) => api.deleteNoteForever(n.id), (c) => `${c} deleted`).then(leaves);
    },
  };
  /** Actions for the selected notes (the selection bar's ⋯ menu and the right-click menu). */
  const bulkItems = () => {
    const c = plural(checkedNotes.length);
    if (view.type === 'trash') {
      return [
        { label: `Restore ${c}`, onClick: bulk.restore },
        'sep',
        { label: `Delete ${c} forever…`, danger: true, onClick: bulk.deleteForever },
      ];
    }
    if (view.type === 'templates') {
      return [
        { label: 'Stop using as templates', onClick: () => bulk.patch({ is_template: 0 }, (n) => `${n} back in their notebooks`) },
        'sep',
        { label: `Move ${c} to Trash`, danger: true, onClick: bulk.trash },
      ];
    }
    return [
      { label: 'Tag…', onClick: bulk.tag },
      'sep',
      checkedNotes.length > 1 && { label: `Merge ${c} into one…`, onClick: bulk.merge },
      { label: `Export ${c}…`, onClick: bulk.export },
      'sep',
      { label: 'Pin to top of the list', onClick: () => bulk.patch({ pinned: 1 }, (n) => `Pinned ${n}`) },
      { label: 'Unpin from top of the list', onClick: () => bulk.patch({ pinned: 0 }, (n) => `Unpinned ${n}`) },
      { label: 'Pin to Home', onClick: () => bulk.patch({ dash_pinned: 1 }, (n) => `${n} pinned to Home`) },
      { label: 'Remove from dashboard', onClick: () => bulk.patch({ dash_pinned: 0 }, (n) => `${n} removed from the dashboard`) },
      'sep',
      { label: 'Make into templates', onClick: () => bulk.patch({ is_template: 1 }, (n) => `${n} moved to Templates`) },
      'sep',
      { label: `Move ${c} to Trash`, danger: true, onClick: bulk.trash },
    ];
  };

  // After a note leaves the list: if it was the open one, open its neighbour instead.
  const selectNeighbor = (id) => {
    if (id !== selectedId) return;
    const i = notes.findIndex((n) => n.id === id);
    const next = notes[i + 1] ?? notes[i - 1];
    setSelectedId(next ? next.id : null);
    if (!next) setPane('list');
  };

  const trash = async (id) => {
    await api.trashNote(id);
    setTabs((l) => l.filter((t) => !(t.kind === 'note' && t.id === id)));
    selectNeighbor(id);
    dialog.toast('Note moved to Trash');
    refreshNotes(); refreshTree();
  };
  /** Out of the Trash, to where they were (a deleted notebook is made again) or into `into`. */
  const restoreMany = async (ids, into = null) => {
    try {
      const r = await api.restoreNotes(ids, into);
      dialog.toast(`${plural(r.count)} restored`);
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
    if (ids.includes(selectedId)) setSelectedId(null);
    clearChecked();
    refreshNotes(); refreshTree();
  };
  const restore = async (id) => {
    await api.restoreNote(id);
    selectNeighbor(id);
    dialog.toast('Note restored');
    refreshNotes(); refreshTree();
  };
  const restoreFromBackup = async () => {
    const r = await dialog.open((close) => <BackupRestoreDialog tree={tree} close={close} />);
    if (!r) return;
    refreshTree();
    refreshNotes();
  };
  const deleteForever = async (id) => {
    const ok = await dialog.confirm({
      title: 'Delete note forever?', message: 'This note and its attachments will be permanently deleted. This cannot be undone.',
      okLabel: 'Delete forever', danger: true,
    });
    if (!ok) return;
    await api.deleteNoteForever(id);
    selectNeighbor(id);
    refreshNotes(); refreshTree();
  };
  const emptyTrash = async () => {
    const ok = await dialog.confirm({
      title: 'Empty trash?', message: `Permanently delete ${notes.length} note${notes.length === 1 ? '' : 's'} and their attachments? This cannot be undone.`,
      okLabel: 'Empty trash', danger: true,
    });
    if (!ok) return;
    await api.emptyTrash();
    setSelectedId(null);
    refreshNotes(); refreshTree();
  };
  const moveNote = async (noteId, notebookId) => {
    try {
      await api.updateNote(noteId, { notebook_id: notebookId });
      const nb = tree.notebooks.find((n) => n.id === notebookId);
      dialog.toast(`Moved to ${nb?.name ?? 'notebook'}`);
      refreshNotes(); refreshTree();
      // Re-mount the editor so its notebook selector reflects the move.
      if (noteId === selectedId) { setSelectedId(null); setTimeout(() => setSelectedId(noteId)); }
    } catch (e) {
      dialog.toast(e.message, 'error');
    }
  };

  // After an import: refresh, and open the notebook the notes went into when we know it.
  const onImported = async (notebookId) => {
    await refreshTree();
    if (notebookId) changeView({ type: 'all' }); // 10.1: imports land in My notes, tagged
    else refreshNotes();
  };
  const openSettings = () => dialog.open((close) => (
    <SettingsDialog theme={theme} onTheme={setTheme} cert={cert} tree={tree} onImported={onImported}
      onLogout={onLogout} close={close} />
  ));

  const notebookName = useCallback((id) => tree?.notebooks.find((n) => n.id === id)?.name, [tree]);

  // The open note goes to the top of the palette's "Recent notes".
  const openTitle = notes.find((n) => n.id === selectedId)?.title;
  // The notes list's name (My notes, a tag, Templates…), for the list and the main tab.
  const title = {
    all: 'My notes',
    files: 'Notes with files',
    trash: 'Trash',
    templates: 'Templates',
    untagged: 'Untagged notes',
    notebook: tree?.notebooks.find((n) => n.id === view.id)?.name,
    stack: tree?.stacks.find((x) => x.id === view.id)?.name,
    tag: `#${tree?.tags.find((t) => t.id === view.id)?.name ?? ''}`,
  }[view.type] ?? 'Notes';
  useEffect(() => {
    if (section === 'notes' && selectedId && openTitle !== undefined) rememberNote(selectedId, openTitle);
  }, [section, selectedId, openTitle]);

  // Something shared with me, open on its page (8.0): { id, key } (key: the note in a notebook or project).
  const [sharedOpen, setSharedOpen] = useStoredState('noteapp.sharedOpen', null);
  const [deskOpen, setDeskOpen] = useState(null); // { id, course, title, color } while a study or course is open on Desk
  useEffect(() => {
    // Desk says which study is open; the editor says what kind of note it has (a lesson, sermon or Bible study).
    const onDesk = (e) => setDeskOpen(e.detail);
    const onKind = (e) => setTabs((l) => (l.some((t) => t.kind === 'note' && t.id === e.detail.id && (t.type !== e.detail.type || (e.detail.title && t.title !== e.detail.title)))
      ? l.map((t) => (t.kind === 'note' && t.id === e.detail.id ? { ...t, type: e.detail.type, title: e.detail.title || t.title } : t)) : l));
    window.addEventListener('noteapp:desk-open', onDesk);
    window.addEventListener('noteapp:note-kind', onKind);
    return () => { window.removeEventListener('noteapp:desk-open', onDesk); window.removeEventListener('noteapp:note-kind', onKind); };
  }, [setTabs]);

  // ---- 9.2: Back and Forward: the places you've been (a page, a note, a study on Desk, a passage on the Bible page,
  // a notebook's list), up to fifty, with the arrows in the top bar, Alt+← / Alt+→ and the mouse's side buttons. ----
  // (A notes list with nothing chosen isn't a place: the first note is chosen at once.)
  const utilView = section === 'notes' && ['templates', 'trash'].includes(view.type) ? view.type : null;
  const place = section === 'notes' ? (selectedId ? { k: `n${selectedId}`, note: selectedId, ...(utilView ? { view: utilView } : {}) } : utilView ? { k: `v${utilView}`, section, view: utilView } : null)
    : section === 'build' ? (buildOpen ? { k: `w${buildOpen.id}`, build: buildOpen } : null)
    : section === 'desk' ? (deskOpen ? { k: `s${deskOpen.id}`, study: deskOpen } : { k: 'desk', section })
      : section === 'scripture' ? { k: `b${scriptureQuery ?? ''}`, scripture: scriptureQuery ?? null }
        : { k: section, section };
  const navHistory = useRef({ list: [], at: -1 });
  const [, setHistoryTick] = useState(0);
  useEffect(() => {
    const h = navHistory.current;
    if (!place || h.list[h.at]?.k === place.k) return; // where Back or Forward just went
    h.list = [...h.list.slice(0, h.at + 1), place].slice(-50);
    h.at = h.list.length - 1;
    setHistoryTick((n) => n + 1);
  }, [place?.k]); // eslint-disable-line react-hooks/exhaustive-deps
  const goPlace = (p) => {
    closePeek();
    if (p.note) openNote(p.note);
    else if (p.build) openBuilderPage(p.build.id, p.build.builder);
    else if (p.study) window.dispatchEvent(new CustomEvent(p.study.course ? 'noteapp:show-course' : 'noteapp:show-study', { detail: p.study.id }));
    else if ('scripture' in p) openScripture(p.scripture);
    else if (p.view) changeView({ type: p.view });
    else if (p.section === 'desk') { showDeskTab(JSON.parse(localStorage.getItem('noteapp.deskTab') ?? '"study"')); setSection('desk'); }
    else setSection(p.section);
  };
  const step = (by) => {
    const h = navHistory.current;
    const to = h.at + by;
    if (to < 0 || to >= h.list.length) return;
    h.at = to;
    setHistoryTick((n) => n + 1);
    goPlace(h.list[to]);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const onKey = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      stepRef.current(e.key === 'ArrowLeft' ? -1 : 1);
    };
    // The mouse's side buttons (3 back, 4 forward) would otherwise leave Selah in a browser.
    const onMouse = (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.type === 'mouseup') stepRef.current(e.button === 3 ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);
  // ---- 11.0: tabs work like a browser's. The main tab follows you around the app (the rail, links, Back). A note,
  // study or course opens in a tab of its own only when you ask (Open in new tab, Ctrl-click, a middle click), and
  // what you open while in that tab opens there. A builder always has its own tab; leaving it for a page (the rail)
  // goes back to the main tab and leaves the builder open. ----
  const mainPlace = useRef(null); // where the main tab was, while another tab is in front
  const [mainLabel, setMainLabel] = useState('Home');
  const expect = useRef(null); // { uid, at }: a tab that was just picked, until its page has opened
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const placeLabel = (p) => (p.note ? (openTitle || 'Untitled') : p.study ? (p.study.title || 'Study') : 'scripture' in p ? (p.scripture ? `Bible · ${p.scripture}` : 'Bible')
    : section === 'notes' ? title : PAGE_NAMES[p.section] ?? 'Selah');
  useEffect(() => {
    if (!place) return;
    const list = tabsRef.current;
    // A builder always has a tab of its own (the one it had, or a new one).
    if (place.build) {
      if (expect.current?.uid === 'main' && Date.now() - expect.current.at < 2500) return; // the builder is closing
      const t = list.find((x) => x.kind === 'builder' && x.id === place.build.id);
      if (t) { if (activeUid !== t.uid) setActiveUid(t.uid); return; }
      const uid = newUid();
      setTabs((l) => [...l, { uid, kind: 'builder', type: BUILDER_TYPE[place.build.builder] ?? 'study', id: place.build.id, builder: place.build.builder, title: '' }]);
      setActiveUid(uid);
      return;
    }
    if (activeUid === 'main') {
      expect.current = null;
      mainPlace.current = place;
      setMainLabel(placeLabel(place));
      return;
    }
    const tab = list.find((x) => x.uid === activeUid);
    if (!tab) { setActiveUid('main'); return; }
    if (tabShows(tab, place)) { expect.current = null; return; }
    if (expect.current?.uid === tab.uid && Date.now() - expect.current.at < 2500) return; // still opening
    expect.current = null;
    // Another note or study opened from this tab opens in it; anything else (a page) is the main tab's.
    if (!tab.pinned && tab.kind === 'note' && place.note) setTabs((l) => l.map((x) => (x.uid === tab.uid ? { ...x, id: place.note, type: 'note', title: openTitle ?? '' } : x)));
    else if (!tab.pinned && tab.kind === 'study' && place.study) setTabs((l) => l.map((x) => (x.uid === tab.uid ? { ...x, id: place.study.id, course: !!place.study.course, title: place.study.title ?? '', color: place.study.color } : x)));
    else {
      setActiveUid('main');
      mainPlace.current = place;
      setMainLabel(placeLabel(place));
    }
  }, [place?.k, activeUid]); // eslint-disable-line react-hooks/exhaustive-deps
  // The main tab's name follows what it shows (a note's title as you type it).
  useEffect(() => { if (activeUid === 'main' && place && !place.build) setMainLabel(placeLabel(place)); }, [openTitle, deskOpen?.title, title]); // eslint-disable-line react-hooks/exhaustive-deps
  // A note or study tab's title follows its note or study.
  useEffect(() => {
    if (activeUid === 'main') return;
    const name = section === 'notes' && selectedId ? openTitle : section === 'desk' && deskOpen ? deskOpen.title : undefined;
    if (name === undefined) return;
    const holds = (x) => (x.kind === 'note' && x.id === selectedId) || (x.kind === 'study' && x.id === deskOpen?.id);
    setTabs((l) => (l.some((x) => x.uid === activeUid && holds(x) && x.title !== name) ? l.map((x) => (x.uid === activeUid && holds(x) ? { ...x, title: name ?? '', ...(deskOpen && x.kind === 'study' ? { color: deskOpen.color } : {}) } : x)) : l));
  }, [activeUid, openTitle, deskOpen?.title, deskOpen?.color]); // eslint-disable-line react-hooks/exhaustive-deps
  // A builder's tab is named after its note.
  useEffect(() => {
    if (section !== 'build' || !buildOpen) return undefined;
    const { id } = buildOpen;
    const named = () => api.getNote(id).then((n) => setTabs((l) => (l.some((t) => t.kind === 'builder' && t.id === id && t.title !== (n.title ?? ''))
      ? l.map((t) => (t.kind === 'builder' && t.id === id ? { ...t, title: n.title ?? '' } : t)) : l))).catch(() => {});
    named();
    window.addEventListener('noteapp:notes-changed', named);
    return () => window.removeEventListener('noteapp:notes-changed', named);
  }, [section, buildOpen?.id, setTabs]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Shows what a tab holds. */
  const showTab = (t) => {
    if (t.kind === 'note') openNote(t.id);
    else if (t.kind === 'builder') openBuilderPage(t.id, t.builder);
    else if (t.kind === 'page') goPlace(t.view ? { section: 'notes', view: t.view } : { section: t.section });
    else window.dispatchEvent(new CustomEvent(t.course ? 'noteapp:show-course' : 'noteapp:show-study', { detail: t.id }));
  };
  const pickMain = () => {
    if (activeUid === 'main') return;
    expect.current = { uid: 'main', at: Date.now() };
    setActiveUid('main');
    closePeek();
    const p = mainPlace.current;
    if (p) goPlace(p); else setSection('dashboard');
  };
  const pickTab = (t) => {
    if (t === 'main' || t.uid === 'main') { pickMain(); return; }
    if (t.uid === activeUid) return;
    expect.current = { uid: t.uid, at: Date.now() };
    setActiveUid(t.uid);
    showTab(t);
  };
  /**
   * Opens a note, study, course or page in a new tab, in front. detail: { kind: 'note' | 'study', id, course?, title? }
   * or { kind: 'page', section, view? } (11.0: a rail page, or a Utility page: view 'templates' or 'trash'). With
   * `pinned`, the tab is pinned.
   */
  const openInNewTab = (d) => {
    const uid = newUid();
    const t = d.kind === 'page'
      ? { uid, kind: 'page', section: d.view ? 'notes' : d.section, view: d.view, type: 'page', title: d.title ?? (d.view ? VIEW_NAMES[d.view] : PAGE_NAMES[d.section]) ?? 'Page', pinned: !!d.pinned }
      : { uid, kind: d.kind === 'study' ? 'study' : 'note', id: d.id, course: !!d.course, type: d.kind === 'study' ? (d.course ? 'course' : 'desk') : 'note', title: d.title ?? '', pinned: !!d.pinned };
    setTabs((l) => (t.pinned ? [...l.filter((x) => x.pinned), t, ...l.filter((x) => !x.pinned)] : [...l, t]));
    expect.current = { uid, at: Date.now() };
    setActiveUid(uid);
    showTab(t);
  };
  const openInNewTabRef = useRef(openInNewTab);
  openInNewTabRef.current = openInNewTab;
  useEffect(() => {
    const on = (e) => { if (e.detail?.id || e.detail?.kind === 'page') openInNewTabRef.current(e.detail); };
    window.addEventListener('noteapp:open-tab', on);
    return () => window.removeEventListener('noteapp:open-tab', on);
  }, []);
  /** Closes the tabs `which` picks; if the one in front goes, the tab to its left (or the main tab) comes forward. */
  const closeTabs = (which) => {
    const gone = tabs.filter(which);
    if (!gone.length) return;
    const rest = tabs.filter((x) => !which(x));
    setTabs(rest);
    if (!gone.some((x) => x.uid === activeUid)) return;
    const at = tabs.findIndex((x) => x.uid === activeUid);
    // A builder goes back to the main tab (where you opened it from); another tab gives way to the one on its left.
    const left = tabs[at]?.kind === 'builder' ? null : tabs.slice(0, at).reverse().find((x) => rest.includes(x));
    if (left) pickTab(left); else pickMain();
  };
  const closeTab = (t) => closeTabs((x) => x.uid === t.uid);
  const setTabPinned = (t, pinned) => setTabs((list) => {
    const next = list.map((x) => (x.uid === t.uid ? { ...x, pinned } : x));
    return [...next.filter((x) => x.pinned), ...next.filter((x) => !x.pinned)];
  });
  const pageOf = (p) => (p.view ? { kind: 'page', view: p.view } : { kind: 'page', section: p.section });
  const mainTab = { uid: 'main', main: true, title: mainLabel, type: section === 'notes' ? 'note' : 'page' };
  const tabMenu = (t) => {
    if (t.main) {
      const p = activeUid === 'main' ? place : mainPlace.current;
      return [
        p?.note && { label: 'Open in new tab', onClick: () => openInNewTab({ kind: 'note', id: p.note, title: mainLabel }) },
        p?.study && { label: 'Open in new tab', onClick: () => openInNewTab({ kind: 'study', id: p.study.id, course: p.study.course, title: p.study.title }) },
        p && !p.note && !p.study && !p.build && !('scripture' in p) && { label: 'Open in new tab', onClick: () => openInNewTab(pageOf(p)) },
        p && !p.build && !('scripture' in p) && { label: 'Pin this as a tab', onClick: () => openInNewTab({ ...(p.note ? { kind: 'note', id: p.note, title: mainLabel } : p.study ? { kind: 'study', id: p.study.id, course: p.study.course, title: p.study.title } : pageOf(p)), pinned: true }) },
        tabs.some((x) => !x.pinned) && { label: 'Close all other tabs', onClick: () => closeTabs((x) => !x.pinned) },
      ].filter(Boolean);
    }
    const at = tabs.findIndex((x) => x.uid === t.uid);
    return [
      { label: t.pinned ? 'Unpin tab' : 'Pin tab', onClick: () => setTabPinned(t, !t.pinned) },
      'sep',
      { label: 'Close', onClick: () => closeTab(t) },
      { label: 'Close others', onClick: () => closeTabs((x) => x.uid !== t.uid && !x.pinned) },
      { label: 'Close to the right', onClick: () => closeTabs((x) => tabs.indexOf(x) > at && !x.pinned) },
      { label: 'Close all but pinned', onClick: () => closeTabs((x) => !x.pinned) },
    ];
  };
  // A builder's ✕ (or Save and close): its tab closes, and the main tab comes back.
  const closeBuilder = (id) => {
    setTabs((l) => l.filter((x) => !(x.kind === 'builder' && x.id === id)));
    pickMain();
  };
  const nav = { canBack: navHistory.current.at > 0, canForward: navHistory.current.at < navHistory.current.list.length - 1, back: () => step(-1), forward: () => step(1) };

  // Links between notes and the connections panel open notes through an event.
  const openNoteRef = useRef(null);
  openNoteRef.current = openNote;
  useEffect(() => {
    // detail: a note id, or { id, heading } to open it at a heading.
    const onOpen = (e) => {
      const d = typeof e.detail === 'object' ? e.detail : { id: e.detail };
      openNoteRef.current(d.id);
      if (d.heading) setHeadingTarget({ id: d.id, heading: d.heading, n: Date.now() });
    };
    const onShowStudy = (e) => {
      closePeek();
      showStudy(e.detail);
      setSection('desk');
    };
    window.addEventListener('noteapp:show-study', onShowStudy);
    const onShowCourse = (e) => {
      closePeek();
      showCourse(e.detail);
      setSection('desk');
    };
    window.addEventListener('noteapp:show-course', onShowCourse);
    // A clicked reminder opens its page (Tasks or Calendar).
    const onShowSection = (e) => { closePeek(); setActiveUid('main'); setSection(OLD_SECTIONS[e.detail] ?? e.detail); };
    window.addEventListener('noteapp:show-section', onShowSection);
    // A passage on the Bible page, in the main tab (the tour, links from other pages).
    const onOpenScripture = (e) => { closePeek(); setActiveUid('main'); setScriptureQuery(e.detail ?? null); setSection('scripture'); };
    window.addEventListener('noteapp:open-scripture', onOpenScripture);
    const onOpenShared = (e) => { closePeek(); setSharedOpen({ id: e.detail.id, key: e.detail.key ?? null }); setSection('shared'); };
    window.addEventListener('noteapp:open-shared', onOpenShared);
    const onOpenBuilder = (e) => { closePeek(); setBuildOpen(e.detail); setSection('build'); };
    window.addEventListener('noteapp:open-builder', onOpenBuilder);
    const onChangedNotes = () => { refreshNotes(); refreshTree(); };
    window.addEventListener('noteapp:open-note', onOpen);
    window.addEventListener('noteapp:notes-changed', onChangedNotes);
    return () => {
      window.removeEventListener('noteapp:open-note', onOpen);
      window.removeEventListener('noteapp:show-study', onShowStudy);
      window.removeEventListener('noteapp:show-course', onShowCourse);
      window.removeEventListener('noteapp:show-section', onShowSection);
      window.removeEventListener('noteapp:open-scripture', onOpenScripture);
      window.removeEventListener('noteapp:open-shared', onOpenShared);
      window.removeEventListener('noteapp:open-builder', onOpenBuilder);
      window.removeEventListener('noteapp:notes-changed', onChangedNotes);
    };
  }, [refreshNotes, refreshTree, closePeek]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sharing news (8.0): something shared with me, a comment on a note I share, a reply, a contact. A toast here, and a
  // desktop notification when Selah is in the background or it's the Windows app (not in focus mode).
  useEffect(() => {
    const on = (e) => {
      const d = e.detail ?? {};
      if (!d.sharing) return;
      if (d.sharing === 'error') { dialog.toast(d.error, 'error', 9000); return; }
      const openShared = () => window.dispatchEvent(new CustomEvent('noteapp:open-shared', { detail: { id: d.share } }));
      let msg = null;
      let action = null;
      if (d.sharing === 'new') { msg = `${d.from} shared “${d.title}” with you`; action = { label: 'Open', onClick: openShared }; }
      else if (d.sharing === 'comment' && d.from) { msg = `${d.from} commented on a note you share`; if (d.note) action = { label: 'Open', onClick: () => openNoteRef.current(d.note) }; }
      else if (d.sharing === 'reply') { msg = `${d.from} replied to your comment`; action = { label: 'Open', onClick: openShared }; }
      else if (d.sharing === 'contacts' && d.request) msg = `${d.from} wants to share with you: Shelf → Shared with me → Contacts`;
      else if (d.sharing === 'contacts' && d.accepted) msg = `${d.from} is a contact now`;
      if (!msg) return;
      dialog.toast(msg, 'info', 8000, action);
      if ((isDesktopApp() || document.hidden) && !focusOn()) notify('Selah', msg).catch(() => {});
    };
    window.addEventListener('noteapp:live', on);
    return () => window.removeEventListener('noteapp:live', on);
  }, [dialog]);

  const treeRef = useRef(tree);
  treeRef.current = tree;

  // ---- capture: Alt+N, and things shared to the app from a phone's share menu ----
  const captureOpen = useRef(false);
  const openCapture = useCallback(async () => {
    if (captureOpen.current || !treeRef.current) return;
    captureOpen.current = true;
    await dialog.open((close) => <QuickCapture tree={treeRef.current} close={close} onSaved={() => { refreshTree(); refreshNotes(); }} />);
    captureOpen.current = false;
  }, [dialog, refreshTree, refreshNotes]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyN') {
        e.preventDefault();
        openCapture();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyF') {
        e.preventDefault();
        toggleFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openCapture]);
  useEffect(() => {
    const token = new URLSearchParams(location.search).get('share');
    if (!token) return;
    history.replaceState(null, '', `/${location.hash || '#inbox'}`);
    api.claimShare(token)
      .then((r) => {
        dialog.toast(`Saved “${r.title}” to the Inbox`, 'info', 6000, { label: 'Open', onClick: () => openNoteRef.current(r.id) });
        setSection('inbox');
        refreshTree();
        window.dispatchEvent(new Event('noteapp:notes-changed'));
      })
      .catch((e) => dialog.toast(e.message, 'error'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Ctrl+K command palette ----
  const paletteOpen = useRef(false);
  const go = {
    page: (key) => {
      if (['all', 'templates', 'trash'].includes(key)) changeView({ type: key });
      else if (key === 'mynotes' || key === 'shelf') changeView({ type: 'all' });
      else if (key === 'scripture') openScripture();
      else if (key.startsWith('desk:')) { showDeskTab(key.slice(5)); setSection('desk'); }
      else setSection(key);
    },
    view: changeView,
    note: openNote,
    study: (id) => window.dispatchEvent(new CustomEvent('noteapp:show-study', { detail: id })),
    scripture: (q) => openScripture(q),
    newNote: () => newNote(),
    newSermon: async () => {
      const r = await dialog.open((close) => <NewSermonDialog tree={treeRef.current} close={close} />);
      if (!r) return;
      refreshTree();
      await openSermonBuilder(dialog, r.note_id);
    },
    newStudy: async () => {
      const id = await startStudy(dialog);
      if (id) refreshTree();
    },
    course: (id) => window.dispatchEvent(new CustomEvent('noteapp:show-course', { detail: id })),
    newCourse: async () => {
      if (await startCourse(dialog, treeRef.current)) refreshTree();
    },
    newFromTemplate: () => noteActions.pickTemplate(currentNotebook()),
    newTask: async () => {
      await dialog.open((close) => <TaskDialog task={null} dialog={dialog} close={close} onOpenNote={openNote} />);
      refreshTree();
    },
    newEvent: () => dialog.open((close) => <EventDialog event={null} dialog={dialog} close={close} onOpenNote={openNote} />),
    capture: () => openCapture(),
    voiceMemo: async () => { if (await recordVoiceMemo(dialog)) refreshTree(); },
    settings: () => openSettings(),
    customizeSidebar: () => dialog.open((close) => <SidebarDialog close={close} />),
    theme: setTheme,
  };
  const goRef = useRef(go);
  goRef.current = go;
  const openPalette = useCallback(async () => {
    if (paletteOpen.current || !treeRef.current) return;
    paletteOpen.current = true;
    // `go` is read through a ref so the palette always acts on the current state.
    const proxy = new Proxy({}, { get: (_, k) => (...args) => goRef.current[k](...args) });
    await dialog.open((close) => <CommandPalette tree={treeRef.current} go={proxy} close={close} />);
    paletteOpen.current = false;
  }, [dialog]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette]);
  // Esc closes the peek, unless it's for a dialog, a menu or an open slash/[[ menu in the editor. (Looked at before
  // the editor sees the key, which closes its menus.)
  useEffect(() => {
    if (!peek) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || document.body.classList.contains('focus-writing')) return; // Esc leaves focus mode first
      const open = [...document.querySelectorAll('.modal-backdrop, .menu, .context-menu, .slash-popup, .esv-card, .find-bar')].some((el) => el.getClientRects().length > 0);
      if (!open) closePeek();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [peek, closePeek]);

  if (!tree) return null;

  return (
    <div className={`app pane-${pane} ${section !== 'notes' ? 'is-page' : ''} ${NOTES_SECTIONS.includes(section) ? 'in-notes' : ''} ${section === 'notes' && fullNote && selectedId ? 'is-full-note' : ''}`}>
      <div className="sidebar-backdrop mobile-only" onClick={() => setPane('list')} />
      <UpdateBanner />
      <NoticeBanner />
      <WhatsNewCard onShowAll={() => dialog.open((c) => <WhatsNewDialog close={c} />)} />
      <Tour />
      <Sidebar
        tree={tree} view={section === 'notes' ? view : { type: 'none' }} onView={changeView} onNewNote={newNote}
        onRefresh={refreshTree} onRefreshAll={refreshAll} onMoveNote={moveNote} onSettings={openSettings} onOpenNote={openNote}
        onNewFromTemplate={(nb) => noteActions.pickTemplate(nb ?? currentNotebook())} onNotesChanged={refreshNotes}
        section={section} onSection={(s) => {
          // 11.0: the rail always works in the main tab (a builder or other tab stays open beside it).
          if (activeUid !== 'main') { setActiveUid('main'); closePeek(); }
          if (s === section && (s === 'desk' || s === 'scripture')) setPageEpoch((n) => n + 1); // back to its home view
          if (s === 'scripture') openScripture(); else setSection(s);
        }}
      />
      <TopBar main={mainTab} tabs={tabs} activeUid={activeUid} onPick={pickTab} onClose={closeTab} tabMenu={tabMenu}
        onPalette={openPalette} nav={nav} onRefresh={refreshAll} />
      {section === 'dashboard' && (
        <main className="page-area" key={pageEpoch}>
          <HomePage tree={tree} onOpenNote={openNote} onTasksChanged={refreshTree} onNotesChanged={() => { refreshNotes(); refreshTree(); }}
            onSection={(s) => (s === 'scripture' ? openScripture() : setSection(s))} onPalette={openPalette} onNewNote={newNote} onSettings={openSettings} />
        </main>
      )}
      {section === 'inbox' && (
        <main className="page-area" key={pageEpoch}>
          <InboxPage tree={tree} onOpenNote={openNote} onChanged={refreshTree} onCapture={openCapture}
            onSettings={() => dialog.open((close) => <ClipperDialog close={close} />)} onMenu={() => setPane('sidebar')} />
        </main>
      )}
      {section === 'desk' && (
        <main className="page-area" key={pageEpoch}>
          <DeskPage tree={tree} onOpenNote={openNote} onPeekNote={peekNote} onOpenScripture={openScripture} onChanged={refreshTree} onMenu={() => setPane('sidebar')} />
        </main>
      )}
      {section === 'sermons' && (
        <main className="page-area" key={pageEpoch}>
          <SermonsPage tree={tree} onPeekNote={peekNote} onOpenScripture={openScripture} onChanged={refreshTree} onMenu={() => setPane('sidebar')} />
        </main>
      )}
      {section === 'build' && buildOpen && (
        <main className="page-area builder-area">
          <BuilderPage key={`${buildOpen.builder}-${buildOpen.id}`} {...buildOpen} close={() => closeBuilder(buildOpen.id)} />
        </main>
      )}
      {section === 'shared' && (
        <main className="page-area" key={pageEpoch}>
          <SharedPage shareId={sharedOpen?.id} noteKey={sharedOpen?.key ?? null} onPick={(key) => setSharedOpen((s) => ({ ...s, key }))}
            onOpenNote={openNote} onMenu={() => setPane('sidebar')} />
        </main>
      )}
      {section === 'calendar' && (
        <main className="page-area" key={pageEpoch}>
          <CalendarPage onOpenNote={openNote} onMenu={() => setPane('sidebar')} onTasksChanged={refreshTree} onAllTasks={() => setSection('tasks')} onSection={setSection} />
        </main>
      )}
      {section === 'attendance' && (
        <main className="page-area" key={pageEpoch}>
          <AttendancePage onMenu={() => setPane('sidebar')} onSection={setSection} onTasksChanged={refreshTree} />
        </main>
      )}
      {section === 'tasks' && (
        <main className="page-area" key={pageEpoch}>
          <TasksPage onOpenNote={openNote} onMenu={() => setPane('sidebar')} onTasksChanged={refreshTree} onPlan={() => setSection('calendar')} />
        </main>
      )}
      {section === 'notebooks' && (
        <main className="page-area" key={pageEpoch}>
          <NotebooksPage tree={tree} onRefresh={refreshTree} onOpen={changeView} onNewNote={newNote} onMenu={() => setPane('sidebar')} />
        </main>
      )}
      {section === 'scripture' && (
        <main className="page-area" key={pageEpoch}>
          <ScripturePage key={scriptureQuery ?? ''} initialQuery={scriptureQuery} onOpenNote={openNote} onPeekNote={peekNote} onMenu={() => setPane('sidebar')} />
        </main>
      )}
      {section === 'dailywalk' && (
        <main className="page-area" key={pageEpoch}>
          <DailyWalkPage onOpenNote={openNote} onMenu={() => setPane('sidebar')} onSection={setSection} />
        </main>
      )}
      {section === 'plans' && (
        <main className="page-area" key={pageEpoch}>
          <PlansPage onOpenNote={openNote} onMenu={() => setPane('sidebar')} onSection={setSection} />
        </main>
      )}
      {section === 'prayer' && (
        <main className="page-area" key={pageEpoch}>
          <PrayerPage onOpenNote={openNote} onMenu={() => setPane('sidebar')} onSection={setSection} />
        </main>
      )}
      {section === 'attachments' && (
        <main className="page-area" key={pageEpoch}>
          <AttachmentsPage tree={tree} onOpenNote={openNote} onChanged={() => { refreshTree(); refreshNotes(); }} onMenu={() => setPane('sidebar')} />
        </main>
      )}
      {section === 'media' && (
        <main className="page-area" key={pageEpoch}>
          <MediaPage onMenu={() => setPane('sidebar')} />
        </main>
      )}
      {section === 'wordpress' && (
        <main className="page-area" key={pageEpoch}>
          <WordPressPage onOpenNote={openNote} onOpenScripture={openScripture} onMenu={() => setPane('sidebar')} />
        </main>
      )}
      {section === 'tags' && (
        <main className="page-area" key={pageEpoch}>
          <TagsPage tree={tree} onRefresh={() => { refreshTree(); refreshNotes(); }} onOpen={changeView} onMenu={() => setPane('sidebar')} />
        </main>
      )}
      {section === 'notes' && (<>
      <NoteList
        title={title} notes={notes} selectedId={selectedId} onSelect={clickNote}
        noteMenu={(n) => (checked.has(n.id) && checked.size > 1 ? bulkItems()
          : noteActions.menuItems(n, { open: select, openInTab: (id) => openInNewTab({ kind: 'note', id, title: n.title }), move: moveNote, trash, restore, deleteForever }))}
        checked={checked} selectMode={selectMode} onSelectMode={() => (selectMode ? clearChecked() : setSelectMode(true))}
        onSelectAll={() => setChecked(new Set(notes.map((n) => n.id)))} onClearChecked={clearChecked}
        bulk={bulk} bulkItems={bulkItems}
        query={query} onQuery={setQuery} sort={sort} onSort={setSort}
        onNewNote={() => newNote()} isTrash={view.type === 'trash'} onEmptyTrash={emptyTrash}
        onRestoreGroup={restoreMany} onRestoreFromBackup={restoreFromBackup}
        isTemplates={view.type === 'templates'} onNewFromTemplate={() => noteActions.pickTemplate(currentNotebook())}
        notebookName={notebookName} showNotebook={false} onMenu={() => setPane('sidebar')}
        tagBar={['all', 'tag', 'files'].includes(view.type) ? { tags: tree.tags, view, onView: changeView } : null}
        onUseTemplate={(n) => noteActions.newFromTemplate(n, currentNotebook())} tags={tree.tags}
        onOpenInTab={(n) => openInNewTab({ kind: 'note', id: n.id, title: n.title })}
      />
      <main className="editor-area">
        {selectedId ? (
          <NoteEditor
            key={`${selectedId}-${editorEpoch}`} id={selectedId} tree={tree}
            listNote={notes.find((n) => n.id === selectedId)} noteActions={noteActions} onOpenScripture={openScripture}
            onChanged={onChanged} onSaved={onSaved} onTrash={trash} onRestore={restore}
            onDeleteForever={deleteForever} onBack={() => setPane('list')}
            fullScreen={fullNote} onFullScreen={() => setFullNote((f) => !f)}
            onReload={() => { setEditorEpoch((n) => n + 1); refreshNotes(); }}
            scrollTo={headingTarget?.id === selectedId ? headingTarget : null}
          />
        ) : (
          <div className="editor-empty">
            <Icon name="note" size={48} strokeWidth={1.3} />
            <p>Select a note, or create a new one.</p>
            {view.type !== 'trash' && <button className="btn btn-primary" onClick={() => newNote()}><Icon name="plus" size={16} /> New note</button>}
          </div>
        )}
      </main>
      </>)}
      {peek && (
        <div className="note-peek-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closePeek(); }}>
          <aside className="note-peek editor-area" role="dialog" aria-label="Note">
            <NoteEditor
              key={`${peek.id}-${peek.epoch ?? 0}`} id={peek.id} tree={tree} noteActions={noteActions}
              onOpenScripture={(q) => { closePeek(); openScripture(q); }}
              onChanged={onChanged} onSaved={onSaved}
              onTrash={async (id) => { await api.trashNote(id); dialog.toast('Note moved to Trash'); closePeek(); refreshNotes(); refreshTree(); }}
              onRestore={restore} onDeleteForever={deleteForever} onBack={closePeek}
              onReload={() => setPeek((p) => ({ ...p, epoch: Date.now() }))}
              scrollTo={peek.heading ? { id: peek.id, heading: peek.heading, n: peek.n } : null}
              peek={{ onClose: closePeek, onOpenFull: () => openNote(peek.id) }}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
