// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./KernelBase.t.sol";

/**
 * DC-41 and DC-42: same-kernel mixed-workflow contention.
 * Split into sub-functions to avoid stack-too-deep.
 */
contract ContentionTest is Test {
    uint256 internal constant D = 1000;
    function u(uint256 x) internal pure returns (uint256) { return x * D; }

    // ── DC-41 helpers ─────────────────────────────────────────────────────

    struct DC41State {
        MockERC20 tok;
        BusinessKernel k;
        uint256 pool;
        uint256 accM;
        uint256 aA; uint256 aB; uint256 aC;
        address lend; address sup; address supF;
        address merch; address cust;
        address bA; address bB; address bC;
        uint256 offG; uint256 offF; uint256 offC;
        uint256 exp;
    }

    function _dc41_setup() internal returns (DC41State memory s) {
        s.tok = new MockERC20();
        s.lend  = makeAddr("dc41lend");
        s.sup   = makeAddr("dc41sup");
        s.supF  = makeAddr("dc41supF");
        s.merch = makeAddr("dc41merch");
        s.cust  = makeAddr("dc41cust");
        s.bA    = makeAddr("dc41bA");
        s.bB    = makeAddr("dc41bB");
        s.bC    = makeAddr("dc41bC");

        s.k    = new BusinessKernel(address(s.tok), s.lend);
        s.pool = s.k.POOL_ID();
        vm.prank(s.merch); s.accM = s.k.openAccount();
        vm.prank(s.bA);    s.aA   = s.k.openAccount();
        vm.prank(s.bB);    s.aB   = s.k.openAccount();
        vm.prank(s.bC);    s.aC   = s.k.openAccount();

        s.exp = block.timestamp + 7 days;
        vm.prank(s.sup);  s.offG = s.k.createOffer(s.sup,  u(60),  100, 100, s.exp);
        vm.prank(s.supF); s.offF = s.k.createOffer(s.supF, u(500), 1,   1,   s.exp);
        vm.prank(s.sup);  s.offC = s.k.createOffer(s.sup,  u(9),   100, 100, s.exp);
    }

    function _dc41_fund(DC41State memory s) internal {
        // Pool 1900
        s.tok.mint(s.lend, u(1900));
        vm.prank(s.lend); s.tok.approve(address(s.k), u(1900));
        vm.prank(s.lend); s.k.depositPool(s.pool, u(1900));
        vm.prank(s.lend); s.k.setBorrowerLimit(s.pool, s.accM, u(2000));
        vm.prank(s.lend); s.k.setBorrowerLimit(s.pool, s.aA,   u(200));
        vm.prank(s.lend); s.k.setBorrowerLimit(s.pool, s.aB,   u(200));
        vm.prank(s.lend); s.k.setBorrowerLimit(s.pool, s.aC,   u(200));

        // Merchant
        s.tok.mint(s.merch, u(3000));
        vm.prank(s.merch); s.tok.approve(address(s.k), u(3000));
        vm.prank(s.merch); s.k.depositCash(s.accM, u(3000));
        vm.prank(s.merch); s.k.setProtectedFloor(s.accM, u(2000));

        // Buyers
        s.tok.mint(s.bA, u(300));
        vm.prank(s.bA); s.tok.approve(address(s.k), u(300));
        vm.prank(s.bA); s.k.depositCash(s.aA, u(300));
        vm.prank(s.bA); s.k.setProtectedFloor(s.aA, u(100));

        s.tok.mint(s.bB, u(250));
        vm.prank(s.bB); s.tok.approve(address(s.k), u(250));
        vm.prank(s.bB); s.k.depositCash(s.aB, u(250));
        vm.prank(s.bB); s.k.setProtectedFloor(s.aB, u(100));

        s.tok.mint(s.bC, u(200));
        vm.prank(s.bC); s.tok.approve(address(s.k), u(200));
        vm.prank(s.bC); s.k.depositCash(s.aC, u(200));
        vm.prank(s.bC); s.k.setProtectedFloor(s.aC, u(100));
    }

    function _dc41_draftSale(DC41State memory s) internal returns (uint256 salePlan) {
        IBusinessKernel.OfferRef[] memory srefs = new IBusinessKernel.OfferRef[](2);
        srefs[0] = IBusinessKernel.OfferRef(s.offG, 100, s.sup);
        srefs[1] = IBusinessKernel.OfferRef(s.offF, 1, s.supF);
        IBusinessKernel.BuyerTerms[] memory sb = new IBusinessKernel.BuyerTerms[](0);
        (salePlan,) = s.k.draftPlan(IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CustomerOrder, buyers: sb,
            saleParty: IBusinessKernel.SalePartyTerms(
                s.merch, s.accM, u(1000), u(1500), u(2000), s.cust, u(4000), u(10000)
            ),
            lenderPoolId: s.pool, offerRefs: srefs,
            expiry: s.exp, commercialRef: bytes32("s41")
        }));
        vm.prank(s.lend);  s.k.approveLenderPlan(salePlan, 0, u(1500), s.exp);
        vm.prank(s.sup);   s.k.approveSupplierPlan(salePlan, 0, 100, s.exp);
        vm.prank(s.supF);  s.k.approveSupplierPlan(salePlan, 1, 1, s.exp);
    }

    function _dc41_draftGroup(DC41State memory s) internal returns (uint256 groupPlan) {
        IBusinessKernel.BuyerTerms[] memory gb = new IBusinessKernel.BuyerTerms[](3);
        gb[0] = IBusinessKernel.BuyerTerms(s.bA, s.aA, 40, u(200), u(160), u(200));
        gb[1] = IBusinessKernel.BuyerTerms(s.bB, s.aB, 35, u(150), u(165), u(200));
        gb[2] = IBusinessKernel.BuyerTerms(s.bC, s.aC, 25, u(100), u(125), u(200));
        IBusinessKernel.OfferRef[] memory grefs = new IBusinessKernel.OfferRef[](1);
        grefs[0] = IBusinessKernel.OfferRef(s.offC, 100, s.sup);
        (groupPlan,) = s.k.draftPlan(IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CollectivePurchase, buyers: gb,
            saleParty: IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0),
            lenderPoolId: s.pool, offerRefs: grefs,
            expiry: s.exp, commercialRef: bytes32("g41")
        }));
        vm.prank(s.lend);  s.k.approveLenderPlan(groupPlan, 0, u(160), s.exp);
        vm.prank(s.lend);  s.k.approveLenderPlan(groupPlan, 1, u(165), s.exp);
        vm.prank(s.lend);  s.k.approveLenderPlan(groupPlan, 2, u(125), s.exp);
        vm.prank(s.sup);   s.k.approveSupplierPlan(groupPlan, 0, 100, s.exp);
    }

    function test_DC41_SharedPoolContention() public {
        DC41State memory s = _dc41_setup();
        _dc41_fund(s);
        uint256 salePlan  = _dc41_draftSale(s);
        uint256 groupPlan = _dc41_draftGroup(s);

        // Reserve sale (1500)
        s.tok.mint(s.cust, u(4000));
        vm.prank(s.cust); s.tok.approve(address(s.k), u(4000));
        vm.prank(s.cust); s.k.fundCustomerEscrow(salePlan);
        vm.prank(s.merch); s.k.joinMerchant(salePlan);
        (,, uint256 r1) = s.k.getPool(s.pool);
        assertEq(r1, u(1500), "1500 after sale");

        // A joins (160); 240 left
        vm.prank(s.bA); s.k.joinBuyer(groupPlan, 0);
        (,, uint256 r2) = s.k.getPool(s.pool);
        assertEq(r2, u(1660), "1660 after A");

        // B joins (165); 75 left
        vm.prank(s.bB); s.k.joinBuyer(groupPlan, 1);
        (,, uint256 r3) = s.k.getPool(s.pool);
        assertEq(r3, u(1825), "1825 after B");

        // C needs 125, only 75 available
        vm.prank(s.bC);
        vm.expectRevert(BK_InsufficientPoolLiquidity.selector);
        s.k.joinBuyer(groupPlan, 2);

        // Deposit 50 more; C succeeds (also need to raise borrow limit since usage tracks it)
        s.tok.mint(s.lend, u(50));
        vm.prank(s.lend); s.tok.approve(address(s.k), u(50));
        vm.prank(s.lend); s.k.depositPool(s.pool, u(50));

        vm.prank(s.bC); s.k.joinBuyer(groupPlan, 2);
        (,, uint256 r4) = s.k.getPool(s.pool);
        assertEq(r4, u(1950), "1950 reserved total");
    }

    // ── DC-42 ─────────────────────────────────────────────────────────────

    function test_DC42_SharedAccountContention() public {
        MockERC20      t42 = new MockERC20();

        address shared = makeAddr("dc42shared");
        address lend42 = makeAddr("dc42lend");
        address cust42 = makeAddr("dc42cust");

        BusinessKernel k42 = new BusinessKernel(address(t42), lend42);
        uint256 pool42 = k42.POOL_ID();
        vm.prank(shared); uint256 accS   = k42.openAccount();

        _dc42_fundAccounts(t42, k42, shared, lend42, accS, pool42);
        _dc42_createOffers(k42);
        uint256 sp42 = _dc42_draftSalePlan(k42, shared, cust42, accS, pool42);
        uint256 gp42 = _dc42_draftGroupPlan(k42, shared, accS, pool42);

        t42.mint(cust42, u(4000));
        vm.prank(cust42); t42.approve(address(k42), u(4000));
        vm.prank(cust42); k42.fundCustomerEscrow(sp42);
        vm.prank(shared); k42.joinMerchant(sp42);

        vm.prank(shared);
        vm.expectRevert(BK_InsufficientBuyerCash.selector);
        k42.joinBuyer(gp42, 0);

        vm.prank(shared); k42.leaveMerchant(sp42);
        vm.prank(shared); k42.joinBuyer(gp42, 0);
        (bool jG,,,) = k42.getBuyerParticipation(gp42, 0);
        assertTrue(jG, "group join succeeds after release");
    }

    function _dc42_fundAccounts(
        MockERC20 t42, BusinessKernel k42,
        address shared, address lend42,
        uint256 accS, uint256 pool42
    ) internal {
        t42.mint(shared, u(3000));
        vm.prank(shared); t42.approve(address(k42), u(3000));
        vm.prank(shared); k42.depositCash(accS, u(3000));
        vm.prank(shared); k42.setProtectedFloor(accS, u(2000));

        t42.mint(lend42, u(2000));
        vm.prank(lend42); t42.approve(address(k42), u(2000));
        vm.prank(lend42); k42.depositPool(pool42, u(2000));
        vm.prank(lend42); k42.setBorrowerLimit(pool42, accS, u(2000));
    }

    // Stored offer IDs for DC-42 so we can pass them across function boundaries
    uint256 private _dc42og; uint256 private _dc42of; uint256 private _dc42oc;

    function _dc42_createOffers(BusinessKernel k42) internal {
        uint256 exp = block.timestamp + 7 days;
        address sup42  = makeAddr("dc42sup");
        address sup42f = makeAddr("dc42supF");
        address sup42c = makeAddr("dc42supC");
        vm.prank(sup42);  _dc42og = k42.createOffer(sup42,  u(60),  100, 100, exp);
        vm.prank(sup42f); _dc42of = k42.createOffer(sup42f, u(500), 1,   1,   exp);
        vm.prank(sup42c); _dc42oc = k42.createOffer(sup42c, u(9),   100, 100, exp);
    }

    function _dc42_draftSalePlan(
        BusinessKernel k42, address shared, address cust42, uint256 accS, uint256 pool42
    ) internal returns (uint256 sp42) {
        uint256 exp = block.timestamp + 7 days;
        address sup42  = makeAddr("dc42sup");
        address sup42f = makeAddr("dc42supF");
        address lend42 = makeAddr("dc42lend");
        IBusinessKernel.OfferRef[] memory srefs = new IBusinessKernel.OfferRef[](2);
        srefs[0] = IBusinessKernel.OfferRef(_dc42og, 100, sup42);
        srefs[1] = IBusinessKernel.OfferRef(_dc42of, 1,   sup42f);
        IBusinessKernel.BuyerTerms[] memory sb = new IBusinessKernel.BuyerTerms[](0);
        IBusinessKernel.SalePartyTerms memory spt = IBusinessKernel.SalePartyTerms(
            shared, accS, u(1000), u(1500), u(2000), cust42, u(4000), u(10000)
        );
        (sp42,) = k42.draftPlan(IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CustomerOrder, buyers: sb,
            saleParty: spt, lenderPoolId: pool42, offerRefs: srefs,
            expiry: exp, commercialRef: bytes32("sp42")
        }));
        vm.prank(lend42);  k42.approveLenderPlan(sp42, 0, u(1500), exp);
        vm.prank(sup42);   k42.approveSupplierPlan(sp42, 0, 100, exp);
        vm.prank(sup42f);  k42.approveSupplierPlan(sp42, 1, 1, exp);
    }

    function _dc42_draftGroupPlan(
        BusinessKernel k42, address shared, uint256 accS, uint256 pool42
    ) internal returns (uint256 gp42) {
        uint256 exp = block.timestamp + 7 days;
        address sup42c = makeAddr("dc42supC");
        address lend42 = makeAddr("dc42lend");
        IBusinessKernel.BuyerTerms[] memory gb = new IBusinessKernel.BuyerTerms[](1);
        gb[0] = IBusinessKernel.BuyerTerms(shared, accS, 40, u(200), u(160), u(200));
        IBusinessKernel.OfferRef[] memory grefs = new IBusinessKernel.OfferRef[](1);
        grefs[0] = IBusinessKernel.OfferRef(_dc42oc, 40, sup42c);
        IBusinessKernel.SalePartyTerms memory empty = IBusinessKernel.SalePartyTerms(address(0),0,0,0,0,address(0),0,0);
        (gp42,) = k42.draftPlan(IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CollectivePurchase, buyers: gb,
            saleParty: empty, lenderPoolId: pool42, offerRefs: grefs,
            expiry: exp, commercialRef: bytes32("gp42")
        }));
        vm.prank(lend42);  k42.approveLenderPlan(gp42, 0, u(160), exp);
        vm.prank(sup42c);  k42.approveSupplierPlan(gp42, 0, 40, exp);
    }
}
