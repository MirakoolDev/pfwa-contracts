// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {OBMarket} from "../src/OBMarket.sol";
import {OBMarketFactory} from "../src/OBMarketFactory.sol";
import {PFWAMarketHook, ITickMoveListener} from "../src/PFWAMarketHook.sol";
import {MarketResolver} from "../src/MarketResolver.sol";
import {FeeCollector, ISwapRouter02} from "../src/FeeCollector.sol";
import {MockRouter} from "./OrderBook.t.sol";
import {PFWALimitOrders} from "../src/PFWALimitOrders.sol";

/// The whole lifecycle on a Robinhood Chain fork: Uniswap's deployed PoolManager and the real USDG (Global Dollar).
/// Create a market with the factory's capped terms, seed both pools, trade through the real PoolManager, propose,
/// wait out the challenge window, finalize and redeem. Skipped unless ROBINHOOD_RPC_URL is set.
contract OrderBookForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    address arbiter = makeAddr("arbiter");
    address bot = makeAddr("resolver bot");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");

    function test_fork_fullLifecycleOnRobinhoodChain() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        assertEq(IERC20Meta(address(USDG)).decimals(), 6);

        MockERC20 pfwa = new MockERC20("PFWA", "PFWA", 18); // the buyback path isn't under test here
        PFWAMarketHook hook = _deployHook();
        FeeCollector collector = new FeeCollector(
            address(this), USDG, IERC20(address(pfwa)), ISwapRouter02(address(new MockRouter(MockERC20(address(USDG)), pfwa))),
            abi.encodePacked(address(USDG), uint24(3000), address(pfwa)), makeAddr("treasury")
        );
        MarketResolver resolver = new MarketResolver(USDG, arbiter, bot, address(collector));
        OBMarketFactory factory = new OBMarketFactory(address(this), PM, hook, resolver, USDG, 1e6);
        hook.setup(address(factory), address(collector), new PFWALimitOrders(PM, hook));
        resolver.setFactory(address(factory));
        factory.setDepositCap(50_000e6);

        deal(address(USDG), creator, 100_000e6);
        deal(address(USDG), alice, 1_000e6);
        deal(address(USDG), bot, 100e6);

        string[] memory names = new string[](2);
        names[0] = "YES";
        names[1] = "NO";
        uint16[] memory opening = new uint16[](2);
        opening[0] = 6_000;
        opening[1] = 4_000;
        vm.startPrank(creator);
        USDG.approve(address(factory), type(uint256).max);
        uint256 id = factory.createMarket(
            OBMarketFactory.CreateParams({
                setupHash: keccak256("fork"),
                question: "Fork test: will it rain?",
                rules: "YES if the test says so, otherwise NO.",
                outcomeNames: names,
                openingBps: opening,
                endOfTrading: uint64(block.timestamp + 1 days),
                creatorFeeBps: 100
            })
        );
        OBMarket market = factory.getMarket(id).market;
        assertEq(market.depositCap(), 50_000e6);
        PoolKey[] memory keys = factory.getPools(id);

        // seed both pools with 10,000 complete sets, across the bounds
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(PM);
        USDG.approve(address(market), type(uint256).max);
        market.mintSet(20_000e6, creator);
        for (uint256 i; i < 2; ++i) {
            IERC20(Currency.unwrap(keys[i].currency0)).approve(address(lp), type(uint256).max);
            IERC20(Currency.unwrap(keys[i].currency1)).approve(address(lp), type(uint256).max);
            bool usdg0 = Currency.unwrap(keys[i].currency0) == address(USDG);
            (int24 lower, int24 upper) = factory.priceBoundsInTicks(usdg0);
            lp.modifyLiquidity(
                keys[i],
                ModifyLiquidityParams({tickLower: ((lower / 10) + 1) * 10, tickUpper: (upper / 10) * 10, liquidityDelta: 2e9, salt: 0}),
                ""
            );
        }
        vm.stopPrank();
        assertEq(USDG.balanceOf(address(market)), market.outcomes(0).totalSupply(), "backed 1:1 on the real USDG");

        // alice buys YES with 50 USDG through the real PoolManager
        PoolSwapTest swapper = new PoolSwapTest(PM);
        bool yesUsdg0 = Currency.unwrap(keys[0].currency0) == address(USDG);
        IERC20 yes = IERC20(address(market.outcomes(0)));
        vm.startPrank(alice);
        USDG.approve(address(swapper), type(uint256).max);
        swapper.swap(
            keys[0],
            SwapParams({
                zeroForOne: yesUsdg0,
                amountSpecified: -int256(50e6),
                sqrtPriceLimitX96: yesUsdg0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        uint256 aliceYes = yes.balanceOf(alice);
        assertGt(aliceYes, 50e6, "YES bought below 1 USDG");
        assertEq(hook.creatorFeesOwed(creator), 0.5e6, "1% of the USDG in to the creator");
        assertEq(hook.protocolFeesOwed(), 0.5e6, "1% to the protocol");
        assertEq(USDG.balanceOf(address(hook)), 1e6);

        // resolve: the creator posts YES after the deadline, nobody disputes, the 2-hour window passes
        vm.warp(block.timestamp + 1 days);
        vm.prank(creator);
        resolver.resolveMarket(id, 0);
        assertFalse(market.tradingOpen());
        vm.warp(block.timestamp + 2 hours);
        resolver.finalize(id);
        assertTrue(market.resolved());

        uint256 before = USDG.balanceOf(alice);
        vm.prank(alice);
        market.redeem(0, aliceYes, alice);
        assertEq(USDG.balanceOf(alice) - before, aliceYes, "1 USDG per winning token");
        hook.sweepProtocolFees();
        assertEq(USDG.balanceOf(address(collector)), 1e6 + 0.5e6, "creation fee and the protocol's swap fee");
    }

    function _deployHook() internal returns (PFWAMarketHook h) {
        bytes memory code = abi.encodePacked(type(PFWAMarketHook).creationCode, abi.encode(address(PM), address(USDG), address(this)));
        bytes32 codeHash = keccak256(code);
        for (uint256 salt; salt < 400_000; salt++) {
            address predicted = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), codeHash))))
            );
            if (uint160(predicted) & Hooks.ALL_HOOK_MASK == FLAGS && predicted.code.length == 0) {
                h = new PFWAMarketHook{salt: bytes32(salt)}(PM, USDG, address(this));
                return h;
            }
        }
        revert("no salt");
    }
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
}
