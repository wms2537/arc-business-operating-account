// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import "./KernelBase.t.sol";

contract ReadinessFundingRegressionTest is KernelBase {
    function _preparedSale(uint256 draw) internal returns (uint256 plan) {
        seedSaleFixture();
        IBusinessKernel.PlanTerms memory terms=_coTerms(block.timestamp+7 days);
        terms.saleParty.creditDraw=draw;
        (plan,)=kernel.draftPlan(terms);
        approveLenderCO(plan,draw);
        approveSuppliersCO(plan,100,1);
        fundEscrow(plan);
        vm.prank(merchant); kernel.joinMerchant(plan);
    }
    function _state(uint256 plan) internal view returns (bytes32 h) {
        (,uint256 cash,uint256 floor,uint256 held,uint256 active,uint256 debt)=kernel.getAccount(accMerchant);
        h=keccak256(abi.encode(cash,floor,held,active,debt,kernel.totalCustody(),kernel.accountedCustody()));
        (,uint256 poolCash,uint256 reserved)=kernel.getPool(lenderPool);
        (,uint256 escrow,bool refundable,bool withdrawn)=kernel.getEscrow(plan);
        h=keccak256(abi.encode(h,poolCash,reserved,escrow,refundable,withdrawn,
            tok.balanceOf(supplierA),tok.balanceOf(supplierB)));
    }
    function _checkMismatch(uint256 draw) internal {
        uint256 plan=_preparedSale(draw);
        (bool joined,uint256 cashHeld,uint256 creditHeld)=kernel.getMerchantParticipation(plan);
        assertTrue(joined); assertEq(cashHeld,u(1000)); assertEq(creditHeld,draw);
        (,uint256 poolCash,uint256 poolHeld)=kernel.getPool(lenderPool);
        assertEq(poolCash,u(2000)); assertEq(poolHeld,draw);
        (address escrowOwner,uint256 escrow,,)=kernel.getEscrow(plan);
        assertEq(escrowOwner,customer); assertEq(escrow,u(4000));
        bytes32 beforeState=_state(plan);
        (bool ready,)=kernel.planReadiness(plan);
        vm.expectRevert(BK_SourcesNeqPayout.selector);
        kernel.commitPlan(plan);
        assertEq(_state(plan),beforeState,"failed commit moved financial state");
        assertFalse(ready,"Ready disagrees with commit for immutable funding mismatch");
    }
    function test_RF01_OneUnitShortIsNotReady() public { _checkMismatch(u(1500)-1); }
    function test_RF02_OneUnitExcessIsNotReady() public { _checkMismatch(u(1500)+1); }
    function test_RF03_ExactFundingIsReadyAndCommits() public {
        uint256 plan=_preparedSale(u(1500));
        (bool ready,)=kernel.planReadiness(plan); assertTrue(ready);
        kernel.commitPlan(plan);
        assertEq(tok.balanceOf(supplierA),u(6000));
        assertEq(tok.balanceOf(supplierB),u(500));
        assertEq(kernel.totalCustody(),u(2500));
    }
}
