# Install Selah Cloud on your own server

Selah Cloud runs a separate Selah for each person (each in its own container), an admin console to create, pause,
back up and update them, and an HTTPS gateway in front. It's the same setup as the original Selah Cloud server.

## What you need

- **A Linux server**: Ubuntu 24.04 or newer, x86-64 or ARM, with a public IPv4 address (or on your own network
  only: a home server or a test VM, see [On your own network](dns-https.md#3-on-your-own-network)). 2 GB of memory is enough for
  a handful of people; allow about 300 MB more per active person, and disk for their notes and attachments.
  Any VPS provider works (Hetzner, OVH, DigitalOcean, Linode…).
- **A domain** you control, such as `example.org`. Selah uses a part of it: each Selah is `<name>.<domain>` and the
  console is `admin.<domain>`. A subdomain works well: `selah.example.org` gives `jason.selah.example.org`.
- **SSH access** as a user with `sudo` (not root).
- **Port 443** reachable from the internet (and 22 for SSH). Selah doesn't use port 80.

## 1. Point your domain at the server

At your DNS provider, add one wildcard record (see [DNS and HTTPS](dns-https.md)):

| Type | Name | Value |
| --- | --- | --- |
| A | `*.selah` (for `*.selah.example.org`) | the server's IPv4 address |

## 2. Prepare the server (once)

Sign in as root once, make an ordinary user and turn on the firewall:

```bash
adduser selah
usermod -aG sudo selah
ufw allow OpenSSH
ufw allow 443/tcp
ufw enable
```

Then sign in as that user (`ssh selah@<server>`). Using an SSH key and turning off password sign-in for SSH is
strongly recommended.

## 3. Run the installer

```bash
curl -fsSL https://raw.githubusercontent.com/JDT12/selah/main/scripts/install.sh -o install.sh
bash install.sh
```

It asks:

| Question | What to give |
| --- | --- |
| Domain | The part after each name, e.g. `selah.example.org` |
| HTTPS certificates | **1** (any DNS provider) unless your domain is on Cloudflare and you want one wildcard certificate; **3** for a server only on your own network (a private certificate you trust on each device) |
| Email for Let's Encrypt | Where certificate expiry warnings go (rare; the gateway renews by itself). Not asked for **3** |
| Your address | The public address you'll open the admin console from. It suggests the one you're connected from; blank means only through an SSH tunnel |
| Admin password | 12 characters or more; you add two-step sign-in when you first sign in |
| First Selah | A short name (`jason`), or blank to make them later in the console |

Then it checks the DNS, installs Docker, Node.js and Caddy, sets up the admin console and gateway as services that
start at boot, and builds the first release (about ten minutes in all). The app lives in `~/selah`; all data is in
`~/selah/notes-data/cloud`.

## 4. Sign in and make Selahs

Open `https://admin.<domain>`, sign in, and set up two-step sign-in (an authenticator app); the console requires it.
Under **Tenants**, **New tenant** makes a Selah and gives a one-time setup link: send it to the person, who opens it,
chooses a password and turns on two-step sign-in. Their Selah is at `https://<name>.<domain>`.

With per-name certificates (option 1), a new name gets its certificate within a minute of being made.

## The console from somewhere else

The console answers only from the addresses you list. When your home address changes, from the server:

```bash
cd ~/selah && npm run admin -- allow-ip add <new address>
```

## Useful commands

From `~/selah`:

| Command | What it does |
| --- | --- |
| `npm run admin -- status` | Services, certificate, every Selah and its version |
| `npm run admin -- tenants` | Lists the Selahs |
| `npm run admin -- create <name>` | A new Selah and its setup link |
| `npm run admin -- setup-link <name>` | A fresh setup link (forgotten password) |
| `npm run admin -- reset-two-step` | Resets the console's two-step sign-in, when you've lost the phone |
| `npm run admin -- maintenance-stop` / `maintenance-start` | Stops and starts everything around server maintenance |
| `bash scripts/update.sh` | [Updates](updates.md) to the newest release |

Next: [Backups](backups.md), [Updates](updates.md), [Troubleshooting](troubleshooting.md).
