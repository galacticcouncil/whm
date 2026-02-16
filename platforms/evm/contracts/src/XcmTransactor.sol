// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ScaleCodec} from "./utils/ScaleCodec.sol";
import {DerivedAccount} from "./utils/DerivedAccount.sol";

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

/// @notice Moonbeam XcmTransactorV3 precompile at 0x817
interface IXcmTransactorV3 {
    function transactThroughSigned(
        Multilocation memory dest,
        address feeLocationAddress,
        Weight memory transactRequiredWeightAtMost,
        bytes memory call,
        uint256 feeAmount,
        Weight memory overallWeight,
        bool refund
    ) external;
}

/// @title XcmTransactor - Dispatch EVM calls on Hydration via Moonbeam XCM
/// @notice Only whitelisted addresses (e.g. MessageDispatcher) can call transact
contract XcmTransactor is Initializable, UUPSUpgradeable {
    IXcmTransactorV3 public constant XCM_PRECOMPILE = IXcmTransactorV3(0x0000000000000000000000000000000000000817);

    address public owner;
    mapping(address => bool) public authorized;
    mapping(address => bool) public authorizedDispatchers;

    // --- Runtime config (immutable across upgrades) ---
    uint32 public immutable DESTINATION_PARA_ID;
    uint32 public immutable SOURCE_PARA_ID;
    uint8 public immutable EVM_PALLET_INDEX;
    uint8 public immutable EVM_CALL_INDEX;
    address public immutable FEE_LOCATION_ADDRESS;

    // --- XCM source (derived H160 on Hydration) ---
    address public xcmSource;

    // --- XCM defaults (tunable by authorized callers) ---
    uint64 public xcmGasLimit;
    uint256 public xcmMaxFeePerGas;
    uint64 public xcmTransactWeight;
    uint64 public xcmTransactProofSize;
    uint256 public xcmFeeAmount;

    event XcmDispatched(address indexed target, bytes input);

    error NotOwner();
    error NotAuthorized();
    error NotAuthorizedDispatcher();
    error InvalidFeeLocationAddress();

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier onlyAuthorized() {
        _onlyAuthorized();
        _;
    }

    modifier onlyAuthorizedDispacher() {
        _onlyAuthorizedDispatcher();
        _;
    }

    constructor(
        uint32 _destinationParaId,
        uint32 _sourceParaId,
        uint8 _evmPalletIndex,
        uint8 _evmCallIndex,
        address _feeLocationAddress
    ) {
        _disableInitializers();
        DESTINATION_PARA_ID = _destinationParaId;
        SOURCE_PARA_ID = _sourceParaId;
        EVM_PALLET_INDEX = _evmPalletIndex;
        EVM_CALL_INDEX = _evmCallIndex;

        if (_feeLocationAddress == address(0)) revert InvalidFeeLocationAddress();
        FEE_LOCATION_ADDRESS = _feeLocationAddress;
    }

    function initialize() public initializer {
        owner = msg.sender;
        xcmSource = DerivedAccount.deriveSibling(SOURCE_PARA_ID, address(this));
        xcmGasLimit = 200_000;
        xcmMaxFeePerGas = 10_000_000;
        xcmTransactWeight = 6_000_000_000;
        xcmTransactProofSize = 60_000;
        xcmFeeAmount = 5_000_000_000_000;
    }

    // ─── Transact ──────────────────────────────────────────────

    /// @notice Dispatch an EVM call on Hydration via XCM
    /// @param target  Contract address on Hydration
    /// @param input   EVM calldata
    function transact(address target, bytes calldata input) external onlyAuthorizedDispacher {
        bytes memory encoded = _encodeEvmCall(target, input);
        _xcmSend(encoded);
        emit XcmDispatched(target, input);
    }

    /// @notice Debug: returns the SCALE-encoded evm.call bytes without sending
    function encodeEvmCall(address target, bytes calldata input) external view returns (bytes memory) {
        return _encodeEvmCall(target, input);
    }

    // ─── Internal ──────────────────────────────────────────────

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _onlyAuthorized() internal view {
        if (!authorized[msg.sender]) revert NotAuthorized();
    }

    function _onlyAuthorizedDispatcher() internal view {
        if (!authorized[msg.sender]) revert NotAuthorizedDispatcher();
    }

    function _encodeEvmCall(address target, bytes calldata input) internal view returns (bytes memory) {
        return abi.encodePacked(
            EVM_PALLET_INDEX,
            EVM_CALL_INDEX,
            bytes20(xcmSource),
            bytes20(target),
            ScaleCodec.encodeVecU8(input),
            ScaleCodec.u256Le(0),
            ScaleCodec.u64Le(xcmGasLimit),
            ScaleCodec.u256Le(xcmMaxFeePerGas),
            ScaleCodec.encodeNone(), // max_priority_fee_per_gas
            ScaleCodec.encodeNone(), // nonce
            uint8(0x00) // access_list: empty Vec
        );
    }

    function _xcmSend(bytes memory encodedCall) internal {
        Multilocation memory dest;
        dest.parents = 1;
        dest.interior = new bytes[](1);
        dest.interior[0] = abi.encodePacked(uint8(0x00), DESTINATION_PARA_ID);

        Weight memory transactRequiredWeightAtMost =
            Weight({refTime: xcmTransactWeight, proofSize: xcmTransactProofSize});
        Weight memory overallWeight = Weight({refTime: xcmTransactWeight * 2, proofSize: xcmTransactProofSize * 2});

        XCM_PRECOMPILE.transactThroughSigned(
            dest, FEE_LOCATION_ADDRESS, transactRequiredWeightAtMost, encodedCall, xcmFeeAmount, overallWeight, true
        );
    }

    // ─── Upgrade ────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override {
        _onlyOwner();
    }

    // ─── Admin ─────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function setAuthorized(address addr, bool enabled) external onlyOwner {
        authorized[addr] = enabled;
    }

    function setAuthorizedDispatcher(address addr, bool enabled) public onlyOwner {
        authorizedDispatchers[addr] = enabled;
    }

    function setXcmDefaults(
        uint64 gasLimit,
        uint256 maxFeePerGas,
        uint64 transactWeightRefTime,
        uint64 transactWeightProofSize,
        uint256 feeAmount
    ) external onlyAuthorized {
        xcmGasLimit = gasLimit;
        xcmMaxFeePerGas = maxFeePerGas;
        xcmTransactWeight = transactWeightRefTime;
        xcmTransactProofSize = transactWeightProofSize;
        xcmFeeAmount = feeAmount;
    }
}
