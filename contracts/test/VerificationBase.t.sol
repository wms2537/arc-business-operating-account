// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import "./KernelBase.t.sol";

abstract contract VerificationBase is KernelBase {
    function _viewHash(bytes memory data) internal view returns (bytes32) {
        (bool ok,bytes memory result)=address(kernel).staticcall(data);
        require(ok,"verification getter failed");
        return keccak256(result);
    }
    function _planHash(uint256 plan) internal view returns (bytes32 h) {
        if (plan==0) return bytes32(0);
        h=keccak256(abi.encode(_viewHash(abi.encodeCall(kernel.getPlan,(plan))),
            _viewHash(abi.encodeCall(kernel.getEscrow,(plan))),
            _viewHash(abi.encodeCall(kernel.getSalesState,(plan))),
            _viewHash(abi.encodeCall(kernel.getMerchantParticipation,(plan)))));
        (IBusinessKernel.WorkflowKind kind,,,,)=kernel.getPlan(plan);
        if(kind==IBusinessKernel.WorkflowKind.CollectivePurchase) {
            for(uint256 i;i<3;i++) h=keccak256(abi.encode(h,
                _viewHash(abi.encodeCall(kernel.getBuyerParticipation,(plan,i))),
                _viewHash(abi.encodeCall(kernel.getLenderPlanApproval,(plan,i)))));
            h=keccak256(abi.encode(h,_viewHash(abi.encodeCall(kernel.getSupplierPlanApproval,(plan,uint256(0))))));
        } else {
            h=keccak256(abi.encode(h,_viewHash(abi.encodeCall(kernel.getLenderPlanApproval,(plan,uint256(0))))));
            for(uint256 i;i<2;i++) h=keccak256(abi.encode(h,
                _viewHash(abi.encodeCall(kernel.getSupplierPlanApproval,(plan,i)))));
        }
    }
    function _world(uint256 first,uint256 second) internal view returns (bytes32 h) {
        h=keccak256(abi.encode(kernel.totalCustody(),kernel.accountedCustody(),
            _viewHash(abi.encodeCall(kernel.getPool,(lenderPool))),_planHash(first),_planHash(second)));
        for(uint256 i=1;i<=4;i++) {
            h=keccak256(abi.encode(h,_viewHash(abi.encodeCall(kernel.getAccount,(i))),
                _viewHash(abi.encodeCall(kernel.getBorrowerUsage,(lenderPool,i))),
                _viewHash(abi.encodeCall(kernel.getLoan,(i)))));
        }
        for(uint256 i=1;i<=3;i++) h=keccak256(abi.encode(h,_viewHash(abi.encodeCall(kernel.getOffer,(i)))));
        address[9] memory actors=[buyerA,buyerB,buyerC,merchant,lender,customer,supplierA,supplierB,stranger];
        for(uint256 i;i<actors.length;i++) h=keccak256(abi.encode(h,tok.balanceOf(actors[i]),tok.allowance(actors[i],address(kernel))));
    }
    function _deny(address actor,bytes memory data,bytes4 reason,uint256 first,uint256 second) internal {
        bytes32 beforeState=_world(first,second);
        uint256 actorBalance=tok.balanceOf(actor);
        vm.prank(actor); (bool ok,bytes memory result)=address(kernel).call(data);
        assertFalse(ok,"unauthorized command succeeded");
        assertGe(result.length,4,"missing revert selector");
        assertEq(bytes4(result),reason,"wrong failure boundary");
        assertEq(_world(first,second),beforeState,"rejected command changed financial state");
        assertEq(tok.balanceOf(actor),actorBalance);
    }
    function _committedSale() internal returns (uint256 plan) {
        seedSaleFixture(); plan=draftAndApproveFullCOPlan(); fundEscrow(plan);
        vm.prank(merchant); kernel.joinMerchant(plan); kernel.commitPlan(plan);
    }
    function _acceptedSale() internal returns (uint256 plan) {
        plan=_committedSale();
        vm.startPrank(merchant); kernel.acknowledgeGoods(plan); kernel.acknowledgeFreight(plan); vm.stopPrank();
        vm.prank(customer); kernel.acceptSalesOrder(plan);
        vm.prank(customer); tok.approve(address(kernel),u(6000));
    }
    function _physicalTotal() internal view returns (uint256 total) {
        total=tok.balanceOf(address(kernel));
        address[9] memory actors=[buyerA,buyerB,buyerC,merchant,lender,customer,supplierA,supplierB,stranger];
        for(uint256 i;i<actors.length;i++) total+=tok.balanceOf(actors[i]);
    }
}
