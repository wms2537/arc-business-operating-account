// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// IBusinessKernel — public interface for the immutable USDC custody and settlement kernel.
// Design decisions:
//  - PlanTerms fully specified at creation; no field can change afterwards.
//  - Join authorises the caller's pre-named participation; cannot alter terms.
//  - cash = total funded claim; available = cash - floor - aggregateHeld.
//  - One lender pool per kernel, created at construction; no runtime pool creation path.
//  - Capacity reserved at join, consumed at commit.
//  - Readiness always derived from live state; no stored READY flag.

// Custom errors — 4-byte selectors, ~28 bytes saved per revert vs string messages
error BK_ZeroUSDC();
error BK_ZeroLender();
/// @dev Emitted when the actual token receipt does not equal the declared amount.
error BK_TransferReceiptMismatch();
error BK_AccountExists();
error BK_NotAccountOwner();
error BK_NotPoolOwner();
error BK_NotOfferOwner();
error BK_NotBorrowerOwner();
error BK_PlanNotFound();
error BK_PlanNotOpen();
error BK_PlanExpired();
error BK_ZeroAmount();
error BK_ZeroTo();
error BK_InsufficientAvailableCash();
error BK_ActiveParticipations();
error BK_OutstandingDebt();
error BK_FloorIncreaseUnbacked();
error BK_BorrowerNotFound();
error BK_LimitBelowBookedUsage();
error BK_ZeroPayee();
error BK_ZeroPrice();
error BK_ZeroCapacity();
error BK_InvalidMinimumFill();
error BK_BelowMinimumFill();
error BK_OfferExpiredAtCreation();
error BK_AlreadyRevoked();
error BK_ExpiryInPast();
error BK_BadOfferRefsCount();
error BK_BadBuyersCount();
error BK_CP1OfferRef();
error BK_CO2OfferRefs();
error BK_COUseSaleParty();
error BK_ZeroBuyerOwner();
error BK_BuyerAccountNotFound();
error BK_BuyerOwnerMismatch();
error BK_ZeroBuyerQuantity();
error BK_DrawExceedsLimit();
error BK_BuyerSourcesAllocation();
error BK_DuplicateBuyerAccount();
error BK_BuyerQtySumMismatch();
error BK_ZeroMerchantOwner();
error BK_MerchantAccountNotFound();
error BK_MerchantOwnerMismatch();
error BK_ZeroCustomer();
error BK_ZeroRequiredEscrow();
error BK_SaleValueMustExceedEscrow();
error BK_DuplicateOfferRefs();
error BK_PoolNotFound();
error BK_PoolNotActive();
error BK_OfferNotFound();
error BK_OfferRevoked();
error BK_PayeeMismatch();
error BK_ZeroOfferQuantity();
error BK_NoLenderPlanApproval();
error BK_AggregateDrawExceedsBorrowerLimit();
error BK_NoSupplierPlanApproval();
error BK_OfferInvalid();
error BK_GoodsPayeeChanged();
error BK_FreightPayeeChanged();
error BK_InsufficientBuyerCash();
error BK_InsufficientPoolLiquidity();
error BK_OfferCapacityExceeded();
error BK_AlreadyJoined();
error BK_NotTheNamedBuyer();
error BK_NotTheNamedMerchant();
error BK_NotTheNamedCustomer();
error BK_EscrowAlreadyConsumed();
error BK_EscrowAlreadyFunded();
error BK_IndexOutOfRange();
error BK_NotJoined();
error BK_NoLenderPool();
error BK_InvalidIndexForCO();
error BK_BuyerNotJoined();
error BK_QuantityMismatch();
error BK_MerchantNotJoined();
error BK_EscrowNotFullyFunded();
error BK_EscrowWithdrawn();
error BK_WrongCustomer();
error BK_SourcesNeqPayout();
error BK_NotAParty();
error BK_NotCommitted();
error BK_AlreadyAcknowledged();
error BK_GoodsNotAcknowledged();
error BK_FreightNotAcknowledged();
error BK_AlreadyAccepted();
error BK_AcceptanceRequired();
error BK_ZeroBalance();
error BK_ExceedsRemainingBalance();
error BK_ReceiptRefUsed();
error BK_ReceivableExists();
error BK_ZeroPayer();
error BK_NotBeneficiaryOwner();
error BK_ReceivableNotFound();
error BK_ExceedsRemaining();
error BK_PaymentRefUsed();
error BK_LoanNotFound();
error BK_ExceedsOutstanding();
error BK_NoNativeDeposits();
error BK_NotYetExpired();
error BK_AlreadyCommitted();
error BK_NotRefundable();
error BK_EscrowNotCO();
error BK_NotCustomer();
error BK_ApprovedDrawMismatch();
error BK_ApprovedQtyMismatch();
error BK_ApprovalExpiryInPast();
error BK_ApprovalExpiryExceedsPlan();
error BK_ApprovalExpiryExceedsOffer();
error BK_LenderApprovalExpired();
error BK_SupplierApprovalExpired();
error BK_ApprovalCutoffExpired();
error BK_ApprovalOverwriteWhileJoined();
error BK_ReservedLiquidity();
error BK_BorrowerAccountNotFound();
error BK_CPNeedsOne();
error BK_CONeedsTwo();
error BK_InternalIndex();
error BK_BuyerQtySumOffer();
error BK_COUsesSaleParty();
error BK_COUsesIndex0();
error BK_NotCPPlan();
error BK_NotCOPlan();
error BK_BuyerIndexOutOfRange();
error BK_OfferExpired();
error BK_OfferPayeeChanged();
error BK_PayeeChanged();
error BK_NoGoodsSupplierApproval();
error BK_NoFreightSupplierApproval();
error BK_GoodsOfferInvalid();
error BK_FreightOfferInvalid();
error BK_InsufficientMerchantCash();
error BK_GoodsCapacityExceeded();
error BK_FreightCapacityExceeded();
error BK_AlreadyWithdrawn();
error BK_ZeroEscrow();
error BK_NotMerchantOwner();
error BK_NotNamedCustomer();
error BK_AcceptanceRequiredFirst();
error BK_ReceiptRefAlreadyUsed();
error BK_NotBoundPayer();
error BK_NotFound();

