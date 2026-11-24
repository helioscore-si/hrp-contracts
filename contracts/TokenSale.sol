// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {HRPToken, ITransferGovernance} from "./HRPToken.sol";

/// @notice Pre-release sale. Source rule: first cumulative threshold, then bonus on new purchases.
contract TokenSale is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant HRP_PER_LOT = 100e18;
    uint256 public constant BONUS_THRESHOLD_LOTS = 10;
    uint256 private constant BPS = 10_000;
    uint8 public constant ROUND_COUNT = 5;

    struct Setup {
        address administrator;
        address paymentToken;
        address treasury;
        address hrp;
        uint8 paymentDecimals;
        uint64 closesAt;
        uint256 inventory;
    }
    struct Buyer { uint256 paidLots; uint256 paidUSDT; uint256 bonusHRP; }
    struct Quote { uint256 paidUSDT; uint256 paidHRP; uint256 bonusHRP; uint256 totalHRP; uint8 round; }

    HRPToken public immutable token;
    IERC20 public immutable paymentToken;
    address public immutable initialTreasury;
    address public treasury;
    uint256 public treasuryRevision;
    uint64 public immutable closesAt;
    uint8 public immutable paymentDecimals;
    uint256 public immutable usdtPerLot;
    uint256 public immutable fundingAmount;
    uint256 public immutable requiredInventory;
    uint8 public currentRound;
    uint256[5] public roundCapsLots;
    uint16[5] public bonusRatesBps;
    uint256[5] public soldLots;
    mapping(address => bool) public eligible;
    mapping(address => bool) public admissionBlocked;
    address public admissionSigner;
    uint256 public admissionRevision;
    struct PurchaseAuthorization {
        address buyer; uint256 lots; uint8 expectedRound; bytes32 orderId;
        uint64 deadline; uint256 minHRPOut; uint256 revision;
    }
    bytes32 private constant PURCHASE_TYPEHASH = keccak256(
        "PurchaseAuthorization(address buyer,uint256 lots,uint8 expectedRound,bytes32 orderId,uint64 deadline,uint256 minHRPOut,uint256 revision)"
    );
    // Static EIP-712 domain; recomputed chain ID also prevents fork replay.
    // Kept Paris-compatible: OZ 5.6 EIP712 imports Cancun-only Bytes helpers.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("HELIOS TokenSale"), keccak256("1"), block.chainid, address(this)));
    }
    error InvalidAuthorization();
    event AdmissionSignerChanged(address indexed signer, uint256 revision);

    /// @notice Safe sets a limited portal signer once; buyers need no Safe signatures.
    /// @dev Revision invalidates every outstanding authorization, even on same-key rotation.
    function setAdmissionSigner(address signer, uint256 expectedRevision) external onlyOwner {
        _requireGovernance();
        if (expectedRevision != admissionRevision) revert InvalidConfiguration();
        if (signer != address(0)) {
            if (signer == owner() || signer == treasury || signer == address(this)
                || signer == address(token) || signer == address(paymentToken)
                || signer == token.companyVault() || signer == token.reserveVault()
                || signer.code.length != 0 || eligible[signer]) revert InvalidConfiguration();
            address[] memory governingOwners = ITransferGovernance(owner()).getOwners();
            if (signer == governingOwners[0] || signer == governingOwners[1]) revert InvalidConfiguration();
        }
        admissionSigner = signer;
        admissionRevision++;
        emit AdmissionSignerChanged(signer, admissionRevision);
    }

    function _automaticBuyer(address buyer) private view returns (bool) {
        return buyer != address(0) && !admissionBlocked[buyer]
            && buyer != owner() && buyer != treasury && buyer != address(this)
            && buyer != address(token) && buyer != address(paymentToken)
            && buyer != token.companyVault() && buyer != token.reserveVault()
            && buyer != admissionSigner && buyer != settlementOperator;
    }

    function _requireExternalAdmission(address buyer) private view {
        if (admissionBlocked[buyer] || (!eligible[buyer]
            && !(admissionSigner != address(0) && msg.sender == admissionSigner && _automaticBuyer(buyer))))
            revert NotEligible();
    }

    function buyAuthorized(PurchaseAuthorization calldata a, bytes calldata signature)
        external nonReentrant whenNotPaused
    {
        if (admissionSigner == address(0) || a.buyer != msg.sender || !_automaticBuyer(msg.sender)
            || a.revision != admissionRevision || a.deadline > block.timestamp + 10 minutes)
            revert InvalidAuthorization();
        bytes32 structHash = keccak256(abi.encode(PURCHASE_TYPEHASH, a.buyer, a.lots,
            a.expectedRound, a.orderId, a.deadline, a.minHRPOut, a.revision));
        if (ECDSA.recover(keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash)), signature) != admissionSigner)
            revert InvalidAuthorization();
        _buy(a.lots, a.expectedRound, a.orderId, a.deadline, a.minHRPOut);
    }

    mapping(address => Buyer) public buyers;
    mapping(address => mapping(bytes32 => bool)) public usedOrders;

    // Source-chain payments are attested by a narrowly scoped service signer.
    // No bridge and no source-chain USDT custody in this BSC contract.
    struct ExternalOrder {
        address buyer; uint256 lots; uint256 paidHRP; uint256 bonusHRP;
        uint256 sourceMicros; bytes32 recipientHash;
        uint64 createdAt; uint64 deadline; uint64 settleUntil;
        uint8 round; uint8 source; uint8 state; // 1 reserved, 2 delivered, 3 expired
    }
    address public settlementOperator;
    uint256 public settlementRevision;
    uint256 public externalLotLimit;
    uint256 public externalCommittedLots;
    uint256 public reservedHRP;
    uint256[5] public reservedLots;
    mapping(bytes32 => ExternalOrder) private externalOrders;
    mapping(address => bytes32) public activeExternal;
    mapping(bytes32 => bool) public usedSourcePayments;
    error ExternalPaymentInvalid();
    error ExternalOrderActive();
    error OperatorRequired();
    event SettlementOperatorChanged(address indexed operator, uint256 lotLimit, uint256 revision);
    event ExternalReserved(bytes32 indexed orderId, address indexed buyer, uint8 source, uint64 deadline);
    event ExternalExpired(bytes32 indexed orderId);
    event ExternalSettled(bytes32 indexed orderId, bytes32 indexed paymentId, uint8 source,
        bytes32 sourceTx, uint256 logIndex, uint256 sourceMicros, bytes32 recipientHash, uint64 paidAt);

    modifier onlyOperator() {
        if (msg.sender != settlementOperator || msg.sender == address(0)) revert OperatorRequired();
        _;
    }

    function externalOrder(bytes32 orderId) external view returns (ExternalOrder memory) {
        return externalOrders[orderId];
    }

    /// @notice Both Safe owners approve the service and its cumulative sales budget.
    /// @dev Zero address disables it. Budget includes delivered and reserved lots.
    function setSettlementOperator(address operator, uint256 lotLimit, uint256 revision) external onlyOwner {
        _requireGovernance();
        if (revision != settlementRevision || lotLimit < externalCommittedLots
            || lotLimit > _totalCap() || operator == owner() || operator == treasury
            || operator == address(this) || operator == address(token)
            || operator == token.companyVault() || operator == token.reserveVault()
            || operator == address(paymentToken) || eligible[operator]) revert InvalidConfiguration();
        address[] memory governingOwners = ITransferGovernance(owner()).getOwners();
        if (operator == governingOwners[0] || operator == governingOwners[1]) revert InvalidConfiguration();
        settlementOperator = operator;
        externalLotLimit = lotLimit;
        settlementRevision++;
        emit SettlementOperatorChanged(operator, lotLimit, settlementRevision);
    }

    function _totalCap() private view returns (uint256 n) {
        for (uint8 i; i < ROUND_COUNT; ++i) n += roundCapsLots[i];
    }

    /// @notice Reserve BEFORE displaying payment instructions. The quote cannot change
    /// while this buyer has a reservation, including when the round advances.
    function reserveExternal(bytes32 orderId, address buyer, uint256 lots, uint8 expectedRound,
        uint8 source, bytes32 recipientHash, uint256 sourceMicros, uint64 deadline)
        external onlyOperator nonReentrant whenNotPaused
    {
        _requireExternalAdmission(buyer);
        if (block.timestamp >= closesAt) revert SaleClosed();
        if (expectedRound != currentRound) revert StaleRound();
        if (activeExternal[buyer] != bytes32(0)) revert ExternalOrderActive();
        if (orderId == bytes32(0) || externalOrders[orderId].state != 0 || usedOrders[buyer][orderId]) revert InvalidOrder();
        // 1 = Ethereum mainnet USDT, 2 = TRON mainnet USDT. Both have 6 decimals.
        // A disclosed <= 0.009999 USDT matching tag does not purchase additional HRP.
        if ((source != 1 && source != 2) || recipientHash == bytes32(0)
            || deadline <= block.timestamp || deadline > block.timestamp + 30 minutes || deadline > closesAt
            || sourceMicros <= lots * 100e6 || sourceMicros > lots * 100e6 + 9999)
            revert ExternalPaymentInvalid();
        Quote memory q = quote(buyer, lots);
        _checkCapacity(q, lots);
        if (externalCommittedLots + lots > externalLotLimit) revert RoundCapExceeded();
        externalOrders[orderId] = ExternalOrder(buyer,lots,q.paidHRP,q.bonusHRP,sourceMicros,
            recipientHash,uint64(block.timestamp),deadline,deadline + 7 days,q.round,source,1);
        activeExternal[buyer] = orderId;
        reservedLots[q.round] += lots;
        reservedHRP += q.totalHRP;
        externalCommittedLots += lots;
        emit ExternalReserved(orderId,buyer,source,deadline);
    }

    /// @dev Only actual, finalized source transfers may be attested. On-chain code
    /// cannot independently verify TRON/Ethereum. Service compromise is a trust risk.
    function settleExternal(bytes32 orderId, bytes32 sourceTx, uint256 logIndex, uint64 paidAt)
        external onlyOperator nonReentrant whenNotPaused
    {
        ExternalOrder storage o = externalOrders[orderId];
        if (o.state != 1 || sourceTx == bytes32(0) || paidAt < o.createdAt || paidAt > o.deadline
            || paidAt > block.timestamp || block.timestamp > o.settleUntil) revert ExternalPaymentInvalid();
        _requireExternalAdmission(o.buyer);
        bytes32 paymentId = keccak256(abi.encode(o.source,sourceTx,logIndex));
        if (usedSourcePayments[paymentId] || usedOrders[o.buyer][orderId]) revert InvalidOrder();
        usedSourcePayments[paymentId] = true;
        _releaseReservation(o);
        o.state = 2;
        Quote memory q = Quote(o.lots * usdtPerLot,o.paidHRP,o.bonusHRP,o.paidHRP + o.bonusHRP,o.round);
        _book(o.buyer,orderId,o.lots,q);
        token.deliver(o.buyer,q.totalHRP);
        emit ExternalSettled(orderId,paymentId,o.source,sourceTx,logIndex,o.sourceMicros,o.recipientHash,paidAt);
        emit Purchased(o.buyer,orderId,o.round,o.lots,q.paidUSDT,q.paidHRP,q.bonusHRP);
    }

    /// @notice Release an unpaid invoice only after the service has scanned a
    /// finalized source interval beyond the full payment window.
    function expireUnpaidExternal(bytes32 orderId, uint64 sourceFinalizedAt) external onlyOperator nonReentrant {
        ExternalOrder storage o = externalOrders[orderId];
        if (o.state != 1 || sourceFinalizedAt <= o.deadline || sourceFinalizedAt > block.timestamp
            || block.timestamp <= o.deadline) revert ExternalPaymentInvalid();
        _releaseReservation(o);
        externalCommittedLots -= o.lots;
        o.state = 3;
        emit ExternalExpired(orderId);
    }

    // No early cancellation: a transfer may already be waiting for finality.
    function expireExternal(bytes32 orderId) external nonReentrant {
        ExternalOrder storage o = externalOrders[orderId];
        if (o.state != 1 || block.timestamp <= o.settleUntil) revert ExternalPaymentInvalid();
        _releaseReservation(o);
        externalCommittedLots -= o.lots;
        o.state = 3;
        emit ExternalExpired(orderId);
    }

    function _releaseReservation(ExternalOrder storage o) private {
        activeExternal[o.buyer] = bytes32(0);
        reservedLots[o.round] -= o.lots;
        reservedHRP -= o.paidHRP + o.bonusHRP;
    }

    function _requireGovernance() private view {
        if (token.sale() != address(this) || token.owner() != owner() || owner().code.length == 0)
            revert GovernanceRequired();
        ITransferGovernance governance = ITransferGovernance(owner());
        address[] memory owners = governance.getOwners();
        (address[] memory modules, address next) = governance.getModulesPaginated(address(1), 1);
        if (governance.getThreshold() != 2 || owners.length != 2
            || owners[0] == address(0) || owners[1] == address(0) || owners[0] == owners[1]
            || modules.length != 0 || next != address(1)) revert GovernanceRequired();
    }

    function _checkCapacity(Quote memory q, uint256 lots) private view {
        if (soldLots[q.round] + reservedLots[q.round] + lots > roundCapsLots[q.round]) revert RoundCapExceeded();
        if (token.balanceOf(address(this)) < reservedHRP + q.totalHRP) revert InsufficientInventory();
    }

    function _book(address wallet, bytes32 orderId, uint256 lots, Quote memory q) private {
        usedOrders[wallet][orderId] = true;
        soldLots[q.round] += lots;
        Buyer storage buyer = buyers[wallet];
        buyer.paidLots += lots;
        buyer.paidUSDT += q.paidUSDT;
        buyer.bonusHRP += q.bonusHRP;
    }

    error InvalidConfiguration();
    error UnfundedPlan(uint256 required, uint256 supplied);
    error NotEligible();
    error SaleClosed();
    error QuoteExpired();
    error StaleRound();
    error InvalidOrder();
    error InvalidLots();
    error RoundCapExceeded();
    error InsufficientInventory();
    error MinimumOutputNotMet();
    error UnexpectedPaymentAmount();
    error SaleNotBound();
    error LastRound();
    error GovernanceRequired();
    error StaleTreasury();
    error TreasuryUnchanged();

    event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury, uint256 revision);
    event PaymentRouted(bytes32 indexed orderId, address indexed buyer, address indexed treasury,
        uint256 paidUSDT, uint256 revision);
    event EligibilityChanged(address indexed wallet, bool admitted);
    event RoundAdvanced(uint8 indexed previousRound, uint8 indexed newRound);
    event Purchased(address indexed buyer, bytes32 indexed orderId, uint8 indexed round,
        uint256 lots, uint256 paidUSDT, uint256 paidHRP, uint256 bonusHRP);

    constructor(Setup memory setup, uint256[5] memory capsLots, uint16[5] memory ratesBps)
        Ownable(setup.administrator)
    {
        if (setup.hrp.code.length == 0 || setup.paymentToken.code.length == 0
            || setup.hrp == setup.paymentToken || setup.administrator == setup.paymentToken
            || setup.administrator == setup.hrp || setup.administrator == address(this)
            || setup.treasury == address(0)
            || setup.treasury == address(this) || setup.treasury == setup.hrp
            || setup.treasury == setup.paymentToken || setup.closesAt <= block.timestamp
            || setup.paymentDecimals > 18
            || IERC20Metadata(setup.paymentToken).decimals() != setup.paymentDecimals)
            revert InvalidConfiguration();
        token = HRPToken(setup.hrp);
        paymentToken = IERC20(setup.paymentToken);
        treasury = setup.treasury;
        initialTreasury = setup.treasury;
        closesAt = setup.closesAt;
        paymentDecimals = setup.paymentDecimals;
        usdtPerLot = 100 * (10 ** setup.paymentDecimals);
        fundingAmount = setup.inventory;
        uint256 required;
        for (uint8 i = 0; i < ROUND_COUNT; ++i) {
            if (capsLots[i] == 0 || ratesBps[i] > BPS || (i > 0 && ratesBps[i] > ratesBps[i-1]))
                revert InvalidConfiguration();
            uint256 paid = capsLots[i] * HRP_PER_LOT;
            required += paid + paid * ratesBps[i] / BPS;
        }
        // With non-increasing rates, delayed threshold bonuses cannot exceed this bound.
        if (setup.inventory < required) revert UnfundedPlan(required, setup.inventory);
        requiredInventory = required;
        roundCapsLots = capsLots;
        bonusRatesBps = ratesBps;
        _pause();
    }

    /// @notice Redirect future USDT payments. Existing funds and HRP balances do not move.
    /// @dev A revision prevents execution of an obsolete prepared change, including A -> B -> A.
    function setTreasury(address nextTreasury, uint256 expectedRevision) external onlyOwner nonReentrant {
        if (expectedRevision != treasuryRevision) revert StaleTreasury();
        if (nextTreasury == treasury) revert TreasuryUnchanged();
        if (nextTreasury == address(0) || nextTreasury == address(this)
            || nextTreasury == address(token) || nextTreasury == address(paymentToken)
            || nextTreasury == settlementOperator || nextTreasury == admissionSigner || eligible[nextTreasury]) revert InvalidConfiguration();
        _requireGovernance();
        address previous = treasury;
        treasury = nextTreasury;
        treasuryRevision++;
        emit TreasuryChanged(previous, nextTreasury, treasuryRevision);
    }

    function setEligible(address wallet, bool admitted) external onlyOwner {
        if (wallet == address(0) || wallet == treasury || wallet == address(token)
            || wallet == address(this) || wallet == token.companyVault()
            || wallet == token.reserveVault() || wallet == address(paymentToken) || wallet == settlementOperator || wallet == admissionSigner) revert InvalidConfiguration();
        eligible[wallet] = admitted;
        admissionBlocked[wallet] = !admitted;
        emit EligibilityChanged(wallet, admitted);
    }

    function advanceRound() external onlyOwner {
        if (block.timestamp >= closesAt) revert SaleClosed();
        uint8 previous = currentRound;
        if (previous == ROUND_COUNT - 1) revert LastRound();
        currentRound = previous + 1;
        emit RoundAdvanced(previous, currentRound);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner {
        if (token.sale() != address(this)) revert SaleNotBound();
        // New purchases still enforce closesAt; old paid reservations can finish.
        _unpause();
    }

    /// @notice Calculation only: admission, deadlines and inventory are checked again by buy.
    function quote(address buyer, uint256 lots) public view returns (Quote memory q) {
        if (lots == 0) revert InvalidLots();
        uint256 previous = buyers[buyer].paidLots;
        uint256 cumulative = previous + lots;
        uint256 bonusLots = cumulative < BONUS_THRESHOLD_LOTS ? 0
            : previous < BONUS_THRESHOLD_LOTS ? cumulative : lots;
        q.round = currentRound;
        q.paidUSDT = lots * usdtPerLot;
        q.paidHRP = lots * HRP_PER_LOT;
        q.bonusHRP = bonusLots * HRP_PER_LOT * bonusRatesBps[currentRound] / BPS;
        q.totalHRP = q.paidHRP + q.bonusHRP;
    }

    function buy(uint256 lots, uint8 expectedRound, bytes32 orderId, uint64 deadline,
        uint256 minHRPOut) external nonReentrant whenNotPaused
    {
        if (!eligible[msg.sender] || admissionBlocked[msg.sender]) revert NotEligible();
        _buy(lots, expectedRound, orderId, deadline, minHRPOut);
    }

    function _buy(uint256 lots, uint8 expectedRound, bytes32 orderId, uint64 deadline,
        uint256 minHRPOut) private
    {
        if (activeExternal[msg.sender] != bytes32(0)) revert ExternalOrderActive();
        if (block.timestamp >= closesAt) revert SaleClosed();
        if (block.timestamp > deadline) revert QuoteExpired();
        if (expectedRound != currentRound) revert StaleRound();
        if (orderId == bytes32(0) || usedOrders[msg.sender][orderId]) revert InvalidOrder();
        Quote memory q = quote(msg.sender, lots);
        _checkCapacity(q, lots);
        if (q.totalHRP < minHRPOut) revert MinimumOutputNotMet();
        _book(msg.sender, orderId, lots, q);

        address recipient = treasury;
        uint256 beforePayment = paymentToken.balanceOf(recipient);
        paymentToken.safeTransferFrom(msg.sender, recipient, q.paidUSDT);
        if (paymentToken.balanceOf(recipient) != beforePayment + q.paidUSDT)
            revert UnexpectedPaymentAmount();
        token.deliver(msg.sender, q.totalHRP);
        emit PaymentRouted(orderId, msg.sender, recipient, q.paidUSDT, treasuryRevision);
        emit Purchased(msg.sender, orderId, q.round, lots, q.paidUSDT, q.paidHRP, q.bonusHRP);
    }

    function renounceOwnership() public view override onlyOwner { revert GovernanceRequired(); }
}
