// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import "./VerificationBase.t.sol";

contract ReservationSequenceTest is VerificationBase {
    uint256 private firstCP;
    uint256 private secondCP;
    uint256 private sale;
    uint256 private initialPhysical;
    uint256[4] private limits;

    function _setupSequence() internal {
        fundAccount(buyerA,accA,u(3000)); fundAccount(buyerB,accB,u(250)); fundAccount(buyerC,accC,u(200));
        fundPool(u(1900)); tok.mint(lender,u(500));
        vm.prank(buyerA); kernel.setProtectedFloor(accA,u(2000));
        vm.prank(buyerB); kernel.setProtectedFloor(accB,u(100));
        vm.prank(buyerC); kernel.setProtectedFloor(accC,u(100));
        limits=[u(2000),u(200),u(200),uint256(0)];
        for(uint256 i;i<3;i++) { vm.prank(lender); kernel.setBorrowerLimit(lenderPool,i+1,limits[i]); }
        firstCP=draftAndApproveFullCPPlan(); secondCP=draftAndApproveFullCPPlan();
        IBusinessKernel.PlanTerms memory terms=_coTerms(block.timestamp+7 days);
        terms.saleParty.merchantOwner=buyerA; terms.saleParty.merchantAccountId=accA;
        (sale,)=kernel.draftPlan(terms);
        approveLenderCO(sale,u(1500)); approveSuppliersCO(sale,100,1); fundEscrow(sale);
        tok.mint(stranger,7); vm.prank(stranger); tok.transfer(address(kernel),7);
        initialPhysical=_physicalTotal();
        // Establish real contention before any random transition.
        vm.prank(buyerA); kernel.joinMerchant(sale);
        _deny(buyerA,abi.encodeCall(kernel.joinBuyer,(firstCP,uint256(0))),BK_InsufficientBuyerCash.selector,firstCP,sale);
        vm.prank(buyerA); kernel.leaveMerchant(sale);
        vm.prank(buyerA); kernel.joinBuyer(firstCP,0);
        _assertInvariants();
    }
    function _snapshot() internal view returns (bytes32) {
        return keccak256(abi.encode(_world(firstCP,sale),_planHash(secondCP)));
    }
    function _assertInvariants() internal {
        uint256[4] memory heldCash;
        uint256[4] memory heldCredit;
        uint256[4] memory active;
        uint256 groupUnits;
        uint256[3] memory own=[u(200),u(150),u(100)];
        uint256[3] memory draws=[u(160),u(165),u(125)];
        uint256[3] memory quantities=[uint256(40),35,25];
        for(uint256 p;p<2;p++) {
            uint256 plan=p==0?firstCP:secondCP;
            for(uint256 i;i<3;i++) {
                (bool joined,,uint256 cash,uint256 credit)=kernel.getBuyerParticipation(plan,i);
                assertEq(cash,joined?own[i]:0); assertEq(credit,joined?draws[i]:0);
                if(joined) { heldCash[i]+=own[i]; heldCredit[i]+=draws[i]; active[i]++; groupUnits+=quantities[i]; }
            }
        }
        (bool saleJoined,uint256 saleCash,uint256 saleCredit)=kernel.getMerchantParticipation(sale);
        assertEq(saleCash,saleJoined?u(1000):0); assertEq(saleCredit,saleJoined?u(1500):0);
        if(saleJoined) { heldCash[0]+=u(1000); heldCredit[0]+=u(1500); active[0]++; }
        uint256 accountCash; uint256 totalCredit;
        for(uint256 i;i<4;i++) {
            accountCash+=_checkAccount(i,heldCash[i],heldCredit[i],active[i]);
            totalCredit+=heldCredit[i];
        }
        (,uint256 poolCash,uint256 poolHeld)=kernel.getPool(lenderPool);
        assertEq(poolHeld,totalCredit); assertGe(poolCash,poolHeld);
        _checkOffer(offerGroup,groupUnits); _checkOffer(offerGoods,saleJoined?100:0); _checkOffer(offerFreight,saleJoined?1:0);
        (,uint256 escrow,,)=kernel.getEscrow(sale);
        assertEq(kernel.accountedCustody(),accountCash+poolCash+escrow);
        assertEq(kernel.totalCustody(),kernel.accountedCustody()+7,"surplus became an attributed claim");
        assertEq(_physicalTotal(),initialPhysical,"physical funds changed");
        for(uint256 i=1;i<=4;i++) { (,,,uint256 original,uint256 outstanding)=kernel.getLoan(i); assertEq(original,0); assertEq(outstanding,0); }
    }
    function _checkAccount(uint256 i,uint256 expectedHeld,uint256 expectedCredit,uint256 expectedActive)
        internal returns (uint256 cash) {
        uint256 floor; uint256 held; uint256 count; uint256 debt;
        (,cash,floor,held,count,debt)=kernel.getAccount(i+1);
        assertGe(cash,floor+held); assertEq(held,expectedHeld); assertEq(count,expectedActive); assertEq(debt,0);
        assertEq(kernel.getBorrowerUsage(lenderPool,i+1),expectedCredit); assertLe(expectedCredit,limits[i]);
    }
    function _checkOffer(uint256 offer,uint256 expected) internal {
        (,,,uint256 capacity,,uint256 held,uint256 consumed,,)=kernel.getOffer(offer);
        assertEq(held,expected); assertEq(consumed,0); assertLe(held+consumed,capacity);
    }
    function _step(uint256 random) internal {
        uint256 op=random%16;
        uint256 plan=(random>>8)%2==0?firstCP:secondCP;
        uint256 index=(random>>16)%3;
        address[3] memory owners=[buyerA,buyerB,buyerC];
        uint256[3] memory draws=[u(160),u(165),u(125)];
        address actor;
        bytes memory command;
        uint256 candidateLimit;
        if(op==0) { actor=owners[index]; command=abi.encodeCall(kernel.joinBuyer,(plan,index)); }
        else if(op==1) { actor=owners[index]; command=abi.encodeCall(kernel.leaveBuyer,(plan,index)); }
        else if(op==2) { actor=lender; command=abi.encodeCall(kernel.revokeLenderApproval,(plan,index)); }
        else if(op==3) { actor=lender; command=abi.encodeCall(kernel.approveLenderPlan,(plan,index,draws[index],block.timestamp+7 days)); }
        else if(op==4) { actor=supplierA; command=abi.encodeCall(kernel.revokeOfferApproval,(plan,uint256(0))); }
        else if(op==5) { actor=supplierA; command=abi.encodeCall(kernel.approveSupplierPlan,(plan,uint256(0),uint256(100),block.timestamp+7 days)); }
        else if(op==6) { actor=buyerA; command=abi.encodeCall(kernel.joinMerchant,(sale)); }
        else if(op==7) { actor=buyerA; command=abi.encodeCall(kernel.leaveMerchant,(sale)); }
        else if(op==8) { actor=lender; command=abi.encodeCall(kernel.revokeLenderApproval,(sale,uint256(0))); }
        else if(op==9) { actor=lender; command=abi.encodeCall(kernel.approveLenderPlan,(sale,uint256(0),u(1500),block.timestamp+7 days)); }
        else if(op==10) {
            actor=owners[index]; command=abi.encodeCall(kernel.withdrawCash,(index+1,actor,(random>>24)%(u(1000)+1)));
        } else if(op==11) {
            actor=owners[index]; uint256 amount=(random>>24)%(tok.balanceOf(actor)+1);
            vm.prank(actor); tok.approve(address(kernel),amount);
            command=abi.encodeCall(kernel.depositCash,(index+1,amount));
        } else if(op==12) { actor=lender; command=abi.encodeCall(kernel.withdrawPool,(lenderPool,lender,(random>>24)%(u(500)+1))); }
        else if(op==13) {
            actor=lender; uint256 amount=(random>>24)%(tok.balanceOf(lender)+1);
            vm.prank(lender); tok.approve(address(kernel),amount);
            command=abi.encodeCall(kernel.depositPool,(lenderPool,amount));
        } else if(op==14) {
            actor=owners[index]; command=abi.encodeCall(kernel.setProtectedFloor,(index+1,(random>>24)%(u(3000)+1)));
        } else {
            actor=lender; candidateLimit=(random>>24)%(u(2000)+1);
            command=abi.encodeCall(kernel.setBorrowerLimit,(lenderPool,index+1,candidateLimit));
        }
        bytes32 beforeState=_snapshot();
        vm.prank(actor); (bool ok,)=address(kernel).call(command);
        if(!ok) assertEq(_snapshot(),beforeState,"failed transition changed state");
        else if(op==15) limits[index]=candidateLimit;
        _assertInvariants();
    }
    function testFuzz_CV17_SharedReservationSequencePreservesInvariants(uint256 seed) public {
        _setupSequence();
        for(uint256 i;i<64;i++) { seed=uint256(keccak256(abi.encode(seed,i))); _step(seed); }
        kernel.cancelPlan(firstCP); _assertInvariants();
        kernel.cancelPlan(secondCP); _assertInvariants();
        kernel.cancelPlan(sale); _assertInvariants();
        vm.prank(customer); kernel.withdrawCustomerEscrow(sale); _assertInvariants();
        for(uint256 i;i<3;i++) {
            address owner=i==0?buyerA:i==1?buyerB:buyerC;
            vm.prank(owner); kernel.setProtectedFloor(i+1,0);
        }
        _assertInvariants();
        _deny(stranger,abi.encodeCall(kernel.releaseExpiredPlan,(sale)),BK_PlanNotOpen.selector,firstCP,sale);
    }
}
