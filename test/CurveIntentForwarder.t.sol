// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BondingCurveToken} from "../src/BondingCurveToken.sol";
import {PFWAMarketFactory} from "../src/PFWAMarketFactory.sol";
import {CurveIntentForwarder, CurveIntentDeposit, ICurveMarkets} from "../src/CurveIntentForwarder.sol";

contract CurveIntentForwarderTest is Test {
    PFWAMarketFactory factory;
    CurveIntentForwarder fwd;
    address platform = makeAddr("platform");
    address user = makeAddr("user");
    address keeper = makeAddr("keeper");
    uint256 marketId;
    address[] tokens;

    function setUp() public {
        factory = new PFWAMarketFactory(address(new BondingCurveToken()), platform, makeAddr("relayer"));
        factory.setBuybackBurnPercentage(0); // no PFWA pool on a local chain
        string[] memory names = new string[](2);
        names[0] = "YES";
        names[1] = "NO";
        (marketId, tokens) = factory.createMarket{value: factory.marketCreationFee()}("Will it?", names, block.timestamp + 7 days, PFWAMarketFactory.MarketType.BINARY);
        fwd = new CurveIntentForwarder(ICurveMarkets(address(factory)));
    }

    function order(uint256 minShares) internal view returns (CurveIntentForwarder.Order memory) {
        return CurveIntentForwarder.Order(user, marketId, 0, minShares, uint64(block.timestamp + 3 hours), 1);
    }

    /// What 1Click does: send ETH to the order's deposit address.
    function deliver(CurveIntentForwarder.Order memory o, uint256 amount) internal returns (address dep) {
        dep = fwd.depositAddress(o);
        vm.deal(address(this), amount);
        (bool ok,) = dep.call{value: amount}("");
        assertTrue(ok);
    }

    function test_executeBuysSharesForUser() public {
        uint256 quoted = fwd.sharesFor(tokens[0], 0.01 ether);
        CurveIntentForwarder.Order memory o = order((quoted * 99) / 100);
        address dep = deliver(o, 0.01 ether);

        vm.prank(keeper);
        uint256 shares = fwd.execute(o);

        assertEq(shares, quoted);
        assertEq(BondingCurveToken(payable(tokens[0])).balanceOf(user), shares);
        assertEq(BondingCurveToken(payable(tokens[0])).balanceOf(address(fwd)), 0);
        assertEq(dep.balance, 0);
        assertEq(address(fwd).balance, 0);
        // Whatever the curve didn't use is the user's, never the forwarder's or the keeper's.
        assertLe(user.balance, 0.0001 ether);
        assertEq(keeper.balance, 0);
    }

    function test_executeTwiceFails() public {
        CurveIntentForwarder.Order memory o = order(0);
        deliver(o, 0.01 ether);
        fwd.execute(o);
        vm.expectRevert(CurveIntentForwarder.NothingDeposited.selector);
        fwd.execute(o);
    }

    function test_minSharesProtectsUser() public {
        uint256 quoted = fwd.sharesFor(tokens[0], 0.01 ether);
        CurveIntentForwarder.Order memory o = order(quoted);
        deliver(o, 0.01 ether);
        // Someone buys first and moves the price.
        vm.deal(address(this), 1 ether);
        BondingCurveToken t = BondingCurveToken(payable(tokens[0]));
        uint256 big = fwd.sharesFor(tokens[0], 0.5 ether);
        t.buy{value: 0.5 ether}(big);

        vm.expectRevert();
        fwd.execute(o);

        // The user takes the ETH back on Robinhood Chain.
        vm.prank(user);
        fwd.refund(o);
        assertEq(user.balance, 0.01 ether);
    }

    function test_refundOnlyUserBeforeDeadline() public {
        CurveIntentForwarder.Order memory o = order(0);
        deliver(o, 0.02 ether);
        vm.prank(keeper);
        vm.expectRevert(CurveIntentForwarder.NotYet.selector);
        fwd.refund(o);

        vm.warp(o.deadline + 1);
        vm.expectRevert(CurveIntentForwarder.Expired.selector);
        fwd.execute(o);
        vm.prank(keeper);
        fwd.refund(o);
        assertEq(user.balance, 0.02 ether);
    }

    function test_madeUpOrderMovesNothing() public {
        CurveIntentForwarder.Order memory real = order(0);
        deliver(real, 0.01 ether);
        CurveIntentForwarder.Order memory fake = order(0);
        fake.user = keeper;
        vm.expectRevert(CurveIntentForwarder.NothingDeposited.selector);
        fwd.execute(fake);
        vm.warp(fake.deadline + 1);
        vm.expectRevert(CurveIntentForwarder.NothingDeposited.selector);
        fwd.refund(fake);
    }

    function test_unknownOptionFails() public {
        CurveIntentForwarder.Order memory o = order(0);
        o.option = 2;
        deliver(o, 0.01 ether);
        vm.expectRevert(CurveIntentForwarder.NoSuchOption.selector);
        fwd.execute(o);
    }

    function test_depositAcceptsEthAfterClone() public {
        CurveIntentForwarder.Order memory o = order(0);
        deliver(o, 0.01 ether);
        fwd.execute(o); // deploys the clone
        address dep = deliver(o, 0.01 ether); // a second delivery to the same order
        assertEq(dep.balance, 0.01 ether);
        fwd.execute(o);
        assertEq(dep.balance, 0);
    }

    function testFuzz_sharesForAlwaysAffordable(uint96 eth) public view {
        uint256 ethIn = bound(uint256(eth), 1e12, 20 ether);
        uint256 shares = fwd.sharesFor(tokens[0], ethIn);
        assertLe(BondingCurveToken(payable(tokens[0])).costToBuyWithFee(shares), ethIn);
    }

    receive() external payable {}
}
