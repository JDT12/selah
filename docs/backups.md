# Backups and restoring

## Selah Cloud

- **Every night, off the server**: Settings → Data & backup → **Off-site backup** copies your library to OneDrive, S3
  or WebDAV, encrypted. Set it up on day one: a copy only on the server doesn't survive losing it.
- **Restore points**: Selah keeps your notes as they were on each of the last 14 days. Settings → Data & backup →
  **Restore from a backup** brings notes back as copies.
- **Your own copy**: Settings → Data & backup → **Download a backup** (encrypted with a passphrase), or on the server
  `selah backup` (into `~/selah-cloud/backups`).
- **Replacing the whole library** from a backup file (from Selah Desktop, another Selah Cloud or Selah Ministry):
  Settings → Data & backup → **Replace the library → From a backup file**. The library you had is kept aside on the
  server in `~/selah-cloud/data/storage-before-restore`, and your sign-in stays the same.

## Selah Ministry

- **Every night** the admin console backs up every Selah (its notes database, attachments and keys) to the
  destinations chosen in the console (Backups): a folder on the server, and off the server through OneDrive, S3 or
  WebDAV, encrypted. Set up an off-server one on day one: a copy only on the server doesn't survive losing it.
- **Restore points**: each Selah also keeps its notes as they were on each of the last 14 days. People bring notes
  back themselves in Settings → Data & backup → **Restore from a backup**; they come back as copies.
- **Their own copy**: anyone can download a backup file of their whole Selah (Settings → Data & backup →
  **Download a backup**), encrypted with a passphrase.
- **Restoring a whole Selah** from a backup file, in the console (Tenants → the Selah → Restore…) or:

  ```bash
  npm run admin -- restore-file <name> <file>
  ```

  Its current data is moved aside, not deleted.
- **The share hub** (what people share with each other) is in the same nightly backup: its database, kept like the
  console's, and its attachments. To restore it, stop the hub (`docker rm -f selah-tenant-hub`), put `hub.db` and
  `files/` back in `notes-data/cloud/hub`, and the console starts it again within a minute.

## Selah Desktop

- **Automatic backups** to a folder you choose (Settings → Data & backup): daily or weekly, the newest ten kept,
  optionally encrypted.
- **Go back to a backup** replaces the whole library; the one you had is kept aside.
- **Restore notes** brings notes back as copies: from the daily restore points or an automatic backup.
- **Import a library** opens any backup file, including one downloaded from Selah Cloud or Selah Ministry.

## Keep these off the server

For Selah Cloud and Selah Ministry, keep in a password manager: your password and two-step recovery codes (and the
admin console's, on Ministry), the off-server backup's passphrase, and the login for your DNS provider.
