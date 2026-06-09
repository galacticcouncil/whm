// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IBasejumpLandingNative {
    // ─── Events ──────────────────────────────────────────────────

    event TransferExecuted(
        address indexed sourceAsset, address indexed destAsset, bytes32 indexed recipient, uint256 amount
    );
    event TransferQueued(
        uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount
    );
    event PendingTransferFulfilled(
        uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount
    );
    event Withdrawn(address indexed asset, uint256 amount, address indexed to);
    event DestAssetUpdated(address indexed sourceAsset, address indexed destAsset);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotAuthorizedBridge();
    error InsufficientBalance();
    error NoPendingTransfers();
    error ReceiverNotContract(address recipient);
    error AssetNotConfigured(address sourceAsset);
    error NativeTransferFailed();

    // ─── Core ────────────────────────────────────────────────────

    /// @notice Deliver `amount` to `recipient`, paying out the asset that `sourceAsset` maps to via
    ///         `destAssetFor` on this chain — an ERC20, or the chain's native currency when the
    ///         mapping resolves to `NATIVE`. The authorized bridge passes the *source-chain* asset
    ///         address; this landing owns the source→dest mapping (the source contract cannot know
    ///         the destination address). Reverts `AssetNotConfigured` if no mapping is set.
    ///         If the pool has insufficient balance the transfer is queued and can be fulfilled
    ///         later by anyone via `fulfillPending`.
    ///         If `data.length > 0`, the recipient MUST be a contract implementing IBasejumpReceiver;
    ///         `onBasejumpReceive(destAsset, amount, data)` fires after delivery in the same
    ///         transaction (immediate or queue-drain), with the resolved destination asset.
    function transfer(address sourceAsset, uint256 amount, bytes32 recipient, bytes memory data) external;

    /// @notice Fulfill the next queued transfer FIFO once liquidity is available.
    function fulfillPending() external;

    // ─── Views ───────────────────────────────────────────────────

    function NATIVE() external view returns (address);
    function owner() external view returns (address);
    function authorizedBridges(address bridge) external view returns (bool);
    function destAssetFor(address sourceAsset) external view returns (address);
    function pendingHead() external view returns (uint256);
    function pendingTail() external view returns (uint256);
    function pendingTransfers(uint256 id)
        external
        view
        returns (address sourceAsset, uint256 amount, bytes32 recipient, bytes memory data);

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;
    function setAuthorizedBridge(address bridge, bool enabled) external;
    function setDestAsset(address sourceAsset, address destAsset) external;
    function setDestNative(address sourceAsset) external;
    function isNative(address sourceAsset) external view returns (bool);
    function withdraw(address asset, uint256 amount, address to) external;
}
