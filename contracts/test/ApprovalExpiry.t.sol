// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// ApprovalExpiry.t.sol — focused tests for independent lender and supplier
// approval deadlines.
//
// ID   Scenario
// ─────────────────────────────────────────────────────────────────────────────
// AE-01  Lender approval stores and returns draw + expiry
// AE-02  Supplier approval stores and returns quantity + expiry
// AE-03  Approval expiry in past (== block.timestamp) reverts BK_ApprovalExpiryInPast
// AE-04  Approval expiry strictly in future, equal to plan expiry: accepted
// AE-05  Approval expiry exceeds plan expiry: reverts BK_ApprovalExpiryExceedsPlan
// AE-06  Supplier approval expiry exceeds offer expiry: reverts BK_ApprovalExpiryExceedsOffer
// AE-07  joinBuyer rejects when lender approval is expired; state unchanged
// AE-08  joinBuyer rejects when supplier approval is expired; state unchanged
// AE-09  joinMerchant rejects when lender approval is expired
// AE-10  joinMerchant rejects when supplier approval is expired
// AE-11  planReadiness returns (false, "Lender approval expired") when lender approval expired
// AE-12  planReadiness returns (false, "Supplier approval expired") when supplier approval expired
// AE-13  commitPlan reverts BK_LenderApprovalExpired when lender approval expired after join
// AE-14  commitPlan reverts BK_SupplierApprovalExpired when supplier approval expired after join
// AE-15  releaseExpiredPlan succeeds when only lender approval is expired (plan/offer still valid)
// AE-16  releaseExpiredPlan succeeds when only supplier approval is expired
// AE-17  Reapproval with shorter expiry replaces prior active approval; join succeeds with new expiry
// AE-18  Reapproval after revocation with new expiry: join succeeds; fresh generation
// AE-19  CP: all three buyer approvals expire independently; each blocks its own join
// AE-20  CO: full canonical flow with approval expiry equal to plan expiry

import "forge-std/Test.sol";
import { IBusinessKernel } from "../IBusinessKernel.sol";
import { BusinessKernel } from "../BusinessKernel.sol";

import {
    BK_ApprovalCutoffExpired,
    BK_ApprovalOverwriteWhileJoined,
    BK_ApprovalExpiryInPast,
    BK_ApprovalExpiryExceedsPlan,
    BK_ApprovalExpiryExceedsOffer,
    BK_LenderApprovalExpired,
    BK_SupplierApprovalExpired,
    BK_NoLenderPlanApproval,
    BK_NoSupplierPlanApproval,
    BK_NoGoodsSupplierApproval,
    BK_NoFreightSupplierApproval,
    BK_AlreadyJoined,
    BK_NotYetExpired,
    BK_PlanNotOpen
} from "../IBusinessKernel.sol";

