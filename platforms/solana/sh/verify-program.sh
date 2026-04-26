#!/usr/bin/env bash
set -euo pipefail

# Usage: verify-program.sh <program_id>
#
# Verifies the deployed message-emitter bytecode matches a deterministic
# build of this repo, and (optionally) registers that verification on-chain
# via solana-verify so explorers (OtterSec, Solscan, etc.) display the
# verified badge.
#
# IMPORTANT: on-chain registration (final step) requires the program's
# upgrade authority to sign. After `finalize-program.sh` runs, that authority
# is None forever and registration becomes permanently impossible.
# Run this script BEFORE finalizing.
#
# Requirements:
#   - solana-verify  https://github.com/Ellipsis-Labs/solana-verifiable-build
#   - docker (running)
#   - solana CLI configured with cluster + upgrade-authority keypair
#
# Example:
#   ./sh/verify-program.sh 8j68bb2BLUSgEW6rdF3LnkxZFGieokLfJMBVd8bjATiz

PROGRAM_ID=${1:?Usage: verify-program.sh <program_id>}

if ! command -v solana-verify >/dev/null 2>&1; then
  echo "ERROR: solana-verify not found in PATH."
  echo "  Install with: cargo install solana-verify"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: docker daemon not running (or docker CLI not installed)."
  echo "  solana-verify uses Docker for the deterministic build."
  exit 1
fi

REPO_URL="https://github.com/galacticcouncil/whm"
LIBRARY_NAME="message_emitter"
MOUNT_PATH="platforms/solana"

# Override the Docker image used by solana-verify when its default ships with
# a too-old rustc for this dependency tree. Examples:
#   BASE_IMAGE=solanafoundation/solana-verifiable-build:2.1.0
#   BASE_IMAGE=solanafoundation/solana-verifiable-build:latest
BASE_IMAGE="${BASE_IMAGE:-}"
BASE_IMAGE_FLAG=()
if [ -n "$BASE_IMAGE" ]; then
  BASE_IMAGE_FLAG=(--base-image "$BASE_IMAGE")
fi

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SOLANA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMMIT_HASH=$(git -C "$REPO_ROOT" rev-parse HEAD)

# Refuse to run on a dirty tree — registered metadata points to a commit hash;
# uncommitted changes mean the registration won't reflect what's actually built.
if ! git -C "$REPO_ROOT" diff-index --quiet HEAD --; then
  echo "ERROR: working tree has uncommitted changes."
  echo "  Commit or stash before verifying so the registered commit hash is meaningful."
  exit 1
fi

echo "─── Verifying deployed bytecode ──────────────"
echo "  Program ID : $PROGRAM_ID"
echo "  Repo       : $REPO_URL"
echo "  Mount path : $MOUNT_PATH"
echo "  Library    : $LIBRARY_NAME"
echo "  Commit     : $COMMIT_HASH"
echo "  Base image : ${BASE_IMAGE:-(solana-verify default)}"
echo ""

# 1. On-chain hash (read-only RPC, works any time)
echo "─── 1. On-chain program hash ──────────────────"
ONCHAIN_HASH=$(solana-verify get-program-hash "$PROGRAM_ID")
echo "  $ONCHAIN_HASH"
echo ""

# 2. Deterministic local build
echo "─── 2. Building deterministically (Docker) ───"
( cd "$SOLANA_DIR" && solana-verify build \
    --library-name "$LIBRARY_NAME" \
    "${BASE_IMAGE_FLAG[@]}" )
echo ""

LOCAL_HASH=$(solana-verify get-executable-hash \
  "$SOLANA_DIR/target/deploy/${LIBRARY_NAME}.so")
echo "  Local hash : $LOCAL_HASH"
echo ""

# 3. Compare
if [ "$LOCAL_HASH" != "$ONCHAIN_HASH" ]; then
  echo "❌ HASH MISMATCH"
  echo "  Deployed bytecode does not match a deterministic build of this repo at $COMMIT_HASH."
  echo "  Either the deployed program was built from a different commit, or"
  echo "  the build environment differs (toolchain version, feature flags)."
  exit 1
fi

echo "✓ Hashes match. Deployed bytecode is provably built from commit $COMMIT_HASH."
echo ""

# 4. On-chain registration (requires upgrade authority signature)
echo "─── 4. Register verification on-chain ────────"
echo "  This signs with the wallet from \`solana config get\` — must match the upgrade authority."
echo "  Skip if already registered for this commit, or if --final has been called."
echo ""
read -r -p "Register on-chain now? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Skipped on-chain registration. Local verification stands."
  exit 0
fi

cd "$REPO_ROOT"
solana-verify verify-from-repo \
  --remote \
  --program-id "$PROGRAM_ID" \
  --commit-hash "$COMMIT_HASH" \
  --library-name "$LIBRARY_NAME" \
  --mount-path "$MOUNT_PATH" \
  "${BASE_IMAGE_FLAG[@]}" \
  "$REPO_URL"

echo ""
echo "Done."
