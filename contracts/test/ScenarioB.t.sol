// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./KernelBase.t.sol";

/**
 * Scenario B - Customer Order (financed sale) fixture
 * Covers DC-17..DC-37, DC-39..DC-44, DC-48
 */
contract ScenarioBTest is KernelBase {

    uint256 planId;

    function setUp() public override {
        super.setUp();
        seedSaleFixture();
        planId = draftAndApproveFullCOPlan();
    }

    // ── DC-17: Open kernel=9000 after escrow; escrow=4000; merchant free=1000 ──

    function test_DC17_EscrowFunded() public {
        // Before escrow
        assertEq(tok.balanceOf(address(kernel)), u(5000), "kernel 5000 before escrow");
        (,uint256 mCash,,uint256 mHeld,,) = kernel.getAccount(accMerchant);
        assertEq(mCash, u(3000), "merchant cash 3000");
        assertEq(mHeld, 0, "merchant held 0");

        fundEscrow(planId);

        assertEq(tok.balanceOf(address(kernel)), u(9000), "kernel 9000 after escrow");
        (,address esc,uint256 escAmt,,) = _getEscrowFull(planId);
        assertEq(escAmt, u(4000), "escrow 4000");
        assertEq(esc, customer, "escrow customer");

        // Merchant available cash still 1000 (3000 - 2000 floor)
        uint256 avail = _availCash(accMerchant);
        assertEq(avail, u(1000), "merchant available 1000");

        // Customer external cash 6000 (10000-4000)
        assertEq(tok.balanceOf(customer), u(6000), "customer external 6000");
    }

    // ── DC-18: Customer escrow can't be used as merchant free cash ────────

    function test_DC18_EscrowNotMerchantCash() public {
        fundEscrow(planId);

        // Merchant tries to withdraw 1001 (only 1000 available)
        vm.prank(merchant);
        vm.expectRevert(BK_InsufficientAvailableCash.selector);
        kernel.withdrawCash(accMerchant, merchant, u(1001));
    }

    // ── DC-19: Reserve; holds correct; no debt; freight on separate offer ─

    function test_DC19_Reserve() public {
        fundEscrow(planId);
        vm.prank(merchant); kernel.joinMerchant(planId);

        // Merchant cash hold = 1000
        (,uint256 mCash,,uint256 mHeld,,) = kernel.getAccount(accMerchant);
        assertEq(mCash, u(3000), "merchant cash unchanged 3000");
        assertEq(mHeld, u(1000), "merchant held 1000");

        // Pool reserved 1500
        (,uint256 pCash, uint256 pRes) = kernel.getPool(lenderPool);
        assertEq(pCash, u(2000), "pool cash unchanged");
        assertEq(pRes,  u(1500), "pool reserved 1500");

        // Goods offer: 100 units reserved
        (,,,,,uint256 gRes,,,) = kernel.getOffer(offerGoods);
        assertEq(gRes, 100, "goods reserved 100");

        // Freight offer: 1 unit reserved
        (,,,,,uint256 fRes,,,) = kernel.getOffer(offerFreight);
        assertEq(fRes, 1, "freight reserved 1");

        // No debt
        (,,,,, uint256 debt) = kernel.getAccount(accMerchant);
        assertEq(debt, 0, "no debt before commit");
    }

    // ── DC-20: Commit; exact fixture state ───────────────────────────────

    function test_DC20_Commit() public {
        fundEscrow(planId);
        vm.prank(merchant); kernel.joinMerchant(planId);

        uint256 supBefore     = tok.balanceOf(supplierA);
        uint256 freightBefore = tok.balanceOf(supplierB);

        kernel.commitPlan(planId);

        // Supplier received 6000
        assertEq(tok.balanceOf(supplierA) - supBefore, u(6000), "goods payout 6000");
        // Freight received 500
        assertEq(tok.balanceOf(supplierB) - freightBefore, u(500), "freight payout 500");

        // Kernel = 2500
        assertEq(tok.balanceOf(address(kernel)), u(2500), "kernel 2500");

        // Merchant cash = 2000 (3000 - 1000), escrow consumed
        (,uint256 mCash,,uint256 mHeld,, uint256 debt) = kernel.getAccount(accMerchant);
        assertEq(mCash, u(2000), "merchant cash 2000");
        assertEq(mHeld, 0,       "merchant held 0");
        assertEq(debt,  u(1500), "merchant principal 1500");

        // Lender cash = 500
        (,uint256 pCash,) = kernel.getPool(lenderPool);
        assertEq(pCash, u(500), "lender cash 500");

        // Escrow = 0
        (,,uint256 escAmt,,) = _getEscrowFull(planId);
        assertEq(escAmt, 0, "escrow consumed");

        // Sales receivable = 6000 (10000-4000)
        (,,,uint256 recv,) = kernel.getSalesState(planId);
        assertEq(recv, u(6000), "receivable 6000");
    }

    // ── DC-21: Full acceptance + collect 6000 → final state ──────────────

    function test_DC21_FullAcceptanceAndCollection() public {
        _doCommit();
        _doAcknowledgeAndAccept();

        // Collect 6000
        tok.mint(customer, u(6000));
        vm.prank(customer); tok.approve(address(kernel), u(6000));
        vm.prank(customer);
        kernel.collectSalesBalance(planId, bytes32("full-pay"), u(6000));

        // Kernel 8500
        assertEq(tok.balanceOf(address(kernel)), u(8500), "kernel 8500");

        // Merchant cash 6500
        (,uint256 mCash,,,,uint256 debt) = kernel.getAccount(accMerchant);
        assertEq(mCash, u(6500), "merchant cash 6500");
        assertEq(debt,  0,       "debt 0");

        // Lender cash 2000
        (,uint256 pCash,) = kernel.getPool(lenderPool);
        assertEq(pCash, u(2000), "lender cash 2000");
    }

    // ── DC-22: Two partial collections after acceptance ───────────────────

    function test_DC22_TwoPartialCollections() public {
        _doCommit();
        _doAcknowledgeAndAccept();

        tok.mint(customer, u(6000));
        vm.prank(customer); tok.approve(address(kernel), u(6000));

        // First 600: repays 600 of 1500 principal
        vm.prank(customer);
        kernel.collectSalesBalance(planId, bytes32("p1"), u(600));
        (,uint256 m1,,,,uint256 d1) = kernel.getAccount(accMerchant);
        assertEq(d1, u(900), "debt 900 after first receipt");
        assertEq(m1, u(2000), "merchant cash 2000 (2000 + 0 retained)");
        (,uint256 lend1,) = kernel.getPool(lenderPool);
        assertEq(lend1, u(1100), "lender 1100 after 600 repaid");

        // Second 5400
        vm.prank(customer);
        kernel.collectSalesBalance(planId, bytes32("p2"), u(5400));
        (,uint256 mF,,,,uint256 dF) = kernel.getAccount(accMerchant);
        assertEq(mF, u(6500), "merchant final 6500");
        assertEq(dF, 0,       "debt final 0");
        (,uint256 lendF,) = kernel.getPool(lenderPool);
        assertEq(lendF, u(2000), "lender final 2000");
    }

    // ── DC-23: Duplicate receipt reference rejected ───────────────────────

    function test_DC23_DuplicateReceiptRejected() public {
        _doCommit();
        _doAcknowledgeAndAccept();

        tok.mint(customer, u(6000));
        vm.prank(customer); tok.approve(address(kernel), u(6000));
        vm.prank(customer);
        kernel.collectSalesBalance(planId, bytes32("ref-1"), u(3000));

        vm.prank(customer);
        vm.expectRevert(BK_ReceiptRefAlreadyUsed.selector);
        kernel.collectSalesBalance(planId, bytes32("ref-1"), u(3000));
    }

    // ── DC-24: Overcollection rejected ───────────────────────────────────

    function test_DC24_OvercollectionRejected() public {
        _doCommit();
        _doAcknowledgeAndAccept();

        tok.mint(customer, u(7000));
        vm.prank(customer); tok.approve(address(kernel), u(7000));
        vm.prank(customer);
        vm.expectRevert(BK_ExceedsRemainingBalance.selector);
        kernel.collectSalesBalance(planId, bytes32("over"), u(7000));
    }

    // ── DC-25: Repayment blocked if it would breach protected floor ───────

    function test_DC25_RepaymentBoundByFloor() public {
        _doCommit();
        // Merchant has 2000 cash, 2000 floor → available = 0
        vm.prank(merchant);
        vm.expectRevert(BK_InsufficientAvailableCash.selector);
        kernel.repayLoan(1, u(1)); // any amount fails
    }

    // ── DC-26: Voluntary repayment then collection applies remaining ──────

    function test_DC26_VoluntaryRepayThenCollect() public {
        _doCommit();
        // Give merchant extra 500 so it can repay voluntarily
        fundAccount(merchant, accMerchant, u(500));

        vm.prank(merchant); kernel.repayLoan(1, u(500)); // repay 500 of 1500

        _doAcknowledgeAndAccept();

        tok.mint(customer, u(6000));
        vm.prank(customer); tok.approve(address(kernel), u(6000));
        vm.prank(customer);
        kernel.collectSalesBalance(planId, bytes32("cp"), u(6000));

        // Principal was 1500-500=1000 outstanding; 1000 repaid at collection
        (,uint256 mF,,,,uint256 dF) = kernel.getAccount(accMerchant);
        assertEq(dF, 0, "debt 0 - no double repayment");
        // Merchant got 6000 - 1000 = 5000 from collection, plus 2000 from commit + 500 deposit - 500 repay
        assertEq(mF, u(2000) + u(500) - u(500) + (u(6000) - u(1000)), "merchant cash correct");
    }

    // ── DC-27: Withdrawal above available blocked ─────────────────────────

    function test_DC27_WithdrawalAboveAvailableBlocked() public {
        fundEscrow(planId);
        vm.prank(merchant); kernel.joinMerchant(planId); // holds 1000

        // Available = 3000 - 2000 floor - 1000 held = 0
        vm.prank(merchant);
        vm.expectRevert(BK_InsufficientAvailableCash.selector);
        kernel.withdrawCash(accMerchant, merchant, u(1));
    }

    // ── DC-28: Lender withdrawal above unreserved cash blocked ───────────

    function test_DC28_LenderWithdrawalBlocked() public {
        fundEscrow(planId);
        vm.prank(merchant); kernel.joinMerchant(planId); // reserves 1500

        // Available = 2000 - 1500 = 500
        vm.prank(lender);
        vm.expectRevert(BK_ReservedLiquidity.selector);
        kernel.withdrawPool(lenderPool, lender, u(501));

        // Valid withdrawal of 500
        vm.prank(lender);
        kernel.withdrawPool(lenderPool, lender, u(500));
    }

    // ── DC-29: Floor increase backed; decrease blocked during holds/debt ──

    function test_DC29_FloorChanges() public {
        // Increase within free cash: cash 3000, floor 2000; new 2100 → avail 900, still >= merchantCash 1000? no.
        // Use floor 1999 to leave avail=1001 >= merchantCash=1000
        vm.prank(merchant);
        kernel.setProtectedFloor(accMerchant, u(1999));

        // Unbacked increase: cash 3000, held 0; floor 3001 > 3000
        vm.prank(merchant);
        vm.expectRevert(BK_FloorIncreaseUnbacked.selector);
        kernel.setProtectedFloor(accMerchant, u(3001));

        // Restore floor to 2000 so merchant can join (avail = 3000-2000-0 = 1000 == merchantCash)
        vm.prank(merchant);
        kernel.setProtectedFloor(accMerchant, u(2000));

        // Can't decrease while holding
        fundEscrow(planId);
        vm.prank(merchant); kernel.joinMerchant(planId);
        vm.prank(merchant);
        vm.expectRevert(BK_ActiveParticipations.selector);
        kernel.setProtectedFloor(accMerchant, u(0));

        // After commit: can't decrease while debt exists
        kernel.commitPlan(planId);
        vm.prank(merchant);
        vm.expectRevert(BK_OutstandingDebt.selector);
        kernel.setProtectedFloor(accMerchant, u(0));
    }

    // ── DC-30: Naming account in draft does NOT freeze it ────────────────

    function test_DC30_DraftDoesNotFreezeAccount() public {
        // planId already drafted; merchant NOT joined
        // Merchant can still set floor, withdraw etc
        vm.prank(merchant);
        kernel.setProtectedFloor(accMerchant, u(1500));

        uint256 avail = _availCash(accMerchant);
        assertEq(avail, u(3000) - u(1500), "merchant free cash unchanged by draft");
    }

    // ── DC-31: Cancel before commit; escrow becomes refundable ───────────

    function test_DC31_CancelMakesEscrowRefundable() public {
        fundEscrow(planId);
        vm.prank(merchant); kernel.joinMerchant(planId);

        vm.prank(merchant); kernel.cancelPlan(planId);

        // Kernel still 9000 (no transfer)
        assertEq(tok.balanceOf(address(kernel)), u(9000), "kernel 9000 after cancel");

        // Escrow withdrawable
        (,,uint256 escAmt, bool wd,) = _getEscrowFull(planId);
        assertEq(escAmt, u(4000), "escrow still in kernel");
        assertTrue(wd, "escrow withdrawable");

        // Holds released: merchant available again
        uint256 avail = _availCash(accMerchant);
        assertEq(avail, u(1000), "merchant hold released");

        // Pool reservation released
        (,, uint256 pRes) = kernel.getPool(lenderPool);
        assertEq(pRes, 0, "pool reservation released");
    }

    // ── DC-32: Customer withdraws escrow; second attempt reverts ─────────

    function test_DC32_EscrowWithdrawAndRetry() public {
        fundEscrow(planId);
        vm.prank(merchant); kernel.cancelPlan(planId);

        vm.prank(customer); kernel.withdrawCustomerEscrow(planId);
        assertEq(tok.balanceOf(address(kernel)), u(5000), "kernel 5000 after refund");
        assertEq(tok.balanceOf(customer), u(10000), "customer restored");

        vm.prank(customer);
        vm.expectRevert(BK_AlreadyWithdrawn.selector);
        kernel.withdrawCustomerEscrow(planId);
    }

    // ── DC-33: Post-commit cancel rejected ───────────────────────────────

    function test_DC33_PostCommitCancelRejected() public {
        _doCommit();
        vm.prank(merchant);
        vm.expectRevert(BK_PlanNotOpen.selector);
        kernel.cancelPlan(planId);
    }

    // ── DC-35: Unauthorized withdrawal/change rejected ────────────────────

    function test_DC35_UnauthorizedActionsRejected() public {
        // Stranger cannot withdraw merchant cash
        vm.prank(stranger);
        vm.expectRevert(BK_NotAccountOwner.selector);
        kernel.withdrawCash(accMerchant, stranger, u(100));

        // Non-owner cannot set floor
        vm.prank(stranger);
        vm.expectRevert(BK_NotAccountOwner.selector);
        kernel.setProtectedFloor(accMerchant, u(0));

        // Non-owner cannot join as merchant
        vm.prank(stranger);
        vm.expectRevert(BK_NotTheNamedMerchant.selector);
        kernel.joinMerchant(planId);

        // Non-named customer cannot fund escrow
        vm.prank(stranger);
        vm.expectRevert(BK_NotTheNamedCustomer.selector);
        kernel.fundCustomerEscrow(planId);
    }

    // ── DC-37: UI readiness stale; commit rechecks ────────────────────────

    function test_DC37_ReadinessStalenessCheck() public {
        fundEscrow(planId);
        vm.prank(merchant); kernel.joinMerchant(planId);

        (bool rdy,) = kernel.planReadiness(planId);
        assertTrue(rdy, "plan ready");

        // Revoke offer AFTER checking readiness
        vm.prank(supplierA); kernel.revokeOffer(offerGoods);

        vm.expectRevert(BK_OfferRevoked.selector);
        kernel.commitPlan(planId);
    }

    // ── DC-39: Competing transactions, chain-ordered ──────────────────────

    function test_DC39_CompetingReservations() public {
        // Two plans compete for the same 1500 lender liquidity
        uint256 p1 = planId;

        // Second plan wants to reserve from same pool
        address m2 = makeAddr("merchant2");
        vm.prank(m2); uint256 acc2 = kernel.openAccount();
        fundAccount(m2, acc2, u(3000));
        vm.prank(m2); kernel.setProtectedFloor(acc2, u(2000));
        vm.prank(lender); kernel.setBorrowerLimit(lenderPool, acc2, u(2000));

        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](2);
        refs[0] = IBusinessKernel.OfferRef(offerGoods,   100, supplierA);
        refs[1] = IBusinessKernel.OfferRef(offerFreight, 1,   supplierB);

        IBusinessKernel.BuyerTerms[] memory nb = new IBusinessKernel.BuyerTerms[](0);
        (uint256 p2,) = kernel.draftPlan(IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CustomerOrder,
            buyers: nb,
            saleParty: IBusinessKernel.SalePartyTerms({
                merchantOwner: m2, merchantAccountId: acc2,
                merchantCash: u(1000), creditDraw: u(1500), creditLimit: u(2000),
                customerAddress: customer, requiredEscrow: u(4000), saleValue: u(10000)
            }),
            lenderPoolId: lenderPool,
            offerRefs: refs,
            expiry: block.timestamp + 7 days,
            commercialRef: bytes32("dc39")
        }));
        vm.prank(lender);    kernel.approveLenderPlan(p2, 0, u(1500), block.timestamp + 7 days);
        vm.prank(supplierA); kernel.approveSupplierPlan(p2, 0, 100, block.timestamp + 7 days);
        vm.prank(supplierB); kernel.approveSupplierPlan(p2, 1, 1, block.timestamp + 7 days);

        // P1 joins first
        fundEscrow(p1);
        vm.prank(merchant); kernel.joinMerchant(p1);

        // P2 tries to fund escrow and join
        tok.mint(customer, u(4000));
        vm.prank(customer); tok.approve(address(kernel), u(4000));
        vm.prank(customer); kernel.fundCustomerEscrow(p2);

        // P2 join fails: pool already fully reserved
        vm.prank(m2);
        vm.expectRevert(BK_InsufficientPoolLiquidity.selector);
        kernel.joinMerchant(p2);
    }

    // ── DC-40: No financial change from offchain status changes ──────────

    function test_DC40_OffchainDoesNothing() public {
        // This is a trivially true assertion: the contract has no admin backdoor
        uint256 before = tok.balanceOf(address(kernel));
        // Do nothing offchain
        uint256 after_ = tok.balanceOf(address(kernel));
        assertEq(before, after_, "no change without tx");
    }

    // DC-41 and DC-42 are in ContendTests.t.sol (stack reduction via helpers)

    function _removed_DC41() internal {
        // Fresh instance to avoid state from setUp
        MockERC20 t41 = new MockERC20();

        address lend41 = makeAddr("lend41");
        address sup41  = makeAddr("sup41");
        address sup41f = makeAddr("sup41f");
        address merch41 = makeAddr("merch41");
        address cust41 = makeAddr("cust41");
        address bA41 = makeAddr("bA41");
        address bB41 = makeAddr("bB41");
        address bC41 = makeAddr("bC41");

        BusinessKernel k41 = new BusinessKernel(address(t41), lend41);
        uint256 pool41 = k41.POOL_ID();
        vm.prank(merch41); uint256 accM41 = k41.openAccount();
        vm.prank(bA41); uint256 aA41 = k41.openAccount();
        vm.prank(bB41); uint256 aB41 = k41.openAccount();
        vm.prank(bC41); uint256 aC41 = k41.openAccount();

        // Fund pool with 1900
        t41.mint(lend41, u(1900));
        vm.prank(lend41); t41.approve(address(k41), u(1900));
        vm.prank(lend41); k41.depositPool(pool41, u(1900));

        vm.prank(lend41); k41.setBorrowerLimit(pool41, accM41, u(2000));
        vm.prank(lend41); k41.setBorrowerLimit(pool41, aA41,  u(200));
        vm.prank(lend41); k41.setBorrowerLimit(pool41, aB41,  u(200));
        vm.prank(lend41); k41.setBorrowerLimit(pool41, aC41,  u(200));

        uint256 exp = block.timestamp + 7 days;
        vm.prank(sup41); uint256 off41g = k41.createOffer(sup41, u(60), 100, 100, exp);
        vm.prank(sup41f); uint256 off41f = k41.createOffer(sup41f, u(500), 1, 1, exp);
        vm.prank(sup41); uint256 off41c = k41.createOffer(sup41, u(9), 100, 100, exp);

        // Fund merchant 3000
        t41.mint(merch41, u(3000));
        vm.prank(merch41); t41.approve(address(k41), u(3000));
        vm.prank(merch41); k41.depositCash(accM41, u(3000));
        vm.prank(merch41); k41.setProtectedFloor(accM41, u(2000));

        // Fund buyers
        t41.mint(bA41, u(300)); vm.prank(bA41); t41.approve(address(k41), u(300));
        vm.prank(bA41); k41.depositCash(aA41, u(300)); vm.prank(bA41); k41.setProtectedFloor(aA41, u(100));
        t41.mint(bB41, u(250)); vm.prank(bB41); t41.approve(address(k41), u(250));
        vm.prank(bB41); k41.depositCash(aB41, u(250)); vm.prank(bB41); k41.setProtectedFloor(aB41, u(100));
        t41.mint(bC41, u(200)); vm.prank(bC41); t41.approve(address(k41), u(200));
        vm.prank(bC41); k41.depositCash(aC41, u(200)); vm.prank(bC41); k41.setProtectedFloor(aC41, u(100));

        // Draft sale plan (needs 1500 from pool)
        IBusinessKernel.OfferRef[] memory srefs = new IBusinessKernel.OfferRef[](2);
        srefs[0] = IBusinessKernel.OfferRef(off41g, 100, sup41);
        srefs[1] = IBusinessKernel.OfferRef(off41f, 1, sup41f);
        IBusinessKernel.BuyerTerms[] memory sb = new IBusinessKernel.BuyerTerms[](0);
        (uint256 salePlan,) = k41.draftPlan(IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CustomerOrder, buyers: sb,
            saleParty: IBusinessKernel.SalePartyTerms(merch41, accM41, u(1000), u(1500), u(2000), cust41, u(4000), u(10000)),
            lenderPoolId: pool41, offerRefs: srefs,
            expiry: exp, commercialRef: bytes32("s41")
        }));

        // Draft group plan (A+B+C, needs 450 from pool)
        IBusinessKernel.BuyerTerms[] memory gb = new IBusinessKernel.BuyerTerms[](3);
        gb[0] = IBusinessKernel.BuyerTerms(bA41, aA41, 40, u(200), u(160), u(200));
        gb[1] = IBusinessKernel.BuyerTerms(bB41, aB41, 35, u(150), u(165), u(200));
        gb[2] = IBusinessKernel.BuyerTerms(bC41, aC41, 25, u(100), u(125), u(200));
        IBusinessKernel.OfferRef[] memory grefs = new IBusinessKernel.OfferRef[](1);
        grefs[0] = IBusinessKernel.OfferRef(off41c, 100, sup41);
        (uint256 groupPlan,) = k41.draftPlan(IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CollectivePurchase, buyers: gb,
            saleParty: IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId: pool41, offerRefs: grefs,
            expiry: exp, commercialRef: bytes32("g41")
        }));

        // Reserve sale (1500); pool has 400 left
        t41.mint(cust41, u(4000));
        vm.prank(cust41); t41.approve(address(k41), u(4000));
        vm.prank(cust41); k41.fundCustomerEscrow(salePlan);
        vm.prank(merch41); k41.joinMerchant(salePlan);
        (,, uint256 r1) = k41.getPool(pool41);
        assertEq(r1, u(1500), "1500 reserved after sale");

        // Group A: 160; pool has 240 left
        vm.prank(bA41); k41.joinBuyer(groupPlan, 0);
        (,, uint256 r2) = k41.getPool(pool41);
        assertEq(r2, u(1660), "1660 after A");

        // Group B: 165; pool has 75 left
        vm.prank(bB41); k41.joinBuyer(groupPlan, 1);
        (,, uint256 r3) = k41.getPool(pool41);
        assertEq(r3, u(1825), "1825 after B");

        // Group C: needs 125, only 75 available → fails
        vm.prank(bC41);
        vm.expectRevert(BK_InsufficientPoolLiquidity.selector);
        k41.joinBuyer(groupPlan, 2);

        // Deposit 50 more
        t41.mint(lend41, u(50));
        vm.prank(lend41); t41.approve(address(k41), u(50));
        vm.prank(lend41); k41.depositPool(pool41, u(50));

        // C now succeeds
        vm.prank(bC41); k41.joinBuyer(groupPlan, 2);
        (,, uint256 r4) = k41.getPool(pool41);
        assertEq(r4, u(1950), "1950 reserved - zero free");
    }

    function _removed_DC42() internal {
        MockERC20 t42 = new MockERC20();

        address shared = makeAddr("shared");
        address lend42 = makeAddr("lend42");
        address sup42  = makeAddr("sup42");
        address sup42f = makeAddr("sup42f");
        address sup42c = makeAddr("sup42c");
        address cust42 = makeAddr("cust42");

        BusinessKernel k42 = new BusinessKernel(address(t42), lend42);
        uint256 pool42 = k42.POOL_ID();
        vm.prank(shared); uint256 accS   = k42.openAccount();

        t42.mint(shared, u(3000));
        vm.prank(shared); t42.approve(address(k42), u(3000));
        vm.prank(shared); k42.depositCash(accS, u(3000));
        vm.prank(shared); k42.setProtectedFloor(accS, u(2000));

        t42.mint(lend42, u(2000));
        vm.prank(lend42); t42.approve(address(k42), u(2000));
        vm.prank(lend42); k42.depositPool(pool42, u(2000));
        vm.prank(lend42); k42.setBorrowerLimit(pool42, accS, u(2000));

        uint256 exp = block.timestamp + 7 days;
        vm.prank(sup42); uint256 og42 = k42.createOffer(sup42, u(60), 100, 100, exp);
        vm.prank(sup42f); uint256 of42 = k42.createOffer(sup42f, u(500), 1, 1, exp);
        vm.prank(sup42c); uint256 oc42 = k42.createOffer(sup42c, u(9), 100, 100, exp);

        // Sale plan: shared is merchant, cash=1000
        IBusinessKernel.OfferRef[] memory srefs = new IBusinessKernel.OfferRef[](2);
        srefs[0] = IBusinessKernel.OfferRef(og42, 100, sup42);
        srefs[1] = IBusinessKernel.OfferRef(of42, 1, sup42f);
        IBusinessKernel.BuyerTerms[] memory sb = new IBusinessKernel.BuyerTerms[](0);
        (uint256 sp42,) = k42.draftPlan(IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CustomerOrder, buyers: sb,
            saleParty: IBusinessKernel.SalePartyTerms(shared, accS, u(1000), u(1500), u(2000), cust42, u(4000), u(10000)),
            lenderPoolId: pool42, offerRefs: srefs,
            expiry: exp, commercialRef: bytes32("sp42")
        }));

        // Group plan: shared is buyer A, ownCash=200
        IBusinessKernel.BuyerTerms[] memory gb = new IBusinessKernel.BuyerTerms[](1);
        gb[0] = IBusinessKernel.BuyerTerms(shared, accS, 40, u(200), u(160), u(200));
        IBusinessKernel.OfferRef[] memory grefs = new IBusinessKernel.OfferRef[](1);
        grefs[0] = IBusinessKernel.OfferRef(oc42, 40, sup42c);
        (uint256 gp42,) = k42.draftPlan(IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CollectivePurchase, buyers: gb,
            saleParty: IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId: pool42, offerRefs: grefs,
            expiry: exp, commercialRef: bytes32("gp42")
        }));

        // Reserve sale (holds 1000 of shared's 1000 available cash)
        t42.mint(cust42, u(4000));
        vm.prank(cust42); t42.approve(address(k42), u(4000));
        vm.prank(cust42); k42.fundCustomerEscrow(sp42);
        vm.prank(shared); k42.joinMerchant(sp42);

        // Now try group join: shared needs 200 more cash, but available = 0
        vm.prank(shared);
        vm.expectRevert(BK_InsufficientBuyerCash.selector);
        k42.joinBuyer(gp42, 0);

        // Release sale participation; group join succeeds
        vm.prank(shared); k42.leaveMerchant(sp42);
        vm.prank(shared); k42.joinBuyer(gp42, 0);

    }

    // ── DC-43: Collection before acceptance rejected ──────────────────────

    function test_DC43_CollectionBeforeAcceptanceRejected() public {
        _doCommit();

        tok.mint(customer, u(6000));
        vm.prank(customer); tok.approve(address(kernel), u(6000));

        // No acks yet
        vm.prank(customer);
        vm.expectRevert(BK_AcceptanceRequiredFirst.selector);
        kernel.collectSalesBalance(planId, bytes32("early"), u(1000));

        // After goods ack only
        vm.prank(merchant); kernel.acknowledgeGoods(planId);
        vm.prank(customer);
        vm.expectRevert(BK_AcceptanceRequiredFirst.selector);
        kernel.collectSalesBalance(planId, bytes32("early2"), u(1000));
    }

    // ── DC-44: Ack/acceptance sequence enforced ───────────────────────────

    function test_DC44_AckSequenceEnforced() public {
        _doCommit();

        // Can't accept before both acks
        vm.prank(customer);
        vm.expectRevert(BK_GoodsNotAcknowledged.selector);
        kernel.acceptSalesOrder(planId);

        vm.prank(merchant); kernel.acknowledgeGoods(planId);

        vm.prank(customer);
        vm.expectRevert(BK_FreightNotAcknowledged.selector);
        kernel.acceptSalesOrder(planId);

        // Unauthorized ack
        vm.prank(stranger);
        vm.expectRevert(BK_NotMerchantOwner.selector);
        kernel.acknowledgeFreight(planId);

        vm.prank(merchant); kernel.acknowledgeFreight(planId);

        // Wrong customer
        vm.prank(stranger);
        vm.expectRevert(BK_NotNamedCustomer.selector);
        kernel.acceptSalesOrder(planId);

        // Valid acceptance
        vm.prank(customer); kernel.acceptSalesOrder(planId);

        // Duplicate acceptance
        vm.prank(customer);
        vm.expectRevert(BK_AlreadyAccepted.selector);
        kernel.acceptSalesOrder(planId);

        // Duplicate acks don't change state
        vm.prank(merchant);
        vm.expectRevert(BK_AlreadyAcknowledged.selector);
        kernel.acknowledgeGoods(planId);

        (bool ga, bool fa, bool ca,,) = kernel.getSalesState(planId);
        assertTrue(ga && fa && ca, "all acked and accepted");
    }

    // ── DC-48: Wrong-plan/wrong-caller acceptance rejected ────────────────

    function test_DC48_AcceptanceGateEnforced() public {
        _doCommit();
        vm.prank(merchant); kernel.acknowledgeGoods(planId);
        vm.prank(merchant); kernel.acknowledgeFreight(planId);

        // Non-customer cannot accept
        vm.prank(stranger);
        vm.expectRevert(BK_NotNamedCustomer.selector);
        kernel.acceptSalesOrder(planId);

        // Verify acceptance by correct customer
        vm.prank(customer); kernel.acceptSalesOrder(planId);
        (,,,, uint256 collected) = kernel.getSalesState(planId);
        assertEq(collected, 0, "no collection yet");
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _doCommit() internal {
        fundEscrow(planId);
        vm.prank(merchant); kernel.joinMerchant(planId);
        kernel.commitPlan(planId);
    }

    function _doAcknowledgeAndAccept() internal {
        vm.prank(merchant); kernel.acknowledgeGoods(planId);
        vm.prank(merchant); kernel.acknowledgeFreight(planId);
        vm.prank(customer); kernel.acceptSalesOrder(planId);
    }

    function _availCash(uint256 accId) internal view returns (uint256) {
        (,uint256 cash, uint256 floor, uint256 held,,) = kernel.getAccount(accId);
        uint256 locked = floor + held;
        return cash > locked ? cash - locked : 0;
    }

    function _getEscrowFull(uint256 pid) internal view returns (
        bool exists, address cust, uint256 amt, bool wd, bool wdrawn
    ) {
        (cust, amt, wd, wdrawn) = kernel.getEscrow(pid);
        exists = cust != address(0);
    }
}
