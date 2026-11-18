// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CurveIntentForwarder, ICurveMarkets} from "../src/CurveIntentForwarder.sol";

/// Against the live PFWAMarketFactory on Robinhood Chain: FORK_URL=<rpc> forge test --match-path test/CurveIntentForwarderFork.t.sol
/// Picks the newest market and buys its first option the way a NEAR Intents order would.
contract CurveIntentForwarderForkTest is Test {
    ICurveMarkets constant FACTORY = ICurveMarkets(0x7B38e940Cd649bc0C701c42eE1A6ceff75584afa);

    function test_fork_buyNewestMarket() public {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        CurveIntentForwarder fwd = new CurveIntentForwarder(FACTORY);
        (bool ok, bytes memory ret) = address(FACTORY).staticcall(abi.encodeWithSignature("marketCount()"));
        require(ok);
        uint256 marketId = abi.decode(ret, (uint256)) - 1;
        address user = makeAddr("user");
        address token = fwd.tokenOf(marketId, 0);
        uint256 quoted = fwd.sharesFor(token, 0.001 ether);
        CurveIntentForwarder.Order memory o = CurveIntentForwarder.Order(user, marketId, 0, (quoted * 99) / 100, uint64(block.timestamp + 3 hours), 7);
        vm.deal(fwd.depositAddress(o), 0.001 ether);
        uint256 shares = fwd.execute(o);
        assertEq(IERC20(token).balanceOf(user), shares);
        assertGt(shares, 0);
        assertEq(address(fwd).balance, 0);
    }
}
