# Backups and restoring

## Selah Cloud

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

## Selah Desktop

- **Automatic backups** to a folder you choose (Settings → Data & backup): daily or weekly, the newest ten kept,
  optionally encrypted.
- **Go back to a backup** replaces the whole library; the one you had is kept aside.
- **Restore notes** brings notes back as copies: from the daily restore points, an automatic backup or a sync
  conflict copy.
- **Import a library** opens any backup file, including one downloaded from Selah Cloud.

## Keep these off the server

For Selah Cloud, keep in a password manager: the admin password and two-step recovery codes, the off-server
backup's passphrase, and the login for your DNS provider.
