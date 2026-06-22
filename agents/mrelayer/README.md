# mrelayer

Wormhole VAA relayer for cross-chain token transfers.

## Relayers

### Mrl Relayer (default)

Relays token transfers **to Moonbeam** from ETH, Base, Acala, Solana, and SUI using GMP precompile.
Also runs the Basejump fast-path watchers (Base + Ethereum → the corridor's `BasejumpProxy.completeTransfer`)
and the Solana oracle relay.

### Base Relayer

Relays token transfers **from Moonbeam to Base** using standard Wormhole Token Bridge.

### Ethereum Relayer

Relays token transfers **from Moonbeam to Ethereum** using standard Wormhole Token Bridge.

### Intent Relayer (`start:intent`)

Relays the WTT intent path **from Moonbeam to Ethereum** — payload-3 transfers addressed to the
`IntentReceiver`. Completes via `IntentReceiver.redeem(vaa, feeRequested)` (the payload-3 recipient
restriction means the bare TokenBridge can't), pricing `feeRequested` from the [quoter](../quoter/)
service and skipping when it exceeds the payload's `maxRelayFee`. Uses its own **reimbursed** wallet
(`INTENT_PRIVKEY`), separate from the generic relayers.

## Environment Variables

### Common (all relayers)

| Variable              | Description                                                        | Default          |
| --------------------- | ------------------------------------------------------------------ | ---------------- |
| `PRIVKEY`             | Signing key (the **intent** relayer uses `INTENT_PRIVKEY` instead) | Required         |
| `REDIS_HOST`          | Redis host                                                         | `localhost`      |
| `REDIS_PORT`          | Redis port                                                         | `6379`           |
| `SPY_ENDPOINT`        | Wormhole Spy endpoint                                              | `localhost:7073` |
| `WORMHOLE_API_KEY`    | Wormholescan API key (raises rate limit)                           | optional         |
| `GAS_WARN_MULTIPLIER` | Low-gas warning threshold (× min gas)                              | `50`             |
| `DISCORD_WEBHOOK_URL` | Low-gas / out-of-gas alerts                                        | optional         |

### Mrl relayer — `start` (inbound to Hydration)

| Variable                 | Description                                       | Default                              |
| ------------------------ | ------------------------------------------------- | ------------------------------------ |
| `MOONBEAM_RPC`           | Moonbeam RPC endpoint                             | `https://moonbeam-rpc.n.dwellir.com` |
| `ETH_FROM_SEQ`           | Start sequence for ETH VAAs                       | `499562`                             |
| `BASE_FROM_SEQ`          | Start sequence for Base VAAs                      | `244981`                             |
| `ACA_FROM_SEQ`           | Start sequence for Acala VAAs                     | `3358`                               |
| `SOLANA_FROM_SEQ`        | Start sequence for Solana token VAAs              | `1211243`                            |
| `SUI_FROM_SEQ`           | Start sequence for SUI VAAs                       | `217370`                             |
| `BASEJUMP_BASE_FROM_SEQ` | Start sequence for Basejump (Base) fast-path VAAs | `0`                                  |
| `BASEJUMP_ETH_FROM_SEQ`  | Start sequence for Basejump (Ethereum) fast-path VAAs | `0`                              |
| `ORACLE_SOLANA_FROM_SEQ` | Start sequence for Solana oracle VAAs             | `0`                                  |

### Base relayer — `start:base` (Moonbeam → Base)

| Variable            | Description                      | Default                    |
| ------------------- | -------------------------------- | -------------------------- |
| `BASE_RPC`          | Base RPC endpoint                | `https://mainnet.base.org` |
| `MOONBEAM_FROM_SEQ` | Start sequence for Moonbeam VAAs | `0`                        |

### Eth relayer — `start:eth` (Moonbeam → Ethereum)

| Variable            | Description                      | Default                    |
| ------------------- | -------------------------------- | -------------------------- |
| `ETH_RPC`           | Ethereum RPC endpoint            | `https://eth.llamarpc.com` |
| `MOONBEAM_FROM_SEQ` | Start sequence for Moonbeam VAAs | `95495`                    |

### Intent relayer — `start:intent` (Moonbeam → Ethereum, reimbursed)

| Variable            | Description                                         | Default                    |
| ------------------- | --------------------------------------------------- | -------------------------- |
| `INTENT_PRIVKEY`    | Reimbursed signing wallet (separate from `PRIVKEY`) | Required                   |
| `INTENT_RECEIVER`   | IntentReceiver proxy address on Ethereum            | Required                   |
| `QUOTER_URL`        | quoter service base URL                             | `http://localhost:8080`    |
| `ETH_RPC`           | Ethereum RPC endpoint                               | `https://eth.llamarpc.com` |
| `MOONBEAM_FROM_SEQ` | Start sequence for Moonbeam VAAs                    | `0`                        |

## Development

```bash
# Install dependencies
npm install

# Run Moonbeam relayer (dev)
npm run dev

# Run Base relayer (dev)
npm run dev:base


# Start Redis locally
npm run redis

# Start Wormhole Spy (mainnet)
npm run mainnet-spy
```

## Production

```bash
# Build
npm run build

# Run Moonbeam relayer
npm run start

# Run Base relayer
npm run start:base
```

## Docker

```bash
# Build image
docker build -t mrelayer .

# Run Moonbeam relayer (default)
docker run -e PRIVKEY=<key> mrelayer

# Run Base relayer
docker run -e PRIVKEY=<key> -e BASE_RPC=<rpc> mrelayer start:base
```

## Docker Stack

```bash
# Deploy Moonbeam relayer stack
docker stack deploy -c stack.yml mrelayer
```

For Base relayer, override the command in your stack config:

```yaml
services:
  app:
    image: mrelayer
    command: ["start:base"]
    environment:
      BASE_RPC: "https://mainnet.base.org"
      # ...
```
