# Accounting, state invariants and acceptance checks

Status: implementation specification for the proposed M1. Prepared 26 October 2026.

This document defines simplified bookkeeping for two fictional demonstrations. The examples omit tax, interest, fees, FX, impairment calculations and financing adjustments. Their purpose is to make the product's financial claims consistent and testable. Statutory reporting remains outside this release.

The existing collective-purchase HTML remains an M0 simulation. This specification extends the fixtures and must not be presented as functionality already implemented, built in Arc Studio, or verified onchain.

## 1. Decisions that implementations must preserve

- One settlement kernel holds actual USDC. Independently authorized logical accounts hold claims on that funded pool.
- A business's claim on the kernel is its asset. The kernel records a corresponding obligation to that business. Do not count both as two amounts of physical USDC.
- Customer money awaiting the sales commitment stays in a dedicated, refundable escrow claim. The customer initially holds funds in an external wallet. The customer does not receive a general-purpose free-balance account in this fixture.
- Before commitment, the merchant owns neither the customer's escrow nor an advance from that customer. At commitment, the authorized release becomes an advance to the merchant and funds the specified purchase.
- Joining, quoting, approving, earmarking and reserving credit do not create loans, sales or expenses.
- Debt arises only when funded credit is drawn. A funded but undrawn lender reservation is not borrower cash or borrower debt.
- Supplier payment is initially a prepayment. It does not establish physical receipt of inventory.
- In the sales fixture, the 500 logistics charge is specifically inbound freight needed to bring the goods to their intended location and condition. It is capitalized with the 6,000 goods cost only after the required receipt and service evidence exists.
- Customer acceptance is the fixture's agreed evidence of transfer of control and an unconditional right to the remaining sale consideration. Revenue is not recognized merely because a quote, order, payment or delivery claim exists.
- The sales balance collection is permitted only after recorded full customer acceptance and the corresponding recognized receivable. Actual USDC enters from the customer's external wallet and the authorized principal-first waterfall credits the lender's internal funded claim. Partial receipts are permitted after acceptance.
- Group opening-receivable collections credit the respective buyer's funded claim and reduce that receivable. Principal repayment is a separate buyer-authorized operation. There is no automatic group collection waterfall.
- Cancelling before sales commitment releases holds and makes the customer's escrow credit withdrawable. It does not send money. A separate customer withdrawal transfers the escrow back. Postcommit refund processing is outside M1.
- Unsolicited transfers create reconciliation exceptions and unallocated surplus in M1. They cannot be attributed, returned, rescued or used to repay principal through an M1 command.
- An external lender withdrawal is separate from any repayment that credits the lender's internal funded claim.
- Payment, loan and claim updates within the final financial commitment are atomic onchain. Physical shipment, external bank redemption, external ERP projections and statutory books are outside that execution boundary.
- All quantities and money calculations use exact integers. The displayed amounts below are USDC units, not integer atomic units. The asset adapter must explicitly handle the selected USDC interface and its decimals; never use floating-point arithmetic or silently mix six-decimal token amounts with eighteen-decimal native units.

## 2. Keep four kinds of state separate

| State | Example | Accounting or execution consequence |
|---|---|---|
| Physical funds | USDC actually held by the kernel or an external wallet | Contributes to physical cash conservation |
| Funded account claims | Merchant claim of 3,000 on the kernel | Asset for the owner and matching kernel obligation |
| Commercial and financial balances | Customer advance, supplier prepayment, receivable, loan principal | Separate assets or liabilities; not additional physical funds |
| Memo and authorization state | Quote, purchase commitment, payroll protection, cash hold, credit reservation | Constrains execution; does not by itself create an accounting expense or loan |

A payroll allocation is a restriction on use of an existing funded claim. It is not a second asset. If a payroll liability also exists, do not subtract both the liability and a hold covering that same liability when calculating availability.

Reserved cash is part of the owner's total claim:

~~~text
owner total cash claim
  = available cash + protected cash + other disjoint cash holds

lender total cash claim
  = available lender cash + undrawn funded reservations

kernel USDC
  = all owner cash claims
  + customer escrow claims, including cancelled-order refundable credits
  + observed unallocated surplus
~~~

These categories must be disjoint. In particular, do not add held cash a second time to an owner's total claim. Borrower debt and lender loan receivables are not assets backing the kernel's withdrawable cash claims.

Unallocated surplus is the excess actual USDC observed above known funded claims and escrow. It is a reconciliation difference, not an additional spendable claim, assigned customer liability or revenue. It is zero in both authorized fixture paths. M1 reports unexpected excess funds without an attribution, rescue or return function. A deficit is a reconciliation failure; never conceal it as negative surplus. A production reconciliation must also identify every other legitimate liability, asset movement and fee.

## 3. Customer-order flagship

### 3.1 Fixed commercial assumptions

| Item | Amount |
|---|---:|
| Sale consideration | 10,000 |
| Customer refundable escrow before commitment | 4,000 |
| Customer balance payable after acceptance | 6,000 |
| Merchant opening funded claim | 3,000 |
| Protected merchant cash | 2,000 |
| Merchant own contribution to the order | 1,000 |
| Supplier quote: 100 goods units at 60 each | 6,000 |
| Inbound freight quote: 1 service unit at 500 | 500 |
| Actual approved credit draw | 1,500 |
| Lender opening funded claim | 2,000 |
| Customer opening external USDC | 10,000 |

The required draw is exactly:

~~~text
6,000 goods + 500 freight - 4,000 authorized escrow - 1,000 own contribution
  = 1,500 credit
~~~

The separate lender claim contains enough real funding. Its undrawn reservation is 1,500, leaving 500 available. An approval without that actual funded capacity cannot satisfy the fixture.