interface IBusinessKernel {

    // ───────────────────────────────────────────────────────────────────────
    // Enumerations
    // ───────────────────────────────────────────────────────────────────────

    enum WorkflowKind { CollectivePurchase, CustomerOrder }

    /// @dev Persisted plan lifecycle state. Readiness is derived, not stored.
    enum PlanStatus { Open, Committed, Cancelled, Expired }

    // ───────────────────────────────────────────────────────────────────────
    // Immutable plan terms — frozen at draftPlan, never mutated
    // ───────────────────────────────────────────────────────────────────────

    struct BuyerTerms {
        address owner;          // must be msg.sender on joinBuyer
        uint256 accountId;      // pre-registered business account
        uint256 quantity;       // units to purchase
        uint256 ownCash;        // exact cash hold required from this buyer
        uint256 creditDraw;     // exact credit draw from the lender pool
        uint256 creditLimit;    // lender-approved per-buyer principal ceiling
    }

    struct SalePartyTerms {
        address merchantOwner;
        uint256 merchantAccountId;
        uint256 merchantCash;       // exact merchant own-cash contribution
        uint256 creditDraw;         // exact funded-credit draw
        uint256 creditLimit;        // lender-approved principal ceiling
        address customerAddress;    // named customer; only they may fund escrow
        uint256 requiredEscrow;     // exact advance required (no partial funding)
        uint256 saleValue;          // total sale consideration for receivable calc
    }

    struct OfferRef {
        uint256 offerId;
        uint256 quantity;       // units to consume from this offer
        address payee;          // immutable payout destination approved by supplier
    }

    struct PlanTerms {
        WorkflowKind kind;
        // Collective purchase: buyers[] (1-8 entries); saleParty is ignored.
        // Customer order:      buyers[] is empty; saleParty is used.
        BuyerTerms[]   buyers;        // max 8; exact per-buyer terms
        SalePartyTerms saleParty;     // used only for CustomerOrder
        uint256        lenderPoolId;  // must be 1 (singleton) when credit is needed; 0 if no credit
        // Offer references — max 4; index 0 = goods, index 1 = freight (sale)
        OfferRef[]     offerRefs;     // max 4
        uint256        expiry;        // plan and all auth deadlines <= this
        bytes32        commercialRef; // opaque reference / content hash
    }

