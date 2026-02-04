#!/usr/bin/env bash

RPC=http://127.0.0.1:8546
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
RELAYER=0x706F82e9bb5b0813501714Ab5974216704980e31

npx tsx contracts/scripts/sender/deploy.ts \
  --rpc $RPC \
  --pk $PK \
  --relayer $RELAYER