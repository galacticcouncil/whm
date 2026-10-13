# Cross-Chain Governance Executor

## Status

Draft v0.1. This document defines the intended security model and the decisions that must be closed
before implementation.

The following parameters are agreed for v0.1:

| Parameter | Decision |
| --- | --- |
| Hydration governance origin | Root |
| Hydration governance identity | Fixed runtime account mapped to `0xaa7e0000000000000000000000000000000aa7e2` |
| OpenGov execution delay | 24 hours from destination queueing; TC may fast-track |
| Technical Committee recovery delay | 30 days from destination queueing; OpenGov may veto |
| Execution grace period | 7 days after the action matures |
| Batch behavior | Atomic, at most 16 calls |
| Upgrade model | UUPS; executor upgrades require self-call, dispatcher upgrades require governance caller |
| Technical Committee | Safe configured independently per destination chain; veto and fast-track OpenGov actions, propose 30-day recovery actions |
| Recovery veto | OpenGov cancellation of a TC recovery action cannot be vetoed by the TC |
| Queue and execution | Permissionless; failed execution remains retryable until expiry |
| Message destination | Exactly one destination executor per Wormhole message |
| Wormhole consistency | `202` (Hydration finalized) |

## Abstract

Hydration OpenGov needs to administer protocol-owned contracts and positions on Robinhood Chain,
Ethereum, and other EVM L1s and L2s. Initial consumers are Uniswap v4 liquidity positions and
Wormhole Native Token Transfer (NTT) deployments.

An enacted Hydration governance call publishes a destination-bound action through Wormhole. A
governance executor on the destination verifies the signed Wormhole message and queues the action.
The destination chain's Technical Committee multisig may veto the action or approve and execute it
before the ordinary 24-hour delay. If it does neither, anyone may execute it after the delay and
before its expiry. The committee may also propose arbitrary recovery calls, including ownership
transfers and upgrades. Those calls wait 30 days and OpenGov can veto them through a protected
governance action before they mature.

The executor is a contract account. It owns the Uniswap position NFTs and holds the relevant NTT
administrative roles; it is not an EOA.

## Goals

- Make Hydration OpenGov the proposal authority for protocol-owned positions and NTT administration
  on external EVM chains.
- Give the Technical Committee bounded veto, fast-track, and long-delay recovery controls.
- Allow arbitrary EVM calls so new integrations do not require a new governance bridge.
- Require no trusted relayer: VAA submission and matured-action execution are permissionless.
- Make every stage observable, replay-safe, and independently verifiable on-chain.
- Use the same destination contract and message format across supported EVM chains.

## Non-goals

- General user bridging or token transfers.
- Automatic proof that a message corresponds to a particular referendum number. Authorization comes
  from the OpenGov-controlled dispatcher path, not from an unverified identifier in the payload.
- Unauthenticated Technical Committee calls or modification of an OpenGov-signed payload.
- `delegatecall` into arbitrary targets.
- Non-EVM destination chains in the first version.

## System overview

```text
Hydration                                           Destination EVM chain
---------                                           ---------------------

OpenGov referendum
      |
      v
pallet-dispatcher
  dispatch as dedicated cross-chain
  governance account
      |
      v
GovernanceDispatcher.publish(action)
      |
      | Wormhole message / guardian-signed VAA
      v
                                              GovernanceExecutor.queue(vaa)
                                                        |
                                      veto period       | TC may veto
                                                        v
                                              GovernanceExecutor.execute(...)
                                                        |
                                    +-------------------+------------------+
                                    |                                      |
                                    v                                      v
                         Uniswap v4 PositionManager              Wormhole NTT contracts
```

One OpenGov referendum may publish multiple messages, but each message targets exactly one executor
on one destination chain.

## Authorities

| Authority | Capability |
| --- | --- |
| Hydration OpenGov | Publish destination actions through the governance dispatcher |
| Wormhole Guardians | Attest that the configured Hydration dispatcher published a message |
| Technical Committee multisig | Veto or fast-track OpenGov actions; propose calls subject to a 30-day OpenGov-veto window |
| Any account | Submit a valid VAA and execute a matured, unexpired action |
| Governance executor | Own positions/assets and exercise downstream contract permissions |

The Technical Committee cannot alter a verified OpenGov payload or undo execution. A veto is final
for that action ID. OpenGov may publish a new action with a new nonce. Committee-originated actions
cannot be fast-tracked, and their OpenGov cancellation actions cannot be vetoed by the committee.

## Hydration source path

### Dispatcher

Root uses the existing generic dispatch machinery with a dedicated synthetic account:

```text
Root
    -> Utility::dispatch_as(
         Signed(CrossChainGovernanceAccount),
         Dispatcher::dispatch_evm_call(EVM::call(...))
       )
    -> CrossChainGovernanceAccount
       0xaa7e0000000000000000000000000000000aa7e2000000000000000000000000
    -> deterministic EVM msg.sender
       0xaa7e0000000000000000000000000000000aa7e2
```

The account follows the existing synthetic `AaveManagerAccount` (`...aa7e0`) and
`EmergencyAdminAccount` (`...aa7e1`) address convention, but does not require another dispatcher
extrinsic or runtime constant. The Root proposal supplies the full 32-byte signed origin; its first
20 bytes are the EVM address. It has no managed private key.

Requirements:

- Use `pallet_utility::dispatch_as`, whose outer origin is already restricted to Root.
- Dispatch as exactly the synthetic `CrossChainGovernanceAccount` above.
- Nest the existing `pallet_dispatcher::dispatch_evm_call`, which accepts only an EVM call and
  checks its EVM exit reason.
- Require the `pallet_evm::Call::call.source` to match the synthetic signed origin.
- Do not reuse the Aave manager or emergency-admin identities: doing so would also authorize the
  Economic Parameters track or Technical Committee for immediate cross-chain publication.
- Monitor `Utility::DispatchedAs`, the EVM result, and `ActionPublished`; absence of the Wormhole
  publication event means the cross-chain action was not created.

The fixed account holds only the native balance needed for Hydration EVM gas and the exact Wormhole
message fee. It must not receive unrelated protocol roles, token approvals, or asset custody. It has
no key; funding does not make it externally controllable. Insufficient balance fails the referendum
inner call and must be visible in the utility dispatch result.

`Utility::dispatch_as` reports the inner result in `Utility::DispatchedAs` while returning outer
success. Governance automation must therefore inspect that event and confirm `ActionPublished`
rather than treating referendum enactment alone as proof of publication. This is the accepted cost
of reusing the generic Root-only path instead of adding a protocol-specific dispatchable.

### Governance dispatcher

`GovernanceDispatcher` is deployed on Hydration EVM and configured with:

- the Hydration Wormhole core contract;
- the dedicated cross-chain governance EVM address; and
- the supported message version.

Only the dedicated governance address may publish. The dispatcher assigns a monotonically increasing
`governanceNonce`; callers do not choose or reuse it. Each publication emits the destination,
nonce, action hash, and Wormhole sequence.

The dispatcher proxy is deployed with initialization calldata in the same transaction. Initialization
requires nonzero Wormhole and governance addresses, verifies that the Wormhole address has code,
requires the core contract to report Hydration Wormhole chain ID 73, sets `governanceNonce = 1`, and
cannot be repeated. The implementation constructor disables initializers. There is no deployer owner
and no setter for the governance caller.

Publication is payable and requires `msg.value == wormhole.messageFee()`. A fee change therefore
fails closed instead of trapping excess value or spending an unbounded dispatcher balance. The
dispatcher forwards exactly `msg.value`, never `address(this).balance`; forced native balance cannot be
spent by publication. The dispatcher must propagate a fee-check revert. The Wormhole consistency
level is the code constant `202`, which Hydration's production watcher treats as finalized. Live
verification showed that level `200` skips the pending queue with zero confirmations, while
otherwise-identical messages at `202` wait for finality. Governance cannot lower the constant
through a setter.

The dispatcher is UUPS-upgradeable. `_authorizeUpgrade` accepts only the fixed governance caller and its
state uses namespaced storage. The nonce must survive every upgrade and must revert rather than wrap.
There is no `ProxyAdmin` or alternate upgrade authority. The generic `MessageEmitter` is not suitable
because its `sendMessage` function is permissionless.

The v1 publication surface is:

```solidity
function publish(
    uint16 destinationWormholeChain,
    address destinationExecutor,
    Call[] calldata calls
) external payable returns (uint64 governanceNonce, uint64 wormholeSequence, bytes32 actionId);

event ActionPublished(
    bytes32 indexed actionId,
    uint16 indexed destinationWormholeChain,
    address indexed destinationExecutor,
    uint64 governanceNonce,
    uint64 wormholeSequence,
    bytes32 payloadHash
);
```

`publish` is reentrancy-guarded, checks its caller before any external interaction, rejects zero
destination fields and invalid calls, constructs the one canonical payload encoding, and enforces all
v1 size limits. It reserves and increments the governance nonce before calling Wormhole; a revert
rolls the increment back. The action ID uses the core contract's verified local Wormhole chain ID,
the left-zero-padded Wormhole emitter address of the dispatcher, and the payload hash according to
the formula below.

## Message format

Protocol v1 uses the following logical schema:

