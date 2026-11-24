// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface ISaleBinding {
    function token() external view returns (address);
    function fundingAmount() external view returns (uint256);
    function owner() external view returns (address);
}

interface ITransferGovernance {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function getModulesPaginated(address start, uint256 pageSize) external view
        returns (address[] memory array, address next);
}

/// @notice Pre-release: supply is fixed at 20 million; launch addresses and review remain pending.
/// @dev All amounts are base units (18 decimals). No mint, burn or proxy entry point.
contract HRPToken is ERC20, Ownable2Step {
    uint256 public constant TOTAL_SUPPLY = 20_000_000 * 1e18;
    address public immutable companyVault;
    address public immutable reserveVault;
    uint256 public immutable initialSupply;
    uint256 public immutable reserveAmount;
    address public sale;
    address public buybackOperator;
    bool public buybackConfigured;
    bool public transfersEnabled;
    uint256 public transfersEnabledAt;
    uint256 public transfersFrozenAt;
    uint256 public transferPolicyRevision;

    error InvalidConfiguration();
    error TransfersLocked();
    error SaleAlreadyBound();
    error UnauthorizedRoute();
    error InvalidRecipient();
    error GovernanceRequired();
    error BuybackAlreadyConfigured();
    error TransferStateUnchanged();
    error StaleTransferPolicy();

    event TransferPolicyChanged(address indexed governance, bool enabled, uint256 revision, uint256 timestamp);
    event SaleBound(address indexed sale, uint256 fundedHRP);
    event BuybackOperatorConfigured(address indexed operator);
    event BuybackOperatorDisabled(address indexed operator);
    event BuybackSettlement(address indexed holder, address indexed operator, uint256 amount);

    constructor(string memory tokenName, uint256 supply, address company,
        address reserve, uint256 reserved, address administrator)
        ERC20(tokenName, "HRP") Ownable(administrator)
    {
        if (bytes(tokenName).length == 0 || company == address(0) || reserve == address(0)
            || company == reserve || company == address(this) || reserve == address(this)
            || supply != TOTAL_SUPPLY || reserved >= supply || supply % 1e18 != 0 || reserved % 1e18 != 0)
            revert InvalidConfiguration();
        companyVault = company;
        reserveVault = reserve;
        initialSupply = supply;
        reserveAmount = reserved;
        _mint(company, supply - reserved);
        if (reserved != 0) _mint(reserve, reserved);
    }

    /// @notice One-time funding of the paired sale; no general treasury transfer privilege.
    function initializeSale(address target) external onlyOwner {
        if (sale != address(0)) revert SaleAlreadyBound();
        if (target.code.length == 0 || target == address(this) || target == companyVault
            || target == reserveVault) revert InvalidConfiguration();
        ISaleBinding candidate = ISaleBinding(target);
        uint256 budget = candidate.fundingAmount();
        if (candidate.token() != address(this) || candidate.owner() != owner() || budget == 0)
            revert InvalidConfiguration();
        sale = target;
        // Bypass the universal transfer lock only for this exact, one-time route.
        super._update(companyVault, target, budget);
        emit SaleBound(target, budget);
    }

    /// @notice Only the bound sale can deliver purchased HRP to its buyer.
    function deliver(address buyer, uint256 amount) external {
        if (msg.sender != sale || sale == address(0)) revert UnauthorizedRoute();
        if (buyer == address(0) || buyer == address(this) || buyer == sale
            || buyer == companyVault || buyer == reserveVault || amount == 0) revert InvalidRecipient();
        super._update(sale, buyer, amount);
    }

    /// @notice Optional future hook. The buyback payment contract is outside this version.
    /// @dev One operator may be configured once; disable is permanent. Holders must approve it.
    function configureBuybackOperator(address operator) external onlyOwner {
        if (buybackConfigured) revert BuybackAlreadyConfigured();
        if (sale == address(0) || operator.code.length == 0 || operator == sale
            || operator == address(this) || operator == companyVault || operator == reserveVault)
            revert InvalidConfiguration();
        buybackConfigured = true;
        buybackOperator = operator;
        emit BuybackOperatorConfigured(operator);
    }

    function disableBuybackOperator() external onlyOwner {
        address previous = buybackOperator;
        buybackConfigured = true;
        buybackOperator = address(0);
        emit BuybackOperatorDisabled(previous);
    }

    /// @notice Holder consent is required; destination is always companyVault.
    function settleBuyback(address holder, uint256 amount) external {
        if (msg.sender != buybackOperator || buybackOperator == address(0)) revert UnauthorizedRoute();
        if (holder == address(0) || holder == companyVault || holder == reserveVault
            || holder == sale || holder == address(this) || amount == 0) revert InvalidRecipient();
        _spendAllowance(holder, msg.sender, amount);
        super._update(holder, companyVault, amount);
        emit BuybackSettlement(holder, msg.sender, amount);
    }

    /// @notice Enable ordinary transfers until a subsequent two-signature freeze.
    function enableTransfers(uint256 expectedRevision) external onlyOwner {
        _setTransfersEnabled(true, expectedRevision);
    }

    /// @notice Freeze ordinary transfers. Primary delivery and consented buyback are separate routes.
    function disableTransfers(uint256 expectedRevision) external onlyOwner {
        _setTransfersEnabled(false, expectedRevision);
    }

    /// @dev Both directions require the same reviewed two-of-two governance.
    ///      The revision invalidates a prepared action after any intervening state change.
    function _setTransfersEnabled(bool enabled, uint256 expectedRevision) private {
        if (expectedRevision != transferPolicyRevision) revert StaleTransferPolicy();
        if (transfersEnabled == enabled) revert TransferStateUnchanged();
        if (sale == address(0) || owner().code.length == 0) revert GovernanceRequired();
        ITransferGovernance governance = ITransferGovernance(owner());
        address[] memory owners = governance.getOwners();
        (address[] memory modules, address next) = governance.getModulesPaginated(address(1), 1);
        if (governance.getThreshold() != 2 || owners.length != 2
            || owners[0] == address(0) || owners[1] == address(0) || owners[0] == owners[1]
            || modules.length != 0 || next != address(1)) revert GovernanceRequired();
        transfersEnabled = enabled;
        transferPolicyRevision++;
        if (enabled) transfersEnabledAt = block.timestamp;
        else transfersFrozenAt = block.timestamp;
        emit TransferPolicyChanged(msg.sender, enabled, transferPolicyRevision, block.timestamp);
    }

    /// @dev While frozen, even owner/system accounts cannot transfer normally.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && !transfersEnabled) revert TransfersLocked();
        super._update(from, to, value);
    }

    function renounceOwnership() public view override onlyOwner { revert GovernanceRequired(); }
}
