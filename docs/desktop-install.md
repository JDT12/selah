# Install Selah Desktop

1. Download **Selah-Setup-<version>.exe** from the [releases page](https://github.com/JDT12/selah/releases/latest).
2. Run it. It installs for your Windows account only (no administrator needed) and opens Selah.
   Windows may say it "protected your PC" while the installer isn't signed yet: choose **More info → Run anyway**.
3. Choose where your library lives:
   - **On this PC**: works offline, with no account. Your notes stay in `%LOCALAPPDATA%\Selah`.
   - **On a Selah Cloud server**: type the address of your Selah (for example `https://you.example.org`) and sign
     in as you would in a browser.

## Set up automatic backups (do this first)

Settings → **Data & backup** → **Automatic backups** → **Use this folder**. Selah suggests a folder in your
OneDrive, iCloud Drive or Dropbox, so a copy of your library leaves the PC. It backs up once a day (or once a
week) and keeps the newest ten. Add a passphrase if the folder is in the cloud; without the passphrase a backup
can't be restored, so keep it in a password manager.

## Everyday things

- **Closing the window** keeps Selah running in the tray by the clock, so reminders arrive. Quit from the tray menu.
- **Quick capture**: Ctrl+Alt+N from anywhere in Windows.
- **Start with Windows**: Settings → General → App, or the tray menu.
- **Slides on a projector or TV**: with a second screen connected, Present opens the slides full screen on it and
  keeps the controls on your laptop.
- **Lock**: Settings → General → App → **Set up a lock**: a PIN (and Windows Hello, where the PC has it), asked when
  Selah opens and after a while away.

## Two PCs (a desktop and a laptop)

Settings → Data & backup → **Use on two PCs** → choose a folder that OneDrive, iCloud Drive or Dropbox syncs (or a
USB stick). Do the same on the second PC and choose **The one in the folder**.

- One PC edits at a time. The other opens your library **read-only** and says which PC has it.
- **Take over** asks the other PC to save and hand over (a minute or two while the sync app catches up), then
  **Edit here**. If the other PC is off or asleep, **Take over anyway**: anything it hadn't saved to the folder is
  kept in the folder's `conflicts` folder, and Settings → Data & backup → Restore notes can bring notes back from it.
- Selah never keeps its live database in the sync folder. It works on its own copy and saves to the folder every
  few minutes and when it closes, so let it close normally before switching PCs.
- For two people using Selah at the same time, use Selah Cloud.

## Moving to Selah Cloud (or back)

- Desktop → Cloud: Settings → Data & backup → **Download a backup**, then restore that file on the server
  (`npm run admin -- restore-file <name> <file>`, or ask whoever runs it).
- Cloud → Desktop: Download a backup in your Cloud Selah, then in Desktop Settings → Data & backup →
  **Import a library**.

## Where things are

| | |
| --- | --- |
| Library (notes, attachments, daily restore points) | `%LOCALAPPDATA%\Selah\storage` |
| App settings, logs | `%LOCALAPPDATA%\Selah\app`, `%LOCALAPPDATA%\Selah\logs` |
| Library before the last restore or sync | `%LOCALAPPDATA%\Selah\storage-before-restore`, `storage-before-sync` |

Uninstalling Selah leaves the library where it is.
