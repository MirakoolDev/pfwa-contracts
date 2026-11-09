// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {OBMarketFactory} from "../src/OBMarketFactory.sol";
import {LiquidityLocker, LiquidityLockerFactory, IPositionManagerLite, IPermit2Lite} from "../src/LiquidityLocker.sol";

/// Deploys the liquidity locker factory, then a locker for an order book market factory.
///
/// Env: MARKET_FACTORY (OBMarketFactory), POSITION_MANAGER (Uniswap v4 PositionManager), PERMIT2.
///
///   forge script script/DeployLocker.s.sol --rpc-url robinhood --broadcast --sender <deployer> <wallet flag>
contract DeployLocker is Script {
    function run() external {
        OBMarketFactory marketFactory = OBMarketFactory(vm.envAddress("MARKET_FACTORY"));
        IPositionManagerLite positionManager = IPositionManagerLite(vm.envAddress("POSITION_MANAGER"));
        IPermit2Lite permit2 = IPermit2Lite(vm.envAddress("PERMIT2"));

        vm.startBroadcast();
        LiquidityLockerFactory lockerFactory = new LiquidityLockerFactory();
        LiquidityLocker locker = lockerFactory.create(positionManager, permit2, marketFactory);
        vm.stopBroadcast();

        console2.log("LiquidityLockerFactory", address(lockerFactory));
        console2.log("LiquidityLocker", address(locker));
    }
}
