// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {OBMarket} from "./OBMarket.sol";

/// Limit-order manager the hook reports price moves to (optional).
interface ITickMoveListener {
    function movePoolTick(PoolKey calldata poolKey, int24 fromTick, int24 toTick, uint160 sqrtPriceX96) external;
}

/// @title PFWAMarketHook
/// @notice The single Uniswap v4 hook for every order book market pool (OUTCOME_i / USDG).
/// - Only the factory can create pools on it.
/// - Swaps are allowed only while the market is open (before its end of trading, and not resolved).
/// - Swaps must be exact-input. The fee is always taken on the USDG leg: from the USDG paid in on a buy,
///   or from the USDG paid out on a sell. It's split between the market's creator and the protocol, and
///   held here until claimed, so a frozen recipient address can never block trading.
/// - After each swap the price must sit inside the pool's bounds (0.001–0.999 USDG per outcome).
/// - Each price move is reported to the limit-order manager, if one is set.
/// No admin can change a live market's fees, bounds or rules.
contract PFWAMarketHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeERC20 for IERC20;

    struct PoolConfig {
        OBMarket market;
        bool usdgIsCurrency0;
        int24 tickLower;
        int24 tickUpper;
        address creator;
        uint16 creatorFeeBps;
        uint16 protocolFeeBps;
        bool registered;
    }

    uint256 internal constant BPS = 10_000;
    /// Transient slot holding the tick before the current swap.
    bytes32 internal constant PREVIOUS_TICK_SLOT = keccak256("pfwa.hook.previousTick");

    IPoolManager public immutable poolManager;
    IERC20 public immutable usdg;
    address public immutable deployer;
    address public factory;
    address public feeCollector;
    ITickMoveListener public orderManager;

    mapping(PoolId => PoolConfig) public pools;
    /// USDG fees owed to each market creator, claimable any time.
    mapping(address => uint256) public creatorFeesOwed;
    /// USDG fees owed to the protocol, swept to the fee collector.
    uint256 public protocolFeesOwed;

    event FactorySet(address factory, address feeCollector, address orderManager);
    event PoolRegistered(PoolId indexed poolId, address indexed market, bool usdgIsCurrency0, int24 tickLower, int24 tickUpper);
    event FeeTaken(PoolId indexed poolId, address indexed creator, uint256 creatorFee, uint256 protocolFee);
    event CreatorFeesClaimed(address indexed creator, address indexed to, uint256 amount);
    event ProtocolFeesSwept(address indexed to, uint256 amount);

    error NotPoolManager();
    error NotFactory();
    error NotDeployer();
    error AlreadySet();
    error PoolNotRegistered();
    error PoolAlreadyRegistered();
    error TradingClosed();
    error ExactOutputNotSupported();
    error PriceOutOfBounds(int24 tick, int24 tickLower, int24 tickUpper);
    error HookNotImplemented();

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /// @param deployer_ The one account that may call `setup`. Passed in, not msg.sender: the hook is deployed at a
    /// mined CREATE2 address, so msg.sender is the CREATE2 deployer.
    constructor(IPoolManager poolManager_, IERC20 usdg_, address deployer_) {
        poolManager = poolManager_;
        usdg = usdg_;
        deployer = deployer_;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    /// One-time wiring by the deployer: the factory and hook depend on each other's address.
    function setup(address factory_, address feeCollector_, ITickMoveListener orderManager_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (factory != address(0)) revert AlreadySet();
        factory = factory_;
        feeCollector = feeCollector_;
        orderManager = orderManager_;
        emit FactorySet(factory_, feeCollector_, address(orderManager_));
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeSwap = true;
        p.afterSwap = true;
        p.beforeSwapReturnDelta = true;
        p.afterSwapReturnDelta = true;
    }

    /// @notice Called by the factory just before it initializes the pool.
    function registerPool(PoolKey calldata key, PoolConfig calldata config) external {
        if (msg.sender != factory) revert NotFactory();
        PoolId id = key.toId();
        if (pools[id].registered) revert PoolAlreadyRegistered();
        PoolConfig memory c = config;
        c.registered = true;
        pools[id] = c;
        emit PoolRegistered(id, address(config.market), config.usdgIsCurrency0, config.tickLower, config.tickUpper);
    }

    // ── Hook callbacks ──────────────────────────────────────────────────────────

    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view onlyPoolManager returns (bytes4) {
        if (sender != factory) revert NotFactory();
        if (!pools[key.toId()].registered) revert PoolNotRegistered();
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        PoolConfig storage c = pools[id];
        if (!c.registered) revert PoolNotRegistered();
        if (!c.market.tradingOpen()) revert TradingClosed();
        if (params.amountSpecified >= 0) revert ExactOutputNotSupported();

        (, int24 tick,,) = poolManager.getSlot0(id);
        bytes32 slot = PREVIOUS_TICK_SLOT;
        assembly {
            tstore(slot, tick)
        }

        // Buying the outcome with USDG: USDG is the input, so take the fee from it now.
        bool usdgIn = params.zeroForOne == c.usdgIsCurrency0;
        if (!usdgIn) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        uint256 fee = _takeFee(id, key, c, uint256(-params.amountSpecified));
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        PoolConfig storage c = pools[id];

        (uint160 sqrtPriceX96, int24 tick,,) = poolManager.getSlot0(id);
        if (tick < c.tickLower || tick > c.tickUpper) revert PriceOutOfBounds(tick, c.tickLower, c.tickUpper);

        if (address(orderManager) != address(0)) {
            int24 fromTick;
            bytes32 slot = PREVIOUS_TICK_SLOT;
            assembly {
                fromTick := tload(slot)
            }
            orderManager.movePoolTick(key, fromTick, tick, sqrtPriceX96);
        }

        // Selling the outcome for USDG: USDG is the output, so take the fee from what's paid out.
        bool usdgIn = params.zeroForOne == c.usdgIsCurrency0;
        if (usdgIn) return (IHooks.afterSwap.selector, 0);
        int128 usdgOut = c.usdgIsCurrency0 ? delta.amount0() : delta.amount1();
        if (usdgOut <= 0) return (IHooks.afterSwap.selector, 0);
        uint256 fee = _takeFee(id, key, c, uint256(int256(usdgOut)));
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    function _takeFee(PoolId id, PoolKey calldata key, PoolConfig storage c, uint256 usdgAmount) internal returns (uint256 fee) {
        Currency usdgCur = c.usdgIsCurrency0 ? key.currency0 : key.currency1;
        uint256 creatorFee = (usdgAmount * c.creatorFeeBps) / BPS;
        uint256 protocolFee = (usdgAmount * c.protocolFeeBps) / BPS;
        fee = creatorFee + protocolFee;
        if (fee == 0) return 0;
        poolManager.take(usdgCur, address(this), fee);
        creatorFeesOwed[c.creator] += creatorFee;
        protocolFeesOwed += protocolFee;
        emit FeeTaken(id, c.creator, creatorFee, protocolFee);
    }

    // ── Fee claims ──────────────────────────────────────────────────────────────

    /// @notice A creator withdraws the USDG fees their markets have earned.
    function claimCreatorFees(address to) external returns (uint256 amount) {
        amount = creatorFeesOwed[msg.sender];
        creatorFeesOwed[msg.sender] = 0;
        if (amount > 0) usdg.safeTransfer(to, amount);
        emit CreatorFeesClaimed(msg.sender, to, amount);
    }

    /// @notice Anyone can send the protocol's fees to the fee collector.
    function sweepProtocolFees() external returns (uint256 amount) {
        amount = protocolFeesOwed;
        protocolFeesOwed = 0;
        if (amount > 0) usdg.safeTransfer(feeCollector, amount);
        emit ProtocolFeesSwept(feeCollector, amount);
    }

    // ── Unused callbacks ────────────────────────────────────────────────────────

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
