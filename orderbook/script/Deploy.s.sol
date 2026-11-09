// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PFWAMarketHook, ITickMoveListener} from "../src/PFWAMarketHook.sol";
import {MarketResolver} from "../src/MarketResolver.sol";
import {FeeCollector, ISwapRouter02} from "../src/FeeCollector.sol";
import {OBMarketFactory} from "../src/OBMarketFactory.sol";
import {ForwarderFactory} from "../src/IntentForwarder.sol";
import {PFWALimitOrders} from "../src/PFWALimitOrders.sol";

/// Deploys the order book markets stack on Robinhood Chain.
///
/// Env: OWNER (multisig: factory owner, settles disputes), RESOLVER_BOT, KEEPER, TREASURY,
///      USDG, PFWA, SWAP_ROUTER (V3 SwapRouter02), BUYBACK_PATH (hex V3 path USDG→…→PFWA),
///      CREATION_FEE (USDG, 6 decimals), DEPOSIT_CAP (USDG per market, 6 decimals; 0 = none)
///
/// The broadcasting wallet comes from the command line (--private-key, --ledger, or --unlocked --sender on a fork):
///   forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --sender <deployer> <wallet flag>
contract Deploy is Script {
    IPoolManager constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    /// Foundry's default CREATE2 deployer, used to mine the hook's address.
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    function run() external {
        IERC20 usdg = IERC20(vm.envAddress("USDG"));
        vm.startBroadcast();
        address me = msg.sender;

        // The hook's address must carry its permission bits, so mine a CREATE2 salt.
        // The broadcasting wallet is the hook's deployer (it calls setup once below).
        bytes memory code = abi.encodePacked(type(PFWAMarketHook).creationCode, abi.encode(POOL_MANAGER, usdg, me));
        bytes32 salt = _mine(keccak256(code));
        PFWAMarketHook hook = new PFWAMarketHook{salt: salt}(POOL_MANAGER, usdg, me);

        FeeCollector collector = new FeeCollector(
            me,
            usdg,
            IERC20(vm.envAddress("PFWA")),
            ISwapRouter02(vm.envAddress("SWAP_ROUTER")),
            vm.envBytes("BUYBACK_PATH"),
            vm.envAddress("TREASURY")
        );
        collector.setKeeper(vm.envAddress("KEEPER"));
        collector.transferOwnership(vm.envAddress("OWNER"));

        // The owner multisig settles disputes; the resolver bot (the markets' relayer) resolves from data sources.
        MarketResolver resolver =
            new MarketResolver(usdg, vm.envAddress("OWNER"), vm.envAddress("RESOLVER_BOT"), address(collector));
        // Deployed owned by the broadcaster so the launch cap can be set, then handed to the multisig.
        OBMarketFactory factory =
            new OBMarketFactory(me, POOL_MANAGER, hook, resolver, usdg, vm.envUint("CREATION_FEE"));
        factory.setDepositCap(vm.envUint("DEPOSIT_CAP"));
        factory.transferOwnership(vm.envAddress("OWNER"));
        PFWALimitOrders limits = new PFWALimitOrders(POOL_MANAGER, hook);
        hook.setup(address(factory), address(collector), limits);
        resolver.setFactory(address(factory));
        ForwarderFactory forwarder = new ForwarderFactory(POOL_MANAGER, factory, usdg);

        vm.stopBroadcast();
        console2.log("hook", address(hook));
        console2.log("feeCollector", address(collector));
        console2.log("resolver", address(resolver));
        console2.log("factory", address(factory));
        console2.log("forwarder", address(forwarder));
        console2.log("limitOrders", address(limits));
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