    // ───────────────────────────────────────────────────────────────────────
    // Events
    // ───────────────────────────────────────────────────────────────────────

    event AccountOpened(uint256 indexed accountId, address indexed owner);
    event CashDeposited(uint256 indexed accountId, uint256 amount);
    event CashWithdrawn(uint256 indexed accountId, address indexed to, uint256 amount);
    event FloorSet(uint256 indexed accountId, uint256 floor);
    event OpeningCheckpointRecorded(uint256 indexed accountId, uint256 totalClaim, uint256 blockNumber);

    event PoolCreated(uint256 indexed poolId, address indexed owner);
    event PoolDeposited(uint256 indexed poolId, uint256 amount);
    event PoolWithdrawn(uint256 indexed poolId, address indexed to, uint256 amount);
    event BorrowerLimitSet(uint256 indexed poolId, uint256 indexed borrowerAccountId, uint256 limit);
    event LenderPlanApproved(uint256 indexed planId, uint256 participantIndex, uint256 draw, uint256 approvalExpiry);
    event SupplierPlanApproved(uint256 indexed planId, uint256 offerRefIndex, uint256 quantity, uint256 approvalExpiry);

    event OfferCreated(uint256 indexed offerId, address indexed supplierOwner, address indexed payee,
                       uint256 unitPrice, uint256 capacity, uint256 minimumFill, uint256 expiry);
    event OfferRevoked(uint256 indexed offerId);
    event CapacityReserved(uint256 indexed offerId, uint256 indexed planId, uint256 units);
    event CapacityReleased(uint256 indexed offerId, uint256 indexed planId, uint256 units);
    event CapacityConsumed(uint256 indexed offerId, uint256 indexed planId, uint256 units);

    event PlanDrafted(uint256 indexed planId, WorkflowKind kind, bytes32 termsHash, uint256 expiry);
    event BuyerJoined(uint256 indexed planId, uint256 indexed accountId, uint256 gen);
    event BuyerLeft(uint256 indexed planId, uint256 indexed accountId, uint256 gen);
    event MerchantJoined(uint256 indexed planId, uint256 indexed accountId);
    event MerchantLeft(uint256 indexed planId, uint256 indexed accountId);
    event CustomerEscrowFunded(uint256 indexed planId, address indexed customer, uint256 amount);
    event CustomerEscrowWithdrawable(uint256 indexed planId, address indexed customer, uint256 amount);
    event CustomerEscrowWithdrawn(uint256 indexed planId, address indexed customer, uint256 amount);
    event PlanCommitted(uint256 indexed planId, bytes32 termsHash,
                        uint256 goodsPayout, uint256 freightPayout, uint256 totalPrincipal);
    event PlanCancelled(uint256 indexed planId, address indexed initiator);
    event PlanExpiredReleased(uint256 indexed planId);
    event PrincipalCreated(uint256 indexed loanId, uint256 indexed planId,
                           uint256 indexed borrowerAccountId, uint256 amount);

    event GoodsAcknowledged(uint256 indexed planId, uint256 quantity);
    event FreightAcknowledged(uint256 indexed planId, uint256 quantity);
    event CustomerAccepted(uint256 indexed planId, uint256 saleValue,
                           uint256 advanceApplied, uint256 receivableCreated);

    event ReceivableRegistered(uint256 indexed receivableId, uint256 indexed beneficiaryAccountId,
                                address indexed boundPayer, uint256 amount);
    event ReceivableCollected(uint256 indexed receivableId, bytes32 indexed paymentRef,
                               address payer, uint256 beneficiaryAccountId,
                               uint256 amount, uint256 remaining);

    event SalesCollected(uint256 indexed planId, bytes32 indexed receiptRef,
                         uint256 amount, uint256 principalRepaid, uint256 merchantCredit);
    event LoanRepaid(uint256 indexed loanId, uint256 amount, uint256 remaining);
    event InternalRepayment(uint256 indexed loanId, uint256 indexed borrowerAccountId,
                             uint256 amount);

    event SurplusObserved(address indexed sender, uint256 amount);

