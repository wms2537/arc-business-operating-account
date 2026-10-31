# 02 — Shared financial domain and contract specification

## Purpose and implementation boundary

This specification defines the financial kernel for the first onchain build, referred to here as **M1**. It supports both the collective-purchase fixture and the financed sales-order fixture through the same accounts, reservations, funded-credit, debt, settlement and repayment rules.

M1 uses one immutable USDC custody and settlement contract, with logical modules inside that contract. Each business has a separately owned cash account in the kernel. The lender has a separately accounted funded liquidity balance. Customer advances remain separately accounted refundable customer funds until a successful sales-order commit. All these balances are backed by USDC held at the same contract address.

This is **pooled contract custody with independently authorized claims**, not a collection of separate wallet balances. The demonstration must disclose that distinction. Supplier and logistics payments are external ERC-20 USDC transfers. Repayment credits the lender's funded internal cash balance; a lender withdrawal is a separate external transfer.

This document specifies decisions and acceptance criteria, not production readiness. It does not authorize a deployment, a transaction, a credit offering or custody of third-party money. Use the pack's official configuration and deployment instructions for network configuration and addresses.

## 1. Ten binding decisions

| Decision | M1 rule | Reason |
|---|---|---|
| Shared authority boundary | One immutable kernel owns custody and all financial state. Logical modules are internal functions/libraries, not independently privileged services. | Cash, reservations, capacity and debt must change within the same transaction boundary. |
| Independent authorization | Use explicit onchain actions by each registered owner or counterparty. Each action refers to immutable plan terms. No EIP-712, relayed signatures, session keys or AI signing in M1. | Separate senders make the authorization evidence inspectable without an additional signature-validation system. |
| One asset and unit | Application accounting uses only the configured USDC ERC-20 interface and integer micro-USDC. Native gas is accounted for separately. | Prevent native/ERC-20 double-counting and decimal mistakes. |
| Firm reservations | Joining atomically reserves the participant's own cash, actual lender liquidity, borrower credit headroom and supplier units. It does not transfer cash or create debt. | A second plan cannot reuse the same resources. |
| Immutable plans | Participant identities, quantities, funding splits, payees, amounts, offer references, deadlines and repayment policy are immutable. Material changes require a new plan. | A party approves one concrete operation, not an editable instruction. |
| Full-fill commitment | The group must fill exactly 100 units. The sale must fund its entire 6,500 procurement/logistics requirement. No partial execution or partial group fill. | Makes all-or-nothing settlement precise. |
| Protected operating cash | Every business cash outflow enforces the protected floor and all other active holds. Floor increases must be fully backed; reductions require no active participation/holds and no outstanding debt. | A withdrawal, another plan or repayment must not bypass protection. |
| Debt begins at draw | Reserved credit is separate from outstanding principal. Commit consumes the credit reservation, debits actual lender cash and creates the same amount of borrower debt. | Approval and reservation are not loans. |
| Explicit lifecycle boundaries | Expiry/revocation immediately makes commit invalid. A transaction must materialize release of holds. Post-commit cancellation cannot undo paid suppliers or erase debt. | Time and UI state do not execute transactions or move money. |
| Typed settlement only | No proxies, arbitrary calls, arbitrary approvals, delegatecall, owner debit override or USDC rescue/sweep function. | Every outflow must pass one of the defined authorization and balance checks. |

## 2. Canonical terminology

- **Business cash:** a business's funded USDC claim inside the kernel. It is not its external wallet balance.
- **Protected floor:** the minimum business cash the kernel must preserve while enforcing the current policy.
- **Cash hold:** cash reserved for a specific approved plan participation. It remains part of business cash until consumed.
- **Available cash:** business cash minus the protected floor and all outstanding cash holds.
- **Funded lender cash:** actual USDC attributed to the lender inside the kernel, including repayments already received or internally reallocated to it.
- **Credit approval:** the lender's permission to lend a stated amount for a stated participant and plan. Approval alone neither holds liquidity nor creates debt.
- **Credit reservation:** a hold on funded lender cash and the borrower's approved credit headroom for one participation.
- **Outstanding principal:** credit actually drawn at commit, less actual principal repayments. It is a receivable of the lender and a liability of the borrower; it is not spendable cash.
- **Customer advance escrow:** actual USDC received from the sale's named customer, earmarked for that sale and refundable before commit. It is not merchant free cash or lender capital.
- **Refundable customer credit:** customer funds made withdrawable after cancellation or expiry. It remains in the customer-funds accounting bucket until withdrawn.
- **Supplier offer:** supplier-authorized price, capacity, expiry and payment destination. The kernel can enforce recorded capacity allocation; it cannot prove physical inventory exists.
- **Capacity reservation:** units of a supplier offer allocated to an uncommitted participation. Joining reserves units; leaving releases them; commit consumes them.
- **Plan:** immutable commercial and financial instructions, with an independently changing approval/reservation/lifecycle state.
- **Commit:** the one atomic transaction that consumes a fully authorized plan, pays its approved external recipients and records its loans and allocations.
- **Collection:** actual new USDC received against a recorded receivable. Group collections credit buyer cash before a separate borrower repayment; accepted sales-order collections use the agreed principal-first allocation. A UI entry or an offchain receipt reference cannot create cash.
- **Repayment:** allocation of actual cash to reduce a particular loan's outstanding principal and increase the lender's funded cash claim.
- **Ready:** a derived statement about current onchain state. It is not a durable authorization, reserved state or guarantee that a later transaction will succeed.

Do not use `balance`, `credit`, `available` or `settled` without identifying which of these meanings applies.

## 3. Minimal architecture

### 3.1 One stateful contract

Use one kernel with the following internal responsibilities:

