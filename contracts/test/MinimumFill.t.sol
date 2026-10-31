// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./KernelBase.t.sol";

/**
 * MinimumFillTest -- supplier minimum-fill enforcement
 *
 * Spec: 02-domain-and-contracts.md s4 "Supplier offer"
 *   "Required fields: ... minimum fill where relevant ..."
 *   "The group offer has unit price 9 and capacity/minimum fill 100."
 *
 * Readiness and commit must agree: a plan that is below minimum fill is
 * not ready AND cannot commit.  A plan that meets minimum fill is ready
 * and can commit.
 *
 * Tests:
 *   MF-01  createOffer stores minimumFill; getOffer returns it
 *   MF-02  createOffer rejects minimumFill == 0
 *   MF-03  createOffer rejects minimumFill > capacity
 *   MF-04  A plan with aggregate qty < minimumFill cannot commit.
 *          planReadiness reports the blocker.
 *          All resources (cash holds, pool reservation, capacity) are
 *          unchanged after the failed commit attempt.
 *   MF-05  The canonical 100-unit collective purchase is ready and commits.
 *   MF-06  DC-07 preserved: capacity-99 offer rejects C's join at the
 *          capacity gate.  A/B holds are intact.  This is a capacity
 *          rejection, not a minimum-fill rejection.
 *   MF-07  A partial plan (A+B = 75 units) against a fill-100 offer:
 *          planReadiness returns (false, "Below offer minimum fill").
 *          commitPlan reverts BK_BelowMinimumFill.
 *          Supplier receives nothing; all holds are intact.
 *   MF-08  CO plan whose goods quantity is below the goods offer's
 *          minimumFill: planReadiness returns the goods blocker;
 *          commitPlan reverts BK_BelowMinimumFill.
 *   MF-09  CO plan whose freight quantity is below the freight offer's
 *          minimumFill: planReadiness returns the freight blocker;
 *          commitPlan reverts BK_BelowMinimumFill.
 */
