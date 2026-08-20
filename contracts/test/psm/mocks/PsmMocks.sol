// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockWormhole} from "../../mocks/MockWormhole.sol";

/// @notice ERC20 with a settable decimals, enough allowance machinery for SafeERC20.
contract MockToken {
    string public name;
    uint8 public decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    constructor(string memory _name, uint8 _decimals) {
        name = _name;
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) public virtual {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice HOLLAR's facilitator arithmetic, which is the module's solvency model.
/// @dev `burn` subtracts from the bucket level with no floor, so a facilitator underflow-reverts
///      the moment it tries to burn more than it minted. That is deliberate, not a mock shortcut.
contract MockGho is MockToken {
    struct Bucket {
        uint256 capacity;
        uint256 level;
    }

    mapping(address => Bucket) internal buckets;

    constructor() MockToken("HOLLAR", 18) {}

    function addFacilitator(address facilitator, uint256 capacity) external {
        buckets[facilitator].capacity = capacity;
    }

    function setFacilitatorBucketCapacity(address facilitator, uint256 capacity) external {
        buckets[facilitator].capacity = capacity;
    }

    function getFacilitatorBucket(address facilitator) external view returns (uint256, uint256) {
        return (buckets[facilitator].capacity, buckets[facilitator].level);
    }

    function mint(address account, uint256 amount) public override {
        Bucket storage bucket = buckets[msg.sender];
        require(bucket.level + amount <= bucket.capacity, "FACILITATOR_BUCKET_CAPACITY_EXCEEDED");
        bucket.level += amount;
        super.mint(account, amount);
    }

    /// @dev Supply this module's bucket does not stand behind — an HSM mint, or HOLLAR bought on
    ///      market. The point of the burn guard is that this cannot be redeemed through us.
    function mintFromElsewhere(address account, uint256 amount) external {
        balanceOf[account] += amount;
        totalSupply += amount;
    }

    function burn(uint256 amount) external {
        // No floor and no require — 0.8 underflow is the guard.
        buckets[msg.sender].level -= amount;
        _move(msg.sender, address(0), amount);
        totalSupply -= amount;
    }
}

/// @notice aToken that actually custodies the underlying, so `usdc.balanceOf(aUsdc)` is the
///         reserve's real withdrawable liquidity the way it is on Aave.
contract MockAToken is MockToken {
    constructor() MockToken("aUSDC", 6) {}

    function burnFrom(address from, uint256 amount) external {
        balanceOf[from] -= amount;
        totalSupply -= amount;
    }

    /// @dev Move the underlying this aToken custodies. Only the pool drives it.
    function release(address token, address to, uint256 amount) external {
        MockToken(token).transfer(to, amount);
    }
}

contract MockAavePool {
    MockToken public immutable underlying;
    MockAToken public immutable aToken;

    /// @dev Set to make Aave refuse, the way a paused or fully-borrowed reserve would.
    bool public supplyReverts;
    bool public withdrawReverts;

    constructor(MockToken _underlying, MockAToken _aToken) {
        underlying = _underlying;
        aToken = _aToken;
    }

    function setSupplyReverts(bool value) external {
        supplyReverts = value;
    }

    function setWithdrawReverts(bool value) external {
        withdrawReverts = value;
    }

    function supply(address, uint256 amount, address onBehalfOf, uint16) external {
        require(!supplyReverts, "SUPPLY_PAUSED");
        underlying.transferFrom(msg.sender, address(aToken), amount);
        aToken.mint(onBehalfOf, amount);
    }

    function withdraw(address, uint256 amount, address to) external returns (uint256) {
        require(!withdrawReverts, "WITHDRAW_PAUSED");
        require(_virtual() >= amount, "NOT_ENOUGH_AVAILABLE");
        aToken.burnFrom(msg.sender, amount);
        aToken.release(address(underlying), to, amount);
        return amount;
    }

    /// @dev Donations to the aToken that Aave never credits. Real v3.3 tracks this as the gap
    ///      between the aToken's balance and `virtualUnderlyingBalance`; the mock takes it as a
    ///      dial so a test can reproduce that gap without a fork.
    uint256 public donated;

    function donate(uint256 amount) external {
        underlying.mint(address(aToken), amount);
        donated += amount;
    }

    /// @dev Borrowers taking liquidity out: lowers both the held balance and the virtual one.
    function drainForBorrow(uint256 amount) external {
        aToken.release(address(underlying), msg.sender, amount);
    }

    function getVirtualUnderlyingBalance(address) external view returns (uint128) {
        return uint128(_virtual());
    }

    function _virtual() internal view returns (uint256) {
        uint256 held = underlying.balanceOf(address(aToken));
        return held > donated ? held - donated : 0;
    }
}

contract MockAggregator {
    int256 public answer;
    uint256 public updatedAt;

    constructor(int256 _answer) {
        answer = _answer;
        updatedAt = block.timestamp;
    }

    function set(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (0, answer, 0, updatedAt, 0);
    }
}

/// @dev Mirrors Base: the oracle serves a price, and the source it names is a capped adapter
///      that reverts on latestRoundData. Price and timestamp therefore come from different places,
///      which is the whole point of the vault's split oracle config.
contract MockAaveOracle {
    address public source;
    MockAggregator internal feed;

    constructor(address _source, MockAggregator _feed) {
        source = _source;
        feed = _feed;
    }

    function getAssetPrice(address) external view returns (uint256) {
        int256 answer = feed.answer();
        return answer <= 0 ? 0 : uint256(answer);
    }

    function getSourceOfAsset(address) external view returns (address) {
        return source;
    }
}

/// @dev The Base capped adapter: a price, no round data. Any staleness check pointed at this
///      reverts, which is exactly the production failure this models.
contract MockCappedAdapter {
    MockAggregator internal feed;

    constructor(MockAggregator _feed) {
        feed = _feed;
    }

    function latestAnswer() external view returns (int256) {
        return feed.answer();
    }

    function latestRoundData() external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert("unknown selector");
    }
}

contract MockAddressesProvider {
    address public pool;
    address public oracle;

    constructor(address _pool, address _oracle) {
        pool = _pool;
        oracle = _oracle;
    }

    function getPool() external view returns (address) {
        return pool;
    }

    function getPriceOracle() external view returns (address) {
        return oracle;
    }
}

/// @notice Wormhole core: verifies with the shared test mixin, records what was published.
contract MockWormholeCore is MockWormhole {
    struct Published {
        uint32 nonce;
        bytes payload;
        uint8 consistencyLevel;
        uint256 value;
    }

    Published[] public published;
    uint256 public messageFee;
    uint16 public chainId;
    uint64 internal sequence;

    constructor(uint16 _chainId, uint256 _messageFee) {
        chainId = _chainId;
        messageFee = _messageFee;
    }

    function setMessageFee(uint256 fee) external {
        messageFee = fee;
    }

    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistencyLevel)
        external
        payable
        returns (uint64)
    {
        published.push(Published(nonce, payload, consistencyLevel, msg.value));
        return sequence++;
    }

    function publishedCount() external view returns (uint256) {
        return published.length;
    }

    function lastPublished() external view returns (Published memory) {
        return published[published.length - 1];
    }
}

/// @notice Builds the VAA bytes the shared mixin decodes.
library VaaBuilder {
    function build(uint16 emitterChainId, bytes32 emitter, bytes memory payload) internal pure returns (bytes memory) {
        return abi.encode(emitterChainId, emitter, payload);
    }

    /// @dev The salt stands in for the Wormhole sequence, so two messages carrying the same payload
    ///      do not hash alike and look like a replay of one another.
    function buildSalted(uint16 emitterChainId, bytes32 emitter, bytes memory payload, uint256 salt)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(emitterChainId, emitter, payload, salt);
    }
}
