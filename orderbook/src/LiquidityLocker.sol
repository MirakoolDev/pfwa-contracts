// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {OBMarket} from "./OBMarket.sol";
import {OBMarketFactory} from "./OBMarketFactory.sol";

/// Uniswap v4 PositionManager, the parts the locker uses.
interface IPositionManagerLite {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;
    function nextTokenId() external view returns (uint256);
    function transferFrom(address from, address to, uint256 id) external;
}

/// Permit2's allowance transfer, the part the locker uses (PositionManager pulls tokens through Permit2).
interface IPermit2Lite {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title LiquidityLocker
/// @notice Seeds an order book market's outcome pools and locks the positions while the market trades.
///
/// One call: the seeder's USDG mints complete sets, then each chosen outcome pool gets a Uniswap v4 position of that
/// outcome's tokens plus USDG. The positions are minted to this contract, so nobody can take them out while the market
/// is trading, the seeder included. Once trading stops (the outcome is posted, or end of trading passes;
/// OBMarket.tradingOpen), release() hands the position NFTs back to the seeder, who withdraws them as usual.
///
/// Leftover USDG and outcome tokens from rounding go straight back to the seeder. The locker holds nothing else between
/// calls. Prices and amounts are the caller's: positions are only ever minted in the market's own pools, and
/// PositionManager's amount maxima bound what each one takes.
contract LiquidityLocker is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // PositionManager action codes (v4-periphery Actions.sol).
    uint8 internal constant MINT_POSITION = 0x02;
    uint8 internal constant SETTLE_PAIR = 0x0d;

    IPositionManagerLite public immutable positionManager;
    IPermit2Lite public immutable permit2;
    OBMarketFactory public immutable marketFactory;
    IERC20 public immutable usdg;

    struct Position {
        /// Index into the market's outcomes (OBMarketFactory.getPools order).
        uint8 outcome;
        int24 tickLower;
        int24 tickUpper;
        uint256 liquidity;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    /// Position NFTs locked per market and seeder.
    mapping(uint256 marketId => mapping(address seeder => uint256[] tokenIds)) internal _locked;
    /// USDG a seeder has put into a market's locked liquidity (sets plus pool USDG, less what came back).
    mapping(uint256 marketId => mapping(address seeder => uint256)) public lockedUsdg;
    /// All USDG locked in a market's liquidity, across seeders.
    mapping(uint256 marketId => uint256) public totalLockedUsdg;

    event Locked(uint256 indexed marketId, address indexed seeder, uint256 firstTokenId, uint256 positions, uint256 usdgIn);
    event Released(uint256 indexed marketId, address indexed seeder, uint256[] tokenIds);

    error TradingNotOpen();
    error TradingStillOpen();
    error NothingLocked();
    error NoPositions();
    error BadOutcome();
    error ZeroAmount();

    constructor(IPositionManagerLite positionManager_, IPermit2Lite permit2_, OBMarketFactory marketFactory_) {
        positionManager = positionManager_;
        permit2 = permit2_;
        marketFactory = marketFactory_;
        usdg = marketFactory_.usdg();
    }

