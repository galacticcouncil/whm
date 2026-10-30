# PSM launch — Base USDC ⇄ Hydration HOLLAR

From nothing deployed to deposits open. Run the steps in order; each ends with what to check
before the next. Deployment is from `feat/psm`.

## Who acts

| Role | Holder | Does |
|---|---|---|
| Base deployer | `PK` = `0x20b588a194d9a3D788985c0C86A1160836a0Aaaa` | migration steps 001–003, 008–009 — needs ETH on Base |
| Hydration deployer | `PK_FACILITATOR` = `0x71FeB8b2849101a6E62e3369eaAfDc6154CD0Bc0` | steps 004–007 — on `EVMAccounts.ContractDeployer`, needs WETH on Hydration |
| Base Safe (4-of-7) | `0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7` | vault admin, guardian, treasurer — opens deposits |
| Technical Committee | majority, as emergency admin `0xaa7e0000000000000000000000000000000aa7e1` | facilitator admin and guardian — opens redeem, then mint |
| Referendum (EconomicParameters) | as AaveManager `0xaa7e0000000000000000000000000000000aa7e0` | grants the 10,000 HOLLAR bucket |
| Relayer operator | `app-psm-hydration`, `app-psm-base` | delivers both directions |

The Base key and the Hydration key are held by different people, and `sh/migrate-psm-base.sh`
requires both `PK` and `PK_FACILITATOR` on every run. Each run sets the key it signs with and gives
the other variable a throwaway, `0x$(openssl rand -hex 32)` — nothing in that run signs with it.
The Base key is in the macOS keychain (macOS asks to allow `security` once):

```sh
key() { security find-generic-password -s "$1" -w | sed 's/^0x//; s/^/0x/'; }
cast wallet address --private-key "$(key whm-eth-deployer)"   # 0x20b588a194d9a3D788985c0C86A1160836a0Aaaa
```

The wrapper sources the root `.env` after the shell, so a `PK` there overrides the one passed in.
After every run, commit and push `deployments/prod/psm-base.json`; pull it before the next.

## Addresses

| | |
|---|---|
| USDC (Base) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| aUSDC (Base) | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB` |
| Aave PoolAddressesProvider (Base) | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` |
| Wormhole core (Base, chain 30) | `0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6` |
| Wormhole core (Hydration, chain 73) | `0x3792a6d63c31941B2805181771795D9176fA82A1` |
| HOLLAR (GhoToken) | `0x531a654d1696ed52e7275a8cede955e82620f99a` |
| Vault, facilitator | `deployments/prod/psm-base.json`, `proxyAddress` of 001 and 004 |

The commands below use:

```sh
RPC_BASE=<dedicated Base RPC>
RPC_HYD=https://rpc.hydradx.cloud/evm
STATE=deployments/prod/psm-base.json
VAULT=$(jq -r '.steps[] | select(.name=="001-deploy-vault") | .output.proxyAddress' $STATE)
FACILITATOR=$(jq -r '.steps[] | select(.name=="004-deploy-facilitator") | .output.proxyAddress' $STATE)
ADMIN=0x0000000000000000000000000000000000000000000000000000000000000000
```

## 1. Pre-flight

```sh
(cd contracts && forge test --match-path "test/psm/**") # set RPC_BASE + RPC_HYDRATION so the 16 fork tests run
npx tsx chopsticks/probes/_probePsmRedeem.ts
pnpm fork:base                                           # terminal 1
pnpm fork:hydration                                      # terminal 2
pnpm migrate:psm-base:fork                               # terminal 3, right after the forks start
```

Everything passes, and the rehearsal stops at `011-upgrade@facilitator`, which waits for the
admin's upgrade (3c). A second `migrate:psm-base:fork` skips the ten steps before it. Delete
`deployments/fork/psm-base.json` before rehearsing again.

## 2. Base half

```sh
PK="$(key whm-eth-deployer)" PK_FACILITATOR=0x$(openssl rand -hex 32) \
  pnpm migrate:psm-base --pause-at 003-set-limits@vault
```

Check:

```sh
cast call $VAULT "depositsPaused()(bool)" --rpc-url $RPC_BASE    # true
cast call $VAULT "redeemFeeBps()(uint256)" --rpc-url $RPC_BASE   # 5
cast call $VAULT "limits()(uint256,uint256,uint256,uint256,uint256,uint256)" --rpc-url $RPC_BASE
# 10000000000 86400 10000000000 10000000000 86400 10000000000
```

Commit `deployments/prod/psm-base.json`. Verify the implementation and proxy on Basescan — the PSM
compiles with the optimizer at 200 runs.

## 3. Hydration, then Base, then the facilitator upgrade

