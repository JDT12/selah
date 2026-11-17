# Updates

## Selah Desktop

It looks for a new version when it starts and every six hours, downloads it, and asks to restart. Tray menu →
**Check for updates** looks now.

## Selah Cloud

**Settings → About → Updates** shows when a new version is out; **Update** does it in a minute or two. Selah saves a
copy of its database, the updater downloads the new version and restarts Selah on it, and if it doesn't start, puts
the old version back with the database as it was. On the server, the same:

```bash
selah update
```

`selah update 14.1.0` goes to a particular version (including back to an older one). `selah status` shows the last
update.

## Selah Ministry

From `~/selah`:

```bash
bash scripts/update.sh
```

It fetches the newest release, builds the admin console, restarts it, downloads the release's image and moves the
Selahs to it **one at a time**. Before each move it saves a copy of that Selah's notes. A Selah that doesn't come
back healthy on the new version is put back on the old one, with its notes as they were, and the update stops there.

- A particular version: `bash scripts/update.sh v12.1.0`.
- **Try a beta first**: `bash scripts/update.sh --beta`, then move one Selah to it
  (`npm run admin -- update <name> --beta`) and use it for a while. When it's good, `npm run admin -- promote` and
  `npm run admin -- update` move everyone.
- **Roll back**: `npm run admin -- rollback <name>` (or Updates in the console) puts a Selah back on the release it
  had before.
- The console's **Updates** page does the same with checkboxes, and keeps the last few releases for rolling back.
  **Published Versions → Get** downloads a new version there.

People see a short "Selah was updated" banner and What's New; nothing else changes for them.

Update the server itself (Ubuntu) now and then too: see [server maintenance](troubleshooting.md#server-maintenance).
