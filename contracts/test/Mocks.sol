// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {HRPToken} from "../HRPToken.sol";

// TEST ONLY. Unrestricted helpers intentionally simulate abnormal external contracts.
contract MockUSDT is ERC20 {
    uint8 private immutable precision;
    uint8 public mode;
    address public reentryTarget;
    bytes public reentryPayload;
    bool public reentrySucceeded;
    bytes public reentryResult;
    constructor(uint8 decimals_) ERC20("Mock USDT", "mUSDT") { precision = decimals_; }
    function decimals() public view override returns (uint8) { return precision; }
    function mint(address wallet, uint256 amount) external { _mint(wallet, amount); }
    function setMode(uint8 value) external { mode = value; }
    function setReentry(address target, bytes calldata payload) external {
        reentryTarget = target; reentryPayload = payload;
    }
    function transferFrom(address from, address to, uint256 amount) public override returns(bool) {
        if(mode == 1) return false;
        if(mode == 2) { super.transferFrom(from, to, amount - 1); return true; }
        if(mode == 3 || mode == 4) {
            (bool ok, bytes memory result) = reentryTarget.call(reentryPayload);
            reentrySucceeded = ok; reentryResult = result;
            if(mode == 4 && !ok) assembly ("memory-safe") { revert(add(result,32),mload(result)) }
        }
        bool success = super.transferFrom(from,to,amount);
        if(mode == 5) assembly ("memory-safe") { return(0,0) }
        return success;
    }
}
contract MockBuybackOperator {
    HRPToken public immutable token;
    constructor(HRPToken token_) { token = token_; }
    function settle(address holder,uint256 amount) external { token.settleBuyback(holder,amount); }
}
contract MockFailingHRP is ERC20 {
    address public immutable companyVault;
    address public immutable reserveVault;
    address public sale;
    error DeliberateDeliveryFailure();
    constructor(address company,address reserve) ERC20("Mock failing HRP","mHRP") {
        companyVault=company; reserveVault=reserve;
    }
    function bind(address target,uint256 balance) external { sale=target; _mint(target,balance); }
    function deliver(address,uint256) external pure { revert DeliberateDeliveryFailure(); }
}
