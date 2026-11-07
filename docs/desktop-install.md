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

## Another PC

Selah Desktop keeps one library on one PC. To move it to another PC, Settings → Data & backup → **Download a
backup**, then **Import a library** on the new PC. To work on notes, lessons, sermons or slides somewhere else, export
them (Word, PDF, PowerPoint or a Selah file), or use Selah Cloud, which works from any computer or phone.

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
| Library before the last restore | `%LOCALAPPDATA%\Selah\storage-before-restore` |

Uninstalling Selah leaves the library where it is.