The customer's 4,000 is counted once. It is separate escrow before commitment and is consumed as a funding source at commitment. Do not add it to a merchant balance that already includes its release and then add it again as another funding source.

### 3.2 Physical balances and internal claims

All amounts in this table are exact. The lender column is an internal funded claim, not an external lender wallet.

| Checkpoint | Kernel USDC | Merchant claim | Lender claim | Customer escrow claim | Customer external USDC | Supplier external USDC | Freight provider external USDC | Loan principal |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Opening | 5,000 | 3,000 | 2,000 | 0 | 10,000 | 0 | 0 | 0 |
| Customer funds escrow | 9,000 | 3,000 | 2,000 | 4,000 | 6,000 | 0 | 0 | 0 |
| Financial commitment | 2,500 | 2,000 | 500 | 0 | 6,000 | 6,000 | 500 | 1,500 |
| Goods received and customer acceptance recorded | 2,500 | 2,000 | 500 | 0 | 6,000 | 6,000 | 500 | 1,500 |
| Customer pays remaining 6,000; principal waterfall completes | 8,500 | 6,500 | 2,000 | 0 | 0 | 6,000 | 500 | 0 |

At each checkpoint:

~~~text
kernel + customer external + supplier external + freight provider external
  = 15,000
~~~

Internal claims are not added again to that physical total. At the final checkpoint, the kernel's 8,500 is backed by merchant and lender claims of 6,500 and 2,000 respectively.

### 3.3 Opening books

For the simplified fixture, use opening equity as the balancing account. It represents balances established before this scenario, not revenue or a new payment.

| Entity | Debit | Credit |
|---|---|---|
| Merchant | Funded kernel claim 3,000 | Opening equity 3,000 |
| Lender | Funded kernel claim 2,000 | Opening equity 2,000 |
| Customer | External USDC asset 10,000 | Opening equity 10,000 |
| Kernel | USDC asset 5,000 | Due to merchant 3,000; due to lender 2,000 |

The merchant and lender deposits that established those kernel claims precede the opening checkpoint. Do not post them a second time when loading the fixture.

Record this opening checkpoint immutably at the end of a finalized block: chain ID, kernel address, block number and hash, fixture version, posting-rule version, and the complete opening snapshot of cash claims, escrow, receivables, payables and equity. Snapshot the customer's external 10,000 at the same boundary. Replay financial postings only from events in blocks strictly after that checkpoint. Raw older history may be retained for evidence, but the seed deposits already included in opening balances are excluded from posting again. Section 7.3 applies the same rule to both fixtures.

### 3.4 Customer funds refundable escrow

The customer sends 4,000 real USDC from its external wallet to the kernel.

| Entity | Debit | Credit |
|---|---|---|
| Customer | Refundable escrow claim 4,000 | External USDC asset 4,000 |
| Kernel | USDC asset 4,000 | Refundable customer escrow obligation 4,000 |
| Merchant | No entry | No entry |
| Lender | No entry | No entry |

The fixture explicitly assigns the escrow claim to the customer until commitment. Therefore the merchant has no advance liability at this stage. Do not generalize this treatment to a different escrow arrangement with different rights.

Reservations of the merchant's 1,000 and the lender's 1,500 are memo-state changes. No principal exists yet. The customer's 4,000 cannot fund another order or another customer.

### 3.5 Financial close

The onchain commitment consumes the approved escrow, merchant contribution and lender reservation, pays the supplier and freight provider, registers the order allocation, creates principal and emits the canonical financial event. Every required operation succeeds or the financial close reverts.

The merchant's combined entry is:

| Debit | Credit |
|---|---|
| Supplier prepayment 6,000 | Funded kernel claim 1,000 |
| Inbound freight prepayment 500 | Loan payable 1,500 |
| | Customer advance liability 4,000 |
| **Total 6,500** | **Total 6,500** |

This combined entry accurately records payment made on the merchant's behalf. Do not invent intermediate merchant cash receipts that the chosen kernel implementation did not create.

Other entities record:

| Entity | Debit | Credit |
|---|---|---|
| Customer | Advance to merchant 4,000 | Refundable escrow claim 4,000 |
| Lender | Loan receivable from merchant 1,500 | Funded kernel claim 1,500 |
| Supplier | External USDC asset 6,000 | Advance received for goods 6,000 |
| Freight provider | External USDC asset 500 | Advance received for freight service 500 |
| Kernel | Due to merchant 1,000; due to lender 1,500; refundable customer escrow obligation 4,000 | USDC asset 6,500 |

The supplier's and freight provider's receipts are shown as advances until their agreed performance occurs. Their own operating costs are outside the fixture and must not be invented.

After close, the merchant has assets of 8,500:

- Funded kernel claim 2,000.
- Supplier prepayment 6,000.
- Freight prepayment 500.

It has liabilities of 5,500 and opening equity of 3,000:

- Customer advance liability 4,000.
- Loan payable 1,500.
- Opening equity 3,000.

Assets equal liabilities plus equity. Payroll protection remains funded by the merchant's 2,000 claim.

### 3.6 Goods and inbound freight are received

Use separately authorized evidence that the goods and specified inbound freight service have been received. Payment alone is insufficient.

| Entity | Debit | Credit |
|---|---|---|
| Merchant | Inventory 6,500 | Supplier prepayment 6,000; inbound freight prepayment 500 |
| Supplier | Advance received for goods 6,000 | Goods revenue 6,000 |
| Freight provider | Advance received for freight service 500 | Freight service revenue 500 |

The supplier and freight entries assume the fixture's specified performance conditions have been met. The system must not assert that a merchant receipt event universally establishes another entity's statutory revenue treatment.