    // ───────────────────────────────────────────────────────────────────────
    // Account management
    // ───────────────────────────────────────────────────────────────────────

    function openAccount() external returns (uint256 accountId);
    function depositCash(uint256 accountId, uint256 amount) external;
    function withdrawCash(uint256 accountId, address to, uint256 amount) external;
    function setProtectedFloor(uint256 accountId, uint256 floor) external;
    function recordOpeningCheckpoint(uint256 accountId) external;

    // ───────────────────────────────────────────────────────────────────────
    // Lender pool — singleton pool (ID=1) initialized at construction
    // ───────────────────────────────────────────────────────────────────────

    function depositPool(uint256 poolId, uint256 amount) external;
    function withdrawPool(uint256 poolId, address to, uint256 amount) external;
    function setBorrowerLimit(uint256 poolId, uint256 borrowerAccountId, uint256 limit) external;

    /// @notice Lender grants plan-specific approval for a participant's exact draw,
    ///         with its own independent expiry. approvalExpiry <= plan expiry.
    ///         participantIndex: buyer index (CP) or 0 (CO merchant).
    function approveLenderPlan(uint256 planId, uint256 participantIndex, uint256 approvedDraw, uint256 approvalExpiry) external;

    /// @notice Supplier grants plan-specific approval for an offer ref,
    ///         with its own independent expiry. approvalExpiry <= min(plan expiry, offer expiry).
    function approveSupplierPlan(uint256 planId, uint256 offerRefIndex, uint256 approvedQuantity, uint256 approvalExpiry) external;

    // ───────────────────────────────────────────────────────────────────────
    // Supplier offers
    // ───────────────────────────────────────────────────────────────────────

    function createOffer(address payee, uint256 unitPrice, uint256 capacity, uint256 minimumFill, uint256 expiry)
        external returns (uint256 offerId);
    function revokeOffer(uint256 offerId) external;

    // ───────────────────────────────────────────────────────────────────────
    // Plan lifecycle
    // ───────────────────────────────────────────────────────────────────────

    /// @notice Create an immutable plan. Returns planId and the frozen termsHash.
    ///         Creation does NOT reserve any resource or count as anyone's approval.
    function draftPlan(PlanTerms calldata terms) external returns (uint256 planId, bytes32 termsHash);

    /// @notice Buyer owner joins its own pre-named participation in a CollectivePurchase plan.
    ///         Atomically reserves own cash, credit headroom + pool liquidity, and supplier units.
    function joinBuyer(uint256 planId, uint256 buyerIndex) external;

    /// @notice Merchant owner joins in a CustomerOrder plan.
    function joinMerchant(uint256 planId) external;

    /// @notice Named customer funds the exact required escrow for a CustomerOrder plan.
    ///         This is both the deposit and the customer's approval of the referenced plan.
    function fundCustomerEscrow(uint256 planId) external;

    /// @notice Buyer owner leaves before commit; releases their entire reservation bundle.
    function leaveBuyer(uint256 planId, uint256 buyerIndex) external;

    /// @notice Merchant owner leaves before commit.
    function leaveMerchant(uint256 planId) external;

    /// @notice Lender revokes its approval for a specific buyer/merchant in this plan.
    ///         Releases that participant's reservation bundle.
    function revokeLenderApproval(uint256 planId, uint256 participantIndex) external;

    /// @notice Supplier revokes the plan-specific offer approval for the given offer ref index.
    ///         Releases all reservation bundles that depend on this offer.
    function revokeOfferApproval(uint256 planId, uint256 offerRefIndex) external;

    /// @notice Atomically close a fully-authorized plan. Callable by anyone.
    function commitPlan(uint256 planId) external;

    /// @notice Cancel an open plan (coordinator or any required party). Releases reservations;
    ///         makes customer escrow withdrawable. No external transfer.
    function cancelPlan(uint256 planId) external;

    /// @notice Permissionless expiry cleanup for plans past their deadline.
    function releaseExpiredPlan(uint256 planId) external;

    /// @notice Customer withdraws their refundable escrow after cancel/expiry.
    function withdrawCustomerEscrow(uint256 planId) external;

