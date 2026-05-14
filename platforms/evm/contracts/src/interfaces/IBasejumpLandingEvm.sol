// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IBasejumpLandingEvm {
    // ─── Events ──────────────────────────────────────────────────

    event TransferExecuted(address indexed asset, address indexed recipient, uint256 amount);
    event TransferQueued(uint256 indexed id, address indexed asset, address indexed recipient, uint256 amount);
    event PendingTransferFulfilled(
        uint256 indexed id, address indexed asset, address indexed recipient, uint256 amount
    );
    event Withdrawn(address indexed asset, uint256 amount, address indexed to);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotAuthorizedBridge();
    error InsufficientBalance();
    error NoPendingTransfers();
    error ReceiverNotContract(address recipient);

    // ─── Core ────────────────────────────────────────────────────

    /// @notice Deliver `amount` of `asset` to `recipient`. `asset` is the on-chain ERC20
    ///         to pay out from this pool — the authorized bridge is responsible for
    ///         encoding the correct destination-chain address in the fast-path payload.
    ///         If the pool has insufficient balance the transfer is queued and can be
    ///         fulfilled later by anyone via `fulfillPending`.
    ///         If `data.length > 0`, the recipient MUST be a contract implementing
    ///         IBasejumpReceiver. The callback fires after token delivery in the same
    ///         transaction the delivery occurs in (immediate or queue-drain).
    function transfer(address asset, uint256 amount, bytes32 recipient, bytes memory data) external;

    /// @notice Fulfill the next queued transfer FIFO once liquidity is available.
    function fulfillPending() external;

    // ─── Views ───────────────────────────────────────────────────

    function owner() external view returns (address);
    function authorizedBridges(address bridge) external view returns (bool);
    function pendingHead() external view returns (uint256);
    function pendingTail() external view returns (uint256);
    function pendingTransfers(uint256 id)
        external
        view
        returns (address asset, uint256 amount, bytes32 recipient, bytes memory data);

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;
    function setAuthorizedBridge(address bridge, bool enabled) external;
    function withdraw(address asset, uint256 amount, address to) external;
}
