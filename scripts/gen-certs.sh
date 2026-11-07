#!/usr/bin/env bash
# Creates a private Certificate Authority (once) and a server certificate signed by it.
# Install data/certs/ca.crt as a trusted root on your devices to get a clean padlock.
#
# Usage: npm run gen-certs                     (same hosts as last time, else this machine's IPs + hostname)
#        CERT_HOSTS="10.0.0.5 notes.lan" npm run gen-certs
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${NOTEAPP_DATA_DIR:-data}/certs"
mkdir -p "$DIR"
cd "$DIR"

# Names/IPs the certificate covers. CERT_HOSTS overrides; otherwise reuse the list from the
# last run (hosts.txt), so a re-issue never silently drops a name like notes.example.lan.
if [[ -n "${CERT_HOSTS:-}" ]]; then
  HOSTS="$CERT_HOSTS"
elif [[ -f hosts.txt ]]; then
  HOSTS="$(cat hosts.txt)"
else
  HOSTS="$(hostname -I) $(hostname) localhost 127.0.0.1"
fi
echo "$HOSTS" > hosts.txt

if [[ ! -f ca.key ]]; then
  echo "Creating local CA..."
  openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
    -keyout ca.key -out ca.crt -subj "/CN=Note App Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi

SAN=""
for h in $HOSTS; do
  if [[ $h =~ ^[0-9.]+$ || $h == *:* ]]; then entry="IP:$h"; else entry="DNS:$h"; fi
  [[ ",$SAN," == *",$entry,"* ]] || SAN="${SAN:+$SAN,}$entry"
done

openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=Note App" 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 -sha256 -extfile <(printf '%s\n' \
    "subjectAltName=$SAN" \
    "basicConstraints=CA:FALSE" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth") 2>/dev/null
rm -f server.csr
chmod 600 ./*.key

echo "Server certificate valid for: $SAN"
echo "Trust this CA on your devices: $(pwd)/ca.crt"