1. **Account ledger:** business cash, protected floors, aggregate cash holds, deposits and withdrawals.
2. **Funding ledger:** lender cash, aggregate liquidity reservations, per-borrower credit limits, approvals, reservations and loan principal.
3. **Offer book:** supplier-authorized offers, declared capacity, reserved units and consumed units.
4. **Plan engine:** immutable plan data, participant approvals, reservation bundles, readiness, commit, cancellation and expiry release.
5. **Customer funds and collection routing:** refundable advances, sales-order collections, principal-first allocation and customer refunds.
6. **Events and read models:** structured financial events and read-only views for the UI and accounting projections.

These responsibilities share one storage and authorization boundary. Their functions may be organized into source files or internal libraries for readability. Do not introduce a generic financial executor that can call arbitrary target contracts.

The reference M1 uses one lender-owned liquidity pool per kernel. The two canonical fixtures are independent initial-state fixtures using the same kernel implementation and bytecode. Use fresh local/test deployments and distinct recorded deployment addresses for those canonical demonstrations. Do not reset or overwrite balances on a live deployment, or silently count one lender deposit in both fixtures.

A same-kernel mixed-workflow contention test is mandatory: a sale and a group must compete for the same lender liquidity, and a separate variant must make them compete for the same business cash. This demonstrates an actual shared financial core rather than two implementations that merely look alike. See DC-41 and DC-42. Their deliberately different aggregate funding is not a replacement for the canonical fixtures.

The submission may show one complete actual mainnet flow and a second verified testnet flow if time or funding limits require that boundary; label each network and execution honestly. Deployment/funding instructions and any scaled capital estimate belong to the deployment section of this pack. This document authorizes neither funding nor execution.

### 3.2 Offchain components have no financial authority

The UI, optional agent, event indexer and accounting projections can propose plans, explain failure reasons and prepare transactions. They cannot declare a reservation funded, change a payee, recognize a draw or mark debt repaid independently of kernel state.

Store commercial documents and descriptive ERP data offchain. An immutable content reference/hash may be included in plan terms. All fields necessary to validate financial execution must be available to the kernel as typed data; an opaque document hash is not a substitute for checking amounts and authorization.

### 3.3 Bounded scope

Use explicit small bounds: at most eight business participants, four payout lines and four supplier-offer lines per plan. The group fixture uses three participants and one supplier line. The sale uses one borrowing business and two payout/offer lines.

Global history can grow, but no state-changing command may loop over every plan, account or offer. Release and commit loops operate only on one bounded plan. A stale offer may affect many plans; each affected plan is released separately.

## 4. Domain records and authority

These are conceptual records, not prescribed Solidity declarations.

### Business account

Required fields: account identifier/owner, funded cash, protected floor, aggregate cash holds, active authorized participation count, aggregate outstanding principal and aggregate reserved credit headroom.

An owner may deposit, authorize a participation, withdraw available cash, make a permitted repayment and change its protected floor under the stated rules. A plan creator cannot operate another owner's account. Merely naming an account in an unapproved proposal must not freeze its floor or funds.

If `activeParticipationCount` is stored, increment it exactly once when that owner successfully joins and obtains a reservation bundle, including a participation with zero own-cash contribution. Decrement it exactly once when that bundle is consumed at commit or released by leave, revocation, cancellation or expiry cleanup. A failed join and an identical repeated join do not increment it. Repeated cleanup cannot decrement it again. Reservation identity/generation and terminal consumed/released state must prevent underflow or a permanent stale lock.

After commit, the consumed participation no longer contributes to the count. Its outstanding principal independently keeps the protected-floor reduction locked until that debt is fully repaid. Other active participations still lock the floor. The count must equal the number of that owner's currently active reservation bundles; a derived alternative is acceptable only if it preserves the same semantics with bounded tracking. Draft naming and unaccepted approvals alone never increment it.

### Lender and borrower facility

The pool records its owner, funded cash and aggregate reserved liquidity. A borrower facility records its approved outstanding-principal limit and current reserved/outstanding usage. A plan funding approval binds the lender to the exact plan hash, borrower, draw amount and authorization expiry.

Only the lender may fund or withdraw its pool, set its borrower limits and grant/revoke funding approvals. A limit reduction cannot erase debt or move below already reserved plus outstanding usage. Revoke an uncommitted approval through the explicit release path; do not overwrite booked usage.

The lender's cash withdrawal limit is funded pool cash minus reserved liquidity. Outstanding loans are not withdrawable cash. An approval without a reservation is not a promise that liquidity remains available.

### Supplier offer

Required fields: offer ID, supplier owner, immutable payout wallet, unit price, declared capacity, minimum fill where relevant, expiry, reserved units, consumed units and active/revoked state.

The supplier publishes the offer and explicitly approves the plan referencing it. The approval binds the plan hash and payee. Publishing a general offer alone does not approve arbitrary changes to a plan.

The group offer has unit price 9 and capacity/minimum fill 100. Each joining buyer reserves its own units. The sales goods offer is **100 goods units at 60 per unit**, totaling 6,000. The separate freight offer is **one service unit at 500**, totaling 500. Reserve and consume 100 goods units and one freight unit against their respective offer IDs; do not describe them as two units of the same resource or collapse the goods into one lot. Monetary demo scaling changes prices and amounts, not physical quantities: goods remain 100 units and freight remains one unit.

The supplier cannot silently change price, payee or capacity under existing approvals. Revoke the old offer and publish a new one for changed terms. In particular, reducing declared capacity below reserved plus consumed units is forbidden as an ordinary edit. A revocation invalidates uncommitted uses and allows their release; it cannot undo consumed capacity or payments.

Capacity enforcement is limited to the recorded offer and plans using it. It does not prove stock availability elsewhere, prevent off-platform promises or combine independently issued offers into a global inventory ledger.

### Plan and participation

A plan fixes:

- Template: collective purchase or financed sale.
- Creator/coordinator and all required parties.
- Business participant addresses and exact quantities.
- Exact own-cash contributions and exact funded-credit draws.
- Approved lender/pool and repayment policy.
- Supplier offer IDs and exact payout recipients/amounts.
- Group minimum/exact aggregate quantity, or sales total and customer advance.
- Commercial reference/hash and acceptance deadline.

