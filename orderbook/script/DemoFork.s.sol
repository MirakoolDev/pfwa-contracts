// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PFWAMarketHook} from "../src/PFWAMarketHook.sol";
import {MarketResolver} from "../src/MarketResolver.sol";
import {FeeCollector, ISwapRouter02} from "../src/FeeCollector.sol";
import {OBMarketFactory} from "../src/OBMarketFactory.sol";
import {OBMarket} from "../src/OBMarket.sol";
import {ForwarderFactory} from "../src/IntentForwarder.sol";
import {PFWALimitOrders} from "../src/PFWALimitOrders.sol";

/// For the local demo only (intents/e2e/fork.sh): deploys the whole stack on an anvil fork of Robinhood Chain,
/// opens one market ("Will it rain tomorrow?", YES 60% / NO 40%) and seeds both pools with 10,000 complete sets.
/// The broadcaster must already hold enough USDG for the sets and the USDG side of the liquidity (the e2e script
/// lends it 200,000 from the PoolManager on the fork).
/// Env: PRIVATE_KEY, KEEPER (address).
contract DemoFork is Script {
    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    IERC20 constant USDG = IERC20(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168);
    address constant PFWA = 0xa934bA4F59070149d37A93F8A002Af79BAe35563;
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);

        bytes memory code = abi.encodePacked(type(PFWAMarketHook).creationCode, abi.encode(PM, USDG, me));
        PFWAMarketHook hook = new PFWAMarketHook{salt: _mine(keccak256(code))}(PM, USDG, me);
        FeeCollector collector = new FeeCollector(
            me, USDG, IERC20(PFWA), ISwapRouter02(address(1)), abi.encodePacked(address(USDG), uint24(3000), PFWA), me
        );
        MarketResolver resolver = new MarketResolver(USDG, me, vm.envAddress("KEEPER"), address(collector));
        OBMarketFactory factory = new OBMarketFactory(me, PM, hook, resolver, USDG, 1e6);
        PFWALimitOrders limits = new PFWALimitOrders(PM, hook);
        hook.setup(address(factory), address(collector), limits);
        resolver.setFactory(address(factory));
        ForwarderFactory forwarder = new ForwarderFactory(PM, factory, USDG);

        string[] memory names = new string[](2);
        names[0] = "YES";
        names[1] = "NO";
        uint16[] memory opening = new uint16[](2);
        opening[0] = 6_000;
        opening[1] = 4_000;
        USDG.approve(address(factory), type(uint256).max);
        uint256 marketId = factory.createMarket(
            OBMarketFactory.CreateParams({
                setupHash: keccak256("demo"),
                question: "Will it rain tomorrow?",
                outcomeNames: names,
                openingBps: opening,
                endOfTrading: uint64(block.timestamp + 7 days),
                creatorFeeBps: 100
            })
        );
        OBMarket market = factory.getMarket(marketId).market;
        PoolKey[] memory keys = factory.getPools(marketId);
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(PM);
        USDG.approve(address(market), type(uint256).max);
        market.mintSet(20_000e6, me);
        for (uint256 i; i < keys.length; ++i) {
            IERC20(Currency.unwrap(keys[i].currency0)).approve(address(lp), type(uint256).max);
            IERC20(Currency.unwrap(keys[i].currency1)).approve(address(lp), type(uint256).max);
            (int24 lower, int24 upper) = factory.priceBoundsInTicks(Currency.unwrap(keys[i].currency0) == address(USDG));
            lp.modifyLiquidity(
                keys[i],
                ModifyLiquidityParams({tickLower: ((lower / 10) + 1) * 10, tickUpper: (upper / 10) * 10, liquidityDelta: 2e9, salt: 0}),
                ""
            );
        }
        vm.stopBroadcast();

        console2.log("FACTORY", address(factory));
        console2.log("FORWARDER", address(forwarder));
        console2.log("LIMIT_ORDERS", address(limits));
        console2.log("RESOLVER", address(resolver));
        console2.log("MARKET_ID", marketId);
        console2.log("YES_TOKEN", address(market.outcomes(0)));
    }

    function _mine(bytes32 codeHash) internal view returns (bytes32) {
        for (uint256 salt; salt < 1_000_000; salt++) {
            address predicted = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, bytes32(salt), codeHash))))
            );
            if (uint160(predicted) & Hooks.ALL_HOOK_MASK == FLAGS && predicted.code.length == 0) return bytes32(salt);
        }
        revert("no salt found");
    }
}
