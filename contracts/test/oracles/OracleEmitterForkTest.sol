// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {OracleEmitter} from "../../src/oracles/OracleEmitter.sol";

/// @dev Mainnet fork test. Verifies the calldata wired into the production
///      `registerFeed(...)` calls — the wstETH `stEthPerToken()` selector and
///      the apyUSD vault `convertToAssets(1e18)` shape — actually decode to an
///      18-decimal `uint256` on live state, and that the published payload
///      round-trips through `abi.decode`.
///
///      Run with: forge test --match-contract OracleEmitterForkTest
///      Requires the `mainnet` rpc endpoint in foundry.toml.
abstract contract WormholeRecorder {
    bytes public lastPayload;
    uint64 public nextSequence = 1;

    function messageFee() external pure returns (uint256) {
        return 0;
    }

    function publishMessage(uint32, bytes memory payload, uint8) external payable returns (uint64) {
        lastPayload = payload;
        uint64 seq = nextSequence;
        nextSequence = seq + 1;
        return seq;
    }
}

contract OracleEmitterForkTest is Test, WormholeRecorder {
    OracleEmitter public emitterContract;

    address constant WSTETH_TOKEN = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0;
    address constant APYUSD_VAULT = 0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A;

    bytes32 constant WSTETH = keccak256("WSTETH");
    bytes32 constant APYUSD = keccak256("APYUSD");

    uint8 constant ACTION_RATE_UPDATE = 2;

    function setUp() public {
        vm.createSelectFork("mainnet");

        OracleEmitter impl = new OracleEmitter();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(OracleEmitter.initialize, (address(this)))
        );
        emitterContract = OracleEmitter(address(proxy));
    }

    // ─── Selector sanity ─────────────────────────────────────────

    function testStEthPerTokenSelector() public pure {
        // The migration uses 0x035faf82; assert it matches the canonical signature.
        assertEq(bytes4(0x035faf82), bytes4(keccak256("stEthPerToken()")));
    }

    function testConvertToAssetsSelector() public pure {
        assertEq(bytes4(0x07a2d13a), bytes4(keccak256("convertToAssets(uint256)")));
    }

    // ─── wstETH ──────────────────────────────────────────────────

    function testSendRealWstETH() public {
        bytes memory call = abi.encodeWithSelector(bytes4(0x035faf82));
        emitterContract.registerFeed(WSTETH, WSTETH_TOKEN, call);

        uint64 ts = uint64(block.timestamp);
        uint64 seq = emitterContract.send(WSTETH);
        assertEq(seq, 1);

        bytes memory payload = lastPayload;
        assertEq(payload.length, 128);

        (uint8 action, bytes32 assetId, uint256 rate, uint64 decodedTs) =
            abi.decode(payload, (uint8, bytes32, uint256, uint64));

        assertEq(action, ACTION_RATE_UPDATE);
        assertEq(assetId, WSTETH);
        assertEq(decodedTs, ts);

        // wstETH rate is monotonically increasing from 1e18 since Lido genesis.
        // A sane lower bound (post-merge: > 1.15e18) and a generous upper bound
        // (no realistic path to > 3e18 within the next decade).
        assertGt(rate, 1.15e18);
        assertLt(rate, 3e18);
    }

    // ─── apyUSD ──────────────────────────────────────────────────

    function testSendRealApyUSD() public {
        bytes memory call = abi.encodeWithSignature("convertToAssets(uint256)", uint256(1e18));
        emitterContract.registerFeed(APYUSD, APYUSD_VAULT, call);

        uint64 ts = uint64(block.timestamp);
        uint64 seq = emitterContract.send(APYUSD);
        assertEq(seq, 1);

        bytes memory payload = lastPayload;
        assertEq(payload.length, 128);

        (uint8 action, bytes32 assetId, uint256 rate, uint64 decodedTs) =
            abi.decode(payload, (uint8, bytes32, uint256, uint64));

        assertEq(action, ACTION_RATE_UPDATE);
        assertEq(assetId, APYUSD);
        assertEq(decodedTs, ts);

        // apxUSD per apyUSD share — vault NAV. Starts ~1.0 and accrues.
        // Generous bounds: never below 0.95e18 (would imply loss), well below 5e18.
        assertGt(rate, 0.95e18);
        assertLt(rate, 5e18);
    }

    // ─── Both registered, independent sequence ───────────────────

    function testBothFeedsRegisteredAndSent() public {
        emitterContract.registerFeed(
            WSTETH,
            WSTETH_TOKEN,
            abi.encodeWithSelector(bytes4(0x035faf82))
        );
        emitterContract.registerFeed(
            APYUSD,
            APYUSD_VAULT,
            abi.encodeWithSignature("convertToAssets(uint256)", uint256(1e18))
        );

        uint64 s1 = emitterContract.send(WSTETH);
        uint64 s2 = emitterContract.send(APYUSD);

        assertEq(s1, 1);
        assertEq(s2, 2);
        assertEq(emitterContract.nonce(), 2);
    }
}
