# Product specification and build plan

## 1. Product decision

Build a business operating account with purchasing, customer orders, funded credit, collections and bookkeeping supplied natively by one financial model.

The user's operating question is: "Can I accept or fund this opportunity without spending cash already promised elsewhere?"

The core action is an authorized financial close. It consumes exact cash and credit reservations, releases a permitted customer advance where relevant, pays approved recipients, and records the resulting obligations in one same-chain transaction. Earlier deposits, offers, approvals and reservations are separate transactions. Physical delivery and external accounting synchronization are separate events.

The product vision is a broader banking and ERP suite. The first release proves its financial core with two workflows:

1. Three businesses combine a purchase to qualify for a supplier's price, with separately authorized cash and credit contributions.
2. A business accepts a customer order using a permitted customer advance, its own free cash and approved funded credit, while preserving payroll cash. It later collects the balance and repays principal.

The first release is a controlled demonstration with fictional business information and a prefunded demonstration lender. It does not claim an actual bank partnership, credit underwriting or real customer traction.

Canonical baseline fixtures use fresh isolated deployments of the same kernel implementation. A live app cannot reset deposited funds to switch fixtures. Display each actual deployment explicitly. A required mixed-workflow contention test in one instance proves that the two workflows share reservation rules. At least one complete real mainnet business flow is the grant proof; a second scenario demonstrated only on testnet must remain labeled that way.

Use distinct controlled external actors for the canonical fixtures, or compare explicitly recorded opening balances and fixture-specific deltas. Other wallet holdings and gas reserves are not part of the fictional business amounts. For external wallet reconciliation, account for real receipt fees in native18-decimal units and convert ERC20 movements exactly; do not demand that a gas-paying wallet's raw balance equal a fee-free fixture total.

## 2. What the owner sees

### Account overview

Display total business cash, protected cash, reserved own cash, free cash, credit reserved, principal outstanding and recognized receivables. Label customer escrow separately because it is not business cash before its permitted release. Do not add reserved components to cash totals again.

The primary action is "Review an operation". The owner can choose a customer order or collective purchase. A readiness panel explains which authorizations, funds or offers are missing. It must derive actionable readiness from fresh contract reads or a simulation immediately before submission, not from an old database flag.

### Customer order

Show the sale value, customer advance, supplier and inbound freight costs, protected cash, funding gap, approved credit and remaining customer balance. The detail screen contains commercial terms, approval history, reserved resources, the proposed financial close and the accounting timeline.

The customer can fund a refundable escrow for the exact plan and withdraw it before close, invalidating readiness. Release to the approved purchase is allowed only by the explicit agreed plan. A later delivery acceptance is an authenticated statement from the authorized actor, not proof that a blockchain observed physical goods.

Cancellation first changes the escrow into a customer-withdrawable refund claim; the kernel still holds the money. A separate withdrawal returns actual tokens. Show these as distinct states. Sales balance collection is enabled only after the authorized customer records full acceptance onchain and the required goods/freight acknowledgments are complete. Partial monetary collections can then reduce the remaining recognized balance without implying partial-delivery support.

### Collective purchase

Show the 100-unit offer, quantities for A, B and C, each buyer's cash/credit split, reservation status and the supplier's registered capacity. Begin the demo with A and B joined for 75 units and no debt. C completes 100 units. Approval or participation changes affect actual contract state.

### Funding

The lender sees funded liquidity, liquidity already reserved, free liquidity, principal by borrower and plan, approved amounts and expiry. Approval alone does not reserve money. A reservation must use existing deposited liquidity. Joining creates no debt.

### Books and evidence

Show event-derived entries per entity, their operation references, entry totals, chain receipts and projection status. A payment is not automatically revenue or an expense. The app must explain customer advances, supplier prepayments, inventory, receivables and loan principal in plain language.

Show "Transaction confirmed; books syncing" if financial execution is complete but the projection is behind. Recover the projection without issuing another payment. Never present a model-only receipt as a real chain transaction.

## 3. Canonical scenarios

