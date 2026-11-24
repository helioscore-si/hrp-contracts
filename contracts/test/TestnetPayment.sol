// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
/// @notice Valueless payment asset for isolated rehearsals. Cannot deploy on mainnet.
contract TestnetPayment is ERC20 {
    constructor(address buyer) ERC20("HRP Test Payment (no value)", "tUSDT") {
        require(block.chainid == 97 || block.chainid == 31337, "TEST_NETWORK_ONLY");
        _mint(buyer, 1_000_000 * 1e18);
    }
}
