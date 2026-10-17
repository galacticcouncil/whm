// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IZecUtxoEmitter — Hydration entry point for ZEC → a Zcash address
/// @notice One user operation: `send` takes ZEC on Hydration, keeps a small fee, and settles the rest
///         over the ZEC NTT route to the NEAR account `nearAccount`, which is derived from
///         `zcashAddress` by `withdraw-zec.hydration-whm.near` (NEAR MPC). On NEAR, that contract signs
///         the withdrawal from the account to the address through Omni's Zcash connector.
///
///         The NTT message carries only `sha256(nearAccount)`. `WithdrawRequested` is how the bot
///         learns the address, from chain alone; it is a hint the bot re-derives and checks, never
///         trusted. Design: docs/near-utxo/withdraw.md.
///
/// @dev The fee is kept here as ZEC. The owner (Hydration governance) swaps it into NEAR for the bot's
///      gas — sold through the router, then sent over the NEAR NTT route to the account it names.
interface IZecUtxoEmitter {
    // ─── Events ──────────────────────────────────────────────────

    /// @param sequence The ZEC NTT manager's sequence — the id the transfer's VAA carries
    /// @param nearAccount The derived NEAR account (its Ed25519 key; the account id is its hex)
    /// @param sender Who sent
    /// @param amount ZEC settled to NEAR, net of `fee`
    /// @param fee ZEC kept for the bot's gas
    /// @param destination The destination address — here the 22-byte `zcashAddress`. `bytes`, so
    ///        every coin's emitter logs the same event; only for indexing, never what pays out
    event WithdrawRequested(
        uint64 indexed sequence,
        bytes32 indexed nearAccount,
        address indexed sender,
        uint256 amount,
        uint256 fee,
        bytes destination
    );

    /// @param sequence The NEAR NTT manager's sequence — the id the transfer's VAA carries
    /// @param zecIn Fee ZEC sold
    /// @param nearOut NEAR sent, quantized to the rail's precision
    /// @param account The NEAR account it was sent to
    event Refueled(uint64 indexed sequence, uint256 zecIn, uint256 nearOut, string account);

    event FeeSet(uint256 fee);
    event Swept(address indexed asset, address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotConfigured();
    error ZeroAmount();
    error DispatchFailed();
    error InvalidZcashAddress();
    error InvalidNearAccount();

    /// @dev What is left after the fee is below the Zcash connector's minimum withdrawal.
    error AmountBelowMinimum(uint256 amount, uint256 minimum);
    /// @dev The swap produced less than one unit of the NEAR rail's precision.
    error AmountBelowTrimUnit(uint256 nearOut, uint256 trimUnit);

    // ─── Core ────────────────────────────────────────────────────

    /// @notice Send `amount` ZEC toward `zcashAddress`: keep `fee`, settle the rest to `nearAccount`
    ///         on NEAR over NTT.
    /// @param zcashAddress Decoded transparent address — `0x1cb8` (t1) or `0x1cbd` (t3) and the
    ///        20-byte hash. No checksum to get wrong: any value with a valid prefix is payable.
    /// @param nearAccount The account `withdraw-zec.hydration-whm.near` derives for `zcashAddress`.
    ///        Not checked here — EVM cannot run the derivation; the bot rejects a mismatch, and a
    ///        mismatch pays the account named.
    /// @dev Not payable: the rail's delivery price (0 today) is paid from this contract's balance.
    /// @return sequence The ZEC NTT manager's sequence
    function send(uint256 amount, bytes22 zcashAddress, bytes32 nearAccount) external returns (uint64 sequence);

    /// @notice Owner: sell `zecIn` of the held fee ZEC for NEAR and send it to `account` on NEAR.
    /// @param zecIn Fee ZEC to sell — exact, so `minNearOut` always belongs to the amount it was set for.
    /// @param minNearOut Router floor on the NEAR the sale produces.
    /// @param account NEAR account id that receives it — the bot's gas account, named per call.
    /// @dev The NEAR rail's delivery price (0 today) is paid from this contract's balance.
    /// @return sequence The NEAR NTT manager's sequence
    function refuel(uint256 zecIn, uint256 minNearOut, string calldata account) external returns (uint64 sequence);

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;

    function owner() external view returns (address);
}