All amounts below are business-scale USDC equivalents. The actual onchain demo divides every monetary amount by 1,000. The UI must display actual onchain amounts prominently and can show the business-scale example in a clearly labeled secondary view. Do not scale quantities, identifiers, deadlines, percentages or counts.

### Customer order

| Item | Business scale | Actual demo USDC |
| --- | ---: | ---: |
| Customer's initial external funds | 10,000 | 10.000000 |
| Merchant deposited cash | 3,000 | 3.000000 |
| Protected merchant cash | 2,000 | 2.000000 |
| Merchant contribution | 1,000 | 1.000000 |
| Lender deposited liquidity | 2,000 | 2.000000 |
| Refundable customer escrow | 4,000 | 4.000000 |
| Credit reserved, then drawn at close | 1,500 | 1.500000 |
| Supplier payout | 6,000 | 6.000000 |
| Inbound freight payout | 500 | 0.500000 |
| Customer balance collected later | 6,000 | 6.000000 |

The financial close pays 6,500, leaves merchant cash 2,000 and lender cash 500, creates principal 1,500 and leaves customer external cash 6,000. The kernel holds 2,500, backing the merchant and lender claims.

After goods and inbound freight are acknowledged, inventory cost is 6,500. When the customer accepts the completed sale, recognize revenue 10,000, consume the 4,000 customer-advance liability and record receivable 6,000. Recognize cost of goods sold 6,500. Later collection of 6,000 follows the approved waterfall: principal 1,500 returns to lender liquidity and 4,500 becomes merchant cash. Terminal cash is merchant 6,500, lender 2,000, supplier 6,000, freight provider 500 and customer zero. Global cash is 15,000 throughout, before separately tracked gas and fees.

### Collective purchase

| Buyer | Quantity | Starting cash | Protected | Own cash held | Credit reserved/drawn | Supplier allocation | Opening receivable |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 40 | 300 | 100 | 200 | 160 | 360 | 160 |
| B | 35 | 250 | 100 | 150 | 165 | 315 | 165 |
| C | 25 | 200 | 100 | 100 | 125 | 225 | 125 |
| Total | 100 | 750 | 300 | 450 | 450 | 900 | 450 |

Supplier price is 9 per unit, capacity is exactly 100, lender liquidity is 500, each buyer's approval ceiling is 200 and an external customer starts with 1,000. The opening receivables are explicit fictional balances from earlier business, included in opening equity. They are a bookkeeping extension to the earlier prototype. Do not invent new sales revenue when collecting them.

A and B reserve 350 of own cash, 325 of funded credit and 75 units. C adds 100, 125 and 25. Before close, buyer cash stays 750, lender cash stays 500, principal is zero and supplier receipts are zero. At close, supplier receives 900, buyers retain 100 each, principal is 160/165/125 and lender cash is 50. Total cash including the external customer is 2,250.

After delivery and collection of the opening receivables, each buyer explicitly repays its own principal from its free cash. Buyer cash ends at 100 each, lender at 500, supplier at 900 and external customer at 550. Loan balances end at zero. No borrower guarantees another borrower's debt.

## 4. Product boundaries for this release

Deliver complete behavior for one currency, exact fills, a bounded number of participants, zero interest, zero financing fees, one funded lender per plan and the two specified workflows. Explain these as demo terms.

Defer automated underwriting, variable interest, tax filing, local bank payouts, crosschain financial close, FX inside close, yield strategies, fractional receivable markets, generalized dispute arbitration, partial delivery, production payroll, inventory forecasting and an autonomous agent that can sign arbitrary transfers. Their future interfaces should not complicate the first kernel.

Post-close cancellation cannot erase history. A dispute can be recorded without changing money. Actual refunds must be real transfers and separately allocated. The first release can provide a read-only dispute record and documented recovery limitation rather than a partial refund engine. If no refund flow exists, disable that action with an accurate explanation.

## 5. User stories

