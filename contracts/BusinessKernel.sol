// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IBusinessKernel.sol";

/**
 * @title BusinessKernel  (G1/G2)
 * @notice Immutable USDC custody and settlement kernel — Business Account M1.
 *
 * Financial model
 * ───────────────
 * cash         = total funded USDC claim (holds are PART of cash, not extra)
 * available    = cash − floor − aggregateHeld
 * pool.cash    = total lender funded claim (reservations are PART of pool.cash)
 * pool.avail   = pool.cash − pool.reserved
 *
 * Plans are fully specified at creation (immutable PlanTerms).
 * join* only authorises the pre-named participant's exact terms.
 * Capacity is reserved at join and consumed at commit.
 * Readiness is always derived from live state; no stored READY flag.
 */
contract BusinessKernel is IBusinessKernel, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ───────────────────────────────────────────────────────────────────────
    // Constants
    // ───────────────────────────────────────────────────────────────────────

    uint8  public constant MAX_BUYERS    = 8;
    uint8  public constant MAX_OFFER_REFS = 4;
    uint256 public constant VERSION      = 2;

    // ───────────────────────────────────────────────────────────────────────
    // USDC token (immutable)
    // ───────────────────────────────────────────────────────────────────────

    IERC20 private immutable _usdc;

    // ───────────────────────────────────────────────────────────────────────
    // Account ledger
    // ───────────────────────────────────────────────────────────────────────

    struct Account {
        address owner;
        uint256 cash;            // total funded claim; holds are within this
        uint256 floor;           // protected minimum
        uint256 aggregateHeld;   // sum of all active cash holds
        uint256 activePlanCount; // number of currently live reservation bundles
        uint256 outstandingPrincipal; // total drawn but not yet repaid
    }

    uint256 private _nextAccId = 1;
    mapping(uint256 => Account)  private _accs;
    mapping(address => uint256)  private _ownerToAcc;

    // ───────────────────────────────────────────────────────────────────────
    // Lender pool — singleton; pool ID is always 1, created at construction
    // ───────────────────────────────────────────────────────────────────────

    struct Pool {
        address owner;
        uint256 cash;       // total funded lender claim
        uint256 reserved;   // sum of active liquidity reservations
    }

    /// @dev The one lender address, bound immutably at deployment.
    address private immutable _lender;

    /// @dev Singleton pool ID. Always 1; exposed for tests and external callers.
    uint256 public constant POOL_ID = 1;
    mapping(uint256 => Pool)    private _pools;
    // poolId → borrowerAccId → approved principal limit
    mapping(uint256 => mapping(uint256 => uint256)) private _borrowerLimit;
    // poolId → borrowerAccId → total reserved + outstanding usage (for headroom check)
    mapping(uint256 => mapping(uint256 => uint256)) private _borrowerUsage;

    // ───────────────────────────────────────────────────────────────────────
    // Offer book
    // ───────────────────────────────────────────────────────────────────────

    struct Offer {
        address supplierOwner;
        address payee;
        uint256 unitPrice;
        uint256 capacity;
        uint256 minimumFill; // minimum aggregate units required to commit a single plan
        uint256 reserved;   // units held by open plans
        uint256 consumed;   // units used by committed plans
        uint256 expiry;
        bool    revoked;
    }

    uint256 private _nextOfferId = 1;
    mapping(uint256 => Offer) private _offers;

    // ───────────────────────────────────────────────────────────────────────
    // Plan engine
    // ───────────────────────────────────────────────────────────────────────

    // Immutable terms stored per plan
    struct StoredBuyerTerms {
        address owner;
        uint256 accountId;
        uint256 quantity;
        uint256 ownCash;
        uint256 creditDraw;
        uint256 creditLimit;
    }

    struct StoredSaleParty {
        address merchantOwner;
        uint256 merchantAccountId;
        uint256 merchantCash;
        uint256 creditDraw;
        uint256 creditLimit;
        address customerAddress;
        uint256 requiredEscrow;
        uint256 saleValue;
    }

    struct StoredOfferRef {
        uint256 offerId;
        uint256 quantity;
        address payee;
    }

    // Live participation state per buyer slot
    struct BuyerPart {
        bool    joined;
        uint256 generation; // increments on each rejoin
        uint256 cashHeld;   // == terms.ownCash when joined
        uint256 creditReserved; // == terms.creditDraw when joined
    }

    // Live merchant participation
    struct MerchantPart {
        bool    joined;
        uint256 cashHeld;
        uint256 creditReserved;
    }

    // Customer escrow state
    struct Escrow {
        address customer;
        uint256 amount;
        bool    withdrawable;
        bool    withdrawn;
    }

    // Approval record — amount and its own independent expiry deadline
    struct Approval {
        uint256 amount;   // approved draw (lender) or approved quantity (supplier)
        uint256 expiry;   // block.timestamp < expiry required; 0 = cleared/revoked
    }

    // Per-plan lender approval: poolId → planId → participantIndex → Approval
    mapping(uint256 => mapping(uint256 => mapping(uint256 => Approval))) private _lenderPlanApproval;
    // Per-plan supplier approval: planId → offerRefIndex → Approval
    mapping(uint256 => mapping(uint256 => Approval)) private _supplierPlanApproval;
    mapping(uint256 => mapping(uint256 => bool)) private _supplierPlanRevoked;

    // Sales operational acknowledgment state
    struct SalesOps {
        bool    goodsAcked;
        bool    freightAcked;
        bool    customerAccepted;
        uint256 saleReceivable; // set at acceptance = saleValue - advance
        uint256 collected;      // cumulative post-commit collections
    }

    struct Plan {
        WorkflowKind kind;
        PlanStatus   status;
        bytes32      termsHash;
        uint256      expiry;
        uint256      committedAt;
        uint256      lenderPoolId;
        bool         consumed; // replay guard
        address      coordinator; // msg.sender at draftPlan

        // Immutable terms (copied from calldata at draft)
        StoredBuyerTerms[]  buyers;
        StoredSaleParty     sale;
        StoredOfferRef[]    offerRefs;
        bytes32             commercialRef;

        // Live state
        BuyerPart[]  buyerParts;
        MerchantPart merchant;
        Escrow       escrow;
        SalesOps     salesOps;
        // Effective execution deadline (min of all approval expiries). Updated monotonically downward.
        // Value 0 = no approvals yet (planOpen modifier and commitPlan gate on this).
        uint256      hardCutoff;
        // Count of currently joined participants (join +=1, release/commit -=1).
        // Guards approval overwrite without looping over participant arrays.
        uint256      joinedCount;
    }

    uint256 private _nextPlanId = 1;
    mapping(uint256 => Plan) private _plans;

    // ───────────────────────────────────────────────────────────────────────
    // Loans
    // ───────────────────────────────────────────────────────────────────────

    struct Loan {
        uint256 planId;
        uint256 borrowerAccountId;
        uint256 lenderPoolId;
        uint256 originalPrincipal;
        uint256 outstanding;
    }

    uint256 private _nextLoanId = 1;
    mapping(uint256 => Loan) private _loans;
    // planId → loanId for CustomerOrder plans (one loan per CO plan)
    mapping(uint256 => uint256) private _planLoanId;

    // ───────────────────────────────────────────────────────────────────────
    // Opening receivables (group fixture)
    // ───────────────────────────────────────────────────────────────────────

    struct Receivable {
        uint256 beneficiaryAccountId;
        address boundPayer;
        uint256 openingAmount;
        uint256 remaining;
        bool    exists;
    }

    mapping(uint256 => Receivable)                     private _receivables;
    mapping(uint256 => mapping(bytes32 => bool))       private _receiptUsed; // receivableId → ref used

    // Sales receipt replay guard: planId → receiptRef → used
    mapping(uint256 => mapping(bytes32 => bool))       private _salesReceiptUsed;

    // Real claim counters for accountedCustody (defect 6)
    // Sum of all account.cash + pool.cash + active escrow amounts
    uint256 private _totalAccountCash;   // sum of all _accs[*].cash
    uint256 private _totalPoolCash;      // sum of all _pools[*].cash
    uint256 private _totalEscrow;        // sum of all active escrow.amount

    // Receivable provenance storage (defect 10)
    mapping(uint256 => bytes32) private _receivableProvenance;
    mapping(uint256 => address) private _receivableRegistrar;
    mapping(uint256 => uint256) private _receivableRegisteredAt;

    // ───────────────────────────────────────────────────────────────────────
    // Constructor
    // ───────────────────────────────────────────────────────────────────────

    constructor(address usdcToken, address lenderAddr) {
        if (usdcToken == address(0)) revert BK_ZeroUSDC();
        if (lenderAddr == address(0)) revert BK_ZeroLender();
        _usdc   = IERC20(usdcToken);
        _lender = lenderAddr;
        // Initialize the singleton pool. Owner is immutable; no setter or upgrade.
        _pools[POOL_ID].owner = lenderAddr;
        emit PoolCreated(POOL_ID, lenderAddr);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Modifiers
    // ───────────────────────────────────────────────────────────────────────

    modifier onlyAccOwner(uint256 accId) {
        if (!(_accs[accId].owner == msg.sender)) revert BK_NotAccountOwner();
        _;
    }

    modifier onlyPoolOwner(uint256 poolId) {
        if (!(_pools[poolId].owner == msg.sender)) revert BK_NotPoolOwner();
        _;
    }

    modifier planExists(uint256 planId) {
        if (!(planId > 0 && planId < _nextPlanId)) revert BK_PlanNotFound();
        _;
    }

    modifier planOpen(uint256 planId) {
        if (!(planId > 0 && planId < _nextPlanId)) revert BK_PlanNotFound();
        if (!(_plans[planId].status == PlanStatus.Open)) revert BK_PlanNotOpen();
        if (!(block.timestamp < _plans[planId].expiry)) revert BK_PlanExpired();
        // Hard approval cutoff: once any approval narrows the window, all joins/escrow
        // are gated to that cutoff regardless of which specific approval was narrowed.
        {
            uint256 _cutoff = _plans[planId].hardCutoff;
            if (_cutoff > 0 && !(block.timestamp < _cutoff)) revert BK_ApprovalCutoffExpired();
        }
        _;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Internal receipt helper
    // ───────────────────────────────────────────────────────────────────────

    /**
     * @dev Pull exactly `amount` USDC from `from` into this contract.
     *      Snapshots the kernel's token balance before the transfer and
     *      re-reads it after; reverts unless the balance delta equals `amount`
     *      exactly. Rejects no-op transfers (delta == 0), short receipts
     *      (delta < amount) and unexpected excess (delta > amount).
     *      Called only from nonReentrant entry points.
     */
    function _receiveExact(address from, uint256 amount) private {
        uint256 before = _usdc.balanceOf(address(this));
        _usdc.safeTransferFrom(from, address(this), amount);
        if (_usdc.balanceOf(address(this)) - before != amount) revert BK_TransferReceiptMismatch();
    }

    // ───────────────────────────────────────────────────────────────────────
    // Account management
    // ───────────────────────────────────────────────────────────────────────

    function openAccount() external override nonReentrant returns (uint256 accId) {
        if (!(_ownerToAcc[msg.sender] == 0)) revert BK_AccountExists();
        accId = _nextAccId++;
        _accs[accId].owner = msg.sender;
        _ownerToAcc[msg.sender] = accId;
        emit AccountOpened(accId, msg.sender);
    }

    function depositCash(uint256 accId, uint256 amount)
        external override nonReentrant onlyAccOwner(accId)
    {
        if (!(amount > 0)) revert BK_ZeroAmount();
        _receiveExact(msg.sender, amount);
        _accs[accId].cash   += amount;
        _totalAccountCash   += amount;
        emit CashDeposited(accId, amount);
    }

    function withdrawCash(uint256 accId, address to, uint256 amount)
        external override nonReentrant onlyAccOwner(accId)
    {
        if (!(to != address(0))) revert BK_ZeroTo();
        if (!(amount > 0)) revert BK_ZeroAmount();
        Account storage a = _accs[accId];
        if (!(_availCash(a) >= amount)) revert BK_InsufficientAvailableCash();
        a.cash            -= amount;
        _totalAccountCash -= amount;
        _usdc.safeTransfer(to, amount);
        emit CashWithdrawn(accId, to, amount);
    }

    function setProtectedFloor(uint256 accId, uint256 floor)
        external override nonReentrant onlyAccOwner(accId)
    {
        Account storage a = _accs[accId];
        if (floor > a.floor) {
            // Increase: new floor must be backed by cash after existing holds
            if (!(a.cash >= floor + a.aggregateHeld)) revert BK_FloorIncreaseUnbacked();
        } else {
            // Decrease: only when no active participations and no debt
            if (!(a.activePlanCount == 0)) revert BK_ActiveParticipations();
            if (!(a.outstandingPrincipal == 0)) revert BK_OutstandingDebt();
        }
        a.floor = floor;
        emit FloorSet(accId, floor);
    }

    function recordOpeningCheckpoint(uint256 accId)
        external override nonReentrant onlyAccOwner(accId)
    {
        Account storage a = _accs[accId];
        emit OpeningCheckpointRecorded(accId, a.cash, block.number);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Lender pool
    // ───────────────────────────────────────────────────────────────────────

    function depositPool(uint256 poolId, uint256 amount)
        external override nonReentrant onlyPoolOwner(poolId)
    {
        if (!(amount > 0)) revert BK_ZeroAmount();
        _receiveExact(msg.sender, amount);
        _pools[poolId].cash += amount;
        _totalPoolCash      += amount;
        emit PoolDeposited(poolId, amount);
    }

    function withdrawPool(uint256 poolId, address to, uint256 amount)
        external override nonReentrant onlyPoolOwner(poolId)
    {
        if (!(to != address(0))) revert BK_ZeroTo();
        if (!(amount > 0)) revert BK_ZeroAmount();
        Pool storage p = _pools[poolId];
        if (!(p.cash - p.reserved >= amount)) revert BK_ReservedLiquidity();
        p.cash         -= amount;
        _totalPoolCash -= amount;
        _usdc.safeTransfer(to, amount);
        emit PoolWithdrawn(poolId, to, amount);
    }

    function setBorrowerLimit(uint256 poolId, uint256 borrowerAccId, uint256 limit)
        external override nonReentrant onlyPoolOwner(poolId)
    {
        if (_accs[borrowerAccId].owner == address(0)) revert BK_BorrowerAccountNotFound();
        // Prevent reduction below currently booked (reserved + outstanding) usage
        if (!(limit >= _borrowerUsage[poolId][borrowerAccId])) revert BK_LimitBelowBookedUsage();
        _borrowerLimit[poolId][borrowerAccId] = limit;
        emit BorrowerLimitSet(poolId, borrowerAccId, limit);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Supplier offers
    // ───────────────────────────────────────────────────────────────────────

    function createOffer(address payee, uint256 unitPrice, uint256 capacity, uint256 minimumFill, uint256 expiry)
        external override nonReentrant returns (uint256 offerId)
    {
        if (!(payee != address(0))) revert BK_ZeroPayee();
        if (!(unitPrice > 0)) revert BK_ZeroPrice();
        if (!(capacity > 0)) revert BK_ZeroCapacity();
        if (!(minimumFill > 0 && minimumFill <= capacity)) revert BK_InvalidMinimumFill();
        if (!(expiry > block.timestamp)) revert BK_OfferExpiredAtCreation();
        offerId = _nextOfferId++;
        _offers[offerId] = Offer({
            supplierOwner: msg.sender,
            payee:         payee,
            unitPrice:     unitPrice,
            capacity:      capacity,
            minimumFill:   minimumFill,
            reserved:      0,
            consumed:      0,
            expiry:        expiry,
            revoked:       false
        });
        emit OfferCreated(offerId, msg.sender, payee, unitPrice, capacity, minimumFill, expiry);
    }

    function revokeOffer(uint256 offerId) external override nonReentrant {
        Offer storage o = _offers[offerId];
        if (!(o.supplierOwner == msg.sender)) revert BK_NotOfferOwner();
        if (o.revoked) revert BK_AlreadyRevoked();
        o.revoked = true;
        emit OfferRevoked(offerId);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Plan drafting — creates immutable terms, no reservation
    // ───────────────────────────────────────────────────────────────────────

    function _storePlan(uint256 planId, PlanTerms calldata terms, bytes32 termsHash) private {
        Plan storage p = _plans[planId];
        p.kind          = terms.kind;
        p.status        = PlanStatus.Open;
        p.termsHash     = termsHash;
        p.expiry        = terms.expiry;
        p.lenderPoolId  = terms.lenderPoolId;
        p.commercialRef = terms.commercialRef;

        for (uint256 i = 0; i < terms.buyers.length; i++) {
            BuyerTerms calldata b = terms.buyers[i];
            p.buyers.push(StoredBuyerTerms({
                owner: b.owner, accountId: b.accountId, quantity: b.quantity,
                ownCash: b.ownCash, creditDraw: b.creditDraw, creditLimit: b.creditLimit
            }));
            p.buyerParts.push(BuyerPart({ joined: false, generation: 0, cashHeld: 0, creditReserved: 0 }));
        }

        if (terms.kind == WorkflowKind.CustomerOrder) {
            SalePartyTerms calldata sp = terms.saleParty;
            p.sale = StoredSaleParty({
                merchantOwner: sp.merchantOwner, merchantAccountId: sp.merchantAccountId,
                merchantCash: sp.merchantCash, creditDraw: sp.creditDraw, creditLimit: sp.creditLimit,
                customerAddress: sp.customerAddress, requiredEscrow: sp.requiredEscrow, saleValue: sp.saleValue
            });
        }

        for (uint256 i = 0; i < terms.offerRefs.length; i++) {
            OfferRef calldata ref = terms.offerRefs[i];
            p.offerRefs.push(StoredOfferRef({ offerId: ref.offerId, quantity: ref.quantity, payee: ref.payee }));
        }
    }

    function draftPlan(PlanTerms calldata terms)
        external override nonReentrant returns (uint256 planId, bytes32 termsHash)
    {
        // Validate structural bounds
        if (!(terms.expiry > block.timestamp)) revert BK_ExpiryInPast();
        if (!(terms.offerRefs.length > 0 && terms.offerRefs.length <= MAX_OFFER_REFS)) revert BK_BadOfferRefsCount();

        if (terms.kind == WorkflowKind.CollectivePurchase) {
            if (!(terms.buyers.length > 0 && terms.buyers.length <= MAX_BUYERS)) revert BK_BadBuyersCount();
            if (!(terms.offerRefs.length == 1)) revert BK_CPNeedsOne();

            // Validate offer ref exists and not revoked before using unit price
            {
                OfferRef calldata ref0 = terms.offerRefs[0];
                if (!(ref0.offerId > 0 && ref0.offerId < _nextOfferId)) revert BK_OfferNotFound();
                if (_offers[ref0.offerId].revoked) revert BK_OfferRevoked();
                if (!(ref0.payee == _offers[ref0.offerId].payee)) revert BK_PayeeMismatch();
                if (!(ref0.quantity > 0)) revert BK_ZeroOfferQuantity();
            }

            uint256 unitPrice = _offers[terms.offerRefs[0].offerId].unitPrice;
            uint256 totalQty;
            // No-duplicate buyer accountId check
            bool[9] memory seenBuyer; // max 8, indexed 0-7, use slot 8 as safety
            for (uint256 i = 0; i < terms.buyers.length; i++) {
                BuyerTerms calldata b = terms.buyers[i];
                if (!(b.owner != address(0))) revert BK_ZeroBuyerOwner();
                if (!(b.accountId > 0 && b.accountId < _nextAccId)) revert BK_BuyerAccountNotFound();
                // Verify owner field matches real account owner (defect 1)
                if (!(_accs[b.accountId].owner == b.owner)) revert BK_BuyerOwnerMismatch();
                if (!(b.quantity > 0)) revert BK_ZeroBuyerQuantity();
                if (!(b.creditDraw <= b.creditLimit)) revert BK_DrawExceedsLimit();
                // Per-buyer sources must cover exactly their allocation (defect 2)
                uint256 alloc = b.quantity * unitPrice;
                if (!(b.ownCash + b.creditDraw == alloc)) revert BK_BuyerSourcesAllocation();
                totalQty += b.quantity;
                // Duplicate account check (defect 11)
                if (!(!seenBuyer[i])) revert BK_InternalIndex();
            }
            // Verify no two buyers share same accountId (defect 11)
            for (uint256 i = 0; i < terms.buyers.length; i++) {
                for (uint256 j = i + 1; j < terms.buyers.length; j++) {
                    if (!(terms.buyers[i].accountId != terms.buyers[j].accountId)) revert BK_DuplicateBuyerAccount();
                }
            }
            if (!(totalQty == terms.offerRefs[0].quantity)) revert BK_BuyerQtySumOffer();
        } else {
            // CustomerOrder
            if (!(terms.buyers.length == 0)) revert BK_COUsesSaleParty();
            if (!(terms.saleParty.merchantOwner != address(0))) revert BK_ZeroMerchantOwner();
            if (!(terms.saleParty.merchantAccountId > 0 &&                     terms.saleParty.merchantAccountId < _nextAccId)) revert BK_MerchantAccountNotFound();
            // Verify merchant owner field matches real account owner (defect 1)
            if (!(_accs[terms.saleParty.merchantAccountId].owner == terms.saleParty.merchantOwner)) revert BK_MerchantOwnerMismatch();
            if (!(terms.saleParty.customerAddress != address(0))) revert BK_ZeroCustomer();
            if (!(terms.saleParty.requiredEscrow > 0)) revert BK_ZeroRequiredEscrow();
            if (!(terms.saleParty.saleValue > terms.saleParty.requiredEscrow)) revert BK_SaleValueMustExceedEscrow();
            if (!(terms.saleParty.creditDraw <= terms.saleParty.creditLimit)) revert BK_DrawExceedsLimit();
            if (!(terms.offerRefs.length == 2)) revert BK_CONeedsTwo();
            // Duplicate offer ID check for CO (defect 11)
            if (!(terms.offerRefs[0].offerId != terms.offerRefs[1].offerId)) revert BK_DuplicateOfferRefs();
        }

        // Validate pool if credit is used
        bool needsPool = false;
        if (terms.kind == WorkflowKind.CollectivePurchase) {
            for (uint256 i = 0; i < terms.buyers.length; i++) {
                if (terms.buyers[i].creditDraw > 0) { needsPool = true; break; }
            }
        } else {
            if (terms.saleParty.creditDraw > 0) needsPool = true;
        }
        if (needsPool) {
            // Only the singleton pool (ID=1) exists; reject any other ID.
            if (!(terms.lenderPoolId == POOL_ID)) revert BK_PoolNotFound();
        }

        // Validate offer refs for CO (CP's single ref already validated above)
        if (terms.kind == WorkflowKind.CustomerOrder) {
            for (uint256 i = 0; i < 2; i++) {
                OfferRef calldata ref = terms.offerRefs[i];
                if (!(ref.offerId > 0 && ref.offerId < _nextOfferId)) revert BK_OfferNotFound();
                if (_offers[ref.offerId].revoked) revert BK_OfferRevoked();
                if (!(ref.payee == _offers[ref.offerId].payee)) revert BK_PayeeMismatch();
                if (!(ref.quantity > 0)) revert BK_ZeroOfferQuantity();
            }
        }

        // Compute complete frozen terms hash — must encode ALL financial fields (defect 3)
        termsHash = _computeTermsHash(terms);

        planId = _nextPlanId++;
        _plans[planId].coordinator = msg.sender;
        _storePlan(planId, terms, termsHash);
        emit PlanDrafted(planId, terms.kind, termsHash, terms.expiry);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Complete terms hash — encodes ALL financial fields (defect 3)
    // ───────────────────────────────────────────────────────────────────────

    function _computeTermsHash(PlanTerms calldata t) private view returns (bytes32) {
        // Hash buyer array contents
        bytes32 buyersHash;
        {
            bytes memory buf;
            for (uint256 i = 0; i < t.buyers.length; i++) {
                BuyerTerms calldata b = t.buyers[i];
                buf = abi.encodePacked(buf, b.owner, b.accountId, b.quantity,
                                       b.ownCash, b.creditDraw, b.creditLimit);
            }
            buyersHash = keccak256(buf);
        }
        // Hash offer refs
        bytes32 refsHash;
        {
            bytes memory buf;
            for (uint256 i = 0; i < t.offerRefs.length; i++) {
                OfferRef calldata r = t.offerRefs[i];
                buf = abi.encodePacked(buf, r.offerId, r.quantity, r.payee);
            }
            refsHash = keccak256(buf);
        }
        // Hash sale party
        SalePartyTerms calldata sp = t.saleParty;
        bytes32 saleHash = keccak256(abi.encode(
            sp.merchantOwner, sp.merchantAccountId, sp.merchantCash,
            sp.creditDraw, sp.creditLimit, sp.customerAddress,
            sp.requiredEscrow, sp.saleValue
        ));
        return keccak256(abi.encode(
            block.chainid,
            address(this),
            t.kind,
            t.lenderPoolId,
            t.expiry,
            t.commercialRef,
            buyersHash,
            saleHash,
            refsHash
        ));
    }

    // ───────────────────────────────────────────────────────────────────────
    // Plan-specific approvals (defect 4)
    // ───────────────────────────────────────────────────────────────────────

    function approveLenderPlan(
        uint256 planId,
        uint256 participantIndex,
        uint256 approvedDraw,
        uint256 approvalExpiry
    ) external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.status == PlanStatus.Open)) revert BK_PlanNotOpen();
        if (!(p.lenderPoolId > 0)) revert BK_NoLenderPool();
        if (!(_pools[p.lenderPoolId].owner == msg.sender)) revert BK_NotPoolOwner();
        // Approval expiry must be strictly in the future and no later than the plan
        if (!(block.timestamp < approvalExpiry)) revert BK_ApprovalExpiryInPast();
        if (!(approvalExpiry <= p.expiry)) revert BK_ApprovalExpiryExceedsPlan();

        if (p.kind == WorkflowKind.CollectivePurchase) {
            if (!(participantIndex < p.buyers.length)) revert BK_IndexOutOfRange();
            if (!(approvedDraw == p.buyers[participantIndex].creditDraw)) revert BK_ApprovedDrawMismatch();
            // Block overwrite while participant holds an active reservation
            if (p.buyerParts[participantIndex].joined) revert BK_ApprovalOverwriteWhileJoined();
        } else {
            if (!(participantIndex == 0)) revert BK_COUsesIndex0();
            if (!(approvedDraw == p.sale.creditDraw)) revert BK_ApprovedDrawMismatch();
            // Block overwrite while merchant holds an active reservation
            if (p.merchant.joined) revert BK_ApprovalOverwriteWhileJoined();
        }
        _lenderPlanApproval[p.lenderPoolId][planId][participantIndex] =
            Approval({ amount: approvedDraw, expiry: approvalExpiry });
        // Narrow the plan's effective execution cutoff (min of all approval deadlines)
        if (p.hardCutoff == 0 || approvalExpiry < p.hardCutoff) p.hardCutoff = approvalExpiry;
        emit LenderPlanApproved(planId, participantIndex, approvedDraw, approvalExpiry);
    }

    function approveSupplierPlan(
        uint256 planId,
        uint256 offerRefIndex,
        uint256 approvedQuantity,
        uint256 approvalExpiry
    ) external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.status == PlanStatus.Open)) revert BK_PlanNotOpen();
        if (!(offerRefIndex < p.offerRefs.length)) revert BK_IndexOutOfRange();
        uint256 offerId = p.offerRefs[offerRefIndex].offerId;
        if (!(_offers[offerId].supplierOwner == msg.sender)) revert BK_NotOfferOwner();
        if (!(approvedQuantity == p.offerRefs[offerRefIndex].quantity)) revert BK_ApprovedQtyMismatch();
        // Approval expiry must be strictly in the future and no later than both plan and offer
        if (!(block.timestamp < approvalExpiry)) revert BK_ApprovalExpiryInPast();
        if (!(approvalExpiry <= p.expiry)) revert BK_ApprovalExpiryExceedsPlan();
        if (!(approvalExpiry <= _offers[offerId].expiry)) revert BK_ApprovalExpiryExceedsOffer();
        // Block overwrite while any participant holds an active reservation.
        if (p.joinedCount > 0) revert BK_ApprovalOverwriteWhileJoined();
        _supplierPlanApproval[planId][offerRefIndex] =
            Approval({ amount: approvedQuantity, expiry: approvalExpiry });
        _supplierPlanRevoked[planId][offerRefIndex] = false;
        // Narrow the plan's effective execution cutoff (min of all approval deadlines)
        if (p.hardCutoff == 0 || approvalExpiry < p.hardCutoff) p.hardCutoff = approvalExpiry;
        emit SupplierPlanApproved(planId, offerRefIndex, approvedQuantity, approvalExpiry);
    }

    // ───────────────────────────────────────────────────────────────────────
    // joinBuyer — buyer authorises and reserves its exact pre-named terms
    // ───────────────────────────────────────────────────────────────────────

    function joinBuyer(uint256 planId, uint256 buyerIndex)
        external override nonReentrant planOpen(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.kind == WorkflowKind.CollectivePurchase)) revert BK_NotCPPlan();
        if (!(buyerIndex < p.buyers.length)) revert BK_BuyerIndexOutOfRange();

        StoredBuyerTerms storage bt = p.buyers[buyerIndex];
        if (!(bt.owner == msg.sender)) revert BK_NotTheNamedBuyer();

        BuyerPart storage bp = p.buyerParts[buyerIndex];
        if (bp.joined) revert BK_AlreadyJoined();

        Account storage a  = _accs[bt.accountId];
        Pool    storage pl = _pools[p.lenderPoolId];
        Offer   storage o  = _offers[p.offerRefs[0].offerId];

        // Require plan-specific lender approval for this participant.
        // Expiry is already gated by the planOpen modifier's hard-cutoff check.
        if (bt.creditDraw > 0) {
            if (!(_lenderPlanApproval[p.lenderPoolId][planId][buyerIndex].amount == bt.creditDraw))
                revert BK_NoLenderPlanApproval();
            // Aggregate headroom: reserved + outstanding must fit within limit (defect 5)
            uint256 usage = _borrowerUsage[p.lenderPoolId][bt.accountId];
            if (!(usage + bt.creditDraw <= _borrowerLimit[p.lenderPoolId][bt.accountId])) revert BK_AggregateDrawExceedsBorrowerLimit();
        }

        // Require plan-specific supplier approval. Expiry gated by planOpen modifier.
        if (!(_supplierPlanApproval[planId][0].amount == p.offerRefs[0].quantity))
            revert BK_NoSupplierPlanApproval();

        // Check offer is still valid
        if (o.revoked) revert BK_OfferRevoked();
        if (!(block.timestamp < o.expiry)) revert BK_OfferExpired();

        // Check payee matches plan's frozen ref
        if (!(p.offerRefs[0].payee == o.payee)) revert BK_OfferPayeeChanged();

        // ── Check all three resource pools ──────────────────────────────
        if (!(_availCash(a) >= bt.ownCash)) revert BK_InsufficientBuyerCash();
        if (bt.creditDraw > 0) {
            if (!(pl.cash - pl.reserved >= bt.creditDraw)) revert BK_InsufficientPoolLiquidity();
        }
        if (!(o.reserved + o.consumed + bt.quantity <= o.capacity)) revert BK_OfferCapacityExceeded();

        // ── Reserve all three atomically ────────────────────────────────
        a.aggregateHeld   += bt.ownCash;
        a.activePlanCount += 1;

        if (bt.creditDraw > 0) {
            pl.reserved += bt.creditDraw;
            _borrowerUsage[p.lenderPoolId][bt.accountId] += bt.creditDraw;
        }

        o.reserved += bt.quantity;

        uint256 gen = bp.generation + 1;
        bp.joined         = true;
        bp.generation     = gen;
        bp.cashHeld       = bt.ownCash;
        bp.creditReserved = bt.creditDraw;
        p.joinedCount    += 1;

        emit CapacityReserved(p.offerRefs[0].offerId, planId, bt.quantity);
        emit BuyerJoined(planId, bt.accountId, gen);
    }

    // ───────────────────────────────────────────────────────────────────────
    // joinMerchant — merchant authorises and reserves its exact pre-named terms
    // ───────────────────────────────────────────────────────────────────────

    function joinMerchant(uint256 planId)
        external override nonReentrant planOpen(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.kind == WorkflowKind.CustomerOrder)) revert BK_NotCOPlan();
        if (!(p.sale.merchantOwner == msg.sender)) revert BK_NotTheNamedMerchant();
        if (p.merchant.joined) revert BK_AlreadyJoined();

        Account storage ma  = _accs[p.sale.merchantAccountId];
        Pool    storage pl  = _pools[p.lenderPoolId];
        Offer   storage go  = _offers[p.offerRefs[0].offerId];
        Offer   storage fo  = _offers[p.offerRefs[1].offerId];

        // Plan-specific lender approval for merchant. Expiry gated by planOpen modifier.
        if (p.sale.creditDraw > 0) {
            if (!(_lenderPlanApproval[p.lenderPoolId][planId][0].amount == p.sale.creditDraw))
                revert BK_NoLenderPlanApproval();
            // Aggregate headroom check (defect 5)
            uint256 usage = _borrowerUsage[p.lenderPoolId][p.sale.merchantAccountId];
            if (!(usage + p.sale.creditDraw <= _borrowerLimit[p.lenderPoolId][p.sale.merchantAccountId])) revert BK_AggregateDrawExceedsBorrowerLimit();
        }

        // Plan-specific supplier approvals. Expiry gated by planOpen modifier.
        if (!(_supplierPlanApproval[planId][0].amount == p.offerRefs[0].quantity))
            revert BK_NoGoodsSupplierApproval();
        if (!(_supplierPlanApproval[planId][1].amount == p.offerRefs[1].quantity))
            revert BK_NoFreightSupplierApproval();

        // Check offers are still valid
        if (!(!go.revoked && block.timestamp < go.expiry)) revert BK_GoodsOfferInvalid();
        if (!(!fo.revoked && block.timestamp < fo.expiry)) revert BK_FreightOfferInvalid();
        if (!(p.offerRefs[0].payee == go.payee)) revert BK_GoodsPayeeChanged();
        if (!(p.offerRefs[1].payee == fo.payee)) revert BK_FreightPayeeChanged();

        // ── Check all resource pools ────────────────────────────────────
        if (!(_availCash(ma) >= p.sale.merchantCash)) revert BK_InsufficientMerchantCash();
        if (p.sale.creditDraw > 0) {
            if (!(pl.cash - pl.reserved >= p.sale.creditDraw)) revert BK_InsufficientPoolLiquidity();
        }
        if (!(go.reserved + go.consumed + p.offerRefs[0].quantity <= go.capacity)) revert BK_GoodsCapacityExceeded();
        if (!(fo.reserved + fo.consumed + p.offerRefs[1].quantity <= fo.capacity)) revert BK_FreightCapacityExceeded();

        // ── Reserve atomically ──────────────────────────────────────────
        ma.aggregateHeld   += p.sale.merchantCash;
        ma.activePlanCount += 1;

        if (p.sale.creditDraw > 0) {
            pl.reserved += p.sale.creditDraw;
            _borrowerUsage[p.lenderPoolId][p.sale.merchantAccountId] += p.sale.creditDraw;
        }

        go.reserved += p.offerRefs[0].quantity;
        fo.reserved += p.offerRefs[1].quantity;

        p.merchant.joined         = true;
        p.merchant.cashHeld       = p.sale.merchantCash;
        p.merchant.creditReserved = p.sale.creditDraw;
        p.joinedCount            += 1;

        emit CapacityReserved(p.offerRefs[0].offerId, planId, p.offerRefs[0].quantity);
        emit CapacityReserved(p.offerRefs[1].offerId, planId, p.offerRefs[1].quantity);
        emit MerchantJoined(planId, p.sale.merchantAccountId);
    }

    // ───────────────────────────────────────────────────────────────────────
    // fundCustomerEscrow — named customer deposits exact required advance
    // ───────────────────────────────────────────────────────────────────────

    function fundCustomerEscrow(uint256 planId)
        external override nonReentrant planOpen(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.kind == WorkflowKind.CustomerOrder)) revert BK_NotCOPlan();
        if (!(p.sale.customerAddress == msg.sender)) revert BK_NotTheNamedCustomer();
        if (p.escrow.withdrawn) revert BK_EscrowAlreadyConsumed();
        if (!(p.escrow.amount == 0)) revert BK_EscrowAlreadyFunded();

        uint256 amt = p.sale.requiredEscrow;
        _receiveExact(msg.sender, amt);

        p.escrow.customer    = msg.sender;
        p.escrow.amount      = amt;
        p.escrow.withdrawable = false;
        p.escrow.withdrawn   = false;
        _totalEscrow         += amt;

        emit CustomerEscrowFunded(planId, msg.sender, amt);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Leave / release participation bundles
    // ───────────────────────────────────────────────────────────────────────

    function leaveBuyer(uint256 planId, uint256 buyerIndex)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.status == PlanStatus.Open)) revert BK_PlanNotOpen();
        if (!(buyerIndex < p.buyers.length)) revert BK_IndexOutOfRange();
        StoredBuyerTerms storage bt = p.buyers[buyerIndex];
        if (!(bt.owner == msg.sender)) revert BK_NotTheNamedBuyer();
        BuyerPart storage bp = p.buyerParts[buyerIndex];
        if (!(bp.joined)) revert BK_NotJoined();

        uint256 gen = bp.generation;
        _releaseBuyer(p, bt, bp, planId);
        emit BuyerLeft(planId, bt.accountId, gen);
    }

    function leaveMerchant(uint256 planId)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.status == PlanStatus.Open)) revert BK_PlanNotOpen();
        if (!(p.kind == WorkflowKind.CustomerOrder)) revert BK_NotCOPlan();
        if (!(p.sale.merchantOwner == msg.sender)) revert BK_NotTheNamedMerchant();
        if (!(p.merchant.joined)) revert BK_NotJoined();
        _releaseMerchant(p, planId);
        emit MerchantLeft(planId, p.sale.merchantAccountId);
    }

    function revokeLenderApproval(uint256 planId, uint256 participantIndex)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.status == PlanStatus.Open)) revert BK_PlanNotOpen();
        if (!(p.lenderPoolId > 0)) revert BK_NoLenderPool();
        if (!(_pools[p.lenderPoolId].owner == msg.sender)) revert BK_NotPoolOwner();

        if (p.kind == WorkflowKind.CollectivePurchase) {
            if (!(participantIndex < p.buyers.length)) revert BK_IndexOutOfRange();
            BuyerPart storage bp = p.buyerParts[participantIndex];
            if (bp.joined) {
                uint256 gen = bp.generation;
                StoredBuyerTerms storage bt = p.buyers[participantIndex];
                _releaseBuyer(p, bt, bp, planId);
                emit BuyerLeft(planId, bt.accountId, gen);
            }
            delete _lenderPlanApproval[p.lenderPoolId][planId][participantIndex];
        } else {
            // participantIndex must be 0 for the single merchant
            if (!(participantIndex == 0)) revert BK_InvalidIndexForCO();
            if (p.merchant.joined) {
                _releaseMerchant(p, planId);
                emit MerchantLeft(planId, p.sale.merchantAccountId);
            }
            delete _lenderPlanApproval[p.lenderPoolId][planId][0];
        }
    }

    function revokeOfferApproval(uint256 planId, uint256 offerRefIndex)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.status == PlanStatus.Open)) revert BK_PlanNotOpen();
        if (!(offerRefIndex < p.offerRefs.length)) revert BK_IndexOutOfRange();
        uint256 offerId = p.offerRefs[offerRefIndex].offerId;
        if (!(_offers[offerId].supplierOwner == msg.sender)) revert BK_NotOfferOwner();

        // Release all active participation bundles that reference this offer
        if (p.kind == WorkflowKind.CollectivePurchase) {
            for (uint256 i = 0; i < p.buyers.length; i++) {
                BuyerPart storage bp = p.buyerParts[i];
                if (bp.joined) {
                    uint256 gen = bp.generation;
                    StoredBuyerTerms storage bt = p.buyers[i];
                    _releaseBuyer(p, bt, bp, planId);
                    emit BuyerLeft(planId, bt.accountId, gen);
                }
            }
        } else {
            if (p.merchant.joined) {
                _releaseMerchant(p, planId);
                emit MerchantLeft(planId, p.sale.merchantAccountId);
            }
        }
        // Clear the supplier approval so a fresh approveSupplierPlan is required before rejoin
        delete _supplierPlanApproval[planId][offerRefIndex];
        _supplierPlanRevoked[planId][offerRefIndex] = true;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Commit — atomic close
    // ───────────────────────────────────────────────────────────────────────

    function commitPlan(uint256 planId)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (p.consumed) revert BK_AlreadyCommitted();
        if (!(p.status == PlanStatus.Open)) revert BK_PlanNotOpen();
        if (!(block.timestamp < p.expiry)) revert BK_PlanExpired();

        // Validate offer refs are still valid
        for (uint256 i = 0; i < p.offerRefs.length; i++) {
            Offer storage o = _offers[p.offerRefs[i].offerId];
            if (o.revoked) revert BK_OfferRevoked();
            if (!(block.timestamp < o.expiry)) revert BK_OfferExpired();
            if (!(p.offerRefs[i].payee == o.payee)) revert BK_PayeeChanged();
            // Supplier approval must have been granted; expiry covered by hard-cutoff check above
            if (_supplierPlanApproval[planId][i].expiry == 0) revert BK_NoSupplierPlanApproval();
        }

        // Validate hard approval cutoff (covers all individual approval deadlines)
        if (p.hardCutoff == 0 || !(block.timestamp < p.hardCutoff)) revert BK_ApprovalCutoffExpired();

        if (p.kind == WorkflowKind.CollectivePurchase) {
            _commitCP(planId, p);
        } else {
            // Confirm CO lender approval not cleared (expiry covered by hard-cutoff check above)
            if (p.sale.creditDraw > 0) {
                if (_lenderPlanApproval[p.lenderPoolId][planId][0].expiry == 0)
                    revert BK_NoLenderPlanApproval();
            }
            _commitCO(planId, p);
        }

        p.consumed    = true;
        p.status      = PlanStatus.Committed;
        p.committedAt = block.timestamp;
    }

    function _commitCP(uint256 planId, Plan storage p) private {
        uint256 offerId  = p.offerRefs[0].offerId;
        uint256 offerQty = p.offerRefs[0].quantity;
        address payee    = p.offerRefs[0].payee;
        uint256 poolId   = p.lenderPoolId;
        bytes32 hash     = p.termsHash;

        // 1. Verify and accumulate; confirm lender approval not cleared (expiry covered by cutoff check)
        uint256 totalQty;
        for (uint256 i = 0; i < p.buyers.length; i++) {
            if (!(p.buyerParts[i].joined)) revert BK_BuyerNotJoined();
            if (p.buyers[i].creditDraw > 0) {
                if (_lenderPlanApproval[poolId][planId][i].expiry == 0) revert BK_NoLenderPlanApproval();
            }
            totalQty += p.buyers[i].quantity;
        }
        if (!(totalQty == offerQty)) revert BK_QuantityMismatch();
        if (!(totalQty >= _offers[offerId].minimumFill)) revert BK_BelowMinimumFill();

        // 2. Consume each buyer
        uint256 totalPrincipal;
        for (uint256 i = 0; i < p.buyers.length; i++) {
            totalPrincipal += _consumeBuyer(planId, p, i, poolId);
        }

        // 3. Consume capacity and pay
        Offer storage o = _offers[offerId];
        o.reserved -= totalQty;
        o.consumed += totalQty;
        emit CapacityConsumed(offerId, planId, totalQty);

        uint256 supplierPayout = o.unitPrice * totalQty;
        _usdc.safeTransfer(payee, supplierPayout);

        emit PlanCommitted(planId, hash, supplierPayout, 0, totalPrincipal);
    }

    function _consumeBuyer(
        uint256 planId,
        Plan storage p,
        uint256 i,
        uint256 poolId
    ) private returns (uint256 drawn) {
        StoredBuyerTerms storage bt = p.buyers[i];
        BuyerPart        storage bp = p.buyerParts[i];
        Account          storage a  = _accs[bt.accountId];

        a.cash            -= bt.ownCash;
        a.aggregateHeld   -= bt.ownCash;
        a.activePlanCount -= 1;
        _totalAccountCash -= bt.ownCash;
        bp.joined          = false;
        bp.cashHeld        = 0;
        bp.creditReserved  = 0;
        p.joinedCount     -= 1;

        if (bt.creditDraw > 0) {
            _pools[poolId].cash     -= bt.creditDraw;
            _pools[poolId].reserved -= bt.creditDraw;
            _totalPoolCash          -= bt.creditDraw;
            a.outstandingPrincipal  += bt.creditDraw;
            // Reserved becomes outstanding; usage stays the same (reserved → outstanding)
            _createLoanRecord(planId, bt.accountId, poolId, bt.creditDraw);
            drawn = bt.creditDraw;
        }
    }

    function _commitCO(uint256 planId, Plan storage p) private {
        if (!(p.merchant.joined)) revert BK_MerchantNotJoined();
        if (!(p.escrow.amount == p.sale.requiredEscrow)) revert BK_EscrowNotFullyFunded();
        if (p.escrow.withdrawn) revert BK_EscrowWithdrawn();
        if (!(p.sale.customerAddress == p.escrow.customer)) revert BK_WrongCustomer();

        // Load all terms into memory to reduce stack pressure from storage pointers
        uint256 merchantAccId    = p.sale.merchantAccountId;
        uint256 cashHeld         = p.merchant.cashHeld;
        uint256 creditReserved   = p.merchant.creditReserved;
        uint256 poolId           = p.lenderPoolId;
        uint256 goodsOfferId     = p.offerRefs[0].offerId;
        uint256 freightOfferId   = p.offerRefs[1].offerId;
        uint256 goodsQty         = p.offerRefs[0].quantity;
        uint256 freightQty       = p.offerRefs[1].quantity;
        address goodsPayee       = p.offerRefs[0].payee;
        address freightPayee     = p.offerRefs[1].payee;

        uint256 supplierCost = _offers[goodsOfferId].unitPrice   * goodsQty;
        uint256 freightCost  = _offers[freightOfferId].unitPrice * freightQty;

        {
            uint256 sources = p.escrow.amount + cashHeld + creditReserved;
            if (!(sources == supplierCost + freightCost)) revert BK_SourcesNeqPayout();
        }
        if (!(goodsQty   >= _offers[goodsOfferId].minimumFill))   revert BK_BelowMinimumFill();
        if (!(freightQty >= _offers[freightOfferId].minimumFill)) revert BK_BelowMinimumFill();

        // Consume merchant cash hold
        _accs[merchantAccId].cash          -= cashHeld;
        _accs[merchantAccId].aggregateHeld -= cashHeld;
        _accs[merchantAccId].activePlanCount -= 1;
        _totalAccountCash                  -= cashHeld;

        // Draw credit
        uint256 principal = _drawCreditCO(planId, merchantAccId, poolId, creditReserved);

        // Consume escrow
        _totalEscrow     -= p.escrow.amount;
        p.escrow.amount      = 0;
        p.merchant.joined    = false;
        p.merchant.cashHeld  = 0;
        p.merchant.creditReserved = 0;
        p.joinedCount       -= 1;
        p.salesOps.saleReceivable = p.sale.saleValue - p.sale.requiredEscrow;

        // Consume capacity
        _offers[goodsOfferId].reserved   -= goodsQty;
        _offers[goodsOfferId].consumed   += goodsQty;
        _offers[freightOfferId].reserved -= freightQty;
        _offers[freightOfferId].consumed += freightQty;
        emit CapacityConsumed(goodsOfferId,   planId, goodsQty);
        emit CapacityConsumed(freightOfferId, planId, freightQty);

        // External payouts
        _usdc.safeTransfer(goodsPayee,   supplierCost);
        _usdc.safeTransfer(freightPayee, freightCost);

        emit PlanCommitted(planId, p.termsHash, supplierCost, freightCost, principal);
    }

    function _drawCreditCO(
        uint256 planId,
        uint256 merchantAccId,
        uint256 poolId,
        uint256 creditReserved
    ) private returns (uint256 principal) {
        if (creditReserved == 0) return 0;
        _pools[poolId].cash     -= creditReserved;
        _pools[poolId].reserved -= creditReserved;
        _totalPoolCash          -= creditReserved;
        _accs[merchantAccId].outstandingPrincipal += creditReserved;
        _planLoanId[planId] = _createLoanRecord(planId, merchantAccId, poolId, creditReserved);
        return creditReserved;
    }

    // ───────────────────────────────────────────────────────────────────────
    // Cancel and expiry release
    // ───────────────────────────────────────────────────────────────────────

    function cancelPlan(uint256 planId)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.status == PlanStatus.Open)) revert BK_PlanNotOpen();
        // Coordinator, required parties, and suppliers may cancel (defect 9)
        bool isParty = (p.coordinator == msg.sender);
        if (!isParty) {
            if (p.kind == WorkflowKind.CollectivePurchase) {
                for (uint256 i = 0; i < p.buyers.length; i++) {
                    if (p.buyers[i].owner == msg.sender) { isParty = true; break; }
                }
                if (!isParty && p.lenderPoolId > 0 && _pools[p.lenderPoolId].owner == msg.sender)
                    isParty = true;
                // Supplier may cancel a CP plan they supplied
                if (!isParty && p.offerRefs.length > 0) {
                    if (_offers[p.offerRefs[0].offerId].supplierOwner == msg.sender)
                        isParty = true;
                }
            } else {
                if (p.sale.merchantOwner == msg.sender || p.sale.customerAddress == msg.sender)
                    isParty = true;
                if (!isParty && p.lenderPoolId > 0 && _pools[p.lenderPoolId].owner == msg.sender)
                    isParty = true;
                // Supplier may cancel a CO plan they supplied
                if (!isParty) {
                    for (uint256 i = 0; i < p.offerRefs.length; i++) {
                        if (_offers[p.offerRefs[i].offerId].supplierOwner == msg.sender) {
                            isParty = true; break;
                        }
                    }
                }
            }
        }
        // Past deadline: permissionless cancellation
        if (!isParty) {
            if (!(block.timestamp >= p.expiry)) revert BK_NotAParty();
        }

        _releaseAll(p, planId);
        p.status = PlanStatus.Cancelled;
        emit PlanCancelled(planId, msg.sender);
    }

    function releaseExpiredPlan(uint256 planId)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.status == PlanStatus.Open)) revert BK_PlanNotOpen();
        bool expired = block.timestamp >= p.expiry;
        bool invalid;
        for (uint256 i; i < p.offerRefs.length; i++) {
            Offer storage offer = _offers[p.offerRefs[i].offerId];
            if (block.timestamp >= offer.expiry) expired = true;
            if (offer.revoked || _supplierPlanRevoked[planId][i]) invalid = true;
        }
        // The hardCutoff scalar tracks the earliest approval expiry; if any approval has
        // expired, cleanup is permitted without looping over participants.
        if (!expired && p.hardCutoff > 0 && block.timestamp >= p.hardCutoff) expired = true;
        if (!expired && !invalid) revert BK_NotYetExpired();

        _releaseAll(p, planId);
        p.status = expired ? PlanStatus.Expired : PlanStatus.Cancelled;
        if (expired) emit PlanExpiredReleased(planId);
        else emit PlanCancelled(planId, msg.sender);
    }

    function withdrawCustomerEscrow(uint256 planId)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.kind == WorkflowKind.CustomerOrder)) revert BK_NotCOPlan();
        if (!(p.escrow.customer == msg.sender)) revert BK_NotCustomer();
        if (!(p.escrow.withdrawable)) revert BK_NotRefundable();
        if (!(!p.escrow.withdrawn)) revert BK_AlreadyWithdrawn();
        uint256 amt = p.escrow.amount;
        if (!(amt > 0)) revert BK_ZeroEscrow();

        p.escrow.withdrawn = true;
        p.escrow.amount    = 0;
        _totalEscrow      -= amt;

        _usdc.safeTransfer(msg.sender, amt);
        emit CustomerEscrowWithdrawn(planId, msg.sender, amt);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Post-commit: acknowledgments and customer acceptance
    // ───────────────────────────────────────────────────────────────────────

    function acknowledgeGoods(uint256 planId)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.kind == WorkflowKind.CustomerOrder)) revert BK_NotCOPlan();
        if (!(p.status == PlanStatus.Committed)) revert BK_NotCommitted();
        if (!(p.sale.merchantOwner == msg.sender)) revert BK_NotMerchantOwner();
        if (p.salesOps.goodsAcked) revert BK_AlreadyAcknowledged();

        p.salesOps.goodsAcked = true;
        emit GoodsAcknowledged(planId, p.offerRefs[0].quantity);
    }

    function acknowledgeFreight(uint256 planId)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.kind == WorkflowKind.CustomerOrder)) revert BK_NotCOPlan();
        if (!(p.status == PlanStatus.Committed)) revert BK_NotCommitted();
        if (!(p.sale.merchantOwner == msg.sender)) revert BK_NotMerchantOwner();
        if (p.salesOps.freightAcked) revert BK_AlreadyAcknowledged();

        p.salesOps.freightAcked = true;
        emit FreightAcknowledged(planId, p.offerRefs[1].quantity);
    }

    function acceptSalesOrder(uint256 planId)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.kind == WorkflowKind.CustomerOrder)) revert BK_NotCOPlan();
        if (!(p.status == PlanStatus.Committed)) revert BK_NotCommitted();
        if (!(p.sale.customerAddress == msg.sender)) revert BK_NotNamedCustomer();
        if (!(p.salesOps.goodsAcked)) revert BK_GoodsNotAcknowledged();
        if (!(p.salesOps.freightAcked)) revert BK_FreightNotAcknowledged();
        if (p.salesOps.customerAccepted) revert BK_AlreadyAccepted();

        p.salesOps.customerAccepted = true;

        emit CustomerAccepted(planId, p.sale.saleValue,
                               p.sale.requiredEscrow,
                               p.salesOps.saleReceivable);
    }

    function collectSalesBalance(uint256 planId, bytes32 receiptRef, uint256 amount)
        external override nonReentrant planExists(planId)
    {
        Plan storage p = _plans[planId];
        if (!(p.kind == WorkflowKind.CustomerOrder)) revert BK_NotCOPlan();
        if (!(p.status == PlanStatus.Committed)) revert BK_NotCommitted();
        if (!(p.salesOps.customerAccepted)) revert BK_AcceptanceRequiredFirst();
        if (!(p.sale.customerAddress == msg.sender)) revert BK_NotNamedCustomer();
        if (!(amount > 0)) revert BK_ZeroAmount();
        if (!(!_salesReceiptUsed[planId][receiptRef])) revert BK_ReceiptRefAlreadyUsed();

        uint256 remaining = p.salesOps.saleReceivable - p.salesOps.collected;
        if (!(amount <= remaining)) revert BK_ExceedsRemainingBalance();

        // Mark receipt ref consumed BEFORE transfer (replay protection)
        _salesReceiptUsed[planId][receiptRef] = true;
        p.salesOps.collected += amount;

        // Pull USDC from customer — exact-receipt guard resets state on mismatch
        _receiveExact(msg.sender, amount);

        // Principal-first waterfall: direct lookup (O(1))
        uint256 principalRepaid = 0;
        uint256 merchantCredit  = amount;

        uint256 loanId = _planLoanId[planId];
        if (loanId > 0) {
            Loan storage loan = _loans[loanId];
            if (loan.outstanding > 0) {
                uint256 repay = amount < loan.outstanding ? amount : loan.outstanding;
                loan.outstanding -= repay;
                _pools[loan.lenderPoolId].cash += repay;
                _accs[p.sale.merchantAccountId].outstandingPrincipal -= repay;
                _borrowerUsage[loan.lenderPoolId][p.sale.merchantAccountId] -= repay;
                principalRepaid  = repay;
                merchantCredit  -= repay;
                emit LoanRepaid(loanId, repay, loan.outstanding);
            }
        }

        // Credit merchant cash and pool cash (principal-first waterfall)
        if (principalRepaid > 0) {
            _totalPoolCash += principalRepaid;
        }
        if (merchantCredit > 0) {
            _accs[p.sale.merchantAccountId].cash += merchantCredit;
            _totalAccountCash                    += merchantCredit;
        }

        emit SalesCollected(planId, receiptRef, amount, principalRepaid, merchantCredit);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Group opening receivables
    // ───────────────────────────────────────────────────────────────────────

    function registerReceivable(
        uint256 receivableId,
        uint256 beneficiaryAccountId,
        address boundPayer,
        uint256 amount,
        bytes32 provenance
    ) external override nonReentrant {
        if (_receivables[receivableId].exists) revert BK_ReceivableExists();
        if (!(amount > 0)) revert BK_ZeroAmount();
        if (!(boundPayer != address(0))) revert BK_ZeroPayer();
        Account storage a = _accs[beneficiaryAccountId];
        if (!(a.owner == msg.sender)) revert BK_NotBeneficiaryOwner();

        _receivables[receivableId] = Receivable({
            beneficiaryAccountId: beneficiaryAccountId,
            boundPayer:           boundPayer,
            openingAmount:        amount,
            remaining:            amount,
            exists:               true
        });
        // Provenance stored in contract state (defect 10)
        _receivableProvenance[receivableId]   = provenance;
        _receivableRegistrar[receivableId]    = msg.sender;
        _receivableRegisteredAt[receivableId] = block.timestamp;

        emit ReceivableRegistered(receivableId, beneficiaryAccountId, boundPayer, amount);
    }

    function collectReceivable(
        uint256 receivableId,
        bytes32 paymentRef,
        uint256 amount
    ) external override nonReentrant {
        Receivable storage r = _receivables[receivableId];
        if (!(r.exists)) revert BK_ReceivableNotFound();
        if (!(r.boundPayer == msg.sender)) revert BK_NotBoundPayer();
        if (!(amount > 0)) revert BK_ZeroAmount();
        if (!(amount <= r.remaining)) revert BK_ExceedsRemaining();
        if (_receiptUsed[receivableId][paymentRef]) revert BK_PaymentRefUsed();

        // Mark ref before transfer
        _receiptUsed[receivableId][paymentRef] = true;
        r.remaining -= amount;

        // Pull actual USDC from the bound payer — exact-receipt guard resets on mismatch
        _receiveExact(msg.sender, amount);

        // Credit the fixed beneficiary account
        _accs[r.beneficiaryAccountId].cash += amount;
        _totalAccountCash                  += amount;

        emit ReceivableCollected(receivableId, paymentRef, msg.sender,
                                  r.beneficiaryAccountId, amount, r.remaining);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Voluntary loan repayment (from own free cash, internal reallocation)
    // ───────────────────────────────────────────────────────────────────────

    function repayLoan(uint256 loanId, uint256 amount)
        external override nonReentrant
    {
        if (!(loanId > 0 && loanId < _nextLoanId)) revert BK_LoanNotFound();
        Loan    storage loan = _loans[loanId];
        Account storage a    = _accs[loan.borrowerAccountId];
        if (!(a.owner == msg.sender)) revert BK_NotBorrowerOwner();
        if (!(amount > 0)) revert BK_ZeroAmount();
        if (!(amount <= loan.outstanding)) revert BK_ExceedsOutstanding();
        if (!(_availCash(a) >= amount)) revert BK_InsufficientAvailableCash();

        // Internal reallocation: no external transfer
        a.cash                   -= amount;
        a.outstandingPrincipal   -= amount;
        loan.outstanding         -= amount;
        _pools[loan.lenderPoolId].cash += amount;
        // Claim counters: account loses, pool gains
        _totalAccountCash -= amount;
        _totalPoolCash    += amount;
        // Borrower aggregate usage decreases as outstanding shrinks
        _borrowerUsage[loan.lenderPoolId][loan.borrowerAccountId] -= amount;

        emit InternalRepayment(loanId, loan.borrowerAccountId, amount);
        emit LoanRepaid(loanId, amount, loan.outstanding);
    }

    // ───────────────────────────────────────────────────────────────────────
    // receive() — reject native deposits; log surplus for unsolicited ERC-20
    // ───────────────────────────────────────────────────────────────────────

    receive() external payable {
        revert("BK: no native deposits");
    }

    // ───────────────────────────────────────────────────────────────────────
    // Internal release helpers
    // ───────────────────────────────────────────────────────────────────────

    function _createLoanRecord(
        uint256 planId,
        uint256 borrowerAccId,
        uint256 poolId,
        uint256 amount
    ) private returns (uint256 loanId) {
        loanId = _nextLoanId++;
        _loans[loanId] = Loan({
            planId:            planId,
            borrowerAccountId: borrowerAccId,
            lenderPoolId:      poolId,
            originalPrincipal: amount,
            outstanding:       amount
        });
        emit PrincipalCreated(loanId, planId, borrowerAccId, amount);
    }

    function _releaseBuyer(
        Plan storage p,
        StoredBuyerTerms storage bt,
        BuyerPart        storage bp,
        uint256 planId
    ) private {
        Account storage a = _accs[bt.accountId];
        a.aggregateHeld   -= bp.cashHeld;
        a.activePlanCount -= 1;

        if (bp.creditReserved > 0) {
            _pools[p.lenderPoolId].reserved -= bp.creditReserved;
            _borrowerUsage[p.lenderPoolId][bt.accountId] -= bp.creditReserved;
        }

        Offer storage o = _offers[p.offerRefs[0].offerId];
        o.reserved -= bt.quantity;

        bp.joined         = false;
        bp.cashHeld       = 0;
        bp.creditReserved = 0;
        p.joinedCount    -= 1;

        emit CapacityReleased(p.offerRefs[0].offerId, planId, bt.quantity);
    }

    function _releaseMerchant(Plan storage p, uint256 planId) private {
        Account storage ma = _accs[p.sale.merchantAccountId];
        ma.aggregateHeld   -= p.merchant.cashHeld;
        ma.activePlanCount -= 1;

        if (p.merchant.creditReserved > 0) {
            _pools[p.lenderPoolId].reserved -= p.merchant.creditReserved;
            _borrowerUsage[p.lenderPoolId][p.sale.merchantAccountId] -= p.merchant.creditReserved;
        }

        _offers[p.offerRefs[0].offerId].reserved -= p.offerRefs[0].quantity;
        _offers[p.offerRefs[1].offerId].reserved -= p.offerRefs[1].quantity;

        p.merchant.joined         = false;
        p.merchant.cashHeld       = 0;
        p.merchant.creditReserved = 0;
        p.joinedCount            -= 1;

        emit CapacityReleased(p.offerRefs[0].offerId, planId, p.offerRefs[0].quantity);
        emit CapacityReleased(p.offerRefs[1].offerId, planId, p.offerRefs[1].quantity);
    }

    function _releaseAll(Plan storage p, uint256 planId) private {
        if (p.kind == WorkflowKind.CollectivePurchase) {
            for (uint256 i = 0; i < p.buyers.length; i++) {
                if (p.buyerParts[i].joined) {
                    _releaseBuyer(p, p.buyers[i], p.buyerParts[i], planId);
                }
            }
        } else {
            if (p.merchant.joined) {
                _releaseMerchant(p, planId);
            }
            // Make customer escrow refundable (no transfer; stays in _totalEscrow until withdrawn)
            if (p.escrow.amount > 0 && !p.escrow.withdrawn) {
                p.escrow.withdrawable = true;
                emit CustomerEscrowWithdrawable(planId, p.escrow.customer, p.escrow.amount);
            }
        }
    }

    function _availCash(Account storage a) private view returns (uint256) {
        uint256 locked = a.floor + a.aggregateHeld;
        if (a.cash <= locked) return 0;
        return a.cash - locked;
    }

    // ───────────────────────────────────────────────────────────────────────
    // View functions
    // ───────────────────────────────────────────────────────────────────────

    function usdc() external view override returns (address) {
        return address(_usdc);
    }

    function lender() external view override returns (address) {
        return _lender;
    }

    function accountOf(address owner) external view override returns (uint256) {
        return _ownerToAcc[owner];
    }

    function getAccount(uint256 accId) external view override returns (
        address owner,
        uint256 cash,
        uint256 floor,
        uint256 aggregateHeld,
        uint256 activePlanCount,
        uint256 outstandingPrincipal
    ) {
        Account storage a = _accs[accId];
        owner              = a.owner;
        cash               = a.cash;
        floor              = a.floor;
        aggregateHeld      = a.aggregateHeld;
        activePlanCount    = a.activePlanCount;
        outstandingPrincipal = a.outstandingPrincipal;
    }

    function getPool(uint256 poolId) external view override returns (
        address owner, uint256 cash, uint256 reserved
    ) {
        Pool storage pl = _pools[poolId];
        owner    = pl.owner;
        cash     = pl.cash;
        reserved = pl.reserved;
    }

    function getOffer(uint256 offerId) external view override returns (
        address supplierOwner, address payee, uint256 unitPrice,
        uint256 capacity, uint256 minimumFill, uint256 reserved, uint256 consumed,
        uint256 expiry, bool revoked
    ) {
        Offer storage o = _offers[offerId];
        supplierOwner = o.supplierOwner;
        payee         = o.payee;
        unitPrice     = o.unitPrice;
        capacity      = o.capacity;
        minimumFill   = o.minimumFill;
        reserved      = o.reserved;
        consumed      = o.consumed;
        expiry        = o.expiry;
        revoked       = o.revoked;
    }

    function getPlan(uint256 planId) external view override returns (
        WorkflowKind kind, PlanStatus status,
        bytes32 termsHash, uint256 expiry, uint256 committedAt
    ) {
        Plan storage p = _plans[planId];
        kind       = p.kind;
        status     = p.status;
        termsHash  = p.termsHash;
        expiry     = p.expiry;
        committedAt = p.committedAt;
    }

    function getBuyerParticipation(uint256 planId, uint256 buyerIndex) external view override returns (
        bool joined, uint256 generation, uint256 cashHeld, uint256 creditReserved
    ) {
        BuyerPart storage bp = _plans[planId].buyerParts[buyerIndex];
        joined         = bp.joined;
        generation     = bp.generation;
        cashHeld       = bp.cashHeld;
        creditReserved = bp.creditReserved;
    }

    function getMerchantParticipation(uint256 planId) external view override returns (
        bool joined, uint256 cashHeld, uint256 creditReserved
    ) {
        MerchantPart storage mp = _plans[planId].merchant;
        joined         = mp.joined;
        cashHeld       = mp.cashHeld;
        creditReserved = mp.creditReserved;
    }

    function getEscrow(uint256 planId) external view override returns (
        address customer, uint256 amount, bool withdrawable, bool withdrawn
    ) {
        Escrow storage e = _plans[planId].escrow;
        customer     = e.customer;
        amount       = e.amount;
        withdrawable = e.withdrawable;
        withdrawn    = e.withdrawn;
    }

    function getLoan(uint256 loanId) external view override returns (
        uint256 planId, uint256 borrowerAccountId, uint256 lenderPoolId,
        uint256 originalPrincipal, uint256 outstanding
    ) {
        Loan storage l = _loans[loanId];
        planId             = l.planId;
        borrowerAccountId  = l.borrowerAccountId;
        lenderPoolId       = l.lenderPoolId;
        originalPrincipal  = l.originalPrincipal;
        outstanding        = l.outstanding;
    }

    function getReceivable(uint256 receivableId) external view override returns (
        uint256 beneficiaryAccountId, address boundPayer,
        uint256 openingAmount, uint256 remaining,
        bytes32 provenance, address registrar, uint256 registeredAt
    ) {
        Receivable storage r = _receivables[receivableId];
        if (!(r.exists)) revert BK_NotFound();
        beneficiaryAccountId = r.beneficiaryAccountId;
        boundPayer           = r.boundPayer;
        openingAmount        = r.openingAmount;
        remaining            = r.remaining;
        provenance           = _receivableProvenance[receivableId];
        registrar            = _receivableRegistrar[receivableId];
        registeredAt         = _receivableRegisteredAt[receivableId];
    }

    function getSalesState(uint256 planId) external view override returns (
        bool goodsAcknowledged, bool freightAcknowledged, bool customerAccepted,
        uint256 saleReceivable, uint256 collected
    ) {
        SalesOps storage s = _plans[planId].salesOps;
        goodsAcknowledged  = s.goodsAcked;
        freightAcknowledged = s.freightAcked;
        customerAccepted   = s.customerAccepted;
        saleReceivable     = s.saleReceivable;
        collected          = s.collected;
    }

    function planReadiness(uint256 planId) external view override returns (
        bool ready, string memory blockedReason
    ) {
        if (planId == 0 || planId >= _nextPlanId) return (false, "Plan not found");
        Plan storage p = _plans[planId];
        if (p.status != PlanStatus.Open || block.timestamp >= p.expiry)
            return (false, "Plan not open or expired");

        for (uint256 i = 0; i < p.offerRefs.length; i++) {
            Offer storage o = _offers[p.offerRefs[i].offerId];
            if (o.revoked || block.timestamp >= o.expiry || p.offerRefs[i].payee != o.payee)
                return (false, "Offer invalid");
        }

        // Scalar check: if any approval has expired, surface it as a single blocker
        if (p.hardCutoff == 0)                   return (false, "No approvals granted");
        if (block.timestamp >= p.hardCutoff)     return (false, "Approval expired");

        if (p.kind == WorkflowKind.CollectivePurchase) {
            uint256 totalQty;
            for (uint256 i = 0; i < p.buyers.length; i++) {
                if (!p.buyerParts[i].joined) return (false, "Buyer not joined");
                totalQty += p.buyers[i].quantity;
            }
            if (totalQty != p.offerRefs[0].quantity) return (false, "Quantity mismatch");
            if (totalQty < _offers[p.offerRefs[0].offerId].minimumFill)
                return (false, "Below offer minimum fill");
        } else {
            if (!p.merchant.joined)          return (false, "Merchant not joined");
            if (p.escrow.amount != p.sale.requiredEscrow || p.escrow.withdrawn)
                return (false, "Escrow not ready");
            uint256 goodsQty   = p.offerRefs[0].quantity;
            uint256 freightQty = p.offerRefs[1].quantity;
            if (p.escrow.amount + p.merchant.cashHeld + p.merchant.creditReserved
                != _offers[p.offerRefs[0].offerId].unitPrice * goodsQty
                 + _offers[p.offerRefs[1].offerId].unitPrice * freightQty)
                return (false, "Funding mismatch");
            if (goodsQty   < _offers[p.offerRefs[0].offerId].minimumFill)
                return (false, "Below goods offer minimum fill");
            if (freightQty < _offers[p.offerRefs[1].offerId].minimumFill)
                return (false, "Below freight offer minimum fill");
        }

        return (true, "");
    }

    function totalCustody() external view override returns (uint256) {
        return _usdc.balanceOf(address(this));
    }

    function accountedCustody() external view override returns (uint256) {
        // Sum of independently maintained claim counters (defect 6).
        // accountCash + poolCash + activeEscrow = all legitimate claims.
        // Any ERC-20 balance above this is unsolicited surplus.
        return _totalAccountCash + _totalPoolCash + _totalEscrow;
    }

    function getLenderPlanApproval(uint256 planId, uint256 participantIndex)
        external view override returns (uint256 approvedDraw, uint256 approvalExpiry)
    {
        Plan storage p = _plans[planId];
        if (!(p.lenderPoolId > 0)) revert BK_NoLenderPool();
        Approval storage a = _lenderPlanApproval[p.lenderPoolId][planId][participantIndex];
        approvedDraw  = a.amount;
        approvalExpiry = a.expiry;
    }

    function getSupplierPlanApproval(uint256 planId, uint256 offerRefIndex)
        external view override returns (uint256 approvedQuantity, uint256 approvalExpiry)
    {
        Approval storage a = _supplierPlanApproval[planId][offerRefIndex];
        approvedQuantity = a.amount;
        approvalExpiry   = a.expiry;
    }

    function getBorrowerUsage(uint256 poolId, uint256 borrowerAccountId)
        external view override returns (uint256 usage)
    {
        return _borrowerUsage[poolId][borrowerAccountId];
    }

    function getPlanCoordinator(uint256 planId)
        external view override returns (address coordinator)
    {
        return _plans[planId].coordinator;
    }
}