```solidity
struct Call {
    address target;
    uint256 value;
    bytes data;
}

struct GovernanceAction {
    uint8 version;
    uint16 destinationWormholeChain;
    address destinationExecutor;
    uint64 governanceNonce;
    Call[] calls;
}
```

The signed Wormhole payload is exactly:

```solidity
abi.encode(
    bytes6(0x484458474f56), // ASCII "HDXGOV"
    uint8(1),
    destinationWormholeChain,
    destinationExecutor,
    governanceNonce,
    calls
)
```

Its canonical ABI tuple is:

```text
(bytes6,uint8,uint16,address,uint64,(address,uint256,bytes)[])
```

The payload is encoded as the tuple above, not as `abi.encode(GovernanceAction)`. This distinction is
load-bearing because a top-level struct containing a dynamic array has a different ABI envelope.

`0x484458474f56` is the ASCII `HDXGOV` protocol discriminator and `1` is the independently checked
protocol version.
Both must match. The dispatcher assigns `governanceNonce`, starting at 1 and increasing by one for every
published destination message. Each message has its own nonce even when one referendum targets
several chains.

Protocol v1 limits are:

| Item | Limit |
| --- | ---: |
| Calls per action | 16 |
| Calldata in one `Call.data` | 32,768 bytes |
| Complete encoded Wormhole payload | 65,536 bytes |

Both dispatcher and executor enforce all three limits. The total limit applies to the exact ABI-encoded
payload, including tuple and array overhead. These are application limits, not claims about a global
Wormhole limit: Wormhole documents payload capacity as chain-dependent, and the EVM sender does not
impose a fixed payload cap. Every supported source/destination combination must still pass a
maximum-size fork or testnet rehearsal before production deployment.

After decoding, both contracts re-encode the fields with the tuple above and require the re-encoded
bytes to equal the supplied payload byte-for-byte. This rejects trailing bytes, non-canonical dynamic
offsets, overlapping regions, and any other alternate ABI representation that happens to decode to
the same calls. Every target must be nonzero and every individual `data` length must satisfy the
limit before publication or queueing.

### Domain separation

Every action commits to:

- the message-format version;
- the authorized source Wormhole chain and emitter, through VAA verification;
- the destination Wormhole chain;
- the destination executor address;
- the dispatcher-assigned governance nonce;
- every call's target, value, and calldata.

The destination chain and executor checks prevent the same VAA from being executed by another
deployment.

The action ID is exactly:

```solidity
bytes32 constant ACTION_DOMAIN =
    keccak256("hydration.cross-chain-governance.action.v1");

bytes32 payloadHash = keccak256(vm.payload);
bytes32 actionId = keccak256(
    abi.encode(
        ACTION_DOMAIN,
        uint16(vm.emitterChainId),
        bytes32(vm.emitterAddress),
        payloadHash
    )
);
```

The source chain and emitter come from the verified VAA, never from payload fields. Including them in
the action ID prevents collisions across an authorized-dispatcher migration. The record stores
`payloadHash`, so execution verifies the exact signed bytes without recomputing the action ID from the
executor's current source configuration. Consequently, changing the authorized dispatcher does not
strand actions that were already queued from the previous dispatcher.

The payload deliberately contains no referendum or preimage hash. A preimage cannot contain its own
hash without creating a circular dependency, and a caller-supplied referendum identifier would not
be independently trustworthy. The canonical audit identifiers are the Hydration enactment
transaction and block, Wormhole sequence and VAA hash, dispatcher-assigned governance nonce, and
destination action ID. Proposal tooling and published governance metadata must link these records.

## Destination executor

Each destination has an independent `GovernanceExecutor` configured with:

- Wormhole core address;
- authorized Hydration Wormhole chain ID;
- authorized Hydration dispatcher address in Wormhole universal-address form;
- local Wormhole chain ID, read from and checked against the Wormhole core contract;
- Technical Committee vetoer address;
- a 24-hour veto period; and
- a fixed 30-day Technical Committee recovery delay; and
- a 7-day execution grace period measured from action maturity.

For an action queued at `queuedAt`:

```text
executableAt = queuedAt + 24 hours
expiresAt    = executableAt + 7 days
```

For a Technical Committee recovery action, `executableAt = queuedAt + 30 days`. The normal grace
period applies after that maturity timestamp.

The executor must be able to receive native tokens and ERC-721 position NFTs. Support for other
token receiver interfaces is added only where an identified integration requires it.

The ERC-1967 proxy is deployed with initialization calldata in the same transaction. Initialization
requires a Wormhole contract with code, a nonzero source dispatcher, and a deployed Safe contract as
vetoer; verifies the local Wormhole chain ID from the core contract; installs the 24-hour and 7-day
minimums; and cannot be repeated. The implementation constructor disables initializers. The
executor uses namespaced storage and has no `ProxyAdmin`, deployer owner, or other upgrade path.