1. As a business owner, I want to see protected, reserved and available cash, so that I can judge a new commitment.
2. As a business owner, I want to fund my account from my wallet, so that its balances have real backing.
3. As a business owner, I want withdrawals to respect existing reservations and protected cash, so that I cannot accidentally break an accepted funding plan.
4. As a business owner, I want to prepare an order with exact terms, so that counterparties approve the same operation.
5. As a customer, I want my pre-close deposit to remain refundable, so that an uncommitted order does not consume my money.
6. As a customer, I want to authorize the permitted use of my advance, so that it funds only the order I agreed to.
7. As a supplier, I want to publish an offer with a price, capacity, payee and expiry, so that purchases use my terms.
8. As a supplier, I want reserved capacity to be visible, so that two operations cannot consume the same registered capacity.
9. As a buyer, I want to join a group with my own cash and credit limits, so that I retain control over my contribution.
10. As a buyer, I want to leave an uncommitted group, so that my undrawn reservations can be released.
11. As a lender, I want to deposit actual liquidity, so that approved commitments can be funded.
12. As a lender, I want to approve exact borrowing terms, so that a buyer cannot increase principal without my authority.
13. As a lender, I want to distinguish approvals, reservations and debt, so that I know what money is available and what has actually been lent.
14. As a lender, I want withdrawals to preserve active reservations, so that I cannot remove promised liquidity.
15. As a participant, I want expired or revoked terms to block close immediately, so that obsolete approvals cannot be used.
16. As a participant, I want anyone to be able to release expired reservations, so that funds do not depend on one operator remaining online.
17. As a business owner, I want to preview the exact resulting balances before signing, so that I understand the operation.
18. As a business owner, I want a failed close to leave its financial effects uncommitted, so that I do not have to repair a partial purchase.
19. As a business owner, I want a repeated submission to avoid duplicate payment or debt, so that a timeout is recoverable.
20. As a recipient, I want to see confirmed token receipts, so that I can distinguish execution from a pending request.
21. As a buyer, I want to record receipt of the goods I actually accepted, so that prepayments can become inventory at the correct event.
22. As a customer, I want to acknowledge or dispute fulfillment, so that the business record reflects my response.
23. As a business owner, I want actual customer collections linked to an identified receivable, so that the books do not invent income from arbitrary deposits.
24. As a borrower, I want repayments to reduce only my principal, so that debts remain separate.
25. As a lender, I want to withdraw repaid available liquidity, so that an internal balance is redeemable subject to actual backing.
26. As an accountant, I want balanced entries linked to confirmed events, so that I can review the transaction lifecycle.
27. As an accountant, I want the books to recover after interruption, so that an indexer outage does not require another payment.
28. As a reviewer, I want a read-only role view without control of that role's wallet, so that I can inspect the product safely.
29. As a user, I want the active environment and actual token amounts to be obvious, so that I do not confuse simulation, testnet and mainnet.
30. As a user, I want an assistant to explain a funding shortfall from current data, so that its advice is grounded in the operation.
31. As a wallet owner, I want an assistant's proposal to remain subject to my transaction approval, so that generated text cannot spend my funds.
32. As a reviewer, I want genuine Studio, repository and transaction evidence, so that I can reproduce the claimed build.

## 6. Application architecture

Prefer a small TypeScript repository with the existing Studio-generated frontend preserved when sound. For a new scaffold, use React, Vite, TypeScript and a current verified EVM client such as viem. Use a supported wallet integration rather than asking users to paste private keys. Solidity contracts use Foundry and reviewed standard token/security helpers compatible with the selected compiler. Pin actual resolved versions and record them in a lockfile.

Suggested layout:

```text
apps/web/                 business UI and wallet transaction preparation
apps/api/                 read-only confirmed-event projector and query API
contracts/               kernel, Foundry tests, deployment scripts
packages/domain/         integer money, schemas, read models and plan construction
packages/accounting/     deterministic journals and projection rules
fixtures/                canonical scenarios and deployment-scale fixtures
docs/                    decisions, trust model, build provenance and release evidence
```

Use SQLite for local event projections. A D1 deployment is a reasonable later adapter for the same small relational model. Do not block the financial core on Cloudflare hosting or rewrite a working Studio stack solely to match the preferred folder layout. Record an adaptation as a short decision document.

The contract is authoritative for funds, authorizations, reservations, principal and committed operation status. The relational store is a replayable projection plus controlled commercial metadata. The frontend cannot authorize a financial operation by changing a database row. A browser draft is a proposal until the relevant chain transactions confirm.

