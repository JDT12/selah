# Install Selah Cloud on your own server

Selah Cloud is one Selah, for you or your family, on a server you run, at one address such as `selah.example.org`.
Use it from any browser, Selah Desktop and the Selah apps for iPhone, iPad and Android. For a church or ministry,
with a Selah for each person and an admin console, see [Selah Ministry](ministry-install.md) instead.

It runs as three small containers: Selah itself, Caddy for HTTPS, and an updater that Settings → Updates uses. Selah
comes as a ready-made image (`ghcr.io/jdt12/selah`), so nothing is built on your server.

## What you need

- **A Linux server**: Ubuntu 24.04 or newer, x86-64 or ARM. 1 GB of memory is enough; disk for your notes and
  attachments. Any VPS provider works (Hetzner, OVH, DigitalOcean, Linode…), or a computer at home.
- **An address** you control, such as `selah.example.org`, pointed at the server.
- **SSH access** as a user with `sudo` (not root).
- **Ports 80 and 443** reachable from the internet, for HTTPS (and 22 for SSH). On your own network only, the
  devices you use just need to reach the server.

## 1. Point the address at the server

At your DNS provider, add one record:

| Type | Name | Value |
| --- | --- | --- |
| A | `selah` (for `selah.example.org`) | the server's IPv4 address |

On your own network only, your router or Pi-hole can give the name instead (or each device's hosts file).

## 2. Prepare the server (once)

Sign in as root once, make an ordinary user and turn on the firewall:

```bash
adduser selah
usermod -aG sudo selah
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443
ufw enable
```

Then sign in as that user (`ssh selah@<server>`). Using an SSH key and turning off password sign-in for SSH is
strongly recommended.

## 3. Run the installer

```bash
curl -fsSL https://raw.githubusercontent.com/JDT12/selah/main/scripts/install.sh -o install.sh
bash install.sh
```

Choose **1, Selah Cloud**. It asks:

| Question | What to give |
| --- | --- |
| Address | The name from step 1, e.g. `selah.example.org` |
| HTTPS certificate | **1** Let's Encrypt (free, trusted everywhere; needs ports 80 and 443 open to the internet), or **2** for a server only on your own network (a private certificate you trust once on each device) |
| Email for Let's Encrypt | Where certificate expiry warnings go (rare; Caddy renews by itself) |
| Time zone | For your calendar and reminders |

It installs Docker, downloads the newest Selah and starts it, all in about two minutes. Last, it prints a
**setup link**: open it, choose your username, email and password, and set up two-step sign-in (an authenticator
app; recommended, and you can do it later in Settings → Security). The link works once, for 30 days.

Everything lives in `~/selah-cloud`: your library in `data/`, the settings in `.env`.

## 4. Phones, tablets and Selah Desktop

- **The Selah apps** for iPhone, iPad and Android: in the web app, **Settings → General → App → Connect a phone or
  tablet** shows a code; scan it with the phone's camera. Or type the address in the app.
- **Selah Desktop**: choose **Sign in to your Selah server** and type the address.
- **Any browser**: open the address; Chrome and Edge can install it as an app, and Safari can add it to the home
  screen.

Reminders are scheduled on each phone itself; Selah Cloud doesn't send push notifications.

## 5. Updates

**Settings → About → Updates** shows when a new version is out; **Update** does it in a minute or two. Selah saves a
copy of its database first, and if the new version doesn't start, the updater puts the old one back with your
library as it was. From the server, `selah update` does the same. See [Updates](updates.md).

## 6. Backups (do this first)

**Settings → Data & backup → Off-site backup** copies your library every night to OneDrive, S3 or WebDAV,
encrypted. Set it up on day one: a copy only on the server doesn't survive losing it. See [Backups](backups.md).

## The selah command

On the server:

| Command | What it does |
| --- | --- |
| `selah status` | What's running, the version and the last update |
| `selah setup-link` | A new setup link: when the first one is lost, or for a forgotten password or lost phone |
| `selah update [version]` | Updates to the newest release (or that version) |
| `selah backup` | The whole library as a backup file, in `~/selah-cloud/backups` |
| `selah logs` | Selah's log |
| `selah start` / `stop` / `restart` | Starts or stops Selah |

## Moving a library

A backup file from Selah Desktop, another Selah Cloud or a Selah Ministry opens here: **Settings → Data & backup →
Restore from a backup → From a file**. It replaces the library; the one you had is kept aside. The other way, download
a backup here (**Download a backup**) and open it there.

Next: [Backups](backups.md), [Updates](updates.md), [Troubleshooting](troubleshooting.md).
