// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import "../BusinessKernel.sol";
import "../IBusinessKernel.sol";

/**
 * @notice Shared test infrastructure: mock ERC-20, demo amounts, fixture builders.
 *
 * All monetary amounts are at demo scale (÷1000 from business scale),
 * expressed as 6-decimal USDC micro-units.
 * e.g. 300 USDC business = 0.300 USDC demo = 300_000 micro-USDC
 *
 * Demo amounts (business ÷ 1000, then × 10^6 for 6 decimals):
 *   300 biz → 0.300 demo → 300_000 µUSDC
 */
contract MockERC20 {
    string public name   = "Mock USDC";
    string public symbol = "USDC";
    uint8  public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 private _totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        _totalSupply   += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "ERC20: balance");
        require(allowance[from][msg.sender] >= amount, "ERC20: allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}

abstract contract KernelBase is Test {

    // ── Demo scale multiplier ────────────────────────────────────────────
    // business amount / 1000, then * 10^6 for USDC decimals
    // So 1 business USDC = 1000 µUSDC at demo scale
    uint256 internal constant D = 1000; // 1 demo-unit = 1000 µUSDC

    function u(uint256 businessUsdc) internal pure returns (uint256) {
        return businessUsdc * D; // µUSDC at demo scale
    }

    // ── Contracts ───────────────────────────────────────────────────────
    MockERC20       internal tok;
    BusinessKernel  internal kernel;

    // ── Addresses ───────────────────────────────────────────────────────
    address internal lender  = makeAddr("lender");
    address internal supplierA = makeAddr("supplierA");
    address internal supplierB = makeAddr("supplierB"); // freight payee
    address internal buyerA  = makeAddr("buyerA");
    address internal buyerB  = makeAddr("buyerB");
    address internal buyerC  = makeAddr("buyerC");
    address internal merchant = makeAddr("merchant");
    address internal customer = makeAddr("customer");
    address internal stranger = makeAddr("stranger");

    // ── Fixture account IDs (set in setUp) ──────────────────────────────
    uint256 internal lenderPool;
    uint256 internal accA;
    uint256 internal accB;
    uint256 internal accC;
    uint256 internal accMerchant;

    // ── Offer IDs ───────────────────────────────────────────────────────
    uint256 internal offerGroup;   // 100 units @ 9
    uint256 internal offerGoods;   // 100 units @ 60  (sale)
    uint256 internal offerFreight; // 1 unit @ 500    (sale)

    uint256 internal constant OFFER_EXPIRY = 365 days;

    function setUp() public virtual {
        tok    = new MockERC20();
        kernel = new BusinessKernel(address(tok), lender);

        // ── Pool is initialized at construction; ID is always 1 ──────────
        lenderPool = kernel.POOL_ID();

        // ── Open accounts ────────────────────────────────────────────────
        vm.prank(buyerA);  accA       = kernel.openAccount();
        vm.prank(buyerB);  accB       = kernel.openAccount();
        vm.prank(buyerC);  accC       = kernel.openAccount();
        vm.prank(merchant); accMerchant = kernel.openAccount();

        // ── Create offers ────────────────────────────────────────────────
        uint256 exp = block.timestamp + OFFER_EXPIRY;

        vm.prank(supplierA);
        // Group offer: capacity 100, minimumFill 100 (canonical full-fill requirement)
        offerGroup = kernel.createOffer(supplierA, u(9), 100, 100, exp);

        vm.prank(supplierA);
        // Goods offer: capacity 100, minimumFill 100
        offerGoods = kernel.createOffer(supplierA, u(60), 100, 100, exp);

        vm.prank(supplierB);
        // Freight offer: capacity 1, minimumFill 1
        offerFreight = kernel.createOffer(supplierB, u(500), 1, 1, exp);
    }

    // ── Funding helpers ──────────────────────────────────────────────────

    function fundAccount(address owner, uint256 accId, uint256 amount) internal {
        tok.mint(owner, amount);
        vm.prank(owner);
        tok.approve(address(kernel), amount);
        vm.prank(owner);
        kernel.depositCash(accId, amount);
    }

    function fundPool(uint256 amount) internal {
        tok.mint(lender, amount);
        vm.prank(lender);
        tok.approve(address(kernel), amount);
        vm.prank(lender);
        kernel.depositPool(lenderPool, amount);
    }

    // ── Plan-term builders ───────────────────────────────────────────────

    function _cpTerms(
        uint256[3] memory qtys,   // A, B, C quantities
        uint256[3] memory cash,   // A, B, C own cash
        uint256[3] memory credit, // A, B, C credit draws
        uint256[3] memory limits, // A, B, C credit limits
        uint256 offerQty,
        uint256 exp
    ) internal view returns (IBusinessKernel.PlanTerms memory t) {
        IBusinessKernel.BuyerTerms[] memory buyers =
            new IBusinessKernel.BuyerTerms[](3);
        buyers[0] = IBusinessKernel.BuyerTerms(buyerA, accA, qtys[0], cash[0], credit[0], limits[0]);
        buyers[1] = IBusinessKernel.BuyerTerms(buyerB, accB, qtys[1], cash[1], credit[1], limits[1]);
        buyers[2] = IBusinessKernel.BuyerTerms(buyerC, accC, qtys[2], cash[2], credit[2], limits[2]);

        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(offerGroup, offerQty, supplierA);

        t = IBusinessKernel.PlanTerms({
            kind:        IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers:      buyers,
            saleParty:   IBusinessKernel.SalePartyTerms(address(0), 0, 0, 0, 0, address(0), 0, 0),
            lenderPoolId: lenderPool,
            offerRefs:   refs,
            expiry:      exp,
            commercialRef: bytes32("cp-v1")
        });
    }

    function _coTerms(uint256 exp) internal view returns (IBusinessKernel.PlanTerms memory t) {
        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](2);
        refs[0] = IBusinessKernel.OfferRef(offerGoods,   100, supplierA);
        refs[1] = IBusinessKernel.OfferRef(offerFreight, 1,   supplierB);

        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](0);

        t = IBusinessKernel.PlanTerms({
            kind:        IBusinessKernel.WorkflowKind.CustomerOrder,
            buyers:      buyers,
            saleParty:   IBusinessKernel.SalePartyTerms({
                merchantOwner:     merchant,
                merchantAccountId: accMerchant,
                merchantCash:      u(1000),
                creditDraw:        u(1500),
                creditLimit:       u(2000),
                customerAddress:   customer,
                requiredEscrow:    u(4000),
                saleValue:         u(10000)
            }),
            lenderPoolId: lenderPool,
            offerRefs:   refs,
            expiry:      exp,
            commercialRef: bytes32("co-v1")
        });
    }

    // ── Scenario A: seed group fixture ───────────────────────────────────

    function seedGroupFixture() internal {
        fundAccount(buyerA, accA, u(300));
        fundAccount(buyerB, accB, u(250));
        fundAccount(buyerC, accC, u(200));
        fundPool(u(500));

        vm.prank(lender);
        kernel.setBorrowerLimit(lenderPool, accA, u(200));
        vm.prank(lender);
        kernel.setBorrowerLimit(lenderPool, accB, u(200));
        vm.prank(lender);
        kernel.setBorrowerLimit(lenderPool, accC, u(200));

        vm.prank(buyerA);
        kernel.setProtectedFloor(accA, u(100));
        vm.prank(buyerB);
        kernel.setProtectedFloor(accB, u(100));
        vm.prank(buyerC);
        kernel.setProtectedFloor(accC, u(100));
    }

    // ── Scenario B: seed sale fixture ────────────────────────────────────

    function seedSaleFixture() internal {
        fundAccount(merchant, accMerchant, u(3000));
        fundPool(u(2000));

        vm.prank(lender);
        kernel.setBorrowerLimit(lenderPool, accMerchant, u(2000));

        vm.prank(merchant);
        kernel.setProtectedFloor(accMerchant, u(2000));
    }

    // ── Plan-specific approval helpers ───────────────────────────────────

    /// @dev Default approval expiry for helpers: plan expiry = block.timestamp + 7 days.
    ///      Tests that need a shorter approval expiry must call the kernel directly.
    function _defaultApprovalExpiry() internal view returns (uint256) {
        return block.timestamp + 7 days;
    }

    /// @dev Approve lender for all CP buyers in a plan (approval expiry == plan expiry).
    function approveLenderCP(uint256 planId, uint256[3] memory draws) internal {
        uint256 aExp = _defaultApprovalExpiry();
        for (uint256 i = 0; i < 3; i++) {
            if (draws[i] > 0) {
                vm.prank(lender);
                kernel.approveLenderPlan(planId, i, draws[i], aExp);
            }
        }
    }

    /// @dev Approve lender for CO merchant (participantIndex = 0).
    function approveLenderCO(uint256 planId, uint256 draw) internal {
        if (draw > 0) {
            vm.prank(lender);
            kernel.approveLenderPlan(planId, 0, draw, _defaultApprovalExpiry());
        }
    }

    /// @dev Approve supplier for a single CP offer ref (index 0).
    function approveSupplierCP(uint256 planId, uint256 qty) internal {
        vm.prank(supplierA);
        kernel.approveSupplierPlan(planId, 0, qty, _defaultApprovalExpiry());
    }

    /// @dev Approve both suppliers for a CO plan (goods = index 0, freight = index 1).
    function approveSuppliersCO(uint256 planId, uint256 goodsQty, uint256 freightQty) internal {
        uint256 aExp = _defaultApprovalExpiry();
        vm.prank(supplierA);
        kernel.approveSupplierPlan(planId, 0, goodsQty, aExp);
        vm.prank(supplierB);
        kernel.approveSupplierPlan(planId, 1, freightQty, aExp);
    }

    // ── Canonical CP plan (all 3 buyers, 100 units) ──────────────────────

    function draftFullCPPlan() internal returns (uint256 planId) {
        IBusinessKernel.PlanTerms memory t = _cpTerms(
            [uint256(40), 35, 25],
            [u(200), u(150), u(100)],
            [u(160), u(165), u(125)],
            [u(200), u(200), u(200)],
            100,
            block.timestamp + 7 days
        );
        (planId,) = kernel.draftPlan(t);
        // No approvals issued here — tests that need join must approve first.
        // Use draftAndApproveFullCPPlan() when you need a fully approved plan.
    }

    function draftAndApproveFullCPPlan() internal returns (uint256 planId) {
        planId = draftFullCPPlan();
        approveLenderCP(planId, [u(160), u(165), u(125)]);
        approveSupplierCP(planId, 100);
    }

    function draftFullCOPlan() internal returns (uint256 planId) {
        IBusinessKernel.PlanTerms memory t = _coTerms(block.timestamp + 7 days);
        (planId,) = kernel.draftPlan(t);
    }

    function draftAndApproveFullCOPlan() internal returns (uint256 planId) {
        planId = draftFullCOPlan();
        approveLenderCO(planId, u(1500));
        approveSuppliersCO(planId, 100, 1);
    }

    // ── Approve helpers using a specific kernel instance ─────────────────

    /// @dev Lender approves all buyers in a CP plan on a given kernel (approval expiry = plan expiry).
    function _approveAllCP(
        IBusinessKernel k, address lend, uint256 poolId,
        uint256 planId_, uint256 cnt,
        uint256[] memory draws
    ) internal {
        uint256 aExp = block.timestamp + 7 days;
        for (uint256 i = 0; i < cnt; i++) {
            if (draws[i] > 0) {
                vm.prank(lend);
                k.approveLenderPlan(planId_, i, draws[i], aExp);
            }
        }
    }

    /// @dev Supplier approves offer ref index on a given kernel (approval expiry = plan expiry).
    function _approveSupplierPlan(
        IBusinessKernel k, address sup,
        uint256 planId_, uint256 refIdx, uint256 qty
    ) internal {
        vm.prank(sup);
        k.approveSupplierPlan(planId_, refIdx, qty, block.timestamp + 7 days);
    }

    // ── Fund customer escrow helper ──────────────────────────────────────

    function fundEscrow(uint256 planId) internal {
        // Mint u(10000) total: u(4000) goes into escrow, u(6000) stays external.
        // DC-17 asserts customer external = u(6000); DC-32 asserts customer gets u(10000) after refund.
        tok.mint(customer, u(10000));
        vm.prank(customer);
        tok.approve(address(kernel), u(4000));
        vm.prank(customer);
        kernel.fundCustomerEscrow(planId);
    }
}