The minimum API is read-only for confirmed plans, events, account summaries and journals. Core monetary changes are wallet-signed contract calls. If private metadata or editable drafts are added to the backend, implement proper identity, ownership and access checks; a role selector is not authentication. Fictional public fixtures do not justify exposing real documents later.

## 7. Screen requirements

Use a restrained finance application layout. Keep the environment indicator persistent. Avoid a crypto trading dashboard, decorative token prices, invented APYs and unimplemented navigation.

| Screen | Required working behavior |
| --- | --- |
| Account | Real deposited claims, protected/reserved/free cash, funding and withdrawal |
| Operations | Customer-order and collective-purchase templates over the same domain |
| Operation detail | Terms, readiness, party actions, proposed effects and confirmed timeline |
| Funding | Deposits, approvals, reservations, principal and repayments for the lender |
| Books | Per-entity journals, balances, source events and projection status |
| Evidence | Network, contract, transaction receipts, Studio provenance and limitations |

A role/view switch changes what is displayed. It does not impersonate the connected signer. Show the connected address and explain when an action requires a different signer. A local developer mode may use deterministic test signers, but it must be visibly isolated and disabled in deployed builds.

Refresh or a lost connection must not reset confirmed balances. Pending transactions require reconciliation by hash and operation ID. A rejected wallet request is not a reverted chain transaction. A successful transaction followed by a failed API refresh is not a failed payment.

## 8. AI scope

The first AI feature explains and prepares. It may read current authorized operation data, identify a shortfall, compare a bounded alternative and produce a structured draft. It cannot sign, change protected cash, grant credit or mark a transaction confirmed.

Build the deterministic workflow first. If no model credentials are configured, either omit the AI panel or explicitly label a rule-based explanation. Do not simulate an LLM response and present it as a connected model. Any model integration uses server-side secrets, bounded context and an explicit call budget.

## 9. Milestones and release gates

| Gate | Work | Exit evidence |
| --- | --- | --- |
| G0 | Studio project, reference docs, fixtures and domain decisions | Saved Studio URL, actual generated files, fixture checker passes |
| G1 | Deposits, protected funds, offers, approvals and reservations | Contract tests show backed claims, separate authority and no debt on reserve |
| G2 | Both financial closes and their failure paths | Exact fixtures pass against actual deployed local contracts; replay and competing-operation tests pass |
| G3 | Working UI, wallet actions and role views | Real testnet actions, persisted state after reload, accurate signer restrictions |
| G4 | Delivery acknowledgments, collections, repayment and journals | Both lifecycles reconcile; projection rebuild yields identical books without another payment |
| G5 | Independent review and Arc testnet rehearsal | Security issues resolved or bounded, receipts captured, actual USDC decimals/duplicate events handled |
| G6 | Mainnet release preparation and approved execution | Exact manifest, reviewed artifact hash, wallet-owner approval, verified explorer evidence |
| G7 | Submission package | Public repo, deployed app, Studio history, videos and real transaction evidence |

Do not advance on a narrative claim. Record commands, test results, artifacts and remaining limitations at each gate. A failed gate calls for a focused repair prompt, not broad optional testing or another redesign.

For a six-day working schedule, target G0/G1 on day 1, G2 on day 2, G3 on day 3, G4 on day 4, G5 on day 5, and approved G6/G7 on day 6. This is a planning allocation, not a promise that a new financial contract is production-ready in six days. Check the actual submission deadline and timezone before scheduling the last day.

If time is short, remove AI, extra analytics and cosmetic work first. Preserve the financial invariants, real Studio use and end-to-end transaction evidence. If the second workflow is incomplete, label it accurately and demonstrate the completed workflow without claiming full suite completion.

## 10. Done means

The release is done when a reviewer can follow the two fixtures through real contract state, see separately authorized participation, observe no debt before commitment, verify external supplier payments, recover the books after an interruption, and reconcile all remaining money and principal. The application must show the exact limitations of the controlled demo.

Successful specification arithmetic is not evidence that the contracts or app work. No contract or UI implementation has been executed by preparing this pack.
