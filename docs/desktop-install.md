# Install Selah Desktop

Selah Desktop runs on Windows, Mac (Apple Silicon and Intel, macOS 12 or later) and Linux (64-bit Intel/AMD).
Download it from the [releases page](https://github.com/JDT12/selah/releases/latest).

## Windows

1. Download **Selah-Setup-<version>.exe**.
2. Run it. It installs for your Windows account only (no administrator needed) and opens Selah.
   Windows may say it "protected your PC" while the installer isn't signed yet: choose **More info → Run anyway**.

## Mac

1. Download the **.dmg** for your Mac: **Selah-<version>-mac-arm64.dmg** for Apple Silicon (M1 and later),
   **Selah-<version>-mac-x64.dmg** for an Intel Mac. ( → About This Mac shows which: "Chip Apple M…" or
   "Processor … Intel".)
2. Open it and drag **Selah** to **Applications**, then open Selah from Applications.
3. The first time, macOS asks whether to open an app downloaded from the internet: choose **Open**. Selah is signed
   and notarized by Apple, and updates itself after that. (Builds before 12.1.0-beta.4 weren't signed: if macOS says
   one "can't be opened" or "is damaged", use **System Settings → Privacy & Security → Open Anyway**, or run this in
   Terminal, then open Selah again:)

   ```bash
   xattr -cr /Applications/Selah.app
   ```

## Linux

Two downloads; pick one:

- **AppImage** (any distribution): download **Selah-<version>-x86_64.AppImage**, make it executable and run it:

  ```bash
  chmod +x Selah-*.AppImage
  ./Selah-*.AppImage
  ```

  It updates itself in place. Ubuntu 22.04 and later need `libfuse2` for AppImages (`sudo apt install libfuse2`,
  or `libfuse2t64` on 24.04). On Ubuntu 24.04, if it closes at once, start it with `--no-sandbox` or use the .deb.
- **.deb** (Ubuntu, Debian, Mint, Pop!_OS): download **selah_<version>_amd64.deb** and install it:

  ```bash
  sudo apt install ./selah_*_amd64.deb
  ```

  Selah is then in your applications menu. Updates download by themselves and ask for your password to install.

GNOME hides tray icons unless the **AppIndicator** extension is on (Ubuntu has it on already).

## First start

Choose where your library lives:

- **On this computer**: works offline, with no account. Your notes stay in the Selah folder (see
  [Where things are](#where-things-are)).
- **On a Selah Cloud server**: type the address of your Selah (for example `https://you.example.org`) and sign
  in as you would in a browser.

## Set up automatic backups (do this first)

Settings → **Data & backup** → **Automatic backups** → **Use this folder**. Selah suggests a folder in your
OneDrive, iCloud Drive, Dropbox or Google Drive, so a copy of your library leaves the computer. It backs up once a
day (or once a week) and keeps the newest ten. Add a passphrase if the folder is in the cloud; without the
passphrase a backup can't be restored, so keep it in a password manager.

## Everyday things

- **Closing the window** keeps Selah running, so reminders arrive: in the tray by the clock on Windows and Linux,
  in the menu bar at the top of the screen on a Mac (click Selah in the Dock to bring the window back). Quit from
  that menu, or Cmd+Q on a Mac.
- **Quick capture**: Ctrl+Alt+N from anywhere (Cmd+Option+N on a Mac).
- **Start at sign-in**: Settings → General → App, or the tray / menu-bar menu (Start with Windows, or Open at login).
- **Slides on a projector or TV**: with a second screen connected, Present opens the slides full screen on it and
  keeps the controls on your laptop.
- **Lock**: Settings → General → App → **Set up a lock**: a PIN, asked when Selah opens and after a while away.
  Windows Hello (Windows) or Touch ID (Mac) can unlock it too, where the computer has them.
- **Notifications** on a Mac: allow them when macOS asks, or later in System Settings → Notifications → Selah.

## Another computer

Selah Desktop keeps one library on one computer. To move it to another (any of Windows, Mac or Linux), Settings →
Data & backup → **Download a backup**, then **Import a library** on the new one. To work on notes, lessons, sermons
or slides somewhere else, export them (Word, PDF, PowerPoint or a Selah file), or use Selah Cloud, which works from
any computer or phone.

## Moving to Selah Cloud (or back)

- Desktop → Cloud: Settings → Data & backup → **Download a backup**, then restore that file on the server
  (`npm run admin -- restore-file <name> <file>`, or ask whoever runs it).
- Cloud → Desktop: Download a backup in your Cloud Selah, then in Desktop Settings → Data & backup →
  **Import a library**.

## Where things are

| | Windows | Mac | Linux |
| --- | --- | --- | --- |
| The Selah folder | `%LOCALAPPDATA%\Selah` | `~/Library/Application Support/Selah` | `~/.local/share/Selah` |

Inside it:

| | |
| --- | --- |
| Library (notes, attachments, daily restore points) | `storage` |
| App settings, logs | `app`, `logs` |
| Library before the last restore | `storage-before-restore` |

Uninstalling Selah leaves the library where it is.
