// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {OBMarketFactory} from "../src/OBMarketFactory.sol";
import {OBSetRouter, OBSetRouterFactory} from "../src/OBSetRouter.sol";

/// Deploys the set router factory, then a router for an order book market factory.
///
/// Env: MARKET_FACTORY (OBMarketFactory), POOL_MANAGER (Uniswap v4 PoolManager), USDG.
///
///   forge script script/DeployRouter.s.sol --rpc-url robinhood --broadcast --sender <deployer> <wallet flag>
contract DeployRouter is Script {
    function run() external {
        OBMarketFactory marketFactory = OBMarketFactory(vm.envAddress("MARKET_FACTORY"));
        IPoolManager poolManager = IPoolManager(vm.envAddress("POOL_MANAGER"));
        IERC20 usdg = IERC20(vm.envAddress("USDG"));

        vm.startBroadcast();
        OBSetRouterFactory routerFactory = new OBSetRouterFactory();
        OBSetRouter router = routerFactory.create(poolManager, marketFactory, usdg);
        vm.stopBroadcast();

        console2.log("OBSetRouterFactory", address(routerFactory));
        console2.log("OBSetRouter", address(router));
    }
}
