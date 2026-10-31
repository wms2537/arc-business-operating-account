// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./KernelBase.t.sol";

/**
 * Scenario A — Collective Purchase fixture
 * Covers DC-01..DC-16, DC-38, DC-45..DC-47, DC-49 (group-side)
 */
contract ScenarioATest is KernelBase {

    uint256 planId;

    function setUp() public override {
        super.setUp();
        seedGroupFixture();
        planId = draftAndApproveFullCPPlan();
    }

    // ── DC-01: A and B join; cash unchanged, holds correct ──────────────

    function test_DC01_ABJoin() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        vm.prank(buyerB); kernel.joinBuyer(planId, 1);

        // A: cash unchanged at 300 demo
        (,uint256 cashA,,uint256 heldA,,) = kernel.getAccount(accA);
        assertEq(cashA, u(300), "A cash unchanged");
        assertEq(heldA, u(200), "A hold = 200");

        (,uint256 cashB,,uint256 heldB,,) = kernel.getAccount(accB);
        assertEq(cashB, u(250), "B cash unchanged");
        assertEq(heldB, u(150), "B hold = 150");

        // Lender: reserved 160+165 = 325, cash still 500
        (,uint256 poolCash, uint256 poolRes) = kernel.getPool(lenderPool);
        assertEq(poolCash, u(500), "pool cash unchanged");
        assertEq(poolRes,  u(325), "pool reserved 325");

        // Capacity held 75
        (,,,,, uint256 offerRes,,, ) = kernel.getOffer(offerGroup);
        assertEq(offerRes, 75, "offer reserved 75");

        // No debt
        (,,,,, uint256 debtA) = kernel.getAccount(accA);
        (,,,,, uint256 debtB) = kernel.getAccount(accB);
        assertEq(debtA, 0, "A debt zero");
        assertEq(debtB, 0, "B debt zero");
    }

    // ── DC-02: C joins; totals correct; readiness true ───────────────────

    function test_DC02_CJoins() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        vm.prank(buyerB); kernel.joinBuyer(planId, 1);
        vm.prank(buyerC); kernel.joinBuyer(planId, 2);

        (,uint256 cashC,,uint256 heldC,,) = kernel.getAccount(accC);
        assertEq(cashC, u(200), "C cash unchanged");
        assertEq(heldC, u(100), "C hold = 100");

        (,uint256 poolCash, uint256 poolRes) = kernel.getPool(lenderPool);
        assertEq(poolCash, u(500), "pool cash still 500");
        assertEq(poolRes,  u(450), "pool reserved 450");

        (,,,,, uint256 offerRes,,, ) = kernel.getOffer(offerGroup);
        assertEq(offerRes, 100, "offer reserved 100");

        (bool rdy,) = kernel.planReadiness(planId);
        assertTrue(rdy, "plan ready");
    }

    // ── DC-03: Duplicate join rejected ───────────────────────────────────

    function test_DC03_DuplicateJoinReverts() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        vm.prank(buyerA);
        vm.expectRevert(BK_AlreadyJoined.selector);
        kernel.joinBuyer(planId, 0);
    }

    // ── DC-04: Lender funded with only 300; A succeeds, B fails ─────────

    function test_DC04_Lender300_ASucceedsBFails() public {
        // New kernel with fresh offer
        MockERC20      tok2    = new MockERC20();
        address lender2 = makeAddr("lender2");
        address bA = makeAddr("bA2"); address bB = makeAddr("bB2");
        address supA2 = makeAddr("supA2");

        BusinessKernel kernel2 = new BusinessKernel(address(tok2), lender2);
        uint256 pool2 = kernel2.POOL_ID();
        vm.prank(bA);      uint256 aA = kernel2.openAccount();
        vm.prank(bB);      uint256 aB = kernel2.openAccount();

        uint256 exp = block.timestamp + 7 days;
        vm.prank(supA2);
        uint256 off2 = kernel2.createOffer(supA2, u(9), 100, 100, exp);

        // Fund lender with only 300
        tok2.mint(lender2, u(300));
        vm.prank(lender2); tok2.approve(address(kernel2), u(300));
        vm.prank(lender2); kernel2.depositPool(pool2, u(300));

        vm.prank(lender2); kernel2.setBorrowerLimit(pool2, aA, u(200));
        vm.prank(lender2); kernel2.setBorrowerLimit(pool2, aB, u(200));

        tok2.mint(bA, u(300)); vm.prank(bA); tok2.approve(address(kernel2), u(300));
        vm.prank(bA); kernel2.depositCash(aA, u(300));
        vm.prank(bA); kernel2.setProtectedFloor(aA, u(100));

        tok2.mint(bB, u(250)); vm.prank(bB); tok2.approve(address(kernel2), u(250));
        vm.prank(bB); kernel2.depositCash(aB, u(250));
        vm.prank(bB); kernel2.setProtectedFloor(aB, u(100));

        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](2);
        buyers[0] = IBusinessKernel.BuyerTerms(bA, aA, 40, u(200), u(160), u(200));
        buyers[1] = IBusinessKernel.BuyerTerms(bB, aB, 35, u(150), u(165), u(200));

        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(off2, 75, supA2);

        IBusinessKernel.PlanTerms memory t = IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers: buyers,
            saleParty: IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId: pool2,
            offerRefs: refs,
            expiry: exp,
            commercialRef: bytes32("dc04")
        });
        (uint256 p2,) = kernel2.draftPlan(t);

        // Grant plan-specific approvals
        vm.prank(lender2); kernel2.approveLenderPlan(p2, 0, u(160), exp);
        vm.prank(lender2); kernel2.approveLenderPlan(p2, 1, u(165), exp);
        vm.prank(supA2);   kernel2.approveSupplierPlan(p2, 0, 75, exp);

        // A joins — uses 160 of 300, leaves 140
        vm.prank(bA); kernel2.joinBuyer(p2, 0);
        (,, uint256 res2) = kernel2.getPool(pool2);
        assertEq(res2, u(160), "pool reserved 160 after A");

        // B fails — needs 165, only 140 available
        vm.prank(bB);
        vm.expectRevert(BK_InsufficientPoolLiquidity.selector);
        kernel2.joinBuyer(p2, 1);

        // A's reservation untouched
        _assertBuyerJoined(kernel2, p2, 0, u(200));
    }

    function _assertBuyerJoined(BusinessKernel k, uint256 pid, uint256 idx, uint256 expectedHeld) internal {
        (bool joined,, uint256 held,) = k.getBuyerParticipation(pid, idx);
        assertTrue(joined, "buyer still joined");
        assertEq(held, expectedHeld, "hold unchanged");
    }

    // ── DC-05: Already-held cash can't be reserved for another plan ──────

    function test_DC05_HeldCashBlocksSecondPlan() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0); // holds 200 of A's 200 avail

        // Draft a second plan where A needs another 50 own cash
        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](1);
        // 10 units × u(9) = u(90). A already has 200 held; avail = 300-100(floor)-200(held) = 0.
        buyers[0] = IBusinessKernel.BuyerTerms(buyerA, accA, 10, u(90), 0, 0);
        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(offerGroup, 10, supplierA);

        IBusinessKernel.PlanTerms memory t2 = IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers: buyers,
            saleParty: IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId: lenderPool,
            offerRefs: refs,
            expiry: block.timestamp + 7 days,
            commercialRef: bytes32("dc05")
        });
        (uint256 p2,) = kernel.draftPlan(t2);
        // No credit draw; only supplier approval needed
        vm.prank(supplierA); kernel.approveSupplierPlan(p2, 0, 10, block.timestamp + 7 days);

        vm.prank(buyerA);
        vm.expectRevert(BK_InsufficientBuyerCash.selector);
        kernel.joinBuyer(p2, 0);
    }

    // ── DC-06: Already-reserved pool liquidity blocks second plan ────────

    function test_DC06_HeldCreditBlocksSecondPlan() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        vm.prank(buyerB); kernel.joinBuyer(planId, 1);
        // Pool now has 175 free (500 - 325)

        // Second plan needs 176 from pool
        address bX = makeAddr("bX");
        vm.prank(bX); uint256 accX = kernel.openAccount();
        fundAccount(bX, accX, u(300));
        vm.prank(lender); kernel.setBorrowerLimit(lenderPool, accX, u(300));

        // 20 units × u(9) = u(180); pool only has 175 free after A+B reserve 325
        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](1);
        buyers[0] = IBusinessKernel.BuyerTerms(bX, accX, 20, u(0), u(180), u(300));
        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(offerGroup, 20, supplierA);

        IBusinessKernel.PlanTerms memory t2 = IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers: buyers,
            saleParty: IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId: lenderPool,
            offerRefs: refs,
            expiry: block.timestamp + 7 days,
            commercialRef: bytes32("dc06")
        });
        (uint256 p2,) = kernel.draftPlan(t2);
        vm.prank(lender);    kernel.approveLenderPlan(p2, 0, u(180), block.timestamp + 7 days);
        vm.prank(supplierA); kernel.approveSupplierPlan(p2, 0, 20, block.timestamp + 7 days);

        vm.prank(bX);
        vm.expectRevert(BK_InsufficientPoolLiquidity.selector);
        kernel.joinBuyer(p2, 0);
    }

    // ── DC-07: Capacity 99; A/B can reserve 75; C(25) fails ─────────────

    function test_DC07_Capacity99_CFailsPartial() public {
        // Create a fresh offer with capacity 99
        vm.prank(supplierA);
        // capacity=99, minimumFill=1 so A/B can reserve 75 (below minimumFill is only a commit gate)
        uint256 off99 = kernel.createOffer(supplierA, u(9), 99, 1, block.timestamp + 7 days);

        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](3);
        buyers[0] = IBusinessKernel.BuyerTerms(buyerA, accA, 40, u(200), u(160), u(200));
        buyers[1] = IBusinessKernel.BuyerTerms(buyerB, accB, 35, u(150), u(165), u(200));
        buyers[2] = IBusinessKernel.BuyerTerms(buyerC, accC, 25, u(100), u(125), u(200));

        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(off99, 100, supplierA);

        IBusinessKernel.PlanTerms memory t = IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers: buyers,
            saleParty: IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId: lenderPool,
            offerRefs: refs,
            expiry: block.timestamp + 7 days,
            commercialRef: bytes32("dc07")
        });
        (uint256 p99,) = kernel.draftPlan(t);
        vm.prank(lender);    kernel.approveLenderPlan(p99, 0, u(160), block.timestamp + 7 days);
        vm.prank(lender);    kernel.approveLenderPlan(p99, 1, u(165), block.timestamp + 7 days);
        vm.prank(lender);    kernel.approveLenderPlan(p99, 2, u(125), block.timestamp + 7 days);
        vm.prank(supplierA); kernel.approveSupplierPlan(p99, 0, 100, block.timestamp + 7 days);

        // A and B can reserve 75 total
        vm.prank(buyerA); kernel.joinBuyer(p99, 0);
        vm.prank(buyerB); kernel.joinBuyer(p99, 1);
        (,,,,, uint256 res99,,, ) = kernel.getOffer(off99);
        assertEq(res99, 75, "75 reserved");

        // C fails
        vm.prank(buyerC);
        vm.expectRevert(BK_OfferCapacityExceeded.selector);
        kernel.joinBuyer(p99, 2);

        // A/B reservations unchanged
        (bool jA,, uint256 hA,) = kernel.getBuyerParticipation(p99, 0);
        (bool jB,, uint256 hB,) = kernel.getBuyerParticipation(p99, 1);
        assertTrue(jA && jB, "A and B still joined");
        assertEq(hA, u(200), "A hold intact");
        assertEq(hB, u(150), "B hold intact");
    }

    // ── DC-08: Two plans share same offer, aggregate ≤ capacity ─────────

    function test_DC08_TwoPlansShareOffer() public {
        // Plan1 (A only, 40 units)
        IBusinessKernel.BuyerTerms[] memory b1 = new IBusinessKernel.BuyerTerms[](1);
        b1[0] = IBusinessKernel.BuyerTerms(buyerA, accA, 40, u(200), u(160), u(200));
        IBusinessKernel.OfferRef[] memory r1 = new IBusinessKernel.OfferRef[](1);
        r1[0] = IBusinessKernel.OfferRef(offerGroup, 40, supplierA);
        (uint256 p1,) = kernel.draftPlan(IBusinessKernel.PlanTerms(
            IBusinessKernel.WorkflowKind.CollectivePurchase, b1,
            IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPool, r1, block.timestamp + 7 days, bytes32("dc08-1")
        ));
        vm.prank(lender);    kernel.approveLenderPlan(p1, 0, u(160), block.timestamp + 7 days);
        vm.prank(supplierA); kernel.approveSupplierPlan(p1, 0, 40, block.timestamp + 7 days);

        // Plan2 (bX, 61 units — would exceed capacity with plan1)
        address bX08 = makeAddr("bX08");
        vm.prank(bX08); uint256 accX08 = kernel.openAccount();
        fundAccount(bX08, accX08, u(600)); // 61 * u(9) = u(549)

        IBusinessKernel.BuyerTerms[] memory b2 = new IBusinessKernel.BuyerTerms[](1);
        b2[0] = IBusinessKernel.BuyerTerms(bX08, accX08, 61, u(549), u(0), u(0));
        IBusinessKernel.OfferRef[] memory r2 = new IBusinessKernel.OfferRef[](1);
        r2[0] = IBusinessKernel.OfferRef(offerGroup, 61, supplierA);
        (uint256 p2,) = kernel.draftPlan(IBusinessKernel.PlanTerms(
            IBusinessKernel.WorkflowKind.CollectivePurchase, b2,
            IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPool, r2, block.timestamp + 7 days, bytes32("dc08-2")
        ));
        vm.prank(supplierA); kernel.approveSupplierPlan(p2, 0, 61, block.timestamp + 7 days);

        vm.prank(buyerA); kernel.joinBuyer(p1, 0); // holds 40
        // bX08's plan asks for 61, only 60 remain
        vm.prank(bX08);
        vm.expectRevert(BK_OfferCapacityExceeded.selector);
        kernel.joinBuyer(p2, 0);
    }

    // ── DC-09: A leaves; exact release; retry idempotent via revert ──────

    function test_DC09_LeaveAndRetry() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);

        (,uint256 cashA_before,,uint256 heldA_before,,) = kernel.getAccount(accA);
        (,, uint256 poolRes_before) = kernel.getPool(lenderPool);
        (,,,,, uint256 offerRes_before,,, ) = kernel.getOffer(offerGroup);

        vm.prank(buyerA); kernel.leaveBuyer(planId, 0);

        (,uint256 cashA,,uint256 heldA,,) = kernel.getAccount(accA);
        (,, uint256 poolRes) = kernel.getPool(lenderPool);
        (,,,,, uint256 offerRes,,, ) = kernel.getOffer(offerGroup);

        assertEq(cashA, cashA_before, "cash unchanged");
        assertEq(heldA, heldA_before - u(200), "hold released 200");
        assertEq(poolRes, poolRes_before - u(160), "pool released 160");
        assertEq(offerRes, offerRes_before - 40, "capacity released 40");

        // Retry: not joined
        vm.prank(buyerA);
        vm.expectRevert(BK_NotJoined.selector);
        kernel.leaveBuyer(planId, 0);
    }

    // ── DC-10: Block.timestamp == expiry; join/commit fail ───────────────

    function test_DC10_ExpiryEquality() public {
        uint256 exp = block.timestamp + 1;
        IBusinessKernel.PlanTerms memory t = _cpTerms(
            [uint256(40), 35, 25], [u(200), u(150), u(100)],
            [u(160), u(165), u(125)], [u(200), u(200), u(200)],
            100, exp
        );
        (uint256 p2,) = kernel.draftPlan(t);

        vm.warp(exp); // timestamp == expiry
        vm.prank(buyerA);
        vm.expectRevert(BK_PlanExpired.selector);
        kernel.joinBuyer(p2, 0);
    }

    // ── DC-11: Release expired plan twice; second is no-op revert ────────

    function test_DC11_ReleaseExpiredTwice() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        vm.prank(buyerB); kernel.joinBuyer(planId, 1);

        vm.warp(block.timestamp + 8 days); // past expiry

        kernel.releaseExpiredPlan(planId);

        // Holds released
        (,,, uint256 heldA,,) = kernel.getAccount(accA);
        assertEq(heldA, 0, "A hold released");

        // Second release reverts
        vm.expectRevert(BK_PlanNotOpen.selector);
        kernel.releaseExpiredPlan(planId);
    }

    // ── DC-12: Lender revokes B; B's bundle released; others intact ──────

    function test_DC12_LenderRevokesB() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        vm.prank(buyerB); kernel.joinBuyer(planId, 1);
        vm.prank(buyerC); kernel.joinBuyer(planId, 2);

        vm.prank(lender); kernel.revokeLenderApproval(planId, 1); // index 1 = B

        // B not joined
        (bool jB,,,) = kernel.getBuyerParticipation(planId, 1);
        assertFalse(jB, "B not joined after revoke");

        // A and C still joined
        (bool jA,,,) = kernel.getBuyerParticipation(planId, 0);
        (bool jC,,,) = kernel.getBuyerParticipation(planId, 2);
        assertTrue(jA, "A still joined");
        assertTrue(jC, "C still joined");

        // No debt anywhere
        (,,,,, uint256 debtB) = kernel.getAccount(accB);
        assertEq(debtB, 0, "B debt zero");

        // Plan not ready (B missing)
        (bool rdy,) = kernel.planReadiness(planId);
        assertFalse(rdy, "plan not ready after revoke");
    }

    // ── DC-13: Supplier revokes offer; commit fails ───────────────────────

    function test_DC13_SupplierRevokeBlocksCommit() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        vm.prank(buyerB); kernel.joinBuyer(planId, 1);
        vm.prank(buyerC); kernel.joinBuyer(planId, 2);

        vm.prank(supplierA); kernel.revokeOffer(offerGroup);

        vm.expectRevert(BK_OfferRevoked.selector);
        kernel.commitPlan(planId);
    }

    // ── DC-14: Full group commit — exact fixture amounts ─────────────────

    function test_DC14_FullGroupCommit() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        vm.prank(buyerB); kernel.joinBuyer(planId, 1);
        vm.prank(buyerC); kernel.joinBuyer(planId, 2);

        uint256 supplierBefore = tok.balanceOf(supplierA);
        kernel.commitPlan(planId);

        // Supplier received 900 demo = 900_000 µUSDC
        assertEq(tok.balanceOf(supplierA) - supplierBefore, u(900), "supplier payout 900");

        // Each buyer retains 100 cash (300-200=100, 250-150=100, 200-100=100)
        (,uint256 cashA,,uint256 heldA,,uint256 debtA) = kernel.getAccount(accA);
        (,uint256 cashB,,uint256 heldB,,uint256 debtB) = kernel.getAccount(accB);
        (,uint256 cashC,,uint256 heldC,,uint256 debtC) = kernel.getAccount(accC);
        assertEq(cashA, u(100), "A cash 100"); assertEq(heldA, 0, "A held 0");
        assertEq(cashB, u(100), "B cash 100"); assertEq(heldB, 0, "B held 0");
        assertEq(cashC, u(100), "C cash 100"); assertEq(heldC, 0, "C held 0");

        // Principal 160/165/125
        assertEq(debtA, u(160), "A principal 160");
        assertEq(debtB, u(165), "B principal 165");
        assertEq(debtC, u(125), "C principal 125");

        // Lender cash 50 (500 - 450)
        (,uint256 poolCash, uint256 poolRes) = kernel.getPool(lenderPool);
        assertEq(poolCash, u(50),  "lender cash 50");
        assertEq(poolRes,  0,      "pool reserved 0");

        // Capacity consumed 100
        (,,,,,uint256 capRes, uint256 capCons,,) = kernel.getOffer(offerGroup);
        assertEq(capRes,  0,   "reserved 0");
        assertEq(capCons, 100, "consumed 100");

        // Kernel holds 350 = 100*3 + 50
        assertEq(tok.balanceOf(address(kernel)), u(350), "kernel 350");
    }

    // ── DC-15: Replay commit reverts ─────────────────────────────────────

    function test_DC15_ReplayCommitReverts() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        vm.prank(buyerB); kernel.joinBuyer(planId, 1);
        vm.prank(buyerC); kernel.joinBuyer(planId, 2);
        kernel.commitPlan(planId);

        vm.expectRevert(BK_AlreadyCommitted.selector);
        kernel.commitPlan(planId);
    }

    // ── DC-16: Final payout fails → full revert
    // Covered by PayoutRollbackRegression.t.sol:
    //   test_failingSecondPayoutRollsBackTheFirstPayoutAndAllClaims
    // That test uses vm.mockCall to force a false return on the second transfer,
    // then asserts the first transfer rolled back and all claim counters are
    // restored to their pre-commit values.

    // ── DC-38: Collections credit buyer cash; repayment separate ─────────

    function test_DC38_CollectionsAndRepayment() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        vm.prank(buyerB); kernel.joinBuyer(planId, 1);
        vm.prank(buyerC); kernel.joinBuyer(planId, 2);
        kernel.commitPlan(planId);

        // Register opening receivables
        vm.prank(buyerA);
        kernel.registerReceivable(1, accA, customer, u(160), bytes32("prov-A"));
        vm.prank(buyerB);
        kernel.registerReceivable(2, accB, customer, u(165), bytes32("prov-B"));
        vm.prank(buyerC);
        kernel.registerReceivable(3, accC, customer, u(125), bytes32("prov-C"));

        // Customer has 1000 external
        tok.mint(customer, u(1000));

        // Collect A's 160
        vm.prank(customer);
        tok.approve(address(kernel), u(1000));
        vm.prank(customer);
        kernel.collectReceivable(1, bytes32("pay-A"), u(160));
        (,uint256 cashA,,,,uint256 debtA) = kernel.getAccount(accA);
        assertEq(cashA, u(260), "A cash 260 after collection");
        assertEq(debtA, u(160), "A debt unchanged 160");

        // Collect B's 165
        vm.prank(customer);
        kernel.collectReceivable(2, bytes32("pay-B"), u(165));
        (,uint256 cashB,,,,uint256 debtB) = kernel.getAccount(accB);
        assertEq(cashB, u(265), "B cash 265");
        assertEq(debtB, u(165), "B debt 165");

        // Collect C's 125
        vm.prank(customer);
        kernel.collectReceivable(3, bytes32("pay-C"), u(125));
        (,uint256 cashC,,,,uint256 debtC) = kernel.getAccount(accC);
        assertEq(cashC, u(225), "C cash 225");
        assertEq(debtC, u(125), "C debt 125");

        // Lender still 50
        (,uint256 poolCash,) = kernel.getPool(lenderPool);
        assertEq(poolCash, u(50), "lender still 50");

        // Kernel: 350 + 450 collections = 800
        assertEq(tok.balanceOf(address(kernel)), u(800), "kernel 800");

        // Now separate repayments — find loan IDs (1,2,3 = A,B,C)
        vm.prank(buyerA); kernel.repayLoan(1, u(160));
        (,uint256 cashA2,,,,uint256 debtA2) = kernel.getAccount(accA);
        assertEq(cashA2, u(100), "A cash 100 after repay");
        assertEq(debtA2, 0,      "A debt 0");

        vm.prank(buyerB); kernel.repayLoan(2, u(165));
        vm.prank(buyerC); kernel.repayLoan(3, u(125));

        // Terminal: lender 500
        (,uint256 poolFinal,) = kernel.getPool(lenderPool);
        assertEq(poolFinal, u(500), "lender 500 terminal");

        // Buyer cash 100 each
        (,uint256 fA,,,,) = kernel.getAccount(accA);
        (,uint256 fB,,,,) = kernel.getAccount(accB);
        (,uint256 fC,,,,) = kernel.getAccount(accC);
        assertEq(fA, u(100), "A terminal 100");
        assertEq(fB, u(100), "B terminal 100");
        assertEq(fC, u(100), "C terminal 100");

        // Kernel still 800 (repayments are internal)
        assertEq(tok.balanceOf(address(kernel)), u(800), "kernel 800 terminal");
    }

    // ── DC-45: Register receivables; no cash change; stranger rejected ────

    function test_DC45_RegisterReceivables() public {
        vm.prank(buyerA);
        kernel.registerReceivable(101, accA, customer, u(160), bytes32("prov-101"));

        (uint256 benId, address payer, uint256 open, uint256 rem,,,) =
            kernel.getReceivable(101);
        assertEq(benId, accA,      "beneficiary A");
        assertEq(payer, customer,  "payer correct");
        assertEq(open,  u(160),    "opening 160");
        assertEq(rem,   u(160),    "remaining 160");

        // Cash unchanged
        (,uint256 cashA,,,,) = kernel.getAccount(accA);
        assertEq(cashA, u(300), "A cash unchanged by registration");

        // Stranger cannot register for A's account
        vm.prank(stranger);
        vm.expectRevert(BK_NotBeneficiaryOwner.selector);
        kernel.registerReceivable(102, accA, customer, u(100), bytes32("bad"));
    }

    // ── DC-46: Bound payer collects; attribution correct ─────────────────

    function test_DC46_CollectReceivable() public {
        vm.prank(buyerA);
        kernel.registerReceivable(201, accA, customer, u(160), bytes32("pr-A"));

        tok.mint(customer, u(160));
        vm.prank(customer); tok.approve(address(kernel), u(160));
        vm.prank(customer);
        kernel.collectReceivable(201, bytes32("ref-1"), u(160));

        (,,,uint256 rem,,,) = kernel.getReceivable(201);
        assertEq(rem, 0, "remaining 0");

        (,uint256 cashA,,,,) = kernel.getAccount(accA);
        assertEq(cashA, u(300) + u(160), "A credited 160");
    }

    // ── DC-47: Unauthorized payer, dup ref, overpay rejected ─────────────

    function test_DC47_InvalidCollections() public {
        vm.prank(buyerA);
        kernel.registerReceivable(301, accA, customer, u(160), bytes32("pr-A2"));

        tok.mint(stranger, u(160));
        vm.prank(stranger); tok.approve(address(kernel), u(160));

        // Wrong payer
        vm.prank(stranger);
        vm.expectRevert(BK_NotBoundPayer.selector);
        kernel.collectReceivable(301, bytes32("r1"), u(160));

        tok.mint(customer, u(200));
        vm.prank(customer); tok.approve(address(kernel), u(200));

        // Overpay
        vm.prank(customer);
        vm.expectRevert(BK_ExceedsRemaining.selector);
        kernel.collectReceivable(301, bytes32("r1"), u(200));

        // Valid first collection
        vm.prank(customer);
        kernel.collectReceivable(301, bytes32("r1"), u(100));

        // Duplicate ref
        vm.prank(customer);
        vm.expectRevert(BK_PaymentRefUsed.selector);
        kernel.collectReceivable(301, bytes32("r1"), u(60));
    }

    // ── DC-49: Participation count; floor lock; rejoin ────────────────────

    function test_DC49_ParticipationCount() public {
        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        assertEq(_planCount(accA), 1, "count 1 after join");

        vm.prank(buyerA); kernel.leaveBuyer(planId, 0);
        assertEq(_planCount(accA), 0, "count 0 after leave");

        vm.prank(buyerA); kernel.joinBuyer(planId, 0);
        assertEq(_planCount(accA), 1, "count 1 after rejoin");
        (, uint256 gen,,) = kernel.getBuyerParticipation(planId, 0);
        assertEq(gen, 2, "generation incremented on rejoin");

        vm.prank(buyerB); kernel.joinBuyer(planId, 1);
        vm.prank(buyerC); kernel.joinBuyer(planId, 2);
        kernel.commitPlan(planId);

        assertEq(_planCount(accA), 0, "count 0 after commit");
        assertEq(_debt(accA), u(160), "debt 160 after commit");

        vm.prank(buyerA);
        vm.expectRevert(BK_OutstandingDebt.selector);
        kernel.setProtectedFloor(accA, u(0));
    }

    function _planCount(uint256 accId) internal view returns (uint256 c) {
        (,,,, c,) = kernel.getAccount(accId);
    }

    function _debt(uint256 accId) internal view returns (uint256 d) {
        (,,,,, d) = kernel.getAccount(accId);
    }
}