### External interface

Protocol v1 exposes the following application interface (alongside the inherited UUPS surface):

```solidity
interface IGovernanceExecutor {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    enum ActionState {
        Unknown,
        Pending,
        Ready,
        Vetoed,
        Executed,
        Expired
    }

    enum ActionAuthority {
        Unknown,
        Governance,
        TechnicalCommittee
    }

    struct ActionRecord {
        bytes32 payloadHash;
        uint64 governanceNonce;
        uint48 queuedAt;
        uint48 executableAt;
        uint48 expiresAt;
        uint8 storedStatus;
    }

    function queue(bytes calldata vaa) external returns (bytes32 actionId);
    function queueTechnicalCommitteeAction(bytes calldata payload) external returns (bytes32 actionId);
    function veto(bytes32 actionId, bytes32 reasonHash) external;
    function vetoTechnicalCommitteeAction(bytes32 actionId, bytes32 reasonHash) external;
    function execute(bytes32 actionId, bytes calldata payload) external;

    function action(bytes32 actionId) external view returns (ActionRecord memory);
    function actionAuthority(bytes32 actionId) external view returns (ActionAuthority);
    function technicalCommitteeNonce() external view returns (uint64);
    function state(bytes32 actionId) external view returns (ActionState);

    function setVetoer(address newVetoer) external;
    function setSourceDispatcher(bytes32 sourceDispatcher) external;
    function setTiming(uint48 vetoPeriod, uint48 executionGracePeriod) external;
}
```

`setVetoer`, `setSourceDispatcher`, `setTiming`, and UUPS upgrade authorization are `onlySelf`. The
initializer alone sets their bootstrap values. Timing changes affect only actions queued after the
change because every action stores its own deadlines. `setVetoer` rejects zero and requires deployed
code. Hydration Wormhole chain ID 73 is immutable in v1; `setSourceDispatcher` rotates only the
nonzero dispatcher address. `setTiming` enforces a minimum 24-hour execution delay and minimum 7-day grace
period; governance may lengthen them but cannot weaken these v1 floors without a vetoable
implementation upgrade. Ceilings bound the same call: the veto period must stay at least seven
days below the 30-day committee delay, so OpenGov always retains a real cancellation window over
committee actions, and the grace period may not exceed 90 days, keeping deadline arithmetic far
from the uint48 limit so a configuration call cannot brick either queue lane.

`setSourceDispatcher` replaces, rather than supplements, the authorized source. Before executing a
source migration, operators must queue and reconcile every intended VAA from the old dispatcher; an
old-dispatcher VAA first submitted after replacement is intentionally rejected. Already queued
old-dispatcher actions remain executable because their records retain the original payload hash and
action ID.

The executor also implements `receive()` and `IERC721Receiver.onERC721Received`.

### Events

```solidity
event ActionQueued(
    bytes32 indexed actionId,
    bytes32 indexed vaaHash,
    uint64 indexed governanceNonce,
    bytes32 payloadHash,
    uint48 queuedAt,
    uint48 executableAt,
    uint48 expiresAt
);

event ActionVetoed(
    bytes32 indexed actionId,
    address indexed vetoer,
    bytes32 indexed reasonHash
);

event ActionExecuted(bytes32 indexed actionId, address indexed caller);
event ActionFastTracked(bytes32 indexed actionId, address indexed technicalCommittee);
event TechnicalCommitteeActionQueued(
    bytes32 indexed actionId,
    uint64 indexed technicalCommitteeNonce,
    bytes32 payloadHash,
    uint48 queuedAt,
    uint48 executableAt,
    uint48 expiresAt
);
event VetoerUpdated(address indexed previousVetoer, address indexed newVetoer);
event SourceDispatcherUpdated(
    bytes32 previousSourceDispatcher,
    bytes32 newSourceDispatcher
);
event TimingUpdated(uint48 vetoPeriod, uint48 executionGracePeriod);
```

The inherited ERC-1967 `Upgraded` event records implementation changes. A failed atomic execution
reverts, so it cannot persist a failure event; callers and monitoring must retain the revert data and
transaction attempt.

### Action state

```text
Unknown       -> Pending
Pending       -> Ready       (derived at executableAt)
Pending/Ready -> Vetoed      (stored)
Ready         -> Executed    (stored)
Pending/Ready -> Expired     (derived after expiresAt)
```

`Ready` and `Expired` are timestamp-derived views of a stored pending record. Neither is written as a
storage status.

A pending action records at least:

- action ID, payload hash, and governance nonce;
- queue timestamp;
- executable timestamp;
- expiry timestamp; and
- stored status (`Pending`, `Vetoed`, or `Executed`).

The exact Wormhole payload bytes are supplied again at execution and checked against the stored
payload hash, avoiding unbounded calldata duplication in storage and re-encoding ambiguity.

### Queue

`queue(bytes vaa)` is permissionless and must:

1. Enter a reentrancy guard before calling the Wormhole core.
2. Parse and verify the VAA with the configured Wormhole core.
3. Require the configured Hydration source chain and dispatcher's emitter address from the verified VM.
4. Reject an already consumed VAA hash and a payload larger than 65,536 bytes.
5. Decode only the `HDXGOV` discriminator and supported message version.
6. Re-encode the decoded payload and require byte-for-byte canonical equality.
7. Require the local Wormhole chain ID and `address(this)` as destination.
8. Reject an empty batch, more than 16 calls, a zero target, or oversized call data.
9. Derive and reject a duplicate action ID.
10. Compute deadlines with checked arithmetic from `block.timestamp`.
11. Store the action and consume the VAA before emitting `ActionQueued`.

All state changes roll back if any check fails. The exclusive review period starts when the
destination accepts the VAA, not when Hydration publishes it. This guarantees the full configured
delay even if relaying is delayed.

### Veto

`veto(bytes32 actionId, bytes32 reasonHash)` may be called only by the destination's configured
Technical Committee Safe while the stored action status is pending and
`block.timestamp <= expiresAt`. The action remains vetoable after it becomes executable, until the
first successful veto or execution transaction wins ordering.

A veto is irreversible. It does not consume or alter unrelated actions. The reason for a veto is
recorded off-chain; `reasonHash` may link to that record and may be zero when no external record is
provided.

The configured Safe can veto ordinary OpenGov actions, including an action that would replace the
vetoer. The sole exception is a narrowly recognized OpenGov action containing exactly one
zero-value self-call to `vetoTechnicalCommitteeAction`. This exception ensures a compromised TC
cannot censor governance's veto of the TC's own recovery action. It does not provide a general Root
bypass or forced vetoer rotation.

### Execute

`execute(bytes32 actionId, bytes payload)` is permissionless and must:

1. Require `keccak256(payload)` to match the queued record's payload hash.
2. Decode, canonically re-encode, and revalidate the discriminator, version, destination, targets,
   batch count, and payload limits.
3. Require the stored action status to be pending.
4. Require `block.timestamp >= executableAt`, unless the action came from OpenGov and the configured
   TC is the caller.
5. Require `block.timestamp <= expiresAt`.
6. Enter a reentrancy guard and set the stored status to executed before the first external call.
7. Execute every call in order using normal EVM `call`.
8. Bubble a bounded form of downstream revert data and revert the whole batch if any call fails.

Setting the status before interaction prevents recursive execution; an outer revert rolls the status
back to pending, so a failed batch remains retryable until expiry. Successful execution retains the
executed status only after every call returns successfully.

Before interaction, execution computes the sum of every call value with checked arithmetic and
requires it not to exceed the executor's native balance.

If a call targets `address(this)` with the executor proxy's UUPS `upgradeToAndCall` selector, the
action must contain exactly that one call with zero native value. Any upgrade initialization is
carried inside `upgradeToAndCall`. This prevents a single batch from continuing across mixed old/new
implementation semantics.

A failed execution remains pending and retryable until expiry. Tooling records the failed transaction
and bounded revert data because reverted EVM logs do not persist.

When the TC executes a verified OpenGov action before `executableAt`, the executor emits
`ActionFastTracked`. The payload hash, destination checks, balance checks, atomicity, replay
protection, and expiry rules are identical to ordinary execution. Fast-track authority never applies
to a TC-originated recovery action.

### Technical Committee recovery

`queueTechnicalCommitteeAction(bytes payload)` accepts a canonical destination payload only from
the configured TC Safe. The payload must contain the next local monotonically increasing TC nonce;
the executor uses it in an authority-separated action ID, then records a fixed 30-day delay. The
current nonce is publicly readable. After maturity, execution is permissionless and uses
the same atomic call path as an OpenGov action. This lets the TC recover or transfer downstream
ownership, migrate assets, or upgrade the proxy when OpenGov is unavailable, without granting an
immediate arbitrary-call capability.

OpenGov vetoes such an action by publishing a normal action whose sole call is
`vetoTechnicalCommitteeAction(actionId, reasonHash)`. That governance action waits the normal
OpenGov delay, but the TC cannot veto it. Direct calls to the cancellation method fail because it is
`onlySelf`. TC actions expire after the configured grace period just like OpenGov actions.

### Expiry