If goods and freight evidence arrive at different times, preserve the separate pending balances. Do not capitalize a freight prepayment for a service that has not occurred.

### 3.7 Customer acceptance and revenue recognition

For this fixture, customer acceptance establishes transfer of control and the unconditional right to the remaining 6,000.

| Entity | Debit | Credit |
|---|---|---|
| Merchant | Customer advance liability 4,000; accounts receivable from customer 6,000 | Sales revenue 10,000 |
| Merchant | Cost of goods sold 6,500 | Inventory 6,500 |
| Customer | Purchased inventory 10,000 | Advance to merchant 4,000; accounts payable to merchant 6,000 |

This creates 3,500 gross profit in the merchant's simplified books. It does not create 10,000 cash. The receivable remains an unpaid asset until collection.

An invoice draft, uploaded delivery document, token transfer or AI-generated acceptance summary cannot independently trigger this entry. The versioned evidence and authorized actor must satisfy the fixture's acceptance policy.

### 3.8 Collection and principal waterfall

The order must first have recorded full customer acceptance and the recognized 6,000 receivable. Reject any designated balance-collection attempt before that transition, before transferring funds or changing principal. A delivery claim or partial acceptance does not satisfy this gate. Eligibility follows the canonical acceptance and receivable state; it does not wait for an external ERP projection to finish synchronizing.

Once eligible, the customer sends 6,000 actual USDC from its external wallet through the designated collection command. The command attributes the receipt to the recognized outstanding order balance and applies the approved principal-first waterfall. The same gate applies to every partial receipt.

The merchant can display the gross entries:

| Debit | Credit |
|---|---|
| Funded kernel claim 6,000 | Accounts receivable 6,000 |
| Loan payable 1,500 | Funded kernel claim 1,500 |

An equivalent combined entry is:

| Debit | Credit |
|---|---|
| Funded kernel claim 4,500; loan payable 1,500 | Accounts receivable 6,000 |

Choose one posting representation. Do not post both representations.

Other entities record:

| Entity | Debit | Credit |
|---|---|---|
| Customer | Accounts payable to merchant 6,000 | External USDC asset 6,000 |
| Lender | Funded kernel claim 1,500 | Loan receivable 1,500 |
| Kernel | USDC asset 6,000 | Due to merchant 4,500; due to lender 1,500 |

Principal repayment credits a funded lender claim. It is not an external 1,500 token transfer to the lender. A later lender withdrawal must debit that claim and transfer actual USDC out of the kernel.

For an incoming attributed amount x:

~~~text
principal repayment = min(x, eligible outstanding principal)
merchant retained amount = x - principal repayment
~~~

The actual receipt is bounded by the authorized outstanding customer balance. M1 rejects an overpayment through this command; it does not create revenue or redirect excess to another order. Two authorized receipts of 3,000 after full acceptance are permitted. The first repays 1,500 principal and credits the merchant 1,500, leaving merchant claim 3,500, lender claim 2,000 and receivable 3,000. The second credits the merchant 3,000 and completes collection.

The final merchant balance is 6,500, comprising opening capital 3,000 plus gross profit 3,500. It is not 6,500 profit. Its protected 2,000 remains within the 6,500 funded claim.

## 4. Cancellation, refund and default

### 4.1 Before financial commitment

Cancellation releases undrawn merchant, supplier-capacity and lender reservations and makes the customer's 4,000 escrow credit refundable. Cancellation is a state transition only. It creates no cash movement, principal or financial journal. The same 4,000 customer escrow asset and matching kernel obligation remain outstanding; changing its withdrawal eligibility must not credit it a second time.

Immediately after cancellation, the kernel still holds 9,000: merchant claim 3,000, lender claim 2,000 and refundable customer credit 4,000. The customer still holds 6,000 externally. The cancelled order cannot subsequently commit.

The customer then separately authorizes withdrawal of its refundable credit. Only that withdrawal sends the actual 4,000 and creates these journals:

| Entity | Debit | Credit |
|---|---|---|
| Customer | External USDC asset 4,000 | Refundable escrow claim 4,000 |
| Kernel | Refundable customer escrow obligation 4,000 | USDC asset 4,000 |

Merchant and lender books have no loan or customer advance to reverse. After the withdrawal, the kernel returns to 5,000; customer external funds return to 10,000; merchant and lender claims remain 3,000 and 2,000. The refundable credit is consumed exactly once. A failed or repeated withdrawal cannot destroy an unpaid credit or send another 4,000.

If escrow funding happened in an earlier transaction, a failed financial close does not undo that earlier funding. The 4,000 remains customer escrow. A later successful close may consume it; otherwise the cancellation and separate withdrawal path is required. The UI must distinguish failed close, cancelled with refundable credit, and completed withdrawal.

### 4.2 After financial commitment

Changing the order status to cancelled cannot reverse actual supplier payments, erase debt or restore cash.

M1 rejects the precommit cancellation operation after a financial close. It preserves the actual supplier and freight payments, the customer's advance and all outstanding principal. A request, document or claimed refund cannot reset those balances.

Postcommit refund orchestration, partial recovery allocation, customer refund distribution and a full unwind are outside M1. Do not add a refund engine or present an unsupported refund process as completed. If someone sends funds back directly, M1 reports the actual excess as an unallocated-surplus reconciliation exception under Section 6; it does not infer a merchant credit, repayment or customer refund.

Appendix A gives educational future journals for actual verified recoveries. It is explicitly outside the M1 implementation and acceptance scope.

### 4.3 Default or dispute

If the customer does not pay the remaining 6,000 after acceptance, retain the 6,000 receivable and 1,500 loan principal. Do not mark either paid based on a forecast. Impairment, write-off, restructuring and legal recovery are separate authorized processes outside the initial fixture.