// Minimal ERC-20 stub used only in this file
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address sp, uint256 amt) external { allowance[msg.sender][sp] = amt; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allowance");
        require(balanceOf[f] >= a, "balance");
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "balance");
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract ApprovalExpiryTest is Test {

    // ── Helpers ─────────────────────────────────────────────────────────────

    function u(uint256 x) internal pure returns (uint256) { return x * 1e6; }

    // ── State ────────────────────────────────────────────────────────────────

    MockToken  tok;
    BusinessKernel kernel;

    address lender    = makeAddr("lender");
    address supplierA = makeAddr("supplierA");
    address supplierB = makeAddr("supplierB");

    address buyerA    = makeAddr("buyerA");
    address buyerB    = makeAddr("buyerB");
    address buyerC    = makeAddr("buyerC");

    address merchant  = makeAddr("merchant");
    address customer  = makeAddr("customer");

    uint256 lenderPool;
    uint256 accA;
    uint256 accB;
    uint256 accC;
    uint256 accMerchant;

    uint256 cpOffer;   // CP offer (cap=100, minFill=100)
    uint256 goodsOffer;
    uint256 freightOffer;

    uint256 PLAN_EXPIRY;
    uint256 OFFER_EXPIRY;  // same as PLAN_EXPIRY for most tests

    // ── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        tok = new MockToken();
        // This test contract is the lender; passed to constructor to initialize the pool.
        kernel = new BusinessKernel(address(tok), address(this));
        lenderPool = kernel.POOL_ID();

        // Accounts
        vm.prank(buyerA);    accA = kernel.openAccount();
        vm.prank(buyerB);    accB = kernel.openAccount();
        vm.prank(buyerC);    accC = kernel.openAccount();
        vm.prank(merchant);  accMerchant = kernel.openAccount();

        // Fund accounts
        tok.mint(buyerA,   u(300)); vm.prank(buyerA);   tok.approve(address(kernel), u(300));
        tok.mint(buyerB,   u(250)); vm.prank(buyerB);   tok.approve(address(kernel), u(250));
        tok.mint(buyerC,   u(200)); vm.prank(buyerC);   tok.approve(address(kernel), u(200));
        tok.mint(merchant, u(3000)); vm.prank(merchant); tok.approve(address(kernel), u(3000));

        vm.prank(buyerA);   kernel.depositCash(accA, u(300));
        vm.prank(buyerA);   kernel.setProtectedFloor(accA, u(100));
        vm.prank(buyerB);   kernel.depositCash(accB, u(250));
        vm.prank(buyerB);   kernel.setProtectedFloor(accB, u(100));
        vm.prank(buyerC);   kernel.depositCash(accC, u(200));
        vm.prank(buyerC);   kernel.setProtectedFloor(accC, u(100));
        vm.prank(merchant); kernel.depositCash(accMerchant, u(3000));
        vm.prank(merchant); kernel.setProtectedFloor(accMerchant, u(2000));

        // Deposit lender funds (this contract owns the pool).
        tok.mint(address(this), u(2000));
        tok.approve(address(kernel), u(2000));
        kernel.depositPool(lenderPool, u(2000));
        kernel.setBorrowerLimit(lenderPool, accA, u(200));
        kernel.setBorrowerLimit(lenderPool, accB, u(200));
        kernel.setBorrowerLimit(lenderPool, accC, u(200));
        kernel.setBorrowerLimit(lenderPool, accMerchant, u(2000));

        OFFER_EXPIRY = block.timestamp + 7 days;
        PLAN_EXPIRY  = block.timestamp + 7 days;

        // CP offer
        vm.prank(supplierA);
        cpOffer = kernel.createOffer(supplierA, u(9), 100, 100, OFFER_EXPIRY);

        // CO offers
        vm.prank(supplierA);
        goodsOffer = kernel.createOffer(supplierA, u(60), 100, 100, OFFER_EXPIRY);
        vm.prank(supplierB);
        freightOffer = kernel.createOffer(supplierB, u(500), 1, 1, OFFER_EXPIRY);
    }

    // ── Helpers — plan drafting ──────────────────────────────────────────────

    function _draftCP() internal returns (uint256 planId) {
        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](3);
        buyers[0] = IBusinessKernel.BuyerTerms(buyerA, accA, 40, u(200), u(160), u(200));
        buyers[1] = IBusinessKernel.BuyerTerms(buyerB, accB, 35, u(150), u(165), u(200));
        buyers[2] = IBusinessKernel.BuyerTerms(buyerC, accC, 25, u(100), u(125), u(200));

        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(cpOffer, 100, supplierA);

        (planId,) = kernel.draftPlan(IBusinessKernel.PlanTerms({
            kind:          IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers:        buyers,
            saleParty:     IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId:  lenderPool,
            offerRefs:     refs,
            expiry:        PLAN_EXPIRY,
            commercialRef: bytes32("ae-cp")
        }));
    }

    function _draftCO() internal returns (uint256 planId) {
        IBusinessKernel.BuyerTerms[] memory empty = new IBusinessKernel.BuyerTerms[](0);
        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](2);
        refs[0] = IBusinessKernel.OfferRef(goodsOffer,   100, supplierA);
        refs[1] = IBusinessKernel.OfferRef(freightOffer, 1,   supplierB);

        (planId,) = kernel.draftPlan(IBusinessKernel.PlanTerms({
            kind:         IBusinessKernel.WorkflowKind.CustomerOrder,
            buyers:       empty,
            saleParty:    IBusinessKernel.SalePartyTerms(
                              merchant, accMerchant, u(1000), u(1500), u(2000),
                              customer, u(4000), u(10000)
                          ),
            lenderPoolId: lenderPool,
            offerRefs:    refs,
            expiry:       PLAN_EXPIRY,
            commercialRef: bytes32("ae-co")
        }));
    }

    function _approveCP(uint256 planId, uint256 aExp) internal {
        kernel.approveLenderPlan(planId, 0, u(160), aExp);
        kernel.approveLenderPlan(planId, 1, u(165), aExp);
        kernel.approveLenderPlan(planId, 2, u(125), aExp);
        vm.prank(supplierA); kernel.approveSupplierPlan(planId, 0, 100, aExp);
    }

    function _approveCO(uint256 planId, uint256 aExp) internal {
        kernel.approveLenderPlan(planId, 0, u(1500), aExp);
        vm.prank(supplierA); kernel.approveSupplierPlan(planId, 0, 100, aExp);
        vm.prank(supplierB); kernel.approveSupplierPlan(planId, 1, 1, aExp);
    }

    function _fundEscrow(uint256 planId) internal {
        tok.mint(customer, u(4000));
        vm.prank(customer); tok.approve(address(kernel), u(4000));
        vm.prank(customer); kernel.fundCustomerEscrow(planId);
    }

    // ── AE-01: Lender approval stores draw + expiry ──────────────────────────

    function test_AE01_LenderApprovalStoredWithExpiry() public {
        uint256 pid = _draftCP();
        uint256 aExp = PLAN_EXPIRY - 1 hours;  // shorter than plan
        kernel.approveLenderPlan(pid, 0, u(160), aExp);

        (uint256 draw, uint256 exp) = kernel.getLenderPlanApproval(pid, 0);
        assertEq(draw, u(160), "AE-01: draw stored");
        assertEq(exp, aExp,    "AE-01: expiry stored");
    }

    // ── AE-02: Supplier approval stores quantity + expiry ────────────────────

    function test_AE02_SupplierApprovalStoredWithExpiry() public {
        uint256 pid = _draftCP();
        uint256 aExp = PLAN_EXPIRY - 2 hours;
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, aExp);

        (uint256 qty, uint256 exp) = kernel.getSupplierPlanApproval(pid, 0);
        assertEq(qty, 100,   "AE-02: qty stored");
        assertEq(exp, aExp,  "AE-02: expiry stored");
    }

    // ── AE-03: Approval expiry == block.timestamp reverts BK_ApprovalExpiryInPast

    function test_AE03_ApprovalExpiryAtTimestampReverts() public {
        uint256 pid = _draftCP();
        // approvalExpiry == block.timestamp: the check is !(block.timestamp < approvalExpiry)
        vm.expectRevert(BK_ApprovalExpiryInPast.selector);
        kernel.approveLenderPlan(pid, 0, u(160), block.timestamp);

        vm.expectRevert(BK_ApprovalExpiryInPast.selector);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, block.timestamp);
    }

    // ── AE-04: approvalExpiry == plan expiry is valid ────────────────────────

    function test_AE04_ApprovalExpiryEqualToPlanExpiry() public {
        uint256 pid = _draftCP();
        // Should not revert
        kernel.approveLenderPlan(pid, 0, u(160), PLAN_EXPIRY);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, PLAN_EXPIRY);
    }

    // ── AE-05: approvalExpiry > plan expiry reverts BK_ApprovalExpiryExceedsPlan

    function test_AE05_ApprovalExpiryExceedsPlanReverts() public {
        uint256 pid = _draftCP();
        vm.expectRevert(BK_ApprovalExpiryExceedsPlan.selector);
        kernel.approveLenderPlan(pid, 0, u(160), PLAN_EXPIRY + 1);

        vm.expectRevert(BK_ApprovalExpiryExceedsPlan.selector);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, PLAN_EXPIRY + 1);
    }

    // ── AE-06: Supplier approvalExpiry > offer expiry reverts BK_ApprovalExpiryExceedsOffer

    function test_AE06_SupplierApprovalExpiryExceedsOfferReverts() public {
        // Create a plan with a later plan expiry but offer expiry is shorter
        // cpOffer has OFFER_EXPIRY = block.timestamp + 7 days (= PLAN_EXPIRY)
        // Create a new offer with a shorter expiry than the plan
        uint256 shortOfferExp = block.timestamp + 3 days;
        vm.prank(supplierA);
        uint256 shortOffer = kernel.createOffer(supplierA, u(9), 100, 100, shortOfferExp);

        // Plan expiry = 7 days (longer than offer)
        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](1);
        buyers[0] = IBusinessKernel.BuyerTerms(buyerA, accA, 40, u(200), u(160), u(200));
        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(shortOffer, 40, supplierA);
        (uint256 pid,) = kernel.draftPlan(IBusinessKernel.PlanTerms({
            kind:          IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers:        buyers,
            saleParty:     IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId:  lenderPool,
            offerRefs:     refs,
            expiry:        PLAN_EXPIRY,          // 7 days
            commercialRef: bytes32("ae06")
        }));

        // Approval expiry set to 5 days — > offer expiry (3 days) but <= plan expiry (7 days)
        uint256 aExp = block.timestamp + 5 days;
        vm.expectRevert(BK_ApprovalExpiryExceedsOffer.selector);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 40, aExp);

        // At offer expiry exactly: also reverts
        vm.expectRevert(BK_ApprovalExpiryExceedsOffer.selector);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 40, shortOfferExp + 1);

        // At offer expiry - 1: succeeds
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 40, shortOfferExp);
    }

    // ── AE-07: joinBuyer rejects when lender approval is expired ─────────────

    function test_AE07_JoinBuyerBlockedByExpiredLenderApproval() public {
        uint256 pid = _draftCP();
        // Approve with very short expiry
        uint256 aExp = block.timestamp + 1;
        kernel.approveLenderPlan(pid, 0, u(160), aExp);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, PLAN_EXPIRY);

        // Advance time past approval expiry (but plan and offer still valid)
        vm.warp(block.timestamp + 2);

        // State before
        (,, uint256 poolReservedBefore) = kernel.getPool(lenderPool);
        (,,, uint256 heldBefore,,) = kernel.getAccount(accA);

        vm.prank(buyerA);
        vm.expectRevert(BK_ApprovalCutoffExpired.selector);
        kernel.joinBuyer(pid, 0);

        // State unchanged
        (,, uint256 poolReservedAfter) = kernel.getPool(lenderPool);
        (,,, uint256 heldAfter,,) = kernel.getAccount(accA);
        assertEq(poolReservedAfter, poolReservedBefore, "AE-07: pool reserved unchanged");
        assertEq(heldAfter, heldBefore, "AE-07: buyer held unchanged");
    }

    // ── AE-08: joinBuyer rejects when supplier approval is expired ────────────

    function test_AE08_JoinBuyerBlockedByExpiredSupplierApproval() public {
        uint256 pid = _draftCP();
        kernel.approveLenderPlan(pid, 0, u(160), PLAN_EXPIRY);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, block.timestamp + 1);

        vm.warp(block.timestamp + 2);

        (,, uint256 poolBefore) = kernel.getPool(lenderPool);
        (,,, uint256 heldBefore,,) = kernel.getAccount(accA);

        vm.prank(buyerA);
        vm.expectRevert(BK_ApprovalCutoffExpired.selector);
        kernel.joinBuyer(pid, 0);

        (,, uint256 poolAfter) = kernel.getPool(lenderPool);
        (,,, uint256 heldAfter,,) = kernel.getAccount(accA);
        assertEq(poolAfter, poolBefore, "AE-08: pool reserved unchanged");
        assertEq(heldAfter, heldBefore, "AE-08: buyer held unchanged");
    }

    // ── AE-09: joinMerchant rejects when lender approval is expired ──────────

    function test_AE09_JoinMerchantBlockedByExpiredLenderApproval() public {
        uint256 pid = _draftCO();
        kernel.approveLenderPlan(pid, 0, u(1500), block.timestamp + 1);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, PLAN_EXPIRY);
        vm.prank(supplierB); kernel.approveSupplierPlan(pid, 1, 1,   PLAN_EXPIRY);
        _fundEscrow(pid);

        vm.warp(block.timestamp + 2);

        (,,, uint256 heldBefore,,) = kernel.getAccount(accMerchant);
        vm.prank(merchant);
        vm.expectRevert(BK_ApprovalCutoffExpired.selector);
        kernel.joinMerchant(pid);
        (,,, uint256 heldAfter,,) = kernel.getAccount(accMerchant);
        assertEq(heldAfter, heldBefore, "AE-09: merchant held unchanged");
    }

    // ── AE-10: joinMerchant rejects when supplier approval is expired ─────────

    function test_AE10_JoinMerchantBlockedByExpiredSupplierApproval() public {
        uint256 pid = _draftCO();
        kernel.approveLenderPlan(pid, 0, u(1500), PLAN_EXPIRY);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, block.timestamp + 1);
        vm.prank(supplierB); kernel.approveSupplierPlan(pid, 1, 1,   PLAN_EXPIRY);
        _fundEscrow(pid);

        vm.warp(block.timestamp + 2);

        vm.prank(merchant);
        vm.expectRevert(BK_ApprovalCutoffExpired.selector);
        kernel.joinMerchant(pid);
    }

    // ── AE-11: planReadiness returns (false, "Lender approval expired") ──────

    function test_AE11_ReadinessBlocedByLenderApprovalExpiry() public {
        uint256 pid = _draftCP();
        // Lender approval for buyer 0 only — rest at full expiry
        uint256 shortExp = block.timestamp + 1;
        kernel.approveLenderPlan(pid, 0, u(160), shortExp);
        kernel.approveLenderPlan(pid, 1, u(165), PLAN_EXPIRY);
        kernel.approveLenderPlan(pid, 2, u(125), PLAN_EXPIRY);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, PLAN_EXPIRY);

        // Join all buyers before expiry
        vm.prank(buyerA); kernel.joinBuyer(pid, 0);
        vm.prank(buyerB); kernel.joinBuyer(pid, 1);
        vm.prank(buyerC); kernel.joinBuyer(pid, 2);

        // Move time past buyer 0's approval expiry
        vm.warp(block.timestamp + 2);

        (bool ready, string memory reason) = kernel.planReadiness(pid);
        assertFalse(ready, "AE-11: not ready when lender approval expired");
        assertEq(reason, "Approval expired", "AE-11: reason string");
    }

    // ── AE-12: planReadiness returns (false, "Supplier approval expired") ────

    function test_AE12_ReadinessBlockedBySupplierApprovalExpiry() public {
        uint256 pid = _draftCP();
        uint256 shortExp = block.timestamp + 1;
        kernel.approveLenderPlan(pid, 0, u(160), PLAN_EXPIRY);
        kernel.approveLenderPlan(pid, 1, u(165), PLAN_EXPIRY);
        kernel.approveLenderPlan(pid, 2, u(125), PLAN_EXPIRY);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, shortExp);

        vm.prank(buyerA); kernel.joinBuyer(pid, 0);
        vm.prank(buyerB); kernel.joinBuyer(pid, 1);
        vm.prank(buyerC); kernel.joinBuyer(pid, 2);

        vm.warp(block.timestamp + 2);

        (bool ready, string memory reason) = kernel.planReadiness(pid);
        assertFalse(ready, "AE-12: not ready when supplier approval expired");
        assertEq(reason, "Approval expired", "AE-12: reason string");
    }

    // ── AE-13: commitPlan reverts BK_LenderApprovalExpired ───────────────────

    function test_AE13_CommitBlockedByExpiredLenderApproval() public {
        // All buyers join, then lender approval expires before commit
        uint256 shortExp = block.timestamp + 1;
        uint256 pid = _draftCP();
        kernel.approveLenderPlan(pid, 0, u(160), shortExp);
        kernel.approveLenderPlan(pid, 1, u(165), PLAN_EXPIRY);
        kernel.approveLenderPlan(pid, 2, u(125), PLAN_EXPIRY);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, PLAN_EXPIRY);

        vm.prank(buyerA); kernel.joinBuyer(pid, 0);
        vm.prank(buyerB); kernel.joinBuyer(pid, 1);
        vm.prank(buyerC); kernel.joinBuyer(pid, 2);

        // Advance past approval expiry, still before plan expiry
        vm.warp(block.timestamp + 2);

        // Supply tokens for supplier payout
        tok.mint(supplierA, 0); // ensure address is known but no mint needed

        vm.expectRevert(BK_ApprovalCutoffExpired.selector);
        kernel.commitPlan(pid);

        // State intact: plan still open
        (, IBusinessKernel.PlanStatus status,,, ) = kernel.getPlan(pid);
        assertEq(uint8(status), uint8(IBusinessKernel.PlanStatus.Open), "AE-13: plan still open");
    }

    // ── AE-14: commitPlan reverts BK_SupplierApprovalExpired ─────────────────

    function test_AE14_CommitBlockedByExpiredSupplierApproval() public {
        uint256 shortExp = block.timestamp + 1;
        uint256 pid = _draftCP();
        _approveCP(pid, PLAN_EXPIRY);

        // Override supplier approval with short expiry
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, shortExp);

        vm.prank(buyerA); kernel.joinBuyer(pid, 0);
        vm.prank(buyerB); kernel.joinBuyer(pid, 1);
        vm.prank(buyerC); kernel.joinBuyer(pid, 2);

        vm.warp(block.timestamp + 2);

        vm.expectRevert(BK_ApprovalCutoffExpired.selector);
        kernel.commitPlan(pid);

        (, IBusinessKernel.PlanStatus status,,, ) = kernel.getPlan(pid);
        assertEq(uint8(status), uint8(IBusinessKernel.PlanStatus.Open), "AE-14: plan still open");
    }

    // ── AE-15: releaseExpiredPlan when only lender approval expired ───────────

    function test_AE15_ReleaseByExpiredLenderApproval() public {
        uint256 shortExp = block.timestamp + 1;
        uint256 pid = _draftCP();
        kernel.approveLenderPlan(pid, 0, u(160), shortExp);
        kernel.approveLenderPlan(pid, 1, u(165), PLAN_EXPIRY);
        kernel.approveLenderPlan(pid, 2, u(125), PLAN_EXPIRY);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, PLAN_EXPIRY);

        vm.prank(buyerA); kernel.joinBuyer(pid, 0);
        vm.prank(buyerB); kernel.joinBuyer(pid, 1);
        vm.prank(buyerC); kernel.joinBuyer(pid, 2);

        // Advance past lender approval expiry but NOT past plan or offer expiry
        vm.warp(block.timestamp + 2);

        // Permissionless release must succeed
        (,,, uint256 heldBefore,,) = kernel.getAccount(accA);
        assertGt(heldBefore, 0, "AE-15: buyer A had a hold");

        kernel.releaseExpiredPlan(pid);

        (, IBusinessKernel.PlanStatus status,,, ) = kernel.getPlan(pid);
        assertEq(uint8(status), uint8(IBusinessKernel.PlanStatus.Expired), "AE-15: plan expired");

        (,,, uint256 heldAfter,,) = kernel.getAccount(accA);
        assertEq(heldAfter, 0, "AE-15: buyer A hold released");
    }

    // ── AE-16: releaseExpiredPlan when only supplier approval expired ─────────

    function test_AE16_ReleaseByExpiredSupplierApproval() public {
        uint256 shortExp = block.timestamp + 1;
        uint256 pid = _draftCP();
        _approveCP(pid, PLAN_EXPIRY);
        // Override supplier approval with short expiry
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, shortExp);

        vm.prank(buyerA); kernel.joinBuyer(pid, 0);
        vm.prank(buyerB); kernel.joinBuyer(pid, 1);
        vm.prank(buyerC); kernel.joinBuyer(pid, 2);

        vm.warp(block.timestamp + 2);

        (,,, uint256 heldBefore,,) = kernel.getAccount(accB);
        assertGt(heldBefore, 0, "AE-16: buyer B had a hold");

        kernel.releaseExpiredPlan(pid);

        (, IBusinessKernel.PlanStatus status,,, ) = kernel.getPlan(pid);
        assertEq(uint8(status), uint8(IBusinessKernel.PlanStatus.Expired), "AE-16: plan expired");

        (,,, uint256 heldAfter,,) = kernel.getAccount(accB);
        assertEq(heldAfter, 0, "AE-16: buyer B hold released");
    }

    // ── AE-17: Reapproval with shorter expiry replaces prior active approval ──

    function test_AE17_ReapprovalReplacesExpiry() public {
        uint256 pid = _draftCP();
        // First approval at full plan expiry
        kernel.approveLenderPlan(pid, 0, u(160), PLAN_EXPIRY);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, PLAN_EXPIRY);

        // Re-approve with a shorter expiry (still in future)
        uint256 newExp = block.timestamp + 2 days;
        kernel.approveLenderPlan(pid, 0, u(160), newExp);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, newExp);

        (uint256 draw, uint256 aExp1) = kernel.getLenderPlanApproval(pid, 0);
        (uint256 qty,  uint256 aExp2) = kernel.getSupplierPlanApproval(pid, 0);
        assertEq(aExp1, newExp, "AE-17: lender approval expiry updated");
        assertEq(aExp2, newExp, "AE-17: supplier approval expiry updated");
        assertEq(draw, u(160), "AE-17: draw preserved");
        assertEq(qty, 100, "AE-17: qty preserved");

        // Approve remaining buyers then join all
        kernel.approveLenderPlan(pid, 1, u(165), PLAN_EXPIRY);
        kernel.approveLenderPlan(pid, 2, u(125), PLAN_EXPIRY);
        vm.prank(buyerA); kernel.joinBuyer(pid, 0);
        vm.prank(buyerB); kernel.joinBuyer(pid, 1);
        vm.prank(buyerC); kernel.joinBuyer(pid, 2);

        (bool joined,,, ) = kernel.getBuyerParticipation(pid, 0);
        assertTrue(joined, "AE-17: buyer A joined after reapproval");
    }

    // ── AE-18: Reapproval after revocation with new expiry ───────────────────

    function test_AE18_ReapprovalAfterRevocation() public {
        uint256 pid = _draftCP();
        _approveCP(pid, PLAN_EXPIRY);

        vm.prank(buyerA); kernel.joinBuyer(pid, 0);

        // Revoke lender approval for buyer 0 — releases their hold
        kernel.revokeLenderApproval(pid, 0);
        (bool joinedAfterRevoke,,,) = kernel.getBuyerParticipation(pid, 0);
        assertFalse(joinedAfterRevoke, "AE-18: buyer A not joined after revoke");

        // Confirm approval was cleared
        (uint256 draw,) = kernel.getLenderPlanApproval(pid, 0);
        assertEq(draw, 0, "AE-18: approval cleared");

        // Re-approve with fresh expiry
        kernel.approveLenderPlan(pid, 0, u(160), PLAN_EXPIRY);

        // Join again
        vm.prank(buyerA); kernel.joinBuyer(pid, 0);

        (bool joined, uint256 gen,,) = kernel.getBuyerParticipation(pid, 0);
        assertTrue(joined, "AE-18: buyer A rejoined");
        assertEq(gen, 2, "AE-18: fresh generation");
    }

    // ── AE-19: Each buyer's approval expires independently ───────────────────

    function test_AE19_PerBuyerApprovalExpiryIsIndependent() public {
        uint256 pid = _draftCP();

        // Different expiries for each buyer
        uint256 expA = block.timestamp + 1;    // very short
        uint256 expB = block.timestamp + 3;
        uint256 expC = PLAN_EXPIRY;

        kernel.approveLenderPlan(pid, 0, u(160), expA);
        kernel.approveLenderPlan(pid, 1, u(165), expB);
        kernel.approveLenderPlan(pid, 2, u(125), expC);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 100, PLAN_EXPIRY);

        // Advance past expA but before expB
        vm.warp(block.timestamp + 2);

        // Buyer A's approval expired
        vm.prank(buyerA);
        vm.expectRevert(BK_ApprovalCutoffExpired.selector);
        kernel.joinBuyer(pid, 0);

        // The earliest required approval stops every new participation.
        vm.prank(buyerB); vm.expectRevert(BK_ApprovalCutoffExpired.selector); kernel.joinBuyer(pid, 1);
        vm.prank(buyerC); vm.expectRevert(BK_ApprovalCutoffExpired.selector); kernel.joinBuyer(pid, 2);

        // Advance past expB
        vm.warp(block.timestamp + 4);

        // Plan can be released now (both A and B approval expired)
        // B is joined, A is not — still release should work
        kernel.releaseExpiredPlan(pid);

        (, IBusinessKernel.PlanStatus status,,, ) = kernel.getPlan(pid);
        assertEq(uint8(status), uint8(IBusinessKernel.PlanStatus.Expired), "AE-19: plan expired");
    }

    // ── AE-20: CO canonical flow with approval expiry == plan expiry ─────────

    function test_AE20_COCanonicalFlowWithApprovalExpiry() public {
        uint256 pid = _draftCO();
        _approveCO(pid, PLAN_EXPIRY);
        _fundEscrow(pid);
        vm.prank(merchant); kernel.joinMerchant(pid);

        (bool ready,) = kernel.planReadiness(pid);
        assertTrue(ready, "AE-20: plan ready");

        // Mint token balance for supplier payouts
        tok.mint(address(kernel), 0); // not needed, kernel holds escrowed tokens

        // Commit
        kernel.commitPlan(pid);

        (, IBusinessKernel.PlanStatus status,,, ) = kernel.getPlan(pid);
        assertEq(uint8(status), uint8(IBusinessKernel.PlanStatus.Committed), "AE-20: committed");

        (, uint256 merchantCash,,,,) = kernel.getAccount(accMerchant);
        assertEq(merchantCash, u(2000), "AE-20: merchant cash post-commit");
    }

    // Independent regressions for the final, monotonically narrowing execution window.
    function _joinCP(uint256 pid) internal {
        vm.prank(buyerA); kernel.joinBuyer(pid, 0);
        vm.prank(buyerB); kernel.joinBuyer(pid, 1);
        vm.prank(buyerC); kernel.joinBuyer(pid, 2);
    }
    function _accountState(uint256 id) internal view returns (bytes32) {
        (address owner,uint256 cash,uint256 floor,uint256 held,uint256 active,uint256 debt) = kernel.getAccount(id);
        return keccak256(abi.encode(owner,cash,floor,held,active,debt));
    }
    function _moneyState(uint256 pid) internal view returns (bytes32 s) {
        s=keccak256(abi.encode(_accountState(accA),_accountState(accB),_accountState(accC),_accountState(accMerchant),kernel.totalCustody(),kernel.accountedCustody()));
        (,uint256 cash,uint256 reserved)=kernel.getPool(lenderPool);
        s=keccak256(abi.encode(s,cash,reserved));
        (,uint256 amount,bool refundable,bool withdrawn)=kernel.getEscrow(pid);
        s=keccak256(abi.encode(s,amount,refundable,withdrawn,tok.balanceOf(customer),tok.balanceOf(supplierA),tok.balanceOf(supplierB)));
        uint256[3] memory offers=[cpOffer,goodsOffer,freightOffer];
        for(uint256 i;i<3;i++) {
            (,,,,,uint256 held,uint256 used,,)=kernel.getOffer(offers[i]);
            s=keccak256(abi.encode(s,held,used));
        }
    }
    function _assertCutoffBlocksCommit(uint256 pid) internal {
        bytes32 beforeState=_moneyState(pid);
        (bool ready,string memory reason)=kernel.planReadiness(pid);
        assertFalse(ready); assertEq(reason,"Approval expired");
        vm.expectRevert(BK_ApprovalCutoffExpired.selector); kernel.commitPlan(pid);
        assertEq(_moneyState(pid),beforeState,"failed commit changed financial state");
    }
    function test_AE21_UnapprovedDraftCannotBeExpiredByStranger() public {
        uint256 pid=_draftCP(); bytes32 beforeState=_moneyState(pid);
        vm.prank(address(0xBEEF)); vm.expectRevert(BK_NotYetExpired.selector); kernel.releaseExpiredPlan(pid);
        assertEq(_moneyState(pid),beforeState);
    }
    function test_AE22_EqualityAndIdempotentCPCleanup() public {
        uint256 pid=_draftCP(); uint256 cutoff=block.timestamp+60;
        _approveCP(pid,cutoff); _joinCP(pid);
        bytes32 beforeTime=_moneyState(pid); vm.warp(cutoff);
        assertEq(_moneyState(pid),beforeTime,"time passage moved funds");
        _assertCutoffBlocksCommit(pid);
        vm.prank(address(0xBEEF)); kernel.releaseExpiredPlan(pid);
        (,,,uint256 held,uint256 active,uint256 debt)=kernel.getAccount(accA);
        assertEq(held,0); assertEq(active,0); assertEq(debt,0);
        (,uint256 cash,uint256 reserved)=kernel.getPool(lenderPool);
        assertEq(cash,u(2000)); assertEq(reserved,0);
        bytes32 released=_moneyState(pid);
        vm.expectRevert(BK_PlanNotOpen.selector); kernel.releaseExpiredPlan(pid);
        assertEq(_moneyState(pid),released,"cleanup retry changed funds");
    }
    function _checkCOCleanup(bool supplierExpiry) internal {
        uint256 pid=_draftCO(); uint256 cutoff=block.timestamp+60;
        _approveCO(pid,PLAN_EXPIRY);
        if(supplierExpiry) { vm.prank(supplierB); kernel.approveSupplierPlan(pid,1,1,cutoff); }
        else kernel.approveLenderPlan(pid,0,u(1500),cutoff);
        _fundEscrow(pid); vm.prank(merchant); kernel.joinMerchant(pid);
        bytes32 beforeTime=_moneyState(pid); uint256 custody=kernel.totalCustody(); vm.warp(cutoff);
        assertEq(_moneyState(pid),beforeTime); _assertCutoffBlocksCommit(pid);
        vm.prank(address(0xBEEF)); kernel.releaseExpiredPlan(pid);
        assertEq(kernel.totalCustody(),custody,"cleanup transferred escrow");
        (,uint256 amount,bool refundable,bool withdrawn)=kernel.getEscrow(pid);
        assertEq(amount,u(4000)); assertTrue(refundable); assertFalse(withdrawn);
        (,uint256 cash,,uint256 held,uint256 active,uint256 debt)=kernel.getAccount(accMerchant);
        assertEq(cash,u(3000)); assertEq(held,0); assertEq(active,0); assertEq(debt,0);
        bytes32 released=_moneyState(pid);
        vm.expectRevert(BK_PlanNotOpen.selector); kernel.releaseExpiredPlan(pid);
        assertEq(_moneyState(pid),released);
        vm.prank(customer); kernel.withdrawCustomerEscrow(pid);
        assertEq(kernel.totalCustody(),custody-u(4000)); assertEq(tok.balanceOf(customer),u(4000));
        bytes32 refunded=_moneyState(pid);
        vm.prank(customer); vm.expectRevert(); kernel.withdrawCustomerEscrow(pid);
        assertEq(_moneyState(pid),refunded,"refund replay changed funds");
    }
    function test_AE23_COFundingExpiryCleanupAndSeparateRefund() public { _checkCOCleanup(false); }
    function test_AE24_COFreightExpiryCleanupAndSeparateRefund() public { _checkCOCleanup(true); }
    function test_AE25_CPApprovalOverwriteBlockedWhileHeld() public {
        uint256 pid=_draftCP(); uint256 cutoff=block.timestamp+60; _approveCP(pid,cutoff); _joinCP(pid);
        bytes32 held=_moneyState(pid);
        vm.expectRevert(BK_ApprovalOverwriteWhileJoined.selector); kernel.approveLenderPlan(pid,0,u(160),PLAN_EXPIRY);
        vm.prank(supplierA); vm.expectRevert(BK_ApprovalOverwriteWhileJoined.selector); kernel.approveSupplierPlan(pid,0,100,PLAN_EXPIRY);
        vm.warp(cutoff);
        vm.expectRevert(BK_ApprovalOverwriteWhileJoined.selector); kernel.approveLenderPlan(pid,0,u(160),PLAN_EXPIRY);
        vm.prank(supplierA); vm.expectRevert(BK_ApprovalOverwriteWhileJoined.selector); kernel.approveSupplierPlan(pid,0,100,PLAN_EXPIRY);
        assertEq(_moneyState(pid),held); _assertCutoffBlocksCommit(pid);
    }
    function test_AE26_COApprovalOverwriteBlockedWhileHeld() public {
        uint256 pid=_draftCO(); uint256 cutoff=block.timestamp+60; _approveCO(pid,cutoff); _fundEscrow(pid);
        vm.prank(merchant); kernel.joinMerchant(pid); bytes32 held=_moneyState(pid);
        vm.expectRevert(BK_ApprovalOverwriteWhileJoined.selector); kernel.approveLenderPlan(pid,0,u(1500),PLAN_EXPIRY);
        vm.prank(supplierA); vm.expectRevert(BK_ApprovalOverwriteWhileJoined.selector); kernel.approveSupplierPlan(pid,0,100,PLAN_EXPIRY);
        vm.prank(supplierB); vm.expectRevert(BK_ApprovalOverwriteWhileJoined.selector); kernel.approveSupplierPlan(pid,1,1,PLAN_EXPIRY);
        vm.warp(cutoff);
        vm.expectRevert(BK_ApprovalOverwriteWhileJoined.selector); kernel.approveLenderPlan(pid,0,u(1500),PLAN_EXPIRY);
        assertEq(_moneyState(pid),held); _assertCutoffBlocksCommit(pid);
    }
    function test_AE27_CPReplacementCannotExtendExecutionCutoff() public {
        uint256 pid=_draftCP(); uint256 cutoff=block.timestamp+60; _approveCP(pid,PLAN_EXPIRY);
        kernel.approveLenderPlan(pid,0,u(160),cutoff);
        vm.prank(buyerA); kernel.joinBuyer(pid,0); kernel.revokeLenderApproval(pid,0);
        kernel.approveLenderPlan(pid,0,u(160),PLAN_EXPIRY); _joinCP(pid);
        (bool joined,uint256 generation,,)=kernel.getBuyerParticipation(pid,0); assertTrue(joined); assertEq(generation,2);
        (,uint256 replacementExpiry)=kernel.getLenderPlanApproval(pid,0); assertEq(replacementExpiry,PLAN_EXPIRY);
        vm.warp(cutoff); _assertCutoffBlocksCommit(pid);
        vm.prank(address(0xBEEF)); kernel.releaseExpiredPlan(pid);
    }
    function test_AE28_COReplacementCannotExtendExecutionCutoff() public {
        uint256 pid=_draftCO(); uint256 cutoff=block.timestamp+60; _approveCO(pid,PLAN_EXPIRY);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid,0,100,cutoff);
        _fundEscrow(pid); vm.prank(merchant); kernel.joinMerchant(pid);
        vm.prank(supplierA); kernel.revokeOfferApproval(pid,0);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid,0,100,PLAN_EXPIRY);
        vm.prank(merchant); kernel.joinMerchant(pid);
        (,uint256 replacementExpiry)=kernel.getSupplierPlanApproval(pid,0); assertEq(replacementExpiry,PLAN_EXPIRY);
        vm.warp(cutoff); _assertCutoffBlocksCommit(pid);
        vm.prank(address(0xBEEF)); kernel.releaseExpiredPlan(pid);
    }
    function _checkCPOrder(bool supplierFirst) internal {
        uint256 pid=_draftCP(); uint256 cutoff=block.timestamp+60;
        if(supplierFirst) { vm.prank(supplierA); kernel.approveSupplierPlan(pid,0,100,PLAN_EXPIRY); }
        kernel.approveLenderPlan(pid,0,u(160),cutoff);
        if(!supplierFirst) { vm.prank(supplierA); kernel.approveSupplierPlan(pid,0,100,PLAN_EXPIRY); }
        kernel.approveLenderPlan(pid,1,u(165),PLAN_EXPIRY); kernel.approveLenderPlan(pid,2,u(125),PLAN_EXPIRY);
        (,uint256 lenderExpiry)=kernel.getLenderPlanApproval(pid,0); (,uint256 supplierExpiry)=kernel.getSupplierPlanApproval(pid,0);
        assertEq(lenderExpiry,cutoff); assertEq(supplierExpiry,PLAN_EXPIRY);
        _joinCP(pid); (bool ready,)=kernel.planReadiness(pid); assertTrue(ready);
        vm.warp(cutoff); _assertCutoffBlocksCommit(pid);
    }
    function test_AE29_CPLenderFirstIndependentDeadlines() public { _checkCPOrder(false); }
    function test_AE30_CPSupplierFirstIndependentDeadlines() public { _checkCPOrder(true); }
    function _checkCOOrder(bool supplierFirst) internal {
        uint256 pid=_draftCO(); uint256 cutoff=block.timestamp+60;
        if(supplierFirst) { vm.prank(supplierB); kernel.approveSupplierPlan(pid,1,1,cutoff); }
        kernel.approveLenderPlan(pid,0,u(1500),PLAN_EXPIRY);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid,0,100,PLAN_EXPIRY);
        if(!supplierFirst) { vm.prank(supplierB); kernel.approveSupplierPlan(pid,1,1,cutoff); }
        _fundEscrow(pid); vm.prank(merchant); kernel.joinMerchant(pid);
        (bool ready,)=kernel.planReadiness(pid); assertTrue(ready);
        (,uint256 lenderExpiry)=kernel.getLenderPlanApproval(pid,0); (,uint256 freightExpiry)=kernel.getSupplierPlanApproval(pid,1);
        assertEq(lenderExpiry,PLAN_EXPIRY); assertEq(freightExpiry,cutoff);
        vm.warp(cutoff); _assertCutoffBlocksCommit(pid);
    }
    function test_AE31_COLenderFirstIndependentDeadlines() public { _checkCOOrder(false); }
    function test_AE32_COFreightFirstIndependentDeadlines() public { _checkCOOrder(true); }
    function test_AE33_ExpiredCutoffBlocksNewEscrowFunding() public {
        uint256 pid=_draftCO(); uint256 cutoff=block.timestamp+60; _approveCO(pid,cutoff);
        tok.mint(customer,u(4000)); vm.prank(customer); tok.approve(address(kernel),u(4000));
        vm.warp(cutoff); bytes32 beforeState=_moneyState(pid);
        vm.prank(customer); vm.expectRevert(BK_ApprovalCutoffExpired.selector); kernel.fundCustomerEscrow(pid);
        assertEq(_moneyState(pid),beforeState); assertEq(tok.allowance(customer,address(kernel)),u(4000));
    }
    function test_AE34_CPExpiryCannotEraseCommittedDebt() public {
        uint256 pid=_draftCP(); uint256 cutoff=block.timestamp+60; _approveCP(pid,cutoff); _joinCP(pid); kernel.commitPlan(pid);
        (,,,,,uint256 debt)=kernel.getAccount(accA); assertEq(debt,u(160)); bytes32 committed=_moneyState(pid);
        vm.warp(cutoff); vm.expectRevert(BK_PlanNotOpen.selector); kernel.releaseExpiredPlan(pid);
        assertEq(_moneyState(pid),committed);
    }
    function test_AE35_COExpiryCannotEraseCommittedDebt() public {
        uint256 pid=_draftCO(); uint256 cutoff=block.timestamp+60; _approveCO(pid,cutoff); _fundEscrow(pid);
        vm.prank(merchant); kernel.joinMerchant(pid); kernel.commitPlan(pid);
        (,,,,,uint256 debt)=kernel.getAccount(accMerchant); assertEq(debt,u(1500)); bytes32 committed=_moneyState(pid);
        vm.warp(cutoff); vm.expectRevert(BK_PlanNotOpen.selector); kernel.releaseExpiredPlan(pid);
        assertEq(_moneyState(pid),committed);
    }
}