After the grace period, an unexecuted action cannot execute. Expiry is derived permanently from the
stored `expiresAt` timestamp; there is no `expire()` or pruning transaction. The record remains in
storage for replay protection and auditability. OpenGov must publish a new action to try again.

### Self-administration

Changes to the executor itself pass through an authenticated action. The executor is a UUPS proxy.
Sensitive setters and `_authorizeUpgrade` use `onlySelf`, so they succeed only when the executor
calls itself from an executed OpenGov action or a matured, non-vetoed TC recovery action.

This includes:

- executor implementation upgrades;
- vetoer rotation;
- veto-period and grace-period changes;
- source dispatcher migration on Hydration chain 73; and
- recovery or migration to a replacement executor.

Bootstrap configuration is performed by atomic proxy initialization. No deployer authority exists
before or after handover. New implementations must preserve namespaced storage, retain UUPS
compatibility, and pass storage-layout validation before an upgrade action is proposed.

## Execution semantics

- Batches are atomic and contain between 1 and 16 calls.
- Calls execute from the executor's address.
- Arbitrary target addresses, calldata, and native value are supported.
- `delegatecall` is never exposed.
- A zero-address target is invalid.
- Native value across calls cannot exceed the executor's available balance.
- `execute` is nonpayable; execution spends only native balance already held by the executor.
- Native tokens may enter through `receive()`. There is no privileged sweep function; recovery is an
  ordinary delayed governance call.
- Queue, veto, and execute are protected against reentrancy. Administrative entry points rely on
  `onlySelf` and remain callable by the executor during a guarded execution.
- Receiver callbacks are deliberately not guarded because a governed call may safely transfer an
  ERC-721 to the executor during execution. They return only the required selector, mutate no
  governance state, and cannot bypass the guarded entry points.
- Return and revert data copied from a downstream target is capped at 4,096 bytes to prevent a target
  from forcing unbounded memory expansion. The executor does not otherwise use return data.

Because arbitrary calls are supported, the executor is a cross-chain root account for everything it
owns. Source authorization, message decoding, replay protection, and timing are the primary security
boundary.

## Initial integrations

### Uniswap v4

The executor is expected to own protocol LP position NFTs and call the deployed Uniswap v4
PositionManager or related periphery contracts. Before deployment, integration tests must identify
the exact Robinhood deployment and prove:

- safe transfer of a position NFT into the executor;
- liquidity increase and decrease;
- fee collection;
- settlement of any native-token or ERC-20 deltas;
- token approvals and Permit2 requirements;
- full withdrawal or migration to a replacement executor; and
- behavior when a position-manager call partially prepares state and then reverts.

No Uniswap-specific privileged method is required in the executor unless generic calls cannot safely
satisfy a receiver or callback requirement.

### Wormhole NTT

For each NTT deployment, record every role to be transferred or exercised:

- manager owner;
- proxy upgrade authority;
- pauser;
- transceiver owner;
- peer and threshold administration;
- rate-limit administration; and
- any chain-specific role that cannot be represented by an EVM address.

The executor may administer only EVM-resident roles. Solana, Sui, or other non-EVM ownership remains
out of scope until a separate destination adapter is specified.

Ownership transfer must be staged and verified with harmless calls before the prior owner gives up
recovery authority.

## Relaying and monitoring

No relayer is trusted for correctness, but production needs automation for availability.

A governance app in `agents/relayer` should:

- watch the Hydration dispatcher;
- fetch and submit signed VAAs to the correct destination;
- track pending actions and their deadlines;
- execute actions after maturity;
- retry transient failures without changing payloads;
- alert on veto, expiry, repeated failure, low gas, and unqueued VAAs; and
- expose source transaction, VAA hash, action ID, destination transaction, and final state.

Independent parties can perform the same queue and execute calls.

## Security invariants

1. Only a VAA from the configured Hydration dispatcher or the configured TC can create an action.
2. A VAA or authority-separated action ID cannot create more than one queued action on an executor.
3. An action cannot execute on a destination other than the one encoded in its payload.
4. Only the TC can execute a verified OpenGov action before its local veto period has elapsed.
5. A TC-originated action cannot execute before its fixed 30-day delay.
6. The TC can veto ordinary OpenGov actions but cannot veto OpenGov cancellation of a TC action.
7. Vetoed, expired, and executed actions can never execute.
8. A failed batch changes neither the action's terminal state nor downstream state.
9. Successful calls originate from the executor address that owns the governed resources.
10. Executor configuration and upgrades follow an authenticated OpenGov or delayed TC action path.
11. Deployment keys retain no authority after initialization and handover.
12. Alternate or non-canonical ABI encodings cannot represent an executable action.
13. No configuration call can reduce the ordinary execution delay below 24 hours or the grace period below 7
    days in implementation v1, raise the veto period to within seven days of the committee delay, or raise the
    grace period above 90 days.
