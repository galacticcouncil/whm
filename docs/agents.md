# Off-chain agents

How to check every agent's bot wallet, its balance and how long that balance lasts.

## Run

```sh
pnpm print:agents              # balances + runway from the stored bots (seconds)
pnpm print:agents --discover   # re-scan the last 24h of chain activity first (~1 min)
```

Discovery also runs on its own when `sh/agents.json` does not exist yet. Re-discover after:

- rotating an agent's key,
- changing a cadence (broadcaster thresholds, refresh interval),
- adding or removing an agent or route.

## How discovery works

1. Each agent has a list of the contracts it calls directly: emitters, receivers, NTT transceivers.
2. The script reads those contracts' logs from the last 24h and samples the transactions behind them.
3. Anyone may call these contracts, so the bot is the sender with the most direct calls in the sample.
4. The bot's transactions per 24h and its cost per transaction give the burn per 24h.
5. The results are saved to `sh/agents.json`. Every later run only re-reads balances.

Keys are never read. Signers come from chain activity only.

## Reading the output

**Agents table**, one row per agent:

| Column   | Meaning                                    |
| -------- | ------------------------------------------ |
| Bot      | Dominant direct caller over the last 24h   |
| Share    | Bot's transactions / direct calls sampled. |
| Tx/24h   | Bot's own transactions in the window       |
| Cost/tx  | Average fee paid per transaction           |
| Burn/24h | Tx/24h × Cost/tx                           |

`relayer/ntt` usually shows a share below 100%, because users redeem their own NTT transfers on the same transceivers.

**Wallets table**, one row per wallet and chain. Agents that share a key are summed:

| Column  | Meaning                                |
| ------- | -------------------------------------- |
| Balance | Native gas balance (WETH on Hydration) |
| Runway  | Balance / Burn/24h                     |

**`WARN shared signer`** lists keys used by more than one agent on one chain. Those agents compete for nonces, so one agent's transaction can stall or replace another's. The fix is a separate key for each agent.

## Caveats

- Burn is based on a single 24h window. Oracle cadence follows the market, so a volatile day can multiply it.
- An agent with no transactions in the window shows `-`, and its wallet drops out of the wallets table.
- On Hydration, a transaction holds `gas_limit × max_fee_per_gas` up front and refunds the unused part afterwards. Keep the balance well above the per-transaction burn.

## Adding an agent

Edit the targets at the top of [sh/print-agents.sh](../sh/print-agents.sh). They mirror the agents' own routes, so keep them in step:

- `AGENTS` has one row per agent: `service/app|chain|targets`.
- `NTT_TRANSCEIVERS` holds every Hydration-side transceiver, including tokens the relayer doesn't route yet.
- `ORACLE_RECEIVERS` holds the Hydration receivers, one per source chain.
- `SOLANA_PROGRAM` is the oracle-emitter program.

Sources: `agents/broadcaster/src/apps/*/routes.ts` and `agents/relayer/src/apps/*/routes.ts`.

Not covered yet: the Gamma keeper and the DIA EVM bots.
