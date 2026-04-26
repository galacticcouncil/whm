#!/usr/bin/env bash
set -euo pipefail

# Usage: PK=<bs58-secret> with-deployer-keypair.sh <command> [args...]
#
# Writes the BS58-encoded keypair from $PK to a temp JSON file, points
# `solana config` at it for the duration of <command>, then restores the
# previous keypair and deletes the temp file — even on failure.
#
# Same pattern as platforms/solana/migrations/actions/emitter/deploy.ts.
#
# Examples:
#   PK=$DEPLOYER_PK ./sh/with-deployer-keypair.sh \
#     solana-verify remote submit-job \
#       --program-id 8j68bb2BLUSgEW6rdF3LnkxZFGieokLfJMBVd8bjATiz \
#       --uploader 6db8TCH51fK4Pq2LkBdMaMFPfXD17GjfLD8TaMPWNuiq
#
#   PK=$DEPLOYER_PK ./sh/with-deployer-keypair.sh \
#     ./sh/finalize-program.sh 8j68bb2BLUSgEW6rdF3LnkxZFGieokLfJMBVd8bjATiz

PK=${PK:?Missing PK (BS58-encoded secret key)}

if [ $# -eq 0 ]; then
  echo "Usage: PK=<bs58-secret> with-deployer-keypair.sh <command> [args...]"
  exit 1
fi

TMPKP=$(mktemp -t whm-deployer.XXXXXX)
mv "$TMPKP" "$TMPKP.json"
TMPKP="$TMPKP.json"
chmod 600 "$TMPKP"

PREV_KEYPAIR=$(solana config get keypair 2>/dev/null | awk -F': *' '/Keypair Path/ { print $2 }')

cleanup() {
  rm -f "$TMPKP"
  if [ -n "${PREV_KEYPAIR:-}" ]; then
    solana config set --keypair "$PREV_KEYPAIR" >/dev/null
  fi
}
trap cleanup EXIT

# Decode BS58 PK and write JSON array of u8 (64 bytes for ed25519 keypair).
PK="$PK" node -e "
const fs = require('fs');
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const map = {}; for (let i = 0; i < ALPH.length; i++) map[ALPH[i]] = i;
function decode(s) {
  const bytes = [0];
  for (const ch of s) {
    if (!(ch in map)) throw new Error('Invalid base58 char: ' + ch);
    let carry = map[ch];
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>>= 8; }
  }
  for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.push(0);
  return bytes.reverse();
}
const sk = decode(process.env.PK);
if (sk.length !== 64) {
  console.error('Expected 64-byte secret key, got ' + sk.length);
  process.exit(1);
}
fs.writeFileSync(process.argv[1], JSON.stringify(sk));
" "$TMPKP"

solana config set --keypair "$TMPKP" >/dev/null
ACTUAL=$(solana address)
echo "Using keypair: $ACTUAL"
echo ""

"$@"
