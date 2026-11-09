// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {OBMarket} from "../src/OBMarket.sol";
import {OBMarketFactory} from "../src/OBMarketFactory.sol";
import {LiquidityLocker, LiquidityLockerFactory, IPositionManagerLite, IPermit2Lite} from "../src/LiquidityLocker.sol";

interface IERC721Owner {
    function ownerOf(uint256 id) external view returns (address);
}

/// The liquidity locker on a Robinhood Chain fork, against the deployed order book factory, Uniswap's PositionManager
/// and Permit2, and the real USDG: create a market, seed both pools in a band around their opening prices through the
/// locker, check nobody can take the positions out while trading is open, then release them once trading has ended.
/// Skipped unless ROBINHOOD_RPC_URL is set.
contract LiquidityLockerForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address constant POSM = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    OBMarketFactory constant FACTORY = OBMarketFactory(0x06703aE0f85Ad14846CB5EeBCeBFc85b1cebB6F7);

    address creator = makeAddr("creator");
    address stranger = makeAddr("stranger");

    function test_fork_seedLockRelease() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);

        LiquidityLocker locker = new LiquidityLockerFactory().create(
            IPositionManagerLite(POSM), IPermit2Lite(PERMIT2), FACTORY
        );
        assertEq(address(locker.usdg()), address(USDG));

        deal(address(USDG), creator, 200e6);
        vm.startPrank(creator);
        USDG.approve(address(FACTORY), type(uint256).max);
        uint256 id = FACTORY.createMarket(_params());
        OBMarket market = FACTORY.getMarket(id).market;
        PoolKey[] memory keys = FACTORY.getPools(id);

        // 100 USDG: 60 sets, up to 40 USDG into the pools, each position ±2,000 ticks around its opening price.
        uint256 sets = 60e6;
        uint256 poolUsdg = 40e6;
        LiquidityLocker.Position[] memory ps = new LiquidityLocker.Position[](keys.length);
        for (uint256 i; i < keys.length; i++) {
            ps[i] = _position(keys[i], uint8(i), sets * 99 / 100, poolUsdg / keys.length);
        }
        USDG.approve(address(locker), sets + poolUsdg);
        uint256 before = USDG.balanceOf(creator);
        uint256 first = locker.seed(id, sets, poolUsdg, ps);
        vm.stopPrank();

        // Positions belong to the locker; the pools have liquidity; leftovers came back.
        for (uint256 i; i < keys.length; i++) {
            assertEq(IERC721Owner(POSM).ownerOf(first + i), address(locker));
            assertGt(PM.getLiquidity(keys[i].toId()), 0);
        }
        uint256 net = locker.lockedUsdg(id, creator);
        assertEq(net, before - USDG.balanceOf(creator));
        assertGt(net, 95e6);
        assertEq(locker.totalLockedUsdg(id), net);
        assertEq(USDG.balanceOf(address(locker)), 0);
        assertEq(locker.lockedPositions(id, creator).length, keys.length);

        // Locked while trading: neither the creator nor anyone else can take them out.
        vm.expectRevert(LiquidityLocker.TradingStillOpen.selector);
        vm.prank(creator);
        locker.release(id, creator);
        vm.prank(creator);
        vm.expectRevert();
        IPositionManagerLite(POSM).transferFrom(address(locker), creator, first);

        // A market that isn't trading can't be seeded.
        vm.warp(market.endOfTrading());
        assertFalse(market.tradingOpen());
        vm.prank(creator);
        vm.expectRevert(LiquidityLocker.TradingNotOpen.selector);
        locker.seed(id, sets, poolUsdg, ps);

        // Trading over: anyone can release, and the NFTs go to the creator only.
        vm.prank(stranger);
        locker.release(id, creator);
        for (uint256 i; i < keys.length; i++) {
            assertEq(IERC721Owner(POSM).ownerOf(first + i), creator);
        }
        assertEq(locker.lockedUsdg(id, creator), 0);
        assertEq(locker.totalLockedUsdg(id), 0);
        vm.expectRevert(LiquidityLocker.NothingLocked.selector);
        locker.release(id, creator);
    }

    function _params() internal view returns (OBMarketFactory.CreateParams memory p) {
        string[] memory names = new string[](2);
        names[0] = "YES";
        names[1] = "NO";
        uint16[] memory opening = new uint16[](2);
        opening[0] = 6_000;
        opening[1] = 4_000;
        p = OBMarketFactory.CreateParams({
            setupHash: keccak256("locker fork"),
            question: "Locker fork test",
            rules: "YES if the test says so, otherwise NO.",
            outcomeNames: names,
            openingBps: opening,
            endOfTrading: uint64(block.timestamp + 1 days),
            creatorFeeBps: 100
        });
    }

    /// A position of up to `tokens` outcome tokens and `usdgMax` USDG in a ±2,000-tick band around the pool's price.
    function _position(PoolKey memory key, uint8 outcome, uint256 tokens, uint256 usdgMax)
        internal
        view
        returns (LiquidityLocker.Position memory p)
    {
        (uint160 sqrtP, int24 tick,,) = PM.getSlot0(key.toId());
        int24 lower = ((tick - 2000) / 10) * 10;
        int24 upper = ((tick + 2000) / 10) * 10;
        bool usdgIs0 = Currency.unwrap(key.currency0) == address(USDG);
        (uint256 a0, uint256 a1) = usdgIs0 ? (usdgMax, tokens) : (tokens, usdgMax);
        uint160 sa = TickMath.getSqrtPriceAtTick(lower);
        uint160 sb = TickMath.getSqrtPriceAtTick(upper);
        uint256 l0 = FullMath.mulDiv(FullMath.mulDiv(a0, sqrtP, 1 << 96), sb, sb - sqrtP);
        uint256 l1 = FullMath.mulDiv(a1, 1 << 96, sqrtP - sa);
        p = LiquidityLocker.Position({
            outcome: outcome,
            tickLower: lower,
            tickUpper: upper,
            liquidity: l0 < l1 ? l0 : l1,
            amount0Max: uint128(a0),
            amount1Max: uint128(a1)
        });
    }
}