If the supplier fails before delivery, retain the real supplier payment and the resulting recovery claim. Do not recognize the customer's remaining 6,000 as receivable merely to cover the funding gap when the required performance has not occurred.

The payroll floor is an application spending constraint. It does not establish global solvency or immunity from legal creditor claims.

## 5. Collective-purchase fixture

### 5.1 Explicit extension of M0

The original M0 collection button used a labeled synthetic external source. M1 uses documented opening receivables of 160, 165 and 125, owed to A, B and C by a separate customer with 1,000 external USDC.

These receivables exist before this group purchase. Their amounts deliberately match the demonstration loan principal so the repayment path is easy to inspect. They are not new sales created by borrowing or by clicking collect.

| Buyer | Units | Opening kernel claim | Protected claim | Own contribution | Loan draw | Purchase prepayment | Opening receivable |
|---|---:|---:|---:|---:|---:|---:|---:|
| A | 40 | 300 | 100 | 200 | 160 | 360 | 160 |
| B | 35 | 250 | 100 | 150 | 165 | 315 | 165 |
| C | 25 | 200 | 100 | 100 | 125 | 225 | 125 |
| Total | 100 | 750 | 300 | 450 | 450 | 900 | 450 |

The lender begins with a 500 funded claim. Each buyer has an individual approved principal cap of 200. The fixed quote requires exactly 100 units at 9 each and has capacity for exactly 100.

### 5.2 Opening books and conservation

| Entity | Debit | Credit |
|---|---|---|
| A | Funded kernel claim 300; opening accounts receivable 160 | Opening equity 460 |
| B | Funded kernel claim 250; opening accounts receivable 165 | Opening equity 415 |
| C | Funded kernel claim 200; opening accounts receivable 125 | Opening equity 325 |
| Lender | Funded kernel claim 500 | Opening equity 500 |
| Separate customer | External USDC asset 1,000 | Opening payable to A 160; to B 165; to C 125; opening equity 550 |
| Kernel | USDC asset 1,250 | Due to A 300; due to B 250; due to C 200; due to lender 500 |

The customer's opening payable is 450 in total, split into A160, B165 and C125, and its opening equity is 550. The opening receivables and payables are mirrored and balance. Their prior-period origin must be identified in the fixture. They do not increase physical funds.

The group fixture has its own immutable finalized opening checkpoint and version. Its snapshot contains kernel USDC 1,250, buyer and lender claims, each buyer's opening receivable and equity, the customer's external 1,000, its per-payee opening payables and equity 550. Seed deposits before that checkpoint are evidence, not new replay postings.

~~~text
opening physical funds = kernel 1,250 + external customer 1,000 = 2,250
~~~

### 5.3 Joining and final commitment

Joining reserves each contribution and loan amount without moving funds or creating principal. When all buyers have joined, the lender still owns a 500 cash claim, of which 450 is reserved and 50 is available.

The final commitment records:

| Entity | Debit | Credit |
|---|---|---|
| A | Supplier prepayment 360 | Funded kernel claim 200; loan payable 160 |
| B | Supplier prepayment 315 | Funded kernel claim 150; loan payable 165 |
| C | Supplier prepayment 225 | Funded kernel claim 100; loan payable 125 |
| Lender | Loan receivable A 160; B 165; C 125 | Funded kernel claim 450 |
| Supplier | External USDC asset 900 | Advances received A 360; B 315; C 225 |
| Kernel | Due to A 200; due to B 150; due to C 100; due to lender 450 | USDC asset 900 |

The kernel then holds 350, backing buyer claims of 100 each and a lender claim of 50. The supplier holds 900. The customer still holds 1,000 externally. Physical funds remain 2,250.

Allocations are exactly A40, B35 and C25. Neither 75 nor 101 units satisfies this fixed quote. Do not silently reprice, partially fill an overlarge join, or borrow more to replace a missing buyer.

### 5.4 Receipt of goods

On the agreed authorized goods-receipt evidence:

| Entity | Debit | Credit |
|---|---|---|
| A | Inventory 360 | Supplier prepayment 360 |
| B | Inventory 315 | Supplier prepayment 315 |
| C | Inventory 225 | Supplier prepayment 225 |
| Supplier | Advances received 900 | Goods revenue 900 |

The buyers have not sold these goods in this fixture. Do not create buyer revenue or recognize their inventory as cost of goods sold.

### 5.5 Collection of opening receivables, then separate repayment

These are two separate authorized operations and two separate economic posting events. There is no automatic group principal waterfall. The opening receivables are already recognized before this group purchase, so their collection does not depend on receipt of the newly purchased goods.

First, the separate customer pays 160 against A's specified opening receivable, 165 against B's and 125 against C's. Each payment transfers actual external USDC into the kernel, credits that buyer's funded claim and reduces only that buyer's opening receivable. The corresponding customer payable is reduced by the same amount.

| Entity and collection | Debit | Credit |
|---|---|---|
| A: receive payment of its opening receivable | Funded kernel claim 160 | Opening accounts receivable 160 |
| B: receive payment of its opening receivable | Funded kernel claim 165 | Opening accounts receivable 165 |
| C: receive payment of its opening receivable | Funded kernel claim 125 | Opening accounts receivable 125 |
| Separate customer: pay A | Opening payable to A 160 | External USDC asset 160 |
| Separate customer: pay B | Opening payable to B 165 | External USDC asset 165 |
| Separate customer: pay C | Opening payable to C 125 | External USDC asset 125 |
| Kernel: collect A's receipt | USDC asset 160 | Due to A 160 |
| Kernel: collect B's receipt | USDC asset 165 | Due to B 165 |
| Kernel: collect C's receipt | USDC asset 125 | Due to C 125 |

