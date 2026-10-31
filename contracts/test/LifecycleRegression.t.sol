// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./KernelBase.t.sol";

contract LifecycleRegression is KernelBase {
    function joinAll(uint256 id) internal {
        vm.prank(buyerA); kernel.joinBuyer(id, 0);
        vm.prank(buyerB); kernel.joinBuyer(id, 1);
        vm.prank(buyerC); kernel.joinBuyer(id, 2);
    }

    function committedSale() internal returns (uint256 id) {
        seedSaleFixture();
        id = draftAndApproveFullCOPlan();
        // Mint the customer's complete opening balance exactly once.
        tok.mint(customer, u(10000));
        vm.prank(customer); tok.approve(address(kernel), u(10000));
        vm.prank(customer); kernel.fundCustomerEscrow(id);
        vm.prank(merchant); kernel.joinMerchant(id);
        kernel.commitPlan(id);
        vm.prank(merchant); kernel.acknowledgeGoods(id);
        vm.prank(merchant); kernel.acknowledgeFreight(id);
        vm.prank(customer); kernel.acceptSalesOrder(id);
    }

    function test_lenderRevocationRequiresFreshApprovalBeforeRejoin() public {
        seedGroupFixture();
        uint256 id = draftAndApproveFullCPPlan();
        vm.prank(buyerA); kernel.joinBuyer(id, 0);
        vm.prank(lender); kernel.revokeLenderApproval(id, 0);
        (uint256 approvedDraw,) = kernel.getLenderPlanApproval(id, 0);
        assertEq(approvedDraw, 0, "Revocation must remove approval");
        vm.prank(buyerA); vm.expectRevert(); kernel.joinBuyer(id, 0);
        vm.prank(lender); kernel.approveLenderPlan(id, 0, u(160), block.timestamp + 7 days);
        vm.prank(buyerA); kernel.joinBuyer(id, 0);
        (bool joined, uint256 generation,,) = kernel.getBuyerParticipation(id, 0);
        assertTrue(joined);
        assertEq(generation, 2);
    }

    function test_supplierRevocationRequiresFreshApprovalBeforeRejoin() public {
        seedGroupFixture();
        uint256 id = draftAndApproveFullCPPlan();
        vm.prank(buyerA); kernel.joinBuyer(id, 0);
        vm.prank(supplierA); kernel.revokeOfferApproval(id, 0);
        (uint256 approvedQty,) = kernel.getSupplierPlanApproval(id, 0);
        assertEq(approvedQty, 0, "Revocation must remove approval");
        vm.prank(buyerA); vm.expectRevert(); kernel.joinBuyer(id, 0);
        vm.prank(supplierA); kernel.approveSupplierPlan(id, 0, 100, block.timestamp + 7 days);
        vm.prank(buyerA); kernel.joinBuyer(id, 0);
    }

    function test_salesCollectionRestoresBorrowerCreditHeadroom() public {
        uint256 id = committedSale();
        assertEq(kernel.getBorrowerUsage(lenderPool, accMerchant), u(1500));
        vm.prank(customer); kernel.collectSalesBalance(id, bytes32("first"), u(600));
        assertEq(kernel.getBorrowerUsage(lenderPool, accMerchant), u(900), "Partial receipt releases repaid headroom");
        vm.prank(customer); kernel.collectSalesBalance(id, bytes32("rest"), u(5400));
        assertEq(kernel.getBorrowerUsage(lenderPool, accMerchant), 0, "Repaid loan uses no credit headroom");
        vm.prank(lender); kernel.setBorrowerLimit(lenderPool, accMerchant, 0);
    }

    function test_committedGroupHasNoLiveParticipationHolds() public {
        seedGroupFixture();
        uint256 id = draftAndApproveFullCPPlan();
        joinAll(id);
        kernel.commitPlan(id);
        for (uint256 i; i < 3; i++) {
            (bool joined,, uint256 cashHeld, uint256 creditHeld) = kernel.getBuyerParticipation(id, i);
            assertFalse(joined);
            assertEq(cashHeld, 0, "Consumed cash hold must read as zero");
            assertEq(creditHeld, 0, "Consumed credit hold must read as zero");
        }
    }

    function test_committedSaleHasNoLiveParticipationHolds() public {
        uint256 id = committedSale();
        (bool joined, uint256 cashHeld, uint256 creditHeld) = kernel.getMerchantParticipation(id);
        assertFalse(joined);
        assertEq(cashHeld, 0);
        assertEq(creditHeld, 0);
    }

    function test_saleConservationWithoutMintingAgainAtCollection() public {
        uint256 id = committedSale();
        vm.prank(customer); kernel.collectSalesBalance(id, bytes32("full"), u(6000));
        assertEq(tok.balanceOf(customer), 0);
        assertEq(tok.balanceOf(address(kernel)), u(8500));
        assertEq(tok.balanceOf(supplierA), u(6000));
        assertEq(tok.balanceOf(supplierB), u(500));
        assertEq(kernel.accountedCustody(), u(8500));
        assertEq(tok.balanceOf(address(kernel)) + tok.balanceOf(supplierA) + tok.balanceOf(supplierB) + tok.balanceOf(customer), u(15000));
    }

    function test_groupConservationAfterCollectionsAndSeparateRepayments() public {
        seedGroupFixture();
        uint256 id = draftAndApproveFullCPPlan();
        joinAll(id);
        kernel.commitPlan(id);
        tok.mint(customer, u(1000));
        vm.prank(customer); tok.approve(address(kernel), u(450));
        address[3] memory owners = [buyerA, buyerB, buyerC];
        uint256[3] memory accounts = [accA, accB, accC];
        uint256[3] memory amounts = [u(160), u(165), u(125)];
        for (uint256 i; i < 3; i++) {
            vm.prank(owners[i]); kernel.registerReceivable(700 + i, accounts[i], customer, amounts[i], bytes32("demo opening AR"));
            vm.prank(customer); kernel.collectReceivable(700 + i, bytes32("receipt"), amounts[i]);
            (,,,,,uint256 debt) = kernel.getAccount(accounts[i]);
            assertEq(debt, amounts[i], "Collection alone must not repay a loan");
        }
        for (uint256 i; i < 3; i++) {
            vm.prank(owners[i]); kernel.repayLoan(i + 1, amounts[i]);
            (,uint256 cash,,,,uint256 debt) = kernel.getAccount(accounts[i]);
            assertEq(cash, u(100));
            assertEq(debt, 0);
        }
        (,uint256 poolCash,) = kernel.getPool(lenderPool);
        assertEq(poolCash, u(500));
        assertEq(tok.balanceOf(customer), u(550));
        assertEq(tok.balanceOf(supplierA), u(900));
        assertEq(tok.balanceOf(address(kernel)), u(800));
        assertEq(kernel.accountedCustody(), u(800));
        assertEq(tok.balanceOf(address(kernel)) + tok.balanceOf(supplierA) + tok.balanceOf(customer), u(2250));
    }
}
