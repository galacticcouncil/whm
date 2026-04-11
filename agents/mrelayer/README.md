# mrelayer

Wormhole VAA relayer for cross-chain token transfers.

## Relayers

### Moonbeam Relayer (default)
Relays token transfers **to Moonbeam** from ETH, Base, Acala, Solana, and SUI using GMP precompile.

### Base Relayer
Relays token transfers **from Moonbeam to Base** using standard Wormhole Token Bridge.

### Solana Relayer
Relays Solana oracle messages to the MessageDispatcher proxy on Moonbeam. Integrated into the main Moonbeam relayer.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PRIVKEY` | Private key for signing transactions | Required |
| `MOONBEAM_RPC` | Moonbeam RPC endpoint | `https://moonbeam-rpc.n.dwellir.com` |
| `BASE_RPC` | Base RPC endpoint | `https://mainnet.base.org` |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `SPY_ENDPOINT` | Wormhole Spy endpoint | `localhost:7073` |
| `MOONBEAM_FROM_SEQ` | Starting sequence for Moonbeam VAAs | `0` |
| `ETH_FROM_SEQ` | Starting sequence for ETH VAAs | `499562` |
| `BASE_FROM_SEQ` | Starting sequence for Base VAAs | `244981` |
| `ACA_FROM_SEQ` | Starting sequence for Acala VAAs | `3358` |
| `SOLANA_FROM_SEQ` | Starting sequence for Solana VAAs | `1211243` |
| `SUI_FROM_SEQ` | Starting sequence for SUI VAAs | `217370` |
| `ORACLE_SOLANA_FROM_SEQ` | Starting sequence for Solana oracle VAAs | `0` |

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
      BASE_RPC: 'https://mainnet.base.org'
      # ...
```