Use a canonical hash of the full typed terms and a unique plan ID. Include the kernel/network context in identity handling. Never use only a human invoice number as global replay protection.

For each participation, record whether it is joined, the cash/credit/capacity holds it owns, and a reservation generation or equivalent unique identifier. Rejoining after a valid leave creates a new reservation identity. Repeating the same active join must not accumulate duplicate holds.

The fixture funding split is computed when preparing the immutable plan, using available own cash after the floor and existing holds. It is then explicitly authorized. Do not silently change the split at commit because the account balance changed. If a different split is desired, create/reapprove a new plan. Describe the fixture draw as the minimum for its stated funding snapshot, not a continuously recomputed optimum.

### Loan and receipt

A loan is uniquely identified by committed plan and borrower. Record lender, original principal, outstanding principal, total principal repaid and repayment policy. M1 is principal-only: no interest, fees, default liquidation or implicit debt forgiveness.

A sales receipt records its plan, named payer, amount, unique payment/reference ID and actual allocation between principal and merchant cash. A repeated reference cannot consume tokens a second time. A reference reused with different fields must fail.

### Group opening receivable and collection

The group fixture requires a real attributed collection path; an owner-only deposit method is insufficient because the actual payer is the separate external customer/source.

Each buyer owner explicitly registers its opening receivable onchain. Registration fixes an immutable receivable ID, buyer beneficiary account, actual payer address, opening amount and opening-evidence/provenance reference. Only that buyer's owner may register a receivable benefiting its account. Store the registered owner, registration time and a remaining amount initially equal to the opening amount. Material changes require a new record; do not edit the payer or beneficiary of an existing receivable.

For the fixture, register three distinct records: A receives 160, B 165 and C 125, each payable by the same specified external collection source funded with 1,000. Label them explicitly as **owner-registered demo opening receivables**. They are supplied opening balances, not newly earned revenue, independent evidence that a customer owes money, or proof of real adoption. Registration creates no cash, debt repayment, payer-funds reservation or withdrawal permission. The payer need not approve registration; it authorizes payment only by submitting its own collection transaction.

The named payer calls the attributed collection command for a registered receivable, amount and unique payment reference. The kernel verifies the caller equals the immutable payer, the positive amount does not exceed that receivable's remaining amount and the payment reference has not been used for it. It then transfers actual USDC from that bound payer into the kernel, credits only the immutable buyer beneficiary, decreases remaining receivable by the amount actually received, and emits `ReceivableCollected` with receivable ID, payment reference, payer, beneficiary, amount and remaining amount. The payer supplies the necessary ERC-20 allowance; neither an AI/backend assertion nor registration alone permits a token pull.

Duplicate references, conflicting duplicate payloads, unauthorized payers, zero amounts and overpayment must revert before transfer or claim changes. Do not use a generic database `giveCredit` endpoint. An unrelated direct token transfer remains unaccounted surplus and cannot be silently attributed to this receivable. Collection leaves the buyer's loan outstanding until the borrower submits a separate repayment.

### Sales receipt acknowledgments and customer acceptance

Keep three recorded **authenticated onchain** operational acknowledgments separate from financial commitment: merchant acknowledgment of all 100 goods units, merchant acknowledgment of the one freight service unit, and the named customer's acceptance of the full sales order. Each acknowledgment binds the immutable plan ID and its terms hash/version; an offchain AR row, UI toggle or unrelated plan acceptance cannot satisfy the gate. Only the merchant owner may record its goods/freight acknowledgments, and only after commit. Either merchant acknowledgment may occur first, but both are required before customer acceptance. Only the named customer may then record full acceptance. M1 does not support partial goods, partial freight or partial customer acceptance.

These owner-authorized onchain records are assertions about fulfillment, not independent proof of physical delivery. Record the actor, plan, complete quantity/service reference and timestamp, with the agreed evidence reference where provided. Repeating an identical acknowledgment or acceptance cannot change quantities or financial balances.

Sales balance collection is enabled only after all three acknowledgments are recorded in this order of dependency. Recording them does not itself move cash, repay principal or collect the remaining 6,000. Before full customer acceptance, a collection attempt must fail before any token pull, cash allocation or receipt-reference consumption.

## 5. Financial invariants

All quantities below use integer micro-USDC unless explicitly described as supplier units.

### 5.1 Business cash

For every business account:

`cash >= protectedFloor + aggregateCashHolds`

`availableCash = cash - protectedFloor - aggregateCashHolds`

Do not subtract outstanding debt again when calculating available cash. Debt is a separate liability. Do not hide a violated invariant by clamping a negative available balance to zero in the UI.

Every outgoing cash path must enforce the invariant: withdrawal, new reservation, manual repayment and any future internal cash transfer. There is no separate convenience transfer method that bypasses it.

At commit, consume the plan's own hold correctly:

- Cash decreases by that held contribution.
- Aggregate holds decrease by the same contribution.
- Remaining cash must still cover the protected floor and every **other** hold.

Do not require the contribution to be available a second time: reserved cash is already excluded from available cash.

### 5.2 Lender liquidity and borrower headroom

`poolCash >= poolReservedLiquidity`

`poolAvailable = poolCash - poolReservedLiquidity`

For each borrower facility:

`outstandingPrincipal + reservedPrincipal <= approvedLimit`

A join increases reserved liquidity/headroom and leaves cash and debt unchanged. A draw decreases both pool cash and its reservation, decreases borrower reserved principal, and increases borrower outstanding principal by exactly the funded draw. Repayment increases pool cash and decreases the corresponding outstanding principal by the same amount.

Do not subtract outstanding principal from pool cash a second time: drawn money already left pool cash at commit.

### 5.3 Custody backing

At every completed transaction:

`sum(businessCash) + lenderCash + refundableCustomerFunds + unallocatedReceipts <= kernelUSDCBalance`