Runs that each resume where the last stopped.

**a. Hydration key, 004–007:** deploy the facilitator, bind the vault as its emitter, set its
limits, hand it to the TC.

```sh
PK=0x$(openssl rand -hex 32) PK_FACILITATOR=<hydration key> \
  pnpm migrate:psm-base --pause-at 007-transfer-ownership@facilitator
```

**b. Base key, 008–009:** bind the facilitator on the vault, hand the vault to the Safe.

```sh
PK="$(key whm-eth-deployer)" PK_FACILITATOR=0x$(openssl rand -hex 32) \
  pnpm migrate:psm-base --pause-at 009-transfer-ownership@vault
```

**c. Hydration key, 010, then the TC, 011:** upgrade the facilitator to the implementation with
`redeemWithPermit`. 010 deploys it; 011 sends nothing and fails, printing the `upgradeToAndCall`
calldata, until the proxy points at it.

```sh
PK=0x$(openssl rand -hex 32) PK_FACILITATOR=<hydration key> pnpm migrate:psm-base
```

A TC member proposes that calldata to `$FACILITATOR` through `dispatch_as_emergency_admin`, the
shape of Motion 1 in step 7. Once it enacts, the same command again completes 011:

```sh
PK=0x$(openssl rand -hex 32) PK_FACILITATOR=<hydration key> pnpm migrate:psm-base
cast storage $FACILITATOR 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $RPC_HYD   # 010's implAddress
```

A run that reaches the other key's step fails it before anything is sent; the right key's next run
retries it.

Check:

```sh
cast call $VAULT "hasRole(bytes32,address)(bool)" $ADMIN 0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7 --rpc-url $RPC_BASE   # true
cast call $VAULT "authorizedEmitters(uint16)(bytes32)" 73 --rpc-url $RPC_BASE                  # the facilitator, padded
cast call $FACILITATOR "hasRole(bytes32,address)(bool)" $ADMIN 0xaa7e0000000000000000000000000000000aa7e1 --rpc-url $RPC_HYD  # true
cast call $FACILITATOR "authorizedEmitters(uint16)(bytes32)" 30 --rpc-url $RPC_HYD            # the vault, padded
cast call $FACILITATOR "mintPaused()(bool)" --rpc-url $RPC_HYD                                 # true
cast call $FACILITATOR "redeemPaused()(bool)" --rpc-url $RPC_HYD                               # true
cast call $FACILITATOR "limits()(uint256,uint256,uint256,uint256)" --rpc-url $RPC_HYD          # 10000000000 ×4
```

Neither deployer holds `$ADMIN` on its contract. Commit the state file and verify the facilitator
on the Hydration explorer.

## 4. Proposal calldata

```sh
npx tsx chopsticks/probes/_probePsmGoLive.ts [--label "HOLLAR PSM Base USDC"]
```

It reads the facilitator from the state file, prints the calldata, and enacts all three on a fork
of live Hydration under their real origins. Use only an output that shows no `STAND-IN` warning and
ends with every check passing. It prints:

- the referendum: `preimage.notePreimage` and `referenda.submit`;
- Motion 1 (open redeem) and Motion 2 (open mint): `technicalCommittee.propose`, with the threshold
  read from the live committee;
- the two accounts that pay the EVM gas, what each holds and what each needs.

## 5. Referendum — the bucket

1. From any account, submit the step 4 `preimage.notePreimage`, then `referenda.submit`.
2. Place the 750,000 HDX decision deposit (`referenda.placeDecisionDeposit`).
3. Track economic_parameters: 7-day decision, 12-hour confirmation, then it enacts 100 blocks
   (10 minutes) after approval.

The AaveManager's gas account must hold 0.003 WETH when it enacts (step 4 prints the account).

Check, after enactment:

```sh
cast call 0x531a654d1696ed52e7275a8cede955e82620f99a "getFacilitator(address)((uint128,uint128,string))" $FACILITATOR --rpc-url $RPC_HYD
# (10000000000000000000000, 0, "HOLLAR PSM Base USDC")
```

## 6. Relayer

1. Fill `agents/relayer/src/apps/psm/routes.ts`: route `mint` is vault → facilitator, route `redeem`
   is facilitator → vault.
2. `pnpm --filter @whm/relayer verify:psm-app`, then `pnpm --filter @whm/relayer docker:deploy`.
3. In `agents/relayer/stack.yml`: `app-psm-hydration` gets its own `PRIVKEY` (WETH on Hydration),
   `app-psm-base` its own `PRIVKEY_BASE` (ETH on Base), a dedicated `RPC_BASE`, and
   `DISCORD_WEBHOOK_URL` on both.
4. `pnpm --filter @whm/relayer docker:up`.

