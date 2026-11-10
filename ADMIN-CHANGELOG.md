# Admin Console Changelog

The admin console's own history, newest first. It's versioned apart from Selah (CHANGELOG.md), which is what tenants
run: a console release doesn't need a Selah release, and the other way round. Its version is in
`server/admin/version.js` and shows at the foot of the console's menu.

## [Unreleased]

## [3.4.0] - 2026-11-10

Push notifications to the Selah phone and tablet apps.

### Added
- **Push to the Selah apps** (`server/admin/push.js`): the console sends each tenant's queued pushes (reminders, a quiet "check for changes", sharing notes) through Apple (APNs, HTTP/2 with a signed token) and Google (Firebase Cloud Messaging v1), with keys only the host has: `npm run admin -- push-keys apns <AuthKey.p8> --key-id <id>` and `push-keys fcm <service-account.json>` copy them to `<cloud root>/push` (readable only by the console's user; picked up without a restart; `push-keys` alone shows what's set). It keeps one waiting request per tenant, as sharing does, tells each tenant which platforms work, and hands back tokens Apple or Google say are gone. Tenants on releases before 13.0 are asked less and less often.

### Fixed
- Pruning old releases now also removes their Docker images (about 1 GB each), which were being left behind for good.

## [3.3.0] - 2026-11-06

Shipping a beta takes one command, and the demo can be tested without signing in.

### Added
- Command line: `demo-session` (an hour's sign-in to the demo as one line of JSON, from the demo's `/control/demo-session`; for the smoke test, so it never needs the demo's password) and `beta-review [<name>] [--json]` (what was ticked off and noted with the Beta button, from `/control/beta-review`).
- Demo Reset keeps `beta_review` (`KEEP_SETTINGS`), so notes about a beta survive the reset that follows it.

### Changed
- Pruning removes a beta once its release (or a later one) is main, whatever its age, unless a tenant runs it or could roll back to it.

## [3.2.0] - 2026-11-06

Releases go to a beta first, and there's a demo tenant to try them on.

### Added
- **Beta releases** (`server/admin/releases.js`): Prepare makes a beta by default (`beta_release`), which doesn't change what new tenants start on (`current_release`, now called main). **Promote** (`POST /api/admin/releases/promote`, `promoteRelease()`) makes the beta main; tenants already running stay where they are until they're updated. **As main…** prepares straight to main, for urgent fixes. Releases are labeled Main, Beta or Old (`channel` in `GET /api/admin/releases`, which also has `beta`).
- **Updates page**: a release picker (beta first when there is one) and checkboxes on the tenants, with **Update** (the chosen tenants to the picked release, one at a time, each checked, as before) and **Roll back** (each chosen tenant to the release it ran before, one at a time: `POST /api/admin/releases/rollback { slugs }`, `rollBack(slugs)`). A banner shows the waiting beta with **Promote to main…**. History shows promotes and demo resets.
- **Demo tenant Reset** (`server/admin/demo.js`): on the panel of the tenant called `demo`, **Reset to sample data…** (type demo; `POST /api/admin/demo/reset`, logged as `demo-reset`). The demo is stopped, its sign-in settings (`KEEP_SETTINGS`) and signed-in devices are read from its database, its storage is moved to `storage-before-reset/` (the one before it is replaced), and it starts on an empty database; then its control port gets the sign-in back and adds the sample data (Selah 10.2.1, `/control/demo-seed`). If any step fails, the old storage goes back and it starts as it was. Only when you click it; the monitor doesn't restart the demo while it's being reset, and updates wait for it.
- Command line: `prepare-release` makes a beta (`--main` for main), `promote [<version>]`, `update [<names>] [--beta | --release <version>]`, `rollback <names>`, `demo-reset [--yes]`.

### Changed
- Releases sort by version with pre-releases in order (`compareVersions`: 11.0.0-beta.2 < 11.0.0-beta.10 < 11.0.0). Pruning keeps main, the beta and every release a tenant runs or could roll back to, besides the newest three.

## [3.1.0] - 2026-11-03

### Added
- **Sign-in** on a tenant's panel (`Tenants.jsx`): the username and email the person signs in with (from `/control/health`'s `signIn`, Selah 10.0), the email as a mailto link, or "Password only (no username yet)".

### Changed
- **Two-step** on a tenant's panel reads "Off (recommended)" in plain text rather than as a problem: since Selah 10.0 it's the person's choice. The console's own sign-in still requires it.

## [3.0.0] - 2026-10-31

