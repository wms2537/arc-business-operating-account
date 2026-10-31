// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import "../BusinessKernel.sol";
import "../IBusinessKernel.sol";
import "./KernelBase.t.sol";

/**
 * SP-01 through SP-10: single-pool-per-kernel specification.
 *
 * Invariants:
 *   - Pool is always created at construction with the bound lender as owner.
 *   - Pool ID is always 1 (POOL_ID constant).
 *   - Zero lender address is rejected at construction.
 *   - No runtime pool creation path exists.
 *   - Only the bound lender can manage the pool.
 *   - Pool starts empty (zero cash, zero reserved).
 *   - Plans must reference pool ID 1 when credit is needed.
 *   - Shared-pool contention between CP and CO workflows on the same kernel.
 */
contract SinglePoolTest is Test {
    uint256 internal constant D = 1000;
    function u(uint256 x) internal pure returns (uint256) { return x * D; }

    // ── SP-01: Zero lender rejected at construction ───────────────────────

    function test_SP01_ZeroLenderRejected() public {
        MockERC20 tok = new MockERC20();
        vm.expectRevert(BK_ZeroLender.selector);
        new BusinessKernel(address(tok), address(0));
    }

    // ── SP-02: Zero USDC token rejected at construction ───────────────────

    function test_SP02_ZeroTokenRejected() public {
        address lend = makeAddr("lend");
        vm.expectRevert(BK_ZeroUSDC.selector);
        new BusinessKernel(address(0), lend);
    }

    // ── SP-03: Pool initialized at construction ───────────────────────────
    // Pool ID is 1, owner equals the bound lender, cash = 0, reserved = 0.

    function test_SP03_PoolInitializedAtConstruction() public {
        MockERC20 tok  = new MockERC20();
        address   lend = makeAddr("lend");
        BusinessKernel kernel = new BusinessKernel(address(tok), lend);

        assertEq(kernel.POOL_ID(), 1, "POOL_ID constant is 1");
        assertEq(kernel.lender(),  lend, "lender() returns constructor arg");

        (address owner, uint256 cash, uint256 reserved) = kernel.getPool(1);
        assertEq(owner,    lend, "Pool owner is bound lender");
        assertEq(cash,     0,    "Pool cash starts at zero");
        assertEq(reserved, 0,    "Pool reserved starts at zero");
    }

    // ── SP-04: lender() view returns the immutable lender address ─────────

    function test_SP04_LenderViewIsImmutable() public {
        MockERC20 tok  = new MockERC20();
        address   lend = makeAddr("lend04");
        BusinessKernel kernel = new BusinessKernel(address(tok), lend);
        assertEq(kernel.lender(), lend);
    }

    // ── SP-05: Outsider cannot deposit into the pool ──────────────────────

    function test_SP05_OutsiderCannotDeposit() public {
        MockERC20 tok      = new MockERC20();
        address   lend     = makeAddr("lend05");
        address   outsider = makeAddr("outsider05");
        BusinessKernel kernel = new BusinessKernel(address(tok), lend);

        tok.mint(outsider, u(100));
        vm.prank(outsider); tok.approve(address(kernel), u(100));
        vm.prank(outsider);
        vm.expectRevert(BK_NotPoolOwner.selector);
        kernel.depositPool(1, u(100));
    }

    // ── SP-06: Outsider cannot withdraw from the pool ─────────────────────

    function test_SP06_OutsiderCannotWithdraw() public {
        MockERC20 tok      = new MockERC20();
        address   lend     = makeAddr("lend06");
        address   outsider = makeAddr("outsider06");
        BusinessKernel kernel = new BusinessKernel(address(tok), lend);

        // Fund pool as lender first
        tok.mint(lend, u(200));
        vm.prank(lend); tok.approve(address(kernel), u(200));
        vm.prank(lend); kernel.depositPool(1, u(200));

        vm.prank(outsider);
        vm.expectRevert(BK_NotPoolOwner.selector);
        kernel.withdrawPool(1, outsider, u(100));
    }

    // ── SP-07: Outsider cannot set borrower limits ────────────────────────

    function test_SP07_OutsiderCannotSetBorrowerLimit() public {
        MockERC20 tok      = new MockERC20();
        address   lend     = makeAddr("lend07");
        address   borrower = makeAddr("borrower07");
        address   outsider = makeAddr("outsider07");
        BusinessKernel kernel = new BusinessKernel(address(tok), lend);

        vm.prank(borrower); uint256 accId = kernel.openAccount();

        vm.prank(outsider);
        vm.expectRevert(BK_NotPoolOwner.selector);
        kernel.setBorrowerLimit(1, accId, u(500));
    }

    // ── SP-08: Plan with wrong pool ID (≠1) is rejected ───────────────────

    function test_SP08_WrongPoolIdRejected() public {
        MockERC20 tok  = new MockERC20();
        address   lend = makeAddr("lend08");
        address   bA   = makeAddr("bA08");
        address   sup  = makeAddr("sup08");
        BusinessKernel kernel = new BusinessKernel(address(tok), lend);

        vm.prank(bA); uint256 accA = kernel.openAccount();
        uint256 exp = block.timestamp + 7 days;
        vm.prank(sup); uint256 offId = kernel.createOffer(sup, u(9), 100, 100, exp);

        // unitPrice=u(9), qty=100 → alloc=u(900); ownCash+creditDraw must equal u(900).
        // draftPlan does not check actual account balance, so ownCash=u(800) is valid here.
        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](1);
        buyers[0] = IBusinessKernel.BuyerTerms(bA, accA, 100, u(800), u(100), u(200));

        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(offId, 100, sup);

        IBusinessKernel.PlanTerms memory terms = IBusinessKernel.PlanTerms({
            kind:         IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers:       buyers,
            saleParty:    IBusinessKernel.SalePartyTerms(address(0), 0, 0, 0, 0, address(0), 0, 0),
            lenderPoolId: 2, // wrong: only pool 1 exists
            offerRefs:    refs,
            expiry:       exp,
            commercialRef: bytes32("sp08")
        });

        vm.expectRevert(BK_PoolNotFound.selector);
        kernel.draftPlan(terms);
    }

    // ── SP-09: Lender can deposit, withdraw, and set limits ───────────────
    // Basic sanity that pool operations still function correctly after construction.

    function test_SP09_LenderPoolOperations() public {
        MockERC20 tok  = new MockERC20();
        address   lend = makeAddr("lend09");
        address   bor  = makeAddr("bor09");
        BusinessKernel kernel = new BusinessKernel(address(tok), lend);

        vm.prank(bor); uint256 accId = kernel.openAccount();

        tok.mint(lend, u(500));
        vm.prank(lend); tok.approve(address(kernel), u(500));
        vm.prank(lend); kernel.depositPool(1, u(500));

        (,uint256 cash,) = kernel.getPool(1);
        assertEq(cash, u(500), "Cash recorded after deposit");

        vm.prank(lend); kernel.setBorrowerLimit(1, accId, u(300));
        assertEq(kernel.getBorrowerUsage(1, accId), 0, "Usage starts at zero");

        address recip = makeAddr("recip09");
        vm.prank(lend); kernel.withdrawPool(1, recip, u(200));
        (,uint256 cash2,) = kernel.getPool(1);
        assertEq(cash2, u(300), "Cash decremented after withdrawal");
        assertEq(tok.balanceOf(recip), u(200), "Recipient received tokens");
    }

    // ── SP-10: Shared-pool contention across CP and CO on same kernel ─────
    // Two plans (one CP, one CO) compete for the same pool liquidity.
    // CP joins first; CO join fails due to insufficient liquidity; CP leaves;
    // CO join then succeeds.

    struct SP10State {
        MockERC20      tok;
        BusinessKernel kernel;
        uint256        pool;
        uint256        accA;
        uint256        accM;
        address        lend;
        address        bA;
        address        merch;
        address        cust;
        address        supG;
        address        supF;
        uint256        offG;
        uint256        offCO;
        uint256        offF;
        uint256        exp;
    }

    function _sp10_setup() internal returns (SP10State memory s) {
        s.tok   = new MockERC20();
        s.lend  = makeAddr("sp10lend");
        s.bA    = makeAddr("sp10bA");
        s.merch = makeAddr("sp10merch");
        s.cust  = makeAddr("sp10cust");
        s.supG  = makeAddr("sp10supG");
        s.supF  = makeAddr("sp10supF");

        s.kernel = new BusinessKernel(address(s.tok), s.lend);
        s.pool   = s.kernel.POOL_ID();

        vm.prank(s.bA);    s.accA = s.kernel.openAccount();
        vm.prank(s.merch); s.accM = s.kernel.openAccount();

        s.exp = block.timestamp + 7 days;
        // CP offer: 10 units @ u(30) each → alloc = u(300) per plan.
        // minimumFill=10 so a single buyer taking all 10 units satisfies the fill.
        vm.prank(s.supG); s.offG  = s.kernel.createOffer(s.supG, u(30),  10, 10,  s.exp);
        // CO procurement is 900 + 500 = 1400, backed by 500 cash + 400 credit + 500 escrow.
        vm.prank(s.supG); s.offCO = s.kernel.createOffer(s.supG, u(9),   100, 100, s.exp);
        vm.prank(s.supF); s.offF  = s.kernel.createOffer(s.supF, u(500), 1,   1,   s.exp);

        // Pool: 400 USDC — enough for CP draw(160) or CO draw(400) but not both at once.
        s.tok.mint(s.lend, u(400));
        vm.prank(s.lend); s.tok.approve(address(s.kernel), u(400));
        vm.prank(s.lend); s.kernel.depositPool(s.pool, u(400));

        // Buyer: deposit u(300), floor u(100), free=u(200). ownCash=u(140)+creditDraw=u(160)=u(300)=alloc.
        s.tok.mint(s.bA, u(300));
        vm.prank(s.bA); s.tok.approve(address(s.kernel), u(300));
        vm.prank(s.bA); s.kernel.depositCash(s.accA, u(300));
        vm.prank(s.bA); s.kernel.setProtectedFloor(s.accA, u(100));

        // Merchant: deposit u(1500), floor u(1000). merchantCash=u(500)+creditDraw=u(400)=u(900) needed.
        s.tok.mint(s.merch, u(1500));
        vm.prank(s.merch); s.tok.approve(address(s.kernel), u(1500));
        vm.prank(s.merch); s.kernel.depositCash(s.accM, u(1500));
        vm.prank(s.merch); s.kernel.setProtectedFloor(s.accM, u(1000));

        vm.prank(s.lend); s.kernel.setBorrowerLimit(s.pool, s.accA, u(200));
        vm.prank(s.lend); s.kernel.setBorrowerLimit(s.pool, s.accM, u(400));
    }

    function _sp10_draftCP(SP10State memory s) internal returns (uint256 cpPlan) {
        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](1);
        // qty=10, unitPrice=u(30) → alloc=u(300). ownCash=u(140)+creditDraw=u(160)=u(300). ✓
        buyers[0] = IBusinessKernel.BuyerTerms(s.bA, s.accA, 10, u(140), u(160), u(200));
        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](1);
        refs[0] = IBusinessKernel.OfferRef(s.offG, 10, s.supG); // 10 units total, matching buyer qty
        IBusinessKernel.PlanTerms memory t = IBusinessKernel.PlanTerms({
            kind:         IBusinessKernel.WorkflowKind.CollectivePurchase,
            buyers:       buyers,
            saleParty:    IBusinessKernel.SalePartyTerms(address(0), 0, 0, 0, 0, address(0), 0, 0),
            lenderPoolId: s.pool,
            offerRefs:    refs,
            expiry:       s.exp,
            commercialRef: bytes32("sp10-cp")
        });
        (cpPlan,) = s.kernel.draftPlan(t);
    }

    function _sp10_draftCO(SP10State memory s) internal returns (uint256 coPlan) {
        IBusinessKernel.OfferRef[] memory corefs = new IBusinessKernel.OfferRef[](2);
        corefs[0] = IBusinessKernel.OfferRef(s.offCO, 100, s.supG);
        corefs[1] = IBusinessKernel.OfferRef(s.offF,  1,   s.supF);
        IBusinessKernel.BuyerTerms[] memory nobuyers = new IBusinessKernel.BuyerTerms[](0);
        IBusinessKernel.PlanTerms memory t = IBusinessKernel.PlanTerms({
            kind: IBusinessKernel.WorkflowKind.CustomerOrder,
            buyers: nobuyers,
            saleParty: IBusinessKernel.SalePartyTerms({
                merchantOwner:     s.merch,
                merchantAccountId: s.accM,
                merchantCash:      u(500),
                creditDraw:        u(400),
                creditLimit:       u(400),
                customerAddress:   s.cust,
                requiredEscrow:    u(500),
                saleValue:         u(2000)
            }),
            lenderPoolId: s.pool,
            offerRefs: corefs,
            expiry: s.exp,
            commercialRef: bytes32("sp10-co")
        });
        (coPlan,) = s.kernel.draftPlan(t);
    }

    function test_SP10_SharedPoolContention_CP_CO() public {
        SP10State memory s = _sp10_setup();

        uint256 cpPlan = _sp10_draftCP(s);
        uint256 coPlan = _sp10_draftCO(s);

        // Approve CP (offerRef has 10 units)
        vm.prank(s.lend);  s.kernel.approveLenderPlan(cpPlan, 0, u(160), s.exp);
        vm.prank(s.supG);  s.kernel.approveSupplierPlan(cpPlan, 0, 10, s.exp);

        // Approve CO
        vm.prank(s.lend);  s.kernel.approveLenderPlan(coPlan, 0, u(400), s.exp);
        vm.prank(s.supG);  s.kernel.approveSupplierPlan(coPlan, 0, 100, s.exp);
        vm.prank(s.supF);  s.kernel.approveSupplierPlan(coPlan, 1, 1,   s.exp);

        // Fund CO escrow
        s.tok.mint(s.cust, u(500));
        vm.prank(s.cust); s.tok.approve(address(s.kernel), u(500));
        vm.prank(s.cust); s.kernel.fundCustomerEscrow(coPlan);

        // CP buyer A joins — reserves 160 from pool
        vm.prank(s.bA); s.kernel.joinBuyer(cpPlan, 0);
        (,, uint256 res1) = s.kernel.getPool(s.pool);
        assertEq(res1, u(160), "SP10: CP reserved 160 from pool");

        // CO merchant join must fail: only 240 free, needs 400
        vm.prank(s.merch);
        vm.expectRevert(BK_InsufficientPoolLiquidity.selector);
        s.kernel.joinMerchant(coPlan);

        // CP buyer leaves — releases 160 back
        vm.prank(s.bA); s.kernel.leaveBuyer(cpPlan, 0);
        (,, uint256 res2) = s.kernel.getPool(s.pool);
        assertEq(res2, 0, "SP10: pool fully released after CP leave");

        // Now CO merchant can join
        vm.prank(s.merch); s.kernel.joinMerchant(coPlan);
        (,, uint256 res3) = s.kernel.getPool(s.pool);
        assertEq(res3, u(400), "SP10: CO reserved 400 from pool after CP released");
        (bool ready,) = s.kernel.planReadiness(coPlan);
        assertTrue(ready, "balanced CO plan is ready after contention clears");
        s.kernel.commitPlan(coPlan);
        assertEq(s.tok.balanceOf(s.supG), u(900), "actual goods payment");
        assertEq(s.tok.balanceOf(s.supF), u(500), "actual freight payment");
        assertEq(s.kernel.totalCustody(), u(1300), "remaining backed claims");
        assertEq(s.kernel.accountedCustody(), u(1300));
        (,,,,,uint256 principal) = s.kernel.getAccount(s.accM);
        assertEq(principal,u(400), "commit creates only the reserved principal");

    }

    function test_SP11_LegacyPoolCreationUnavailable() public {
        MockERC20 tok = new MockERC20();
        address lend = makeAddr("sp11lend");
        address outsider = makeAddr("sp11outsider");
        BusinessKernel kernel = new BusinessKernel(address(tok), lend);
        vm.prank(lend);
        (bool lenderSucceeded,) = address(kernel).call(abi.encodeWithSignature("createPool()"));
        vm.prank(outsider);
        (bool outsiderSucceeded,) = address(kernel).call(abi.encodeWithSignature("createPool()"));
        assertFalse(lenderSucceeded, "legacy creation selector removed for lender");
        assertFalse(outsiderSucceeded, "legacy creation selector removed for outsider");
        (address owner,uint256 cash,uint256 reserved) = kernel.getPool(1);
        assertEq(owner,lend); assertEq(cash,0); assertEq(reserved,0);
        (address absent,uint256 otherCash,uint256 otherReserved) = kernel.getPool(2);
        assertEq(absent,address(0)); assertEq(otherCash,0); assertEq(otherReserved,0);
    }

    function test_SP12_LenderCannotOperateAnotherPoolId() public {
        MockERC20 tok = new MockERC20();
        address lend = makeAddr("sp12lend");
        address borrower = makeAddr("sp12borrower");
        BusinessKernel kernel = new BusinessKernel(address(tok), lend);
        vm.prank(borrower); uint256 acc = kernel.openAccount();
        tok.mint(lend,u(500));
        vm.prank(lend); tok.approve(address(kernel),u(500));
        vm.prank(lend); kernel.depositPool(1,u(200));
        vm.prank(lend); vm.expectRevert(BK_NotPoolOwner.selector); kernel.depositPool(2,u(100));
        vm.prank(lend); vm.expectRevert(BK_NotPoolOwner.selector); kernel.withdrawPool(2,lend,u(100));
        vm.prank(lend); vm.expectRevert(BK_NotPoolOwner.selector); kernel.setBorrowerLimit(2,acc,u(100));
        vm.prank(lend); vm.expectRevert(BK_NotPoolOwner.selector); kernel.depositPool(0,u(100));
        (,uint256 cash,uint256 reserved) = kernel.getPool(1);
        assertEq(cash,u(200)); assertEq(reserved,0);
        assertEq(tok.balanceOf(lend),u(300)); assertEq(tok.balanceOf(address(kernel)),u(200));
        (address absent,uint256 otherCash,uint256 otherReserved) = kernel.getPool(2);
        assertEq(absent,address(0)); assertEq(otherCash,0); assertEq(otherReserved,0);
    }
}
