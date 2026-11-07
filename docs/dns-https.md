# DNS and HTTPS

Every Selah gets its own name under your domain, `<name>.<domain>`, plus `admin.<domain>` for the console. The
gateway (Caddy) gets free certificates from Let's Encrypt and renews them itself. There are two ways to prove the
domain is yours; the installer asks which.

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