    /// @notice Mints `sets` complete sets from the caller's USDG, adds `positions` to the market's pools with them
    /// and up to `poolUsdg` more USDG, and locks the positions until trading stops. Approve sets + poolUsdg USDG first.
    /// @return firstTokenId The first position NFT's id; the positions are firstTokenId … firstTokenId + n − 1.
    function seed(uint256 marketId, uint256 sets, uint256 poolUsdg, Position[] calldata positions)
        external
        nonReentrant
        returns (uint256 firstTokenId)
    {
        uint256 n = positions.length;
        if (n == 0) revert NoPositions();
        if (sets == 0) revert ZeroAmount();
        OBMarket market = marketFactory.getMarket(marketId).market;
        if (!market.tradingOpen()) revert TradingNotOpen();
        PoolKey[] memory keys = marketFactory.getPools(marketId);

        uint256 usdgIn = sets + poolUsdg;
        usdg.safeTransferFrom(msg.sender, address(this), usdgIn);
        usdg.forceApprove(address(market), sets);
        market.mintSet(sets, address(this));
        _allowPositionManager(address(usdg));

        bytes memory actions = new bytes(n * 2);
        bytes[] memory params = new bytes[](n * 2);
        for (uint256 i; i < n; i++) {
            Position calldata p = positions[i];
            if (p.outcome >= keys.length) revert BadOutcome();
            PoolKey memory key = keys[p.outcome];
            address token = Currency.unwrap(key.currency0) == address(usdg)
                ? Currency.unwrap(key.currency1)
                : Currency.unwrap(key.currency0);
            _allowPositionManager(token);
            actions[2 * i] = bytes1(MINT_POSITION);
            actions[2 * i + 1] = bytes1(SETTLE_PAIR);
            params[2 * i] = abi.encode(key, p.tickLower, p.tickUpper, p.liquidity, p.amount0Max, p.amount1Max, address(this), bytes(""));
            params[2 * i + 1] = abi.encode(key.currency0, key.currency1);
        }

        firstTokenId = positionManager.nextTokenId();
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);

        uint256[] storage mine = _locked[marketId][msg.sender];
        for (uint256 i; i < n; i++) {
            mine.push(firstTokenId + i);
        }

        // Rounding leftovers go back: USDG, and every outcome token (sets mint all of them, even unseeded ones).
        uint256 back = usdg.balanceOf(address(this));
        if (back > 0) usdg.safeTransfer(msg.sender, back);
        for (uint256 i; i < keys.length; i++) {
            address token = Currency.unwrap(keys[i].currency0) == address(usdg)
                ? Currency.unwrap(keys[i].currency1)
                : Currency.unwrap(keys[i].currency0);
            uint256 left = IERC20(token).balanceOf(address(this));
            if (left > 0) IERC20(token).safeTransfer(msg.sender, left);
        }

        uint256 net = usdgIn - back;
        lockedUsdg[marketId][msg.sender] += net;
        totalLockedUsdg[marketId] += net;
        emit Locked(marketId, msg.sender, firstTokenId, n, net);
    }

    /// @notice Once the market's trading has stopped, sends `seeder`'s locked position NFTs back to them. Anyone may
    /// call it; the NFTs only ever go to the seeder.
    function release(uint256 marketId, address seeder) external nonReentrant {
        OBMarket market = marketFactory.getMarket(marketId).market;
        if (market.tradingOpen()) revert TradingStillOpen();
        uint256[] memory ids = _locked[marketId][seeder];
        if (ids.length == 0) revert NothingLocked();
        delete _locked[marketId][seeder];
        totalLockedUsdg[marketId] -= lockedUsdg[marketId][seeder];
        lockedUsdg[marketId][seeder] = 0;
        for (uint256 i; i < ids.length; i++) {
            positionManager.transferFrom(address(this), seeder, ids[i]);
        }
        emit Released(marketId, seeder, ids);
    }

    /// @notice The position NFTs `seeder` has locked in a market.
    function lockedPositions(uint256 marketId, address seeder) external view returns (uint256[] memory) {
        return _locked[marketId][seeder];
    }

    function _allowPositionManager(address token) internal {
        if (IERC20(token).allowance(address(this), address(permit2)) < type(uint128).max) {
            IERC20(token).forceApprove(address(permit2), type(uint256).max);
        }
        permit2.approve(token, address(positionManager), type(uint160).max, type(uint48).max);
    }
}

/// @title LiquidityLockerFactory
/// @notice Deploys a LiquidityLocker for any order book market factory. Permissionless.
contract LiquidityLockerFactory {
    event LockerCreated(address indexed locker, address indexed marketFactory, address positionManager, address permit2);

    function create(IPositionManagerLite positionManager, IPermit2Lite permit2, OBMarketFactory marketFactory)
        external
        returns (LiquidityLocker locker)
    {
        locker = new LiquidityLocker(positionManager, permit2, marketFactory);
        emit LockerCreated(address(locker), address(marketFactory), address(positionManager), address(permit2));
    }
}
