#!/usr/bin/env bash
set -euo pipefail

# Usage: finalize-program.sh <program_id>
#
# IRREVERSIBLY revokes the upgrade authority of a Solana program, making its
# bytecode immutable forever. After this runs there is no path back —
# the program can never be upgraded, paused, or closed.
#
# The signing wallet (from `solana config get`) must be the current upgrade
# authority. Override the cluster/keypair beforehand if needed:
#   solana config set --url <RPC>
#   solana config set --keypair <PATH>
#
# Example:
#   ./sh/finalize-program.sh 8j68bb2BLUSgEW6rdF3LnkxZFGieokLfJMBVd8bjATiz

PROGRAM_ID=${1:?Usage: finalize-program.sh <program_id>}

CONFIRM_PHRASE="FINALIZE"

echo "─── Solana config ───────────────────────────────"
solana config get
echo ""

echo "─── Current program state ───────────────────────"
solana program show "$PROGRAM_ID"
echo ""

CURRENT_AUTHORITY=$(solana program show "$PROGRAM_ID" | awk -F': *' '/Authority/ { print $2; exit }')
SIGNER=$(solana address)

if [ -z "$CURRENT_AUTHORITY" ] || [ "$CURRENT_AUTHORITY" = "none" ]; then
  echo "Program already has no upgrade authority (already final). Nothing to do."
  exit 0
fi

if [ "$CURRENT_AUTHORITY" != "$SIGNER" ]; then
  echo "ERROR: signer mismatch."
  echo "  Current upgrade authority : $CURRENT_AUTHORITY"
  echo "  Configured signing wallet : $SIGNER"
  echo ""
  echo "Switch to the upgrade-authority keypair (solana config set --keypair <PATH>) and rerun."
  exit 1
fi

echo "─── About to FINALIZE program ────────────────────"
echo "  Program ID       : $PROGRAM_ID"
echo "  Upgrade authority: $CURRENT_AUTHORITY"
echo "  Signer           : $SIGNER"
echo ""
echo "This is IRREVERSIBLE. The program bytecode becomes permanent;"
echo "no upgrades, no closes, ever. The program rent is locked forever."
echo ""
read -r -p "Type '$CONFIRM_PHRASE' to proceed: " input

if [ "$input" != "$CONFIRM_PHRASE" ]; then
  echo "Aborted."
  exit 1
fi

echo ""
echo "─── Submitting set-upgrade-authority --final ────"
solana program set-upgrade-authority "$PROGRAM_ID" --final
echo ""

echo "─── Post-finalize state ─────────────────────────"
solana program show "$PROGRAM_ID"
echo ""
echo "Done. Program is now immutable."