contract MinimumFillTest is KernelBase {

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /// Return (minimumFill, reserved) for an offer without capturing other
    /// return values -- avoids stack-too-deep in callers that already have
    /// many locals.
    function _offerMF(uint256 offerId) internal view returns (uint256 mf) {
        (,,,, mf,,,,) = kernel.getOffer(offerId);
    }

    function _offerReserved(uint256 offerId) internal view returns (uint256 res) {
        (,,,,, res,,,) = kernel.getOffer(offerId);
    }

    // -----------------------------------------------------------------------
    // MF-01: createOffer stores minimumFill; getOffer returns it
    // -----------------------------------------------------------------------

    function test_MF01_MinimumFillStoredAndReturned() public {
        uint256 exp = block.timestamp + 7 days;
        vm.prank(supplierA);
        uint256 oid = kernel.createOffer(supplierA, u(9), 200, 50, exp);
        assertEq(_offerMF(oid), 50, "minimumFill stored and returned");
    }

    // -----------------------------------------------------------------------
    // MF-02: minimumFill == 0 is rejected
    // -----------------------------------------------------------------------

    function test_MF02_ZeroMinimumFillReverts() public {
        vm.prank(supplierA);
        vm.expectRevert(BK_InvalidMinimumFill.selector);
        kernel.createOffer(supplierA, u(9), 100, 0, block.timestamp + 7 days);
    }

    // -----------------------------------------------------------------------
    // MF-03: minimumFill > capacity is rejected
    // -----------------------------------------------------------------------

    function test_MF03_MinimumFillAboveCapacityReverts() public {
        vm.prank(supplierA);
        vm.expectRevert(BK_InvalidMinimumFill.selector);
        kernel.createOffer(supplierA, u(9), 100, 101, block.timestamp + 7 days);
    }

    // -----------------------------------------------------------------------
    // MF-04: plan qty < minimumFill -- not ready, commit blocked, state intact
    // -----------------------------------------------------------------------

    function test_MF04_BelowMinimumFillBlocksCommit() public {
        seedGroupFixture(); // fund accounts, set borrower limits

        uint256 exp = block.timestamp + 7 days;

        // capacity 200, minimumFill 100: joins succeed, commit fails at 75
        vm.prank(supplierA);
        uint256 offerPartial = kernel.createOffer(supplierA, u(9), 200, 100, exp);

        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](2);
        buyers[0] = IBusinessKernel.BuyerTerms(buyerA, accA, 40, u(200), u(160), u(200));
        buyers[1] = IBusinessKernel.BuyerTerms(buyerB, accB, 35, u(150), u(165), u(200));

        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(offerPartial, 75, supplierA);

        (uint256 pid,) = kernel.draftPlan(IBusinessKernel.PlanTerms({
            kind:          IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers:        buyers,
            saleParty:     IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId:  lenderPool,
            offerRefs:     refs,
            expiry:        exp,
            commercialRef: bytes32("mf04")
        }));

        vm.prank(lender);    kernel.approveLenderPlan(pid, 0, u(160), exp);
        vm.prank(lender);    kernel.approveLenderPlan(pid, 1, u(165), exp);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 75, exp);

        vm.prank(buyerA); kernel.joinBuyer(pid, 0);
        vm.prank(buyerB); kernel.joinBuyer(pid, 1);

        // planReadiness must report the blocker
        (bool rdy, string memory reason) = kernel.planReadiness(pid);
        assertFalse(rdy, "plan must not be ready below minimum fill");
        assertEq(reason, "Below offer minimum fill", "wrong readiness reason");

        // Snapshot pre-commit state
        uint256 cashA_pre; uint256 heldA_pre;
        uint256 cashB_pre; uint256 heldB_pre;
        uint256 poolCash_pre; uint256 poolRes_pre;
        uint256 offerRes_pre;
        {
            (,cashA_pre,,heldA_pre,,) = kernel.getAccount(accA);
            (,cashB_pre,,heldB_pre,,) = kernel.getAccount(accB);
            (,poolCash_pre,poolRes_pre) = kernel.getPool(lenderPool);
            offerRes_pre = _offerReserved(offerPartial);
        }

        vm.expectRevert(BK_BelowMinimumFill.selector);
        kernel.commitPlan(pid);

        // All state unchanged after failed commit
        {
            (,uint256 cashA,,uint256 heldA,,) = kernel.getAccount(accA);
            (,uint256 cashB,,uint256 heldB,,) = kernel.getAccount(accB);
            assertEq(cashA, cashA_pre,     "A cash unchanged");
            assertEq(heldA, heldA_pre,     "A hold unchanged");
            assertEq(cashB, cashB_pre,     "B cash unchanged");
            assertEq(heldB, heldB_pre,     "B hold unchanged");
        }
        {
            (,uint256 poolCash, uint256 poolRes) = kernel.getPool(lenderPool);
            assertEq(poolCash, poolCash_pre, "pool cash unchanged");
            assertEq(poolRes,  poolRes_pre,  "pool reserved unchanged");
        }
        assertEq(_offerReserved(offerPartial), offerRes_pre, "offer reserved unchanged");

        // Both buyers are still joined
        (bool jA,,,) = kernel.getBuyerParticipation(pid, 0);
        (bool jB,,,) = kernel.getBuyerParticipation(pid, 1);
        assertTrue(jA, "A still joined after failed commit");
        assertTrue(jB, "B still joined after failed commit");
    }

    // -----------------------------------------------------------------------
    // MF-05: canonical 100-unit purchase is ready and commits
    // -----------------------------------------------------------------------

    function test_MF05_CanonicalFullFillIsReadyAndCommits() public {
        seedGroupFixture();
        uint256 pid = draftAndApproveFullCPPlan();

        vm.prank(buyerA); kernel.joinBuyer(pid, 0);
        vm.prank(buyerB); kernel.joinBuyer(pid, 1);
        vm.prank(buyerC); kernel.joinBuyer(pid, 2);

        (bool rdy, string memory reason) = kernel.planReadiness(pid);
        assertTrue(rdy,  "canonical 100-unit plan must be ready");
        assertEq(reason, "", "no blocker for full-fill plan");

        uint256 supBefore = tok.balanceOf(supplierA);
        kernel.commitPlan(pid);

        assertEq(tok.balanceOf(supplierA) - supBefore, u(900),
            "supplier receives 900 on canonical full fill");
        assertEq(tok.balanceOf(address(kernel)), u(350),
            "kernel holds 350 after commit");

        // minimumFill is 100 on the canonical offer
        assertEq(_offerMF(offerGroup), 100, "offerGroup minimumFill is 100");
    }

    // -----------------------------------------------------------------------
    // MF-06: DC-07 preserved -- capacity-99 rejects C's join at capacity gate
    // -----------------------------------------------------------------------

    function test_MF06_DC07_CapacityGatePrecedesMinimumFill() public {
        seedGroupFixture();
        vm.prank(supplierA);
        // capacity=99, minimumFill=1: any non-empty commit passes fill;
        // capacity is the binding limit here.
        uint256 off99 = kernel.createOffer(
            supplierA, u(9), 99, 1, block.timestamp + 7 days
        );

        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](3);
        buyers[0] = IBusinessKernel.BuyerTerms(buyerA, accA, 40, u(200), u(160), u(200));
        buyers[1] = IBusinessKernel.BuyerTerms(buyerB, accB, 35, u(150), u(165), u(200));
        buyers[2] = IBusinessKernel.BuyerTerms(buyerC, accC, 25, u(100), u(125), u(200));

        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(off99, 100, supplierA);

        (uint256 p99,) = kernel.draftPlan(IBusinessKernel.PlanTerms({
            kind:          IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers:        buyers,
            saleParty:     IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId:  lenderPool,
            offerRefs:     refs,
            expiry:        block.timestamp + 7 days,
            commercialRef: bytes32("mf06")
        }));
        vm.prank(lender);    kernel.approveLenderPlan(p99, 0, u(160), block.timestamp + 7 days);
        vm.prank(lender);    kernel.approveLenderPlan(p99, 1, u(165), block.timestamp + 7 days);
        vm.prank(lender);    kernel.approveLenderPlan(p99, 2, u(125), block.timestamp + 7 days);
        vm.prank(supplierA); kernel.approveSupplierPlan(p99, 0, 100, block.timestamp + 7 days);

        vm.prank(buyerA); kernel.joinBuyer(p99, 0);
        vm.prank(buyerB); kernel.joinBuyer(p99, 1);

        // A/B holds before C attempts
        (bool jA_pre,, uint256 hA_pre,) = kernel.getBuyerParticipation(p99, 0);
        (bool jB_pre,, uint256 hB_pre,) = kernel.getBuyerParticipation(p99, 1);
        assertTrue(jA_pre && jB_pre, "A and B joined before C attempts");

        // C fails at the CAPACITY gate (75 + 25 = 100 > capacity 99)
        vm.prank(buyerC);
        vm.expectRevert(BK_OfferCapacityExceeded.selector);
        kernel.joinBuyer(p99, 2);

        // A/B holds are intact (DC-07 assertion)
        (bool jA,, uint256 hA,) = kernel.getBuyerParticipation(p99, 0);
        (bool jB,, uint256 hB,) = kernel.getBuyerParticipation(p99, 1);
        assertTrue(jA,       "A still joined after C's capacity failure");
        assertTrue(jB,       "B still joined after C's capacity failure");
        assertEq(hA, hA_pre, "A hold intact after C's capacity failure");
        assertEq(hB, hB_pre, "B hold intact after C's capacity failure");

        // offer reserved is 75, not 100
        assertEq(_offerReserved(off99), 75, "offer reserved 75 after C's failure");
    }

    // -----------------------------------------------------------------------
    // MF-07: partial CP plan (75 units) vs fill-100 offer
    // planReadiness must report "Below offer minimum fill".
    // commitPlan must revert BK_BelowMinimumFill.
    // Supplier receives nothing; holds are intact.
    // -----------------------------------------------------------------------

    function test_MF07_PartialCPPlanNotReadyAndCommitBlocked() public {
        seedGroupFixture();
        uint256 exp = block.timestamp + 7 days;

        // capacity 200, minimumFill 100: joins for 75 are valid; commit is not
        vm.prank(supplierA);
        uint256 offerLarge = kernel.createOffer(supplierA, u(9), 200, 100, exp);

        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](2);
        buyers[0] = IBusinessKernel.BuyerTerms(buyerA, accA, 40, u(200), u(160), u(200));
        buyers[1] = IBusinessKernel.BuyerTerms(buyerB, accB, 35, u(150), u(165), u(200));

        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(offerLarge, 75, supplierA);

        (uint256 pid,) = kernel.draftPlan(IBusinessKernel.PlanTerms({
            kind:          IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers:        buyers,
            saleParty:     IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId:  lenderPool,
            offerRefs:     refs,
            expiry:        exp,
            commercialRef: bytes32("mf07")
        }));
        vm.prank(lender);    kernel.approveLenderPlan(pid, 0, u(160), exp);
        vm.prank(lender);    kernel.approveLenderPlan(pid, 1, u(165), exp);
        vm.prank(supplierA); kernel.approveSupplierPlan(pid, 0, 75, exp);

        vm.prank(buyerA); kernel.joinBuyer(pid, 0);
        vm.prank(buyerB); kernel.joinBuyer(pid, 1);

        // planReadiness must report the minimum-fill blocker (not ready)
        (bool rdy, string memory reason) = kernel.planReadiness(pid);
        assertFalse(rdy, "partial plan must not be ready");
        assertEq(reason, "Below offer minimum fill", "wrong readiness reason");

        // commitPlan must revert with BK_BelowMinimumFill
        vm.expectRevert(BK_BelowMinimumFill.selector);
        kernel.commitPlan(pid);

        // Supplier received nothing
        assertEq(tok.balanceOf(supplierA), 0, "supplier received nothing after failed commit");

        // Holds are intact
        (bool jA,, uint256 hA,) = kernel.getBuyerParticipation(pid, 0);
        (bool jB,, uint256 hB,) = kernel.getBuyerParticipation(pid, 1);
        assertTrue(jA,         "A still joined");
        assertTrue(jB,         "B still joined");
        assertEq(hA, u(200),   "A cash hold intact");
        assertEq(hB, u(150),   "B cash hold intact");
    }

    // -----------------------------------------------------------------------
    // CO helpers -- avoid stack-too-deep by extracting setup into sub-functions
    // -----------------------------------------------------------------------

    struct COFixture {
        MockERC20      tok;
        BusinessKernel k;
        uint256        pool;
        uint256        accM;
    }

    /// Deploy a fresh kernel, fund lender and merchant, set floor and limit.
    function _deployCO(
        address lend, address merch,
        uint256 lenderFund, uint256 merchantFund, uint256 floor, uint256 limit
    ) internal returns (COFixture memory f) {
        f.tok  = new MockERC20();
        f.k    = new BusinessKernel(address(f.tok), lend);
        f.pool = f.k.POOL_ID();
        vm.prank(merch); f.accM = f.k.openAccount();

        f.tok.mint(lend,  lenderFund);
        f.tok.mint(merch, merchantFund);
        vm.prank(lend);  f.tok.approve(address(f.k), lenderFund);
        vm.prank(merch); f.tok.approve(address(f.k), merchantFund);
        vm.prank(lend);  f.k.depositPool(f.pool, lenderFund);
        vm.prank(merch); f.k.depositCash(f.accM, merchantFund);
        vm.prank(merch); f.k.setProtectedFloor(f.accM, floor);
        vm.prank(lend);  f.k.setBorrowerLimit(f.pool, f.accM, limit);
    }

    struct COPlanParams {
        address lend; address merch; address cust;
        address supG; address supF;
        uint256 offG; uint256 offF;
        uint256 goodsQty; uint256 freightQty;
        uint256 escrow; uint256 credit; uint256 saleValue;
        bytes32 ref;
    }

    function _draftCO(COFixture memory f, COPlanParams memory p)
        internal returns (uint256 pid)
    {
        IBusinessKernel.BuyerTerms[] memory emptyB = new IBusinessKernel.BuyerTerms[](0);
        IBusinessKernel.OfferRef[]   memory refs   = new IBusinessKernel.OfferRef[](2);
        refs[0] = IBusinessKernel.OfferRef(p.offG, p.goodsQty,   p.supG);
        refs[1] = IBusinessKernel.OfferRef(p.offF, p.freightQty, p.supF);
        IBusinessKernel.SalePartyTerms memory sp = IBusinessKernel.SalePartyTerms({
            merchantOwner:     p.merch,
            merchantAccountId: f.accM,
            merchantCash:      0,
            creditDraw:        p.credit,
            creditLimit:       u(2000),
            customerAddress:   p.cust,
            requiredEscrow:    p.escrow,
            saleValue:         p.saleValue
        });
        (pid,) = f.k.draftPlan(IBusinessKernel.PlanTerms({
            kind:          IBusinessKernel.WorkflowKind.CustomerOrder,
            buyers:        emptyB,
            saleParty:     sp,
            lenderPoolId:  f.pool,
            offerRefs:     refs,
            expiry:        block.timestamp + 7 days,
            commercialRef: p.ref
        }));
    }

    function _approveFundJoinCO(COFixture memory f, COPlanParams memory p, uint256 pid)
        internal
    {
        uint256 aExp = block.timestamp + 7 days;
        vm.prank(p.lend);  f.k.approveLenderPlan(pid, 0, p.credit, aExp);
        vm.prank(p.supG);  f.k.approveSupplierPlan(pid, 0, p.goodsQty, aExp);
        vm.prank(p.supF);  f.k.approveSupplierPlan(pid, 1, p.freightQty, aExp);
        f.tok.mint(p.cust, p.escrow + u(100));
        vm.prank(p.cust); f.tok.approve(address(f.k), p.escrow);
        vm.prank(p.cust); f.k.fundCustomerEscrow(pid);
        vm.prank(p.merch); f.k.joinMerchant(pid);
    }

    // -----------------------------------------------------------------------
    // MF-08: CO plan -- goods quantity below goods offer minimumFill
    // planReadiness reports "Below goods offer minimum fill".
    // commitPlan reverts BK_BelowMinimumFill.
    // -----------------------------------------------------------------------

    function test_MF08_COBelowGoodsMinimumFill() public {
        address lend8  = makeAddr("lend8");
        address merch8 = makeAddr("merch8");
        address cust8  = makeAddr("cust8");
        address sup8   = makeAddr("sup8");
        address supF8  = makeAddr("supF8");

        COFixture memory f = _deployCO(lend8, merch8, u(2000), u(3000), u(2000), u(2000));
        uint256 exp = block.timestamp + 7 days;

        // Goods offer: capacity 100, minimumFill 100 (price 10)
        // Plan will use 50 goods: below minimumFill 100
        vm.prank(sup8);  uint256 offG8 = f.k.createOffer(sup8,  u(10), 100, 100, exp);
        // Freight offer: capacity 1, minimumFill 1
        vm.prank(supF8); uint256 offF8 = f.k.createOffer(supF8, u(500), 1,    1, exp);

        // 50 goods * u(10) + 1 freight * u(500) = u(1000)
        // escrow u(500), credit u(500), merchantCash 0
        COPlanParams memory p = COPlanParams({
            lend: lend8, merch: merch8, cust: cust8,
            supG: sup8, supF: supF8,
            offG: offG8, offF: offF8,
            goodsQty: 50, freightQty: 1,
            escrow: u(500), credit: u(500), saleValue: u(1000),
            ref: bytes32("mf08")
        });
        uint256 pid = _draftCO(f, p);
        _approveFundJoinCO(f, p, pid);

        (bool rdy, string memory reason) = f.k.planReadiness(pid);
        assertFalse(rdy, "CO below goods minimumFill must not be ready");
        assertEq(reason, "Below goods offer minimum fill", "wrong CO goods readiness reason");

        vm.expectRevert(BK_BelowMinimumFill.selector);
        f.k.commitPlan(pid);

        assertEq(f.tok.balanceOf(sup8),  0, "goods supplier received nothing");
        assertEq(f.tok.balanceOf(supF8), 0, "freight supplier received nothing");
    }

    // -----------------------------------------------------------------------
    // MF-09: CO plan -- freight quantity below freight offer minimumFill
    // planReadiness reports "Below freight offer minimum fill".
    // commitPlan reverts BK_BelowMinimumFill.
    // -----------------------------------------------------------------------

    function test_MF09_COBelowFreightMinimumFill() public {
        address lend9  = makeAddr("lend9");
        address merch9 = makeAddr("merch9");
        address cust9  = makeAddr("cust9");
        address sup9   = makeAddr("sup9");
        address supF9  = makeAddr("supF9");

        COFixture memory f = _deployCO(lend9, merch9, u(2000), u(3000), u(2000), u(2000));
        uint256 exp = block.timestamp + 7 days;

        // Goods offer: capacity 100, minimumFill 1 (not the binding gate)
        vm.prank(sup9);  uint256 offG9 = f.k.createOffer(sup9,  u(10), 100, 1, exp);
        // Freight offer: capacity 5, minimumFill 3; plan will use only 1 unit
        vm.prank(supF9); uint256 offF9 = f.k.createOffer(supF9, u(100), 5,  3, exp);

        // 10 goods * u(10) + 1 freight * u(100) = u(200)
        // escrow u(100), credit u(100), merchantCash 0
        COPlanParams memory p = COPlanParams({
            lend: lend9, merch: merch9, cust: cust9,
            supG: sup9, supF: supF9,
            offG: offG9, offF: offF9,
            goodsQty: 10, freightQty: 1,
            escrow: u(100), credit: u(100), saleValue: u(200),
            ref: bytes32("mf09")
        });
        uint256 pid = _draftCO(f, p);
        _approveFundJoinCO(f, p, pid);

        (bool rdy, string memory reason) = f.k.planReadiness(pid);
        assertFalse(rdy, "CO below freight minimumFill must not be ready");
        assertEq(reason, "Below freight offer minimum fill", "wrong CO freight readiness reason");

        vm.expectRevert(BK_BelowMinimumFill.selector);
        f.k.commitPlan(pid);

        assertEq(f.tok.balanceOf(sup9),  0, "goods supplier received nothing");
        assertEq(f.tok.balanceOf(supF9), 0, "freight supplier received nothing");
    }
}