After all three collections and before any repayment:

~~~text
kernel USDC = 800
buyer funded claims = A260 + B265 + C225 = 750
lender funded claim = 50
customer external USDC = 550
buyer principal = A160 + B165 + C125 = 450
opening customer receivables and payables = 0
~~~

The lender has not been repaid at this point. Each buyer then separately authorizes repayment from its own available funded claim. The command checks outstanding principal, funded availability, other holds and the protected 100 floor. It cannot debit another buyer or protected funds.

| Entity and repayment | Debit | Credit |
|---|---|---|
| A: authorize principal repayment | Loan payable 160 | Funded kernel claim 160 |
| B: authorize principal repayment | Loan payable 165 | Funded kernel claim 165 |
| C: authorize principal repayment | Loan payable 125 | Funded kernel claim 125 |
| Lender: receive A's principal | Funded kernel claim 160 | Loan receivable A 160 |
| Lender: receive B's principal | Funded kernel claim 165 | Loan receivable B 165 |
| Lender: receive C's principal | Funded kernel claim 125 | Loan receivable C 125 |
| Kernel: move A's funded claim | Due to A 160 | Due to lender 160 |
| Kernel: move B's funded claim | Due to B 165 | Due to lender 165 |
| Kernel: move C's funded claim | Due to C 125 | Due to lender 125 |

These repayments move internal funded claims; kernel USDC remains 800. The separate customer has no repayment journal because its debt to the buyers was already discharged by its payments. Do not combine collection and repayment into one journal source or imply they happened atomically together.

Terminal balances after all separately authorized repayments:

~~~text
kernel USDC = 800
buyer funded claims = A100 + B100 + C100 = 300
lender funded claim = 500
supplier external USDC = 900
customer external USDC = 550
buyer principal = 0
opening customer receivables and payables = 0
physical total = 800 + 900 + 550 = 2,250
~~~

After goods receipt, collection and separate repayment, A has assets of 460, B415 and C325, matching their opening equity. There is no new buyer revenue in this fixture. If a buyer has not authorized repayment, its increased cash claim and the corresponding outstanding principal both remain visible.

## 6. Unsolicited transfers and reconciliation exceptions

An arbitrary token transfer is a funds observation, not an invoice, sale, deposit approval or debt repayment.

When the kernel receives funds outside an authorized M1 funding or collection command:

1. Persist the observed asset, chain, amount, source transaction and transfer identity.
2. Reconcile the actual token balance.
3. Report the excess over known funded claims and escrow as unallocated surplus with a reconciliation exception.
4. Do not credit a business or customer, reduce accounts receivable or principal, recognize revenue, or change an order's paid amount.
5. Preserve the original transfer evidence and the exception. M1 has no attribution, rescue or return command for that surplus.

These funds are not recoverable or attributable through M1. Do not imply that matching a sender, amount or document makes them withdrawable. The exception remains visible, and a retry of a valid collection command still requires its own actual authorized funds transfer; it cannot consume the unsolicited surplus.

Any future recovery mechanism needs a separately reviewed ownership, authorization and accounting policy. It is outside this build. M1 does not manufacture a beneficiary-specific payable or a sales journal to make the surplus disappear.

If a linked native/token interface can credit the kernel without invoking its receive hook, reconciliation must still discover the balance delta. A missing application callback is not permission to ignore actual funds.

Reject unsupported payers, excess amounts, wrong assets or wrong obligations through designated commands before funds move. A raw transfer that bypasses those checks still creates the reconciliation exception above. Do not infer consent from similarity of amounts or an AI-generated match.

## 7. Events, private evidence and journal projection

### 7.1 Immutable commercial identity

Keep stable identities for the order, funding obligation, supplier allocation, customer invoice and original receivable. A new retry identifier must not create a new economic obligation.

Approvals bind the relevant version and exact material terms: asset, amounts, quantities, beneficiaries, principal ceiling, fee limits, timing, escrow disposition and collection waterfall. Changing a material term requires a new authorized version; old payable versions must expire or be explicitly invalidated.

Use opaque onchain identifiers and salted commitments to canonical evidence. Keep names, payroll data, invoices, shipping details and full documents offchain under access control. A hash of guessable unsalted data is not a privacy guarantee.

The amounts, addresses and timing exposed by the chosen settlement path remain observable under that path's actual privacy properties. Private document storage does not by itself make the financial transactions private.

Evidence records include the document version, canonicalization version, commitment, authorized actor, timestamp, decision and supersession relationship. Retain prior versions. Do not replace a signed document in place.

Onchain commitments prove consistency with supplied data under their assumptions. They do not prove that goods exist, a signature's holder has legal corporate authority, or a shipment occurred.

### 7.2 Event identity and economic posting identity

Use a canonical chain-event key:

~~~text
chain ID + contract address + transaction hash + log index
~~~

Include an event-schema version. For raw native transfers without a suitable emitted log, use the verified canonical transfer or trace identity supported by the selected adapter. Do not pretend that every native transfer has an ERC-20 log.

Use a separate unique projection key of `entity_id + economic_event_id`. The economic event identifies the one selected authoritative posting source and is stable across retries. Store event-schema and posting-rule versions as metadata; changing a version must not generate a second ordinary posting for the same economic event. Explicit authorized corrections use distinct correction identities linked to the original posting.

An event key prevents processing the same event twice. It does not prevent posting the same economic effect from two different events. Choose one authoritative source for each posting:

- A commitment event can expand into the complete per-entity financial-close journal.
- Lower-level transfer and loan events then support reconciliation rather than re-posting the whole close.
- Alternatively, dedicated economic events can each post their own disjoint entries, while the order completion event posts no money.

