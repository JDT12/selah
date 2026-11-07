# Updates

## Selah Desktop

It looks for a new version when it starts and every six hours, downloads it, and asks to restart. Tray menu →
**Check for updates** looks now.

## Selah Cloud

From `~/selah`:

```bash
bash scripts/update.sh
```

It fetches the newest release, builds it, restarts the admin console on it, builds the release's image and moves the
Selahs to it **one at a time**. Before each move it saves a copy of that Selah's notes. A Selah that doesn't come
back healthy on the new version is put back on the old one, with its notes as they were, and the update stops there.

- A particular version: `bash scripts/update.sh v12.1.0`.
- **Try a beta first**: `bash scripts/update.sh --beta`, then move one Selah to it
  (`npm run admin -- update <name> --beta`) and use it for a while. When it's good, `npm run admin -- promote` and
  `npm run admin -- update` move everyone.
- **Roll back**: `npm run admin -- rollback <name>` (or Updates in the console) puts a Selah back on the release it
  had before.
- The console's **Updates** page does the same with checkboxes, and keeps the last few releases for rolling back.

People see a short "Selah was updated" banner and What's New; nothing else changes for them.

Update the server itself (Ubuntu) now and then too: see [server maintenance](troubleshooting.md#server-maintenance).
