// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import "./VerificationBase.t.sol";

contract ContractSecurityTest is VerificationBase {
    function testFuzz_CV01_AccountAndLenderAuthorization(address actor) public {
        vm.assume(actor!=buyerA && actor!=lender);
        seedGroupFixture();
        _deny(actor,abi.encodeCall(kernel.depositCash,(accA,uint256(1))),BK_NotAccountOwner.selector,0,0);
        _deny(actor,abi.encodeCall(kernel.withdrawCash,(accA,stranger,uint256(1))),BK_NotAccountOwner.selector,0,0);
        _deny(actor,abi.encodeCall(kernel.setProtectedFloor,(accA,uint256(0))),BK_NotAccountOwner.selector,0,0);
        _deny(actor,abi.encodeCall(kernel.recordOpeningCheckpoint,(accA)),BK_NotAccountOwner.selector,0,0);
        _deny(actor,abi.encodeCall(kernel.depositPool,(lenderPool,uint256(1))),BK_NotPoolOwner.selector,0,0);
        _deny(actor,abi.encodeCall(kernel.withdrawPool,(lenderPool,stranger,uint256(1))),BK_NotPoolOwner.selector,0,0);
        _deny(actor,abi.encodeCall(kernel.setBorrowerLimit,(lenderPool,accA,uint256(0))),BK_NotPoolOwner.selector,0,0);
    }

    function test_CV02_ExistingBusinessRolesCannotImpersonateEachOther() public {
        seedGroupFixture(); seedSaleFixture();
        uint256 cp=draftAndApproveFullCPPlan(); uint256 co=draftAndApproveFullCOPlan();
        vm.prank(buyerA); kernel.joinBuyer(cp,0);
        vm.prank(merchant); kernel.joinMerchant(co);
        address[9] memory actors=[buyerA,buyerB,buyerC,merchant,lender,customer,supplierA,supplierB,stranger];
        for(uint256 i;i<actors.length;i++) {
            address actor=actors[i];
            if(actor!=buyerA) {
                _deny(actor,abi.encodeCall(kernel.joinBuyer,(cp,uint256(0))),BK_NotTheNamedBuyer.selector,cp,co);
                _deny(actor,abi.encodeCall(kernel.leaveBuyer,(cp,uint256(0))),BK_NotTheNamedBuyer.selector,cp,co);
            }
            if(actor!=merchant) {
                _deny(actor,abi.encodeCall(kernel.joinMerchant,(co)),BK_NotTheNamedMerchant.selector,cp,co);
                _deny(actor,abi.encodeCall(kernel.leaveMerchant,(co)),BK_NotTheNamedMerchant.selector,cp,co);
            }
            if(actor!=lender) {
                _deny(actor,abi.encodeCall(kernel.approveLenderPlan,(cp,uint256(0),u(160),block.timestamp+7 days)),BK_NotPoolOwner.selector,cp,co);
                _deny(actor,abi.encodeCall(kernel.revokeLenderApproval,(cp,uint256(0))),BK_NotPoolOwner.selector,cp,co);
            }
            if(actor!=supplierA) {
                _deny(actor,abi.encodeCall(kernel.approveSupplierPlan,(cp,uint256(0),uint256(100),block.timestamp+7 days)),BK_NotOfferOwner.selector,cp,co);
                _deny(actor,abi.encodeCall(kernel.revokeOfferApproval,(cp,uint256(0))),BK_NotOfferOwner.selector,cp,co);
                _deny(actor,abi.encodeCall(kernel.revokeOffer,(offerGroup)),BK_NotOfferOwner.selector,cp,co);
            }
            if(actor!=customer) _deny(actor,abi.encodeCall(kernel.fundCustomerEscrow,(co)),BK_NotTheNamedCustomer.selector,cp,co);
        }
        _deny(stranger,abi.encodeCall(kernel.cancelPlan,(cp)),BK_NotAParty.selector,cp,co);
        _deny(stranger,abi.encodeCall(kernel.releaseExpiredPlan,(co)),BK_NotYetExpired.selector,cp,co);
    }

    function testFuzz_CV03_PostCommitAndReceivableAuthorization(address actor) public {
        vm.assume(actor!=merchant && actor!=customer);
        uint256 co=_committedSale();
        _deny(actor,abi.encodeCall(kernel.acknowledgeGoods,(co)),BK_NotMerchantOwner.selector,co,0);
        _deny(actor,abi.encodeCall(kernel.acknowledgeFreight,(co)),BK_NotMerchantOwner.selector,co,0);
        _deny(actor,abi.encodeCall(kernel.acceptSalesOrder,(co)),BK_NotNamedCustomer.selector,co,0);
        _deny(actor,abi.encodeCall(kernel.repayLoan,(uint256(1),uint256(1))),BK_NotBorrowerOwner.selector,co,0);
        _deny(actor,abi.encodeCall(kernel.registerReceivable,(uint256(99),accMerchant,customer,u(100),bytes32("owner"))),BK_NotBeneficiaryOwner.selector,co,0);
        vm.prank(merchant); kernel.registerReceivable(99,accMerchant,customer,u(100),bytes32("owner"));
        _deny(actor,abi.encodeCall(kernel.collectReceivable,(uint256(99),bytes32("payment"),uint256(1))),BK_NotBoundPayer.selector,co,0);
        vm.startPrank(merchant); kernel.acknowledgeGoods(co); kernel.acknowledgeFreight(co); vm.stopPrank();
        vm.prank(customer); kernel.acceptSalesOrder(co);
        _deny(actor,abi.encodeCall(kernel.collectSalesBalance,(co,bytes32("payment"),uint256(1))),BK_NotNamedCustomer.selector,co,0);
    }

    function test_CV04_RefundsRemainBoundToTheirOwnCustomerAndPlan() public {
        seedSaleFixture();
        uint256 first=draftAndApproveFullCOPlan(); fundEscrow(first);
        vm.prank(merchant); kernel.joinMerchant(first);
        address otherCustomer=makeAddr("other-customer");
        IBusinessKernel.PlanTerms memory terms=_coTerms(block.timestamp+7 days);
        terms.saleParty.customerAddress=otherCustomer;
        (uint256 second,)=kernel.draftPlan(terms);
        tok.mint(otherCustomer,u(4000));
        vm.startPrank(otherCustomer); tok.approve(address(kernel),u(4000)); kernel.fundCustomerEscrow(second); vm.stopPrank();
        kernel.cancelPlan(second);
        _deny(customer,abi.encodeCall(kernel.withdrawCustomerEscrow,(second)),BK_NotCustomer.selector,first,second);
        vm.prank(otherCustomer); kernel.withdrawCustomerEscrow(second);
        assertEq(tok.balanceOf(otherCustomer),u(4000));
        (address owner,uint256 amount,,bool withdrawn)=kernel.getEscrow(first);
        assertEq(owner,customer); assertEq(amount,u(4000)); assertFalse(withdrawn);
        (bool ready,)=kernel.planReadiness(first); assertTrue(ready);
        kernel.commitPlan(first);
        assertEq(tok.balanceOf(supplierA),u(6000)); assertEq(tok.balanceOf(supplierB),u(500));
    }

    function test_CV05_ApprovalsCannotBeBorrowedFromAnotherPlan() public {
        seedGroupFixture();
        uint256 approved=draftAndApproveFullCPPlan(); uint256 other=draftFullCPPlan();
        _deny(buyerA,abi.encodeCall(kernel.joinBuyer,(other,uint256(0))),BK_NoLenderPlanApproval.selector,approved,other);
        approveLenderCP(other,[u(160),u(165),u(125)]);
        _deny(buyerA,abi.encodeCall(kernel.joinBuyer,(other,uint256(0))),BK_NoSupplierPlanApproval.selector,approved,other);
        approveSupplierCP(other,100);
        vm.prank(buyerA); kernel.joinBuyer(other,0);
        vm.prank(lender); kernel.setBorrowerLimit(lenderPool,accA,u(400));
        _deny(buyerA,abi.encodeCall(kernel.joinBuyer,(approved,uint256(0))),BK_InsufficientBuyerCash.selector,approved,other);
    }

    function test_CV06_ZeroRecipientsUnsupportedNativeAndArithmeticRollback() public {
        seedGroupFixture(); uint256 cp=draftAndApproveFullCPPlan();
        _deny(buyerA,abi.encodeCall(kernel.withdrawCash,(accA,address(0),uint256(1))),BK_ZeroTo.selector,cp,0);
        _deny(lender,abi.encodeCall(kernel.withdrawPool,(lenderPool,address(0),uint256(1))),BK_ZeroTo.selector,cp,0);
        _deny(supplierA,abi.encodeCall(kernel.createOffer,(address(0),uint256(1),uint256(1),uint256(1),block.timestamp+1)),BK_ZeroPayee.selector,cp,0);
        vm.prank(buyerA); kernel.joinBuyer(cp,0);
        bytes32 beforeState=_world(cp,0);
        vm.prank(buyerA); vm.expectRevert(stdError.arithmeticError);
        kernel.setProtectedFloor(accA,type(uint256).max);
        assertEq(_world(cp,0),beforeState);
        vm.deal(address(this),1);
        (bool nativeOk,)=address(kernel).call{value:1}("");
        assertFalse(nativeOk); assertEq(address(kernel).balance,0);
        (bool arbitraryOk,)=address(kernel).call(hex"deadbeef");
        assertFalse(arbitraryOk); assertEq(_world(cp,0),beforeState);
    }

    function test_CV07_OverflowingGroupPriceCannotCreateAPlanOrHolds() public {
        seedGroupFixture();
        vm.prank(supplierA); uint256 enormous=kernel.createOffer(supplierA,type(uint256).max,100,100,block.timestamp+7 days);
        IBusinessKernel.PlanTerms memory terms=_cpTerms([uint256(40),35,25],[u(200),u(150),u(100)],
            [u(160),u(165),u(125)],[u(200),u(200),u(200)],100,block.timestamp+7 days);
        terms.offerRefs[0].offerId=enormous;
        bytes32 beforeState=_world(0,0);
        vm.expectRevert(stdError.arithmeticError); kernel.draftPlan(terms);
        assertEq(_world(0,0),beforeState);
        assertEq(draftFullCPPlan(),1,"failed draft consumed plan identity");
    }

    function _checkPartialCollection(uint256 first) internal {
        uint256 co=_acceptedSale();
        assertGt(first,0); assertLt(first,u(6000));
        vm.prank(customer); kernel.collectSalesBalance(co,bytes32("first"),first);
        uint256 repaid=first<u(1500)?first:u(1500);
        (,uint256 cash,,,,uint256 debt)=kernel.getAccount(accMerchant);
        (,uint256 poolCash,)=kernel.getPool(lenderPool);
        (,,,,uint256 loanDebt)=kernel.getLoan(1);
        assertEq(cash,u(2000)+first-repaid); assertEq(poolCash,u(500)+repaid);
        assertEq(debt,u(1500)-repaid); assertEq(loanDebt,debt);
        assertEq(kernel.getBorrowerUsage(lenderPool,accMerchant),debt);
        assertEq(kernel.totalCustody(),u(2500)+first); assertEq(kernel.accountedCustody(),kernel.totalCustody());
        assertEq(_physicalTotal(),u(15000));
        _deny(customer,abi.encodeCall(kernel.collectSalesBalance,(co,bytes32("first"),uint256(1))),BK_ReceiptRefAlreadyUsed.selector,co,0);
        vm.prank(customer); kernel.collectSalesBalance(co,bytes32("second"),u(6000)-first);
        (,cash,,,,debt)=kernel.getAccount(accMerchant);
        assertEq(cash,u(6500)); assertEq(debt,0); assertEq(kernel.totalCustody(),u(8500));
        assertEq(kernel.accountedCustody(),kernel.totalCustody()); assertEq(_physicalTotal(),u(15000));
    }
    function testFuzz_CV08_SalesCollectionConservesEveryMicroUnit(uint256 amount) public {
        _checkPartialCollection(bound(amount,1,u(6000)-1));
    }
    function test_CV09_OneMicroUnitCollection() public { _checkPartialCollection(1); }
    function test_CV10_PrincipalBoundaryMinusOne() public { _checkPartialCollection(u(1500)-1); }
    function test_CV11_PrincipalBoundaryPlusOne() public { _checkPartialCollection(u(1500)+1); }

    function _mixedReady() internal returns (uint256 cp,uint256 co) {
        seedGroupFixture(); seedSaleFixture();
        vm.prank(lender); kernel.withdrawPool(lenderPool,lender,u(600)); // funded pool now1900; keep600 external
        cp=draftAndApproveFullCPPlan(); co=draftAndApproveFullCOPlan(); fundEscrow(co);
        vm.prank(merchant); kernel.joinMerchant(co);
        vm.prank(buyerA); kernel.joinBuyer(cp,0);
        vm.prank(buyerB); kernel.joinBuyer(cp,1);
        _deny(buyerC,abi.encodeCall(kernel.joinBuyer,(cp,uint256(2))),BK_InsufficientPoolLiquidity.selector,cp,co);
        vm.startPrank(lender); tok.approve(address(kernel),u(50)); kernel.depositPool(lenderPool,u(50)); vm.stopPrank();
        vm.prank(buyerC); kernel.joinBuyer(cp,2);
        (,uint256 cash,uint256 held)=kernel.getPool(lenderPool);
        assertEq(cash,u(1950)); assertEq(held,cash);
    }
    function _mixedCommitOrder(bool saleFirst) internal {
        (uint256 cp,uint256 co)=_mixedReady(); uint256 total=_physicalTotal();
        kernel.commitPlan(saleFirst?co:cp);
        assertEq(kernel.totalCustody(),kernel.accountedCustody()); assertEq(_physicalTotal(),total);
        (bool otherReady,)=kernel.planReadiness(saleFirst?cp:co); assertTrue(otherReady);
        kernel.commitPlan(saleFirst?cp:co);
        assertEq(tok.balanceOf(supplierA),u(6900)); assertEq(tok.balanceOf(supplierB),u(500));
        (,uint256 cash,uint256 held)=kernel.getPool(lenderPool); assertEq(cash,0); assertEq(held,0);
        uint256 debts; for(uint256 i=1;i<=4;i++) {
            (,,,uint256 heldCash,uint256 active,uint256 debt)=kernel.getAccount(i);
            assertEq(heldCash,0); assertEq(active,0); debts+=debt;
        }
        uint256 loans; for(uint256 i=1;i<=4;i++) { (,,,,uint256 outstanding)=kernel.getLoan(i); loans+=outstanding; }
        assertEq(debts,u(1950)); assertEq(loans,debts);
        assertEq(kernel.totalCustody(),kernel.accountedCustody()); assertEq(_physicalTotal(),total);
    }
    function test_CV12_MixedWorkflowCommitsSaleThenGroup() public { _mixedCommitOrder(true); }
    function test_CV13_MixedWorkflowCommitsGroupThenSale() public { _mixedCommitOrder(false); }

    function _eightBuyerPlan() internal returns (uint256 plan,IBusinessKernel.PlanTerms memory terms) {
        uint256 expiry=block.timestamp+7 days;
        vm.prank(supplierA); uint256 offer=kernel.createOffer(supplierA,1,8,8,expiry);
        terms.kind=IBusinessKernel.WorkflowKind.CollectivePurchase;
        terms.buyers=new IBusinessKernel.BuyerTerms[](8);
        terms.offerRefs=new IBusinessKernel.OfferRef[](1);
        terms.offerRefs[0]=IBusinessKernel.OfferRef(offer,8,supplierA);
        terms.expiry=expiry; terms.lenderPoolId=lenderPool;
        for(uint256 i;i<8;i++) {
            address owner=address(uint160(0x100000+i));
            vm.prank(owner); uint256 account=kernel.openAccount();
            fundAccount(owner,account,1);
            terms.buyers[i]=IBusinessKernel.BuyerTerms(owner,account,1,1,0,0);
        }
        (plan,)=kernel.draftPlan(terms);
        vm.prank(supplierA); kernel.approveSupplierPlan(plan,0,8,expiry);
        for(uint256 i;i<8;i++) { vm.prank(terms.buyers[i].owner); kernel.joinBuyer(plan,i); }
    }
    function test_CV14_MaxParticipantsCommitGasAfterUnrelatedHistory() public {
        (uint256 plan,IBusinessKernel.PlanTerms memory terms)=_eightBuyerPlan();
        for(uint256 i;i<128;i++) kernel.draftPlan(terms);
        vm.cool(address(kernel)); vm.cool(address(tok));
        uint256 beforeGas=gasleft(); kernel.commitPlan(plan); uint256 used=beforeGas-gasleft();
        emit log_named_uint("CV_MAX8_COMMIT_GAS_AFTER_128_DRAFTS",used);
        assertLt(used,2_000_000,"bounded commit gas regression");
        assertEq(tok.balanceOf(supplierA),8); assertEq(kernel.accountedCustody(),0);
    }
    function test_CV15_MaxParticipantsCleanupGasAfterUnrelatedHistory() public {
        (uint256 plan,IBusinessKernel.PlanTerms memory terms)=_eightBuyerPlan();
        for(uint256 i;i<128;i++) kernel.draftPlan(terms);
        vm.warp(terms.expiry); vm.cool(address(kernel));
        uint256 beforeGas=gasleft(); kernel.releaseExpiredPlan(plan); uint256 used=beforeGas-gasleft();
        emit log_named_uint("CV_MAX8_CLEANUP_GAS_AFTER_128_DRAFTS",used);
        assertLt(used,1_500_000,"bounded cleanup gas regression");
        for(uint256 i;i<8;i++) {
            (,uint256 cash,,uint256 held,uint256 active,uint256 debt)=kernel.getAccount(terms.buyers[i].accountId);
            assertEq(cash,1); assertEq(held,0); assertEq(active,0); assertEq(debt,0);
        }
        assertEq(kernel.accountedCustody(),8); assertEq(kernel.totalCustody(),8);
    }
    function test_CV16_NinthParticipantIsRejectedBeforeReservation() public {
        (,IBusinessKernel.PlanTerms memory terms)=_eightBuyerPlan();
        IBusinessKernel.BuyerTerms[] memory tooMany=new IBusinessKernel.BuyerTerms[](9);
        for(uint256 i;i<8;i++) tooMany[i]=terms.buyers[i];
        tooMany[8]=terms.buyers[0]; terms.buyers=tooMany;
        uint256 custody=kernel.totalCustody();
        vm.expectRevert(BK_BadBuyersCount.selector); kernel.draftPlan(terms);
        assertEq(kernel.totalCustody(),custody);
    }

    function test_CV18_DebtKeepsFloorAndFacilityLockedUntilRealRepayment() public {
        uint256 co=_acceptedSale();
        _deny(lender,abi.encodeCall(kernel.setBorrowerLimit,(lenderPool,accMerchant,u(1500)-1)),BK_LimitBelowBookedUsage.selector,co,0);
        vm.prank(lender); kernel.setBorrowerLimit(lenderPool,accMerchant,u(1500));
        _deny(merchant,abi.encodeCall(kernel.setProtectedFloor,(accMerchant,uint256(0))),BK_OutstandingDebt.selector,co,0);
        vm.prank(customer); kernel.collectSalesBalance(co,bytes32("full"),u(6000));
        assertEq(kernel.getBorrowerUsage(lenderPool,accMerchant),0);
        vm.prank(lender); kernel.setBorrowerLimit(lenderPool,accMerchant,0);
        vm.prank(merchant); kernel.setProtectedFloor(accMerchant,0);
        (,uint256 cash,uint256 floor,,uint256 active,uint256 debt)=kernel.getAccount(accMerchant);
        assertEq(cash,u(6500)); assertEq(floor,0); assertEq(active,0); assertEq(debt,0);
        assertEq(_physicalTotal(),u(15000));
    }

    function test_CV19_RepaymentPreservesOtherPlanHoldsAndOtherBorrowers() public {
        seedGroupFixture(); uint256 committed=draftAndApproveFullCPPlan();
        vm.prank(buyerA); kernel.joinBuyer(committed,0);
        vm.prank(buyerB); kernel.joinBuyer(committed,1);
        vm.prank(buyerC); kernel.joinBuyer(committed,2);
        kernel.commitPlan(committed);
        fundAccount(buyerA,accA,u(300)); fundPool(u(160));
        vm.prank(lender); kernel.setBorrowerLimit(lenderPool,accA,u(400));
        vm.prank(supplierA); uint256 nextOffer=kernel.createOffer(supplierA,u(9),100,100,block.timestamp+7 days);
        IBusinessKernel.PlanTerms memory terms=_cpTerms([uint256(40),35,25],[u(200),u(150),u(100)],
            [u(160),u(165),u(125)],[u(200),u(200),u(200)],100,block.timestamp+7 days);
        terms.offerRefs[0].offerId=nextOffer;
        (uint256 pending,)=kernel.draftPlan(terms);
        approveLenderCP(pending,[u(160),u(165),u(125)]); approveSupplierCP(pending,100);
        vm.prank(buyerA); kernel.joinBuyer(pending,0);
        uint256 custody=kernel.totalCustody(); uint256 physical=_physicalTotal();
        bytes32 otherPlan=_planHash(pending);
        _deny(buyerA,abi.encodeCall(kernel.repayLoan,(uint256(1),u(100)+1)),BK_InsufficientAvailableCash.selector,committed,pending);
        vm.prank(buyerA); kernel.repayLoan(1,u(100));
        assertEq(_planHash(pending),otherPlan,"repayment changed another plan's reservations");
        assertEq(kernel.totalCustody(),custody); assertEq(_physicalTotal(),physical);
        (,,,,,uint256 debtB)=kernel.getAccount(accB); assertEq(debtB,u(165));
        (,,,,,uint256 debtC)=kernel.getAccount(accC); assertEq(debtC,u(125));
        assertEq(kernel.getBorrowerUsage(lenderPool,accA),u(220));
        _deny(lender,abi.encodeCall(kernel.setBorrowerLimit,(lenderPool,accA,u(220)-1)),BK_LimitBelowBookedUsage.selector,committed,pending);
        vm.prank(buyerA); kernel.leaveBuyer(pending,0);
        _deny(buyerA,abi.encodeCall(kernel.setProtectedFloor,(accA,uint256(0))),BK_OutstandingDebt.selector,committed,pending);
        vm.prank(buyerA); kernel.repayLoan(1,u(60));
        vm.prank(buyerA); kernel.setProtectedFloor(accA,0);
        assertEq(kernel.getBorrowerUsage(lenderPool,accA),0);
        (,,,,,,uint256 consumed,,)=kernel.getOffer(offerGroup); assertEq(consumed,100,"repayment restored consumed capacity");
        assertEq(kernel.totalCustody(),custody); assertEq(_physicalTotal(),physical);
    }

    function test_CV20_ZeroAmountsAndExcessRepaymentPreserveReferences() public {
        uint256 co=_acceptedSale();
        _deny(customer,abi.encodeCall(kernel.collectSalesBalance,(co,bytes32("zero"),uint256(0))),BK_ZeroAmount.selector,co,0);
        vm.prank(customer); kernel.collectSalesBalance(co,bytes32("zero"),1);
        _deny(merchant,abi.encodeCall(kernel.repayLoan,(uint256(1),uint256(0))),BK_ZeroAmount.selector,co,0);
        _deny(merchant,abi.encodeCall(kernel.repayLoan,(uint256(1),u(1500))),BK_ExceedsOutstanding.selector,co,0);
        _deny(merchant,abi.encodeCall(kernel.depositCash,(accMerchant,uint256(0))),BK_ZeroAmount.selector,co,0);
        _deny(merchant,abi.encodeCall(kernel.withdrawCash,(accMerchant,stranger,uint256(0))),BK_ZeroAmount.selector,co,0);
        _deny(lender,abi.encodeCall(kernel.depositPool,(lenderPool,uint256(0))),BK_ZeroAmount.selector,co,0);
        _deny(lender,abi.encodeCall(kernel.withdrawPool,(lenderPool,stranger,uint256(0))),BK_ZeroAmount.selector,co,0);
        _deny(buyerA,abi.encodeCall(kernel.registerReceivable,(uint256(99),accA,customer,uint256(0),bytes32("opening"))),BK_ZeroAmount.selector,co,0);
        vm.prank(buyerA); kernel.registerReceivable(99,accA,customer,1,bytes32("opening"));
        _deny(customer,abi.encodeCall(kernel.collectReceivable,(uint256(99),bytes32("zero"),uint256(0))),BK_ZeroAmount.selector,co,0);
        vm.prank(customer); kernel.collectReceivable(99,bytes32("zero"),1);
        (,uint256 cash,,,,)=kernel.getAccount(accA); assertEq(cash,1);
        (,,,uint256 remaining,,,)=kernel.getReceivable(99); assertEq(remaining,0);
        assertEq(kernel.accountedCustody(),kernel.totalCustody()); assertEq(_physicalTotal(),u(15000));
    }

    function test_CV21_RegisteredReceiptEventHasExactAttributionAndNoDebtPayment() public {
        seedGroupFixture(); uint256 cp=draftAndApproveFullCPPlan();
        vm.prank(buyerA); kernel.joinBuyer(cp,0);
        vm.prank(buyerB); kernel.joinBuyer(cp,1);
        vm.prank(buyerC); kernel.joinBuyer(cp,2); kernel.commitPlan(cp);
        vm.expectEmit(true,true,true,true,address(kernel));
        emit IBusinessKernel.ReceivableRegistered(99,accA,customer,u(160));
        vm.prank(buyerA); kernel.registerReceivable(99,accA,customer,u(160),bytes32("opening-evidence"));
        tok.mint(customer,u(160)); vm.prank(customer); tok.approve(address(kernel),u(160));
        vm.expectEmit(true,true,false,true,address(kernel));
        emit IBusinessKernel.ReceivableCollected(99,bytes32("payment"),customer,accA,u(160),0);
        vm.prank(customer); kernel.collectReceivable(99,bytes32("payment"),u(160));
        (,uint256 cash,,,,uint256 debt)=kernel.getAccount(accA);
        assertEq(cash,u(260)); assertEq(debt,u(160));
        (,,,,uint256 loanDebt)=kernel.getLoan(1); assertEq(loanDebt,debt);
    }

    function test_CV22_AcceptanceAndSalesEventsDescribeExactEconomicEffects() public {
        uint256 co=_committedSale();
        vm.expectEmit(true,false,false,true,address(kernel));
        emit IBusinessKernel.GoodsAcknowledged(co,100);
        vm.prank(merchant); kernel.acknowledgeGoods(co);
        vm.expectEmit(true,false,false,true,address(kernel));
        emit IBusinessKernel.FreightAcknowledged(co,1);
        vm.prank(merchant); kernel.acknowledgeFreight(co);
        vm.expectEmit(true,false,false,true,address(kernel));
        emit IBusinessKernel.CustomerAccepted(co,u(10000),u(4000),u(6000));
        vm.prank(customer); kernel.acceptSalesOrder(co);
        (,uint256 cash,,,,uint256 debt)=kernel.getAccount(accMerchant);
        assertEq(cash,u(2000)); assertEq(debt,u(1500)); assertEq(kernel.totalCustody(),u(2500));
        vm.prank(customer); tok.approve(address(kernel),u(1600));
        vm.expectEmit(true,false,false,true,address(kernel));
        emit IBusinessKernel.LoanRepaid(1,u(1500),0);
        vm.expectEmit(true,true,false,true,address(kernel));
        emit IBusinessKernel.SalesCollected(co,bytes32("payment"),u(1600),u(1500),u(100));
        vm.prank(customer); kernel.collectSalesBalance(co,bytes32("payment"),u(1600));
        (,cash,,,,debt)=kernel.getAccount(accMerchant);
        assertEq(cash,u(2100)); assertEq(debt,0); assertEq(kernel.totalCustody(),u(4100));
        assertEq(kernel.accountedCustody(),kernel.totalCustody()); assertEq(_physicalTotal(),u(15000));
    }
}


