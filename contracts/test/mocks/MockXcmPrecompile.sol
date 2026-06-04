// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Moonbeam XCM Multilocation representation
struct Multilocation {
    uint8 parents;
    bytes[] interior;
}

/// @notice Moonbeam XCM Weight representation (Weights V2)
struct Weight {
    uint64 refTime;
    uint64 proofSize;
}

/// @notice Mock XcmTransactorV3 precompile for testing cross-chain dispatches
/// @dev Simulates Moonbeam's XcmTransactor precompile at 0x0817
contract MockXcmPrecompile {
    struct XcmCall {
        Multilocation dest;
        address feeLocationAddress;
        Weight transactRequiredWeightAtMost;
        bytes call;
        uint256 feeAmount;
        Weight overallWeight;
        bool refund;
    }

    XcmCall[] public xcmCalls;

    event XcmTransactCalled(
        uint8 parents,
        bytes32 parachain,
        address feeLocationAddress,
        uint256 feeAmount
    );

    /// @notice Mock implementation of transactThroughSigned
    /// @dev Records XCM call details for test verification
    function transactThroughSigned(
        Multilocation memory dest,
        address feeLocationAddress,
        Weight memory transactRequiredWeightAtMost,
        bytes memory call,
        uint256 feeAmount,
        Weight memory overallWeight,
        bool refund
    ) external {
        // Store the call for test assertions
        xcmCalls.push(
            XcmCall({
                dest: dest,
                feeLocationAddress: feeLocationAddress,
                transactRequiredWeightAtMost: transactRequiredWeightAtMost,
                call: call,
                feeAmount: feeAmount,
                overallWeight: overallWeight,
                refund: refund
            })
        );

        // Extract parachain ID for event (if present in interior)
        bytes32 parachainId = dest.interior.length > 0 ? bytes32(dest.interior[0]) : bytes32(0);

        emit XcmTransactCalled(dest.parents, parachainId, feeLocationAddress, feeAmount);
    }

    /// @notice Get the last XCM call made
    function getLastCall() external view returns (XcmCall memory) {
        require(xcmCalls.length > 0, "No XCM calls recorded");
        return xcmCalls[xcmCalls.length - 1];
    }

    /// @notice Get total number of XCM calls
    function callCount() external view returns (uint256) {
        return xcmCalls.length;
    }

    /// @notice Get a specific XCM call by index
    function getCall(uint256 index) external view returns (XcmCall memory) {
        require(index < xcmCalls.length, "Index out of bounds");
        return xcmCalls[index];
    }

    /// @notice Clear all recorded calls (useful for test cleanup)
    function reset() external {
        delete xcmCalls;
    }
}