`refundableCustomerFunds` includes both locked advances and canceled/expired advances awaiting customer withdrawal. Cash holds and credit reservations are encumbrances on those balances, not additional balances. Outstanding loans, expected customer receipts and supplier units are not USDC held by the kernel.

M1 routes recognized incoming receipts in the same transaction, so its normal `unallocatedReceipts` balance is zero. Do not invent a cash receipt before actual tokens arrive.

Unrequested direct transfers can create **unaccounted surplus**. They do not automatically credit an arbitrary business, the lender or an administrator. Therefore use the inequality above, not an unconditional equality. The invariant can be restated as accounted cash plus nonnegative surplus equals the ERC-20 balance. M1 has no USDC rescue/surplus withdrawal path.

### 5.4 Capacity

For every supplier offer:

`reservedUnits + consumedUnits <= declaredCapacity`

For a participation, its cash, credit and capacity reservations are created/released/consumed as one bundle. A failure to reserve any component leaves all components unchanged.

Commit moves units from reserved to consumed. Repaying a loan does not restore supplier capacity. Post-commit inventory returns or capacity restoration require a separately designed operation and are outside M1.

### 5.5 Conservation and replay

Every credited cash amount must correspond to an actual deposit, an actual collection or an internal debit from another accounted cash bucket in that transaction. Never increment borrower cash, lender cash or a refund balance from expected revenue or approved credit.

Every loan principal reduction must have a matching funded allocation to the lender. A loan status, UI button or time passage cannot repay a loan.

Each plan commits at most once, regardless of request ID, transaction sender or retry. Every reservation is consumed or released at most once. Every receipt reference is applied at most once.

## 6. Authorization and command semantics

### Preparation and approval

Creation of a plan is a proposal only. It cannot debit accounts, reserve resources or count as approval by its named participants.

- Each business owner calls the join/reserve action for its exact participation.
- The lender explicitly approves the exact funding rows and maintains the required funded pool cash.
- Each supplier/logistics owner explicitly approves the plan and its fixed payout destination.
- The named customer funds the exact required sales advance through the kernel. This is both an actual deposit and approval of the referenced plan terms.

Use direct caller authorization and persistent onchain approval state. M1 does not infer consent from an address appearing in an uploaded invoice, an AI response or a server request.

### Required attributed-receipt and acceptance commands

The implementation may choose consistent method names, but it must expose these explicit behaviors rather than simulating them in the database:

| Public command | Authorized caller and inputs | Onchain effect |
|---|---|---|
| Register opening receivable | Buyer account owner; unique receivable ID, its beneficiary account, bound external payer, opening amount and demo/evidence provenance. | Creates the immutable opening record and remaining cap; creates no cash or loan repayment. |
| Collect registered receivable | Its bound payer; receivable ID, unique payment reference and amount. | Pulls actual USDC from that payer, credits the fixed beneficiary, reduces remaining receivable and emits `ReceivableCollected`; does not repay debt. |
| Repay specified loan | Borrower account owner; its loan ID and amount. | Separately reallocates available business cash to lender cash and reduces that loan's principal. |
| Acknowledge goods receipt | Sale merchant owner; committed plan ID/terms hash and exact full goods quantity 100. | Records the authenticated goods acknowledgment without moving cash or debt. |
| Acknowledge freight completion | Sale merchant owner; the same plan ID/terms hash and exact full freight service quantity 1. | Records the authenticated freight acknowledgment without moving cash or debt. |
| Accept full sales order | Named customer; the same plan ID/terms hash, after both merchant acknowledgments. | Records full customer acceptance onchain; creates no collection by itself. |
| Collect accepted sales balance | Named customer; accepted plan ID, unique payment reference and amount within remaining expected cash. | Pulls actual USDC and applies the agreed principal-first allocation. |

### Join and reserve

Check the plan is open and unexpired; the caller owns the participation; supplier and funding approvals are current; quantities and fixed contributions match the plan; the business has sufficient available cash; borrower headroom and actual pool liquidity suffice; and supplier units are available.

Then reserve all resources atomically. A sales participant may reserve before the customer pays the advance, but the plan is not ready until the actual advance is fully funded. Show the missing condition explicitly.

The customer advance is exactly 4,000 in the sales fixture. M1 does not accept overfunding or introduce partially funded advance installments. Duplicate funding must not pull another 4,000.

### Derived readiness

A read method returns readiness and structured reasons from current state. It checks:

1. The plan is open and strictly before every effective deadline.
2. Every required participant has the correct live reservation bundle.
3. Every required approval remains valid.
4. The group is exactly full, or the sale is fully funded including its actual advance.
5. All aggregate cash, credit and capacity invariants hold.

Do not persist `READY` and rely on it later. Commit repeats the checks against the executing block's state. A view can become stale between rendering and transaction inclusion.

### Commit

Once every participant has given the bounded onchain authorization, commit may be called by any sender. The caller cannot select different terms, payees, amounts or allocations. This permits a coordinator to submit execution without holding other participants' keys.

In one non-reentrant transaction:

1. Validate the immutable plan, current approvals, effective deadline, reservation identities and all aggregate invariants.
2. Mark the plan committed/consumed and consume its cash, lender and capacity reservations.
3. Debit business cash, consume the sales advance where applicable, debit funded lender cash and create each borrower's loan principal.
4. Record the fixed allocations and typed settlement events.
5. Execute the exact external ERC-20 payouts to the approved supplier/logistics wallets.

If any payout fails or any check fails, the whole transaction reverts, including earlier token transfers and state writes in that transaction. Do not catch a failed payout and retain a partially committed order. The submitting wallet still pays network gas for a failed transaction.

A second identical commit request is a state-preserving no-op or an explicit already-committed result; it never pays again. A conflicting payload or new request ID for an already consumed plan must not create a new execution. Choose one consistent client presentation for the harmless replay result.

### Cash withdrawals and protected-floor changes

