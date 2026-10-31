// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import "../BusinessKernel.sol";
import "../IBusinessKernel.sol";
import "./ReceiptCheck.t.sol"; // reuse ControlledERC20

/**
 * RP / RE / RS / RR — receipt-integrity tests for the four remaining
 * incoming-transfer paths:
 *   RP: depositPool
 *   RE: fundCustomerEscrow
 *   RS: collectSalesBalance
 *   RR: collectReceivable
 *
 * Each path has: (01) honest exact receipt, (02) no-op transferFrom,
 * (03) short-receipt transferFrom.
 * Collection paths (RS, RR) also assert that no ref/debt is consumed on
 * failure, and that a retry with the same ref succeeds.
 *
 * All kernels use ControlledERC20 as the underlying token so the
 * transferFrom mode can be set per-test.
 */
contract ReceiptPathsTest is Test {
    uint256 internal constant D      = 1000;
    uint256 internal constant AMOUNT = 100 * D;

    // ── RP: depositPool ──────────────────────────────────────────────────

    struct PoolFixture {
        ControlledERC20 tok;
        BusinessKernel  kernel;
        address         lender;
    }

    function _poolFixture() internal returns (PoolFixture memory f) {
        f.lender = makeAddr("rp_lender");
        f.tok    = new ControlledERC20();
        f.kernel = new BusinessKernel(address(f.tok), f.lender);
        f.tok.mint(f.lender, AMOUNT);
        vm.prank(f.lender);
        f.tok.approve(address(f.kernel), AMOUNT);
    }

    function test_RP01_DepositPool_Honest() public {
        PoolFixture memory f = _poolFixture();
        uint256 pid = f.kernel.POOL_ID();
        vm.prank(f.lender);
        f.kernel.depositPool(pid, AMOUNT);
        (,uint256 cash,) = f.kernel.getPool(pid);
        assertEq(cash,                               AMOUNT, "RP01: pool.cash");
        assertEq(f.tok.balanceOf(address(f.kernel)), AMOUNT, "RP01: kernel bal");
        assertEq(f.tok.balanceOf(f.lender),          0,      "RP01: lender debited");
    }

    function test_RP02_DepositPool_NoOp() public {
        PoolFixture memory f = _poolFixture();
        bytes32 beforeState = _receiptState(f.tok, f.kernel, f.lender, 0, 0, 0);
        uint256 pid = f.kernel.POOL_ID();
        f.tok.setMode(ControlledERC20.Mode.NoOp, 0);
        uint256 kernelBalBefore = f.tok.balanceOf(address(f.kernel));

        vm.expectRevert(BK_TransferReceiptMismatch.selector);
        vm.prank(f.lender);
        f.kernel.depositPool(pid, AMOUNT);
        assertEq(_receiptState(f.tok, f.kernel, f.lender, 0, 0, 0), beforeState, "all receipt state rolled back");

        (,uint256 poolCash,) = f.kernel.getPool(pid);
        assertEq(poolCash,                           0,               "RP02: pool.cash unchanged");
        assertEq(f.tok.balanceOf(address(f.kernel)), kernelBalBefore, "RP02: kernel bal unchanged");
        assertEq(f.tok.balanceOf(f.lender),          AMOUNT,          "RP02: lender bal unchanged");
    }

    function test_RP03_DepositPool_Short() public {
        PoolFixture memory f = _poolFixture();
        bytes32 beforeState = _receiptState(f.tok, f.kernel, f.lender, 0, 0, 0);
        uint256 pid = f.kernel.POOL_ID();
        f.tok.setMode(ControlledERC20.Mode.Short, 1);
        uint256 kernelBalBefore = f.tok.balanceOf(address(f.kernel));

        vm.expectRevert(BK_TransferReceiptMismatch.selector);
        vm.prank(f.lender);
        f.kernel.depositPool(pid, AMOUNT);
        assertEq(_receiptState(f.tok, f.kernel, f.lender, 0, 0, 0), beforeState, "all receipt state rolled back");

        (,uint256 poolCash,) = f.kernel.getPool(pid);
        assertEq(poolCash,                           0,               "RP03: pool.cash unchanged");
        assertEq(f.tok.balanceOf(address(f.kernel)), kernelBalBefore, "RP03: kernel bal unchanged");
    }

    // ── RE: fundCustomerEscrow ───────────────────────────────────────────

    struct EscrowFixture {
        ControlledERC20 tok;
        BusinessKernel  kernel;
        address         lender;
        address         merch;
        address         customer;
        address         supG;
        address         supF;
        uint256         accM;
        uint256         planId;
        uint256         exp;
        uint256         escrowAmt;
    }

    function _escrowFixture() internal returns (EscrowFixture memory f) {
        f.lender   = makeAddr("re_lend");
        f.merch    = makeAddr("re_merch");
        f.customer = makeAddr("re_cust");
        f.supG     = makeAddr("re_supG");
        f.supF     = makeAddr("re_supF");
        f.tok      = new ControlledERC20();
        f.kernel   = new BusinessKernel(address(f.tok), f.lender);
        uint256 pool = f.kernel.POOL_ID();

        vm.prank(f.merch); f.accM = f.kernel.openAccount();
        f.exp      = block.timestamp + 7 days;
        f.escrowAmt = u(4000);

        // Offers
        vm.prank(f.supG);
        uint256 offG = f.kernel.createOffer(f.supG, u(60), 100, 100, f.exp);
        vm.prank(f.supF);
        uint256 offF = f.kernel.createOffer(f.supF, u(500), 1, 1, f.exp);

        // Fund lender pool
        f.tok.mint(f.lender, u(2000));
        vm.prank(f.lender); f.tok.approve(address(f.kernel), u(2000));
        vm.prank(f.lender); f.kernel.depositPool(pool, u(2000));
        vm.prank(f.lender); f.kernel.setBorrowerLimit(pool, f.accM, u(2000));

        // Fund merchant cash
        f.tok.mint(f.merch, u(3000));
        vm.prank(f.merch); f.tok.approve(address(f.kernel), u(3000));
        vm.prank(f.merch); f.kernel.depositCash(f.accM, u(3000));
        vm.prank(f.merch); f.kernel.setProtectedFloor(f.accM, u(2000));

        // Draft plan
        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](2);
        refs[0] = IBusinessKernel.OfferRef(offG, 100, f.supG);
        refs[1] = IBusinessKernel.OfferRef(offF, 1,   f.supF);
        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](0);
        IBusinessKernel.PlanTerms memory terms = IBusinessKernel.PlanTerms({
            kind:         IBusinessKernel.WorkflowKind.CustomerOrder,
            buyers:       buyers,
            saleParty:    IBusinessKernel.SalePartyTerms({
                merchantOwner:     f.merch,
                merchantAccountId: f.accM,
                merchantCash:      u(1000),
                creditDraw:        u(1500),
                creditLimit:       u(2000),
                customerAddress:   f.customer,
                requiredEscrow:    f.escrowAmt,
                saleValue:         u(10000)
            }),
            lenderPoolId:  pool,
            offerRefs:     refs,
            expiry:        f.exp,
            commercialRef: bytes32("re-plan")
        });
        (f.planId,) = f.kernel.draftPlan(terms);

        // Approve lender and suppliers
        vm.prank(f.lender); f.kernel.approveLenderPlan(f.planId, 0, u(1500), f.exp);
        vm.prank(f.supG);   f.kernel.approveSupplierPlan(f.planId, 0, 100, f.exp);
        vm.prank(f.supF);   f.kernel.approveSupplierPlan(f.planId, 1, 1,   f.exp);

        // Merchant joins
        vm.prank(f.merch); f.kernel.joinMerchant(f.planId);

        // Pre-fund customer with extra so the token has enough even for a Short-mode test.
        f.tok.mint(f.customer, f.escrowAmt * 2);
        vm.prank(f.customer); f.tok.approve(address(f.kernel), f.escrowAmt * 2);
    }

    function u(uint256 x) internal pure returns (uint256) { return x * D; }

    function test_RE01_FundEscrow_Honest() public {
        EscrowFixture memory f = _escrowFixture();
        vm.prank(f.customer);
        f.kernel.fundCustomerEscrow(f.planId);

        (address cust, uint256 amt, bool withdrawable,) = f.kernel.getEscrow(f.planId);
        assertEq(cust,                               f.customer,    "RE01: customer");
        assertEq(amt,                                f.escrowAmt,   "RE01: escrow amount");
        assertEq(withdrawable,                       false,          "RE01: not withdrawable");
        assertEq(f.tok.balanceOf(address(f.kernel)), f.escrowAmt + u(2000) + u(3000), "RE01: kernel bal");
    }

    function test_RE02_FundEscrow_NoOp() public {
        EscrowFixture memory f = _escrowFixture();
        bytes32 beforeState = _receiptState(f.tok, f.kernel, f.customer, f.accM, f.planId, 0);
        f.tok.setMode(ControlledERC20.Mode.NoOp, 0);

        vm.expectRevert(BK_TransferReceiptMismatch.selector);
        vm.prank(f.customer);
        f.kernel.fundCustomerEscrow(f.planId);
        assertEq(_receiptState(f.tok, f.kernel, f.customer, f.accM, f.planId, 0), beforeState, "all receipt state rolled back");

        // Escrow must not be booked.
        (,uint256 amt,,) = f.kernel.getEscrow(f.planId);
        assertEq(amt, 0, "RE02: escrow not funded");
    }

    function test_RE03_FundEscrow_Short() public {
        EscrowFixture memory f = _escrowFixture();
        bytes32 beforeState = _receiptState(f.tok, f.kernel, f.customer, f.accM, f.planId, 0);
        f.tok.setMode(ControlledERC20.Mode.Short, 1);

        vm.expectRevert(BK_TransferReceiptMismatch.selector);
        vm.prank(f.customer);
        f.kernel.fundCustomerEscrow(f.planId);
        assertEq(_receiptState(f.tok, f.kernel, f.customer, f.accM, f.planId, 0), beforeState, "all receipt state rolled back");

        (,uint256 amt,,) = f.kernel.getEscrow(f.planId);
        assertEq(amt, 0, "RE03: escrow not funded");
    }

    // ── RS: collectSalesBalance ─────────────────────────────────────────

    struct SalesFixture {
        ControlledERC20 tok;
        BusinessKernel  kernel;
        address         lender;
        address         merch;
        address         customer;
        address         supG;
        address         supF;
        uint256         accM;
        uint256         planId;
        uint256         saleReceivable;
    }

    function _salesFixture() internal returns (SalesFixture memory f) {
        f.lender   = makeAddr("rs_lend");
        f.merch    = makeAddr("rs_merch");
        f.customer = makeAddr("rs_cust");
        f.supG     = makeAddr("rs_supG");
        f.supF     = makeAddr("rs_supF");
        f.tok      = new ControlledERC20();
        f.kernel   = new BusinessKernel(address(f.tok), f.lender);
        uint256 pool = f.kernel.POOL_ID();

        vm.prank(f.merch); f.accM = f.kernel.openAccount();
        uint256 exp = block.timestamp + 7 days;

        vm.prank(f.supG);
        uint256 offG = f.kernel.createOffer(f.supG, u(60), 100, 100, exp);
        vm.prank(f.supF);
        uint256 offF = f.kernel.createOffer(f.supF, u(500), 1, 1, exp);

        f.tok.mint(f.lender, u(2000));
        vm.prank(f.lender); f.tok.approve(address(f.kernel), u(2000));
        vm.prank(f.lender); f.kernel.depositPool(pool, u(2000));
        vm.prank(f.lender); f.kernel.setBorrowerLimit(pool, f.accM, u(2000));

        f.tok.mint(f.merch, u(3000));
        vm.prank(f.merch); f.tok.approve(address(f.kernel), u(3000));
        vm.prank(f.merch); f.kernel.depositCash(f.accM, u(3000));
        vm.prank(f.merch); f.kernel.setProtectedFloor(f.accM, u(2000));

        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](2);
        refs[0] = IBusinessKernel.OfferRef(offG, 100, f.supG);
        refs[1] = IBusinessKernel.OfferRef(offF, 1,   f.supF);
        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](0);
        IBusinessKernel.PlanTerms memory terms = IBusinessKernel.PlanTerms({
            kind:         IBusinessKernel.WorkflowKind.CustomerOrder,
            buyers:       buyers,
            saleParty:    IBusinessKernel.SalePartyTerms({
                merchantOwner:     f.merch,
                merchantAccountId: f.accM,
                merchantCash:      u(1000),
                creditDraw:        u(1500),
                creditLimit:       u(2000),
                customerAddress:   f.customer,
                requiredEscrow:    u(4000),
                saleValue:         u(10000)
            }),
            lenderPoolId:  pool,
            offerRefs:     refs,
            expiry:        exp,
            commercialRef: bytes32("rs-plan")
        });
        (f.planId,) = f.kernel.draftPlan(terms);

        vm.prank(f.lender); f.kernel.approveLenderPlan(f.planId, 0, u(1500), exp);
        vm.prank(f.supG);   f.kernel.approveSupplierPlan(f.planId, 0, 100, exp);
        vm.prank(f.supF);   f.kernel.approveSupplierPlan(f.planId, 1, 1,   exp);
        vm.prank(f.merch);  f.kernel.joinMerchant(f.planId);

        // Fund escrow (honest mode required here)
        f.tok.mint(f.customer, u(4000));
        vm.prank(f.customer); f.tok.approve(address(f.kernel), u(4000));
        vm.prank(f.customer); f.kernel.fundCustomerEscrow(f.planId);

        // Commit + acknowledge + accept to reach collectSalesBalance
        f.kernel.commitPlan(f.planId);
        vm.prank(f.merch); f.kernel.acknowledgeGoods(f.planId);
        vm.prank(f.merch); f.kernel.acknowledgeFreight(f.planId);
        vm.prank(f.customer); f.kernel.acceptSalesOrder(f.planId);

        (,,, uint256 sr,) = f.kernel.getSalesState(f.planId);
        f.saleReceivable = sr;

        // Pre-fund customer for the collection calls.
        f.tok.mint(f.customer, f.saleReceivable * 2);
        vm.prank(f.customer); f.tok.approve(address(f.kernel), f.saleReceivable * 2);
    }

    function test_RS01_CollectSales_Honest() public {
        SalesFixture memory f = _salesFixture();
        vm.prank(f.customer);
        f.kernel.collectSalesBalance(f.planId, bytes32("rs-pay"), f.saleReceivable);

        (,,, uint256 saleRec, uint256 collected) = f.kernel.getSalesState(f.planId);
        assertEq(collected, saleRec, "RS01: fully collected");
    }

    function test_RS02_CollectSales_NoOp() public {
        SalesFixture memory f = _salesFixture();
        bytes32 beforeState = _receiptState(f.tok, f.kernel, f.customer, f.accM, f.planId, 0);
        f.tok.setMode(ControlledERC20.Mode.NoOp, 0);

        bytes32 ref = bytes32("rs-noop");
        (,,, uint256 srBefore,) = f.kernel.getSalesState(f.planId);

        vm.expectRevert(BK_TransferReceiptMismatch.selector);
        vm.prank(f.customer);
        f.kernel.collectSalesBalance(f.planId, ref, f.saleReceivable);
        assertEq(_receiptState(f.tok, f.kernel, f.customer, f.accM, f.planId, 0), beforeState, "all receipt state rolled back");

        // ref must not be consumed, collected must not increase.
        (,,, uint256 srAfter, uint256 collected) = f.kernel.getSalesState(f.planId);
        assertEq(collected,  0,        "RS02: collected unchanged");
        assertEq(srAfter,    srBefore, "RS02: saleReceivable unchanged");

        // Retry with same ref in Normal mode must succeed.
        f.tok.setMode(ControlledERC20.Mode.Normal, 0);
        vm.prank(f.customer);
        f.kernel.collectSalesBalance(f.planId, ref, f.saleReceivable);
        (,,, , uint256 collectedAfter) = f.kernel.getSalesState(f.planId);
        assertEq(collectedAfter, f.saleReceivable, "RS02: retry with same ref succeeds");
    }

    function test_RS03_CollectSales_Short() public {
        SalesFixture memory f = _salesFixture();
        bytes32 beforeState = _receiptState(f.tok, f.kernel, f.customer, f.accM, f.planId, 0);
        f.tok.setMode(ControlledERC20.Mode.Short, 1);

        bytes32 ref = bytes32("rs-short");

        vm.expectRevert(BK_TransferReceiptMismatch.selector);
        vm.prank(f.customer);
        f.kernel.collectSalesBalance(f.planId, ref, f.saleReceivable);
        assertEq(_receiptState(f.tok, f.kernel, f.customer, f.accM, f.planId, 0), beforeState, "all receipt state rolled back");

        (,,, , uint256 collected) = f.kernel.getSalesState(f.planId);
        assertEq(collected, 0, "RS03: collected unchanged");

        // Retry must succeed.
        f.tok.setMode(ControlledERC20.Mode.Normal, 0);
        vm.prank(f.customer);
        f.kernel.collectSalesBalance(f.planId, ref, f.saleReceivable);
        (,,, , uint256 collectedAfter) = f.kernel.getSalesState(f.planId);
        assertEq(collectedAfter, f.saleReceivable, "RS03: retry with same ref succeeds");
    }

    // ── RR: collectReceivable ─────────────────────────────────────────────

    struct ReceivableFixture {
        ControlledERC20 tok;
        BusinessKernel  kernel;
        address         lender;
        address         benefOwner;
        address         payer;
        uint256         benefAccId;
        uint256         recvId;
    }

    function _recvFixture() internal returns (ReceivableFixture memory f) {
        f.lender     = makeAddr("rr_lend");
        f.benefOwner = makeAddr("rr_benef");
        f.payer      = makeAddr("rr_payer");
        f.tok        = new ControlledERC20();
        f.kernel     = new BusinessKernel(address(f.tok), f.lender);

        vm.prank(f.benefOwner); f.benefAccId = f.kernel.openAccount();

        f.recvId = 999;
        vm.prank(f.benefOwner);
        f.kernel.registerReceivable(f.recvId, f.benefAccId, f.payer, AMOUNT, bytes32("rr-prov"));

        // Fund the payer; allow extra for the Short-mode test.
        f.tok.mint(f.payer, AMOUNT * 2);
        vm.prank(f.payer); f.tok.approve(address(f.kernel), AMOUNT * 2);
    }

    function test_RR01_CollectReceivable_Honest() public {
        ReceivableFixture memory f = _recvFixture();
        vm.prank(f.payer);
        f.kernel.collectReceivable(f.recvId, bytes32("rr-pay"), AMOUNT);

        (, , uint256 openAmt, uint256 remaining, , ,) = f.kernel.getReceivable(f.recvId);
        assertEq(remaining, 0,       "RR01: remaining zero");
        assertEq(openAmt,   AMOUNT,  "RR01: opening unchanged");

        (,uint256 cash,,,,) = f.kernel.getAccount(f.benefAccId);
        assertEq(cash, AMOUNT, "RR01: beneficiary credited");
    }

    function test_RR02_CollectReceivable_NoOp() public {
        ReceivableFixture memory f = _recvFixture();
        bytes32 beforeState = _receiptState(f.tok, f.kernel, f.payer, f.benefAccId, 0, f.recvId);
        f.tok.setMode(ControlledERC20.Mode.NoOp, 0);

        bytes32 ref = bytes32("rr-noop");
        (, , , uint256 remainingBefore, , ,) = f.kernel.getReceivable(f.recvId);

        vm.expectRevert(BK_TransferReceiptMismatch.selector);
        vm.prank(f.payer);
        f.kernel.collectReceivable(f.recvId, ref, AMOUNT);
        assertEq(_receiptState(f.tok, f.kernel, f.payer, f.benefAccId, 0, f.recvId), beforeState, "all receipt state rolled back");

        // ref must not be consumed, remaining must not decrease.
        (, , , uint256 remainingAfter, , ,) = f.kernel.getReceivable(f.recvId);
        assertEq(remainingAfter, remainingBefore, "RR02: remaining unchanged");

        (,uint256 cash,,,,) = f.kernel.getAccount(f.benefAccId);
        assertEq(cash, 0, "RR02: beneficiary not credited");

        // Retry with same ref in Normal mode must succeed.
        f.tok.setMode(ControlledERC20.Mode.Normal, 0);
        vm.prank(f.payer);
        f.kernel.collectReceivable(f.recvId, ref, AMOUNT);
        (,uint256 cashAfter,,,,) = f.kernel.getAccount(f.benefAccId);
        assertEq(cashAfter, AMOUNT, "RR02: retry succeeds");
    }

    function test_RR03_CollectReceivable_Short() public {
        ReceivableFixture memory f = _recvFixture();
        bytes32 beforeState = _receiptState(f.tok, f.kernel, f.payer, f.benefAccId, 0, f.recvId);
        f.tok.setMode(ControlledERC20.Mode.Short, 1);

        bytes32 ref = bytes32("rr-short");

        vm.expectRevert(BK_TransferReceiptMismatch.selector);
        vm.prank(f.payer);
        f.kernel.collectReceivable(f.recvId, ref, AMOUNT);
        assertEq(_receiptState(f.tok, f.kernel, f.payer, f.benefAccId, 0, f.recvId), beforeState, "all receipt state rolled back");

        (, , , uint256 remaining, , ,) = f.kernel.getReceivable(f.recvId);
        assertEq(remaining, AMOUNT, "RR03: remaining unchanged");
        (,uint256 cash,,,,) = f.kernel.getAccount(f.benefAccId);
        assertEq(cash, 0, "RR03: beneficiary not credited");

        // Retry with same ref.
        f.tok.setMode(ControlledERC20.Mode.Normal, 0);
        vm.prank(f.payer);
        f.kernel.collectReceivable(f.recvId, ref, AMOUNT);
        (,uint256 cashAfter,,,,) = f.kernel.getAccount(f.benefAccId);
        assertEq(cashAfter, AMOUNT, "RR03: retry succeeds");
    }

    function _readState(BusinessKernel k, bytes memory data) internal view returns (bytes32) {
        (bool ok, bytes memory result) = address(k).staticcall(data);
        require(ok, "snapshot getter failed");
        return keccak256(result);
    }

    function _receiptState(ControlledERC20 t, BusinessKernel k, address payer,
        uint256 account, uint256 plan, uint256 receivable) internal view returns (bytes32 h) {
        h = keccak256(abi.encode(t.balanceOf(payer), t.balanceOf(address(k)),
            t.allowance(payer,address(k)), k.accountedCustody()));
        h = keccak256(abi.encode(h, _readState(k,abi.encodeCall(k.getAccount,(account))),
            _readState(k,abi.encodeCall(k.getPool,(uint256(1)))),
            _readState(k,abi.encodeCall(k.getBorrowerUsage,(uint256(1),account)))));
        if (plan != 0) {
            h = keccak256(abi.encode(h, _readState(k,abi.encodeCall(k.getPlan,(plan))),
                _readState(k,abi.encodeCall(k.getEscrow,(plan))),
                _readState(k,abi.encodeCall(k.getMerchantParticipation,(plan)))));
            h = keccak256(abi.encode(h, _readState(k,abi.encodeCall(k.getSalesState,(plan))),
                _readState(k,abi.encodeCall(k.getLoan,(uint256(1)))),
                _readState(k,abi.encodeCall(k.getOffer,(uint256(1)))),
                _readState(k,abi.encodeCall(k.getOffer,(uint256(2))))));
        }
        if (receivable != 0) h = keccak256(abi.encode(h,
            _readState(k,abi.encodeCall(k.getReceivable,(receivable)))));
    }

    function test_RP04_DepositPool_Excess() public {
        PoolFixture memory f = _poolFixture();
        f.tok.mint(f.lender,1);
        bytes32 beforeState = _receiptState(f.tok,f.kernel,f.lender,0,0,0);
        f.tok.setMode(ControlledERC20.Mode.Excess,0);
        vm.prank(f.lender); vm.expectRevert(BK_TransferReceiptMismatch.selector);
        f.kernel.depositPool(1,AMOUNT);
        assertEq(_receiptState(f.tok,f.kernel,f.lender,0,0,0),beforeState);
    }
    function test_RE04_FundEscrow_Excess() public {
        EscrowFixture memory f = _escrowFixture();
        bytes32 beforeState = _receiptState(f.tok,f.kernel,f.customer,f.accM,f.planId,0);
        f.tok.setMode(ControlledERC20.Mode.Excess,0);
        vm.prank(f.customer); vm.expectRevert(BK_TransferReceiptMismatch.selector);
        f.kernel.fundCustomerEscrow(f.planId);
        assertEq(_receiptState(f.tok,f.kernel,f.customer,f.accM,f.planId,0),beforeState);
    }
    function test_RS04_CollectSales_ExcessAndSameReferenceRetry() public {
        SalesFixture memory f = _salesFixture();
        bytes32 beforeState = _receiptState(f.tok,f.kernel,f.customer,f.accM,f.planId,0);
        f.tok.setMode(ControlledERC20.Mode.Excess,0);
        vm.prank(f.customer); vm.expectRevert(BK_TransferReceiptMismatch.selector);
        f.kernel.collectSalesBalance(f.planId,bytes32("excess"),f.saleReceivable);
        assertEq(_receiptState(f.tok,f.kernel,f.customer,f.accM,f.planId,0),beforeState);
        f.tok.setMode(ControlledERC20.Mode.Normal,0);
        vm.prank(f.customer);
        f.kernel.collectSalesBalance(f.planId,bytes32("excess"),f.saleReceivable);
        (,,,,uint256 collected) = f.kernel.getSalesState(f.planId);
        assertEq(collected,f.saleReceivable);
        (,,,,,uint256 debt) = f.kernel.getAccount(f.accM);
        assertEq(debt,0);
    }
    function test_RR04_CollectReceivable_ExcessAndSameReferenceRetry() public {
        ReceivableFixture memory f = _recvFixture();
        bytes32 beforeState = _receiptState(f.tok,f.kernel,f.payer,f.benefAccId,0,f.recvId);
        f.tok.setMode(ControlledERC20.Mode.Excess,0);
        vm.prank(f.payer); vm.expectRevert(BK_TransferReceiptMismatch.selector);
        f.kernel.collectReceivable(f.recvId,bytes32("excess"),AMOUNT);
        assertEq(_receiptState(f.tok,f.kernel,f.payer,f.benefAccId,0,f.recvId),beforeState);
        f.tok.setMode(ControlledERC20.Mode.Normal,0);
        vm.prank(f.payer); f.kernel.collectReceivable(f.recvId,bytes32("excess"),AMOUNT);
        (,,,uint256 remaining,,,) = f.kernel.getReceivable(f.recvId);
        assertEq(remaining,0);
        (,uint256 cash,,,,) = f.kernel.getAccount(f.benefAccId);
        assertEq(cash,AMOUNT);
    }

}
