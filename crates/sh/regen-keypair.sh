#!/usr/bin/env bash
#
# Regenerate the program deploy keypair and update all references.
# Replaces the keypair in target/deploy/, then patches declare_id! in lib.rs
# and the program ID in Anchor.toml to match the new address.
#
# Usage: ./sh/regen-keypair.sh
set -euo pipefail

PROGRAM_NAME="message_emitter"
KEYPAIR_PATH="target/deploy/${PROGRAM_NAME}-keypair.json"
LIB_RS="programs/message-emitter/src/lib.rs"
ANCHOR_TOML="Anchor.toml"

# cd to repo root (where Anchor.toml lives)
cd "$(dirname "$0")/.."

echo "Removing old keypair: $KEYPAIR_PATH"
rm -f "$KEYPAIR_PATH"

echo "Generating new keypair..."
solana-keygen new --no-bip39-passphrase -o "$KEYPAIR_PATH"

NEW_ID=$(solana-keygen pubkey "$KEYPAIR_PATH")
echo "New program ID: $NEW_ID"

# Update declare_id! in lib.rs
sed -i '' "s/declare_id!(\"[^\"]*\")/declare_id!(\"${NEW_ID}\")/" "$LIB_RS"
echo "Updated $LIB_RS"

# Update program ID in Anchor.toml [programs.localnet]
sed -i '' "s/^message-emitter = \"[^\"]*\"/message-emitter = \"${NEW_ID}\"/" "$ANCHOR_TOML"
echo "Updated $ANCHOR_TOML"

echo "Done. Run 'anchor build -p $PROGRAM_NAME' to rebuild."