Only the account owner can withdraw its business cash, up to available cash. Only the lender can withdraw its funded, unreserved liquidity. Only the customer can withdraw its refundable customer credit.

The business owner may increase its floor only if the new floor plus existing cash holds is fully covered by business cash. It may reduce the floor only when it has no owner-authorized active participation/holds and no outstanding principal. An unapproved proposal naming an owner is not active participation.

An increased floor can restrict future voluntary repayment from existing business cash. It does not divert a sales order's already-authorized principal-first incoming receipt allocation. M1 does not claim that every borrower cash balance is automatically collectible by a lender.

## 7. Expiry, revocation, leaving and cancellation

### State boundaries

Persist the financial plan lifecycle as `OPEN`, `COMMITTED`, `CANCELLED` or `EXPIRED`. Readiness is derived. Loan outstanding/repaid state is separate. The sale's merchant goods/freight acknowledgments and full customer acceptance are separately recorded operational states; full customer acceptance gates subsequent sales balance collection without changing the fact that procurement has already committed.

The plan is valid only while `block.timestamp < effectiveExpiry`, where effective expiry is no later than the plan and all required offer/funding authorization deadlines. At equality it is expired for execution.

Time passage does not update storage or release funds by itself. An expired plan fails readiness and commit immediately. Anyone can call a bounded release command to materialize its expiry, release all of its reservations and make its customer advance refundable.

Until that command succeeds, aggregate booked holds remain encumbered. The UI must show them as expired/releasable, not silently count them as available while contract storage still reserves them. A wallet flow may prepare a release followed by a withdrawal; do not claim the withdrawal can bypass outstanding holds.

### Leaving and revoking a participant's funding

Before commit, a business may leave its participation. Release its own cash, borrower headroom, pool liquidity and supplier units once. Other participants' reservations remain in place; the fixed plan becomes unready until the participant validly rejoins or the plan is canceled/expires.

The lender may revoke a plan-specific uncommitted funding approval. Release the affected participant's entire reservation bundle, invalidate that funding approval and leave other participants' holds unchanged. It creates no debt. Reapproval and rejoining use a fresh reservation identity and remain subject to the original immutable plan and deadlines.

Revoking a loan approval after commit cannot cancel existing principal or claw back supplier payments. Only future/unconsumed authorization can be revoked.

### Supplier revocation and whole-plan cancellation

Revoking a required supplier offer or plan approval invalidates commit immediately. Anyone may release the affected invalid plan through the bounded cancellation/invalidation path. Offer-wide revocation can affect many plans; process each plan separately instead of iterating global history.

The coordinator or any required approving party may cancel an open plan. Cancellation releases every remaining reservation in that plan and makes its advance refundable. Record the initiating party and reason. A stranger may release only an objectively expired/invalid plan, not cancel another valid live plan.

Cancellation and expiry create refundable customer credit; they perform **no external refund transfer**. A separate customer withdrawal sends the refund later. A problem receiving a refund must not prevent other participants' reservations from being released. Customer escrow remains fully accounted until the actual withdrawal succeeds.

Revocation and commit are ordered by chain execution. If revocation executes first, commit fails. If commit executes first, a later revocation cannot retroactively undo it.

### After commit

M1 does not provide a cancellation button that refunds external supplier payments, restores lender cash, deletes debt or recreates capacity. A post-commit return/refund would require actual funds coming back and a separately authorized allocation policy. It is deferred.

Customer disputes, partial physical deliveries, goods returns, fees, interest, loan default, write-offs and legal enforcement are deferred. Do not label a financially committed group as delivered, or a repaid loan as proof of commercial fulfillment. Full-fill means complete financial execution of the plan. The sale additionally requires the merchant's full goods/freight acknowledgments and the customer's full acceptance before balance collection; those recorded assertions are not independent verification of physical delivery.

## 8. Repayment and collections

Both workflows use the same loan-principal allocation operation. They have two explicitly different funded sources.

### 8.1 Voluntary repayment from business free cash

The borrower chooses its own specific outstanding loan and an amount no larger than both outstanding principal and available business cash. Debit its cash and credit lender cash internally by that amount. The kernel's physical USDC balance is unchanged.

This must respect the protected floor and every other plan's cash holds. Do not silently spend protected cash, reserved cash, refundable customer advances or another business's cash.

For the group demo, receivable collection from the specified external source transfers actual USDC into the buyers' cash accounts first, with explicit source and receivable references. Collection increases cash and records collection against the referenced receivable; it does **not** reduce loan principal or automatically sweep cash to the lender. Do not attribute an unrelated or unsolicited transfer to a receivable. The buyers then separately authorize repayment of their own loans. The demonstration's recorded receivables and collections do not establish real commercial adoption or independently verified physical fulfillment.

### 8.2 Sales-order principal-first collection

Only after commit, the merchant's acknowledgment of all goods and freight, and recorded full acceptance by the named customer, can that customer pay up to the sale's remaining expected cash amount. Reject a preacceptance collection before pulling tokens, allocating claims or consuming its receipt reference. Do not treat that attempt as another advance or introduce a new preacceptance funds bucket. For an eligible collection, pull the actual USDC from the customer in the same transaction; then allocate:

`principalPayment = min(receiptAmount, thisOrderOutstandingPrincipal)`

`merchantCredit = receiptAmount - principalPayment`

Increase lender cash by principal payment, decrease the linked loan's principal by that amount, and increase merchant cash by the remainder. Existing protected cash is not used. A prior voluntary repayment reduces the outstanding amount before the next collection is allocated; never repay the original principal twice.

Partial monetary receipts are supported **after full customer acceptance**, even though procurement and operational acceptance are full-fill. Their cumulative amount cannot exceed the remaining 6,000 in the canonical sale. Reject overcollection rather than silently taking more than the remaining order amount. Require unique receipt references before pulling tokens.

`remainingExpectedCustomerCash = orderTotal - appliedAdvance - postCommitCollections`

