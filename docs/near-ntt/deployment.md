# NEAR NTT — Mainnet deployment cookbook

One migration per token: `near-ntt-near` (`wrap.near`) and `near-ntt-zec` (`zec.omft.near`). Both run
the same seven steps; env files are `migrations/envs/prod/near-ntt-<token>.env`. Design:
[spec.md](spec.md). Steps in detail: [`near-ntt-zec/index.ts`](../../migrations/definitions/near-ntt-zec/index.ts).

```
001 deploy ntt-manager (create + fund + deploy + init, one transaction)
002 register the emitter on the Wormhole core
003 register storage on the token
004 peer with the Hydration manager + transceiver
005 propose the NEAR custodian as owner
006 delete the contract account's keys — from here only the owner can upgrade it
007 accept the ownership — the custodian calls accept_ownership; a re-run continues
```

## Before the migration

1. **Hydration side first (hydration-ntt):**
   - Register the asset (the `new-hydration-asset` skill).
   - Deploy the BURNING `NttManager` and `WormholeTransceiver`.
   - Fill in `HYDRATION_NTT_MANAGER`, `HYDRATION_NTT_TRANSCEIVER` and `HYDRATION_TOKEN_DECIMALS`. ZEC
     needs at least 8 decimals on Hydration; the connector route depends on there being no trim dust.

2. **Deployer:** set `NEAR_ACCOUNT` and fund it with about 5.1 NEAR. That's `NTT_BALANCE`=5, plus 0.01
   for emitter registration, 0.00125 for token storage, and gas. Code is about 2.6 NEAR of that, so 5
   leaves roughly 2.4 NEAR free. `PK_NEAR` (`ed25519:…`) goes in your shell.

3. **Custodian multisig:** set `NTT_NEW_OWNER`. Check on testnet first that it can actually call:
   - `accept_ownership` with 1 yocto attached.
   - `upgrade` with the raw ~252 KB wasm as input. `upgrade.ts --print` gives the proposal.

   After 006 that owner is the only way to change the code, so this is the one check that can't be
   fixed later. If the multisig can't call `upgrade`, the contract is still owned but can't be
   upgraded. If it can't call `accept_ownership`, the deployer simply stays owner. Left empty, the
   migration stops at 005 and a re-run continues once it is set.

4. **Build once, from the contract directory.** The package script is broken.

   ```bash
   cd crates/near/contracts/ntt-manager && cargo near build non-reproducible-wasm && cd -
   ```

   Don't rebuild between 001 and 006: 006 refuses unless the code on chain equals `NTT_WASM`. For
   mainnet, consider `reproducible-wasm` instead, so anyone can match the code hash.

5. **Launch caps:** the prod envs have 1,000 NEAR and 10 ZEC per 24 h, in each direction. Confirm those
   numbers.

## Run

```bash
pnpm migrate:near-ntt-near      # or: pnpm migrate:near-ntt-zec
```

- **Stops at 007** until the custodian has accepted. The multisig calls `accept_ownership` (1 yocto)
  on `ntt-<token>.<NEAR_ACCOUNT>`; then run the same command again and 007 completes. Until then the
  deployer is still owner: a mistyped custodian is fixed by calling `transfer_ownership` again.
- **Accept straight away.** Between 006 and 007 the deployer's own key is the only upgrade authority.
  Have the multisig proposal ready before running, and keep `PK_NEAR` safe until 007 is done. A
  proposal is withdrawn by proposing the current owner and accepting it.
- **Any failure** — run the same command again; it resumes at the failed step.
- **Record:** `deployments/prod/near-ntt-<token>.json`. `001` holds the `nttAccount` and the
  `emitter` the next section needs.

Check the result:

```bash
RPC_NEAR=https://rpc.mainnet.near.org npx tsx crates/near/scripts/ntt-manager/status.ts \
  --contract ntt-<token>.<NEAR_ACCOUNT>
```

Owner = the custodian, peer 73 = the Hydration manager + transceiver, both limits as configured, not
paused. The account has no access keys left.

## After the migration

6. **hydration-ntt peers back:** `setPeer(15, <001 emitter>, <decimals>, <inbound limit>)` and
   `setWormholePeer(15, <001 emitter>)`.
7. **`set_ntt_minter` referendum:** this needs governance approval and is the real calendar gate.
8. **Relayer:** add an `ntt` route for NEAR → Hydration (source chain 15, `sourceEmitter` = the 001
   emitter). It isn't built yet. Hydration → NEAR is self-redeem through `complete.ts`.
9. **Monitoring:**
   - The contract's free balance. The failed-publish refund path pays for its `claimable` entry from
     it.
   - The conservation invariant: locked = Hydration supply + in flight + queued + claimable.
   - The `whm-ntt` events.
10. **Canary:** one small transfer each way under the caps. That will be the first real Hydration →
    NEAR run: redeem, held deposit and payout have only been tested in the unit and sandbox tests so
    far.

    ```bash
    # NEAR → Hydration
    npx tsx crates/near/scripts/ntt-manager/transfer.ts --contract ntt-<token>.<NEAR_ACCOUNT> \
      --token <token> --amount <units> --recipient 0x<H160> --account <you>.near --pk ed25519:…
    # Hydration → NEAR, after an NTT transfer on Hydration to sha256(<you>.near)
    npx tsx crates/near/scripts/ntt-manager/complete.ts --contract ntt-<token>.<NEAR_ACCOUNT> \
      --emitter <hydration transceiver> --sequence <n> --account <you>.near --pk ed25519:…
    ```
