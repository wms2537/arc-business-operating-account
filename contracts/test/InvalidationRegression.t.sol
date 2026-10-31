// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import "./KernelBase.t.sol";

contract InvalidationRegression is KernelBase {
    function assertGroupReleased(uint256 id) internal view {
        (,uint256 cash,,uint256 held,uint256 active,uint256 debt) = kernel.getAccount(accA);
        assertEq(cash, u(300)); assertEq(held, 0); assertEq(active, 0); assertEq(debt, 0);
        (,,uint256 reserved) = kernel.getPool(lenderPool);
        assertEq(reserved, 0);
        (bool joined,,uint256 cashHold,uint256 creditHold) = kernel.getBuyerParticipation(id, 0);
        assertFalse(joined); assertEq(cashHold, 0); assertEq(creditHold, 0);
    }

    function test_offerExpiryReleasesHoldsBeforePlanDeadline() public {
        seedGroupFixture();
        uint256 expiry = block.timestamp + 60;
        vm.prank(supplierA);
        uint256 offer = kernel.createOffer(supplierA, u(9), 100, 100, expiry);
        IBusinessKernel.PlanTerms memory terms = _cpTerms(
            [uint256(40),35,25], [u(200),u(150),u(100)],
            [u(160),u(165),u(125)], [u(200),u(200),u(200)], 100, block.timestamp + 7 days
        );
        terms.offerRefs[0].offerId = offer;
        (uint256 id,) = kernel.draftPlan(terms);
        approveLenderCP(id, [u(160),u(165),u(125)]);
        vm.prank(supplierA); kernel.approveSupplierPlan(id, 0, 100, expiry);
        vm.prank(buyerA); kernel.joinBuyer(id, 0);
        vm.warp(expiry);
        vm.prank(stranger); kernel.releaseExpiredPlan(id);
        assertGroupReleased(id);
        (,IBusinessKernel.PlanStatus status,,,) = kernel.getPlan(id);
        assertEq(uint256(status), uint256(IBusinessKernel.PlanStatus.Expired));
        vm.prank(stranger); vm.expectRevert(); kernel.releaseExpiredPlan(id);
    }

    function test_revokedOfferAllowsPermissionlessCleanup() public {
        seedGroupFixture();
        uint256 id = draftAndApproveFullCPPlan();
        vm.prank(buyerA); kernel.joinBuyer(id, 0);
        vm.prank(supplierA); kernel.revokeOffer(offerGroup);
        vm.prank(stranger); kernel.releaseExpiredPlan(id);
        assertGroupReleased(id);
    }

    function test_revokedPlanApprovalMakesEscrowWithdrawableWithoutRefundTransfer() public {
        seedSaleFixture();
        uint256 id = draftAndApproveFullCOPlan();
        fundEscrow(id);
        vm.prank(merchant); kernel.joinMerchant(id);
        vm.prank(supplierA); kernel.revokeOfferApproval(id, 0);
        vm.prank(stranger); kernel.releaseExpiredPlan(id);
        (,uint256 amount,bool withdrawable,bool withdrawn) = kernel.getEscrow(id);
        assertEq(amount, u(4000)); assertTrue(withdrawable); assertFalse(withdrawn);
        assertEq(tok.balanceOf(address(kernel)), u(9000));
        vm.prank(customer); kernel.withdrawCustomerEscrow(id);
        assertEq(tok.balanceOf(address(kernel)), u(5000));
    }

    function test_strangerCannotReleaseAValidPendingPlan() public {
        seedGroupFixture();
        uint256 id = draftAndApproveFullCPPlan();
        vm.prank(buyerA); kernel.joinBuyer(id, 0);
        vm.prank(stranger); vm.expectRevert(); kernel.releaseExpiredPlan(id);
        (bool joined,,uint256 held,) = kernel.getBuyerParticipation(id, 0);
        assertTrue(joined); assertEq(held, u(200));
    }
}
