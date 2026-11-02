// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
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

import {OBMarket} from "../src/OBMarket.sol";
import {OBMarketFactory} from "../src/OBMarketFactory.sol";
import {OutcomeToken} from "../src/OutcomeToken.sol";
import {PFWAMarketHook, ITickMoveListener} from "../src/PFWAMarketHook.sol";
import {MarketResolver} from "../src/MarketResolver.sol";
import {FeeCollector, ISwapRouter02} from "../src/FeeCollector.sol";
import {ForwarderFactory} from "../src/IntentForwarder.sol";
import {PFWALimitOrders} from "../src/PFWALimitOrders.sol";

/// Pays 1 PFWA per USDG, to stand in for the real V3 router.
contract MockRouter is ISwapRouter02 {
    MockERC20 public immutable usdg;
    MockERC20 public immutable pfwa;

    constructor(MockERC20 usdg_, MockERC20 pfwa_) {
        usdg = usdg_;
        pfwa = pfwa_;
    }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256) {
        usdg.transferFrom(msg.sender, address(this), p.amountIn);
        require(p.amountIn >= p.amountOutMinimum, "slippage");
        pfwa.mint(p.recipient, p.amountIn);
        return p.amountIn;
    }
}

contract OrderBookTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    PoolManager pm;
    MockERC20 usdg;
    MockERC20 pfwa;
    PFWAMarketHook hook;
    MarketResolver resolver;
    FeeCollector collector;
    OBMarketFactory factory;
    ForwarderFactory forwarder;
    PFWALimitOrders limits;
    PoolModifyLiquidityTest lpRouter;
    PoolSwapTest swapRouter;

    address arbiter = address(0xA11);
    address bot = address(0xB07);
    address creator = address(0xC0);
    address alice = address(0xA1);
    address bob = address(0xB0);
    address treasury = address(0x7EA);

    uint256 marketId;
    OBMarket market;
    PoolKey yesKey;
    PoolKey noKey;

    function setUp() public {
        pm = new PoolManager(address(this));
        usdg = new MockERC20("USDG", "USDG", 6);
        pfwa = new MockERC20("PFWA", "PFWA", 18);
        MockRouter router = new MockRouter(usdg, pfwa);

        hook = _deployHook();
        collector = new FeeCollector(
            address(this),
            IERC20(address(usdg)),
            IERC20(address(pfwa)),
            router,
            abi.encodePacked(address(usdg), uint24(3000), address(pfwa)),
            treasury
        );
        resolver = new MarketResolver(IERC20(address(usdg)), arbiter, bot, address(collector));
        factory = new OBMarketFactory(address(this), pm, hook, resolver, IERC20(address(usdg)), 1e6);
        limits = new PFWALimitOrders(pm, hook);
        hook.setup(address(factory), address(collector), limits);
        resolver.setFactory(address(factory));
        forwarder = new ForwarderFactory(pm, factory, IERC20(address(usdg)));
        lpRouter = new PoolModifyLiquidityTest(pm);
        swapRouter = new PoolSwapTest(pm);

        address[5] memory people = [creator, alice, bob, bot, address(this)];
        for (uint256 i; i < people.length; i++) {
            usdg.mint(people[i], 1_000_000e6);
            vm.prank(people[i]);
            usdg.approve(address(factory), type(uint256).max);
        }

        // Creator opens "Will it rain?" at YES 60% / NO 40%, then seeds both pools.
        uint16[] memory opening = new uint16[](2);
        opening[0] = 6_000;
        opening[1] = 4_000;
        string[] memory names = new string[](2);
        names[0] = "YES";
        names[1] = "NO";
        vm.prank(creator);
        marketId = factory.createMarket(
            OBMarketFactory.CreateParams({
                setupHash: keccak256("rain"),
                question: "Will it rain tomorrow?",
                outcomeNames: names,
                openingBps: opening,
                endOfTrading: uint64(block.timestamp + 1 days),
                creatorFeeBps: 100
            })
        );
        market = factory.getMarket(marketId).market;
        PoolKey[] memory keys = factory.getPools(marketId);
        yesKey = keys[0];
        noKey = keys[1];
        _seed(yesKey, 10_000e6);
        _seed(noKey, 10_000e6);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    function _deployHook() internal returns (PFWAMarketHook h) {
        bytes memory code = abi.encodePacked(type(PFWAMarketHook).creationCode, abi.encode(address(pm), address(usdg), address(this)));
        bytes32 codeHash = keccak256(code);
        for (uint256 salt; salt < 200_000; salt++) {
            address predicted = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), codeHash))))
            );
            if (uint160(predicted) & Hooks.ALL_HOOK_MASK == FLAGS) {
                h = new PFWAMarketHook{salt: bytes32(salt)}(pm, IERC20(address(usdg)), address(this));
                require(address(h) == predicted, "miner");
                return h;
            }
        }
        revert("no salt");
    }

    function _seed(PoolKey memory key, uint256 sets) internal {
        usdg.approve(address(market), sets);
        market.mintSet(sets, address(this));
        IERC20(Currency.unwrap(key.currency0)).approve(address(lpRouter), type(uint256).max);
        IERC20(Currency.unwrap(key.currency1)).approve(address(lpRouter), type(uint256).max);
        (int24 lo, int24 hi) = _range(key);
        lpRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: 2e9, salt: 0}), ""
        );
    }

    function _range(PoolKey memory key) internal view returns (int24 lo, int24 hi) {
        (int24 lower, int24 upper) = factory.priceBoundsInTicks(_usdgIs0(key));
        lo = ((lower / 10) + 1) * 10;
        hi = (upper / 10) * 10;
    }

    function _usdgIs0(PoolKey memory key) internal view returns (bool) {
        return Currency.unwrap(key.currency0) == address(usdg);
    }

    function _outcome(PoolKey memory key) internal view returns (IERC20) {
        return IERC20(Currency.unwrap(_usdgIs0(key) ? key.currency1 : key.currency0));
    }

    /// Price of the outcome in bps of 1 USDG, from the pool's sqrt price.
    function _priceBps(PoolKey memory key) internal view returns (uint256) {
        (uint160 sqrtP,,,) = IPoolManager(address(pm)).getSlot0(key.toId());
        uint256 p = (uint256(sqrtP) * uint256(sqrtP) * 10_000) >> 192; // currency1 per currency0, in bps
        return _usdgIs0(key) ? (10_000 * 10_000) / p : p;
    }

    function _buy(address who, PoolKey memory key, uint256 usdgIn) internal {
        _buy(who, key, usdgIn, false);
    }

    function _buy(address who, PoolKey memory key, uint256 usdgIn, bool expectFail) internal {
        bool zeroForOne = _usdgIs0(key);
        vm.startPrank(who);
        usdg.approve(address(swapRouter), usdgIn);
        if (expectFail) vm.expectRevert();
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(usdgIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function _sell(address who, PoolKey memory key, uint256 tokensIn) internal {
        bool zeroForOne = !_usdgIs0(key);
        vm.startPrank(who);
        _outcome(key).approve(address(swapRouter), tokensIn);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(tokensIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    // ── Setup and pricing ───────────────────────────────────────────────────────

    function test_opensAtTheCreatorsPrices() public view {
        assertApproxEqAbs(_priceBps(yesKey), 6_000, 2);
        assertApproxEqAbs(_priceBps(noKey), 4_000, 2);
    }

    function test_creationFeeGoesToCollector() public view {
        assertEq(usdg.balanceOf(address(collector)), 1e6);
    }

    function test_onlyTheNamedDeployerSetsUpTheHookOnce() public {
        vm.prank(alice);
        vm.expectRevert(PFWAMarketHook.NotDeployer.selector);
        hook.setup(alice, alice, ITickMoveListener(address(0)));
        vm.expectRevert(PFWAMarketHook.AlreadySet.selector);
        hook.setup(alice, alice, ITickMoveListener(address(0)));
        assertEq(hook.deployer(), address(this), "the account passed in, not the CREATE2 deployer");
    }

    function test_onlyFactoryCanCreatePools() public {
        PoolKey memory k = yesKey;
        k.tickSpacing = 20;
        vm.expectRevert();
        pm.initialize(k, TickMath.getSqrtPriceAtTick(0));
    }

    // ── Complete sets ───────────────────────────────────────────────────────────

    function test_mintAndBurnSet() public {
        vm.startPrank(alice);
        usdg.approve(address(market), 100e6);
        market.mintSet(100e6, alice);
        assertEq(market.outcomes(0).balanceOf(alice), 100e6);
        assertEq(market.outcomes(1).balanceOf(alice), 100e6);
        market.burnSet(40e6, alice);
        vm.stopPrank();
        assertEq(market.outcomes(0).balanceOf(alice), 60e6);
        assertEq(usdg.balanceOf(address(market)), market.outcomes(0).totalSupply());
    }

    // ── Trading and fees ────────────────────────────────────────────────────────

    function test_buyTakesFeeFromUsdgIn() public {
        uint256 creatorBefore = usdg.balanceOf(creator);
        uint256 collectorBefore = usdg.balanceOf(address(collector));
        uint256 priceBefore = _priceBps(yesKey);
        _buy(alice, yesKey, 100e6);
        assertEq(hook.creatorFeesOwed(creator), 1e6, "creator 1% owed");
        assertEq(hook.protocolFeesOwed(), 1e6, "protocol 1% owed");
        vm.prank(creator);
        hook.claimCreatorFees(creator);
        hook.sweepProtocolFees();
        assertEq(usdg.balanceOf(creator) - creatorBefore, 1e6, "creator 1%");
        assertEq(usdg.balanceOf(address(collector)) - collectorBefore, 1e6, "protocol 1%");
        assertGt(_outcome(yesKey).balanceOf(alice), 0);
        assertGt(_priceBps(yesKey), priceBefore, "price up");
    }

    function test_sellTakesFeeFromUsdgOut() public {
        _buy(alice, yesKey, 100e6);
        uint256 tokens = _outcome(yesKey).balanceOf(alice);
        uint256 owedBefore = hook.creatorFeesOwed(creator);
        uint256 aliceBefore = usdg.balanceOf(alice);
        _sell(alice, yesKey, tokens);
        uint256 received = usdg.balanceOf(alice) - aliceBefore;
        uint256 creatorFee = hook.creatorFeesOwed(creator) - owedBefore;
        assertGt(received, 0);
        // The creator gets 1% of the gross USDG out: fee / (received + both fees) ≈ 1%.
        assertApproxEqAbs((creatorFee * 10_000) / (received + 2 * creatorFee), 100, 1);
    }

    function test_noTradingAfterEndOfTrading() public {
        vm.warp(block.timestamp + 1 days);
        _buy(alice, yesKey, 10e6, true);
    }

    function test_priceCannotLeaveBounds() public {
        // Far more USDG than the pool's liquidity: the price would run past 0.999, so the swap reverts.
        _buy(alice, yesKey, 500_000e6, true);
    }

    function test_frozenCreatorCannotBlockTrading() public {
        // Fees are held in the hook, so trading never depends on paying the creator.
        _buy(alice, yesKey, 100e6);
        _buy(bob, noKey, 100e6);
        assertEq(hook.creatorFeesOwed(creator), 2e6);
    }

    function test_exactOutputRejected() public {
        vm.startPrank(alice);
        usdg.approve(address(swapRouter), 10e6);
        vm.expectRevert();
        swapRouter.swap(
            yesKey,
            SwapParams({
                zeroForOne: _usdgIs0(yesKey),
                amountSpecified: 1e6,
                sqrtPriceLimitX96: _usdgIs0(yesKey) ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    // ── Resolution: as on bonding curve markets, then a 2-hour dispute window ──

    function _resolve(address who, uint8 outcome) internal {
        vm.prank(who);
        resolver.resolveMarket(marketId, outcome);
    }

    function _dispute(address who) internal {
        vm.startPrank(who);
        usdg.approve(address(resolver), type(uint256).max);
        resolver.dispute(marketId);
        vm.stopPrank();
    }

    function test_resolveStopsTradingThenFinalizesAfterTheWindowAndPays() public {
        _buy(alice, yesKey, 100e6);
        uint256 aliceYes = _outcome(yesKey).balanceOf(alice);
        vm.warp(block.timestamp + 1 days);
        _resolve(creator, 0);
        assertTrue(market.halted());
        assertFalse(market.tradingOpen());
        assertFalse(market.resolved(), "not final while it can be disputed");

        vm.prank(alice);
        vm.expectRevert(OBMarket.NotResolved.selector);
        market.redeem(0, aliceYes, alice);
        vm.expectRevert(MarketResolver.DisputeWindowOpen.selector);
        resolver.finalize(marketId);
        vm.warp(block.timestamp + 2 hours);
        resolver.finalize(marketId); // anyone
        assertTrue(market.resolved());

        uint256 aliceBefore = usdg.balanceOf(alice);
        vm.prank(alice);
        market.redeem(0, aliceYes, alice);
        assertEq(usdg.balanceOf(alice) - aliceBefore, aliceYes, "1 USDG per YES");
        vm.prank(alice);
        vm.expectRevert(OBMarket.BadOutcome.selector);
        market.redeem(1, 1, alice);
    }

    function test_resolvingEarlyStopsTradingAtOnce() public {
        _resolve(creator, 0); // a data source can settle it before the deadline, as on bonding curve markets
        _buy(alice, yesKey, 10e6, true);
        vm.prank(creator);
        vm.expectRevert(MarketResolver.WrongState.selector);
        resolver.resolveMarket(marketId, 1); // once
    }

    function test_whoMayResolveIsTheBondingCurveRule() public {
        vm.prank(alice);
        vm.expectRevert(MarketResolver.NotAllowedToResolve.selector);
        resolver.resolveMarket(marketId, 0); // a stranger, never
        vm.prank(bot);
        vm.expectRevert(MarketResolver.NotAllowedToResolve.selector);
        resolver.resolveMarket(marketId, 0); // the relayer on a creator market, before end of trading + 24h
        assertTrue(resolver.mayResolve(marketId, creator));
        assertTrue(resolver.mayResolve(marketId, arbiter), "the owner, any time");
        vm.warp(block.timestamp + 1 days + 24 hours);
        assertTrue(resolver.mayResolve(marketId, bot), "the relayer, after the grace");
        vm.warp(block.timestamp - 24 hours);
        vm.prank(alice);
        vm.expectRevert(MarketResolver.NotOwner.selector);
        resolver.setPlatform(creator, true);
        vm.prank(arbiter);
        resolver.setPlatform(creator, true);
        _resolve(bot, 0); // the relayer on a platform market, from its data source
    }

    function test_aDisputerWhoWasRightGetsTheBondBack() public {
        vm.warp(block.timestamp + 1 days);
        _resolve(creator, 0); // the creator says YES
        uint256 bobBefore = usdg.balanceOf(bob);
        _dispute(bob);
        assertEq(bobBefore - usdg.balanceOf(bob), 50e6, "the bond");
        vm.warp(block.timestamp + 3 hours);
        vm.expectRevert(MarketResolver.WrongState.selector);
        resolver.finalize(marketId); // a disputed result waits for the owner
        vm.prank(alice);
        vm.expectRevert(MarketResolver.NotArbiter.selector);
        resolver.settleDispute(marketId, 1);
        vm.prank(arbiter);
        resolver.settleDispute(marketId, 1); // it was NO
        assertEq(usdg.balanceOf(bob), bobBefore, "bond back");
        assertTrue(market.resolved());
        assertEq(market.winningOutcome(), 1);
    }

    function test_aDisputerWhoWasWrongLosesTheBond() public {
        vm.warp(block.timestamp + 1 days);
        _resolve(creator, 0);
        _dispute(bob);
        uint256 collectorBefore = usdg.balanceOf(address(collector));
        vm.prank(arbiter);
        resolver.settleDispute(marketId, 0); // YES stands
        assertEq(usdg.balanceOf(address(collector)) - collectorBefore, 50e6, "bond to the fee collector");
        assertEq(market.winningOutcome(), 0);
    }

    function test_theOwnerCanHandDisputesToAnotherArbiterAndNothingElse() public {
        address vote = address(0xB07E); // stands in for a $PFWA holder vote
        assertEq(resolver.arbiter(), arbiter, "starts as the owner");
        vm.prank(alice);
        vm.expectRevert(MarketResolver.NotOwner.selector);
        resolver.setArbiter(vote);
        vm.prank(arbiter);
        resolver.setArbiter(vote);

        vm.warp(block.timestamp + 1 days);
        _resolve(creator, 0);
        _dispute(bob);
        vm.prank(arbiter);
        vm.expectRevert(MarketResolver.NotArbiter.selector);
        resolver.settleDispute(marketId, 1); // the owner no longer settles disputes
        vm.prank(vote);
        resolver.settleDispute(marketId, 1);
        assertEq(market.winningOutcome(), 1);

        vm.startPrank(vote); // and the arbiter gets none of the owner's other powers
        vm.expectRevert(MarketResolver.NotOwner.selector);
        resolver.setRelayer(vote);
        vm.expectRevert(MarketResolver.NotOwner.selector);
        resolver.setFeeCollector(vote);
        vm.stopPrank();
        assertFalse(resolver.mayResolve(marketId, vote), "nor the right to resolve markets");
    }

    function test_disputesOnlyOnAPendingResultAndOnlyOnce() public {
        vm.expectRevert(MarketResolver.WrongState.selector);
        resolver.dispute(marketId); // nothing to dispute yet
        vm.warp(block.timestamp + 1 days);
        _resolve(creator, 0);
        _dispute(bob);
        vm.startPrank(alice);
        usdg.approve(address(resolver), type(uint256).max);
        vm.expectRevert(MarketResolver.WrongState.selector);
        resolver.dispute(marketId); // one dispute
        vm.stopPrank();
    }

    function test_noDisputeAfterTheWindow() public {
        vm.warp(block.timestamp + 1 days);
        _resolve(creator, 0);
        vm.warp(block.timestamp + 2 hours);
        vm.startPrank(bob);
        usdg.approve(address(resolver), type(uint256).max);
        vm.expectRevert(MarketResolver.DisputeWindowOver.selector);
        resolver.dispute(marketId);
        vm.stopPrank();
        resolver.finalize(marketId);
    }

    function test_invalidMarketPaysHalfPerToken() public {
        vm.startPrank(alice);
        usdg.approve(address(market), 10e6);
        market.mintSet(10e6, alice);
        vm.stopPrank();
        vm.warp(block.timestamp + 1 days);
        _resolve(arbiter, 255);
        vm.warp(block.timestamp + 2 hours);
        resolver.finalize(marketId);

        uint256 before = usdg.balanceOf(alice);
        vm.startPrank(alice);
        market.redeem(0, 10e6, alice);
        market.redeem(1, 10e6, alice);
        vm.stopPrank();
        assertEq(usdg.balanceOf(alice) - before, 10e6, "a full set is still worth 1 USDG");
    }

    // ── Fee collector ───────────────────────────────────────────────────────────

    function test_buybackSendsPfwaToTreasury() public {
        _buy(alice, yesKey, 100e6);
        hook.sweepProtocolFees();
        uint256 held = usdg.balanceOf(address(collector));
        vm.prank(alice);
        vm.expectRevert(FeeCollector.NotKeeper.selector);
        collector.buyback(0);
        collector.buyback(held);
        assertEq(pfwa.balanceOf(treasury), held);
        vm.expectRevert(FeeCollector.TooSoon.selector);
        collector.buyback(0);
    }

    // ── Cross-chain orders ──────────────────────────────────────────────────────

    function test_forwarderExecutesOrder() public {
        ForwarderFactory.Order memory o = ForwarderFactory.Order({
            user: alice,
            marketId: marketId,
            outcome: 0,
            minOut: 1,
            deadline: uint64(block.timestamp + 1 hours),
            nonce: 1
        });
        address deposit = forwarder.depositAddress(o);
        usdg.mint(deposit, 50e6); // what NEAR Intents delivers
        uint256 before = _outcome(yesKey).balanceOf(alice);
        uint256 out = forwarder.execute(o);
        assertGt(out, 0);
        assertEq(_outcome(yesKey).balanceOf(alice) - before, out);
        assertEq(usdg.balanceOf(deposit), 0);
    }

    function test_aBigCrossChainOrderStopsAtThePriceBoundAndReturnsTheRest() public {
        ForwarderFactory.Order memory o = ForwarderFactory.Order({
            user: alice,
            marketId: marketId,
            outcome: 0,
            minOut: 1,
            deadline: uint64(block.timestamp + 1 hours),
            nonce: 7
        });
        address deposit = forwarder.depositAddress(o);
        usdg.mint(deposit, 50_000e6); // far more than the seeded pool can take before 0.999
        uint256 usdgBefore = usdg.balanceOf(alice);
        uint256 out = forwarder.execute(o);
        assertGt(out, 0);
        uint256 back = usdg.balanceOf(alice) - usdgBefore;
        assertGt(back, 40_000e6, "the unspent USDG returns to the user");
        assertLe(_priceBps(yesKey), 9_990, "the price stops at the bound");
        assertEq(usdg.balanceOf(deposit), 0);
        assertEq(usdg.balanceOf(address(forwarder)), 0);
    }

    function test_forwarderRefund() public {
        ForwarderFactory.Order memory o = ForwarderFactory.Order({
            user: alice,
            marketId: marketId,
            outcome: 1,
            minOut: type(uint256).max, // can never fill
            deadline: uint64(block.timestamp + 1 hours),
            nonce: 2
        });
        address deposit = forwarder.depositAddress(o);
        usdg.mint(deposit, 20e6);
        vm.expectRevert();
        forwarder.execute(o);

        vm.expectRevert(ForwarderFactory.NotYet.selector);
        forwarder.refund(o); // a stranger, before the deadline

        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        forwarder.refund(o);
        assertEq(usdg.balanceOf(alice) - before, 20e6);
    }

    // ── Launch safety ───────────────────────────────────────────────────────────

    function _newMarket() internal returns (OBMarket m) {
        string[] memory names = new string[](2);
        names[0] = "YES";
        names[1] = "NO";
        vm.prank(creator);
        uint256 id = factory.createMarket(
            OBMarketFactory.CreateParams({
                setupHash: keccak256("cap"),
                question: "Capped?",
                outcomeNames: names,
                openingBps: new uint16[](0),
                endOfTrading: uint64(block.timestamp + 1 days),
                creatorFeeBps: 100
            })
        );
        m = factory.getMarket(id).market;
    }

    function test_depositCapLimitsNewMarketsOnly() public {
        vm.prank(alice);
        vm.expectRevert();
        factory.setDepositCap(100e6); // owner only
        factory.setDepositCap(100e6);
        OBMarket capped = _newMarket();
        assertEq(capped.depositCap(), 100e6);
        assertEq(market.depositCap(), 0, "a live market keeps its cap");
        vm.startPrank(alice);
        usdg.approve(address(capped), type(uint256).max);
        capped.mintSet(100e6, alice);
        vm.expectRevert(OBMarket.CapExceeded.selector);
        capped.mintSet(1, alice);
        capped.burnSet(30e6, alice);
        capped.mintSet(30e6, alice); // room again after a burn
        vm.stopPrank();
    }

    function test_implementationsCanNotBeInitialised() public {
        OutcomeToken[] memory none = new OutcomeToken[](0);
        OBMarket marketImpl = OBMarket(factory.marketImplementation());
        OutcomeToken tokenImpl = OutcomeToken(factory.tokenImplementation());
        vm.expectRevert(OBMarket.AlreadyInitialized.selector);
        marketImpl.initialize(alice, alice, IERC20(address(usdg)), 1, 1, 0, none);
        vm.expectRevert(OutcomeToken.AlreadyInitialized.selector);
        tokenImpl.initialize("x", "x", alice);
    }

    // ── Fuzz: fees and collateral ───────────────────────────────────────────────

    /// forge-config: default.fuzz.runs = 300
    function testFuzz_feesNeverExceedTheConfiguredRate(uint256 usdgIn, bool sell) public {
        usdgIn = bound(usdgIn, 1, 100e6); // the seeded pools reach their 0.999 bound a little past this
        uint256 creatorBefore = hook.creatorFeesOwed(creator);
        uint256 protocolBefore = hook.protocolFeesOwed();
        uint256 aliceBefore = usdg.balanceOf(alice);
        _buy(alice, yesKey, usdgIn);
        uint256 creatorFee = hook.creatorFeesOwed(creator) - creatorBefore;
        uint256 protocolFee = hook.protocolFeesOwed() - protocolBefore;
        assertEq(creatorFee, (usdgIn * 100) / 10_000, "creator 1% of the USDG in");
        assertEq(protocolFee, (usdgIn * 100) / 10_000, "protocol 1% of the USDG in");
        assertEq(aliceBefore - usdg.balanceOf(alice), usdgIn, "exact input");
        if (!sell) return;
        uint256 tokens = _outcome(yesKey).balanceOf(alice);
        if (tokens == 0) return;
        creatorBefore = hook.creatorFeesOwed(creator);
        uint256 usdgBefore = usdg.balanceOf(alice);
        _sell(alice, yesKey, tokens);
        uint256 received = usdg.balanceOf(alice) - usdgBefore;
        uint256 fee = hook.creatorFeesOwed(creator) - creatorBefore;
        // the fee is 1% of the gross USDG out (received + both fees), rounded down
        assertLe(fee, ((received + 2 * fee) * 100) / 10_000);
    }

    /// Random buys, sells, set mints and burns: trading never touches a market's collateral, every outcome stays
    /// backed 1:1, and the hook holds exactly the fees it owes.
    /// forge-config: default.fuzz.runs = 200
    function testFuzz_tradingNeverTouchesCollateral(uint256[8] calldata ops) public {
        address[2] memory who = [alice, bob];
        for (uint256 i; i < ops.length; ++i) {
            address a = who[ops[i] % 2];
            PoolKey memory key = (ops[i] >> 1) % 2 == 0 ? yesKey : noKey;
            uint256 amount = bound(ops[i] >> 8, 1e6, 25e6); // eight moves stay inside the seeded pools' bounds
            uint256 kind = (ops[i] >> 2) % 4;
            if (kind == 0) {
                _buy(a, key, amount);
            } else if (kind == 1) {
                uint256 bal = _outcome(key).balanceOf(a);
                if (bal > 0) _sell(a, key, bal / 2 + 1 > bal ? bal : bal / 2 + 1);
            } else if (kind == 2) {
                vm.startPrank(a);
                usdg.approve(address(market), amount);
                market.mintSet(amount, a);
                vm.stopPrank();
            } else {
                uint256 most = market.outcomes(0).balanceOf(a);
                uint256 other = market.outcomes(1).balanceOf(a);
                if (other < most) most = other;
                if (most > 0) {
                    vm.prank(a);
                    market.burnSet(most, a);
                }
            }
            uint256 held = usdg.balanceOf(address(market));
            assertEq(market.outcomes(0).totalSupply(), held, "YES backed 1:1");
            assertEq(market.outcomes(1).totalSupply(), held, "NO backed 1:1");
            assertEq(
                usdg.balanceOf(address(hook)),
                hook.creatorFeesOwed(creator) + hook.protocolFeesOwed(),
                "the hook holds exactly the fees it owes"
            );
        }
    }

    // ── Limit orders ────────────────────────────────────────────────────────────

    address carol = address(0xCA);

    function _tick(PoolKey memory key) internal view returns (int24 t) {
        (, t,,) = IPoolManager(address(pm)).getSlot0(key.toId());
    }

    function _floorTick(int24 t) internal pure returns (int24) {
        int24 q = t / 10;
        if (t < 0 && t % 10 != 0) q -= 1;
        return q * 10;
    }

    /// A sell of the outcome for USDG, `steps` steps away from the price, by `who` (who holds the outcome).
    /// Returns the step and direction.
    function _placeSell(address who, PoolKey memory key, uint256 steps, uint256 amount)
        internal
        returns (int24 tickLower, bool zeroForOne, uint256 epoch)
    {
        zeroForOne = !_usdgIs0(key); // the outcome is currency0: selling it is zeroForOne, above the price
        int24 base = _floorTick(_tick(key));
        tickLower = zeroForOne ? base + int24(int256(10 * steps)) : base - int24(int256(10 * (steps + 1)));
        vm.startPrank(who);
        _outcome(key).approve(address(limits), type(uint256).max);
        epoch = limits.place(key, tickLower, zeroForOne, amount);
        vm.stopPrank();
    }

    /// A buy of the outcome with USDG, `steps` steps away from the price.
    function _placeBuy(address who, PoolKey memory key, uint256 steps, uint256 amount)
        internal
        returns (int24 tickLower, bool zeroForOne, uint256 epoch)
    {
        zeroForOne = _usdgIs0(key); // USDG is currency0: paying it is zeroForOne, above the price
        int24 base = _floorTick(_tick(key));
        tickLower = zeroForOne ? base + int24(int256(10 * steps)) : base - int24(int256(10 * (steps + 1)));
        vm.startPrank(who);
        usdg.approve(address(limits), type(uint256).max);
        epoch = limits.place(key, tickLower, zeroForOne, amount);
        vm.stopPrank();
    }

    function _holdOutcomes(address who, uint256 sets) internal {
        if (usdg.balanceOf(who) < sets) usdg.mint(who, sets);
        vm.startPrank(who);
        usdg.approve(address(market), sets);
        market.mintSet(sets, who);
        vm.stopPrank();
    }

    function test_aLimitSellFillsWhenABuyPushesThePriceThroughIt() public {
        _holdOutcomes(alice, 100e6);
        uint256 priceBefore = _priceBps(yesKey);
        (,, uint256 epoch) = _placeSell(alice, yesKey, 3, 50e6);
        assertEq(_outcome(yesKey).balanceOf(alice), 50e6, "the order holds the other 50");
        _buy(bob, yesKey, 400e6); // lifts YES well past the order
        assertGt(_priceBps(yesKey), priceBefore);
        (bool filled,,,) = limits.epochInfo(epoch);
        assertTrue(filled, "filled inside the swap");
        uint256 usdgBefore = usdg.balanceOf(alice);
        vm.prank(alice);
        limits.withdraw(epoch, alice);
        uint256 got = usdg.balanceOf(alice) - usdgBefore;
        // 50 YES sold around the order's price (just above where YES opened at 0.60)
        assertGt(got, 30e6);
        assertLt(got, 33e6);
        vm.prank(alice);
        vm.expectRevert(PFWALimitOrders.NothingToWithdraw.selector);
        limits.withdraw(epoch, alice);
    }

    function test_aLimitBuyFillsWhenASellPushesThePriceThroughIt() public {
        _holdOutcomes(bob, 1_000e6);
        (,, uint256 epoch) = _placeBuy(alice, yesKey, 3, 30e6);
        _sell(bob, yesKey, 800e6); // drops YES through the order
        (bool filled,,,) = limits.epochInfo(epoch);
        assertTrue(filled);
        uint256 before = _outcome(yesKey).balanceOf(alice);
        vm.prank(alice);
        limits.withdraw(epoch, alice);
        uint256 got = _outcome(yesKey).balanceOf(alice) - before;
        assertGt(got, 50e6, "30 USDG buys over 50 YES just below 0.60");
        assertLt(got, 52e6);
    }

    function test_anUnfilledOrderCancelsBackToTheInput() public {
        _holdOutcomes(alice, 100e6);
        (int24 tickLower, bool zeroForOne, uint256 epoch) = _placeSell(alice, yesKey, 5, 40e6);
        vm.prank(bob);
        vm.expectRevert(PFWALimitOrders.NothingToWithdraw.selector);
        limits.cancel(yesKey, tickLower, zeroForOne, bob);
        vm.prank(alice);
        (uint256 a0, uint256 a1) = limits.cancel(yesKey, tickLower, zeroForOne, alice);
        assertApproxEqAbs(_outcome(yesKey).balanceOf(alice), 100e6, 2, "back, less a rounding wei");
        assertEq(a0 + a1 + 1 >= 40e6 - 1, true);
        (, uint128 left,,) = limits.epochInfo(epoch);
        assertEq(left, 0);
        vm.prank(alice);
        vm.expectRevert(PFWALimitOrders.NotFilled.selector);
        limits.withdraw(epoch, alice);
    }

    function test_ordersMustSitOnTheFarSideInsideTheBoundsWhileTradingIsOpen() public {
        _holdOutcomes(alice, 100e6);
        bool zeroForOne = !_usdgIs0(yesKey);
        int24 base = _floorTick(_tick(yesKey));
        vm.startPrank(alice);
        _outcome(yesKey).approve(address(limits), type(uint256).max);
        vm.expectRevert(PFWALimitOrders.CrossedRange.selector);
        limits.place(yesKey, zeroForOne ? base - 10 : base + 10, zeroForOne, 10e6); // the wrong side
        vm.expectRevert(PFWALimitOrders.BadTick.selector);
        limits.place(yesKey, base + 5, zeroForOne, 10e6); // off the spacing
        (int24 lower, int24 upper) = factory.priceBoundsInTicks(_usdgIs0(yesKey));
        vm.expectRevert(PFWALimitOrders.BadTick.selector);
        limits.place(yesKey, zeroForOne ? _floorTick(upper) : _floorTick(lower) - 10, zeroForOne, 10e6); // past a bound
        vm.stopPrank();
        PoolKey memory stranger = yesKey;
        stranger.tickSpacing = 60;
        vm.expectRevert(PFWALimitOrders.UnknownPool.selector);
        limits.place(stranger, 0, true, 1);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        vm.expectRevert(PFWALimitOrders.TradingClosed.selector);
        limits.place(yesKey, zeroForOne ? base + 30 : base - 40, zeroForOne, 10e6);
    }

    function test_onlyTheHookReportsPriceMoves() public {
        vm.expectRevert(PFWALimitOrders.NotHook.selector);
        limits.movePoolTick(yesKey, 0, 100, 0);
    }

    function test_ordersAtOnePriceShareTheFillProRata() public {
        _holdOutcomes(alice, 100e6);
        _holdOutcomes(carol, 100e6);
        (,, uint256 epoch) = _placeSell(alice, yesKey, 2, 30e6);
        (,, uint256 same) = _placeSell(carol, yesKey, 2, 10e6);
        assertEq(same, epoch, "one position");
        _buy(bob, yesKey, 400e6);
        uint256 a = usdg.balanceOf(alice);
        uint256 c = usdg.balanceOf(carol);
        vm.prank(alice);
        limits.withdraw(epoch, alice);
        vm.prank(carol);
        limits.withdraw(epoch, carol);
        uint256 gotA = usdg.balanceOf(alice) - a;
        uint256 gotC = usdg.balanceOf(carol) - c;
        assertApproxEqRel(gotA, gotC * 3, 0.001e18, "3 to 1, like their orders");
        (, uint128 left, uint256 t0, uint256 t1) = limits.epochInfo(epoch);
        assertEq(left, 0);
        assertLe(t0 + t1, 2, "only rounding dust left");
    }

    function test_aSwapFillsAtMostEightStepsAndAnyoneFillsTheRest() public {
        _holdOutcomes(alice, 200e6);
        uint256[] memory epochs = new uint256[](10);
        int24[] memory steps = new int24[](10);
        bool zeroForOne;
        for (uint256 i; i < 10; ++i) (steps[i], zeroForOne, epochs[i]) = _placeSell(alice, yesKey, 1 + i, 5e6);
        _buy(bob, yesKey, 400e6);
        uint256 filled;
        for (uint256 i; i < 10; ++i) {
            (bool f,,,) = limits.epochInfo(epochs[i]);
            if (f) ++filled;
        }
        assertEq(filled, 8, "capped per swap");
        for (uint256 i; i < 10; ++i) {
            (bool f,,,) = limits.epochInfo(epochs[i]);
            if (!f) limits.fill(yesKey, steps[i], zeroForOne); // anyone, while the price is past it
            (f,,,) = limits.epochInfo(epochs[i]);
            assertTrue(f);
        }
    }

    function test_fillNeedsThePriceFullyPastTheStep() public {
        _holdOutcomes(alice, 100e6);
        (int24 tickLower, bool zeroForOne,) = _placeSell(alice, yesKey, 4, 20e6);
        vm.expectRevert(PFWALimitOrders.NotCrossed.selector);
        limits.fill(yesKey, tickLower, zeroForOne);
    }

    function test_anOrderCanStillBeCancelledAfterTheMarketCloses() public {
        _holdOutcomes(alice, 100e6);
        (int24 tickLower, bool zeroForOne,) = _placeSell(alice, yesKey, 3, 40e6);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        limits.cancel(yesKey, tickLower, zeroForOne, alice);
        assertApproxEqAbs(_outcome(yesKey).balanceOf(alice), 100e6, 2);
    }

    /// Two makers at random sizes and steps, a random buy: whatever fills, every maker can withdraw or cancel, and
    /// the order book never pays out more than it holds.
    /// forge-config: default.fuzz.runs = 200
    function testFuzz_makersAlwaysGetTheirShareAndTheBookStaysSolvent(uint256 a, uint256 c, uint8 stepA, uint8 stepC, uint256 buy) public {
        a = bound(a, 1e6, 40e6);
        c = bound(c, 1e6, 40e6);
        _holdOutcomes(alice, a);
        _holdOutcomes(carol, c);
        (int24 tA, bool z, uint256 eA) = _placeSell(alice, yesKey, bound(stepA, 1, 12), a);
        (int24 tC,, uint256 eC) = _placeSell(carol, yesKey, bound(stepC, 1, 12), c);
        _buy(bob, yesKey, bound(buy, 1e6, 400e6));
        address[2] memory who = [alice, carol];
        uint256[2] memory eps = [eA, eC];
        int24[2] memory ts = [tA, tC];
        for (uint256 i; i < 2; ++i) {
            (bool f,,,) = limits.epochInfo(eps[i]);
            uint128 mine = limits.liquidityOf(eps[i], who[i]);
            if (mine == 0) continue; // already taken out with the other maker's (shared step)
            vm.prank(who[i]);
            if (f) limits.withdraw(eps[i], who[i]);
            else limits.cancel(yesKey, ts[i], z, who[i]);
        }
        assertLe(usdg.balanceOf(address(limits)), 2, "at most rounding dust stays");
        assertLe(_outcome(yesKey).balanceOf(address(limits)), 2);
    }
}
