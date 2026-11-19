// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {LockraArena} from "../src/LockraArena.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @notice Deploys LOCKRA Arena.
///
/// Every value comes from the environment so nothing secret lives in the repo:
///   ARENA_TOKEN          stake token address ($LOCKRA)
///   ARENA_OWNER          owner address (defaults to the deployer)
///   ARENA_FEE_BPS        fee in basis points, burned from each won pot (default 250 = 2.5%)
///   ARENA_REVEAL_WINDOW  seconds to reveal after a challenger joins (default 3600)
///   ARENA_MIN_STAKE      smallest stake in whole tokens (default 10000)
///   ARENA_MAX_STAKE      largest stake in whole tokens (default 5000000)
///
/// Run with a hardware wallet or an encrypted keystore, never a raw private key:
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --account lockra-deployer --broadcast
contract Deploy is Script {
    function run() external returns (LockraArena arena) {
        address token = vm.envAddress("ARENA_TOKEN");
        address owner = vm.envOr("ARENA_OWNER", msg.sender);
        uint16 feeBps = uint16(vm.envOr("ARENA_FEE_BPS", uint256(250)));
        uint32 window = uint32(vm.envOr("ARENA_REVEAL_WINDOW", uint256(1 hours)));
        uint128 minStake = uint128(vm.envOr("ARENA_MIN_STAKE", uint256(10_000)) * 1e18);
        uint128 maxStake = uint128(vm.envOr("ARENA_MAX_STAKE", uint256(5_000_000)) * 1e18);

        vm.startBroadcast();
        arena = new LockraArena(IERC20(token), owner, feeBps, window, minStake, maxStake);
        vm.stopBroadcast();

        console2.log("LOCKRA Arena deployed at", address(arena));
    }
}
