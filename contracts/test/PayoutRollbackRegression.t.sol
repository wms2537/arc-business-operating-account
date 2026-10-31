// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./KernelBase.t.sol";

contract PayoutRollbackRegression is KernelBase {
    function test_failingSecondPayoutRollsBackTheFirstPayoutAndAllClaims() public {
        seedSaleFixture();
        uint256 id = draftAndApproveFullCOPlan();
        tok.mint(customer, u(10000));
        vm.prank(customer); tok.approve(address(kernel), u(4000));
        vm.prank(customer); kernel.fundCustomerEscrow(id);
        vm.prank(merchant); kernel.joinMerchant(id);

        // Goods transfer executes normally. Only the subsequent freight
        // transfer returns false, exercising rollback after money has moved.
        vm.mockCall(
            address(tok),
            abi.encodeWithSelector(tok.transfer.selector, supplierB, u(500)),
            abi.encode(false)
        );
        vm.expectRevert();
        kernel.commitPlan(id);

        assertEq(tok.balanceOf(supplierA), 0, "First payout must roll back");
        assertEq(tok.balanceOf(supplierB), 0);
        assertEq(tok.balanceOf(address(kernel)), u(9000));
        assertEq(kernel.accountedCustody(), u(9000));
        assertPlanStillReserved(id);

        vm.clearMockedCalls();
        kernel.commitPlan(id);
        assertEq(tok.balanceOf(supplierA), u(6000));
        assertEq(tok.balanceOf(supplierB), u(500));
        assertEq(tok.balanceOf(address(kernel)), u(2500));
    }

    function assertPlanStillReserved(uint256 id) internal view {
        (, uint256 cash,, uint256 held, uint256 active, uint256 debt) = kernel.getAccount(accMerchant);
        assertEq(cash, u(3000));
        assertEq(held, u(1000));
        assertEq(active, 1);
        assertEq(debt, 0);
        (, uint256 poolCash, uint256 poolReserved) = kernel.getPool(lenderPool);
        assertEq(poolCash, u(2000));
        assertEq(poolReserved, u(1500));
        (, uint256 escrow,,) = kernel.getEscrow(id);
        assertEq(escrow, u(4000));
        (,,,,, uint256 goodsReserved, uint256 goodsConsumed,,) = kernel.getOffer(offerGoods);
        assertEq(goodsReserved, 100);
        assertEq(goodsConsumed, 0);
        (,,,,, uint256 freightReserved, uint256 freightConsumed,,) = kernel.getOffer(offerFreight);
        assertEq(freightReserved, 1);
        assertEq(freightConsumed, 0);
    }
}