### Added
- **Sharing between tenants** (Selah 8.0): the console is the relay (`server/admin/sharing.js`). Tenants still can’t reach each other or the console; the console keeps one waiting request open to each active tenant’s control port (`GET /control/sharing/outbox?after=&wait=`, 25 s) and gets that tenant’s queued messages at once. It checks each one, then delivers it to the other tenant (`POST /control/sharing/inbox`). Checked here, not trusted from the tenant: contacts (`relay_contacts`, pending until the other side accepts), which tenant owns a share id and who it’s shared with (`relay_shares`), whether it takes comments, and whether sharing is on for both. Names come from the tenant list. A share’s snapshot is copied from the owner’s `storage/sharing/out/<id>` to each person’s `storage/sharing/in/<id>`, attachments as hard links where possible. Messages for a tenant that isn’t answering wait in `relay_held` and go, in order, when it’s back. The last message read from each tenant is kept in `relay_cursors`. Deleting a tenant ends its contacts and shares.
- **Sharing** page: each tenant’s contacts, what they share and what’s shared with them, waiting messages, and a **Turn off / Turn on** switch (`cloud.sharingOff`; off ends what they share and what’s shared with them, and their Selah shows sharing as off; the monitor re-sends the state to a tenant that missed it). Also every share (titles only) with its people, comment and copy settings, the contacts, and the sharing log (`relay_log`). `GET /api/admin/sharing`, `PUT /api/admin/sharing/:slug { on }` (logged as `sharing-switch`).

## [2.1.0] - 2026-10-31

