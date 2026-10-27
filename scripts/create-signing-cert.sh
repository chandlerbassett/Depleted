#!/bin/bash
# One-time setup: creates a self-signed code-signing certificate, "Depleted Local Signing",
# in your login keychain. Local builds sign with it (see build/signingIdentity.js), so
# macOS keeps the Screen Recording permission across rebuilds instead of asking again.
# The certificate only lives on this Mac; it doesn't make builds trusted anywhere else.
set -euo pipefail

name="Depleted Local Signing"
keychain="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning | grep -q "\"$name\""; then
  echo "\"$name\" is already in your keychain"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $name
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -config "$tmp/cert.cnf"
# The .p12 only exists inside $tmp, so its password doesn't need to be secret
openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
  -name "$name" -out "$tmp/cert.p12" -passout pass:depleted
security import "$tmp/cert.p12" -k "$keychain" -P depleted -T /usr/bin/codesign

echo "Created \"$name\". Rebuild Depleted, grant Screen Recording once more, and it will stick from then on."