Both services must be running before step 9. A message published before they subscribe is not
picked up; it has to be delivered by hand with `receiveMessage(vaa)`.

## 7. Motion 1 — open redeem

Any time after step 3. A TC member signs Motion 1's `technicalCommittee.propose` from step 4;
members vote; anyone closes it. Redeem has no capacity until something is minted.

The emergency admin's gas account must hold 0.001 WETH.

Check:

```sh
cast call $FACILITATOR "redeemPaused()(bool)" --rpc-url $RPC_HYD    # false
cast call $FACILITATOR "maxRedeemable()(uint256)" --rpc-url $RPC_HYD  # 0 until the first mint
```

## 8. Motion 2 — open mint

After step 5 has enacted. Same as Motion 1, with Motion 2's calldata.

Check:

```sh
cast call $FACILITATOR "mintPaused()(bool)" --rpc-url $RPC_HYD      # false
cast call $FACILITATOR "mintHeadroom()(uint256)" --rpc-url $RPC_HYD # 10000000000
```

## 9. Open deposits — Base Safe

After steps 6 and 8. The Safe calls the vault with `setDepositsPaused(false)`:

```
0x1c481e2d0000000000000000000000000000000000000000000000000000000000000000
```

Check:

```sh
cast call $VAULT "depositAllowance()(uint256)" --rpc-url $RPC_BASE  # 10000000000
```

## 10. Canary

One key with USDC and ETH on Base and WETH on Hydration. Deposit 10 USDC, redeem 5.

```sh
ME=<address of KEY>
cast send 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "approve(address,uint256)" $VAULT 10000000 --rpc-url $RPC_BASE --private-key $KEY
cast send $VAULT "deposit(uint256,bytes32)" 10000000 $(cast abi-encode "f(address)" $ME) --rpc-url $RPC_BASE --private-key $KEY
```

The mint lands on Hydration within a couple of minutes:

```sh
cast call 0x531a654d1696ed52e7275a8cede955e82620f99a "balanceOf(address)(uint256)" $ME --rpc-url $RPC_HYD   # 10e18
```

Redeem 5 USDC to the same address on Base:

```sh
cast send 0x531a654d1696ed52e7275a8cede955e82620f99a "approve(address,uint256)" $FACILITATOR 5000000000000000000 --rpc-url $RPC_HYD --private-key $KEY
cast send $FACILITATOR "redeem(uint256,address,uint16,uint64,bytes32)" 5000000 $ME 5 $(($(date +%s)+1200)) $(cast keccak canary) --rpc-url $RPC_HYD --private-key $KEY
```

The credit lands on Base about a minute later, net of the 5 bps fee:

```sh
cast call $VAULT "claimable(address)(uint256)" $ME --rpc-url $RPC_BASE   # 4997500
cast send $VAULT "claim()" --rpc-url $RPC_BASE --private-key $KEY
```

Check the books once nothing is in flight: facilitator `outstanding()` ÷ 1e12 plus
`totalPendingMint()` equals vault `principal()` — 5000000 after this canary.

## 11. UI

After the SDK release with the PSM routes is in the UI build, turn off `VITE_PSM_DISABLED`.

## After launch

- Relayer: a delivery retried for about 5 days parks and is never re-queued. Recovery is
  `receiveMessage(vaa)` on the destination, which anyone may send.
- Vault `Disputed` and `CreditUnpayable`, facilitator `MintQueued`.
- The books: `outstanding()` against `principal()`, as in step 10.
- Base Wormhole `messageFee()` stays 0: a fee-cap return publishes from inside the delivery and
  fails while it is not.
- Keepers are manual: `drain` on Base pays a recipient that never claims (an exchange or payment
  address), and `flushPendingMint` on Hydration mints a queued entry once its blocker clears.

## Emergency levers

| To | Who | Call |
|---|---|---|
| Stop mint and redeem | TC motion | facilitator `setPaused(true, true)` through `dispatch_as_emergency_admin` — Motion 1's shape |
| Stop deposits | Base Safe | vault `setDepositsPaused(true)` |
| Stop payouts, cancels and fee-cap returns | Base Safe | vault `setClaimsPaused(true)` |
| Pull the reserve out of Aave | Base Safe | vault `emergencyUnwindAave(amount)` |
| Cancel a stuck head for its owner | Base Safe | vault `cancelQueuedRedemptionFor(index)` |
| Cancel a queued mint for its owner | TC motion | facilitator `cancelPendingMintFor(id, maxFeeBps)` |
| Hydration circuit-breaker lockdown | whoever triggers it | add facilitator `setPaused(true, true)` to the same batch — facilitator mints bypass the breaker |
