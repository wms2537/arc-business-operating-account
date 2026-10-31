// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./KernelBase.t.sol";

// Independent specification regressions. Setup may follow a changed public API;
// the security and conservation assertions must remain intact.
contract AuthorizationRegression is KernelBase {
    function cpTerms() internal view returns (IBusinessKernel.PlanTerms memory) {
        return _cpTerms(
            [uint256(40), 35, 25],
            [u(200), u(150), u(100)],
            [u(160), u(165), u(125)],
            [u(200), u(200), u(200)],
            100,
            block.timestamp + 7 days
        );
    }

    function test_ownerFieldCannotImpersonateAnotherAccount() public {
        seedGroupFixture();
        IBusinessKernel.PlanTerms memory t = cpTerms();
        t.buyers[0].owner = stranger;
        vm.expectRevert();
        kernel.draftPlan(t);
    }

    function test_merchantOwnerFieldMustMatchAccountOwner() public {
        seedSaleFixture();
        IBusinessKernel.PlanTerms memory t = _coTerms(block.timestamp + 7 days);
        t.saleParty.merchantOwner = stranger;
        vm.expectRevert();
        kernel.draftPlan(t);
    }

    function test_collectiveSourcesMustCoverTheActualSupplierPayout() public {
        seedGroupFixture();
        IBusinessKernel.PlanTerms memory t = cpTerms();
        for (uint256 i; i < 3; i++) {
            t.buyers[i].ownCash = 0;
            t.buyers[i].creditDraw = 0;
        }
        vm.expectRevert();
        kernel.draftPlan(t);
    }

    function test_eachBuyerMustFundItsOwnAllocation() public {
        seedGroupFixture();
        IBusinessKernel.PlanTerms memory t = cpTerms();
        // Overall funds remain 900; A may not silently subsidize B.
        t.buyers[0].ownCash += u(1);
        t.buyers[1].ownCash -= u(1);
        vm.expectRevert();
        kernel.draftPlan(t);
    }

    function test_termsHashIncludesSaleValue() public {
        seedSaleFixture();
        IBusinessKernel.PlanTerms memory t = _coTerms(block.timestamp + 7 days);
        (, bytes32 beforeHash) = kernel.draftPlan(t);
        t.saleParty.saleValue += u(1);
        (, bytes32 afterHash) = kernel.draftPlan(t);
        assertNotEq(beforeHash, afterHash, "Different sale values must have different terms hashes");
    }

    function test_termsHashIncludesNamedCustomer() public {
        seedSaleFixture();
        IBusinessKernel.PlanTerms memory t = _coTerms(block.timestamp + 7 days);
        (, bytes32 beforeHash) = kernel.draftPlan(t);
        t.saleParty.customerAddress = stranger;
        (, bytes32 afterHash) = kernel.draftPlan(t);
        assertNotEq(beforeHash, afterHash, "Different customers must have different terms hashes");
    }

    function test_termsHashIncludesExactFundingSplit() public {
        seedSaleFixture();
        IBusinessKernel.PlanTerms memory t = _coTerms(block.timestamp + 7 days);
        (, bytes32 beforeHash) = kernel.draftPlan(t);
        t.saleParty.merchantCash += u(1);
        t.saleParty.creditDraw -= u(1);
        (, bytes32 afterHash) = kernel.draftPlan(t);
        assertNotEq(beforeHash, afterHash, "Equal total funding with a different split needs fresh consent");
    }

    function test_generalCreditLimitIsNotExactPlanApproval() public {
        seedGroupFixture();
        uint256 id = draftFullCPPlan();
        // The lender set a general limit and suppliers published offers.
        // Neither has approved these exact plan terms yet.
        vm.prank(buyerA);
        vm.expectRevert();
        kernel.joinBuyer(id, 0);
    }

    function test_accountedClaimsExcludeUnsolicitedTransfers() public {
        fundAccount(buyerA, accA, u(300));
        assertEq(kernel.accountedCustody(), u(300));
        tok.mint(address(kernel), u(17));
        assertEq(kernel.totalCustody(), u(317));
        assertEq(kernel.accountedCustody(), u(300), "A direct transfer creates surplus, not a spendable claim");
    }
}
