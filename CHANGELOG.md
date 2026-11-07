# Changelog

All notable changes to Note App are recorded here, newest first.

## [Unreleased]

## [12.1.0] - 2026-11-07

Selah 12.1 (roadmap Phase 6): Selah Desktop for Mac and Linux. Built on branch v121.

### Added
- **Selah Desktop for Mac** (Apple Silicon and Intel, macOS 12+): `.dmg` per architecture plus the `.zip` electron-updater uses (`latest-mac.yml`). Hardened runtime with `build/entitlements.mac.plist` (JIT, unsigned executable memory, library validation off: the window, the server run as Node, WebAssembly OCR, ffmpeg); signed and notarized when CI has the Apple secrets (`MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, and an App Store Connect API key `APPLE_API_KEY_P8`/`_ID`/`_ISSUER` or `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`), otherwise signed ad hoc (`SELAH_MAC_ADHOC`, Open Anyway; no auto-update). The library is in `~/Library/Application Support/Selah`; a menu-bar icon (`trayTemplate.png`), the app menu (Edit roles make Cmd+C/V/Z/A work), Dock click shows the window, Cmd+Option+N quick capture, Open at login (`wasOpenedAtLogin` starts it hidden), Touch ID for the lock (`systemPreferences.promptTouchID`), slides on the other display in simple full screen, the secrets key in the keychain. `stage.mjs` fetches ffmpeg for arm64 and x64; `after-pack.cjs` gives each build its own and copies the server's packages into `Selah.app/Contents/Resources`. Automatic backups also suggest iCloud Drive's real folder and `~/Library/CloudStorage` (OneDrive, Dropbox, Google Drive).
- **Selah Desktop for Linux** (x64): AppImage and `.deb` (`latest-linux.yml`). The library is in `$XDG_DATA_HOME/Selah` (`~/.local/share/Selah`); the tray menu is set ahead of time (StatusNotifier trays send no clicks); Open at login writes `~/.config/autostart/selah.desktop` (the `.AppImage` file itself for an AppImage); the secrets key in the keyring, or the plain key file when there's no keyring (`basic_text`).
- **CI** (`.github/workflows/desktop.yml`): one job makes the tag's draft release, then Windows, Mac (macos-15) and Linux (ubuntu-22.04) build and upload into it. The Mac builds are signed with a Developer ID and notarized (from 12.1.0-beta.4). `actions/checkout` and `actions/setup-node` v5 (Node 24; v4's Node 20 is deprecated).
- Mac app icon on Apple's grid (`build/icon-mac.png`) and the menu-bar template icons, from `branding/build-icons.mjs`.

### Changed
- Desktop's words follow the computer (`desktopWords()` in `client/src/desktop.js`, `platform` from the bridge): tray or menu bar, Start with Windows or Open at login, Windows Hello or Touch ID, "this computer". Settings → General → App offers the Desktop download in browsers on a Mac or Linux too.
- Settings → General → App: **Download** starts the installer for this computer straight from the newest GitHub release (the Setup .exe, the Mac .dmg for its chip, the AppImage), read from GitHub's API in `client/src/desktopDownload.js`; a beta Selah offers the newest published beta. A link beside it opens the release page for the other files, and the page opens if GitHub can't be reached.
- Docs: Desktop install covers Mac and Linux. The user guide no longer mentions Use on two PCs (removed in 12.0.1).

## [12.0.1] - 2026-11-06

### Removed
- **Use on two PCs** (Selah Desktop's library in a sync folder: `server/desktopsync.js`, `server/desktopsyncfs.js`, `SyncBanner.jsx`, `/api/desktop/sync`, its read-only gate and conflict copies in Restore notes): slow, complex, and not needed with export for notes, lessons, sermons and slides; to move a library, Download a backup and Import a library. A PC that had it on keeps its own library as it is; the copy in the folder is left alone. Desktop's server now stops within 10 seconds (it waited up to 55 for a last save to the folder).

## [12.0.0] - 2026-11-06

Selah 12.0 (roadmap Phase 5): Selah Desktop, self-hosted Selah Cloud, the docs site and the fermata logo. Built on branch v12.

### Added
- **Selah Desktop** (`desktop-app/`, Electron 44.9.3, electron-builder 26.18.0, electron-updater 6.8.11; replaces the Tauri app): first run chooses **On this PC** (Offline) or **On a Selah Cloud server** (Connect). Offline runs Selah's own server on Electron's Node 24.22 (`ELECTRON_RUN_AS_NODE`) on 127.0.0.1 with the library in `%LOCALAPPDATA%\Selah` (storage, data, logs, app); tray (Quick capture Ctrl+Alt+N, Start with Windows, Check for updates, logs, Quit), close-to-tray, Windows notifications through the bridge (`window.selahDesktop`, `preload.cjs`), quick capture window, the slides window full screen on the other monitor (`openSlides`), an optional PIN / Windows Hello lock (PowerShell `UserConsentVerifier`; the key header is withheld while locked), updates from GitHub Releases (betas only to beta installs), NSIS per-user installer (`npm run dist`; `scripts/dist.mjs` takes Selah's version; `scripts/after-pack.cjs` adds the server's node_modules). `.github/workflows/desktop.yml` builds it on `v*` tags into a draft release.
- **Desktop edition on the server** (`NOTEAPP_EDITION=desktop`): single mode on 127.0.0.1, plain HTTP, no sign-in; every `/api` request needs the launch key in `X-Selah-Desktop`; sign-in, password and security routes answer 404; the secrets key comes sealed with DPAPI (`NOTEAPP_SECRET_KEY`; a restored `wordpress.key` file wins and is sealed next launch) and goes into backups as `keyData`; the server shuts down over the IPC channel (and when the app disappears). `/api/session` reports `edition`.
- **Automatic backups** (`server/desktopbackup.js`, `DesktopSettings.jsx`): to a chosen folder (OneDrive/iCloud Drive/Dropbox/Google Drive detected and suggested), daily or weekly, keep 2–60, optional passphrase (sealed); written as `.part` and renamed. **Go back to a backup** and **Import a library** stage a full restore that `server/desktoprestore.js` applies before notes.db opens (old library to `storage-before-restore/`; Cloud sign-ins, sharing and setup links dropped; newer-version backups refused).
- **Use on two PCs** (`server/desktopsyncfs.js`, `server/desktopsync.js`, `SyncBanner.jsx`): the library in a sync folder. The live database stays local; the editing PC saves a snapshot, files and the key to the folder every 5 minutes and on close; a newer copy is pulled at start. Each PC writes only `pcs/<id>.json`; one PC edits, others are read-only (423), **Take over** asks the editor to save and hand over, **Take over anyway** forces it and the old PC's unsaved changes go to `conflicts/` as a backup file.
- **Restore notes** also opens Desktop's automatic backups and sync conflict copies (`file:` sources, listed files only; attachments from the file).
- **Self-hosted Selah Cloud**: `scripts/install.sh` (one command on Ubuntu: domain, email, HTTPS mode, allowed address; DNS check; `cloud-setup.sh`, admin init, password, services, first release, optional first tenant) and `scripts/update.sh` (newest/given/beta tag: build, restart the console, prepare, rolling update).
- **HTTPS with any DNS provider**: gateway `tls: 'acme-host'`, a Let's Encrypt certificate per name proven over 443 (TLS-ALPN, no port 80, no API token); `cloud-setup.sh --dns none` installs the standard Caddy. `publicTls()` covers both Let's Encrypt modes.
- **Self-hosting on your own network**: the installer's third HTTPS choice (a home server or a test VM on a private address, where Let's Encrypt can't reach): `gen-certs.sh` makes a private certificate authority and `init --tls files --port 443 --new-cert` a wildcard certificate for `*.<domain>`; no email or DNS check; the console answers from the home network unless one address is given; it ends with the trust and hosts-file steps. Docs: DNS and HTTPS → On your own network.
- **Docs site** (`docs/`, GitHub Pages): Desktop install, Cloud install, DNS and HTTPS, backups, updates, troubleshooting.
- **Desktop demo** (`desktop-app/scripts/demo.mjs`, `NOTEAPP_DESKTOP_DEMO=1`): a separate library with the demo tenant's sample data and six automatic backups dated over two weeks.
- **Fermata logo** (`branding/`): `node branding/build-icons.mjs` renders favicon, PWA icons, extension icons, the rail logo (`selah-rail.svg`) and Desktop's `.ico`.

### Changed
- Cloud tenants no longer get their own off-site backup settings (the admin console backs every Selah up); Data & backup says so.
- Settings → General → App on Windows links to Selah Desktop's download; the older Windows app is pointed at it. `SOURCE_URL` is the new public repository.
- Closing the server ends live-update streams first (it had waited about 55 seconds for them).
- **Selah Desktop installs and opens faster**: the window comes up at once with "Opening your library…" (`pages/starting.html`) while the local server starts, instead of after it; the installer leaves out what the server never reads (the page's own fonts, the browser copies of the OCR engines, the second English OCR model, the second HEIC build, docs, type definitions, source maps, tests, and Chromium's other languages): 210 → 162 MB and about 6,400 → 2,400 files to unpack. `scripts/stage.mjs` checks every server package still loads after trimming.

### Removed
- The Tauri Windows app (`desktop/`), `npm run desktop:publish` and the server's `/desktop/*` and `/api/desktop` routes.

### Added (release tooling, first out in 11.0.1-beta.1)
- **Shipping in one command** (`scripts/ship.mjs`): `npm run beta` numbers the next beta itself (`--version` for a release's first), bumps, builds, commits and pushes the branch, sends the code to the server, prepares it as the beta, moves the demo to it, resets the demo and runs the smoke test. `npm run release` turns `## [Unreleased]` into the release's section and dates its What's New entry, bumps, builds, commits, tags `vX`, fast-forwards main to the branch and pushes both with the tag, prepares it as main on the server and updates the demo (`--all`: every tenant). `--dry-run` and `--no-smoke` on both; `SELAH_SSH` names the server. Betas get no changelog or What's New entry of their own: changes collect under Unreleased, and the coming release's What's New entry waits with `date: ''`.
- **Smoke test** (`scripts/smoke.mjs`, `npm run smoke`; `playwright-core` 1.64.1): signs in to the demo with an hour's session from the admin console (`/control/demo-session`, demo only), opens every page, the Psalm 23 and Ephesians builders and Home at phone width, fails on page errors and 5xx answers (console errors are listed), checks the sample data the demo video needs (`SEED_CHECKS`), puts back the What's New and tour prefs it set, signs out, and writes `smoke-results/<version>/index.html` (a screenshot gallery) and `results.json`.
- **Beta button** (`BetaReview.jsx`, `server/betareview.js`): on a pre-release the top bar shows Beta · tried/total; its panel stays open while you use Selah and lists the coming release's What's New items (or the entry's `try` list) to tick off, with Something's off under each and Anything else. Kept in the setting `beta_review` per version (`GET /api/beta-review`, `PUT …/check`, `POST …/note`, `DELETE …/note/:id`; `/control/beta-review` for the console); `npm run beta-review` prints it.

### Changed (release tooling)
- Settings → About → What's new leaves out an entry for a release that hasn't shipped yet.
- Desktop's workflow makes the tag's draft release (a pre-release for a beta) before electron-builder uploads: its parallel uploads had made two drafts for one tag, the installer and `latest.yml` in one and the blockmap in the other.
- The repository is LF throughout: `.gitattributes` (`* text=auto eol=lf`), and 21 files committed with Windows line endings converted (no other changes).

## [11.0.0] - 2026-11-06

Selah 11.0: Phases 2–4 of the roadmap (Desk and tabs, fixes and attendance, the slide editor), released after betas 1–5 on the demo tenant. The beta sections below list every change.

### Changed
- **What's New** (`shared/whatsnew.js`): the five beta entries are one 11.0.0 entry, and `compareVersions` puts a pre-release before its release (it had ranked `11.0.0-beta.5` above `11.0.0`, which would have hidden the entry), as the admin console's does.

## [11.0.0-beta.5] - 2026-11-06

The fifth beta of 11.0. On the demo tenant only.

### Added
- **Slide colors apart from the theme** (`shared/slideThemes.js`, `SlidesEditor.jsx`, `server/slides.js`): a deck can save `colors` (any theme's id, `brand`, or `custom` with `custom: { bg, text, accent }`); left out, the theme's own. `namedPalette` and `customPalette` (bg2, muted, head and art worked out from the three) feed `deckLook`, so the canvas, the slides window and PowerPoint export all follow it. Design → **Colors** lists the theme's, every other theme's, the brand's and Your own (three color pickers); picking a theme resets it.

## [11.0.0-beta.4] - 2026-11-06

The fourth beta of 11.0. On the demo tenant only.

### Fixed
- **Slide editor scrolling** (`styles.css`): `.se-main`'s grid row is bounded (`grid-template-rows: minmax(0, 1fr)`, children `min-height: 0`), so the thumbnails, the canvas and the Slide/Design panel each scroll inside the window instead of running past it (the builders' Slides tab and a note's Slides… window).

## [11.0.0-beta.3] - 2026-11-06

The third beta of 11.0 (Phase 4: the slide editor, plus the syllabus PDF and manuscript export). On the demo tenant only.

### Added
- **Slide themes** (`shared/slideThemes.js`): eight themes (`light` and `dark` kept as Lamplight and Lamplight Dark, plus Parchment, Linen, Dawn, Forest, Slate, Midnight) and `brand`, each a palette, a font pair and default art; six font pairs (Classic, Book/Lora, Elegant/Playfair Display + Source Serif 4, Modern/Montserrat + Inter, Bold/Oswald + Source Serif 4, Clean/Inter), bundled from fontsource. A deck saves `theme`, optional `fonts` and `art` (null: none), `bg` + `dim` (a picture behind every slide), `translation` and `logo`; a slide saves optional `art` ('none' or an id), `bg`, `logo: false` and, for a passage, `tr`. `SlideView` draws from CSS variables (`slideLook.js` `lookVars`), with layers for the picture, its dimming, the art and the logo.
- **Background art** (`client/src/slideArt.js`): twenty line drawings (cross, cross at sunrise, dove, olive branch, open Bible, oil lamp, wheat, mountains, waves, vine, bread and cup, star, shepherd's staff, tree, candle, road, anchor, fish, crown, sheep) and six textures (parchment, linen, watercolor, grain, paper fibers, soft corners) as SVG in the theme's art color.
- **Church brand** (`GET/PUT /api/slides/brand`, setting `slide_brand`; `POST/DELETE /api/slides/brand/logo`): name, primary/secondary/accent colors, light/dark/color background, fonts, art, logo and its corner. `BrandDialog` in `SlideMedia.jsx`.
- **Media library** (`slide_media` table; `GET/POST /api/slides/media`, `DELETE /api/slides/media/:id`): pictures kept with no note, for image slides and backgrounds. **Utility → Media** (`#media`, `MediaPage`): the brand, My pictures, the art gallery in any theme. The attachment manager counts the logo and media as used.
- **Slide editor** (`SlidesEditor.jsx`): Canvas (thumbnails, the slide large, ↑/↓ between slides, Slide and Design panels) and Outline (every slide's type, title, text and points in one list). Design: theme cards, fonts, art picker, background picture with darkening, translation, logo.
- **Translation per deck and per slide**: `usePassages(slides, translation)` keys passages by translation and reference (`passageKey`); `stepsOf` takes the deck.
- **PowerPoint export** (`client/src/slidesPptx.js`, pptxgenjs 4.0.1): widescreen slides with editable text in the deck's fonts; everything behind the text (gradient, picture, texture, line art, logo) drawn into one JPEG per slide master, so each is stored once; passages over their pages; notes and answers as speaker notes.
- **Manuscript export** (`ManuscriptExport.jsx`, `client/src/manuscript/`): PDF (pdfmake 0.3.12; Source Serif 4, Inter for Greek, Noto Serif Hebrew), Word (`wordDocument` gains `size` and `subtitle`) and RTF (footnotes, written-out list numbers, colored left borders); Regular/Large/Pulpit; a sermon as manuscript or outline, in delivery order, color-coded. From teach/preach mode and the builders' last step.
- **Syllabus PDF** (`POST/DELETE /api/classes/:id/syllabus-pdf`, `data.syllabusPdf`): kept as a note-less attachment, deleted with the class; a class's Syllabus tab shows it in pdf.js with Full screen, Download, Replace, Remove; `pdfText` + `client/src/syllabus.js` read code, professor, email, term, office hours, course site and term dates into a fill-in dialog.
- **Demo seed**: Cedar Hollow's brand (colors, Elegant fonts, wheat, an SVG logo) and two media pictures; the Ephesians sermon deck uses the brand, the title over "Hillside at dawn" and a "Sanctuary window" picture slide.

- **Page tabs** (`App.jsx`, `openTab.js`): a tab can hold a page (`kind: 'page'`, a `section`, or `view` 'templates'/'trash'). Rail pages and Utility's Templates, Attachments, Tags, Media and Trash open in a new tab with Ctrl/⌘-click, a middle click, or right-click → Open in new tab / Pin as a tab (`noteapp:open-tab` with `{ kind: 'page' }`). The main tab's menu has Open in new tab for a page and **Pin this as a tab**.

### Changed
- **Pinned tabs keep what they hold**: a note or study opened from a pinned tab opens in the main tab; pinned tabs are narrow (max 150px). A tab's title only follows the note or study it holds.
- **Verse of the day** (`server/votd.js`): Bible Gateway's daily pick only; Selah's own list, `votd_source` and `GET/PUT /api/votd/source` are gone. When the feed can't be reached, `reference` is null for the day (tried again an hour on) and Home says the verse isn't available.
- The tour's Preach step mentions themes, Outline and PowerPoint.

### Fixed
- The attendance group dialog's fields had no layout (labels and inputs ran together); they're full-width columns now.

## [11.0.0-beta.2] - 2026-11-06

The second beta of 11.0 (Phase 3: tweaks, fixes and attendance). On the demo tenant only; 11.0.0 ships once Phase 4 is in.

### Added
- **Delete from Desk and Home** (`WorkList.jsx` `useDeleteWork`): a trash button on each Desk row (on hover; always on touch screens) and Delete on the right-click menu of Desk and Home rows. A study, lesson or sermon goes to the Trash (`DELETE /api/notes/:id`) with Undo (`POST /api/trash/restore`); a study plan, course, series, writing project or class is deleted after a confirm (`DELETE /api/studies/:id`), its notes kept.
- **"You already have…"** (`ExistingWork.jsx`): New study and New sermon list matching work as you type (a passage study: Bible studies overlapping its verses; a book: its background; a word: word studies on it; a sermon: sermons overlapping its passage), each with Open it, and the start button becomes Start new anyway. Starting a lesson or sermon from a study, and a sermon or teaching series session's sermon or lesson, asks first (`confirmNew`).
- **Attendance on Plan** (`server/attendance.js`, `AttendancePage.jsx`, `PlanTabs.jsx`): tables `att_groups`, `att_people`, `att_meetings`, `att_marks`. A group is a class, service or small group, taken by roster or headcount, optionally following a recurring calendar event (`expand` plus moved occurrences; twelve weeks back to two ahead). Check-off per person (`POST …/meetings/:date/mark`) or the whole list (`PUT …/meetings/:date`), headcount and notes per meeting, visitors added at a meeting (counted from that date), people taken off the roster or deleted. Nudges: on a roster, three taken meetings missed in a row since joining; Follow-up task (`POST /api/attendance/people/:id/follow-up`, a task due today) or Dismiss, hidden until they come back and miss three again. CSV export per group (`GET /api/attendance/groups/:id/export.csv`, BOM, spreadsheet formulas escaped). Ctrl+K "Plan: Attendance". CSS prefix `atn-`.
- **Demo seed**: Adult Sunday School and Tuesday Home Group rosters and Sunday worship as a headcount, eight weeks each from their calendar events, the same every Reset; Hal Pruitt missed the last three Sundays; Jordan Ames visited the home group last Tuesday.
- **Settings → Credits** (`CreditsPane.jsx`, `shared/credits.js`): Bible text and services, the methods the builders follow and their authors, data and fonts, open-source software, a trademark note. Settings → About → Free software: Source code and Credits.
- **Open source**: `LICENSE` (GNU AGPL v3), `"license": "AGPL-3.0-or-later"`, a License section in the README, `THIRD-PARTY-NOTICES.md`.

### Changed
- **The rail's More is gone** (`Sidebar.jsx`, `TopBar.jsx`): Focus mode and Refresh are buttons at the right of the top bar; Customize the rail is in Settings → General → Rail and on the rail's right-click menu, which also lists the pages taken off it. The whole rail scrolls on a short screen. Phones keep More: other pages, Utility, hidden pages, Focus mode, Refresh, Settings.
- **Verse of the day** (`server/votd.js`): from Selah's own list of 114 verses by default (no outside call); Bible Gateway's daily pick is a choice in Settings → Connections (`GET/PUT /api/votd/source`, setting `votd_source`).
- **Product names**: other note apps are no longer named in the app, docs or this changelog; the importers and exporters are named by file format (.enex files, Markdown), and their helpers renamed (`stripExportStubs`, `EXPORT_STUB`, `wikiToMarkdown`). The ENEX DTD addresses stay (the format needs them).
- `package.json` description.

### Fixed
- The builders' passage pane (and reference study text) was in italics: only Cormorant Garamond's 600 italic is bundled, so its "upright" text was italic too. They use the notes' serif now.

## [11.0.0-beta.1] - 2026-11-06

The first beta of 11.0 (Phase 2: workflow and navigation). On the demo tenant only; 11.0.0 ships once Phases 3 and 4 are in.

### Added
- **Your work** (`server/work.js`): `GET /api/work` lists every Bible study (Interpretive Journey, background, word), lesson (a teaching session's note, a note filed as a lesson, or one following `hblt`/`points`) and sermon, with its passage, the builder step it was left on (`step`/`steps`, numbered like the builder: its Start page isn't counted) and `done`/`completed_at` (`note_complete`, or a sermon marked ready). `?passage=` keeps the ones whose passage overlaps it (backgrounds left out).
- **Desk on the rail** (`sidebarPages.js`, `DeskPage.jsx`): its own page above Preach. Study, Teach, Write and Learn list all your work and plans as rows (`WorkList.jsx`, `work.js`: type, passage, date, Step N of M / readings done / Done), with type chips and Active/Done (`noteapp.workFilter` per tab). Rows open the builder (`openBuilderPage`) or the plan; right-click for Mark done/not done and Open in new tab. Teach's New adds Sermon. The status menu (Under way/Finished/Archive) and the study cards are gone from Desk.
- **Home's tabs** (`HomePage.jsx`, `HomeTabs.jsx`): Study, Teach, Write and Learn are Home's own (`noteapp.homeTab`), showing only active work with **Mark done** (`useMarkDone`: `PUT /api/notes/:id/complete`, or a plan's status to done; a toast with Undo). Counts are active work. Learn shows This week.
- **Browser-style tabs** (`App.jsx`, `TopBar.jsx`): a main tab (labelled with where you are) plus tabs opened on purpose (`noteapp:open-tab` event: Ctrl/middle-click, Open in new tab in note and row menus, Ctrl-click on note links) and one per open builder. Navigation inside a note or study tab stays in it; anything else (the rail, `noteapp:show-section`, `noteapp:open-scripture`) goes to the main tab. Closing a builder returns to the main tab. Stored as `noteapp.tabs` (10.x's kept tabs carried over); preview tabs, "N more" and `MAX_TABS` removed.
- **"Your work on" panel** on the passage page (`PassageView.jsx`): the passage's studies, word studies, lessons and sermons with their step or Done, keepers and preaching dates, replacing the separate Studies, Word Studies and Sermons groups; Teaching keeps planned sessions without a lesson.
- **Guided tour** (`Tour.jsx`): nine spotlight steps across the rail, Home, Desk, the study workflow, tabs, the passage page and Preach; offered once (pref `tourOffered`, after What's New and dialogs close), replayed from Settings → About; an optional sample word study (pref `tourSample`) deleted with one click.

### Changed
- **Tabs on every page look like Home's and Walk's** (`home-tabs`, `is-sub` for a second row): Preach, Bible, a class's sections, Prayer, Attachments, Daily Walk's devotionals, WordPress sub-tabs and memory verses.
- **Lectures in This week**: `GET /api/classes/due` includes lectures dated in the coming days (marked Lecture); a class's This week lists lectures in the next seven days, not only its numbered week's.
- Demo seed: the Psalm 23 study is left on Step 1.

## [10.2.1] - 2026-11-06

Sample data for the demo tenant. Nothing changes for anyone else.

### Added
- **Demo sample data** (`server/demo/seed.js`): `POST /control/demo-seed` on the control port, only on the tenant called `demo` and only on a database with no notes yet (the admin console's Reset, Admin 3.2.0, empties it first). It puts back the sign-in the console kept (`{ settings, sessions }`: password, two-step, username and email, Bible and site keys, signed-in devices), then adds the sample data through Selah's own API (`app.inject`, with a session that's removed afterwards), dated around the day of the reset. Everything is made up (Cedar Hollow Bible Church): a finished set on Ephesians 2:1–10 (Bible study, a word study on *charis*, a Sunday school lesson in a teaching study and a sermon with its 10-slide deck, all marked complete, the sermon preached last Sunday), a half-built Psalm 23 study started two days ago, five tagged notes, a memory verse, three sermon bank items, weekly calendar events going back eight weeks (the Sunday school class, worship, the Tuesday home group, the prayer meeting) and two coming up, six tasks (one done), five prayer requests (one answered) and a Bible in a Year plan three days behind. The people the class and home group will have on their rosters are in `DEMO_GROUPS`, for attendance later.
- `startTenant(log, app)` gives the control port the app, for the seed.

## [10.2.0] - 2026-11-04

Reading plans on Walk's new Plans tab and on Home.

### Added
- **Reading plans** (`server/readingplans.js`, `shared/readingPlans.js`, `PlansPage.jsx`, `PlanDialogs.jsx`): tables `reading_plans` (its own copy of the schedule as JSON, `start_date`, a `weekdays` mask, `shift_days`, `since_day`, `status`) and `reading_plan_reads` (plan, day, passage). Routes `GET /api/plans/catalog`, `GET/POST /api/plans`, `GET/PATCH/DELETE /api/plans/:id`, `PUT /api/plans/:id/read` (a passage or a whole day), `POST /api/plans/:id/shift` and `/restart`; every one takes the browser's `today`.
- **Built-in plans**: Bible in a Year (generated from chapter counts: the Old Testament without Psalms and Proverbs once, the New Testament once, Psalms and Proverbs twice, over 365 days), M’Cheyne (the 1842 calendar, `shared/readingPlansMcheyne.js`, all 1,460 readings checked to parse) and Chronological (Selah's own order of 1,189 chapters, each exactly once, split over 365 days). Bible in a Year and M’Cheyne can follow the calendar (day 1 on January 1, `since_day` today so earlier days aren't missed).
- **Build your own**: books (with quick picks) split into whole-chapter days by a number of reading days, chapters a day, or a finish date; start date and reading weekdays; a preview with the finish date.
- **CSV**: import (`planFromCsv`: day number, then passages in more columns or separated by ";"; problems listed by row), a downloadable template (`reading-plan-template.csv`), and **Download as CSV** for any plan.
- **The Plans tab**: each plan with its progress, today's passages (each opens to its text in the chosen translation, `useBible('plans')`), behind days with **Catch up** (the missed days listed to tick) and **Shift dates** (`shift_days` so today is the first missed day), and ⋯ for the whole schedule (`PlanScheduleDialog`), rename, pause, CSV, start over and delete. **Journal** opens the day's Daily Walk journal note, which now lists each active plan's passages for the day (`plansOn` in `dailywalk.js`).
- **Home**: a Reading plans card (`HomePlans`, Customize → Reading plans) with today's passages to tick, Scripture hover cards, and how many days behind.

### Changed
- **Walk's tabs**: Daily Walk, Plans, Prayer. The rail's Walk lights up for Plans too.
- **The rail's foot**: More now sits above Utility (New, More, Utility, Settings).

## [10.1.1] - 2026-11-04

### Fixed
- **The rail's foot** (`Sidebar.jsx`): New (the round + button) comes first again, then a divider, then Utility, More and Settings as labeled tiles (`nr-item`, like the pages above) instead of Utility's tile sitting on the + button with More and Settings as bare icons below it.

## [10.1.0] - 2026-11-04

Notes are sorted by tags, not notebooks: one notebook you see (My notes), the Inbox, and the builders' own notebooks kept out of sight.

### Changed
- **My notes replaces the Shelf** (`Sidebar.jsx`, `sidebarPages.js`): the rail shows the WordPress site (while one is connected; no longer under More) and then **My notes**, after Walk, Bible and Preach. Pinned notebooks are gone. **Utility** moved to the foot of the rail, above New, More and Settings, as its own panel (no Shelf/Utility switch), and now holds **Shared with me** (`RailPanels.jsx`; the Shelf panel, notebook rows, shelf groups and pin buttons were removed). Customize the rail lists My notes and Utility and no longer picks pinned notebooks (`SidebarDialog.jsx`); a saved choice naming `shelf` reads as `mynotes`. The phone tab bar's Shelf is My notes.
- **My notes** (`App.jsx`, `NoteList.jsx`): the note list's `all` view is every note except the Inbox's (`GET /api/notes?mynotes=1`), titled My notes, with a **tag bar** under the search box: All, Files (`?files=1`, notes with attachments), then tags by use (ten, then "+ N more"); picking a tag again goes back to All. Notebook and shelf views are retired (a stored one opens My notes). A new note goes to My notes; made while a tag is open it gets that tag. Notes from templates go to My notes.
- **Inbox: filing is tagging** (`InboxPage.jsx`, `TagToFileDialog` in `TagDialogs.jsx`): the bar offers six tags for the selected item (tags named in its title or text first, then the most used), 1–6 tags it, T (or F) types any tag, and a row's **Tag…** does the same. Undo takes the tag off and puts the note back.
- **A tagged Inbox note moves to My notes** (`server/mynotes.js` `fileTaggedInbox`, called from `setNoteTags` and `POST /api/tags/apply`), so a clip or capture with tags skips the Inbox.
- **Managed notebooks**: `notebooks.managed` marks the builders' notebooks (each study's, course's and class's, Sermons, Bible Study), set by `markManaged()` on `/api/tree`. `tagWork()` gives each note in one the work's tag once (the study's title, else the notebook's name; `notes.work_tagged`), so builders' notes show in My notes; removing the tag sticks.
- **Every other notebook is folded into My notes** (`tidyNotebooks` at server start; `absorbNotebook`): its notes, in the Trash too, move to My notes and get its name, and its shelf's, as tags (not for plain names like First Notebook or Inbox; templates move untagged). Shelves, notebook and shelf shortcuts and the `railNotebooks` pref are cleared. The first start of 10.1 takes a restore point first (`takeRestorePoint`), so the old layout can be brought back from Settings → Data & backup. Later starts fold any notebook made since.
- **Imports and restores land in My notes**: .enex (per file) and Markdown ("Tag them all") imports and Selah notebook files, restores from a backup and shares that bring notebooks fold them in after importing (`absorbNotebooks` in `routes.js` and `importPackage`), the names becoming tags. Restoring a trashed note whose notebook is gone puts it in My notes, tagged with that notebook's name, instead of making the notebook again. Splitting a note can tag the parts with its title instead of making a notebook (`notetools.js`). Daily Walk journal notes go to My notes (`dailywalk.js`).
- **No notebook pickers**: removed from the note header (an Inbox note shows an **Inbox** chip until it has a tag), note and selection menus (Move to notebook…, Restore … to…), new study, course, class, sermon and Logos import dialogs, templates, merge, split, imports and restore from a backup. `notebookOptions()` offers only My notes, and single-choice pickers (WordPress post import, journal note, Attachments filter) are hidden. The clipper's notebook list (`/api/clip/info`) is the Inbox and My notes. Ctrl+K lists no notebooks or shelves. "Put its notebook on the Seminary shelf" is gone from a class's menu.
- **Wording**: "Pin to top of notebook" is now "Pin to top of the list"; the Trash's groups say a note from a gone notebook goes back to My notes.
- **User guide**: Getting around, Notes, sharing, restore, capture and the Inbox, Desk classes, export, merge and split describe My notes and tags.

## [10.0.3] - 2026-11-04

### Changed
- **Dependency updates** (patch releases only): fastify 5.12.8, @fastify/cookie 11.1.5, @fastify/multipart 10.1.7, @fastify/static 10.1.10, marked 18.1.3, TipTap 3.32.2, FullCalendar 6.1.22, React 19.3.1, Vite 8.3.5, @vitejs/plugin-react 6.2.1, and the Inter and Source Serif 4 fonts. `npm audit fix` updated `fast-uri` (pulled in by `ajv`), which fixes four moderate advisories (GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, GHSA-333x-w4r6-6crp); `npm audit` now reports none. FullCalendar 7 and docx 9.15 are left for later.
- **README**: describes the hosted service (one Docker container per person, the admin console, cloud-push releases) as how Selah runs today, with the single-server sections kept for home installs; the layout lists `desktop/` and `extension/`.

### Removed
- `BackupWidget.jsx`, a dashboard backup card that nothing has imported since the Home merge.

## [10.0.2] - 2026-11-03

### Changed
- **Outline numbering in builder boxes** (`styles.css`): numbered lists in a builder's rich boxes (`.rb-body`) and in the read-only previews of parts kept in the note (`.sb-rich-body`) number like notes do: 1. → A. → I. → a. → i. → (1) → (a), with the notes' indents. Tab and Shift+Tab nest and un-nest a list item (TipTap's list item keys). A nested list no longer adds a gap after itself.

## [10.0.1] - 2026-11-03

### Fixed
- **Logos links in builder boxes** (`sermon.js` `boxCanHold`): a part with a link to `https://ref.ly/…` (Scripture or a Logos resource, such as a dictionary entry) is an editable rich box again, not "edit it in the note"; the links are kept as they are. Links to other notes (`#note/…`, with `data-note-id`) and bare `logosres:` addresses still keep a part in the note.

## [10.0.0] - 2026-11-03

Builders as pages with rich boxes, and signing in with a username or email (two-step sign-in recommended, not required).

### Changed
- **Builders are pages in a tab**, not dialogs (`builderPages.js`, `BuilderPage.jsx`, `App.jsx`): `openSermonBuilder`, `openStudyBuilder`, `openReferenceBuilder` and `openLessonBuilder` keep their signatures but dispatch `noteapp:open-builder` and resolve at once. App has a `build` section (`buildOpen` { id, builder, startAt? }; hash `#build/<sermon|study|background|word|lesson>/<id>`), a tab per builder (`kind: 'builder'`, key `w<id>`, labelled "… · Builder" in `TopBar.jsx`, titled from the note and kept current on `noteapp:notes-changed`), and a Back/Forward place. A builder's `close` (✕, Save and close, Preach…) removes its tab and steps Back (or goes Home).
- **Saving as you go** (`useAutosave`): 1.5 s after the last edit and when the builder unmounts (another tab, Back, closing its tab); an edit made while a save is in flight marks it dirty again; with nothing to save, leaving remembers the step (`remember`). Leaving with changes saves instead of asking. Ctrl+S answers only when no dialog is over the builder (`builderKeyAnswers`); Esc no longer closes a builder. The lesson builder no longer re-reads its model from the saved HTML after a save (only the title/passage baseline), so a box being typed in isn't replaced.
- **Rich boxes** (`RichBox.jsx`): the note parts of every builder (sermon parts, Interpretive Journey fields, background/word study fields, lesson hook/took/leads) are a small TipTap editor (StarterKit without headings, code blocks or rules; Link with autolink; Placeholder): bold, italic, bulleted and numbered lists (toolbar or input rules) and links (paste, or Ctrl+K / the toolbar on a selection, through `dialog.prompt`; Ctrl+K is stopped from opening the palette, and flushes the DOM selection first). A Logos quote pastes as the quote with its citation, as before. Worksheet fields kept with a builder (structure, details, delivery notes…), bridging sentences and the big idea stay plain text areas.
- **Field model** (`sermon.js`): `rich` (edit it in the note) is now "anything a box can't hold" (`boxCanHold`: p, br, strong/b, em/i, u, s, code, a[href/target/rel] that isn't a note, Logos or ref.ly link, ul/ol[start]/li, blockquote, and `data-order` on p/li), so parts with lists and links are editable. `editField(f, value)` takes text (chips, photos, refreshed reiterations) or `{ html }` from a box (`edited`, `base`); `fieldOut` writes an edited field's HTML with delivery numbers carried from `base`; `boxHtml`, `appendText` (Photo adds paragraphs after what's there). `setField` in `bibleStudy.js` / `studyLayout.js`, `setPart`, and the lesson's `setText` and leads go through it.

### Added
- **Username and email** (`server/account.js`): setting `account_identity` { username, email, since }; usernames 3–32 of a–z 0–9 . _ - (lowercased), emails checked loosely. `GET /api/account/identity` (username, email, `ask`, `twoStepNudge`), `PUT` (needs a confirmed session; logged `identity-set` / `identity-changed`), `POST /api/account/identity/later`, `POST /api/account/two-step-nudge/off` (setting `two_step_nudge_off`). `GET /api/session` returns `signInName`.
- **Sign-in** (`security.js`, `Login.jsx`): once a username and email are chosen, `POST /api/login` takes `login` and refuses (after the password check, with one message, "That username or email and password don’t match.", logged as `sign-in-failed`) unless it's the username or the email (any case). The sign-in page shows **Username or email** when `signInName` (re-read whenever the app shows the sign-in page).
- **Setup link** (`tenant.js`, `SetupPage.jsx`): step 1 is **Account** (username, email, password; a reset link fills in the current ones); `POST /api/setup/finish` takes `username`, `email` and `skipTwoStep`. **Skip for now** on the authenticator step (marked Recommended) finishes without two-step sign-in (a reset that skips it turns the old authenticator off and clears the recovery codes) and opens Selah.
- **Asked once** (`IdentityDialogs.jsx`): after signing in, a Selah without a username asks for one and an email (**Later** doesn't ask again); **Settings → Account** shows and changes them.
- **Two-step reminder**: a card at the top of Home (`TwoStepNudge`: **Turn on…** opens the set-up dialog, ✕ puts it away for good) while two-step sign-in is off; Settings → Security marks it **Recommended**.
- `/control/health` returns `signIn` { username, email } for the admin console (Admin 3.1.0).

### Changed (security)
- **Two-step sign-in is optional on a hosted Selah**: `POST /api/security/two-step/disable` is refused only in the admin console (it was refused on every hosted Selah); Settings → Security shows **Turn off** beside **Move to a new phone…**.

## [9.2.1] - 2026-11-02

### Added
- **Study type on schedule rows** (`StudiesPage.jsx`): a reading whose note is a Bible study shows a chip (Passage Study, Background Study or Word Study) beside its kind. Items return `study_method` (`ITEM_SELECT` in `server/studies.js`: the note's `note_methods` method, `ggw` by default).

## [9.2.0] - 2026-11-02

Getting around: a regrouped rail, Back and Forward, preview and pinned tabs, and one New Study dialog.

### Changed
- **Rail** (`Sidebar.jsx`, `sidebarPages.js`): pages carry a `band` ('day': Home, Plan, Inbox; 'study': Walk, Bible, Preach); `orderedPageKeys` puts the day band first (each band keeps your saved order), and the rail draws a divider between the bands and before the Shelf. Prayer left the page list: Daily Walk and Prayer show `WalkTabs.jsx` under their headers, and Walk is lit on either. The WordPress site is never on the rail (it's under More). Utility is no longer a rail item: `PanelHead` gives the Shelf a Notebooks / Utility switch (`.rp-sides`), and the Shelf opens on Utility from the Trash, Templates, Tags or Attachments. Hiding 'utility' leaves the Shelf one-sided.
- **Tabs** (`App.jsx`, `TopBar.jsx`): no longer capped at eight (up to 30; the oldest unpinned goes after that). Notes open as a `preview` tab, which the next preview replaces in place; typing in the open note (a `beforeinput` in `.editor-area`, not a peek), double-clicking the tab, or double-clicking the note in the list (`NoteList` `onKeep`) keeps it. Desk studies and courses open kept. `pinned` tabs sort first, show a pin and no close button, and ignore middle clicks. Right-click: Keep open, Pin/Unpin, Close, Close others, Close to the right, Close all but pinned. Six show; the rest are under an "N more" menu, and the open tab always shows.
- **Desk** Study tab: **New study plan** (the self-study dialog, now titled so) beside **New study**. Ctrl+K's "Study a passage…" is "New study…"; Home's New menu has **Study…**; the Bible Studies tab's button and the passage page's **Study this passage** open the dialog too (`startStudy` now opens it).

### Added
- **Back and Forward** (`App.jsx`): a list of places (a note, a Desk study or course, Desk, a Bible page passage, any other page; a notes list with nothing chosen isn't one), up to 50; arrows in the top bar, Alt+← / Alt+→, and the mouse's side buttons (their browser navigation is prevented).
- **New Study** (`NewStudyDialog.jsx`, `openNewStudy`): one box for a passage, book or word; `guessKind` (Strong's number or Greek/Hebrew letters → word; a book name alone → background; any other reference → passage; anything else → word), three kind cards, **File under** an active self-study. Filed: the plan's unstudied reading of the same range is used, or a reading is added (`api.addStudyItems`), and the study is made with `study_item_id`. The builder opens at once; a toast says "Saved in Bible studies › plan" with **Show**.
- **Where a study lives**: `planOf()` in `biblestudy.js` (the self-study whose readings or notes hold the note) is returned as `plan` by `GET /api/notes/:id/bible-study` and every `getStudy`. Study notes show a path above them (Bible studies › plan › title; links to the Bible page and the plan), and the study builder's subtitle starts with it.

## [9.1.0] - 2026-11-02

Quick capture in Selah for Windows (desktop 9.1.0), and the tray icon's menu on a left click.

### Added
- **Quick capture page** (`/#capture`, `CaptureWindow.jsx`, rendered by `main.jsx` like the slides window and remote): **Note** (title, text, notebook; Inbox by default; no title → the first line, up to 80 characters) through `POST /api/capture`, or **Sermon bank** (title, text, kind, passage, topics with the bank's topics as suggestions, and an optional sermon in progress) through `POST /api/clip/bank` with the session (the clipper's routes take a session as well as a clipper key). Notebooks, topics and sermons from `GET /api/clip/info`, reloaded whenever the window comes back. Ctrl+Enter saves; Esc and saving call the app's `hide_capture`; signed out, it offers **Open Selah** (`open_main`). Destination and bank kind are remembered per device. Client `api.clipInfo` / `api.clipBank`.
- **Desktop 9.1.0** (`desktop/src-tauri/src/lib.rs`): a `capture` window (460×420, always on top, no taskbar button, the server's `/#capture`, other sites open in the browser; closing hides it so it reopens at once), opened from the tray's new **Quick capture** item or the global shortcut **Ctrl+Alt+N** (`tauri-plugin-global-shortcut` 2.4.1; if the shortcut can't be registered, the menu item shows no shortcut). Commands `hide_capture` and `open_main`; `write-capability.mjs` gives the `capture` window the same remote capability as `main`.

### Changed
- **Tray icon**: a left click shows the menu (`show_menu_on_left_click(true)`); a double click opens Selah (was: a left click opened it).

## [9.0.0] - 2026-11-02

The Library is removed, Home gets a verse of the day, the notes list shows which builder made a note, and study pages read in a centered column. Major version: a feature and its data are gone.

### Removed
- **The Library** (8.3.0): `server/library.js`, `LibraryPage.jsx`, `BookReader.jsx`, `bookText.js`, its CSS, the `/api/books*` routes and client calls, the rail entry, book tabs (`kind: 'book'`, dropped from saved tabs on load), `#book/<id>/<hid>` addresses (old `#library` links land on Home), the editor's plain-click `#book` links, the bank's `#book` sources, the book-position SSE exception, the backup check for book files, and the reference-study builders' **Library** quote button (`LibraryQuote`).
- **Startup purge** (`server/db.js`): when a `books` table exists, each book's file is deleted, `book_highlights` and `books` are dropped, sermon bank items with a `#book/…` source lose it, and `<a href="#book/…">` links in notes are unwrapped to their text. Reading notes (the Reading Notes notebook) and quotations stay as ordinary notes.

### Added
- **Verse of the day on Home** (`server/votd.js`, `GET /api/votd`): Bible Gateway's daily pick (`biblegateway.com/votd/get/?format=json`) is read for its reference only, kept in the `votd` setting for the day; if the feed can't be reached, a stand-in from a fixed list of 20 is used and the feed is tried again after an hour. Home's `VerseOfDay` card reads the text through the favorite translation (its own switcher, view `votd`), with the reference as a `.bible-ref` (hover card, Logos), the translation credit, **Study it** (`startStudy`), **New note** (`/api/capture` to the Inbox) and **Copy** (HTML blockquote + plain text). Shown or hidden with Customize (`votd`).
- **Builder chips in the notes list**: `GET /api/notes` returns `builder` (`BUILDER_SQL` in `routes.js`): the note's `note_methods` method, else `ggw` for a Bible study, `mcdill` for a sermon, the writing project's type (default `book`) for a chapter, or `lesson`. `NoteList.jsx` shows Bible Study / Background / Word Study / Lesson / Sermon / Chapter / Blog Post / Paper / Devotional, colored by workflow.

### Changed
- **Study pages on wide screens**: `.page.study-detail` (a study, teaching or preaching series, writing project, course or class) uses Home's centered 1144px column above 800px wide.

## [8.5.1] - 2026-11-01

A reading added without a passage can still be studied.

### Changed
- **Study it on every self-study reading** (`StudiesPage.jsx`): `canStudy` no longer needs a passage. A reading with no `ref` (and a title that isn't one) asks for the passage (`askPassage`), saves it as the item's `ref` through `PATCH /api/study-items/:id`, then goes on to the method picker and builder. Cancelling, or a reference that doesn't parse, starts nothing.

### Added
- Schedule item menu: **Set the passage…** / **Change the passage…** (prefilled) and **Remove the passage**, for every kind of study.

## [8.5.0] - 2026-11-01

Two new study methods beside the Interpretive Journey: a book's background and a word study, with Greek and Hebrew from STEPBible.

### Added
- **Methods** `background` and `word` (`shared/methods.js`, workflow `study`). Both are `bible_studies` rows whose method is kept in `note_methods`; `STUDY_SELECT` now returns `method` (default `ggw`). Background and word studies don't count toward `studiedChapters()` (the coverage map).
- **Background study** (`ReferenceStudies.jsx` `BackgroundBuilder`): The Book, Book and Author, Date and Setting, Audience and Occasion, Culture and History, Genre and Structure, Purpose and Themes, Scholars Compared (rows of question / view / held by / why, kept in `data.scholars` and written as a table; read back from the note's table when the study has no copy), Keeper. One per book: `POST /api/bible-studies` with `method: 'background'` stores the whole book as its passage and returns the existing study (`existing: true`) when the book has one. `data.facts` (first lines of author, date, audience, purpose) and the keeper show in the Interpretive Journey's Their Town step and on the passage page (`BackgroundCard`, `GET /api/background-studies?ref=`).
- **Word study** (`WordStudyBuilder`): The Word, Original Language (the verse word by word to click, a lexicon search, typed entry, a pasted Logos link), Translations (the verse in each connected translation; click or Shift+click words for the rendering, add others by hand), Range of Meaning (the lexicon entry, renderings across its uses, your senses), Usage (every use grouped as the same book, the same author (traditional attributions), the rest of the Bible; tick, give a sense, read the verse, add a note), In This Context (the sense chosen, meaning, reasons), Keeper. Kept in `data.word`, `renderings`, `senses`, `uses`, `chosen`, `count`, `allSenses`, `logos`; the generated parts are written into the note on each save. `newWordStudy()` asks for the verse and word and offers the existing study of the same Strong's number.
- **Fallacy check** (`wordStudy.js` `fallacies()`): rule-based flags for the root fallacy, illegitimate totality transfer (two or more of your senses named, or "every meaning"), anachronism (an English word built on the transliteration, allowing u→y and k→c), too few uses looked at, and no sense chosen. Flags only; never suggests wording.
- **Word library and hover cards**: `GET /api/word-studies`; `wordLibrary.js` caches it (refreshed on `noteapp:notes-changed`); `editor/WordMarks.js` decorates each study's lemma, transliteration (with and without accents), Strong's number (G26/G0026) and, when the study asks, its English word as `.word-ref`; `noteCards.js` shows the study's card on those and on links to word-study notes. Ctrl+click opens the study.
- **From the Interpretive Journey**: "Study a word from the passage" (steps 1, 3 and 4) opens a word study over the builder and adds its word, number and keeper under Important Words. Builders now answer Esc and Ctrl+S only when they're the top dialog.
- **Passage page**: a Background card and a Word Studies group (with Study a word); Your Studies lists passage studies only.
- **Library quotations in builder fields** (`LibraryQuote`): a highlight from a Library book, inserted as “words” (Author, Title, place).
- **Greek and Hebrew data** (`server/lang.js`, `server/lang/*.json.gz`, 8 MB): STEPBible-Data (Tyndale House Cambridge / STEPBible.org, CC BY 4.0): the TBESG/TBESH brief lexicons and the TAGNT (NA27/28 words) and TAHOT (Leningrad with Qere) tagged texts, in English verse numbering, NFC-normalized. Built by `scripts/build-lang-data.mjs <folder>`. Loaded on first use (about 60 MB) and released after 15 idle minutes. Routes `GET /api/lang/verse?ref=`, `GET /api/lang/search?q=`, `GET /api/lang/word/:code?ref=&all=1`. Credited in Settings → About and under the data in the builders.
- `client/src/studyLayout.js`: reading and writing study notes laid out in steps (fields as heading 2s, generated parts rewritten on save).
- Work-page prompts for both methods; the Bible Studies tab tags them by method.

### Changed
- Starting a Bible study now asks which method (Interpretive Journey, Background Study, Word Study) unless Settings or a series sets one.

## [8.4.0] - 2026-11-01

Copyright notices, credits and a notice for the people using Selah.

### Added
- **Scripture copyright notices in what leaves Selah**: Word documents (`docx/word.js`, after the text, before the bibliography), WordPress posts and devotionals (`wordpress.js` `scriptureNoticeBlocks`, small paragraphs at the end; a devotional's verse box counts with its version) now end with the publisher's notice for each Bible they quote, as Crossway, Tyndale and API.Bible ask. Quotations are found by the marks Selah puts after them ("— John 3:16 (ESV)", "(John 3:16 NLT)", "(KJV)"). In the app nothing changes: hover cards, panes and quotations already credit and link each translation, with its notice on the credit.
- `shared/bibleCopyright.js`: the ESV and NLT notices (moved from `server/esv.js` and `server/bible.js`, which import them) and `quotedCopyrights(text, translations)`. `GET /api/bible` translations carry `copyright` (an API.Bible Bible's comes from its most recent stored passage, else its name and API.Bible).
- **Settings → About**: *Credits* names citeproc-js (© Frank Bennett) and its Common Public Attribution License 1.0, with links to the license and the source, plus the other main open-source parts. On the hosted service, *About this service* says in a few lines that Selah is free and as is, what the person running the server can see, the nightly encrypted backup, that Bible text stays under its publishers' copyright, and to keep an export.

## [8.3.1] - 2026-11-01

### Fixed
- A Bible reference's hover card closed when one of its translation buttons was clicked: the card showed a one-line "Loading…" while the new translation came, shrank out from under the pointer, and the pointer "leaving" hid it. Now (`esv.js`, `show(el, { switching })`) the card keeps its text, dimmed, and its place until the new translation arrives, and ignores that leave; moving away afterwards closes it as before.

## [8.3.0] - 2026-11-01

The Library (note 69): EPUBs and PDFs read in Selah, each book in its own tab, with highlights, a reading note, quotations and the sermon bank.

### Added
- **`server/library.js`**: tables `books` (kind epub|pdf, title, author, shelf, storage in `files/`, contents JSON `{ toc, spine, cover, pages }`, position, progress, `note_id`) and `book_highlights` (loc = EPUB section path or PDF page, place, text, prefix/suffix (40 characters each side, kept untrimmed), rects (PDF, page fractions), color yellow|green|blue|pink, note). Routes: `GET/POST /api/books` (multipart, 200 MB, sniffed `%PDF-` or zip), `GET/PATCH/DELETE /api/books/:id` (delete moves the file to restore points; the reading note stays), `PUT /api/books/:id/position` (left out of live messages in `events.js`), `GET /api/books/:id/file` (ranges, for pdf.js), `GET /api/books/:id/section?p=` (spine items only), `GET /api/books/:id/res?p=` (images, sandboxed), `POST/PATCH/DELETE /api/books/:id/highlights[/:hid]`, `POST /api/books/:id/note`, `POST /api/books/:id/quote`.
- **EPUB reading**: `readEpub()` (container → OPF; DRM `encryption.xml` refused; metadata, manifest, linear spine, cover from `cover-image` or `meta name=cover`; contents from the EPUB 3 nav `toc` or the EPUB 2 NCX, pruned to the spine); `cleanSection()` (sax: a short list of tags, scripts/styles/forms/SVG dropped, ids prefixed `bk-`, pictures through `/res`, links inside the book as `data-href`, outside links in a new tab, noterefs marked). The three most recent books' zips are kept in memory.
- **Reading note**: one per book in the Reading Notes notebook (`Reading Notes: <title>`), made at the first highlight; each highlight is appended as a quotation plus a line linking `#book/<id>/<highlight>` with its place and note. Editing a highlight's note rewrites that line; deleting it removes the quotation and line (when still as written). Changes are broadcast for the note so open editors reload.
- **Quotations**: `quoteInto()` appends `<blockquote>` with “— Author, <em>Title</em>, place ↗” (the link back) to any note, after a version snapshot.
- **Sermon bank**: `POST /api/sermon-bank` accepts `source_url` (http(s) or `#book/<id>[/<hid>]`) and `source_page`; the board and the bank dialog open book links in the app.
- Client: `LibraryPage.jsx` (grid, shelf chips, drop to add, details dialog), `BookReader.jsx` (`EpubView`: section HTML, marks painted with `bookText.js` `anchorOf/locate/wrap`, position by section and scroll fraction, ←/→ at the ends, fragments; `PdfView`: pdf.js viewer in an iframe, `PDFViewerApplication.eventBus` `textlayerrendered`/`pagechanging`/`pagesloaded`, selection rects as page fractions, highlights drawn with inline styles since the viewer's CSP allows no `<style>`, clicks found by position). Selection bar (four colors, Note, Quote, Bank, Copy), highlight card, Highlights panel, Quote dialog (the reading note or any note via `NotePicker`).
- **Tabs and links**: books are app tabs (`kind: 'book'`, key `b<id>`); `noteapp.bookOpen`; `#book/<id>[/<highlight>]` opens a book (at a highlight), from the address bar at load, a link in a note (plain click), the sermon bank or `openLink()`. Rail page `library` after `scripture` (Bible).
- Backups: `checkUnpacked` counts books' files as needed.

## [8.2.0] - 2026-11-01

More Bible translations (note 69): the NLT and API.Bible beside the ESV, a favorite, and a switcher where text is read.

### Added
- **`server/bible.js`**, the translation layer over `esv.js`. Translation ids: `ESV`, `NLT`, `ab:<API.Bible id>`. `passage(q, tr)` answers in the ESV's shape (`[16]` verse numbers, blank-line paragraphs, poetry indented 2/4 spaces) plus `translation`, `translationId`, `credit { label, url }`, `copyright`. Routes: `GET /api/bible` (translations, favorite, providers), `PUT /api/bible/favorite`, `GET /api/bible/passage?q&t` (no `t`: the favorite), `GET /api/bible/usage`, `DELETE /api/bible/stored?t=NLT|apibible`, `PUT/DELETE /api/bible/nlt`, `PUT/DELETE /api/bible/apibible`, `GET /api/bible/apibible/bibles`, `PUT /api/bible/apibible/chosen` (up to 10). Keys are stored encrypted (`bible.nlt`, `bible.apibible`); the favorite is `bible.favorite`, falling back to the first connected translation.
- **NLT** (Tyndale's api.nlt.to, `/api/passages?ref&version=NLT&key`): `nltText()` reads its HTML (`p.body*` paragraphs, `p.poet1*/poet2*` lines, `span.vn` numbers, `span.sc` as capitals; `a.a-tn`/`span.tn` footnotes, headings and stray `<p>` dropped). One-chapter books are sent with their chapter (`Jude 1:3`). The key `TEST` is refused (it's the API's shared, IP-limited key). 5,000 lookups a day are counted in `bible_calls`.
- **API.Bible** (`rest.api.bible/v1`, header `api-key`): `/bibles` lists what the key may use (English first); passages are fetched as JSON (`include-titles=false`, `include-notes=false`) by USFM ids (`JHN.3.16-JHN.3.18`; a whole chapter per call, `PSA.23`, at most 6 calls) and read by `apiBibleText()` (para styles `q1/q2` as poetry, headings and `b` skipped, `char nd` in capitals, `note`/`f`/`x` dropped). Each response's `meta.fumsToken` is reported to `fums.api.bible/f3` with a random device id and a daily session id (no person identified). 5,000 lookups a month are counted.
- **`bible_cache`** (translation, ref): up to 500 verses per translation, least recently used dropped; API.Bible text older than 30 days is fetched again. Stored reads are logged free (`stored = 1`).
- **`/api/verses/passage?t=`**: the passage page in a translation (default the favorite), with `translation` in the reply. Psalm 119's second half is asked for as 101–176.
- Client: `esv.js` now `bibleInfo()`, `bibleConnected()`, `biblePassage(q, t)`, `bibleChanged()` (event `noteapp:bible-changed`), `viewTranslation/setViewTranslation(view)` (`noteapp.bible.<view>`), `creditHtml(p)` (the label linked to the publisher, plus API.Bible for its texts); `passageNoteHtml` / `passageInlineText` end with the passage's translation. `TranslationPicker.jsx` (`useBible(view)`, `TranslationPicker`, `Credit`).
- **Switchers**: hover cards (chip per translation, `hover`), the side panel's Passage tab (`side`), the builders' passage pane (`study`), the Scripture page (`passage`), the insert dialog (`insert`). Preaching pop-ins, Present mode, slides, the sermon builder's passage, memory verses and WordPress's verse fill use the favorite.
- **Settings → Connections → Bible** (`BibleDialogs.jsx`): favorite menu, ESV / NLT / API.Bible rows; `NltDialog` and `ApiBibleDialog` (key, then tick Bibles, search, usage and stored-verse meters, Forget). The near-limit toast covers each provider. `/bible` slash command (keyword; `/esv` still finds it).
- Test seam `NOTEAPP_BIBLE_TEST=1`: keys `nlttest-0000-0000-0000-000000000000` and `abtest00000000000000000000000000` answer with made-up text in each API's format.

## [8.1.0] - 2026-11-01

Clip to the sermon bank from the Edge clipper (note 69).

### Added
- **`POST /api/clip/bank`** (clipper key, in `CLIP_PATHS`): `{ html, url, page_title, kind, title, topics, passage, sermon_id }`. Pictures, SVG, video and audio are dropped before `cleanHtml` (a bank item is text); the title falls back to the first line, the passage to the first reference `findReferences` finds, the page title to the site name. Replies `{ id, title, kind, sermon }`.
- **`sermon_bank.source_url`, `source_page`, `for_sermon_id`** (added at startup; `for_sermon_id` is `ON DELETE SET NULL`). `addBankItem()` is shared by `POST /api/sermon-bank` and the clipper; `bankFields` takes `for_sermon_id` and checks the sermon exists.
- **`GET /api/clip/info`** also sends `sermons` (sermons being built first, then the latest 30) and `bankTopics` (topics already used in the bank). An older clipper ignores them; a new clipper against an older server keeps the Sermon bank tab off.
- **Clipper popup**: Notes / Sermon bank tabs (`dest`, remembered with `bankKind` in `chrome.storage.local`). The bank tab has Kind, Title, For a sermon, Topics (suggested) and Passage, and saves straight from the popup; with no selection, Add to bank stays off with a hint.
- **Arrange board bank**: items clipped for this sermon sort first, with a left accent and "Clipped for this sermon"; items from the web show their page as a link. The bank item dialog shows "From <page>".

## [8.0.0] - 2026-10-31

Sharing between tenants (the "Selah Sharing Plan (8.0)" note), with Admin 3.0.0, and a tidier note header on phones.

### Added
- **Contacts** (`server/sharing.js`, `share_contacts`): `POST /api/sharing/contacts { slug }` asks, `POST /api/sharing/contacts/:slug/accept` accepts, `DELETE /api/sharing/contacts/:slug` declines, cancels or removes (removing ends everything shared between the two). Two people asking each other connect at once. `ContactsDialog` (Shelf → Shared with me → Contacts) shows your Selah name, requests, contacts, waiting requests and what you share.
- **Sharing a note, notebook or project** live and read-only (`shares_out`, `share_people`): `GET` / `PUT /api/sharing/item { kind: note|notebook|study, id, people, allowCopy, allowComments }` (an empty list stops it), `DELETE /api/sharing/out/:id`. `ShareDialog` from a note’s ⋯ (**Share…**), a notebook’s menu (Shelf and Notebooks page) and a study’s or course’s ⋯ on Desk. A note in a shared notebook or project says so in its dialog, and its **Shared** chip opens that share.
- **Snapshots**: every 4 seconds (`NOTEAPP_SHARE_CHECK_MS`) each share’s notes are compared with the last snapshot sent (titles, `updated_at`, the people, the settings). When they differ, Selah writes `storage/sharing/out/<id>/snapshot.json` with the notes in reading order (a project: its schedule’s notes, then chapters, then its other notes), each with its page-view details (lesson, sermon or Bible study, method, passage) and attachments linked into `files/`, and queues it for the console. A note or notebook that’s gone stops its share.
- **The outbox** (`share_outbox`, numbered with AUTOINCREMENT so numbers never repeat; after a restore puts them behind the console’s, reading starts again from the first) and the control port’s `GET /control/sharing/outbox` (waits up to 30 s for a message), `POST /control/sharing/inbox` and `POST /control/sharing/state`. `/control/health` has `sharing` (on, contacts, counts). The admin console’s own database doesn’t get the tenant tables.
- **Shared with me** (`shares_in`, `shared_notes`): a snapshot from the console replaces the notes kept for that share. Links to the owner’s other notes become plain text, and images point at `/api/shared/:id/files/:att`, which serves only the share’s files; anything but plain images, PDFs, audio and video downloads, with a sandboxing CSP. `GET /api/shared/:id`, `/notes/:key`, `POST /seen`, `POST /copy { key? }` (when copying is allowed: the note, or the whole share as a notebook, with copies of its attachments, through `importPackage`).
- **`SharedPage`** (section `shared`, `noteapp.sharedOpen`, opened with the `noteapp:open-shared` event): the owner and title, a list of the notes for a notebook or project, and the note in a read-only editor (`buildExtensions` with `editor.storage.noteApp.fileUrl` for the share’s files; `Attachment.jsx` and `PdfReader` take it). Lessons, sermons and Bible studies show their 7.1 page header (`WorkMeta`, now exported from `NoteEditor.jsx`). On a phone the notes are a row of cards and the comments go below.
- **The Shelf’s Shared with me** section (`RailPanels.jsx`), grouped by person, with a dot on new or updated shares and the number of new replies, and Home’s **Shared with you** card (new and updated shares, and your notes with comments you haven’t read; Customize can hide it). `client/src/sharing.js` keeps one copy of `/api/sharing`, reloaded on live messages.
- **Margin comments** (`share_comments`): `POST /api/shared/:id/comments` (a new thread on the selected words, kept as the words plus up to 40 characters each side, or a reply in my thread), `GET /api/notes/:id/share-comments` and `/seen` for the owner, `POST /api/sharing/threads/:id/reply`, `/resolve { resolved }`, `DELETE /api/sharing/comments/:id`. `CommentThreads.jsx` lists them; `editor/CommentMarks.js` highlights each open thread’s words (found again by quote and context, `findQuote` in `sharing.js`), and clicking either goes to the other. The owner’s note has a comments chip and the side panel’s **Comments** tab. A comment stays with the owner after the share stops.
- **Notifications**: toasts for a new share, a comment, a reply, a contact request or acceptance, with Open; in the Windows app or with Selah in the background, a desktop notification too (not in focus mode).
- Icons `share` and `comment`.

### Changed
- **The note header on a phone** is one row (back, notebook, save status, lock, ⋯) with the tags and chips in a second row that scrolls sideways (`.note-meta-strip`). The side panel moves into ⋯ on a phone, and focus mode’s pen button is hidden there. The note’s page fills the space down to the tab bar however short it is.

## [7.3.0] - 2026-10-31

Fixes and enhancements from "Selah Features and Fixes".

### Removed
- **My Utmost for His Highest** is gone from Daily Walk, because its text is under copyright. `server/dailywalk.js` no longer fetches utmost.org. On startup it drops the `dw_utmost` table (the saved readings) and the `dailywalk.utmost` / `dailywalk.utmostIndex` settings. Old `utmost` read checks stay in `dw_reads` but no longer count, like a removed book's. The devotional library, EPUB books, connecting up to three, schedules, stats and journal notes all work as before. The Devotionals dialog lists only your books, and `PATCH /api/daily-walk/books/:id` no longer takes `utmost`. The journal template no longer has a My Utmost section; journal notes already written keep theirs.

### Added
- **Mark complete** on a builder's last page: Ready to Teach (lesson), Keeper (Bible study) and Oral Presentation (sermon), in the shared `MarkComplete.jsx`. The box says how many steps are still open, and **Mark not complete** undoes it. The mark ticks the last step in the step list. It's kept in the new `note_complete` table (`server/methods.js`): `GET` / `PUT /api/notes/:id/complete` with `{ complete }`. A sermon's status follows the mark (ready to preach or still building), and the Sermons page's **Mark ready to preach** sets the mark too. Home's Next up counts a marked lesson or sermon as ready.
- **Maintenance notice for users**: a banner across Selah, set in the admin console (Overview → Notice for Users; Admin 2.1.0). It has when maintenance starts and ends and when the banner starts showing, plus an optional note. The console sends it to each tenant (`POST /control/notice`, setting `user_notice`), and the monitor sends it again to any tenant whose copy is older (`health.noticeAt`). `GET /api/notice` returns it from its show-from time until the end, or 4 hours after the start when no end is set. `NoticeBanner.jsx` shows it at the top of the window and checks every 5 minutes. ✕ hides it until the notice changes or maintenance begins.
- **Only DRM-free EPUBs** is now a clear note in the Devotionals dialog and the empty Daily Walk card.

### Fixed
- **PDFs that stayed blank** (seen in the Windows app with ESV.pdf and Greek NT.pdf): attachment numbers are used again once the newest attachments are deleted. `/api/files/:id` and `/api/attachments/:id/thumb` were cached for a year as `immutable`, so a browser that had seen an earlier file under the same number kept showing it. In the Windows app, attachment 132 came back from its cache as a 94 KB PNG, and pdf.js reported "Invalid PDF structure". Both are now `private, no-cache`: a browser asks each time, and an unchanged file is a 304 (by ETag). Each browser also empties its cache once (`GET /api/clear-cache`, `Clear-Site-Data: "cache"`, remembered in `noteapp.cacheCleared`), which drops the stale copies.
- **The editor toolbar scrolls sideways** instead of wrapping onto more lines in a narrow window. A mouse wheel scrolls it too. The highlight, text color and table menus open on the page (`FloatingMenu` in `Toolbar.jsx`) so the scrolling row doesn't clip them.
- **Windows app 7.3.0**: **Attach file** uses the Windows file picker owned by Selah's window (`pick_files` / `read_picked` commands in `desktop/src-tauri/src/lib.rs`; `pickFilesNative` in `client/src/desktop.js`), so it opens in front instead of behind. Older Windows apps and browsers keep the page's own picker. The window's icons are loaded at the exact sizes Windows asks for, from the program's .ico (resource 32512), instead of one image scaled down, which looked distorted in Task Manager.

## [7.2.0] - 2026-10-30

Devotionals for the Scripture Blog plugin 2.7.0, which now hosts one devotional a day.

### Added
- **Post as a devotional** (`WordPressDialogs.jsx`, `DevotionalFields`): when the site's `scripture-blog/v1/info` lists `devotionals`, the posting dialog has **Post as: Blog post · Devotional**. A devotional has a **Day** (`devotional_date`, YYYY-MM-DD; defaults to tomorrow), the **Verse** (`verse_reference`, `verse_version`, default ESV, and `verse_text`, plain text with a blank line between paragraphs; **Fill in from the ESV** when the ESV is connected) and **Save as draft** or **Publish**. There's no schedule: publishing status is separate from the day, and readers see a devotional only once its day arrives. The dialog says that one devotional shows per day (the one edited last). Sent to `POST /wp/v2/devotionals` (`/{id}` to update) without `scripture_refs`; `sbt_bad_date` comes back as a plain message.
- **Notes in the Devotional method's shape fill the form** (`splitDevotional` in `client/src/wordpress.js`): the Scripture section gives the verse (an inserted ESV quote's "— Psalm 23:3 (ESV)" line, or a short first line that reads as a reference; verse numbers dropped), the Application section becomes `application` as simple HTML (paragraphs, lists, bold, italics, http/mailto links), and the rest of the note is the devotional's text, without a leading Reflection heading. A note with both Scripture and Application headings opens as a devotional. Once posted, the verse fields come from the site.

### Changed
- **`wp_posts.kind`** (`'post'` or `'devotional'`, migration in `db.js`): a note's record says what it was posted as. `GET /api/notes/:id/wordpress` reads the right collection and returns the devotional's fields; `PUT` takes `kind: 'devotional'`. Sending a note as the other kind makes a new item on the site (the dialog says so) and the note follows the new one. **Delete WordPress post…** deletes a devotional through `/wp/v2/devotionals/{id}`.

## [7.1.2] - 2026-10-26

### Changed
- **Cornell notes in the theme's colors** (`styles.css`): the sheet's header cells (Topic, Date, Course or study, Speaker, Cues and questions, Notes, Summary) use the sidebar navy (`--sidebar`) with `--sidebar-text`, through `--cornell-bar` and `--cornell-bar-line` on `table[data-cornell]`; in dark mode they step up to `--sidebar-active` so they stand off the page. The cue column is `--sand` with `--walnut` text instead of a 6% accent wash. CSS only; existing Cornell notes and edited templates pick it up as they are.

## [7.1.1] - 2026-10-26

### Changed
- **Daily Walk and Prayer are centered like Home** (`styles.css`): `.page.dw-page` and `.page.pr-page` take Home’s padding, `max(48px, calc((100% - 1144px) / 2))` at the sides, so all three pages share one 1144 px column in the middle of the window. Daily Walk’s left-aligned 1240 px cap (`.dw-page > *`) is lifted. At 800 px and below both use Home’s phone padding (18px 16px 40px).

## [7.1.0] - 2026-10-26

A simpler way around, from the Study Desk mockups: a slim rail, the notes library in panels, tabs along the top, Desk on Home, Plan, and lessons, sermons and studies read as pages.

### Changed
- **The rail** (`components/Sidebar.jsx`, `nav.app-rail` / `nr-*`) replaces 7.0.2's labeled sidebar: a 72 px navy column with the Selah letter (Cormorant Garamond), **Home**, **Shelf**, **Plan**, then your pages with short names (Inbox, Walk, Pray, Preach, Bible, Site), up to three **pinned notebooks**, **Utility**, and New, More and Settings (a sliders icon) at the foot. Badges as before (Inbox waiting, tasks due on Plan). The folded/unfolded sidebar (`noteapp.sidebarFolded`) is gone.
- **Pages on the rail** (`sidebarPages.js`): Home, Plan, Inbox, Daily Walk, Prayer, Preach (sermons), Bible (Scripture), WordPress; Desk is Home's tabs and Tasks is part of Plan, so neither has a place of its own. The notes rows (All notes, Notebooks, Tags, Attachments, Templates, Shortcuts, Trash) became the Shelf and Utility. In focus mode Home opens Desk when Home itself is hidden but Desk isn't. Focus mode hides Utility by default.
- **Customize the rail** (`SidebarDialog.jsx`, under More): pages and their order as before, Utility, and the three pinned notebooks (pref `railNotebooks`, ids).
- **Tabs along the top of every page** (`components/TopBar.jsx`, `noteapp.openTabs`, up to eight; 7.0's `noteapp.noteTabs` carry over): notes (typed lesson, sermon, Bible study or note from the editor's `noteapp:note-kind` event, each with a colored dot) and studies or courses opened on Desk (`noteapp:desk-open`). Shown with one open; no tab is selected on a page. Closing the open tab opens its neighbor. Search (Ctrl+K) sits at the right. The 7.0 tab row above the note is gone. Hidden on a phone.
- **The layout** is a grid at 801 px and wider: the rail over both rows, the tab strip across the top, then the note list and note (or the page).
- **Home** (`pages/HomeTabs.jsx`, shared with `DeskPage.jsx`): a greeting header with Desk's tabs under it (Home · Study · Teach · Write · Learn, with counts under way); Desk is Home on one of those tabs. The Home tab is two columns: the Daily Walk banner (Read, Journal), **Next up** as rows with readiness and Open and Teach/Preach (a lesson or sermon opens as its note), This week with Open Plan on the left; Pick up, Pinned and the status line on the right. Its search box moved to the tab strip.
- **Plan** (`CalendarPage.jsx`, still `#calendar`): the calendar with a task panel (`components/PlanTasks.jsx`): Overdue, Today and No date, a quick-add box and a list filter (`noteapp.plan.list`). Rows drag onto the calendar (FullCalendar `Draggable` + `drop`) to set the due date, and the time in the week and day views. **All tasks** opens the Tasks page, which has a **Plan** button back. Phones keep the calendar alone.

### Added
- **The Shelf** (`components/RailPanels.jsx`, `.rail-panel` / `rp-*`): a panel beside the rail with search, All notes, Shortcuts, each shelf (fold state `noteapp.shelfFolded`; click the name for the shelf's notes) with its notebooks (a color swatch, the count, a pin) and the notebooks on no shelf; New notebook and New shelf. Drop a note on a notebook to move it, a notebook on a shelf to shelve it; right-click for the notebook and shelf menus. Esc or a click outside closes it; on a phone it fills the screen above the tab bar.
- **Utility**: templates (the three last changed, See all, New note from template…), the three newest attachments (opening their note), tags by use (eight, then + more; Manage), and the Trash.
- **Pinned notebooks** on the rail: a colored letter each (the color follows the notebook's id, on the Shelf too); drop a note on one to move it there; right-click for New note, Rename and Unpin.
- **Lessons, sermons and Bible studies as pages** (`NoteEditor.jsx`, `editor/WorkSections.js`): above the title, what it is and its method (e.g. "Lesson · Hook, Book, Look, Took"), its builder button, and Teach or Preach; under it, the passage (opens the side panel's Passage tab), a sermon's length (130 words a minute), "N of M sections written" with a ring and a bar per section. Decorations only, the note isn't changed: the method's section headings as small capital labels (a sermon's divisions as serif headings), a "Big idea:" (or Principle, Keeper, Proposition, Theme) paragraph as a callout, Title and Verses lines in small print, and an empty section greyed with a prompt for its method's step. The builder chips in the note bar give way to these buttons on such notes.
- Icons: shelf, grid, plan, sliders.

## [7.0.2] - 2026-10-26

### Changed
- **One sidebar** instead of the rail and the notes list (`components/Sidebar.jsx`, `.app-side` / `as-*`): a 236 px navy sidebar with Selah's name, **Search** (Ctrl+K) and **New** at the top, a labeled row per page (Inbox and Tasks counts as pills), a **Notes** section (All notes, Notebooks, Tags, Attachments, Templates, with counts) and **Shortcuts**, and Trash, **More** and Settings (with the version) at the foot. Notebooks, Tags, Attachments, Templates and the Trash are now reachable from every page; `.notes-nav` and the 76 px `app-rail` are gone. Hidden pages, page order, focus pages and right-click menus work as before.
- **Fold to icons**: the ‹ button folds the sidebar to a 68 px icon column (names on hover, badges as dots, Shortcuts hidden), kept per device (`noteapp.sidebarFolded`); a window 1100 px wide or less is always folded. Folding fires a resize so the calendar measures again.
- **Phone**: the tab bar is its own element (`nav.ar-tabbar`); More slides the whole sidebar in as the drawer.
- **Home** runs to the window's edge (its scrollbar was in the middle of the screen beside an empty strip): the content keeps its 1144 px width, centered by padding, instead of `max-width` on the scrolling page.

### Fixed
- **Menus off screen on a phone**: a note's ⋯ menu (about 800 px tall) and the long-press menu ran below the screen and under the tab bar. On a phone (800 px or narrower) both kinds of menu now open as a **sheet** along the bottom over a scrim, scrolling inside when long (`.menu.is-sheet`, `.menu-scrim`; the dropdown sheet is portaled to `<body>`). On a computer a dropdown opens upward when there's more room above and scrolls when it's taller than the room it has; a right-click menu is kept inside the window and scrolls past its height, and scrolling inside a menu no longer closes it.

## [7.0.1] - 2026-10-26

### Changed
- **Home**: the Dashboard and Desk's Home are one page (`pages/HomePage.jsx`, still the `dashboard` section), laid out like the study desk mockup: the date and "Your desk", a search box (Ctrl+K), Customize and **New** (note, task, event, Desk); a navy **Daily Walk** banner with today's unread readings and the streak (`/api/daily-walk`), which shrinks to a "Today's reading is done" check once read; **Next up** cards from `/api/desk/home` (lessons with Hook/Book/Look/Took bars and what they need, sermons, writing toward its goal, studies' pace, classes' due count), opening the study on Desk; **This week**, one list of the next seven days with overdue tasks first: events (category filter kept), tasks with a tick box and Desk's dated items (a Desk item's own task is shown once, as the item: `/api/desk/home` week entries carry `task_id`), with the task quick-add; **Pick up where you left off** (Desk's notes and recent notes, newest first) and **Pinned** notes; and a status line with space used and the last host or off-site backup, in color when something needs a look, opening Settings.
- **Customize** on Home shows or hides each part (pref `home`: `{ hidden }`); the Dashboard's layout editor (drag, columns, widths, heights) is gone. Coming from the Dashboard, a hidden Pinned widget stays hidden, Storage and Backups both hidden hide the status line, and the schedule, week and tasks all hidden hide This week.
- **Desk** has no Home tab and opens on the tab used last; Settings' **Desk opens on** is gone (`deskPrefs.js` removed), as is Ctrl+K's "Desk: Home".
- "Dashboard" is **Home** throughout: the rail, Customize sidebar, focus pages, and **Pin to Home** / **Remove from Home** (still `dash_pinned`).

### Removed
- `pages/Dashboard.jsx` and `pages/DeskHome.jsx`.

## [7.0.0] - 2026-10-26

A new look: the study desk. Everything works as before; what changed is how Selah looks and where some things live.

### Changed
- **The rail** replaces the sidebar (`components/Sidebar.jsx`, default export still `Sidebar`): a 76 px navy rail (`--rail` tokens, light and dark) with a button per page (short labels, full names on hover, Inbox and Tasks counts as badges), Notes, **More** (hidden pages, focus mode, Customize sidebar, Refresh), and Search, New (note / from template) and Settings at its foot. Your hidden pages, page order and focus pages apply as before. Its classes are `app-rail` / `ar-*` (Tasks and the passage page keep their own `.rail-item`).
- **The notes list** (`.notes-nav`) shows beside the rail in Notes (`NOTES_SECTIONS`: notes, notebooks, tags, attachments): All notes, Notebooks, Tags, Attachments, Templates, Shortcuts (drag and drop as before) and the Trash, on paper instead of navy.
- **The layout** is a flex row (rail, notes list, note list, note or page) instead of a fixed grid. On a phone the rail is a **tab bar** (your first two pages, New, Notes, More) and More opens a drawer with every page and the notes list; the menu buttons in page headers are hidden there.
- **Notes are pages on the desk**: the open note is a paper sheet (border, 18 px corners) on the desk color, its title in **Source Serif 4**, and note text in the serif by default (**Settings → General → Note text**: Serif or Sans, per device, `data-note-font` on `<html>`; code, tables and citations stay in the sans). Headings in notes use the serif too.
- **Type and shapes**: **Inter** for the interface and Source Serif 4 for page titles, the notes list, dialogs and reading (both bundled with `@fontsource`, no outside requests); larger rounded corners on buttons, inputs, cards, menus and dialogs; page titles 32 px serif; the note list as cards on the desk.

### Added
- **Open notes as tabs** above the note (`noteapp.noteTabs`, up to eight): click to switch, × to close; a trashed note's tab goes.
- **The side panel** (`components/SidePanel.jsx`): one panel beside the note with tabs, **Outline** (the note's headings, click to jump), **Passage** (the references in the title and text via `findReferences`, the ESV text of the one picked, Insert as a quotation, Open in Scripture, look up another), **Sources** (writing projects) and **Revise**, replacing the separate Sources and Revise panels. A panel button by Saved opens it at the tab used last; the Sources and Revise buttons still open theirs.

### Fixed
- The Tasks page's own side list stacked each icon above its label (a passage-page rule for `.rail-item` applied everywhere); it's scoped to the passage page and the weekly review now.

## [6.6.0] - 2026-10-26

### Added
- **Writing project types** (a fourth workflow in `shared/methods.js`): Book (`book`: chapters start blank; front and back matter), Blog Post or Series (`blog`: Hook, Body, Takeaway), Research Paper (`paper`: Introduction, Conclusion, Bibliography, Turabian) and Devotional or Article (`devotional`: Scripture, Reflection, Application, Prayer). Each names its pieces (`piece`/`pieces`) and gives each section the question it answers (`ask`). `skeletonHtml(id)` lays out a new piece. The project's type is `data.methods.writing` (**Project type** in Edit); a new piece uses `chooseMethod('writing')`, so a project without a type asks (with "Use it for every piece"). `POST /api/studies/:id/chapters` takes `method` and `matter`, and records the method. A paper started from a class assignment is typed `paper` with its skeleton. Notes in a writing project get their type from the project (`methodOfNote`); **Switch method…** works on pieces (an untyped piece reads as a book chapter).
- **Front and back matter** for books: `study_notes.matter` ('front' | 'back'), added from **Front matter** / **Back matter** menus (Preface, Introduction, Appendix, Bibliography…) and set from a chapter's ⋯ menu. Front matter sits before the chapters and back matter after them (`renumber` keeps positions whole); they show F and B instead of a number.
- **Stages**: Idea, Research, Outline, Draft, Revise (`revised`), Edit (`edited`), Final, each with a short checklist about the process (`STAGES` in `components/WritingBoard.jsx`; ticks in `study_notes.checks`, keys like `draft.pass`). **List / Board** in a project, and **Projects / Board** on Desk → Write (`GET /api/writing/board`): columns by stage, drag a card to move it, the checklist on each card.
- **Revise panel** (`components/RevisePanel.jsx`), from the marker button on a writing piece or **Revise…** in any note's ⋯ menu, beside the text where Sources goes (one at a time). Rule-based, in the browser, no AI, and no wording suggestions: explanations are observations or questions. `client/src/revise.js` (`analyze`, `docBlocks`, `readingSentences`): Flesch–Kincaid grade, long sentences (limit setting), passive voice (a form of *be* + participle, with irregulars), -ly adverbs (with an exceptions list), filler and hedge phrase lists, repeated content words within 50 words (names skipped), your own words to watch, and for papers Turabian checks (quotation with no footnote, source-like claim with no footnote, quotations of 60+ words, contractions). Quotations (“…”, "…"), block quotes, code and citations are masked out of every check and of the reading figures. `editor/ReviseMarks.js` draws the highlights as decorations; clicking one opens its explanation. Tabs: **Overview** (figures, words changed since the last marked draft), **Highlights** (toggles, step through, dismiss per note in the pref `reviseDismissed-<id>`; settings in the pref `revise`), **Cut** (target percentage, words to go, paragraphs ranked by marks per hundred words), **Drafts** (**Mark this draft…** = a version with reason `Draft: …`, compare any two with `wordDiff`), **Structure** (the type's questions, words per section) and **Read aloud** (`speechSynthesis`, highlighting each sentence).

### Changed
- Version history thinning (`thin` in `links.js`) never drops a marked draft.
- New pieces are titled by type (New post, New part…); the project heading names them (Chapters, Posts, Parts).

## [6.5.0] - 2026-10-26

### Added
- **Methods**: a registry of the methods each workflow can follow (`shared/methods.js`): Bible study → the Interpretive Journey (`ggw`), lesson → Hook, Book, Look, Took (`hblt`) or Big Idea and Three Points (`points`), sermon → McDill's twelve essential skills (`mcdill`). Each method has a name, source, "best for", step names, its builder, and its sections (heading level, a match pattern and roles) for switching. Plain data, shaped so template-based methods can be added later.
- **Method picker** (`components/MethodPicker.jsx`, `chooseMethod`): starting a lesson, sermon or study asks which method to use (a card per method, plus your templates for lessons) when there's more than one. The method used last is preselected (pref `methodLast-<workflow>`), and **Use it for every lesson in …** saves it as the series' method. The picker is skipped when the series or course sets a method, when Settings sets a default, or when there's only one choice. Wired into Write lesson (Studies, courses, passage page), lessons from a study (Take It Further, course weeks), New sermon, a sermon series' sessions, sermons from a study, and every new study.
- **Defaults**: Settings → General → Desk → **New lessons use** (Ask each time or a method; pref `methodDefault-<workflow>`, shown only for workflows with a choice). A series' or course's method: **Lessons use** in Edit study and Edit course (teaching keeps `data.lessonLayout`, now nullable for Ask each time), with **Sermons use** / **Studies use** (`data.methods`) appearing once those have a choice. New teaching series and courses start on Ask each time; existing ones keep their layout.
- **Switch method…** in a lesson's ⋯ menu (any note whose workflow has another method): `convertHtml` in `client/src/methods.js` cuts the note at its method's section headings, matches each to a role, and fills the new method's skeleton by role. Headings one level down that name a section of the new method go back to it, "Big idea: …" in an exposition becomes the Big idea section (and back), and anything with no place goes under **Other notes** with its heading. Done in the editor, so Ctrl+Z undoes it; the lesson builder chip follows the new layout at once.
- **Which method a note follows**: new `note_methods` table and `server/methods.js` (`GET/PUT /api/notes/:id/method`), recorded when a study, lesson or sermon is made. Older notes get theirs detected (a Bible study, a sermon, or a lesson by its headings). `POST /api/bible-studies`, `/api/sermons`, `/api/study-items/:id/note` and `/api/bible-studies/:id/lesson` take `method`; `lessonHtml(item, study, method)`.

## [6.4.1] - 2026-10-26

### Changed
- **Long dropdowns**: a single `<select>` with more than 10 options opens a compact searchable list instead of the browser's own (search box, up to 360px tall and scrolling, opened at the current choice; arrows, Page Up/Down, Enter, Esc). One page-wide listener in `components/SelectPicker.jsx`, mounted by `DialogProvider`, so every select in Selah and the admin console gets it with no changes where they're used: picking sets the select's value and fires a real `change` event. Short lists, touch screens (the phone's own picker) and multi-selects are left alone.
- **Pick-one dialogs** (`dialog.choose`, e.g. Move to notebook…): with more than 8 choices, a search box and a compact scrolling list; Enter picks the top match, double-click picks at once.
- **Desk → Home**: This week is one panel with lines between the days instead of seven tiles (rows on phones).
- **Desk tabs** no longer show counts; the Home tiles already do.

## [6.4.0] - 2026-10-25

### Added
- **Desk → Home**: a dashboard tab before Study, Teach, Write and Learn. Tiles per tab (count under way; behind / next teaching day / words written / due this week and overdue) that switch to the tab; **This week**, seven day columns (a list on phones) of every undone dated item from the studies under way, colored by study, with a count of earlier items not done; **Next up**: the next session of each teaching or sermon series and course with its lesson's readiness (*Not started*, *Needs* Hook/Book/Look/Took, *Ready*, from `lessonSummary`) and the level of learning it reaches, self-studies' pace with a ring, writing projects' words toward their goal, and classes' due count; **Continue where you left off**: the six notes last edited across the studies under way (lessons, sermons, Bible studies, chapters, notes), opened in the peek panel. **New** on Home offers every kind. Studies opened from Home go back to Home. New `server/desk.js` (`GET /api/desk/home`), `client/src/pages/DeskHome.jsx`.
- **Desk opens on** (Settings → General → Desk): Home (the default) or the last tab used; a server pref (`deskOpensOn`), so it follows you. Ctrl+K's **Desk: Home**; Ctrl+K's other Desk tabs still open their tab.
- **Levels of learning explained** in the lesson builder: each level has a plain explanation, how its questions start, and an example (`LEVELS[].explain/starts/example` in `course.js`). Clicking a rung on the meter shows its card with how many of the lesson's questions are there; clicking a question's level opens the card as a popover with the five levels to pick from (replacing click-to-cycle). Escape closes just the popover.

### Changed
- **Desk cards** (study, course, class): a progress ring in the corner instead of the bar (a class with grades shows its letter grade), a wash of the study's color at the top, and the next item as a pill. New `components/Ring.jsx`.

## [6.3.0] - 2026-10-25

### Added
- **Restore from a backup** (Settings → Data & backup → **Restore from a backup…**, or the link at the top of the Trash): pick a day, browse its notebooks and notes (search, read a note's text, tags and attachment names), tick whole notebooks or single notes and bring them back **as copies**. Nothing here now is changed. Each note says what it is now: *Deleted since*, *In the Trash*, *Changed since* or *Same as now*. A whole notebook comes back as a new notebook (named "… (restored Oct 20)" if the name is taken); single notes go to their notebook (or one you choose), marked "(restored Oct 20)" only if the title is taken there. Links between restored notes point at the copies; tags come back; attachments come from this Selah, from removed files kept with the restore points, or from the off-site backup. New `server/restorepoints.js`, `server/notepack.js` (note packages: notes out of one database into this one, as copies), `client/src/components/BackupRestoreDialog.jsx`.
- **Daily restore points**: every Selah keeps a copy of its database each day for 14 days (`NOTEAPP_RESTORE_DAYS`), in `restore-points/` on the notes disk, made within half an hour of the server starting each day. Attachments deleted forever are moved there instead of deleted (`unlinkStorage`), and kept as long. Neither counts toward a storage quota or goes into backups (they're made from the database and files).
- The **off-site backup's** own 30 days of snapshots are offered too when it's connected (downloaded and decrypted only when opened).
- **Selah notebook files (.selahnb)**: a new export format (Export… → **Selah notebook**) with the notes exactly as they are, their tags and attachments, in one file (a zip of `selah.json` and `files/`). **Settings → Data & backup → Import → Selah notebook** brings one into any Selah as new notebooks ("… (imported)" if the name is taken). New `server/notebookfile.js`; `zip.js` gains `zipEntries`/`extractEntry` to read large zips from disk.
- **Trash**: notes are grouped by the notebook they came from, each group with **Restore all**. A notebook that was deleted is remembered (`notes.trash_notebook`) and made again, on its shelf, when its notes are restored, instead of the notes landing in the first notebook. **Restore … to…** in the selection menu picks a notebook. **Keep deleted notes** at the top of the Trash: until it's emptied (as before), or 30, 60 or 90 days (`trash_days`; emptied hourly), with "12d left" on each note. Cards say "Deleted …". New `POST /api/trash/restore`, `GET/PUT /api/trash/settings`.
- **Security log**: "Notes restored from a backup", with where from.

### Changed
- The off-site backup's storage choices (OneDrive, S3-compatible, WebDAV) are a shared component (`StoragePicker.jsx`), also used by the admin console's host backup.

## [6.2.2] - 2026-10-25

### Added
- **Find in note** (Ctrl+F, or **Find in note…** in the note's ⋯ menu): a bar over the top right of the open note highlights every match as you type (case-insensitive, decorations only, so the note isn't changed), with "3 of 12", Enter / Shift+Enter or ↑ ↓ to step, and Esc to close with the cursor on the match. Works in read-only notes; a match in a collapsed heading opens it. Selected text (one line, up to 100 characters) fills the box. The open note takes Ctrl+F when the key is typed in it or nowhere in particular (not in another field, a dialog or a peek); a peek takes it only from inside. New `client/src/editor/FindInNote.js` (plugin `findInNote`) and `components/FindBar.jsx`.

### Changed
- **Note ⋯ menu**: Present, Preach/Teach, Sermon builder and Study builder show only on builder notes: a sermon, a Bible study, a lesson in the Hook/Book/Look/Took layout, or a note in a lesson, sermon or writing workflow (`builderNote` in NoteEditor). Ordinary notes no longer list Present, Preach, **Open in the sermon builder…** or **Open in the study builder…**; start sermons and studies from Sermons, Desk or a passage.

### Fixed
- Unlocking a read-only note and switching notes in the same moment threw "Cannot read properties of null (reading 'commands')" (focus on a destroyed editor).

## [6.2.1] - 2026-10-25

### Fixed
- **Devotional EPUBs laid out with paragraph styles** (InDesign exports such as Crossway's *Daily Doctrine*) were rejected as having no daily readings: their days are `<p class="_Day-Number">Day 21</p>`, not headings. A paragraph that says only "Day N" (or a date) now marks a day too, and a styled title paragraph right under it (`class="…title…"`, e.g. `_Day-Title`) becomes the day's title. *Daily Doctrine* reads as 260 weekday readings.
- In those books, footnote references (`_Footnote-Reference`, `epub:type="noteref"`) show as superscripts, footnotes (`_Footnote-…` paragraphs) as small notes under a rule, and `_Smallcaps`, `_Italic` and `_Bold` spans as small caps, italic and bold.
- The last day in each page of such a book ended with a stray "&lt;/div&gt;": the section's closing tag closed the cleaner's root. Closing tags with nothing open are now dropped first (`dropStrayCloses`).
- A "Week 6" marker before a day no longer sits at the end of the day before.

### Changed
- Daily Walk tabs and stats name a book without its subtitle ("Daily Doctrine", not "Daily Doctrine: A One-Year Guide to Systematic Theology").

## [6.2.0] - 2026-10-25

### Added
- **Daily Walk shows one devotional at a time**, in tabs (pills above the reading, with a read check on each; dimmed when the book has nothing that day). The last tab picked is remembered on the device (`noteapp.dailyWalkTab`); 1–3 switch tabs. Once a reading is marked read, **Next: …** goes to the next unread one. An **Add** tab opens Devotionals while there's room.
- **Connected devotionals, at most 3** (`MAX_CONNECTED` in `server/dailywalk.js`; My Utmost counts as one). The Books dialog is now **Devotionals**: the whole library with a Connected switch each, a meter, Schedule and Remove. A book added while three are connected goes into the library unconnected. My Utmost can be disconnected (setting `dailywalk.utmost` = `off`), in preparation for removing it. Disconnected sources keep their read history but leave the page, the journal template and the streak. `PATCH /api/daily-walk/books/:id` (`utmost` or a book id) takes `{ connected, schedule, start_day }`; `GET /api/daily-walk/books` now returns `{ max, books }` with My Utmost first.
- **EPUBs headed by day number** ("Day 1", "DAY 12: Title", "Day 45 — Title", in h1–h3). By the highest day number: **365/366** follow the calendar (stored by month and day from a common/leap year, so a 366-day book's Feb 29 shows only in leap years and a 365-day book has none); **260** follow the year's weekdays, day 1 being its first weekday (schedule `weekdays-year`; a year's 261st/262nd weekday has none); **any other length** asks, on upload, for **Every day** or **Weekdays** from a Day 1 (default: the upload day, sent as `?today=`), with the finish date shown; "Don't add it" removes the book. Schedule can be changed later. New columns `dw_books.schedule/start_day/length/connected` and `dw_entries.num`; numbered books keep `#<n>` in `dw_entries.mmdd`. The card's byline shows "Day N of L"; a day without a reading says why (weekend, not started, finished).
- The EPUB reader now finds every day heading in a page, not only the first, so books with several days per file work; dated headings may also carry a weekday, an ordinal or a title ("Monday, October 19th: …"). A title taken from the heading under "Day N" isn't repeated in the body.

## [6.1.0] - 2026-10-25

### Added
- **Off-site backup to more kinds of storage** (Settings → Data & backup → Off-site backup): besides OneDrive, any **S3-compatible** service (Backblaze B2, Wasabi, Cloudflare R2, Amazon S3, or another with its endpoint) or a **WebDAV** server (Nextcloud, Synology, Koofr…). Setup starts with a choice of three; each kind shows the boxes it needs and where its keys come from. **Test connection** writes and removes a small file in the backup folder before the passphrase is chosen, and setup does the same check. B2 uses rclone's own backend with `hard_delete` (so pruned snapshots aren't kept and billed as hidden versions); the others use the S3 backend with `no_check_bucket`, for keys limited to one bucket. Endpoints and WebDAV servers must be https and resolve to public addresses (`server/netguard.js` `checkPublicHost`; `NOTEAPP_FETCH_ALLOW` lets a home-network host through). Keys and passwords are kept only in `rclone.conf`; the settings keep the kind, bucket, endpoint, region, address and user name for **Change…**, which signs in again or moves the backup elsewhere. The dashboard widget, Settings, the admin console's tenant view and messages name the storage instead of saying OneDrive.
- **Download a backup** (Settings → Data & backup, and Account → Download all my data): a fresh snapshot of everything as one file, after confirm-it's-you. **Encrypted** (recommended) it's a `.selahbak`: the archive under AES-256-GCM with a key from scrypt (N 2^17) of a passphrase chosen in the dialog, plus a check value so a wrong passphrase is caught at once, and the tag catches a damaged or altered file. **Not encrypted** it's a `.tar.gz` any zip tool opens. Inside: `selah-backup.json`, `README.txt`, `notes.db`, `files/`, `config/wordpress.key` (and a home server's `config/certs/`). It's streamed (no 4 GB limit, nothing kept on the server), one at a time, through a one-time two-minute ticket bound to the session; the last download is shown in Settings, in the admin console, and in the security log (`backup-download`). Format and reader in `server/backupfile.js`, routes in `server/backupdownload.js`. It replaces the zip from "Download all my data".
- **Restore from a backup file**: `npm run restore -- --file <file>` (asks for the passphrase; also takes the nightly `data/backups/note-app-*.tar.gz`). The file is unpacked and checked completely in a scratch folder (passphrase, tag, database integrity, every attachment the database refers to) before the old data is moved aside and the backup put in place. Sessions, setup links and deletion requests don't come back with it. For tenants, see the console's 1.1.0.
- `npm run restore` asks where the off-site backup is (OneDrive, S3-compatible or WebDAV) and takes that storage's sign-in.

### Fixed
- On S3-compatible storage, setting up off-site backup with a different passphrase over an existing backup was allowed, which would have left the folder with two keys: `rclone cat` of a file it can't find prints nothing and succeeds there (OneDrive fails). Empty output now counts as "can't open" in setup, Test passphrase and `npm run restore`.
- `rclone obscure` ran with `--config /dev/null`, which rclone refuses on Windows; it now uses an in-memory config (`--config ""`).

## [6.0.4] - 2026-10-25

### Fixed
- **Downloading the web clipper** (Settings → Browser extension → Download the extension) failed on cloud tenants with a server error (`ENOENT: scandir '/app/extension'`), which the browser showed as a blocked download: the `extension` folder was left out of the release copy (`server/admin/releases.js`) and the container image (`.dockerignore`). Both now include it.

## [6.0.3] - 2026-10-25

### Fixed
- **Off-site backup on a tenant** (Settings → Data & backup → Connect OneDrive) failed every run with "directory not found": it tried to upload the server's TLS certificates folder, which a tenant doesn't have (the gateway handles HTTPS). The certificates are now uploaded only when the folder exists, the manifest records whether they were (`certs`), and `scripts/restore.js` skips them for a backup that has none.
- `scripts/cloud-push.sh` refused to run from Git Bash on Windows, saying every script had Windows line endings: Git Bash drops a `$'
'` inside `$(...)`, so the check searched for an empty pattern. CR is now held in a variable and grep runs with `-U`.

## [6.0.2] - 2026-10-25

### Added
- **Section headings in the lesson builder's Book outline**: **Add a section heading**, `## ` at the start of a line, or the H2 button beside a line (which turns a heading back into a point too). Each heading is written as a Heading 2 with its own numbered list after it, so it shows as an H2 in the note and in Teach mode (where it folds like any heading). Existing lessons whose Exposition already has Heading 2s between or just above its lists read them as section headings; headings followed by other writing stay with that writing. Headings don't count as points (point counts, timing estimate, slides).

### Changed
- Teach mode (and preaching mode) number nested lists as the note does: 1. → A. → I. → a. → i. → (1), instead of 1. → 1. → 1.
- The builder's outline labels match the note's numbering too (1. A. I. a. i. (1), was 1. a. i. 1)), and start again at 1 after a section heading.

## [6.0.1] - 2026-10-25

### Added
- **Cloud hosting**: the admin console, gateway and tenants run on a rented server, with tenants as Docker containers and a public **Let's Encrypt wildcard certificate** that the gateway gets and renews itself, proving the domain through **Cloudflare DNS** (`init --tls acme`). The Cloudflare token is kept only in the gateway's settings file (mode 600) and passed to Caddy as an environment variable, never written into its config or the console's database. HSTS is on for the console and every tenant.
- `scripts/cloud-setup.sh`: prepares an Ubuntu server for hosting (Docker with containers unable to reach each other, capped logs and live restore; port 443 for the gateway without root; HTTPS through the firewall; linger; pinned, checksummed Node.js 24.22.0; rclone; Caddy; npm ci and the build). Safe to run again.
- `scripts/cloud-push.sh <ssh host> [--setup]`: sends the code (only files git knows about, so no data or keys) to the server, removes files deleted here, builds, and restarts the console.
- **Moving a home server to the cloud**: `npm run cloud-export -- <folder> [--with-offsite]` packs the database (an online backup, integrity-checked), attachments, secrets key, shared captures and Windows app downloads with a SHA-256 for every file and the counts; `npm run admin -- import <name> --from <folder> [--replace]` checks every file before making anything, drops the old server's sign-ins (the password and two-step sign-in carry over), starts the tenant and compares the counts. `--replace` keeps the tenant's previous data in the trash for 7 days.
- `npm run install-caddy -- --dns cloudflare`: Caddy 2.11.7 with the Cloudflare DNS module, built from source with pinned Go 1.27.3 (checksummed), xcaddy 0.4.7 and caddy-dns/cloudflare 0.2.4.
- `npm run admin -- dns-token` (asks for the Cloudflare token, checks it can see the zone, restarts the gateway), `prepare-release` and `update [<name>…]` (the console's Prepare release and Update all from the command line, with a lock the console and its monitor respect), and `init --tls acme --email --allow-ip --acme-staging`.

### Changed
- On a cloud server, with no allowed addresses listed, the admin console answers only from the server itself (not from private networks, which would include the tenants' containers).
- The gateway serves HTTP/1.1 and HTTP/2 only, so the firewall needs just TCP 443.
- The console's certificate check asks the gateway for the certificate it serves (Let's Encrypt), and the expiry alert says how to fix each kind.
- The clipper's "can't reach Selah" message no longer assumes a home network.
- Maintenance guide: setting up a cloud server, moving your own Selah there, and the new commands. The disaster-recovery runbook covers rebuilding a cloud server.

## [6.0.0] - 2026-10-25

### Added
- **Hosting Selah for others**: the same server can now host a Selah for each person you invite (a *tenant*), at its own address (`<name>.<domain>`), with its own database, attachments, secrets key, sign-in and backups, completely apart from everyone else's. Your own Selah keeps running exactly as before. On a home server each tenant runs as its own background service with memory, processor and process limits; on a cloud server, as a Docker container (read-only, no capabilities, ports only on the server itself).
- **The admin console** at `admin.<domain>`, with its own password, two-step sign-in required, and answering only from allowed addresses (checked by the gateway and again by the console; home and private networks until some are listed). Pages:
  - **Overview**: tenants running, the gateway and its certificate, the host backup, disk and memory, alerts, and jobs running now.
  - **Tenants**: **New tenant** (name, address, time zone and limits) gives a one-time **setup link** to send them. Each tenant's panel shows its status, version, sign-in and two-step state, storage against its quota, host and OneDrive backups, recent activity and jobs, with **New setup link** / **Reset link**, name and limits (storage, largest upload, memory, processor, longest job, processes), **Back up now**, **Restore…**, **Restart**, **Pause** / **Resume**, **Roll back**, **Server log** and **Delete…**.
  - **Backups**: the host backup's storage (OneDrive or any rclone storage), passphrase and nightly time, every tenant's last backup and check, test restores and restores, tenants in the backup but not on this server (**Bring back**), and the history.
  - **Security**: every tenant's sign-ins, failures and security changes in one log, by tenant and kind.
  - **Updates**: **Prepare release** from this server's code, then **Update all** (or one): tenants move one at a time, each backed up, restarted and checked; one that doesn't come up goes back to its old release with its database as it was, and the update stops. **Roll back** any tenant.
  - **Settings**: allowed addresses (**Add my address**; the change that would lock you out is refused), limits and time zone for new tenants, the gateway, and your own sign-in.
  - **Docs**: the maintenance guide, the full changelog and the disaster-recovery runbook.
- **Setup links**: a tenant chooses their password and sets up two-step sign-in from the link (password, authenticator, recovery codes), so the admin never knows it. The link works once, for a week; its token leaves the address bar as soon as the page has read it. A **reset link** handles a forgotten password or a lost phone without touching their notes.
- **Alerts**: many failed sign-ins, lockouts, blocked requests, a new device signing in, two-step sign-in turned off, a tenant that stopped (it's started again), a failed backup or update, storage over 90%, low disk space and a certificate expiring within three weeks.
- **The host backup**: every tenant every night, encrypted with the admin's passphrase, to storage the admin controls: 30 days of snapshots (never fewer than 3), attachments synced with removed ones kept 30 days, a weekly restore check per tenant, and the admin console's own database. The tenant's dashboard says when they were last backed up.
- **Restores**: **Test restore** restores a snapshot into a scratch folder, checks the database, the note count and every attachment, and removes it. **Restore over their Selah** moves their data aside (kept, not deleted), restores, restarts and checks it; if anything fails, their data is put back. Nobody stays signed in through a restore.
- **Settings → Account**: storage used (against the quota on a hosted Selah), **Download all my data** (the database and every attachment in one zip, after confirming it's you), and on a hosted Selah the host's last backup and **Delete account…** (type the name; the admin console then removes the tenant, its host backup and, after 7 days in the trash, its folder).
- **Connect OneDrive** in Settings → Data & backup (and for the host backup): Microsoft's sign-in opens in a new tab, and the address it ends on is pasted back. No rclone on a PC needed; the old way is still there on a home server.
- **What's New**: a few plain lines for each update, shown once as a card after an update and in Settings → About → **What's new**. The full changelog is only shown on a home server (and in the admin console).
- **Selah for Windows: Server address…** in the tray menu, to open a Selah at another address (such as one on a shared host); **Use the original** goes back.
- `npm run admin` (init, install, status, set-password, reset-two-step, allow-ip, cert, gateway, tenants, create, setup-link, suspend, resume, restart, delete) and `npm run install-caddy` (Caddy 2.11.7, pinned and checksummed). A `Dockerfile` for the cloud runner.

### Changed
- On a hosted Selah, two-step sign-in can't be turned off (**Move to a new phone…** replaces it), and the private-CA certificate help, the maintenance guide and the full changelog don't show.
- Storage moved from Data & backup to the new Account tab.
- Handwriting (OCR), HEIC photo and audio/video conversions stop after the job time limit (10 minutes unless a tenant's limit says less), and a stuck handwriting job no longer blocks the next one.
- The server can run on plain HTTP behind the gateway (`NOTEAPP_TLS=0`), and its security headers are shared with the admin console.
- The maintenance guide has a **Hosting Selah for others** section, the user guide covers setup links, the Account tab, What's new and Connect OneDrive, and DISASTER-RECOVERY.md covers rebuilding hosted tenants.

## [5.17.2] - 2026-10-24

### Removed
- **The Sports page** and everything on it: favorite teams (scores, schedules, standings, TV channels), the NFL player tracker with its lineups and fantasy scoring, and the ESPN connection behind them. It's gone from the sidebar, Customize sidebar, focus mode's page list, Ctrl+K and the user guide; old links to it open Selah as usual. Nothing else changes.

## [5.17.1] - 2026-10-24

### Fixed
- **Passage slides stay readable**: the ESV text now shows one verse a page. A long verse carries on to the next page, cut at a sentence end where it can (then a semicolon or colon, then a comma), with … where it continues. The text is no longer shrunk to fit; the credit says which verse (and part) is showing. A psalm's title shows small above its first verse.
- **The slides window follows the phone remote**: it now follows through the server too, not only from a window in the same browser, so it keeps up when you present from the Windows app or another browser, and its keys and clicker drive the presentation the same way. Open **/#slides** (no note) on any signed-in browser, such as a computer at the projector, to show whatever is being presented. A signed-out slides window offers to sign in.

## [5.17.0] - 2026-10-24

### Added
- **Teach mode for lessons**: preaching mode's reading tools (large type, folding headings, tap a reference for its text, screen kept awake) with the lesson's own timing. The goal is the class length; a bar of Hook, Book, Look and Took shows the minutes planned for each and the time spent in the step you're in, follows your place in the lesson, jumps to a step when tapped, and warns when a step runs long. Discussion questions can be tapped as asked, with the lines under them marked as your answers. ✓ (or leaving) marks the lesson taught and offers the after-class notes. Open it with **Teach** in the lesson builder, a lesson's ⋯ menu, ▶ on a teaching session, or a course week's Teach step.
- **Phone remote**: open **Phone remote** in the slide bar or presenter view and scan the code. The phone shows the current and next slide, the timer and lesson step, the question's answer and your notes, with big Back / Next and Blank buttons, and follows whatever you preach, teach or present. Signing in on the phone returns to the remote.

## [5.16.0] - 2026-10-24

### Added
- **Slides for lessons and sermons**: each lesson and sermon can have its own slide deck, edited in a new **Slides** tab in the sermon and lesson builders (or **Slides…** in the note's ⋯ menu). A new deck is built from the outline: a lesson's title, big idea, passage, outline points (sub-points come in one at a time), discussion questions and Took; a sermon's title, passage, sermon idea, divisions with their verses, and a summary.
- **Slide types**: Title, Point, Passage (ESV text, paged when long), Image (a picture from the note or an upload), Question (its answer shows only on your screen) and Custom. Add, duplicate, delete and drag to reorder; **bold**, *italics* and bullets in text; Lamplight **Light** or **Dark** per deck; speaker notes; changes save by themselves.
- **When the note changes**, the deck offers the change instead of making it: **Note changed** with **Update from the note** or **Keep mine**, **Not in the note** for parts that are gone, and new points offered as new slides.
- **The slides window**: the audience's view in a window of its own, for the projector or TV (F for full screen; it remembers where it was, and can open on the other screen where the browser allows). A clicker or arrow keys work in it.
- **Preaching with slides**: preaching mode keeps working as before and gains a slide bar. With **Follow my place**, each slide comes up as you reach its place in the note (**Comes up when I reach** on each slide); numbered pins beside the text put a slide up at once, ◀ ▶ move by hand, and **Blank** blanks the room's screen.
- **Present** on a lesson or sermon opens a presenter view: the current and next slide, the question's answer and your notes, a timer and every slide to jump to, with **Present here** for a single screen. Plain notes still present the old way.

## [5.15.2] - 2026-10-24

### Fixed
- **Teaching on the passage page**: the passage's rail has a **Teaching** group listing lessons and planned sessions on the passage from your teaching studies, courses and preaching series (found by the session's passage or a reference in its title), with the date and the study or course. **Open the lesson** opens the lesson builder, **Write the lesson** starts one for a planned session, and the study's name opens it on Desk. Lessons no longer sit among the plain notes that mention the passage.
- **Memory verses**: while you practice, the list hides the verses' words so they can't give the answer away (**Show the words** brings them back). **Hide the words** keeps them hidden any time, and is remembered.
- **Sermon builder Arrange board**: cards can now be removed. Each card's ⋯ menu has **Remove** (a paragraph, a list item with its sub-points, a part, or a whole division), or drag a card onto **Drop here to remove**. A toast offers **Undo**, and nothing leaves the note until you save.

## [5.15.1] - 2026-10-24

### Fixed
- **Put its notebook on the Seminary shelf** only shows for a class with a notebook of its own (one holding only that class's notes) that isn't already on the shelf. A class whose notes sit in a shared notebook, like your main one, no longer offers to move it.

## [5.15.0] - 2026-10-24

### Added
- **Learn** (Desk → Learn): your seminary classes get their own view with **This week**, **Lectures**, **Readings**, **Assignments** and **Grades**, plus a **Syllabus** card, the class's notes and the Canvas feed.
- **Syllabus**: a new class asks for its course code, professor, term, first and last day, and whether it's online (week by week) or in person (days, time, length, room). Office hours, the professor's email and the course site are optional. **Edit…** changes them later.
- **Lectures**: **Fill in from the syllabus** adds one a week for an online class, or one per meeting for an in-person class (on the calendar at the class time). **Take notes** opens Cornell notes with the topic, date, class and professor filled in, or plain notes if you choose them. Lectures aren't tasks; tick them as watched or attended.
- **Readings** by week with their pages, each due at the end of its week (and in Tasks), with readings done and pages read.
- **Assignments** with a category, points and score. **Write it** starts a paper: a Write project due when the assignment is, in the class's notebook, with a first chapter and your citation style (Turabian by default).
- **Grades**: weighted categories filled in from graded assignments (or typed points), the grade so far, and a letter from a grading scale you can change. The grade shows at the top of the class and on its card.
- **Due this week** on the Learn tab: what's due in the next seven days (and anything overdue) across your classes.
- A new class's notebook goes on a **Seminary** shelf; ⋯ → **Put its notebook on the Seminary shelf** does it for an older class.

### Fixed
- Schedule items added with extra details (pages, category, points) saved those details in a form they couldn't be read back from.

## [5.14.0] - 2026-10-24

### Changed
- **Desk** replaces the Studies and Courses pages: one sidebar page, in Studies' place, with four tabs. **Study** has self-studies, **Teach** has courses, teaching series and sermon series, **Write** has writing projects (before, they were only a kind of study), and **Learn** has the classes you take. Desk opens on the tab you used last, and the tab counts show what's under way.
- **Under way / Finished / Archive** is now a small button beside the tabs, and each tab remembers its choice.
- Each tab has its own **New** button: New study, New (course, teaching series or sermon series) on Teach, New writing project and New class. Past classes… moved to Learn. The new-study dialog only offers the kinds that belong on that tab and is titled for what you're making.
- A study's ← goes back to its tab ("← Teach"), including one opened from Sermons, a note's study chip, the calendar or Ctrl+K.
- Ctrl+K has **Desk: Study**, **Desk: Teach**, **Desk: Write** and **Desk: Learn**, and its Desk results show each one's kind.
- Your sidebar order and hidden pages carry over: Desk takes Studies' place. Old #studies and #courses links open Desk.

## [5.13.0] - 2026-10-24

### Added
- **Two-step sign-in** (Settings → Security → **Turn on…**): after your password, Selah asks for a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password, Authy…). Setup shows a QR code (or a key to type), checks a code, then gives ten **recovery codes** to save, each good once if the phone is lost (**Lost your phone? Use a recovery code** on the sign-in page). Turning it on signs out other devices. A code can't be used twice; the secret is stored encrypted and the recovery codes only as hashes. On the server, `npm run reset-two-step` turns it off if the phone and the codes are both lost.
- **Confirm it's you**: changes to how you sign in (two-step sign-in, recovery codes, connecting the Edge clipper) ask for the password and a code again unless they were entered in the last 10 minutes; the change carries on once confirmed.
- **Signed-in devices**: every signed-in browser, phone and Windows app ("Edge on Windows", "Safari on iPhone", "Selah for Windows") with when it was last used and its address, plus Edge clippers. Sign one out, or **Sign out all other devices**. A signed-out device's live updates stop too.
- **Sign out when idle**: a device that hasn't opened Selah for 1 day, 1 week, 2 weeks (default) or 30 days signs in again. Sign-ins still last 30 days at most.
- **Security activity**: a log of sign-ins, wrong passwords and codes, sign-outs and security changes, with device and address. The Security tab shows the last sign-in and failed attempts in the last day, and after signing in Selah says if there were failed attempts since last time.

### Changed
- **Failed sign-ins** are counted from the log (so a restart doesn't reset them): 10 from one address, or 50 in all, within 15 minutes pause signing in for 15 minutes. Wrong codes and confirmations count too.
- **New passwords** need 12 characters and are checked against passwords known from data breaches (Have I Been Pwned's range check: only the first 5 characters of the password's SHA-1 are sent). `npm run set-password` uses the same rules.
- **The session cookie** is now `__Host-selah_session`: tied to this exact host name, so another site on the same domain can't read or set it. Existing sign-ins move over on their next request; nobody is signed out.
- **Changes must come from Selah's own pages**: any save, upload or delete whose Origin (or Sec-Fetch-Site) shows another site, including another subdomain of the same domain, is refused and logged. The Edge clipper's key still works from the extension.
- **No fetching from private networks**: clipped pages and images, calendar feeds and WordPress are fetched with every connection's address checked after DNS and on each redirect, so the server can't be pointed at the router, other machines on the network or a cloud host's metadata address. `NOTEAPP_FETCH_ALLOW` lists home-network hosts that are allowed.
- **Rate limits**: an address making more than 2400 API requests a minute, or 60 that aren't signed in, waits a minute.
- More security headers: Cross-Origin-Opener-Policy and a Permissions-Policy (camera and microphone for Selah only), and no caching of sign-in and security responses. Strict-Transport-Security can be turned on with `NOTEAPP_HSTS=1` once Selah has a public certificate, and `NOTEAPP_TRUST_PROXY` reads visitors' addresses through a reverse proxy.

## [5.12.1] - 2026-10-24

### Changed
- **Courses have their own page** in the sidebar, right under Studies, with **Under way**, **Finished** and **Archive** tabs. Course cards show the book (or topic), the class day, weeks taught and the next week. **New course** lives there (and in Ctrl+K, and the Teaching choice in New study), and a course's back button returns to Courses.
- Studies no longer lists courses. Links that open a course from elsewhere (a calendar event, a note's study chip, Ctrl+K, Teach again) go to the Courses page. Studies keeps its name: self-studies, Bible studies, one-off teaching, classes you take and writing projects.

## [5.12.0] - 2026-10-24

### Added
- **Courses**: teaching planned as a curriculum, after Richards and Bredfeldt's *Creative Bible Teaching*. A book of the Bible (or a topic) over a quarter (13 weeks) or two (26), built week by week. **New course** (Studies, the Teaching choice in New study, or Ctrl+K) asks what you'll teach, when the class meets (first class, class day, time, length, dates with no class), the course aims (know, feel, do), then shows a weekly plan with a passage for each week, split evenly by verses for you to adjust. A 26-week course can make week 13 a review and preview week.
- **The course page**: **Up Next** shows the next week, its four steps (**Study**, **Lesson**, **Teach**, **Notes**) and the one to do now. The **Weekly Plan** lists each week with its date, its steps as buttons and its next step, with dates that have no class between them. The side shows the **Course Aims** beside **Tooks so far**, the **Levels of Learning** each lesson reaches, the class plan and the course's notes.
- **Study first, week by week**: **Study it** opens the study builder on the week's passage, and its Keeper step has **Write the week's lesson**, which starts the lesson from your study in the lesson builder. A passage you've studied before is offered instead. Writing a lesson without a study is still in the week's ⋯ menu.
- **After-class notes**: mark a week taught, then note whether the class reached the Took, what worked and what to change. Next week's Hook shows them.
- **Classes on the calendar**: each week is an event on the class day at the class time (all day without one), lasting the class length, linked to the week's lesson, in the category you pick. The event has **Open the course**. **No class on** (a holiday) moves that week and the ones after back a week; **Have class** undoes it. Editing the class day, time or first class moves every date.
- **Teacher's guide**: the whole course as one Word document: an overview with the aims and the weekly plan (with each week's big idea), then every lesson on its own page with your after-class notes.
- **Teach again**: a new course on new dates with the same weeks and aims. Lessons are copied as drafts to revise, each week keeps its study, and last time's after-class notes show on Up Next and in the lesson builder.
- **Levels of learning** in the lesson builder: Richards's ladder from rote to realization. Each discussion question has a level (a guess from its wording; click to change it), and a meter on the Look, Took and Ready to Teach steps counts the questions, methods and Took, shows the highest level the lesson reaches, and suggests what would take it higher.
- **Teaching methods library** in each lesson builder step: methods for adult classes (open question, agree or disagree, paraphrase, neighbor nudge, small groups, case study, one specific step, prayer partners and more) with their minutes and level. Adding one writes it into the step.
- In the lesson builder, a course lesson shows its week ("Week 4 of 13"), the course aims on the first step and above the Took, last time's notes when it was taught before, and ‹ › to move to the previous or next week's lesson.

## [5.11.0] - 2026-10-24

### Added
- **The lesson builder** for teaching studies: a lesson written step by step through Lawrence Richards's **Hook, Book, Look, Took** (*Creative Bible Teaching*), with the ESV text beside you and each step's key question opening to guidance. It reads and writes your lesson layout (Title, Verses, Introduction (Hook), Exposition (Book), Inquisition (Look), Application (Took)), so existing lessons open in it unchanged. **Write lesson** opens it on a new session; a lesson's row has a builder button, and a lesson note has a **Lesson builder** chip.
- **Lesson and Passage**: title, passage, teaching date, a **big idea** (written at the top of the Exposition), and your Bible studies of the passage with buttons to use their principle, questions, application or summary.
- **An outline editor** for the Book: Enter adds a point, Tab and Shift+Tab indent, Alt+↑/↓ moves a point with its sub-points, and clicking a verse number in the passage starts a point on it. It saves as nested numbered lists; unchanged points keep their formatting.
- **Question kinds** in the Look: each question marked Observe, Interpret or Apply (guessed from its wording, changed with a click), with soft checks for a missing kind or an out-of-order question.
- **Timing plan**: class length (kept for the series) and minutes per part, **Suggest a split**, a rough length from what's written, and a warning when the plan runs over.
- **Last week and next week**: the Hook shows the previous lesson's Took with **Add a recap to the hook**; the Took shows the next session with **Add a look ahead**.
- **Ready to Teach**: a checklist, the timing, **Present the lesson** and **Print a class handout**.
- Handouts: **Main points only** leaves off the points under each outline point, for the class to fill in.

### Changed
- **Start a lesson** from a study's Take It Further now opens the new lesson in the lesson builder.

## [5.10.2] - 2026-10-24

### Added
- **Take It Further** on the study builder's Keeper step: **Start a sermon**, **Start a lesson** (pick a teaching study; the lesson joins its schedule in its lesson layout, with your principle and summary under the exposition, your questions for discussion and your application) or **Start a chapter** (pick a writing project). The step lists what the study has started.
- Sermons, lessons and chapters show chips for the studies behind them: **From your study** for the one they came from, **Your study** for others of their passage.

### Changed
- **A study is the first step, never a conversion.** Sermons, lessons and writing chapters keep their own workflows and can't be opened in the study builder. The study builder is offered only on ordinary notes and on self-study readings that name a passage.

### Fixed
- A lesson opened in the study builder in 5.10.0–5.10.1 showed **Study** instead of its lesson buttons. It's a lesson again; its text was never changed.

## [5.10.1] - 2026-10-24

### Added
- **Bible studies in Studies**: in a self-study, each reading that names a passage has **Study it**, which opens the study builder. The study becomes that reading's note, kept in the study's notebook and listed with its notes, and its row shows **Study** and a builder button. In other kinds of study, an item with a passage has **Study it in the study builder** in its ⋯ menu.

### Changed
- Title case for the new headings, tabs and field labels, as in the sermon builder: Bible Studies, This Week, Memory Verses, Your Studies, Notes That Mention It, Times Read, Translations Consulted, Test the Principle and others.

## [5.10.0] - 2026-10-24

### Added
- **Bible studies**: a guided study builder for a passage, following the Interpretive Journey from Duvall and Hays's *Grasping God's Word* with the fields of your Scripture Study Template. Its steps: passage and reading (times read, translations consulted), their town, the river, the principlizing bridge (with the five principle tests), the biblical map, our town, and a **keeper**, the one sentence worth finding again. The ESV text sits beside the steps, each step's key question opens to the book's guidance, and soft checks flag a summary in the present tense or a principle in the past. It saves an ordinary note laid out like the template, and notes made from the template open in it.
- **Start a sermon from a study**: the summary becomes the text idea, the principle the sermon idea, the words and questions the study steps, and the application the call to action. The sermon builder shows your studies of its passage, with buttons to use the summary or principle.
- **The passage page** shows everything on the passage beside its text: your studies and keepers, sermons with when you preached them, memory verses, and the notes that mention it, with **Study this passage**.
- **Verse notes**: jotting on a verse makes a real note titled with the verse (in a Bible Study notebook), shown beside its verse. **Photo of your handwritten notes** reads a picture of your Bible's margins into a note on the passage. Any study field can read a photo too, and a quote pasted from Logos keeps its citation.
- **Coverage map**: books and chapters you've studied fill in green on the Scripture page.
- **Bible studies** and **This week** tabs on the Scripture page. This week is the weekly review: keepers and verse notes from the last seven days, a strip of the weeks you studied, and one older keeper.
- Ctrl+K: **Study a passage…**. A study note shows a **Bible study** chip, and the ⋯ menu has **Open in the study builder…**.

### Changed
- **Margin notes are now notes.** Existing margin notes became verse notes, titled with their verse, and the separate margin-note list is gone. Typing words on the Scripture page searches your notes.

## [5.9.3] - 2026-10-24

### Changed
- **Preaching mode Outline view** shows every paragraph in full. Paragraphs are no longer cut to their first line with "…". Outline now differs from Manuscript only in showing numbered divisions as numbered lists.

## [5.9.2] - 2026-10-24

### Changed
- **Preaching mode Outline view** shows each division with delivery numbers as a numbered list in that order. Each block is a main point (1, 2, 3…), and its further lines and sub-points sit beneath it (A, B…). With color-coding on, each point's number and label take its element's color. Manuscript view keeps the paragraph blocks, and divisions without numbers look as before.

## [5.9.1] - 2026-10-24

### Added
- **Delivery order** for sermons: on the Arrange board, each paragraph and list item under a division has a number box. Number them 1, 2, 3… in the order you'll preach them, for example Explanation, then Illustration, then more Explanation. Sub-points go with their item, and a number used twice is flagged. A division's ⋯ menu can number it in the order shown, or clear it.
- **Delivery Order view** on the board: each division as it will be preached, each block marked with its element. Unnumbered blocks come after the numbered ones, except what sits right under the division heading.
- **Preaching mode** and **Export to Word** follow the delivery order. The note itself stays grouped by element, so the builder's steps and the board work as before. Word has a checkbox to export it grouped instead.
- **Color-coded elements** (optional): blue Explanation, amber Illustration, purple Argumentation and green Application, each with its name. Turn it on with the highlighter button in preaching mode, or with a checkbox when exporting a sermon to Word.

### Changed
- On the board, each division's parts carry their element's color.
- Delivery numbers stay on a paragraph when you retype it in the builder's steps or edit it in the note. Pressing Enter in the note doesn't copy a number to the new line.

## [5.9.0] - 2026-10-24

### Added
- **Arrange board** in the sermon builder: the whole sermon as cards to drag (divisions, their parts, and each paragraph and list item, nested sub-points included), or move with each card's menu. Parts move between divisions, and slots start a part a division doesn't have yet.
- After a move, divisions renumber, a Reiteration filled in from the divisions follows the new order, and transitions that now lead somewhere else are flagged (kept until fixed, even after saving).
- **Undo** for every move (Ctrl+Z), **Compare** with the sermon as last saved, and **Outline / Full Text** views of the board.
- **Sermon bank**: reusable illustrations, quotes, Scripture and applications for any sermon, beside the board. Add from the board, from any card, or from text selected in any note (right-click → Add to sermon bank…, which keeps a link back). Dragging one into a sermon uses a copy and records where it was used.
- **Preaching mode Outline view**: headings and lists in full, each paragraph down to its first line (tap to read it).

### Fixed
- Lines in a builder part (such as a Reiteration list) no longer run together when the sermon is opened again.
- Right-click menus opened inside a dialog show above it.

## [5.8.2] - 2026-10-24

### Changed
- **Preaching mode timer** counts down from a goal time you can set right in the bar (presets or any number of minutes; it starts from the sermon's planned minutes and saves back to them). It turns yellow under 5 minutes, orange under 1 and red at 0, then counts the time over. With no goal it counts up as before.

## [5.8.1] - 2026-10-24

### Changed
- **Sermon builder**: the steps and tabs use title case ("Text Structure", "Bridge to the Sermon"), and hints and labels start with a capital letter.
- The builder's "skills" are now "steps" (Step 4 of 12), and the footer counts the twelve steps.
- The user guide credits Wayne McDill's *12 Essential Skills for Great Preaching* as the basis for the builder's steps.

## [5.8.0] - 2026-10-24

### Added
- **Sermons**, a new page under Studies: your sermon library, the log of where you preached them, and sermon series.
  - **Sermon builder**: Wayne McDill's twelve skills as steps, from the text's structure, details and research
    questions (a worksheet kept with the sermon) through the text idea (subject and modifier), the bridge (sermon idea,
    interrogative, transition), the divisions, their explanation / illustration / argumentation / application with a
    balance bar, analogies, stories, application, the faith response and the oral presentation (delivery notes, length
    at about 130 words a minute). It writes a note laid out like Logos's Sermon Builder and your Sermon Preparation
    Template, rewriting only the parts you change (the version before goes to the note's history).
  - **Preaching mode**: the note read-only in large type (light or dark), folding headings, tap a reference for its
    ESV text, a timer against the planned length (amber near the end, red over), the time of day, outline jumps, and
    the screen kept awake. Leaving after the timer ran offers to log it.
  - **Preached log**: date, place, occasion, minutes and notes; by year, filterable by place.
  - **Sermon series**: a new kind of study. **Plan the series…** dates them; **Build sermon** on a session opens the
    builder; logging a sermon ticks its session.
  - **Import from Logos**: Sermon Builder's Rich Text (.rtf) exports become sermon notes with their headings, lists
    and Logos links; topics become tags and a series becomes a sermon series.
  - Any note can be preached or opened in the builder from its ⋯ menu; sermon notes show a **Sermon** chip. Ctrl+K has
    **New sermon…**.

### Changed
- Focus mode keeps you on Sermons too.
- A page added to the sidebar in an update now appears next to its neighbor even when you've reordered the sidebar.

## [5.7.0] - 2026-10-23

### Added
- **Calendar categories** replace event colors. Each category has a name, a color (now nine: teal and pink are new)
  and an optional icon (church, Bible, book, school, people, home, heart, work, music, travel, birthday and more),
  shown on the calendar, the list, the Dashboard and in the event dialog.
  - Your event colors became categories named after them (Green, Blue…), every event in its own; rename them in
    **Manage…**. Green, the old default, is the default for new events.
  - **Manage…** (beside the chips on the Calendar, or the Dashboard's funnel menu): add, rename, recolor, pick an
    icon, reorder, delete (its events stay, without a category), and choose the default for new events.
  - **Show or hide** categories with the chips above the calendar (and in List mode); "No category" too. Remembered on
    each device.
  - **Dashboard filter**: the funnel on Today's schedule and Next 7 days picks the categories they show, separately
    from the Calendar's.
  - **Default reminders**: a category can give its events reminders (say, 1 day before); an event that sets its own
    keeps those. The event dialog says when its reminders come from the category.
  - **Canvas category**: a class's due dates (Studies → Due dates from Canvas → **On the calendar as**) show on the
    calendar in that category's color and icon, and hide with it.
  - A category changed on another device shows up without a reload.

### Changed
- The event dialog's **Color** row is now **Category** (with **New…**). An event without a category is gray.

## [5.6.0] - 2026-10-23

### Added
- **Export** a note, selected notes, a notebook (or several), a shelf, a tag, or everything (Settings → Data & backup
  → **Export everything…**). **Export…** is in each one's menu, and the dialog shows how many notes and attachments go.
  Formats:
  - **Word**, for a note, selected notes or one notebook: one document, each note on a new page, in the order you
    pick (oldest first, A–Z, newest first), in the Turabian, manuscript or plain format as before.
  - **Markdown**: a .md file per note, with its title, tags, dates and notebook at the top and its attachments in an
    `attachments` folder beside it; shelf and notebook folders when there are several. Markdown apps read it, and so does
    Selah's Markdown import.
  - **Web pages**: a page per note plus a contents page, readable in any browser, light or dark.
  - **.enex file**: an .enex file per notebook with the attachments inside, for apps that import .enex or Selah's own import.
  - Citations and your own footnotes become numbered footnotes, drawings become SVG pictures, to-do lists keep their
    checkmarks, callouts become Markdown callouts, HEIC photos go as JPEG, and links between notes in the
    export link the exported files.
- **Merge notes**: select notes in the list → **Merge … into one…**. Put them in order, name the new note, start each
  part with its title as a heading or with a divider, and pick its notebook. Tags and attachments come along.
- **Split a note** (⋯ → **Split into notes…**) at each Heading 1, 2 or 3, or each divider, with a preview of the
  notes it makes. Each part takes its heading as its title; put them in the same notebook, a new one or another one,
  with an optional contents note linking them in order.
- After a merge or split the originals go to the Trash unless you keep them, and links to them point at the new
  note (or the contents note). Attachments are copied, so a restored original still has its files.

### Changed
- A note's ⋯ menu: **Export…** (with Word as the first choice) replaces **Export to Word…**.

## [5.5.1] - 2026-10-23

### Changed
- **Stacks are now Shelves**: notebooks sit on shelves. Only the name changed; your shelves and their notebooks are
  as they were.
- **Focus mode** keeps you on Daily Walk, Prayer, Studies or Scripture when you turn it on, and from any other page
  goes to Daily Walk (opening Selah in focus mode does the same). Turning it off goes to the Dashboard.
- **Studies and Scripture** open on their home view each time you come back to them (Under way / Passages, no study
  or book open), and clicking them again in the sidebar goes back there too. A study opened from elsewhere (the
  dashboard, a note) still opens straight to that study.
- **ESV usage meter**: lookups answered from the stored verses now show too ("read from storage in the last 24
  hours"), so the meter moves even when the ESV itself isn't asked; only fetches from the ESV count toward
  Crossway's limits. **Show stored passages** lists the passages kept on the server (verses, when last read), and
  each one, or all of them, can be forgotten.

### Fixed
- **Full screen on tablets and phones turned sideways** now covers the sidebar too; ⤢ brings it back.

## [5.5.0] - 2026-10-23

### Added
- **Focus mode**, for study and writing. **Ctrl+Shift+F** or the new focus button at the bottom of the sidebar turns
  it on and off, and **Focus mode · Exit** shows above Settings while it's on. It hides the pages you choose (at first
  Dashboard, Inbox, Calendar, Tasks, Sports, All notes, Tags, Attachments and Templates; change them in Settings →
  General → Focus mode → **Choose pages…**) and the sidebar's counts and badges. A note's toolbar stays out of sight
  until you select text or point at it, and reminders are skipped (they don't all arrive when you turn it off).
  Turning it on while on a hidden page moves you to the first page it shows; hidden pages are still a Ctrl+K away.
  On or off is per device; the pages it hides follow you everywhere.
- **ESV usage meter** (Settings → Connections → ESV…): lookups in the last minute, hour and 24 hours against
  Crossway's limits (60, 1,000 and 5,000), and verses stored (500 at most). Passages already stored don't count. A
  message appears once you pass 80% of the hourly or daily limit, and Selah stops looking up new passages at the limit
  (stored ones keep working) instead of risking the key.
- **Maintenance guide** (Settings → About): a read-only note in your Reference notebook on looking after the server,
  written with this server's own folders and port: the `selah` command, starting at boot, maintenance, updates,
  backups and restoring, the notes disk, and fixes for common problems. Like the user guide, each release keeps it
  up to date.
- **The `selah` command** on the server, from any folder: `selah check` (running, answering, starts at boot, notes
  disk, backups), `status`, `start`, `stop`, `restart`, `logs` (`-f` to follow), `update` (pull, build, restart) and
  `backup` (local and off-site, like the nightly one). `scripts/install-service.sh` installs it.

### Notes
- Starting at boot was already set up (the service is enabled and runs without anyone logged in); `selah check`
  confirms it after a reboot.

## [5.4.6] - 2026-10-23

### Changed
- A tag whose Scripture references are ignored now shows **No Scripture Indexing** on the Tags page (was “No Scripture”).
  On a narrow screen the label goes under the tag name, so the name isn't cut short.

## [5.4.5] - 2026-10-23

### Added
- **Remind me, for each event and task.** Choose any of: at the time, 15 minutes, 1 hour, 12 hours, 1 day or 1 week
  before, or None. It's in the event dialog and in a task's details (once it has a due date). Events still remind you
  15 minutes before and tasks at their time unless you change it (events used to remind 10 minutes before). All-day events and tasks
  without a time have no reminder unless you pick one, and those count back from midnight. A repeating task's next
  copy keeps its reminders.
- **Verses as a quote or inline.** The ESV passage dialog (**/esv**) has **Quote** and **Inline**, and remembers your
  choice. Inline puts the text in your sentence: “For God so loved the world…” (John 3:16 ESV). Right-clicking a
  reference offers both; inline goes right after the reference.
- **Ignore Scripture references by tag.** On the Tags page (⋯ or right-click), **Ignore Scripture references** keeps
  that tag's notes out of the Scripture index and Same Scripture connections. The tag shows **No Scripture**; select
  several tags to change them together.
- **Only notes I link** (Settings → General → Connected notes) shows only the notes that link to a note, without
  title mentions or same-Scripture suggestions.

### Changed
- **Selah opens on the Dashboard.** Opening the app always starts there, instead of on the last page you used.
  Reloading still keeps the page you're on, and links to a note still open that note.
- **Connected notes start folded** on every note; click to open them.

### Fixed
- **Full-screen PDF reader.** The ⤢ button on a PDF in a note opened the reader in a new tab, which the Windows app and
  the installed app don't allow, so nothing happened. The reader now opens over the app, in the browser, the Windows
  app and on phones. **Esc** or **✕** closes it, and it has Download and true full-screen buttons. PDFs in a note's
  attachment list open the same way.

## [5.4.4] - 2026-10-22

### Fixed
- **Dragging one list item.** On the way to an item's grip, the mouse crossed the bullets or numbers, and that handed the
  grip to the whole list, so lists still moved as one block. Every grip in a list is now for its own item (with its
  sub-items). To move the whole list, hold **Alt** as you start dragging any of its items.

## [5.4.3] - 2026-10-22

### Added
- **Highlighter and text colors.** The highlighter now comes in yellow, green, blue, pink, orange and purple, and a
  new **A** button colors text red, orange, green, blue, purple or gray. Each button reuses the last color you picked;
  the arrow beside it shows them all, plus **No highlight** / **Default color**. The colors adjust for dark mode and
  carry over to Word exports, WordPress posts, slides and handouts. Existing highlights stay yellow.
- **Move single list items.** Every list item has its own grip: drag it, with its sub-items, anywhere in the list, into
  another list, or out on its own (a numbered item stays numbered). Dragging a heading still carries its section. **Alt+↑ / Alt+↓** move the item the cursor is in.
- **List buttons on phones.** In a list, a **List item** row in the toolbar has Outdent, Indent, Move up and Move down,
  because phone keyboards have no Tab key.

### Fixed
- **Numbered lists restarting at 1.** Deleting the item or line between two parts of a list left two lists, so the
  second started counting again. Lists of the same kind that touch now join back into one. A note already split this
  way joins up the next time you edit it.
- **Notebooks page on a phone.** Notebook names were cut down to a letter or two beside the note count. The name now
  has its own line, with the count and stack below, and stack headings no longer cut off their counts.
- **Template picker keys.** ↑ and ↓ move through the templates (even while typing in the search box), Home and End
  jump to the ends, and Enter uses the chosen one.
- **Selah for Windows: drag and drop.** The Windows app swallowed every drag inside Selah, so shortcuts, notes, tasks
  and list items couldn't be dragged there. Dragging works as it does in the browser, file drops included.
  This one needs **Selah for Windows 5.4.3**, which the app offers to install by itself.

## [5.4.2] - 2026-10-22

### Fixed
- **Windows notifications in Selah for Windows.** Pages loaded from your server didn't recognize the Windows app,
  so they tried the browser's notifications, which the app doesn't show. Selah now recognizes the app and sends
  Windows notifications. **Send a test** says if Windows refuses one, and why.

## [5.4.1] - 2026-10-22

### Fixed
- **Notifications on Android.** Android only shows notifications through a service worker, so Selah now has a small one.
  It's used only for notifications: nothing is cached and every request still goes to the server. Clicking a reminder
  opens Selah on Tasks or the Calendar.
- Notification problems are no longer silent. **Send a test** (Settings → General → Notifications) says whether the
  test went out as a Windows notification or through the browser, or why it couldn't be sent.

## [5.4.0] - 2026-10-22

### Added
- **Selah for Windows**, a real Windows app (.exe) that opens Selah from your server in its own window.
  - **Tray icon.** Closing the window keeps Selah in the tray, so reminders still arrive. Click the icon to bring it
    back; its menu has Open, **Start with Windows** (a checkbox), **Check for updates** and Quit.
  - **Starts with Windows** when you tick it, quietly in the tray.
  - **Windows notifications** for reminders (below).
  - **Updates itself.** It checks your server shortly after starting and every six hours. When a new version is
    there it asks; **Update now** installs it and reopens Selah. Updates are signed, so it only installs real Selah
    builds. Selah's pages and features still update straight from the server, as before.
  - Links to other sites open in your normal browser.
  - Download it from Settings → General → App on a Windows PC, once the first build is published.
- **Notifications** (Settings → General): reminders on this device for tasks with a time, when they're due, and for
  events, 10 minutes before they start. They work in the Windows app, the installed web app and the browser. Clicking
  one in a browser opens Tasks or the Calendar.

## [5.3.3] - 2026-10-22

### Fixed
- **HEIC photos (Android and iPhone cameras) now show.** Browsers can't display HEIC, so Selah makes a JPEG copy the
  first time one is viewed (full size, a few seconds once) and shows that in notes, the Attachments page and
  thumbnails. The original is kept: **Download** still gives the HEIC file. Photos already in notes are fixed too.
- Handwriting to text can now read HEIC photos that are already in a note.

## [5.3.2] - 2026-10-22

### Added
- **Live updates.** Selah now hears about changes the moment they're saved, from this window, another window, another
  device or the Edge clipper, with no refresh and no leaving the page.
  - **The open note** shows text changed elsewhere right where you are: your cursor and scroll position stay put, and
    a short notice says it was updated.
  - **The Inbox** shows new clips as they arrive, and the sidebar counts and note list keep up too.
- **No more silent overwrites.** A window with an older copy of a note can no longer save over newer text. If you were
  typing when the note changed elsewhere, a bar asks: **Load theirs** or **Keep mine**. The text you don't keep is
  saved in Version history either way.

## [5.3.1] - 2026-10-21

### Added
- **Refresh** button at the bottom of the sidebar, beside Settings. It reloads the counts, the note list and the open
  page without reloading the app, so a note you're typing in keeps everything.

### Fixed
- **Dragging a heading moves its whole section.** A Heading 1 brings everything below it up to the next Heading 1; a
  Heading 2, up to the next Heading 2 or 1. The drag preview shows what's coming along. Other blocks still move alone.
- **Sidebar counts and the note list update by themselves.** A note from the web clipper (or another device) now
  shows up when you come back to Selah, and every minute while it's open, without a manual refresh.
- **PDFs in notes show their pages again in browsers a few versions behind.** The reader's toolbar appeared but the
  document didn't, because the PDF reader uses very new JavaScript. Selah now adds the missing pieces, in the reader
  and in its background worker. The full-screen reader is fixed too.
- **The gray hint on an empty line ("Type '/' for blocks…") no longer gets left behind.** It shows only on the line
  with the cursor and goes away when you click out of the note. An empty note still shows it.
- **Settings spacing**: the same spacing between sections on every tab, thin lines between rows, the first heading
  lined up with the tabs, and on a phone the tabs sit on one line you can swipe instead of wrapping.

## [5.3.0] - 2026-10-21

### Added
- **Handwriting to text.** Type up written notes, read on Selah's own server (Tesseract), so nothing is sent
  anywhere else and there's nothing to sign up for.
  - **/handwriting** (or the Insert menu): choose a photo, scan or PDF, or take a photo. Each page is read, and you
    can fix the text before **Insert into note**. Tick **Also add the photo** to keep the original above the text.
  - **Drawings**: **To text** in the drawing toolbar types up what you wrote with the pen. **Replace the drawing**
    swaps the ink for the text; **Insert below** keeps both.
  - **Pictures and PDFs in a note**: right-click a picture → **Handwriting to text…**, or **To text** on a PDF or
    image attachment. The text goes right below it.
  - Words it wasn't sure of are highlighted in the note so you can check them. Lines starting with a dash or bullet
    become a list, and `1.` a numbered one. **Keep each written line on its own line** can be turned off to run lines
    together into paragraphs.
  - Photos are evened out first (shadows and uneven light taken out) so faint pencil still reads. Neat printing reads
    well; cursive is hard for it, and the dialog says when a page was hard to read.
- **Cornell notes.** A **Cornell notes** template (in Templates), and **/cornell** to add the layout to any note:
  topic, date, course or study and speaker at the top; cues and questions in a narrow column beside the notes; and a
  summary across the bottom.
  - **Tab** goes from cue to note to the next row, and adds a row at the end. From the header it goes to the first
    cue; from the summary, out below the sheet.
  - It's made of ordinary tables, so it searches, prints, posts and exports like any note. Word export keeps the
    narrow cue column.

### Changed
- The slash menu lists blocks whose name matches what you typed before those matched by a keyword.
- The user guide has sections on handwriting to text and Cornell notes.

## [5.2.2] - 2026-10-21

### Added
- **Read-only notes.** The lock button next to *Saved* switches a note to read-only for reading or scrolling, so
  nothing changes by accident.
  - The toolbar goes, and the text and title can't be edited. Links and Bible references still open.
  - Click **Read-only** again to edit.
- **Always open read-only** (a note's ⋯ menu) makes a note open locked every time, with a lock on it in the note list.
  The lock button still unlocks it when you want to edit.

### Changed
- **Notes opened from anywhere but the note list open in full view**: from the dashboard, Ctrl+K, a link, the
  calendar, tasks or a study's full-page button. ⤢ brings the list back. Clicking a note in the list works as before.
- The **user guide** opens read-only, and in full view. It has a section on read-only notes.

## [5.2.1] - 2026-10-21

### Added
- **User guide**: Settings → About → **User guide** opens *Selah User Guide*, a note covering every page and feature,
  with a keyboard shortcut table at the end. Its headings fold.
  - It's made in your first notebook the first time you open it; move it wherever you like.
  - When a new version changes the guide, opening it brings it up to date. The text it replaces is kept in Version
    history. To keep your own notes on it, duplicate it.

### Fixed
- Word export: numbered lists now number 1. → A. → I. → a. → i. as they nest, matching the editor. Before, they
  used 1. → a. → i.

## [5.2.0] - 2026-10-21

### Added
- **Export to Word** (a note's ⋯ menu) makes a .docx in one of three formats, chosen each time:
  - **Turabian paper:** Times New Roman, double-spaced, real Word footnotes, the bibliography on its own page and page
    numbers. It can have a title page (title, subtitle, name, school, course, professor, date); the fields start empty,
    except the title, and lines you leave empty are left out.
  - **Manuscript:** clean and single-spaced with footnotes, for sermons, lessons and articles.
  - **Plain:** the note as written.
  - Headings, bold and italics, lists, block quotations, tables, pictures and links carry over. Citations and your own
    footnotes become Word footnotes (or text, in author–date styles).
- **Writing projects have chapters.** Each chapter is its own note, listed in order on the project:
  - Reorder chapters by dragging or with the arrows.
  - Mark each one Outline, Draft, Revised or Final.
  - Each chapter shows its word count. You can give the project a word goal, and a chapter one too.
  - The project shows words written today and over the last two weeks.
  - **Export to Word…** on the project makes one document of every chapter. Each chapter starts on a new page,
    footnotes are numbered straight through, and there's one bibliography.
- **Focus mode** (the ✎ button, the ⋯ menu, or Ctrl+Shift+F): just the text, centered. The toolbar shows when you
  point at it, and a bar at the bottom shows the word count against the chapter's goal. Esc leaves it.
- **Sources panel** for a chapter (the cite button by the save status):
  - Read the project's reading notes right beside your draft.
  - Click any source the project cites, or one you cited recently, to cite it at the cursor, with a page if you give
    one. **Find in Zotero…** opens the usual cite dialog.
- **WordPress series:** turn on **Post the chapters as a series** in a project.
  - Each chapter you post gets a box at the top with the series name, "Part 2 of 5", and links to the parts before
    and after that are live. Posting a chapter updates the other parts' links.
  - The posts can be tagged with the series name.
  - Each chapter shows whether it's a draft, scheduled or published on the site.

## [5.1.0] - 2026-10-21

### Added
- **Read a passage on the Scripture page.** Type a reference (Romans 8:28-39, Ps 23) to see just those verses in the
  ESV, one per row.
  - Buttons move to the chapter before or after, or widen the passage to the whole chapter.
  - Every chapter in the book browser opens to read, not just the ones you've written about.
  - The notes that mention the passage are listed below it, as before.
- **Margin notes, verse by verse.** Click a verse (or its +) to write a note beside it, like the margin of a study
  Bible.
  - They're kept with the verse, not as separate notes in your lists. Edit or delete them in place.
  - **Make a full note** turns one into a regular note titled with the verse, quoting it, and opens it in the panel.
  - Typing words instead of a reference on the Scripture page searches your margin notes.
  - **Ctrl+K** finds them too and opens the passage at that verse. Typing a reference there ("ps 23") offers to
    read it.
  - Hovering a Bible reference in a note shows your margin notes on those verses under the ESV text.
- **Memory verses**, a new tab on the Scripture page: a simple list of verses you're learning.
  - Add one with ★ beside a verse, **Learn it** on a passage, or by typing a reference.
  - Put the list in order with the arrows.
  - **Practice** three ways: **Fading words** (more words hide each round; click a blank to peek), **Type it out**
    (each missed word is marked; punctuation and capitals don't count), and **Reference ↔ text** (see the reference
    and say the verse, or see the verse and name the reference, through the whole list).
  - Each time you get one, it counts as practiced.

### Changed
- **Customize sidebar** (Settings → General, or Ctrl+K) puts the top section's pages in your order. Drag them or use
  the arrows. **Reset order** goes back to the usual one, and the order follows you to your other devices.

## [5.0.2] - 2026-10-21

### Changed
- **A study's notes open in a panel over the study** instead of taking you to the notes view. This covers the notes
  list, outline headings, and an item's Notes, Lesson or Write lesson button.
  - The note is fully editable there.
  - Esc, the ✕, or a click beside the panel closes it, and the study updates (new titles, for example).
  - The ⤢ button opens the note as a full page.
  - On a phone, the panel fills the screen.

## [5.0.1] - 2026-10-21

Studies, fitted to a real class note (OBST 680) and a real lesson outline (Fear God).

### Changed
- **Lesson notes use the Hook, Book, Look, Took layout**:
  - The note opens with **Title:** and **Verses:** lines. The passage is a Logos link (ESV).
  - Then come Introduction (Hook) closing with the passage, Exposition (Book) as a numbered outline, Inquisition
    (Look) for questions, and Application (Took).
  - A teaching study's **Edit…** dialog picks the layout: Hook, Book, Look, Took; Big idea and three points; or one
    of your templates, where {{passage}}, {{lesson}} and {{study}} fill in.
- **Present mode**:
  - A paragraph that's only a Bible reference becomes a slide with the passage text (ESV, when it's connected).
  - The title slide drops a "Title:" line that repeats the note's title.
  - Long outlines fit the screen. Earlier points fold their sub-points away as you move on, slides fill from the
    top, and each slide keeps one text size from its first point to its last.
- **Handouts**:
  - Pick which sections to print, for example only the Look questions.
  - Lines to answer each question.
  - Room for notes after each Heading 1 section in notes that use them.
  - The handout's title is its only big heading.
- **Past classes**:
  - The **Week N → Watch / Read / Apply checklists become the class schedule**, grouped by week and ticked as they
    were.
  - "Content not supported" placeholders left by the export can be removed.
  - **Split** names each note with the course code ("OBST 680: Syllabus"). It leaves out the checklists, skips
    sections with nothing in them, and trims stray empty lines and dividers.
  - A kept note's outline skips the week headings.
- **Use a lesson you've written…**, in a session's ⋯ menu, attaches an existing note as its lesson.

### Fixed
- Present mode no longer closes itself when the slides change while it's open.

## [5.0.0] - 2026-10-20

### Added
- **Studies**, a new page above Scripture, for anything you work through over weeks. There are four kinds:
  - **Self-study**: a book of the Bible, a theology book, a Logos course.
  - **Teaching**: a class or Bible study you lead.
  - **Writing project**: a blog series, an article, a long study.
  - **Class**: a course you take.
- **Each study has a schedule** of readings, sessions, assignments or milestones, and its own notes.
  - It shows how far along you are, what's next and what's behind. With a finish date, it shows the pace you need
    ("about 3 a week to finish by Easter").
  - **Dated items appear in Tasks, on the Calendar and on the Dashboard**, in a task list named after the study.
    Ticking an item in either place ticks it in both. You can keep a study out of Tasks from its ⋯ menu.
  - **Plan the reading**: a book of the Bible (or numbered chapters) at so many a day, on the weekdays you choose.
  - **Plan the writing**: research, outline, draft, revise and finish, spread out to your finish date.
  - Notes can belong to a study whatever notebook they're in. A note shows chips for its studies, and you can
    click one to go to the study.
- **Teaching tools:**
  - **Plan a series**: weekly sessions (or every two weeks), walking through a book of the Bible if you like, with
    holidays skipped.
  - **Write lesson** gives each session a lesson note with Big idea, Text, Introduction, three points, Application
    and Discussion questions.
  - **Present** (any note's menu, or ▶ on a session): full-screen slides, one per heading, with points shown one
    at a time. → and ← move through them, B blanks the screen, and + and − change the text size.
  - **Print handout…** (any note's menu): a clean printout without the empty template lines. Highlighted words can
    become fill-in-the-blanks, with a leader's copy showing the answers, and lines for notes after each section.
- **Classes:**
  - Paste the Canvas **calendar feed** link and the assignments come in with their due dates and keep themselves
    up to date. A filter keeps just one course.
  - A **grades** table with weighted categories works out your current grade.
- **Past classes** (Studies → Past classes…):
  - Pick the note for each class and see its headings. Then keep it as one note, with an outline you can click
    to jump to each heading, or split it into a note per section.
  - Pictures go with the section that shows them, and the original goes to the Trash.
  - Each class becomes an archived Class study.
- The Ctrl+K palette finds studies too.

## [4.3.0] - 2026-10-20

### Changed
- **Settings has tabs**: **General** (appearance, sidebar, install), **Connections** (Edge clipper, WordPress, Zotero,
  Logos, ESV), **Data & backup** (storage, off-site backup, import), **Security** (password, certificate, sign out)
  and **About** (version and changelog). It opens on the tab you used last. On a phone the tabs wrap onto two rows.

### Fixed
- The Inbox no longer needs sideways scrolling on a phone. A long title or a long unbroken link stretched the card
  past the screen; titles now shorten with “…” and long links wrap.

## [4.2.2] - 2026-10-20

### Changed
- **Install as an app** (Settings → App) names the browser to use. On Android, use **Chrome**: other Android
  browsers (Edge, Samsung Internet) only add a shortcut, and a shortcut doesn't appear in the share menu. On iPhone,
  iPad and Mac, use **Safari**. If you're in a different browser, the steps tell you to switch and what to tap there.

### Fixed
- The update banner said "Notes" instead of "Selah".

## [4.2.1] - 2026-10-20

### Fixed
- Edge clipper: Edge said the manifest was missing after **Extract All**. Windows put the files in a second folder
  inside the one you chose. The download now holds the files directly, so the folder you unzip into is the one
  to pick in **Load unpacked**. The setup steps say so too.

## [4.2.0] - 2026-10-20

### Added
- **Inbox**, a new page under Dashboard. Everything you capture lands here until you file it, and the sidebar shows
  how many are waiting.
  - **File with one key.** Select an item and press **1–6** to file it to a notebook from the bar (your notebook
    shortcuts come first), **F** to pick any notebook, or **Delete** to move it to the Trash. Every action has
    Undo. Use ↑ and ↓ to move and Enter to open.
  - The Inbox is an ordinary notebook named Inbox, so its notes also show in All notes and search.
- **Quick capture with Alt+N**, from anywhere in Selah (also in the Ctrl+K palette and on the Inbox page).
  - The first line is the title. **Enter** saves; **Shift+Enter** starts a new line.
  - Type **#tag** to tag it, **@Notebook** to save it straight to a notebook, or **!task** to make it a task. A
    task reads dates, !priority and #list the same way the Tasks quick-add does.
  - Paste just a link and you get a bookmark with the page's title and description.
- **Voice memos**: record one from quick capture, the Inbox or the palette. It's saved to the Inbox as a note with
  the recording.
- **Share to Selah from your Android phone.** Once Selah is installed from its new address, it appears in the share
  menu of any app. Links, text, photos and files arrive in the Inbox.
- **An Edge clipper** (Settings → Browser extension → Set up clipper…). Download it, load it into Edge with Developer
  mode, and connect it with a one-time code. You can disconnect a clipper at any time.
  - **Article**: the readable text and pictures of a page, without menus and ads. The pictures are saved with
    the note.
  - **Selection**: the text you selected, as a quote with a link back to the page.
  - **Bookmark**: the link, with the page's description and picture.
  - **Screen** and **Area**: a screenshot of what you can see, or of an area you drag out.
  - Pick the notebook (Inbox first), add tags and your own note, or add the clip to the end of an existing note.
  - Right-click a page, selection, link or image to save it, or press **Alt+Shift+S** to clip the page (or the
    selected text) without opening the clipper.
  - The clipper's key can only add notes; it can't read or change them.

## [4.1.0] - 2026-10-20

### Added
- **Links between notes.** Type `[[` and part of a note's title, then pick it, or choose **Create “…”** to start a
  new note in the same notebook and link to it.
  - A link opens its note with a click. Hovering shows a preview first, and right-clicking gives Open note, Copy
    link and Remove link. To put the cursor inside a link, Shift-click it.
  - Links point at the note itself, so they keep working when you rename it. Links that showed the old title change
    to the new one; links you've given your own words keep them.
  - Links to your own notes become plain text in WordPress posts.
- **Connected notes** at the foot of every note:
  - **Linked from**: notes that link here, with the sentence around each link.
  - **Mentions without a link**: notes that use this note's title without linking it. **Link** turns the mention
    into a link.
  - **Same Scripture**: notes that mention the same passages, with the references they share.
  - Click any of them to open it. The panel folds away if you'd rather not see it.
- **Version history** (note menu → **Version history…**):
  - The note as it was before each editing session is kept: a copy when you come back after a 10-minute break,
    and before you restore a version, insert a template, or link a mention.
  - Pick a version to see what changed since, with added and removed words marked, or to read it as it was.
  - **Restore this version** puts it back. What the note said before the restore is kept in the history too.
  - Older copies thin out: everything from the last day, one a day for a month, then one a week.

## [4.0.0] - 2026-10-20

### Changed
- **Notes is now Selah.** A new name, a new icon (a fermata, the musical sign for a pause, over a lamp flame) and
  the italic *Selah* wordmark in the sidebar and on the sign-in page. The installed app, browser tab and
  certificate download use the new name too.
- **A new web address, beginning with *selah* instead of *notes*.** The old address keeps working, and once the new one is set up it forwards
  there, so bookmarks and links in your notes still open. Install the app again from the new address to get the
  new name and icon.
- The sidebar no longer lists every notebook and tag under Shortcuts. Manage them on the **Notebooks** and
  **Tags** pages, and star the ones you use most to keep them under Shortcuts. Dropping a note on a notebook
  shortcut still moves it there.

### Added
- **Hide pages from the sidebar.** Right-click a page and choose **Hide from sidebar** (with Undo), or pick them
  all at once in **Settings → Customize sidebar**. Any page can be hidden, Shortcuts included, and the choice
  follows you to your other devices.
- **Search or jump with Ctrl+K** (also *Search or jump to…* at the top of the sidebar):
  - Go to any page, including hidden ones, or any notebook, stack or tag.
  - Find notes by title or text, with the best matches first.
  - Your recent notes appear before you type.
  - Run actions: new note, new note from template, new task, new event, settings, customize sidebar, and theme.
  - Use ↑ and ↓ to move and Enter to open. It works from anywhere, including while you're typing in a note.

## [3.9.0] - 2026-10-19

### Added
- **Attachments**, a new page in the sidebar between Tags and Templates: every file in every note in one place.
  - **Storage at a glance**: total size and file count, split by kind (images, PDFs, documents, audio, video, other);
    click a kind to filter to it.
  - **Cleanup shortcuts**: files in trashed notes, files listed with a note but no longer shown in its text, large
    files (10 MB+), and duplicate copies (the same file attached more than once, compared by content, with how much
    room deleting the extra copies would free). New files are checked for duplicates when you open the page.
  - **Find and sort**: search file names, note titles and notebooks; filter by kind and notebook; sort by date, size,
    name or note; grid view with previews (image and video thumbnails) or a compact list.
  - **Preview**: images, PDFs, video and audio open in a large viewer with the file's details, the note it's in, and
    other notes holding the same file. Use ← and → to move through the list.
  - **Rename** a file (the note shows the new name), **move** files to another note (they come out of the old note's
    text and go on the end of the new one), and **delete** files (they're taken out of the note's text too).
  - **Select several** (checkboxes, Shift-click for a range) to download them as one zip, grouped in folders by note,
    or to move or delete them together.
  - **Add files**: drop files on the page or use **Add files…** to attach them to an existing note or a new one.

## [3.8.1] - 2026-10-19

### Changed
- WordPress page: the tabs no longer show a scroll bar. On a narrow window they wrap to a second line; on a phone they
  still swipe sideways.
- WordPress page: **Comments** and **Categories & tags** are optional. Hide or show them from the ⚙ button at the end of
  the tab bar; the choice follows you to other devices. With Comments hidden, "Comments waiting" opens the site's own
  comment screen.
- Daily Walk: the **Today's prayers** card sits above the devotional readings.

## [3.8.0] - 2026-10-19

### Added
- **A page for your WordPress site.** It's in the sidebar under Scripture, named after the site, and shows only while a
  site is connected. The header keeps the site's own colors, fonts, icon and tagline, with post counts you can click.
  - **Overview**: what needs attention (comments waiting, notes changed since they were posted, posts pending review),
    what's coming up, the latest posts, and your **posting rhythm**: posts per month for two years, days since the last
    post, posts a month, months in a row with a post, the longest gap, and which weekdays you post on.
  - **Posts**: search, status and category filters, bulk publish and delete, and actions for each post (open the note,
    update from the note, schedule, publish, unschedule, view, edit in WordPress, delete).
  - **Calendar**: published and scheduled posts by day. Drag a scheduled post to another day to move it (same time),
    or drag a draft onto a day to schedule it for 9 AM.
  - **Pipeline**: Ideas (notes tagged **Blog idea** that aren't posted yet) → Drafts → Scheduled → Published, with
    Write, Post…, Schedule… and Open note on the cards.
  - **Scripture**: which books and chapters your published posts cover, as a map of all 66 books, from each post's
    Scripture Blog references (or references found in the text on sites without the plugin). Click a chapter for its
    posts, or jump to your own notes on it.
  - **Comments**: waiting, approved, spam and trash, with approve, reply, spam, trash and delete.
  - **Categories & tags**: counts, add, rename, merge (moves the posts, then deletes the old one) and delete.
  - **Media**: the space the library uses, a grid with previews, type filters and search, and copy link, open, edit and
    delete.
  - **Import into a note**: posts that weren't written in the app become notes, with their images saved as
    attachments, linked to the post so you can update it from the note.
- **Out-of-sync badges**: a post whose note has changed since it was posted shows **Note changed · Update**, which
  opens the posting form for that note. A post changed in WordPress after it was posted shows **Edited on site**, so
  you know updating from the note would replace those changes.

### Removed
- The WordPress dashboard widget and Settings → WordPress → **Manage posts…**; the WordPress page replaces both.

## [3.7.0] - 2026-10-19

### Added
- **Prayer**, a new page in the sidebar under Daily Walk, for keeping a prayer list.
  - **Requests** with who they're for, a category (Family, Church, Missions… or your own), verses to pray (with ESV
    hover text and Logos links), details, a linked note, and a timeline of dated updates.
  - **A rhythm for each request**: every day, on chosen weekdays (Mon: family, Tue: church…), or in rotation. Rotation
    requests take turns, a few each day (you choose how many), so a long list comes round without being prayed all at once.
  - **Quick add**: type `Dad's job search @Dad #Family mon,thu Phil 4:6` and the person, category, days and references
    are picked out as chips, the way task quick-add works.
  - **Today** lists what's due with a check for each. Checks are counted: times prayed, days prayed this year, and a
    prayer streak.
  - **Answered**: mark a request answered with the date and how it was answered. The Answered tab gathers them as a
    timeline by year, with how long and how often each was prayed. Requests can also be archived and prayed again later.
  - **Print** a clean copy of the list, grouped by category.
- Daily Walk: a **Today's prayers** card below the readings, following the selected day. Praying everything due counts
  toward the day being done, so the streak, heatmap and "All done" include prayer.
- Daily Walk journal notes list the day's prayers under **Prayer**.
- Notes: **Add to prayer list…** in a note's ⋯ menu makes a request from the selected text, linked back to the note.

## [3.6.3] - 2026-10-19

### Added
- Daily Walk: **Journal** now asks which notebook the day's note goes in. It offers the notebook you picked last time
  (on this device). A day that already has a journal note still opens it straight away.

## [3.6.2] - 2026-10-19

### Changed
- The Notes icon is now lapis blue with navy rings, to match the Lamplight colors. The browser tab shows it after a
  reload; an installed app picks it up the next time it starts (Chrome may ask you to confirm the new icon).

## [3.6.1] - 2026-10-19

### Fixed
- Daily Walk: the "Read?" and "Mark as read" buttons show their empty check circle again, so the label sits centered
  instead of after a blank gap.

## [3.6.0] - 2026-10-19

### Added
- **Daily Walk**, a new page in the sidebar above Scripture: each day's devotional readings side by side.
  - **My Utmost for His Highest** (Oswald Chambers, Updated Edition) from utmost.org, with the day's key verse and
    Bible-in-a-year reading. Readings are kept once loaded, so days you've seen open instantly.
  - **Devotional books from EPUB files** (Books → Add an EPUB…), shown next to My Utmost. Each day's passages, reflections
    and "Thoughts for Prayer" are laid out for reading. Copy-protected EPUBs can't be read.
  - **One day picker for both**: a week strip, previous/next day, Today and a date picker. The ← and → keys move a day
    and T jumps to today.
  - **Read checks** for each reading, and **stats**: your streak of days with every reading done, days this month and
    this year, readings per book, and a 26-week history you can click to go to a day.
  - **Journal**: makes a note for the day (tagged Devotions) with the readings, the prayer prompt, and headings for
    what stood out, application and prayer. Next time it opens the same note.
  - Bible references in the readings open in Logos.
- **ESV Bible text** (Settings → ESV Bible, with your own free key from api.esv.org):
  - Hover over any Bible reference in a note or on Daily Walk to read the passage.
  - Right-click a reference → **Insert ESV text**, or type **/esv** in a note, to add the passage as a quotation
    ending "(ESV)".
  - As Crossway asks, at most 500 verses are kept on the server, and the ESV is credited with a link to esv.org.

### Changed
- Hovering over a Bible reference in a note shows a card instead of the browser's tooltip.

## [3.5.3] - 2026-10-19

### Changed
- New color scheme to match the Lampstand site's **Lamplight** palette: a deep navy sidebar, lapis blue buttons
  and highlights, and warm sand and off-white backgrounds. Dark mode uses Lampstand's **Night Watch** scheme
  (midnight blue with soft blue highlights). The installed app's title bar uses the new colors too.

### Fixed
- The selected view button on the Calendar page (Month, Day, Agenda…) now has readable text.

## [3.5.2] - 2026-10-19

### Changed
- Spelled "color" throughout the app (it said "colour" in places).
- Fresher, more modern colors for tags and task lists, and three more to pick from: **lime**, **sky** and
  **indigo** (12 in all). Existing tags and lists keep their color choice in the new tone. The Tasks page's own
  accents (views, priorities, date chips) use the same palette.

## [3.5.1] - 2026-10-19

### Added
- **Search** on the Tasks page: finds words in titles, details, steps and list names (accents don't matter) and
  highlights them. Press / to search, Escape to clear. With no matches you can search all tasks instead.
- **Filter**: by due date (overdue, today, next 7 days, has/no date), priority, list, and tasks that repeat, have
  steps, are linked to a note or have started. Active filters show as chips you can remove one by one; they're
  remembered on this device.
- **Sort**: by due date (as before, with your own order within a day), priority, list, title or newest first.
  Sorting by priority or list groups the tasks that way, and dropping a task on a group gives it that priority or
  list. In Today and Upcoming the sort orders tasks within each day.
- **Start dates**: a task with a start date stays out of Today until that day, then shows under **Started** until
  it's done. Until then it's dimmed elsewhere with a "Starts Friday" chip, and Upcoming shows it on its start day.
  Set one in the details panel or dialog, or type "start monday" / "starts oct 20" in quick-add. Repeating tasks keep
  the same gap between start and due date. Moving a due date before the start date moves the start date too.

## [3.5.0] - 2026-10-19

A redesigned, more capable Tasks page.

### Added
- **Lists** (e.g. Church, Home, School) with colors. They sit in a new rail on the Tasks page beside **Today**,
  **Upcoming** (the next 7 days, day by day), **All tasks**, **Inbox** (tasks without a list) and **Completed**.
  Rename, recolor, delete (move the tasks to the Inbox or delete them too) and drag to reorder.
- **Steps**: a checklist inside a task, with a progress bar. Rows show "2/5"; click it to tick steps off in place.
  A repeating task's next occurrence starts with its steps unticked.
- **Smart quick-add**: type "Call Bob tomorrow 3pm !high #Church" or "Water plants every Mon and Thu" and the date,
  time, priority, list and repeat are filled in. They show as chips while you type; × on a chip keeps that text in
  the title. "#NewName" makes a new list. The ? button lists what it understands. It works on the dashboard too.
- **Details panel**: clicking a task opens it beside the list. Every change saves straight away.
- **Inline editing**: double-click a title to rename it in place.
- **Drag and drop**: reorder tasks, drop them on a day or "No date" to reschedule, or on a list in the rail.
- **Multi-select**: Ctrl/⌘-click, Shift-click or **Select**, then complete, set a date, move to a list, set the
  priority or delete them all at once. Ctrl/⌘+A selects all, Delete deletes, Esc clears.
- **Undo** on the toast after completing, deleting, rescheduling or moving tasks.
- "Move all to today" for overdue tasks, a right-click menu with Due today/tomorrow/No date and Move to list, and
  N to jump to the add box.

### Changed
- A new look for tasks: priority-colored checkboxes, date chips (red overdue, green today), list and step chips,
  empty states, and a phone layout with the views as a scrolling strip and the details full screen.
- Deleting a task no longer asks first; Undo puts it back.
- Tasks dialogs on the dashboard and calendar have List and Steps too.

## [3.4.3] - 2026-10-19

### Added
- **Sacked** scoring setting (Passing): points for each time a quarterback is sacked (e.g. -0.5 or -1). It starts at 0.
  Quarterbacks' stat lines show sacks taken ("2 sck").

## [3.4.2] - 2026-10-19

### Added
- A notice under **Player tracker**, and in the scoring settings, that fantasy points are estimates worked out from
  ESPN stats and may not match your league's official scores (stat corrections, rules the tracker doesn't cover,
  rounding).

## [3.4.1] - 2026-10-19

### Changed
- Kicking scoring splits field goals into **0–19, 20–29, 30–39, 40–49 and 50+ yards**. Lineups that had a custom
  "FG 0–39" value keep it for each of the three short ranges.

## [3.4.0] - 2026-10-19

### Added
- More scoring settings for each lineup in the player tracker:
  - **Completions** (points per completion) and **rush attempts** (points per carry).
  - **Two-point conversions**, scored separately for passing, rushing and receiving. They're worked out from ESPN's
    scoring plays, so a pass to a receiver credits both players. Two-point conversions are worth 2 points by default.
  - **Yardage bonuses** for passing, rushing and receiving: a threshold (e.g. 300 passing yards) and the points
    added once a player reaches it in the game.
  - Defense: **tackles for loss** and **4th-down stops** (the opponent's failed fourth-down tries).
- The stat lines show two-point conversions (2PT), and defenses show TFL and 4th-down stops.

## [3.3.0] - 2026-10-19

### Added
- **Fantasy points** in the player tracker: points for each player and a **total for each lineup**, updated live
  during games.
- **Scoring settings for each lineup** (the gear on the lineup): start from **Standard**, **Half PPR** or **PPR**, then
  change any value. Settings cover passing, rushing and receiving (yards per point, TDs, receptions,
  interceptions), fumbles lost and return TDs, kicking (field goals by distance, misses, extra points) and defense
  (sacks, INTs, fumble recoveries, TDs, safeties, and points-allowed tiers). **Copy from…** reuses another
  lineup's settings. Lineups start on Half PPR. Two-point conversions and yardage bonuses aren't counted.

### Changed
- Player cards are much more compact: one row per player, with the game and a short stat line under the name and
  the points on the right.
- The tracker keeps showing a week's final scores and stats **through Wednesday midnight (Central)**, then moves to
  the next week's games, with **BYE** for teams that are off.

## [3.2.0] - 2026-10-19

### Added
- **Player tracker** on the Sports page, for your fantasy starters, using ESPN data with no sign-in.
  - **Lineups…** sets how many lineups you have (one per fantasy team) and how many starters each one has.
  - Fill each spot with any NFL player, or a team defense (search for the team, e.g. "packers def").
  - Each player shows their **ESPN photo** (a team logo for defenses), any injury tag (Q, D, O, IR), and this
    week's game: kickoff time and TV channel before it starts, the **live score** and clock while it's on, and the
    final result after.
  - Stats for the game, by position:
    - QB: completions/attempts, passing yards and TDs, interceptions, rushing yards and TDs.
    - RB: carries, rushing yards and TDs, catches, receiving yards and TDs.
    - WR/TE: catches, targets, receiving yards and TDs, longest catch.
    - K: field goals, longest, extra points, points.
    - Defense: points and yards allowed, sacks, interceptions, fumble recoveries, TDs.
  - Click a player to replace them, or **×** to clear the spot. Lineups are saved on the server, so every device
    shows them.

### Removed
- **Yahoo Fantasy** connection: Yahoo now requires a reviewed developer application. Its setting is removed
  from Settings and any saved Yahoo details are deleted.

## [3.1.0] - 2026-10-19

### Added
- **Sports page** (in the sidebar under Scripture), with scores, schedules and standings from ESPN:
  - **Favorite teams…** lets you choose teams in the **NFL, MLB, NHL, college football (NCAAF) and NCAA men’s
    basketball**, and put them in your own order. Your choices are saved on the server, so every device shows them.
  - Each team shows its record and place in the standings, its **last result** and **next game** (time and TV
    channel), and the **live score** while a game is on. The page refreshes every 30 seconds during a game.
  - **Schedule** lists the whole season. **Standings** shows the team's division or conference.
  - Games on channels YouTube TV carries have a **YouTube TV** link.
- **Yahoo Fantasy Football** on the Sports page: your matchup with live points, projections and win probability;
  your lineup with injury tags; and the league standings, for every NFL league you're in. It's read-only. Connect it in
  **Settings → Yahoo Fantasy**: it walks you through registering a Yahoo app. Yahoo reviews new apps before they can
  read Fantasy data, so it works once Yahoo approves yours.

## [3.0.8] - 2026-10-19

### Changed
- The **Notebooks** and **Tags** management pages moved down the sidebar, between **All notes** and **Templates**.
  The top of the sidebar is now Dashboard, Calendar, Tasks and Scripture.

## [3.0.7] - 2026-10-19

### Changed
- The **Tags** section of the sidebar starts collapsed; click its header to open it. Each device remembers the choice
  after that.
- **All notes** and **Templates** moved down the sidebar, below Tags (just above Trash).

## [3.0.6] - 2026-10-19

### Added
- **"New version available" banner.** After an update, an open Notes window (the installed app or a browser tab)
  shows **Notes vX is available** with a **Reload** button at the bottom right. It checks when you come back to
  the window and every 15 minutes. **×** hides it until the next release. A note you're editing is saved before
  the reload.

## [3.0.5] - 2026-10-19

### Changed
- The **Notebooks** section of the sidebar can be collapsed, like Shortcuts and Tags: click its header. Each device
  remembers whether it's open. Creating a notebook or stack, or dragging a notebook out of a stack onto the header,
  opens it again.

## [3.0.4] - 2026-10-19

### Added
- **Install Notes as an app.** It opens in its own window, without the browser's tabs and address bar, and gets an
  icon in the Start menu and taskbar (or on a phone's home screen). It's the same app and the same notes, still
  kept on the server. **Settings → App → Install…** brings up the browser's install prompt, or shows the steps for
  Edge, Chrome, Safari, iPhone or Android. The browser only offers it once the device trusts the certificate.
- The installed app's title bar matches the light or dark theme.

## [3.0.3] - 2026-10-18

### Fixed
- Links to Logos books (commentaries, handbooks…) now open the book at the linked page in the Logos desktop app,
  not just Logos. The web form of the location ("VolumePage.V+1%2c+p+15") is turned into the desktop app's own
  form ("VolumePage.V_1,_p_15").

## [3.0.2] - 2026-10-18

### Added
- **Right-click a link** in a note for **Open in Logos** (or **Open link**), **Copy link** and **Remove link**
  (removing a link keeps its text).

### Fixed
- **Ctrl+click** (⌘+click on a Mac) on a Bible reference or a Logos link now opens it in the Logos desktop app.
  Chrome had treated it as "open in a background tab", which doesn't work for an app.

## [3.0.1] - 2026-10-18

### Changed
- **Logos links open in the Logos desktop app** on computers: Bible references, links pasted from Logos, the
  Scripture page's **Open in Logos**, and plain ref.ly passage links. The browser may ask the first time; tick
  "Always allow". Phones keep using the Logos website / mobile app.
  - **Settings → Logos** (per device): choose the desktop app or the website, and the Bible passages open in. It's
    ESV to start with. For another Bible, paste a link copied from it in Logos. **Test: open John 3:16** checks it.
  - Notes, copied links and WordPress posts still use the universal ref.ly form, which works without Logos installed.

### Fixed
- Links and Bible references in notes now show the hand pointer when you hover over them.

## [3.0.0] - 2026-10-18

The study & research release: citations, Logos and a Scripture index.

### Added
- **Citations and footnotes from Zotero**
  - **Settings → Zotero & citations**: paste a read-only Zotero API key (your library needs to sync to zotero.org).
    Group libraries the key can read are included. The key is stored encrypted.
  - Cite a source with **/cite**, the toolbar's citation button, or **Ctrl+Alt+F**. Search your library, add a
    page (or chapter, section, verse…), and optional text before or after ("See", "emphasis added"). Cite several
    sources in one footnote. Click a citation to change or remove it.
  - **/footnote** adds a numbered footnote with your own text.
  - Each note shows its **Notes** and **Bibliography** under the text. Notes styles give a full first note and
    short notes after that.
  - **Citation style** (for every note): Turabian 9th / Chicago 17th notes (the default), Chicago 18th notes,
    SBL Handbook 2nd ed., or APA 7th (author–date, with the citation in the text).
  - Cited sources are kept in the app, so notes keep their citations offline and in backups.
    **Refresh sources** picks up changes made in Zotero.
  - **WordPress**: citations become WordPress's own footnotes, followed by a Bibliography, all editable in the
    block editor.
- **Logos**
  - Bible references in notes are underlined. **Ctrl+click** (⌘+click) opens the passage in Logos (desktop, web
    or mobile). Right-click for **Open in Logos**, **Find notes on this passage** and **Copy Logos link**.
  - Paste a link from Logos (**Copy location as → URL**, or a `logosres:` link) and it becomes a readable link that
    opens in Logos. **/logos** adds a named link to a commentary or other book.
  - Paste a quote copied from Logos: the quote goes in as plain text and the citation Logos adds becomes a
    footnote, with the book title still in italics. Ctrl+Z puts back the plain paste.
- **Scripture index**: the new **Scripture** page in the sidebar.
  - Find notes on a passage ("Romans 8:28-30", "Ps 23", "1 Cor 13"). Overlapping passages count, so Romans 8:29
    finds a note on Romans 8:28–30 and one on all of Romans 8.
  - Browse the Old and New Testament by book and chapter, with how many notes mention each.
  - References are read the same way as the Scripture Blog plugin on the website (book names, abbreviations,
    "1 Cor", "II Kings", ranges and lists like "Hosea 11:5; 12:9, 13").

## [2.11.1] - 2026-10-18

### Added
- **Select several notes** in the note list:
  - **Ctrl-click** (⌘-click on a Mac) adds or removes a note; **Shift-click** selects everything between the
    note you're on and the one you click.
  - On phones, tap the **✓** button above the list, then tap notes to select them.
  - The bar above the list shows how many are selected and has **Move to notebook**, **Add or remove a tag** and
    **Move to Trash**. Its **⋯** menu also has **Select all**, both pins, **Make into templates**, and the rest.
    Right-click a selected note for the same menu.
  - In the Trash: **Restore** or **Delete forever** the selected notes. In Templates: **Stop using as templates**.
  - Press **Escape** or **×** to clear the selection. Changing lists clears it too.
- **Insert template** into the note you're writing, at the cursor. Use the new template button in the toolbar,
  type **/template**, or choose **Insert template…** from the note's **⋯** menu. Placeholders are filled in, attachments
  are copied into the note, and the template's tags are added.
- **Tags page**: with one tag selected, the selection bar has **Rename…** and **Tag notes…**.

## [2.11.0] - 2026-10-18

### Added
- **Tags page** (sidebar → **Tags**): every tag with its note count and when it was last used. Search, sort by
  name, most used or recently used, and select several at once.
  - **Rename** a tag. Renaming it to the name of another tag offers to **merge** the two.
  - **Merge** tags into another one; their notes get the tag you choose.
  - **Delete** a tag. It's taken off every note, and the notes are kept.
  - **Color**: pick one of nine colors for a tag. The color shows on the tag in the sidebar, on the note's tag
    chips and in the note list. Click a tag's dot on the Tags page to change it.
  - Select several tags to merge, color or delete them together.
  - The count shows notes; templates and notes in the Trash that use the tag appear as "+N".
- **Tag notes…**: add a tag to many notes, or take it off, from one list with search and tick boxes.
  **New tag** starts the same way: name it, then choose its notes.
- **Tag shortcuts**: star a tag on the Tags page, choose **Add to shortcuts**, or drag a tag from the sidebar into
  Shortcuts.
- **Drag a note onto a tag** in the sidebar to tag it.
- **Untagged notes**: a list of notes without tags, from the Tags page or the sidebar's Tags heading.
- Right-click a tag in the sidebar or on the Tags page for all of the above. Right-click the **Tags** heading for
  Manage tags, New tag and Untagged notes.
- The note list shows up to three of each note's tags.

### Fixed
- Tags left with no notes after notes were deleted forever (or the Trash was emptied) are now removed.
- Commas in tag names (which the tag box treats as separators) are turned into spaces.

## [2.10.0] - 2026-10-18

### Added
- **Templates**: turn any note into a template and start new notes from it.
  - **Make into template** is in a note's **⋯** menu and its right-click menu. The note moves to the new
    **Templates** list in the sidebar. **Stop using as template** puts it back in its notebook.
  - Templates stay out of All notes, notebooks, tags, search and the dashboard. Deleting a notebook doesn't
    delete the templates that came from it.
  - Start a note from a template with the template button next to **New note**, the template button above the
    note list, or **New note from template…** on a notebook's or All notes' right-click menu. Pick the template
    and the notebook for the new note.
  - In the Templates list, each template has a **Use template** button. An open template shows a banner with
    **New note from template**.
  - New notes get the template's title, content, tags and attachments. Attachments are copied, so the note
    keeps them even if the template is deleted later.
  - Placeholders are filled in when you use a template: `{{date}}` (October 18, 2026), `{{time}}` (3:45 PM),
    `{{weekday}}` (Sunday) and `{{year}}`, in titles and text.
  - The **+** in the Templates list makes a new, empty template.
- **Duplicate** a note or a template from its **⋯** or right-click menu, including its attachments.

## [2.9.0] - 2026-10-18

### Added
- **Pin to dashboard** is now separate from **Pin to top of notebook**. Each note can have either, both or
  neither. Find both in the note's **⋯** menu and in its right-click menu.
  - Notes that were pinned before this version keep both pins, so nothing leaves your dashboard.
  - In the note list, a pin icon marks notes pinned to the top of their notebook, and a house icon marks notes
    on the dashboard.
  - The **Pinned notes** widget now shows every note pinned to the dashboard, not just the latest six.
- **Right-click menus** (long-press on most Android phones):
  - **Notes** in the note list and on the dashboard: Open, Pin to top of notebook, Pin to dashboard,
    Move to notebook…, Copy link to note, Move to Trash. In the Trash: Restore, Delete forever…
  - **Notebooks** in the sidebar and on the Notebooks page: New note, Rename…, Move to stack…, Merge into…,
    Add to/Remove from shortcuts, Delete…
  - **Stacks**: New notebook in stack…, Rename stack…, shortcuts, Delete stack…
  - **Shortcuts**: New note, Rename…, Remove from shortcuts.
  - **Tasks**: Edit…, Mark done / Mark not done, Delete task…
  - **All notes** (New note) and the **Notebooks** heading (New notebook, New stack, Manage notebooks).
  - Menus work from the keyboard too: ↑/↓ to move, Enter to choose, Escape to close.

### Changed
- Moving a note to the Trash (or restoring one) from a right-click menu leaves the note you have open alone.
- The Notebooks page's **⋯** menu for a notebook now also offers **Move to stack…** and shortcuts.

## [2.8.6] - 2026-10-18

### Changed
- **Phones ignore widget heights**: on a phone (or any window 800 px wide or less) every dashboard widget shows
  in full, with no scrolling inside it. The heights you set are kept and still apply on wider screens.
  - The height bar is hidden in **Customize** on phones, since it has no effect there.
  - The **Customize** help text now uses the full width on phones, with **Reset** and **Done** below it.

## [2.8.5] - 2026-10-18

### Changed
- A widget with a set height now fades out at the bottom when there's more to scroll to, instead of cutting a
  line in half. The fade disappears once you scroll to the end.

## [2.8.4] - 2026-10-18

### Added
- **Widget heights**: in **Customize**, drag the bar at the bottom of a widget to set its height. The bar shows
  the height as you drag, in steps of 10 px.
  - If the content is taller than the widget, it scrolls inside the widget.
  - Double-click the bar to make the widget fit its content again.
  - With the keyboard: focus the bar, then use ↑/↓ to change the height by 20 px, or Delete to fit the content.
  - Heights are saved with the rest of the layout, so they follow you to other devices.

## [2.8.3] - 2026-10-18

### Changed
- **Dashboard widgets stay where you put them.** Each widget now remembers its column (left or right) as well
  as its order and width. What you arrange in **Customize** is exactly what you get after **Done**.
  - Hiding a widget, or Pinned notes having nothing to show, only closes the gap in its own column. Nothing
    else jumps to the other column.
  - New **‹ / ›** button on each widget in **Customize** moves it to the other column.
  - The arrows move a widget up or down within its column. Past a full-width widget they move it into the
    next section.
  - Drag a widget onto another to take its place and column, or onto the dashed area at the bottom of a
    column to put it last there.
  - Your current arrangement carries over, alternating left and right as before.
  - On phones the left column shows first, then the right.

## [2.8.2] - 2026-10-18

### Changed
- **Dashboard masonry layout**: each widget is now only as tall as its content, and the next widget fills in
  under whichever column is shorter, so there are no empty gaps. Full-width widgets still sit across both
  columns, below everything before them. This replaces the equal-height rows from 2.8.1.

### Fixed
- The blog's name at the top of the WordPress widget was slightly cut off. It now shows in full.

## [2.8.1] - 2026-10-18

### Added
- The app version now shows next to **Settings** at the bottom of the sidebar.

### Changed
- **Dashboard alignment**:
  - Widgets side by side are now the same height, so each row ends evenly. Links like **Open calendar →**
    sit at the bottom of the card.
  - The **Customize**, **Task** and **Event** buttons line up with the right edge of the widgets on wide screens.
  - Notes, tasks and events in a widget now line up with the widget's heading.
  - In **Customize** mode the WordPress widget's toolbar sits in the same place as the other widgets'.

## [2.8.0] - 2026-10-18

### Added
- **Full-screen notes**: the new button next to **Saved** hides the note list so the note fills the space
  beside the sidebar. The writing column widens to match.
  - Full screen stays on after a reload. Choosing a notebook, tag or **All notes** in the sidebar turns it off.
  - On phones a note already fills the screen, so the button isn't shown there.
- **Schedule WordPress posts**: **Post to WordPress…** now offers **Schedule** next to **Save as draft** and
  **Publish now**. Pick a date and time in the app's time zone (shown under the box).
  - The post goes live at that exact moment, whatever time zone the WordPress site is set to.
  - A scheduled note shows a **Scheduled** badge; hover it to see when the post goes live.
  - Reopen the dialog to change the time. **Publish now** puts the post live immediately, and
    **Save as draft** cancels the schedule.
  - **Manage posts** shows when each scheduled post goes live.

### Changed
- The **WordPress dashboard widget** now looks like your site. Its colors, fonts, icon and tagline come from
  the site, so it follows the Lampstand color scheme and font style you choose in WordPress (refresh the
  widget to pick up a change). Other themes get Lampstand's original look.
  - It shows how many posts are published, scheduled and drafts, and adds **Pending review** only when
    something is waiting for review.
  - **Coming up** lists the next scheduled posts and when each goes live, above the latest posts.
  - Comments are no longer shown.
  - The site's web fonts are downloaded once and served by this app, so the widget also works offline.

## [2.7.2] - 2026-10-18

### Added
- **Backups widget** on the dashboard (on by default; move or hide it with **Customize**). It shows:
  - whether the last off-site backup worked and when, with notes, files and snapshots kept;
  - the last restore check and when the next nightly backup runs;
  - the local backups on this server;
  - when you last confirmed your passphrase.

  **Back up now**, **Test passphrase…** and **Manage…** are right there. If off-site backup isn't set up,
  it says so and offers to set it up.
- **Test passphrase…** (in the widget and in **Settings → Off-site backup**): type the backup passphrase
  from where you keep it. You're told whether it's the right one: it must match the key this server
  encrypts with, and it's used to decrypt the backup in OneDrive. The passphrase isn't stored or written
  anywhere.
  - Even a wrong capital letter or an extra space is caught.
  - The widget reminds you to test it if you haven't in 90 days.
  - 10 tries per 15 minutes.

## [2.7.1] - 2026-10-18

### Added
- **`npm run restore`**: rebuilds a server's notes, attachments, settings, certificates and WordPress key from
  the encrypted OneDrive backup.
  - It asks for the OneDrive sign-in (`rclone authorize "onedrive"`) and the backup passphrase, then lets
    you pick a snapshot (newest by default, or `--snapshot`).
  - It checks the database opens and every attachment matches before putting anything in place.
  - It never overwrites existing data unless you pass `--force`, and then it moves old data aside rather
    than deleting it.
  - An older snapshot also gets back attachments deleted since then, from the backup's "recently deleted".
  - The restored certificate authority means devices keep trusting the rebuilt server, and the WordPress
    connection works without signing in again.
- **DISASTER-RECOVERY.md**: step-by-step rebuild on a new server. It covers what to keep outside the server,
  installing Node without root, cloning, restoring, the certificate and address, checks, and rehearsing.

### Changed
- The rclone and OneDrive sign-in code moved to its own module, shared by the backup and the restore.
  No change in behavior.

## [2.7.0] - 2026-10-18

### Added
- **Off-site backup to OneDrive, encrypted** (**Settings → Off-site backup**). After the nightly local
  backup, a copy of your notes, attachments, settings, the server's certificates and the WordPress key goes
  to your OneDrive.
  - It's encrypted on this server with a passphrase you choose, so OneDrive only sees scrambled names and
    contents. Keep the passphrase somewhere other than this server: without it the backup can't be restored.
  - Sign in by running `rclone authorize "onedrive"` on any computer with a browser and pasting the result.
    No Microsoft developer account is needed.
  - Runs daily. Database snapshots are kept 30 days, and the latest 3 are always kept, so a long outage can
    never empty the backup.
  - Attachments are only sent when new. Deleted ones stay in the backup for 30 days.
  - A weekly check downloads the latest snapshot and makes sure it opens, and confirms every attachment
    matches. **Back up now** and **Check backup** run them on demand.
  - If a backup or check fails, or there's been no backup for two days, the dashboard shows a warning.
  - The backup is standard rclone crypt, so it can be read even without this app (see the README).
- `npm run install-rclone` installs a pinned, checksum-verified rclone into `~/.local/bin` (no root needed).

## [2.6.0] - 2026-10-18

### Added
- **Delete all completed tasks**: Tasks → Completed has a **Delete all completed** button. It deletes every
  completed task at once (after asking), including any beyond the 300 the tab shows. Tasks still to do
  aren't affected.
- **Events list**: the Calendar has a **Calendar | List** switch. The list shows every event from a start
  date (past dates work) for 1 week up to 2 years, or until a date you choose, grouped by day. Repeating
  events appear on each day they happen; an event spanning several days is listed once ("Oct 16 – Oct 19").
  Click an event to edit it. The list mode and period are remembered.
- **Delete WordPress posts**: **Manage posts…** (in Settings → WordPress and on the dashboard's WordPress
  widget) lists all the site's posts, with search and a status filter, and shows which came from a note.
  Delete one post or tick several. Choose **Move to Trash** (restorable in WordPress; the default) or
  **Delete permanently**.
  - A posted note's menu also has **Delete WordPress post…**. The note's Published/Draft badge goes away,
    and posting the note again makes a new post with your earlier choices filled in.

### Changed
- The WordPress widget's "All posts" link is now **WordPress admin**, next to **Manage posts…**.
- Settings → WordPress is shortened to "Post notes to WordPress." On phones its buttons sit below the text.

## [2.5.1] - 2026-10-17

### Added
- **WordPress dashboard widget** (optional; turn it on with **Customize** on the dashboard): published
  posts, drafts, scheduled and pending posts, comments (with how many are awaiting moderation), how many
  posts came from your notes, and the latest posts. Posts that came from a note open that note.
- **Auto-tag posted notes**: a note posted to WordPress is tagged with the blog's name, so you can find
  everything you've posted. Turn it off in **Settings → WordPress**.

### Changed
- **Scripture references are checked before saving.** If the site can't read some of them, you're shown
  which ones and can fix them or save anyway. The tidied references are shown as "Saved as".
- **References and downloads are never wiped by accident.** They're only sent when you've entered or
  changed them, so ones added in WordPress stay put. Clearing the box on purpose still removes them.
  The form also starts from the post's current references on the site.
- The app checks the Scripture Blog plugin is still installed each time you post, and leaves out the
  scripture fields if it isn't.

## [2.1.0] - 2026-10-17

### Added
- **Post to WordPress**: connect your WordPress site in **Settings → WordPress** with an application
  password (WordPress: Users → Profile → Application Passwords). Then choose **Post to WordPress…**
  from a note's menu.
  - The form is built from what the site asks for: categories, tags and any other taxonomies (with
    the Scripture Blog plugin: Content Types, Bible Characters, Themes & Doctrines), the excerpt, a
    featured image from the note's pictures, and the plugin's Downloads box.
  - With Scripture Blog 2.5.0 or later, add scripture references; they're checked as you type and
    place the post in Bible order.
  - Choose **Save as draft** or **Publish now**. Posting the note again updates the same post and
    remembers your choices.
  - Pictures, drawings, audio and files are uploaded to the site's media library (each only once).
    The post arrives as WordPress blocks, so it can be edited block by block.
  - Notes that have been posted show a Draft / Published badge that links to the post.
- The site's sign-in details are stored encrypted on this server and never sent to the browser.

## [2.0.0] - 2026-10-17

### Added
- **Drawing**: add a drawing to any note (toolbar pen button, or type `/draw`) and write or sketch
  with an S Pen, Apple Pencil, mouse or finger. Lines follow pen pressure. Choose pen, highlighter or
  eraser, five colors, three thicknesses, and blank, lined or grid paper. Holding the S Pen's side
  button erases. Once you've used a pen on a device, your palm and fingers scroll the page instead of
  drawing (the hand button turns finger drawing back on). The drawing grows as you write near the
  bottom, or drag its bottom edge. Undo, Redo and Clear are on the drawing's own toolbar. Ink color
  follows light and dark mode.
- **Take photo** (toolbar camera button, or `/photo`): phones and tablets open their camera app;
  computers show a live camera preview with Capture, Retake and Switch camera.
- **Record audio** (toolbar microphone button, or `/record`): record with a timer and level meter,
  pause and resume, listen back, then insert it into the note. Recordings are saved as .m4a so they
  play on every device.

## [1.5.3] - 2026-10-17

### Changed
- Graphical updates.

## [1.5.2] - 2026-10-17

### Changed
- **Settings**: the Change password, Trust this device and View changelog buttons now line up on the
  right, each on one line with shorter descriptions.

## [1.5.1] - 2026-10-17

### Added
- **Dashboard banner image**: in **Customize**, choose "Add a banner image" (PNG, JPEG, GIF, WebP or
  AVIF, up to 25 MB). A slider sets which part of the image shows, and you can change or remove it.
  The image is stored on the notes disk, so it's the same on every device and included in backups.

### Changed
- **Settings → Password**: the change-password form now opens from a "Change password…" button
  instead of always being shown.
- The sidebar's **Notebooks** link uses the notebook icon.

## [1.5.0] - 2026-10-17

### Added
- **Customizable dashboard**: choose **Customize** to drag widgets into any order (or use the arrows),
  switch each between full and half width, and hide the ones you don't want. **Reset** restores the
  default. The layout is saved on the server, so it's the same on every device.
- **Notebooks page** (sidebar → Notebooks): all stacks and notebooks in one place, with note counts and
  last-updated dates. Search and sort them. Rename, move to a stack (pick from the list or drag), add to
  shortcuts with the star, and select several to move or delete together.
- **Merge notebooks**: "Merge into…" moves every note from one notebook into another and removes the
  empty one. It's on the Notebooks page and in the sidebar's notebook menu.
- **Markdown import**: bring in `.md` files, or a whole folder. It handles
  headings, task lists, tables, code blocks (with language), `> [!note]` callouts, and images and files
  the notes link to (which become attachments), including `![[embeds]]`. Front-matter title, tags and
  dates are kept.

### Changed
- **Importing moved to Settings → Import**, with .enex and Markdown side by side. The sidebar's
  import button is gone.
- Headings deeper than level 4 in imported notes become level 4, the deepest the editor supports.

## [1.4.1] - 2026-10-17

### Changed
- **Numbered list levels reversed**: lists now number 1. → A. → I. for the first three levels
  (was I. → A. → 1.). Deeper levels are unchanged: a. → i. → (1) → (a).

## [1.4.0] - 2026-10-17

### Added
- **Storage meter** on the dashboard and in Settings → Storage. It shows space used against total
  space on the notes disk only, split into notes & attachments, other and free. It turns amber at 80%
  full and red at 90%.

### Changed
- **Notes now live on their own disk.** The database and attachments moved from `data/` to
  `notes-data/`, a separate disk. Certificates and nightly backups stay on the system disk, so a
  backup survives losing the notes disk.
- New `npm run move-storage` command sets up the notes disk and moves existing notes onto it.
- The server won't start if the notes disk isn't mounted. Before, it would have started with an
  empty notebook.

## [1.3.3] - 2026-10-17

### Added
- **Trust this device**: a guide on the sign-in screen ("Browser says Not secure?") and in
  Settings → Security certificate. It downloads the app's certificate authority and gives install
  steps for Windows (a one-line PowerShell command), macOS, iPhone/iPad, Android and Linux, with
  the SHA-256 fingerprint to check against. The certificate is also downloadable at `/ca.crt`.

### Changed
- Collapsed headings no longer show a trailing "…".

### Fixed
- Devices that don't trust the certificate yet can always click through the browser warning
  (**Advanced → Proceed**). The server no longer sends HSTS, which could block that option.

## [1.3.2] - 2026-10-17

### Fixed
- **Collapsible headings work again**: clicking the arrow beside a heading did nothing because of an
  error in the click handler. A Heading 1 now folds everything down to the next Heading 1, and a
  Heading 2 folds down to the next Heading 2 (or Heading 1).
- **"Not secure" warning**: the HTTPS certificate didn't include `notes.example.lan`, the address used
  to reach the app. The certificate has been re-issued to cover it. The certificate authority is
  unchanged, so devices that already trust it need nothing new.
- `npm run gen-certs` now remembers the names the certificate covers (`data/certs/hosts.txt`), so
  re-issuing it later can't silently drop one.

## [1.3.1] - 2026-10-17

### Changed
- **Code blocks use the Campbell PowerShell color scheme** from Windows Terminal: a PowerShell-blue
  background with PSReadLine-style colors (commands yellow, variables and keywords green,
  strings cyan, comments dark green).

### Fixed
- Collapsing a Heading 1 or Heading 2 now hides every block beneath it, including smaller
  headings, up to the next Heading 1 or Heading 2, and the arrow responds reliably to clicks.
- Switching notebooks, stacks or tags now opens the top note of the new list, instead of
  sometimes staying on a note from the previous notebook.

## [1.3] - 2026-10-17

### Added
- **Shortcuts** in the sidebar for quick access to notebooks and stacks. Add one with
  **Add to shortcuts** in a notebook or stack's ⋯ menu, or drag it onto the Shortcuts heading.
  Drag shortcuts to reorder them, and drop notes on a notebook shortcut to move them.
- **Collapsible headings**: click the arrow beside a Heading 1 or Heading 2 to fold away
  everything beneath it, up to the next heading of the same or a higher level. The folded state
  is saved with the note, and moving the cursor into a folded section opens it again.
- **PowerShell** syntax highlighting in code blocks (also recognised as `ps1` and `pwsh`).
- **Close (×) button** at the top of Settings and the changelog, so the long changelog no longer
  has to be scrolled to the bottom to close.

### Changed
- **Numbered lists use Harvard outline numbering**: I. → A. → 1. → a. → i. → (1) → (a)
  as lists are nested deeper.
- **Tables**:
  - The table button now shows a grid for picking the size of the new table (up to 8 × 8).
  - Cells can be given a background color, and the first column can be made a header column.
  - **Merge cells** and **Split cell** are now separate buttons, available only when they apply.
  - The table tools are grouped into Row, Column, Header and Cells.
  - Tables have rounded borders, a stronger header row and lightly striped rows.

### Fixed
- In Settings → Appearance, the System / Light / Dark selector now moves as soon as it is clicked,
  instead of only after closing and reopening Settings.

## [1.2] - 2026-10-16

### Added
- **About** section in Settings showing the app version, with a **View changelog** button that
  opens this changelog inside the app.

## [1.1] - 2026-10-16

### Added
- **Dashboard** (new home screen): today's schedule, overdue and due-today tasks with quick add,
  the next 7 days, pinned notes and recent notes.
- **Calendar** with month, week, day and agenda views. Click or drag to create events, drag to move
  or resize them. Events have a color, location, details and an optional linked note.
  On phones the calendar defaults to the agenda view.
- **Tasks** with due date and optional time, priority, details and a linked note. Grouped as Overdue,
  Today, Tomorrow, Next 7 days, Later and No date, with a Completed tab. Dated tasks also appear on the calendar.
- **Recurring events and tasks**: daily, weekly on chosen days, monthly by date or nth/last weekday,
  yearly, or every N; ending never, on a date, or after N times.
  - Editing or deleting a repeating event offers *this event*, *this and following events*,
    or *all events*.
  - Moving a whole series also shifts its weekdays and keeps individually edited occurrences.
  - Completing a repeating task creates the next one. If it was overdue, the next date is after today.
- All calendar and task times use America/Chicago (`NOTEAPP_TZ`), unaffected by daylight-saving
  changes or the viewing device's time zone.
- Sidebar entries for Dashboard, Calendar and Tasks, with a badge counting due and overdue tasks.
- Bookmarkable addresses: `#dashboard`, `#calendar`, `#tasks`, `#note/<id>`.

### Fixed
- Pressing Escape with two dialogs open now closes only the top one.

## [1.0] - 2026-10-16

Initial release.

### Added
- **Stacks → Notebooks → Notes** organisation. Drag notes onto notebooks and notebooks onto stacks.
  Includes tags, pinning, full-text search, sorting and a trash with restore.
- **Block editor**:
  - Blocks: headings, bulleted, numbered and to-do lists, quotes, syntax-highlighted code blocks,
    collapsible sections, callouts, tables, dividers, links, highlight.
  - Editing: a `/` command menu, Markdown shortcuts, drag handles to reorder blocks, and autosave.
- **Attachments** by upload, drag-and-drop or paste. Images display inline and can be resized,
  and audio and video play inline.
- **Embedded PDF reader** (pdf.js) for attached PDFs, with search, thumbnails, zoom, print,
  resizing and a full-screen view.
- **.enex import**, keeping attachments, tags, to-do lists, code blocks and dates.
- Single-user password login, HTTPS with a private certificate authority, light and dark themes,
  and a phone-friendly layout.
- systemd user service and a nightly backup of the database and attachments (14 kept).
