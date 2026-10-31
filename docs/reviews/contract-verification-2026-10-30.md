# Contract verification evidence, 30 October 2026

Project: https://studio.arc.io/app/46704d22-91ee-404d-8ff7-7ad873e3c289

## Result and scope

177 tests passed on the default compiler and the same 177 passed on actual release-profile creation bytecode. No tests failed or were skipped. The original 152-test checkpoint was extended by three funding-readiness regressions and 22 targeted verification cases. All executable checks ran in this Studio sandbox. No deployment, wallet transaction or Arc runtime claim is made.

The machine receipt is `docs/evidence/contract-verification-checks.json`. It records exact commands, source hashes before/after, identical test inventories, fuzz runs, gas measurements and the complete release result. Raw stdout/stderr use the `contract-verification-` prefix. `release-artifact-test-results.json` records the release test details.

## Defect reproduced and fixed

Before the fix, a customer-order plan with approved sources one micro-unit below or above the fixed payouts reported Ready. Commit rejected both with `BK_SourcesNeqPayout`, and financial state stayed unchanged. Both failures repeated in two runs; an exactly funded control passed. Additional probes confirmed the stored escrow and holds matched the approved terms.

`planReadiness` omitted the equality check already present in commit. It now compares actual escrow plus reserved merchant cash and credit against the two fixed payouts and returns `Funding mismatch` when they differ. The public transaction and view regressions now pass. Historical red logs and the pre-fix kernel hash remain in `readiness-red-baseline.json`, `readiness-red-run1.stdout/.stderr`, `readiness-red-run2.stdout/.stderr` and the state-probe outputs.

## Targeted verification added

- Account and lender authorization with arbitrary callers; named business roles cannot act for each other. The tests assert exact authorization errors and unchanged financial state.
- Postcommit acknowledgment, customer acceptance, collection, opening-receivable registration and repayment permissions. Refunds remain bound to the correct customer and plan.
- Plan-specific approval isolation and shared cash/credit contention. Mixed workflows commit in both orders after the real funding shortfall is supplied.
- Zero recipients, unsupported native deposits/calls, checked arithmetic overflow, zero amounts and over-repayment. Failed attempts preserve state and permit a valid retry with the same reference.
- Exact one-micro-unit collection behavior and both sides of the principal boundary. Debt, lender credit and merchant credit reconcile with actual receipts.
- Debt and active holds independently prevent floor reduction. Repayment preserves another plan's holds and other borrowers' debt; repaying debt does not restore consumed supplier capacity.
- Exact `ReceivableRegistered`, `ReceivableCollected`, `GoodsAcknowledged`, `FreightAcknowledged`, `CustomerAccepted`, `LoanRepaid` and `SalesCollected` event payloads at the public call boundary.
- Maximum-eight-participant commit and expiry cleanup after 128 unrelated drafts; the ninth participant is rejected before reservation.

Four fuzz properties each executed 256 cases per build, using seed `0x000000000000000000000000000000000000000000000000000000000000c0de`. That is 1,024 fuzz cases per build. The shared-reservation property executes 64 transitions in each case, or 16,384 randomized transitions per build, plus setup and cleanup. It mixes two groups and a sale on shared accounts, liquidity and offer capacity. Every transition checks physical conservation, custody backing with a fixed unallocated surplus, protected floors, exact active counts, facility usage, pool liquidity and supplier reservations. Failed calls must leave the snapshot unchanged. This is a bounded test campaign, not exhaustive proof or an independent security audit.

## Local EVM gas measurements

These measure `gasleft()` around the public call after `vm.cool` on the kernel and, for commit, the token. The fixture has 128 unrelated drafts and the maximum eight participants. Measurements exclude transaction intrinsic gas and real network fees. The regression ceilings are 2,000,000 for commit and 1,500,000 for cleanup. They are not Arc transaction estimates.

| Compiler | Operation | Measured gas |
| --- | --- | ---: |
| Default | CV_MAX8_COMMIT_GAS_AFTER_128_DRAFTS | 475,045 |
| Default | CV_MAX8_CLEANUP_GAS_AFTER_128_DRAFTS | 306,707 |
| Release artifact | CV_MAX8_COMMIT_GAS_AFTER_128_DRAFTS | 472,535 |
| Release artifact | CV_MAX8_CLEANUP_GAS_AFTER_128_DRAFTS | 306,153 |

## Original contract acceptance map

Each reference below was checked against the executed test inventory. The map links the original requirement to inspectable tests; it does not convert local EVM results into network or full-app acceptance.