14. Proxy initialization is atomic and neither implementation contract can be initialized directly.
15. An implementation upgrade cannot be mixed with other calls in one action.
16. An ordinary configuration action cannot authorize a source chain other than Hydration Wormhole
    chain 73.

## Threat model

The system assumes:

- Hydration OpenGov and the configured origin are honest according to their governance rules;
- Wormhole Guardian quorum is not compromised;
- the Technical Committee multisig can observe and veto malicious or erroneous actions within the
  configured window; and
- destination-chain consensus and the Wormhole core deployment are sound.

Expected failure modes and responses:

| Failure | Expected behavior |
| --- | --- |
| Unauthorized source message | Rejected during queue |
| Valid VAA relayed late | Full veto period begins at destination queue time |
| Duplicate VAA or action | Rejected |
| Wrong destination | Rejected |
| Malformed or unsupported payload | Rejected |
| Technical Committee offline | Action executes normally after the delay |
| Technical Committee compromised | It can censor or fast-track OpenGov actions and propose arbitrary calls, but OpenGov has 30 days to cancel each TC proposal |
| Destination outage spans the review period | Veto remains callable after maturity, but veto and execution may race when the chain resumes |
| Relayer offline | Any account can queue or execute |
| Downstream call reverts | Atomic batch reverts and remains retryable |
| Target changes after queueing | TC must evaluate and, if necessary, veto; the executor authenticates calldata, not target code or state |
| Action never executes | It expires after the grace period |
| Wormhole fee changes before enactment | Source publication reverts and the dispatcher reports failure |
| Governance dispatcher call reverts on Hydration | Runtime dispatcher reports enactment failure; no VAA is published |
| Executor bug | OpenGov upgrade path, or TC recovery upgrade subject to the 30-day OpenGov-veto window |

## Deployment model

Each destination deployment has its own configuration and custody record. At minimum, archive:

- chain ID and Wormhole chain ID;
- proxy and implementation addresses;
- Wormhole core address;
- Hydration dispatcher chain and address;
- vetoer multisig address and threshold;
- veto and grace periods;
- implementation code hash;
- initialization transaction;
- canary queue, veto, and execution transactions; and
- every transferred Uniswap position and NTT role.

Production deployments use the repository's crash-safe migration framework and produce immutable
state files under `deployments/prod/`.

Before the Hydration deployment, verify on-chain that the proposed `0xaa7e...aa7e2` identity has no
EVM code, account binding, nonce history, approvals, or existing protocol roles. After deployment,
monitor its native balance and assert that the governance dispatcher remains the only contract that
recognizes it as privileged.

## Test gates

### Solidity unit and fuzz tests

- Dispatcher caller authorization, exact Wormhole fee, fixed finality, and nonce persistence/overflow.
- Canonical encoding and size enforcement on both dispatcher and executor.
- Source-chain and emitter authentication.
- Payload version and canonical action hashing.
- Rejection of trailing bytes, alternate offsets, overlapping ABI regions, and dirty padding.
- Destination domain separation.
- VAA replay and action replay.
- Empty, malformed, and oversized batches.
- Exact veto, execution, and expiry timestamp boundaries.
- Unauthorized and late veto attempts.
- Atomic multi-call success and rollback.
- Status set before interaction and rolled back after a failed call.
- Failed-call retry behavior.
- Reentrancy attempts from call targets and token callbacks.
- Successful ERC-721 receipt during a guarded execution.
- Revert/return-data truncation at 4,096 bytes.
- Native-value sum overflow, insufficient balance, and exact accounting.
- Self-administration and upgrade authorization.
- Old-dispatcher VAA behavior before and after a source migration.
- Rejection of a mixed upgrade/action batch.
- Atomic proxy initialization, implementation initialization lock, and reinitialization attempts.
- Enforcement of the 24-hour and 7-day timing floors.
- ERC-721 receipt and recovery through governance.

### Hydration runtime tests

- `Utility::dispatch_as` rejects signed users and non-Root governance origins.
- Only EVM calls are accepted.
- The EVM caller is the dedicated governance address.
- An inner `pallet_evm::call` naming any other source address is rejected.
- Successful publication produces the expected Wormhole event.
- EVM revert and out-of-gas appear as failure in `Utility::DispatchedAs` and produce no
  `ActionPublished` event.
- Existing utility and dispatcher weights cover the nested call.
- The synthetic AccountId maps to the expected EVM address and has no account binding or unrelated
  roles.

### Fork and end-to-end tests

