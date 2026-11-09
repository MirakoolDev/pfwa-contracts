// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {OBMarketFactory} from "../src/OBMarketFactory.sol";
import {OBMarket} from "../src/OBMarket.sol";
import {OBSetRouter, OBSetRouterFactory} from "../src/OBSetRouter.sol";

/// OBSetRouter against the live order book stack on a Robinhood Chain fork: market 200000 (SPX, YES/NO), its real
/// pools and hook. Skipped unless ROBINHOOD_RPC_URL is set.
contract OBSetRouterForkTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    OBMarketFactory constant FACTORY = OBMarketFactory(0x06703aE0f85Ad14846CB5EeBCeBFc85b1cebB6F7);
    uint256 constant ID = 200_000;

    OBSetRouter router;
    address alice = makeAddr("alice");

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        router = new OBSetRouterFactory().create(PM, FACTORY, USDG);
        deal(address(USDG), alice, 1_000e6);
        vm.prank(alice);
        USDG.approve(address(router), type(uint256).max);
    }

    function _price(uint8 i) internal view returns (uint256 e6) {
        PoolKey memory key = FACTORY.getPools(ID)[i];
        (uint160 sp,,,) = PM.getSlot0(key.toId());
        uint256 p = (uint256(sp) * uint256(sp) * 1e6) >> 192; // currency1 per currency0, scaled 1e6
        return Currency.unwrap(key.currency0) == address(USDG) ? 1e12 / p : p;
    }

    function test_fork_buyYesViaSetsMovesBothPrices() public {
        OBMarket market = FACTORY.getMarket(ID).market;
        IERC20 yes = IERC20(address(market.allOutcomes()[0]));
        uint256 no0 = _price(1);
        uint256 usdgBefore = USDG.balanceOf(alice);
        vm.prank(alice);
        (uint256 out, uint256 paid) = router.buy(ID, 0, 18e6, 0, 10e6, 18e6, alice);
        assertEq(out, 18e6, "18 YES");
        assertEq(yes.balanceOf(alice), 18e6);
        assertEq(usdgBefore - USDG.balanceOf(alice), paid, "paid what it says");
        assertLe(paid, 10e6);
        assertEq(USDG.balanceOf(address(router)), 0, "router keeps nothing");
        assertEq(yes.balanceOf(address(router)), 0);
        assertLt(_price(1), no0, "NO went down");
    }

    /// 10 USDG, split between the direct buy and sets: logs YES received for each split. sets = 0 is a plain buy.
    function test_fork_splitBeatsDirect() public {
        uint256 directOnly;
        uint256 best;
        for (uint256 s = 0; s <= 18e6; s += 2e6) {
            uint256 snap = vm.snapshotState();
            uint256 setCost;
            if (s > 0) {
                vm.prank(alice);
                (, setCost) = router.buy(ID, 0, s, 0, 10e6, 0, alice);
                vm.revertToState(snap);
                snap = vm.snapshotState();
            }
            if (setCost >= 10e6) { vm.revertToState(snap); continue; }
            uint256 direct = 10e6 - setCost - 1;
            vm.prank(alice);
            (uint256 out,) = router.buy(ID, 0, s, direct, 10e6, 0, alice);
            console2.log("sets %s direct %s -> YES %s", s, direct, out);
            console2.log("   after: YES %s NO %s", _price(0), _price(1));
            if (s == 0) directOnly = out;
            if (out > best) best = out;
            vm.revertToState(snap);
        }
        assertGt(best, directOnly, "a split beats a plain buy");
    }

    function test_fork_revertsWhenSalesDontCover() public {
        // 40 sets for 5 USDG: selling 40 NO can't bring in 35 USDG.
        vm.prank(alice);
        vm.expectRevert();
        router.buy(ID, 0, 40e6, 0, 5e6, 0, alice);
    }
}
