#!/usr/bin/env bash
ENV="$(pwd)/contracts/.env.fork"

set -a
source $ENV
set +a

npx tsx contracts/scripts/sender/deploy.ts \
  --rpc $SENDER_RPC \
  --pk $PK \
  --relayer $BASE_RELAYER