### Added
- **Notice for Users** on the Overview (`NoticeCard` in `Maintenance.jsx`, `server/admin/notice.js`): when maintenance starts, when it ends (optional) and when the banner starts showing (times in this browser's time zone), plus an optional note. **Turn on and send** saves it (setting `user_notice`) and sends it to every active tenant; a tenant that doesn't answer gets it from the monitor once it does. **Turn off** takes it down. Its badge says whether it's off, waiting to show, showing, or over. `GET` / `PUT /api/admin/notice`; each save is logged (`user-notice`). Needs Selah 7.3.0 on the tenants. MAINTENANCE-PROCEDURE.md step 1 mentions it.

## [2.0.0] - 2026-10-26

### Changed
- **Selah 7's look**: the menu is a slim rail like Selah's, in walnut (`--adm-rail` tokens, light and dark) with an **Admin** mark under the logo, so the console reads as the console at a glance. Each page is an icon with its name; the alerts count is a badge on Overview. Appearance (Auto, Light, Dark in turn) and Sign out are at the foot of the rail; the console and Selah versions moved to the top bar.
- Page titles, card numbers and the tenant panel's heading use Source Serif 4; the interface uses Inter (both bundled). Cards, panels and dialogs have larger rounded corners, and card headings are small capitals.
- On a phone the menu opens as before, with each page's name beside its icon.

## [1.3.1] - 2026-10-26

### Changed
- **Long dropdowns** (more than 10 options) open a compact searchable list, and long pick-one dialogs get a search box, from the shared `SelectPicker.jsx` / `Dialogs.jsx` (Selah 6.4.1).

## [1.3.0] - 2026-10-25

### Added
- **Docs → Maintenance Procedure** (`MAINTENANCE-PROCEDURE.md`): how to stop Selah everywhere, update the operating system and Selah's own tools, reboot or start again, check everything is back, and what to do when something doesn't come back. The Mark done checklist links to it and gains the stop step.
- **`npm run admin -- maintenance-stop`**: puts Selah in maintenance mode (`maintenance-mode.json` in the cloud folder), stops the console (so its monitor can't start tenants again), every tenant and the gateway. Refused while a backup, restore or update is running (`--force` stops anyway).
- **`npm run admin -- maintenance-start`**: starts the gateway, each active tenant (waiting until it answers), ends maintenance mode and starts the console. A **reboot** does the same by itself: maintenance mode names the boot it was made in, and a console starting in a later boot ends it and starts every tenant. While it's on in the same boot, the monitor doesn't restart tenants or run the nightly backup.
- **Docs → Dependencies**: what Selah depends on, with this server's versions: the operating system, kernel, Docker and systemd; the tools Selah installs and pins (Node.js, Caddy, rclone), flagged when they don't match the pinned version; the tenant image's base and the images on the server; the Node packages Selah runs, and what's built into the page; and the outside services. Each says what it's for, how it's updated and what restarts. **Check again** looks afresh (otherwise kept 10 minutes).

### Changed
- Stopping a tenant asks its container to stop first (`docker stop`, 20 seconds) before removing it, and the console now finishes the requests under way and closes its database when it's told to stop, instead of quitting at once. Tenants do the same from the next Selah release (the code is in, `server/index.js`).
- The docs' Markdown shows tables, numbered lists and code blocks (the Disaster Recovery runbook's tables were shown as plain text).

## [1.2.1] - 2026-10-25

### Fixed
- **Restore…** seemed to have no Restore button: the dialog read the tenant's snapshot list from the storage again on every tab (4–10 seconds from OneDrive) and showed only a spinner and Cancel meanwhile. The list is now read once per dialog and kept on the server for 5 minutes (until the next backup), the wait says what it's doing, and the Test restore / Restore button is always there (greyed out until it can be used).
- **Notes & Notebooks** opens the latest snapshot by itself (choosing another one offers **Open this snapshot**); before, Restore only appeared after clicking Open. The dialog's buttons stay at the bottom when the list is long.

## [1.2.0] - 2026-10-25

### Added
- **The host backup can go to several places at once** (up to 4): Backups lists each destination with how its last backup went, **Reconnect…** and **Remove…**, and **Add a destination…**. Each night's snapshot of a tenant is made once and copied to every destination, each encrypted with its own passphrase; one that fails doesn't stop the others (the tenant's backup shows which failed). Each destination has its own rclone config (`hostbackup/dests/<id>.conf`); the one from before 1.2.0 stays as the first (`hostbackup/rclone.conf`, `host_backup_dests`). Restores ask which destination when there's more than one.
- **The same storage choices as a person's own off-site backup**: OneDrive, S3-compatible (Backblaze B2, Wasabi, Cloudflare R2, Amazon S3, other), WebDAV, or **Other (rclone)** for any remote you paste. **Test connection** checks it takes a write before you choose a passphrase.
- **Restore… → Notes & Notebooks**: bring single notes or whole notebooks back into a running tenant from a host-backup snapshot, as copies; nothing they have now changes. The console shows only notebook names, note titles, dates and attachment counts, never what notes say. The chosen notes go to the tenant as a note package with their attachments (from their own files, or the backup's `files/` and `deleted/`), and the tenant adds them itself (`/control/import-package`); its security log says notes were restored from the host's backup. Needs Selah 6.3.0 on the tenant.
- **An update banner** like Selah's: when the console (or the Selah build it serves) is newer than the open page, a banner offers **Reload**. `/api/version` now also gives `adminVersion`.

### Changed
- Backups → Tenants: "Their own OneDrive" is now "Their own backup".

## [1.1.0] - 2026-10-25

### Added
- **Restore a tenant from a backup file** they downloaded from Selah (Download a backup, 6.1.0): **Restore… → From a Backup File**. The file uploads straight to disk (`console-root/uploads/`, removed once restored, or after a day), then its passphrase and the tenant's name to confirm. It's unpacked and checked while their Selah keeps running; only then does it stop, move their data aside to `pre-restore-<stamp>/` and put the backup in place. If it doesn't start afterwards, the old data goes back. The same from the command line: `npm run admin -- restore-file <name> <file> [--yes]`.
- The tenant view shows which storage a tenant's own off-site backup uses (OneDrive, an S3 service or WebDAV) and when they last downloaded a backup. The security log names backup downloads.

### Fixed
- Setting up the host backup on S3-compatible storage with a passphrase that doesn't match a backup already there was allowed (`rclone cat` prints nothing there instead of failing). It's refused now, as it is for OneDrive.

## [1.0.0] - 2026-10-25

### Added
- **Its own version.** The console is versioned separately from Selah, starting at 1.0.0 (Selah was at 6.0.3). The menu shows both: *Console 1.0.0 · Selah 6.0.3*. Docs has a **Console Changelog** tab beside Selah's.
- **Monthly server maintenance reminder.** By default it's the last Tuesday of every month; Settings → Server Maintenance changes it (1st–4th or last week, any weekday). From a week before, a notice across the top of the console says it's coming up (Hide puts it away until the day). From the day itself, a banner says it's due, and later that it's overdue, until it's marked done. Snooze hides it for a day, 3 days or a week. Marking it done any time in the week before counts for that month.
- **Mark done** opens a checklist: the host backup is recent (with when it last ran), install updates (`sudo apt update && sudo apt full-upgrade`, with a copy button and how many updates are waiting), reboot if the server asked for it, every tenant answering again (how many are), and a test restore. There's an optional note too. Each time is kept in a history on the Overview (the last 36), and in the security log.
- **The server's patch status** on the Overview's new Server Maintenance card: the system and kernel, updates waiting (and how many for security, from `apt-check`), whether a reboot is needed and for which packages, when the server started, when apt last ran, and whether automatic security updates are on. It's checked every 30 minutes, or with **Check now**, and again after marking maintenance done.
- **Alerts**: maintenance due today, a week overdue, a reboot needed for more than three days, and security updates waiting more than three days (when automatic updates have probably stopped).