Payment is not proof of delivery. The sale's collection eligibility comes from its recorded merchant acknowledgments and customer acceptance, not from a payment alone. Accounting projections must retain those distinct operational and financial events and must not treat commitment, acknowledgment, acceptance and collection as interchangeable.

## 9. Canonical fixtures and exact results

### 9.1 Collective purchase

All figures in this section are USDC amounts before conversion to micro-USDC.

| Buyer | Units | Initial cash | Protected floor | Own-cash hold | Credit reservation/draw | Supplier cost |
|---|---:|---:|---:|---:|---:|---:|
| A | 40 | 300 | 100 | 200 | 160 | 360 |
| B | 35 | 250 | 100 | 150 | 165 | 315 |
| C | 25 | 200 | 100 | 100 | 125 | 225 |
| Total | 100 | 750 | 300 | 450 | 450 | 900 |

The lender deposits 500. Each borrower has a 200 principal limit. Supplier price is 9 per unit and capacity/minimum fill is exactly 100. The independent external collection source starts with 1,000. A, B and C separately register their immutable opening receivables of 160, 165 and 125 against that payer, with the explicit demo-opening provenance described above. These registrations do not increase cash.

After A and B join: cash holds are 200 and 150, lender reservations total 325, supplier reserved units total 75, and every debt remains zero. The lender has 175 unreserved cash. C still has 100 available business cash.

After C joins: cash holds total 450, lender reservations total 450 and supplier reservations total 100. Cash balances and debts are unchanged.

After commit: supplier receives an external transfer of 900; each buyer retains 100 cash; lender cash is 50; buyer principal is 160/165/125; reservations are zero; supplier capacity consumed is 100. Kernel USDC is **350**, backing buyer cash 300 plus lender cash 50.

The external source then pays the recorded receivable collections of 160/165/125 into the respective buyer accounts, reducing its balance from 1,000 to 550. Kernel USDC increases to **800**. Buyer cash is 260/265/225 and debt is unchanged. In separate borrower-authorized repayment actions, each borrower repays its own principal internally: buyer cash returns to 100 each; lender cash returns to 500; principal is zero; kernel USDC remains **800**. Including the external supplier's 900 and the collection source's 550, total tracked USDC remains 2,250.

The lender-only-300 scenario must start from an actually funded 300 pool before those joins. A reserves 160, leaving 140; B's 165 request fails without a partial reservation. Do not reduce a live 500 pool to 300 while it already owes 325 of reservations. If a prior withdrawal funds this scenario, track the 200 outside the kernel.

### 9.2 Financed sales order

| Item | Amount |
|---|---:|
| Merchant initial cash | 3,000 |
| Merchant protected floor | 2,000 |
| Merchant own-cash contribution | 1,000 |
| Customer external initial cash | 10,000 |
| Total sales order | 10,000 |
| Customer advance required | 4,000 |
| Goods quantity and unit price | 100 units at 60 |
| Supplier payout | 6,000 |
| Freight quantity and unit price | 1 service unit at 500 |
| Logistics payout | 500 |
| Approved funded credit draw | 1,500 |
| Lender initial funded cash | 2,000 |

The merchant and lender deposits initially put **5,000** in the kernel. The customer then funds the actual 4,000 advance: kernel USDC becomes **9,000**, customer external cash becomes 6,000, and refundable advance escrow is 4,000. Merchant cash remains 3,000; its own available cash remains 1,000.

Reserve 1,000 merchant cash, 1,500 lender liquidity/headroom, **100 goods units** against the supplier offer, and **one freight service unit** against the logistics offer. These are distinct quantities attached to distinct offers. No debt exists yet. The lender's unreserved cash is 500.

Commit consumes 1,000 merchant cash, 4,000 customer escrow and 1,500 funded credit, and transfers 6,000 and 500 externally. Merchant cash is 2,000; lender cash is 500; outstanding merchant principal is 1,500; escrow is zero; remaining expected customer cash is 6,000. Kernel USDC is **2,500**.

After commit, the merchant records acknowledgment of the full 100 goods units and the completed one-unit freight service. The customer then records full acceptance. These acknowledgments change no cash balance or principal. Only then may the remaining customer balance be collected.

The customer's subsequent actual 6,000 collection increases kernel USDC to **8,500**. Allocate 1,500 to lender cash and 4,500 to merchant cash. Merchant cash becomes **6,500**, lender cash **2,000**, and outstanding principal becomes zero. Customer external cash is zero; supplier/logistics external cash totals 6,500. Total tracked USDC remains **15,000**.

These are zero-interest, zero-business-fee fixtures. Gas is funded and recorded separately. The increase of merchant cash from 3,000 to 6,500 is the fixture's 3,500 commercial surplus before omitted costs; it is not independently verified accounting profit or revenue-recognition advice.

## 10. Arc USDC, gas and event treatment

Use the official network/token configuration supplied elsewhere in this pack. At initialization, validate the intended network, token and six-decimal ERC-20 assumptions. Use integer arithmetic and decimal strings at the application boundary; never JavaScript floating-point numbers for money.

Arc's native USDC view uses 18 decimals and its ERC-20 view uses six; they represent the same underlying funds. Use the ERC-20 view consistently for the kernel's application accounting. Do not wrap USDC, add native and ERC-20 balances together, or accept a native `msg.value` deposit as though it were an ERC-20 deposit. Use nonpayable entry points and reject unsupported native deposit paths.

Gas is paid by the transaction submitter's external wallet, outside kernel claims. Do not reimburse it from protected funds, loan reservations or customer escrow in M1. A failed transaction can leave every business-state value unchanged while consuming external wallet gas.

Use kernel domain events as the source for internal cash reallocations. For external ERC-20 movements, filter the configured ERC-20 emitter and its six-decimal units. Arc can also emit an 18-decimal system transfer event for the same movement; do not count the two as independent transfers. Gas deductions are not a second business transfer.

