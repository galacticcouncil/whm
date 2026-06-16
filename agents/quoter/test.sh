#!/usr/bin/env bash
# Example: query the quoter /relay-fee endpoint.
# Start the service first (`pnpm dev` or `pnpm start`), then run this script.
#
#   ./example.sh                          # against http://localhost:8080
#   QUOTER=http://host:8080 ./example.sh  # against a custom host
set -euo pipefail

QUOTER="${QUOTER:-http://localhost:8080}"
USDC="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"

echo "# native (feeAsset omitted)"
curl -fsS "$QUOTER/relay-fee?chain=ethereum"
echo

echo "# USDC"
curl -fsS "$QUOTER/relay-fee?chain=ethereum&feeAsset=$USDC"
echo
