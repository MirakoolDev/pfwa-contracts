// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {CurveIntentForwarder, ICurveMarkets} from "../src/CurveIntentForwarder.sol";

/// Deploys the CurveIntentForwarder for a PFWAMarketFactory (default: the live one on Robinhood Chain). The wallet comes
/// from the command line, no private key in the environment:
///   forge script script/DeployCurveIntentForwarder.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com \
///     --broadcast --sender <deployer> <wallet flag: --account <name> | --ledger | --interactive>
contract DeployCurveIntentForwarder is Script {
    function run() external returns (CurveIntentForwarder fwd) {
        address factory = vm.envOr("MARKET_FACTORY", address(0x7B38e940Cd649bc0C701c42eE1A6ceff75584afa));
        vm.startBroadcast();
        fwd = new CurveIntentForwarder(ICurveMarkets(factory));
        vm.stopBroadcast();
        console2.log("CurveIntentForwarder:", address(fwd));
        console2.log("CurveIntentDeposit implementation:", fwd.depositImplementation());
        console2.log("Market factory:", factory);
    }
}