Official reference for this distinction: [Arc stablecoin native model](https://docs.arc.io/arc/concepts/stablecoin-native-model). The kernel does not depend on CallFrom or Multicall3From: its ordinary transaction performs the authorized multi-party state transition. See [Arc batched transactions](https://docs.arc.io/arc/concepts/batched-transactions) for why sender-preserving EOA batching is a different capability.

## 11. Reentrancy, expiry and approval tradeoffs

- Use a consistent non-reentrant boundary around money-moving commands and reservation/commit transitions. Validate first, then record state effects, then perform external token interactions; any failure reverts the transaction. Do not expose a second mutation path that observes half-consumed reservations.
- Transfers use the configured USDC contract and fixed plan payees. Use safe transfer semantics; never interpret a failed/false token transfer as successful payment. An external payout failure makes the entire plan commit fail. No partial-success flag is allowed.
- For actual deposits and collections, credit only successfully received amounts. Validate the expected balance change for the fixed token path rather than letting a client-provided receipt amount create credit.
- Explicit onchain approvals require more transactions than signatures, but avoid offchain signature expiry/replay/verification complexity in M1. Show each required party's approval separately. One operator possessing several demo keys is a controlled demonstration, not proof of independent commercial adoption.
- Firm per-buyer capacity holds can fragment an offer across incomplete groups. Use clear expiry/cancellation and show held/releasable units. M1 does not implement a fairness scheduler or promise that all incomplete groups can fill.
- Quote and funding revocation remain possible before commit. Reservations are firm accounting encumbrances while valid, not an irrevocable guarantee that a counterparty will never cancel. If stronger irrevocable promises are desired later, that requires a different commercial policy.
- Expiry release is permissionless but transaction-driven. Do not add unbounded background loops. Display stale-but-booked holds accurately until released.
- Immutability deliberately removes administrator fixes and fund sweeps. Bugs would require a new deployment and an explicit user-controlled exit/migration design; M1 must not imply an invisible recovery capability.

## 12. Required acceptance cases

These are behavioral acceptance criteria for the build and prompt pack. They are not a request for a broad production certification suite. Use exact integer assertions and state snapshots where a failure must leave state unchanged.

| ID | Action or condition | Required result |
|---|---|---|
| DC-01 | Seed the group fixture and join A then B. | A/B cash unchanged; holds 200/150; credit reservations 160/165; capacity held 75; debt zero; pool free 175. |
| DC-02 | Join C. | Holds total 450 cash, 450 credit and 100 units; all debts remain zero; readiness true. |
| DC-03 | Repeat an already active join. | No second cash, credit or capacity reservation and no changed financial totals. |
| DC-04 | Fund the lender with only 300 before joining A and B. | A succeeds; B fails because only 140 remains, with no partial B reservation or debt. |
| DC-05 | Try to reserve another plan using already held business cash. | Reject without changing either plan's existing reservations. |
| DC-06 | Try to reserve another plan using already held lender liquidity/headroom. | Reject even if each plan separately appears below an individual nominal limit. |
| DC-07 | Set supplier offer capacity to 99 before joins; attempt A/B/C. | A/B can reserve 75; C's 25 fails; no full group commit is possible. |
| DC-08 | Two plans reserve units from the same offer. | Their aggregate reserved plus consumed units never exceeds capacity. |
| DC-09 | A leaves before commit, then the release is retried. | Release exactly 200 cash, 160 credit and 40 units once; cash balances and debt unchanged. |
| DC-10 | The block timestamp equals the effective deadline. | New joins and commit fail; readiness reports expiry. |
| DC-11 | Release an expired plan twice. | First release frees the booked holds and makes any advance refundable; second does not create money or subtract again. |
| DC-12 | Revoke B's uncommitted funding approval. | B's reservation bundle releases; other holds remain; plan unready; debt stays zero. |
| DC-13 | Revoke a required supplier offer. | Commit fails immediately; bounded invalidation releases the affected plan without altering unrelated plans. |
| DC-14 | Commit the complete group. | External supplier receives 900; buyer cash 100 each; lender cash 50; loans 160/165/125; kernel USDC 350. |
| DC-15 | Replay group commit or submit another request ID for that plan. | No second payout, debt, capacity consumption or ledger debit. |
| DC-16 | Cause the final external payout of a plan to fail. | All payouts and all state changes from the commit revert; external gas may still be spent. |
| DC-17 | Seed sale merchant 3,000 and lender 2,000; fund customer advance 4,000. | Kernel holds 9,000; escrow 4,000; merchant free cash remains 1,000; customer external cash 6,000. |
| DC-18 | Try to use the customer advance as merchant free cash before commit. | Every withdrawal, other-plan reservation and manual repayment path rejects that use. |
| DC-19 | Reserve the sale. | Merchant cash hold 1,000; lender reservation 1,500; 100 goods units held on the supplier offer and one freight service unit held on the separate logistics offer; principal still zero. |
| DC-20 | Commit the sale. | External payouts 6,000/500; kernel 2,500; merchant cash 2,000; lender cash 500; debt 1,500; escrow zero. |
| DC-21 | Record merchant acknowledgment of all 100 goods units and the one freight service, then full customer acceptance; collect the customer's actual remaining 6,000. | Kernel 8,500; merchant cash 6,500; lender cash 2,000; debt zero; remaining expected cash zero. |
| DC-22 | After those merchant acknowledgments and full customer acceptance, instead collect 600, then 5,400. | First receipt reduces principal to 900 and leaves merchant cash 2,000; final state matches DC-21. |
| DC-23 | Reuse a receipt reference, including with different payload. | No extra token pull or allocation; conflicting fields fail. |
| DC-24 | After full customer acceptance, try to collect more than the sale's remaining expected cash. | Reject before taking the excess tokens. |
| DC-25 | Attempt voluntary repayment from the merchant's protected 2,000 after commit. | Reject; protected cash and debt remain unchanged. |
| DC-26 | Make a valid voluntary repayment, complete merchant acknowledgments and full customer acceptance, then collect the sale. | The receipt pays only remaining principal; no double repayment of the original 1,500. |
| DC-27 | Attempt a business withdrawal above available cash, including another plan's holds. | Reject on every outflow path; there is no alternative transfer bypass. |
| DC-28 | Attempt lender withdrawal above unreserved funded cash. | Reject; outstanding loans and reserved liquidity are not available cash. |
| DC-29 | Reduce a protected floor during active participation or debt. | Reject. A fully backed increase succeeds; an unbacked increase fails. |
| DC-30 | Name another account in an unapproved draft plan. | That account's cash and floor-setting permissions remain unaffected. |
| DC-31 | Cancel an open funded sale. | Release holds, create exactly 4,000 refundable customer credit, no debt; physical kernel balance stays 9,000 until refund withdrawal. |
| DC-32 | Customer withdraws that refund and retries. | First withdrawal sends 4,000 and leaves kernel 5,000; retry cannot pay again. |
| DC-33 | Attempt cancellation or debt erasure after successful supplier payment. | No automatic refund, pool restoration, capacity restoration or principal deletion. |
| DC-34 | Deposit unrequested USDC directly to the kernel. | Creates surplus only, not business/lender cash or an administrator withdrawal right; backing inequality remains valid. |
| DC-35 | Try unauthorized approval, withdrawal, recipient change or arbitrary external call. | Reject; immutable plan terms and ownership boundaries hold. |
| DC-36 | Observe both native-system and ERC-20 transfer events for one Arc transfer. | Count the application transfer once; internal ledger and UI money values remain six-decimal exact. |
| DC-37 | Display Ready, then consume/revoke a prerequisite before commit executes. | Commit rechecks and fails safely; no reliance on stale UI readiness. |
| DC-38 | Execute the group's actual 450 receivable collections, then separate borrower repayments. | Collections first leave debt unchanged and credit buyer cash to 260/265/225. After repayments, source cash is 550; buyer cash 100 each; lender cash 500; kernel 800; supplier external 900; total 2,250. |
| DC-39 | Competing transactions try to consume the same remaining cash, credit or capacity. | Chain ordering permits only the valid first consumption; the other fails without over-allocation. |
| DC-40 | Advance time, edit UI status, or mark an offchain invoice paid without transferring money. | No cash, principal, escrow or capacity changes occur. |
| DC-41 | On one kernel, fund a shared lender pool with 1,900. Reserve the sale's 1,500, then group A's 160 and B's 165. Try group C's 125. | The shared pool has only 75 free, so C fails without a partial hold. After an actual additional 50 lender deposit, C succeeds and aggregate reservations are 1,950 with zero free liquidity. Both workflow commits then consume their own holds correctly in either order. |
| DC-42 | On one kernel, use the same business account as the sale's merchant and one group's A participant. Give it 3,000 cash, a 2,000 floor, sufficient approved credit and sufficient lender liquidity; reserve the sale's 1,000 own contribution, then try A's 200 group contribution. | The group join fails on shared available cash. No template-specific second balance exists. Releasing the sale's participation permits the group reservation if all other requirements remain valid. |
| DC-43 | After procurement commit, attempt sales balance collection before full customer acceptance, including after just one merchant acknowledgment. | Revert before token transfer, cash/claim allocation or receipt-reference consumption. No extra advance or unallocated customer funds are created. |
| DC-44 | Attempt customer acceptance before both merchant acknowledgments, an acknowledgment by an unauthorized caller, or a partial acknowledgment; then record the valid full sequence and retry identical acknowledgments. | Invalid transitions fail. Valid sequence records merchant goods quantity 100, freight service quantity 1 and full acceptance by the named customer. Acknowledgments and their retries move no cash and change no debt; only the completed sequence enables subsequent collections. |
| DC-45 | A/B/C owners register their fixture opening receivables of 160/165/125 with immutable IDs, their beneficiary accounts and the bound external source funded with 1,000. | Each remaining cap equals its opening amount; explicit demo provenance is recorded; business cash, lender cash and loan principal are unchanged. A stranger cannot register or edit a receivable for another account. |
| DC-46 | The bound external source calls each registered receivable's collection command with ERC-20 allowance and actual funds. | USDC is transferred from that source; only the fixed buyer beneficiary is credited; its remaining receivable decreases; `ReceivableCollected` contains the correct attribution; debt remains unchanged until a separate borrower repayment. |
| DC-47 | Try an unauthorized payer, duplicate/conflicting collection reference, zero amount or amount above a registered receivable's remaining cap. | Revert before transfer, reference consumption, receivable reduction or cash credit. A direct unsolicited transfer cannot satisfy the receivable collection. |
| DC-48 | Toggle an offchain acceptance/AR flag, use acceptance for another plan/version, or call acceptance as anyone other than the sale's named customer. | The onchain sale remains ineligible for balance collection. Only its authenticated, correctly sequenced onchain acknowledgments and customer acceptance satisfy the gate. |
| DC-49 | Exercise join, duplicate join, failed join, leave/rejoin, lender revocation, cancellation, expiry cleanup and commit for an owner's participation. | Increment active participation once per successful reservation generation and decrement once per consumed/released bundle. Retries never underflow or leave stale counts. After commit the count releases, debt independently locks floor reductions; after full repayment and no other active holds the owner can reduce the floor. Draft naming never locks it. |

## 13. Explicit exclusions for subsequent prompts

Do not add multi-currency conversion, crosschain funding, unsecured lending APIs, automated underwriting, interest accrual, tokenized receivable trading, asset seizure, upgrade governance, generalized smart-account execution, offchain signatures, partial procurement fills or post-commit refunds to M1.

Keep the shared model extensible through precise domain boundaries rather than speculative implementations. The two workflows must use the same financial core and the same invariant checks. Any exception introduced for one demo fixture is a design failure to resolve, not a reason to duplicate settlement logic.