- Encode the exact OpenGov call and execute it on a persistent Hydration fork.
- Extract the published message and construct or retrieve its VAA.
- Queue it on each destination fork.
- Exercise both veto and successful execution paths.
- Operate a real Uniswap v4 test position.
- Exercise every NTT role intended for transfer.
- Test migration to a replacement executor.
- Verify events and final ownership directly on every chain.

## Decision checklist

### Governance and authority

- [x] Select Root as the OpenGov origin.
- [x] Assign the fixed `CrossChainGovernanceAccount` and `0xaa7e...aa7e2` EVM address.
- [x] Use the existing Root-only `Utility::dispatch_as` plus `Dispatcher::dispatch_evm_call` path;
  add no protocol-specific runtime dispatchable.
- [x] Allow the Technical Committee to veto or fast-track verified OpenGov actions.
- [x] Allow TC recovery actions only after a fixed 30-day, OpenGov-vetoable delay.
- [x] Prevent the TC from vetoing an OpenGov cancellation of a TC recovery action.

### Timing and lifecycle

- [x] Set the production veto period to 24 hours from queueing.
- [x] Set the execution grace period to 7 days after maturity.
- [x] Set the Technical Committee recovery delay to 30 days.
- [x] Define exact boundary semantics: veto through `expiresAt`; execute from `executableAt` through
  `expiresAt`, inclusive; after maturity transaction ordering resolves a veto/execution race.
- [x] Derive expiry from timestamps; retain records and provide no expiry/pruning transaction.

### Message protocol

- [x] Freeze the `HDXGOV` ABI tuple and protocol version 1.
- [x] Freeze the source-domain-separated `actionId` derivation.
- [x] Set the maximum batch size to 16 calls.
- [x] Limit each call's calldata to 32 KiB and the complete payload to 64 KiB.
- [x] Omit a self-referential preimage or referendum hash from the payload.
- [x] Confirm exactly one destination executor per message.
- [x] Freeze Hydration Wormhole consistency at `202` (finalized).
- [ ] Rehearse the 64 KiB maximum payload on Hydration and every destination before launch.

### Executor

- [x] Confirm atomic batch execution.
- [x] Choose UUPS with upgrades authorized only through an executor self-call.
- [x] Define `onlySelf` vetoer, source-dispatcher, timing, and UUPS administration.
- [x] Require native-token and ERC-721 receipt in the core executor.
- [x] Accept native funding through `receive()` and allow outflow only through delayed governance.
- [x] Eliminate deployer authority through atomic initialization and `onlySelf` administration.
- [ ] Specify recovery migration to a replacement executor.

### Integrations

- [ ] Record Robinhood Chain IDs and Wormhole support status.
- [ ] Record canonical Uniswap v4 deployment addresses and interfaces.
- [ ] Inventory all protocol-owned LP positions and required actions.
- [ ] Inventory all EVM NTT contracts, proxies, and current role holders.
- [ ] Identify NTT roles that cannot be transferred to an EVM executor.
- [ ] Write staged custody and ownership-transfer procedures.

### Operations

- [ ] Add destination routes to the governance relayer app.
- [ ] Define retry, gas, and alert policies.
- [ ] Build an action encoder and human-readable decoder.
- [ ] Produce a referendum builder that prints payloads and hashes.
- [ ] Record the referendum, enactment transaction, Wormhole sequence and VAA hash, governance
  nonce, and destination action ID as one audit trail.
- [ ] Add read-only deployment and custody verification scripts.
- [ ] Document permissionless manual queue and execution procedures.

### Assurance and launch

- [ ] Complete Solidity unit and fuzz tests.
- [ ] Complete dispatcher unit tests and benchmarks.
- [ ] Complete Hydration-to-destination fork rehearsal.
- [ ] Test veto and executor migration drills.
- [ ] Complete an independent security review.
- [ ] Deploy and verify contracts on every destination.
- [ ] Execute queue, veto, and execution canaries.
- [ ] Transfer one low-value position or role and verify it.
- [ ] Transfer production custody only after every prior gate passes.
- [ ] Publish final addresses, parameters, role inventory, and monitoring links.

## Open decisions

1. What exact Robinhood Uniswap v4 periphery deployment and custody model will be used?
2. Which NTT roles should remain with an emergency multisig rather than the delayed executor?

## Deferred considerations

- A forced rotation mechanism for an actively malicious Technical Committee Safe. The protected
  recovery-action veto prevents a malicious TC from taking over through its 30-day action lane, but
  it can still censor an ordinary OpenGov action that attempts to replace the Safe.

## References

- [Wormhole Core Contracts guide](https://wormhole.com/docs/products/messaging/guides/core-contracts/)
  — `publishMessage` interface and chain-dependent payload constraints.