| Requirement | Original action or condition | Passing evidence or remaining boundary |
| --- | --- | --- |
| DC-01 | Seed the group fixture and join A then B. | `test_DC01_ABJoin` |
| DC-02 | Join C. | `test_DC02_CJoins` |
| DC-03 | Repeat an already active join. | `test_DC03_DuplicateJoinReverts` |
| DC-04 | Fund the lender with only 300 before joining A and B. | `test_DC04_Lender300_ASucceedsBFails` |
| DC-05 | Try to reserve another plan using already held business cash. | `test_DC05_HeldCashBlocksSecondPlan` |
| DC-06 | Try to reserve another plan using already held lender liquidity/headroom. | `test_DC06_HeldCreditBlocksSecondPlan` |
| DC-07 | Set supplier offer capacity to 99 before joins; attempt A/B/C. | `test_DC07_Capacity99_CFailsPartial` |
| DC-08 | Two plans reserve units from the same offer. | `test_DC08_TwoPlansShareOffer` |
| DC-09 | A leaves before commit, then the release is retried. | `test_DC09_LeaveAndRetry` |
| DC-10 | The block timestamp equals the effective deadline. | `test_DC10_ExpiryEquality` |
| DC-11 | Release an expired plan twice. | `test_DC11_ReleaseExpiredTwice` |
| DC-12 | Revoke B's uncommitted funding approval. | `test_DC12_LenderRevokesB` |
| DC-13 | Revoke a required supplier offer. | `test_DC13_SupplierRevokeBlocksCommit` |
| DC-14 | Commit the complete group. | `test_DC14_FullGroupCommit` |
| DC-15 | Replay group commit or submit another request ID for that plan. | `test_DC15_ReplayCommitReverts` |
| DC-16 | Cause the final external payout of a plan to fail. | `test_failingSecondPayoutRollsBackTheFirstPayoutAndAllClaims`, `test_RECB03_PropagatedCallback_SecondTransfer_FullRollback` |
| DC-17 | Seed sale merchant 3,000 and lender 2,000; fund customer advance 4,000. | `test_DC17_EscrowFunded` |
| DC-18 | Try to use the customer advance as merchant free cash before commit. | `test_DC18_EscrowNotMerchantCash` |
| DC-19 | Reserve the sale. | `test_DC19_Reserve` |
| DC-20 | Commit the sale. | `test_DC20_Commit` |
| DC-21 | Record merchant acknowledgment of all 100 goods units and the one freight service, then full customer acceptance; collect the customer's actual remaining 6,000. | `test_DC21_FullAcceptanceAndCollection` |
| DC-22 | After those merchant acknowledgments and full customer acceptance, instead collect 600, then 5,400. | `test_DC22_TwoPartialCollections` |
| DC-23 | Reuse a receipt reference, including with different payload. | `test_DC23_DuplicateReceiptRejected` |
| DC-24 | After full customer acceptance, try to collect more than the sale's remaining expected cash. | `test_DC24_OvercollectionRejected` |
| DC-25 | Attempt voluntary repayment from the merchant's protected 2,000 after commit. | `test_DC25_RepaymentBoundByFloor` |
| DC-26 | Make a valid voluntary repayment, complete merchant acknowledgments and full customer acceptance, then collect the sale. | `test_DC26_VoluntaryRepayThenCollect`, `test_CV19_RepaymentPreservesOtherPlanHoldsAndOtherBorrowers` |
| DC-27 | Attempt a business withdrawal above available cash, including another plan's holds. | `test_DC27_WithdrawalAboveAvailableBlocked`, `test_CV19_RepaymentPreservesOtherPlanHoldsAndOtherBorrowers`, `testFuzz_CV17_SharedReservationSequencePreservesInvariants` |
| DC-28 | Attempt lender withdrawal above unreserved funded cash. | `test_DC28_LenderWithdrawalBlocked`, `testFuzz_CV17_SharedReservationSequencePreservesInvariants` |
| DC-29 | Reduce a protected floor during active participation or debt. | `test_DC29_FloorChanges`, `test_CV18_DebtKeepsFloorAndFacilityLockedUntilRealRepayment`, `test_CV19_RepaymentPreservesOtherPlanHoldsAndOtherBorrowers` |
| DC-30 | Name another account in an unapproved draft plan. | `test_DC30_DraftDoesNotFreezeAccount` |
| DC-31 | Cancel an open funded sale. | `test_DC31_CancelMakesEscrowRefundable` |
| DC-32 | Customer withdraws that refund and retries. | `test_DC32_EscrowWithdrawAndRetry` |
| DC-33 | Attempt cancellation or debt erasure after successful supplier payment. | `test_DC33_PostCommitCancelRejected` |
| DC-34 | Deposit unrequested USDC directly to the kernel. | `test_accountedClaimsExcludeUnsolicitedTransfers`, `testFuzz_CV17_SharedReservationSequencePreservesInvariants` |
| DC-35 | Try unauthorized approval, withdrawal, recipient change or arbitrary external call. | `test_DC35_UnauthorizedActionsRejected`, `testFuzz_CV01_AccountAndLenderAuthorization`, `test_CV02_ExistingBusinessRolesCannotImpersonateEachOther`, `testFuzz_CV03_PostCommitAndReceivableAuthorization`, `test_CV06_ZeroRecipientsUnsupportedNativeAndArithmeticRollback` |
| DC-36 | Observe both native-system and ERC-20 transfer events for one Arc transfer. | Not verified: Arc native/ERC-20 event deduplication requires network receipts and projector integration. |
| DC-37 | Display Ready, then consume/revoke a prerequisite before commit executes. | `test_DC37_ReadinessStalenessCheck`, `test_RF01_OneUnitShortIsNotReady`, `test_RF02_OneUnitExcessIsNotReady`, `test_RF03_ExactFundingIsReadyAndCommits` |
| DC-38 | Execute the group's actual 450 receivable collections, then separate borrower repayments. | `test_DC38_CollectionsAndRepayment` |
| DC-39 | Competing transactions try to consume the same remaining cash, credit or capacity. | `test_DC39_CompetingReservations`, `testFuzz_CV17_SharedReservationSequencePreservesInvariants` |
| DC-40 | Advance time, edit UI status, or mark an offchain invoice paid without transferring money. | `test_DC40_OffchainDoesNothing` |
| DC-41 | On one kernel, fund a shared lender pool with 1,900. Reserve the sale's 1,500, then group A's 160 and B's 165. Try group C's 125. | `test_DC41_SharedPoolContention`, `test_CV12_MixedWorkflowCommitsSaleThenGroup`, `test_CV13_MixedWorkflowCommitsGroupThenSale` |
| DC-42 | On one kernel, use the same business account as the sale's merchant and one group's A participant. Give it 3,000 cash, a 2,000 floor, sufficient approved credit and sufficient lender liquidity; reserve the sale's 1,000 own contribution, then try A's 200 group contribution. | `test_DC42_SharedAccountContention`, `testFuzz_CV17_SharedReservationSequencePreservesInvariants` |
| DC-43 | After procurement commit, attempt sales balance collection before full customer acceptance, including after just one merchant acknowledgment. | `test_DC43_CollectionBeforeAcceptanceRejected` |
| DC-44 | Attempt customer acceptance before both merchant acknowledgments, an acknowledgment by an unauthorized caller, or a partial acknowledgment; then record the valid full sequence and retry identical acknowledgments. | `test_DC44_AckSequenceEnforced`, `test_CV22_AcceptanceAndSalesEventsDescribeExactEconomicEffects` |
| DC-45 | A/B/C owners register their fixture opening receivables of 160/165/125 with immutable IDs, their beneficiary accounts and the bound external source funded with 1,000. | `test_DC45_RegisterReceivables` |
| DC-46 | The bound external source calls each registered receivable's collection command with ERC-20 allowance and actual funds. | `test_DC46_CollectReceivable`, `test_CV21_RegisteredReceiptEventHasExactAttributionAndNoDebtPayment` |
| DC-47 | Try an unauthorized payer, duplicate/conflicting collection reference, zero amount or amount above a registered receivable's remaining cap. | `test_DC47_InvalidCollections`, `test_CV20_ZeroAmountsAndExcessRepaymentPreserveReferences` |
| DC-48 | Toggle an offchain acceptance/AR flag, use acceptance for another plan/version, or call acceptance as anyone other than the sale's named customer. | `test_DC48_AcceptanceGateEnforced`, `testFuzz_CV03_PostCommitAndReceivableAuthorization` |
| DC-49 | Exercise join, duplicate join, failed join, leave/rejoin, lender revocation, cancellation, expiry cleanup and commit for an owner's participation. | `test_DC49_ParticipationCount`, `test_CV18_DebtKeepsFloorAndFacilityLockedUntilRealRepayment`, `test_CV19_RepaymentPreservesOtherPlanHoldsAndOtherBorrowers`, `testFuzz_CV17_SharedReservationSequencePreservesInvariants` |

DC-36 remains open for Arc-specific native/ERC-20 event deduplication and integration. The offchain accounting acceptance cases in `03-accounting-and-acceptance.md` also require the projector and recovery implementation. Local contract verification is ready for the next integration stage; the full app and network acceptance remain unfinished.

## Artifact identity

Release: Solidity 0.8.28, Cancun, via-IR, optimizer_runs=1. Default tests use optimizer_runs=200. Runtime is 24,475 bytes, 101 bytes below the 24,576 limit. Future contract edits must rerun the release verifier and size check.

- Kernel SHA-256: `768b5bff3015eab39363f7472f3dcaed3709025395e90d6620090d021523009b`
- Interface SHA-256: `38c02c51dc633f2bd4e922967b53e50ac0ab8323be0cce972c52190c9e283f3a`

Preserve the old receipt and approval-expiry regressions. Do not infer custody, external lender payment or debt repayment from UI flags. Real token movement, internal claim allocation and loan principal remain separate.