    // ───────────────────────────────────────────────────────────────────────
    // Post-commit: acknowledgments, acceptance, collection
    // ───────────────────────────────────────────────────────────────────────

    function acknowledgeGoods(uint256 planId) external;
    function acknowledgeFreight(uint256 planId) external;
    function acceptSalesOrder(uint256 planId) external;

    /// @notice Named customer collects against the accepted sales receivable.
    ///         Applies principal-first waterfall.
    function collectSalesBalance(uint256 planId, bytes32 receiptRef, uint256 amount) external;

    // ───────────────────────────────────────────────────────────────────────
    // Group opening receivables
    // ───────────────────────────────────────────────────────────────────────

    function registerReceivable(
        uint256 receivableId,
        uint256 beneficiaryAccountId,
        address boundPayer,
        uint256 amount,
        bytes32 provenance
    ) external;

    function collectReceivable(
        uint256 receivableId,
        bytes32 paymentRef,
        uint256 amount
    ) external;

    // ───────────────────────────────────────────────────────────────────────
    // Loan repayment (voluntary, from own free cash)
    // ───────────────────────────────────────────────────────────────────────

    function repayLoan(uint256 loanId, uint256 amount) external;

    // ───────────────────────────────────────────────────────────────────────
    // View functions
    // ───────────────────────────────────────────────────────────────────────

    function usdc() external view returns (address);
    function lender() external view returns (address);
    function POOL_ID() external view returns (uint256);
    function accountOf(address owner) external view returns (uint256);

    function getAccount(uint256 accountId) external view returns (
        address owner,
        uint256 cash,
        uint256 floor,
        uint256 aggregateHeld,
        uint256 activePlanCount,
        uint256 outstandingPrincipal
    );

    function getPool(uint256 poolId) external view returns (
        address owner,
        uint256 cash,
        uint256 reserved
    );

    function getOffer(uint256 offerId) external view returns (
        address supplierOwner,
        address payee,
        uint256 unitPrice,
        uint256 capacity,
        uint256 minimumFill,
        uint256 reserved,
        uint256 consumed,
        uint256 expiry,
        bool    revoked
    );

    function getPlan(uint256 planId) external view returns (
        WorkflowKind kind,
        PlanStatus   status,
        bytes32      termsHash,
        uint256      expiry,
        uint256      committedAt
    );

    function getBuyerParticipation(uint256 planId, uint256 buyerIndex) external view returns (
        bool    joined,
        uint256 generation,
        uint256 cashHeld,
        uint256 creditReserved
    );

    function getMerchantParticipation(uint256 planId) external view returns (
        bool    joined,
        uint256 cashHeld,
        uint256 creditReserved
    );

    function getEscrow(uint256 planId) external view returns (
        address customer,
        uint256 amount,
        bool    withdrawable,
        bool    withdrawn
    );

    function getLoan(uint256 loanId) external view returns (
        uint256 planId,
        uint256 borrowerAccountId,
        uint256 lenderPoolId,
        uint256 originalPrincipal,
        uint256 outstanding
    );

    function getReceivable(uint256 receivableId) external view returns (
        uint256 beneficiaryAccountId,
        address boundPayer,
        uint256 openingAmount,
        uint256 remaining,
        bytes32 provenance,
        address registrar,
        uint256 registeredAt
    );

    function getSalesState(uint256 planId) external view returns (
        bool    goodsAcknowledged,
        bool    freightAcknowledged,
        bool    customerAccepted,
        uint256 saleReceivable,
        uint256 collected
    );

    /// @notice Derived readiness — never stored; always recomputed from live state.
    function planReadiness(uint256 planId) external view returns (
        bool   ready,
        string memory blockedReason
    );

    function totalCustody() external view returns (uint256);
    function accountedCustody() external view returns (uint256);

    function getLenderPlanApproval(uint256 planId, uint256 participantIndex) external view returns (uint256 approvedDraw, uint256 approvalExpiry);
    function getSupplierPlanApproval(uint256 planId, uint256 offerRefIndex) external view returns (uint256 approvedQuantity, uint256 approvalExpiry);
    function getBorrowerUsage(uint256 poolId, uint256 borrowerAccountId) external view returns (uint256 usage);
    function getPlanCoordinator(uint256 planId) external view returns (address coordinator);
}