Document the choice. Never let both an order completion event and its transfer events independently credit the same payment.

### 7.3 Atomic local projection

For each legal entity and economic event, the database transaction must:

1. Insert or claim a unique processing key.
2. Validate event version, source, entity, obligation identity and amounts.
3. Generate all balanced journal lines using the pinned posting-rule version.
4. Persist journal lines, obligation balances and projection position.
5. Mark that processing key complete.
6. Commit together.

If the local transaction fails, it rolls back all local entries. The raw chain event remains durably captured for retry. It does not reverse a successful financial commitment onchain.

Separate entity projections may complete at different times. Each must be independently balanced and idempotent. The product can show committed financial state with accounting synchronization pending.

Rebuilding starts from the recorded immutable opening checkpoint and its opening journals, then replays eligible canonical events strictly after the checkpoint using the retained posting-rule version. Preserve the checkpoint's chain ID, kernel, finalized block number and hash, fixture version, full opening balance snapshot and source evidence. Do not replay pre-checkpoint seed deposits on top of those opening balances. The customer's external balance uses the same boundary. Rebuild is a projection-only operation: it creates no transaction, funding, collection or repayment onchain.

Store posting-rule versions. Correct a prior posting using an authorized reversal and replacement linked to the original event. Do not overwrite financial history or silently rerun a new rule version over posted entries.

An unrecognized event version, inconsistent amount or missing required evidence goes to reconciliation review. Do not fabricate balancing lines to make the journal pass.

## 8. Machine-checkable invariants

The test suite should assert these on every supported transition:

1. Physical funds are conserved across all modeled holders, subject only to separately recorded external inflows, outflows and fees.
2. Actual kernel USDC covers its known funded claims and escrow obligations. In authorized fixture flows the amounts are equal; any unsolicited excess is separately reported as unallocated surplus and cannot be spent. A deficit is an error. Debt receivables cannot substitute for cash backing.
3. Cash holds are disjoint components of an owner's existing claim.
4. Borrower principal equals the corresponding lender loan receivable by loan identity and asset.
5. Undrawn reservations do not create borrower principal.
6. Total lender reservations do not exceed the lender's actual total funded claim. A new reservation cannot exceed the unreserved availability remaining after all existing reservations and other disjoint holds.
7. Cash outflows cannot consume protected cash or another obligation's reserved funds.
8. Every financial journal balances per entity and currency. Different assets cannot cancel each other merely because their displayed numbers match.
9. A principal repayment cannot exceed actual eligible principal and cannot exceed attributed received funds or other explicitly authorized available funding.
10. Each economic obligation and allocation is consumed at most once.
11. A failed final commitment leaves its onchain financial state unchanged, excluding transaction fees and earlier independent transactions.
12. An accounting projection failure does not change confirmed onchain settlement.
13. The sales receivable and sales balance collection require recorded full acceptance; a forecast, delivery claim or partial acceptance is insufficient. The group's specified opening receivables instead come from its documented opening checkpoint.
14. Settled cash and principal are not deleted by cancellation, expiry, dispute or default.

## 9. Acceptance scenarios

These checks concern observable behavior and financial consequences. They are not a requirement to reproduce private implementation details in the UI.

