#!/usr/bin/env bash
ENV="$(pwd)/contracts/.env.fork"

set -a
source $ENV
set +a

npx tsx contracts/scripts/receiver/deploy.ts \
  --rpc $RECEIVER_RPC \
  --pk $PK \
  --relayer $MOONBEAM_RELAYER \
  --sender $SENDER \
  --source-chain-id $SOURCE_CHAIN_ID
