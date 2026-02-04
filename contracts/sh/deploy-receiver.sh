#!/usr/bin/env bash

RPC=http://127.0.0.1:8545
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
RELAYER=0x27428DD2d3DD32A4D7f7C497eAaa23130d894911
SENDER=0x27428DD2d3DD32A4D7f7C497eAaa23130d894911
SOURCE_CHAIN_ID=30

npx tsx contracts/scripts/receiver/deploy.ts \
  --rpc $RPC \
  --pk $PK \
  --relayer $RELAYER \
  --sender $SENDER \
  --source-chain-id $SOURCE_CHAIN_ID