| ID | Scenario | Required result |
|---|---|---|
| A01 | Load the sales opening fixture | Kernel 5,000; merchant claim 3,000; lender claim 2,000; customer external 10,000. Physical total 15,000. All opening journals balance. |
| A02 | Customer funds escrow with 4,000 | Kernel becomes 9,000 and customer external 6,000. Escrow claim is 4,000. Merchant cash and advance liability remain unchanged. |
| A03 | Replay the escrow funding event or the same successful command | No second escrow credit, transfer or journal. |
| A04 | Attempt to use the escrow for a different order | Reject the operation. The original customer's escrow remains attributable and refundable. |
| A05 | Reserve sales funding | Merchant holds 1,000 own funds, keeps 2,000 protected, and lender reserves 1,500 of its 2,000. No debt. No double-counting of escrow or held funds. |
| A06 | Lender attempts to withdraw its reserved 1,500 | Reject use of the reservation. Only its unreserved claim is available under the fixture's rules. |
| A07 | Supplier quote expires before close | Final close fails without supplier payment or debt. Earlier customer escrow remains in the kernel. Cancellation can make it withdrawable, and a separate withdrawal must return it. |
| A08 | After preview but before this plan reserves freight, another plan validly reserves or consumes the remaining capacity | Reject the losing reservation without partial holds, goods payment or credit draw. A valid existing hold cannot be consumed by a competing plan. |
| A09 | Before this plan obtains a firm credit reservation, only 1,499 of unreserved funded lender cash is available | Reject the required 1,500 reservation without partial holds or debt. Do not use protected cash or expected sales to fill the gap; existing firm reservations remain funded. |
| A10 | Change the supplier amount, beneficiary, fee or approved version | Reject the stale authorization. Require the correct newly approved terms. |
| A11 | Replay a completed sales close, including under a different retry ID | Return the existing completion or reject the consumed obligation. No duplicate supplier payment, allocation or principal. |
| A12 | Complete the sales close | Kernel 2,500; merchant claim 2,000; lender claim 500; supplier 6,000; freight provider 500; principal 1,500. Merchant prepayments 6,500 and customer advance liability 4,000. |
| A13 | Observe both the commitment event and its underlying token-transfer events | Post each economic effect once. Physical transfer evidence does not duplicate the canonical financial-close journal. |
| A14 | Cancel before close, then separately withdraw the funded escrow | Cancellation releases holds and makes 4,000 refundable, with kernel still 9,000 and customer external still 6,000. No financial journal or principal is created. The separate customer withdrawal consumes that credit and transfers 4,000, leaving kernel 5,000 and customer external 10,000. Merchant and lender claims remain 3,000 and 2,000 throughout. Replay cannot pay twice. |
| A15 | Request cancellation after close | Reject the precommit cancellation operation. Preserve the actual supplier payments, customer advance and 1,500 debt. Do not expose an implemented postcommit refund engine. |
| A16 | A full postcommit supplier and freight refund is claimed or sent directly | A claim alone changes nothing. Actual direct funds create a surplus reconciliation exception, not a reset of merchant cash, debt or customer advance. Preserve the close and payment history. A refund engine is outside M1. |
| A17 | Only part of the settled supplier amount is sent back directly | Record the actual excess as unallocated surplus and preserve transfer evidence. Do not mark the order cancelled, customer refunded or principal repaid. No partial-refund allocation command is required in M1. |
| A18 | Receive the approved goods and inbound freight evidence | Reclassify 6,500 prepayments to inventory once. No sale revenue or additional cash appears. |
| A19 | Customer fully accepts the specified delivery version | Recognize revenue 10,000, consume advance liability 4,000, create receivable 6,000 and recognize cost of goods sold 6,500 once. A delivery claim or partial acceptance does not unlock collection. |
| A20 | Send 6,000 directly without an eligible collection command | Observe actual unallocated surplus and show a reconciliation exception. No business credit, AR reduction, principal repayment or revenue. M1 provides no attribution, rescue or return function. Replaying observation does not create a claim. |
| A21 | After full acceptance, collect the remaining authorized sales balance of 6,000 | Actual external funds enter the kernel. Merchant claim becomes 6,500, lender claim 2,000, kernel 8,500, principal and receivable zero. No external lender payout is claimed. |
| A22 | After full acceptance, collect two valid payments of 3,000 | First receipt repays 1,500 and leaves merchant claim 3,500, lender claim 2,000, receivable 3,000 and principal zero. Second receipt yields the same terminal state as A21. |
| A23 | Attempt collection before full acceptance, or use the wrong order, payer, asset or an excess amount | Reject before moving funds or reducing debt. No guessed attribution or synthetic balancing entry. A raw transfer bypassing the command remains unallocated surplus with a reconciliation exception. |
| A24 | Deliver the same confirmed chain event to the projector repeatedly | One economic journal and one obligation update per entity. Repeated delivery is observable but financially idempotent. |
| A25 | Crash or rebuild the projector | Journal lines commit together or roll back together. Rebuild retains the immutable opening checkpoint and posting-rule version and posts only later events. Seed deposits already in opening balances are not posted again. Confirmed onchain cash and principal remain intact; no new transaction is sent. |
| A26 | Two workers process the same event concurrently | Unique processing identity permits exactly one complete posting. The loser observes completion or retries safely. |
| A27 | Load the group fixture with opening receivables | Opening receivables and customer payables match A160, B165 and C125, total 450. Customer opening equity is 550 and external USDC is 1,000. Kernel 1,250 plus customer external 1,000 equals 2,250. No current-period revenue is created. |
| A28 | Only A and B join, then C joins | At 75 units there is no commit or debt; credit reservations total 325. At 100 units, reservations total 450 and lender availability is 50, with principal still zero. |
| A29 | Attempt to commit 75 or 101 units, or use capacity 99 | Reject this fixed 100-unit quote. Do not partially fill, change price or redistribute quantities without explicit new authorization. |
| A30 | Commit the full group | Supplier receives 900; kernel holds 350; each buyer retains 100; principal is 160, 165 and 125; lender claim is 50; allocations are 40, 35 and 25. |
| A31 | Collect group opening receivables, then separately authorize repayment | Collection leaves customer external 550, kernel 800, buyer claims A260/B265/C225, lender claim 50, opening AR/AP zero and principal still A160/B165/C125. Separate buyer-authorized repayments restore buyer claims to 100 each and lender claim to 500; principal becomes zero. No automatic group waterfall or new buyer revenue. |
| A32 | A transaction requires gas or another fee | The no-fee fixture is not silently changed. Use the defined separate gas budget or reject an unauthorized financial fee. Do not consume protected money. |
| A33 | Customer becomes overdue or disputes an accepted sale | Keep the real unpaid receivable and debt. No forecast payment, automatic forgiveness or invented supplier refund. |
| A34 | Lender withdraws a repaid internal claim | Only this operation creates the external lender transfer. Reduce the funded claim and actual kernel USDC equally, and track the external recipient in conservation checks. |
| A35 | Two financing requests reference the same approved funding obligation | Enforce the aggregate reservation and principal ceiling against authoritative current state. Different retry IDs cannot duplicate the same loan. This does not prove uniqueness of an off-platform economic claim. |

## 10. Gas and deployment evidence

The displayed balances assume a separately funded transaction sender pays gas. Gas does not come from the merchant's protected claim, customer escrow or reserved loan amounts.

The production account model must make that arrangement explicit. If the business funds a gas wallet or reimburses a relayer, record the actual expense and movement separately. Do not claim exact physical conservation while omitting a fee paid from a tracked balance.

Mainnet evidence should identify actual transfers into escrow, supplier and freight payouts, customer balance collection, the resulting internal claims, principal updates and any optional lender withdrawal. It must distinguish external token movement from an internal funded-claim transfer.

Use the smallest practical amounts for any later real demonstration while preserving the ratios and integer arithmetic. The large figures in this document are planning fixtures, not authorization to fund or execute those amounts.

## 11. Accounting references and limits

The classification choices are illustrative design assumptions informed by the following primary references:

