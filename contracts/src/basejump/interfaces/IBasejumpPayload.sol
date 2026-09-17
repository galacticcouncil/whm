// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IBasejumpPayload — the fast-path wire format
/// @notice The only thing the two ends of a corridor share: the emitter encodes it, the receiver
///         decodes it. Neither contract inherits the other's logic.
interface IBasejumpPayload {
    /// @param sourceAsset Asset pulled on the source chain. The landing resolves it to its local form.
    /// @param amount NET amount owed to the recipient — gross minus the source's `assetFee`. The
    ///        settlement leg delivers the gross to the pool, so the difference accrues there.
    /// @param recipient Destination account; an AccountId32 on Hydration.
    /// @param transferSequence The NTT manager's message sequence for the settlement leg that
    ///        replenishes this payout — the correlation key between the two rails.
    /// @param data Opaque bytes forwarded end-to-end to the destination, untouched by both ends.
    ///        Empty for a plain transfer. Non-empty carries instructions for a `recipient` that is
    ///        a contract — an inbound intent from an L1/L2 that must trigger Hydration-side action
    ///        once the funds land, rather than just crediting an account. The delivery hook that
    ///        consumes it is a landing concern: the deployed `BasejumpLanding` takes `data` in its
    ///        signature but discards it, so an inbound-intent corridor needs that upgraded before
    ///        anything here reaches a callback.
    struct TransferPayload {
        address sourceAsset;
        uint256 amount;
        bytes32 recipient;
        uint64 transferSequence;
        bytes data;
    }
}
