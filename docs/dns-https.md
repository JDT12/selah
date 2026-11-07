# DNS and HTTPS

Every Selah gets its own name under your domain, `<name>.<domain>`, plus `admin.<domain>` for the console. The
gateway (Caddy) gets free certificates from Let's Encrypt and renews them itself. There are two ways to prove the
domain is yours; the installer asks which. A server only on your own network (a third choice) uses a private
certificate instead: see [On your own network](#3-on-your-own-network).

## 1. Any DNS provider (recommended)

One DNS record: a wildcard **A** record for `*.<domain>` pointing at the server's IPv4 address. No API token, and
only port 443 needs to be open.

The gateway gets a certificate for each name (the console's and each Selah's) as it's added, proving it over port
443 itself (the TLS-ALPN check). Let's Encrypt allows 50 new certificates a week per domain: plenty for a church or
a class.

For `selah.example.org`:

| Provider | Name | Type | Value |
| --- | --- | --- | --- |
| Most (Namecheap, Porkbun, GoDaddy…) | `*.selah` | A | `203.0.113.10` |
| Cloudflare (DNS only, grey cloud) | `*.selah` | A | `203.0.113.10` |

If the whole domain is just for Selah, the name is `*`.

## 2. Cloudflare wildcard

If the domain's DNS is on Cloudflare, the gateway can instead get one wildcard certificate (`*.<domain>`) through
Cloudflare's API, so names never appear one by one in public certificate logs. It needs an API token: Cloudflare →
My Profile → API Tokens → Create Token → **Edit zone DNS**, for that zone only. The installer asks for it;
`npm run admin -- dns-token` changes it later. Keep the record **DNS only** (grey cloud): Cloudflare's proxy would end
HTTPS at Cloudflare.

## 3. On your own network

Let's Encrypt has to reach the server from the internet, so it can't certify a home server or a test VM on a private
address (192.168.x.x, 10.x.x.x). For those, choose **3** in the installer. It makes a private certificate authority
on the server (`~/selah/data/certs/ca.crt`) and a wildcard certificate for `*.<domain>` signed by it, valid for
825 days. Any domain works, including one you don't own, such as `selah.lan` (avoid `.local`, which some devices
keep for other uses).

On each device, once:

1. **Trust the certificate authority.** Copy `ca.crt` from the server (`scp selah@<server>:selah/data/certs/ca.crt .`)
   and install it as a trusted root:
   - Windows: double-click it → **Install Certificate** → **Local Machine** → **Place all certificates in the
     following store** → **Trusted Root Certification Authorities**. Selah Desktop and browsers then trust it
     (Firefox: Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import).
   - Mac: open it in Keychain Access, add it to **System**, and set it to **Always Trust**.
   - iPhone: AirDrop or email it, install the profile, then Settings → General → About → Certificate Trust
     Settings → turn it on. Android: Settings → Security → Encryption & credentials → Install a certificate → CA
     certificate.
2. **Point the names at the server.** Best: a wildcard record for `*.<domain>` to the server's address in your
   router or Pi-hole, if it has local DNS. Otherwise add a line per name to the hosts file (Windows:
   `C:\Windows\System32\drivers\etc\hosts`, edited as administrator; Mac and Linux: `/etc/hosts`):

   ```
   192.168.1.50  admin.selah.lan
   192.168.1.50  jason.selah.lan
   ```

   A hosts file can't hold a wildcard, so each new Selah needs its own line. Phones can't edit theirs: use the
   router or Pi-hole for them.

The console answers from any address on your network unless you gave the installer one address. Keep the
certificate authority's key (`data/certs/ca.key`) on the server only: anyone with it could make certificates your
devices trust. Before the wildcard certificate runs out, renew it with
`npm run admin -- init --domain <domain> --tls files --new-cert` and `systemctl --user restart selah-gateway`
(the authority itself lasts ten years, so devices keep trusting it).

An existing server can switch to this the same way: `npm run gen-certs`, then that `init` command.

## Checking

```bash
getent hosts admin.<domain>
cd ~/selah && npm run admin -- cert
journalctl --user -u selah-gateway --since -1h
```

The first shows the address the name points at, the second the certificate the gateway serves, the third what Caddy
did (and why a certificate failed). Common reasons one doesn't arrive: the record points elsewhere (or not yet: DNS
can take an hour), port 443 is closed in the provider's cloud firewall as well as `ufw`, or Cloudflare's proxy
(orange cloud) is on.

To try the setup without Let's Encrypt's limits, install with `SELAH_ACME_STAGING=1 bash install.sh`: you get test
certificates browsers warn about. For real ones afterwards, run `npm run admin -- init --domain <domain> --tls
acme-host` (no `--acme-staging`), then `systemctl --user restart selah-gateway`.