- [IFRS 15, official overview](https://www.ifrs.org/issued-standards/list-of-standards/ifrs-15-revenue-from-contracts-with-customers/). Revenue depends on satisfying the promised performance, rather than receipt of money alone.
- [IFRS 15, published standard](https://www.ifrs.org/content/dam/ifrs/publications/html-standards/english/2026/issued/ifrs15.html). The presentation requirements distinguish customer advances, contract assets and unconditional receivables.
- [IAS 2, official overview](https://www.ifrs.org/issued-standards/list-of-standards/ias-2-inventories/). Inventory costs include eligible costs of bringing inventory to its present location and condition. That is why this fixture explicitly defines the 500 as inbound freight.
- [IAS 7, published standard](https://www.ifrs.org/content/dam/ifrs/publications/html-standards/english/2026/issued/ias7.html). Cash financing flows and financing transactions without cash movement require different treatment. The journals above follow the actual selected funds path.
- [Solidity error-handling documentation](https://docs.soliditylang.org/en/latest/control-structures.html). Reversion applies to the relevant onchain call state. Required failures must propagate; catching an error or ignoring a failed low-level call can defeat the intended business atomicity.

These references do not establish the legal status of a kernel claim, regulatory custody arrangements, statutory USDC classification, tax treatment or the enforceability of a particular invoice. Those are outside this implementation fixture.

## 12. Verification performed for this specification

An independent in-memory integer-cents ledger check on 26 October 2026 covered the sales opening, escrow, close, performance, acceptance and collection journals; cancellation followed by a separate escrow withdrawal; the two-payment sales collection path; and the group opening, close, goods receipt, opening-receivable collection and separate principal repayment journals. It checked per-entity journal balance, physical funds conservation, kernel claim backing, protected cash and mirrored loan principal at the relevant checkpoints.

The sales terminal kernel balance was 8,500, with merchant claim 6,500, lender claim 2,000 and no loan principal or customer receivable. Two valid 3,000 collections after full acceptance reached the same terminal balances as one 6,000 collection. Cancellation alone kept kernel USDC at 9,000; the subsequent separate customer withdrawal reduced it to 5,000.

Group collection alone left kernel USDC 800, buyer claims A260/B265/C225, lender claim 50 and principal A160/B165/C125. Only the separate authorized repayments reduced buyer claims to 100 each and restored lender claim 500. The customer's opening payables of 450 and opening equity 550 balanced its opening external funds of 1,000.

These checks validate the specified arithmetic and journal construction. They are not contract tests, application acceptance results, evidence of physical delivery, an audit, or a mainnet execution. The 35 acceptance scenarios above remain implementation requirements. Appendix A is educational future scope and is not part of M1 acceptance.

## Appendix A. Future recovery journals — outside M1

This appendix explains possible accounting for a separately designed recovery process. It is not a requirement to implement refund, rescue, attribution, partial-unwind or postcommit cancellation commands in M1. In the chosen M1, an unsolicited supplier return remains unallocated surplus with a reconciliation exception under Section 6.

### A.1 Hypothetical complete pre-delivery recovery

Assume a future authorized recovery mechanism verifies actual supplier and freight refunds of 6,000 and 500, identifies the merchant's recovery rights, and applies explicitly approved lender and customer distribution terms. It must also establish that no goods or freight performance has occurred. A cancellation request or a refund document alone is insufficient.

| Entity and future recovery step | Debit | Credit |
|---|---|---|
| Merchant: receive verified refunds | Restricted funded kernel claim 6,500 | Supplier prepayment 6,000; inbound freight prepayment 500 |
| Kernel: receive and attribute those external refunds | USDC asset 6,500 | Due to merchant, restricted for recovery 6,500 |
| Supplier: return advance | Advance received for goods 6,000 | External USDC asset 6,000 |
| Freight provider: return advance | Advance received for freight service 500 | External USDC asset 500 |
| Merchant: repay principal under approved recovery terms | Loan payable 1,500 | Restricted funded kernel claim 1,500 |
| Lender: receive principal internally | Funded kernel claim 1,500 | Loan receivable 1,500 |
| Kernel: reassign repaid principal | Due to merchant 1,500 | Due to lender 1,500 |
| Merchant: refund customer | Customer advance liability 4,000 | Restricted funded kernel claim 4,000 |
| Customer: receive refund | External USDC asset 4,000 | Advance to merchant 4,000 |
| Kernel: send customer refund | Due to merchant 4,000 | USDC asset 4,000 |

The remaining 1,000 of recovered merchant cash is released from its recovery hold by a memo-state change. It is already part of the merchant's funded claim and must not be credited again. The opening physical and claim balances can be restored, but only through these additional real movements and postings. The original close and payments remain in history.

This example assumes approved terms permitting the illustrated sequence. It does not establish that a lender has priority over a customer in other circumstances. A post-performance return would need separate inventory, revenue and cost adjustments not specified here.

### A.2 Hypothetical partial recovery

If the future mechanism instead verifies and attributes only a 1,000 supplier refund, the initial entries would be:

| Entity and future partial recovery | Debit | Credit |
|---|---|---|
| Merchant | Restricted funded kernel claim 1,000 | Supplier prepayment 1,000 |
| Kernel | USDC asset 1,000 | Due to merchant, restricted for recovery 1,000 |
| Supplier | Advance received for goods 1,000 | External USDC asset 1,000 |

The merchant still has supplier prepayment 5,000, freight prepayment 500, loan payable 1,500 and customer advance liability 4,000. The 1,000 receipt alone does not repay principal, refund the customer or complete cancellation. Allocation of recoveries would require explicit authorized terms and its own future implementation. M1 does not perform these attribution journals or distributions.
