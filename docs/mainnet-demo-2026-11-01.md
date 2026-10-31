# Controlled Arc mainnet demonstration, 1 November 2026

The owner confirmed `commitPlan(1)` through the public application and MetaMask. The contract paid the approved supplier and posted the agreed borrower principal. The transaction is finalized and its block is canonical in the independent RPC readback.

- Public app: https://arc-business-operating-account.swmengappdev.workers.dev/
- Original Arc Studio project: https://studio.arc.io/app/46704d22-91ee-404d-8ff7-7ad873e3c289
- Kernel: https://explorer.arc.io/address/0xc7e3f2C1982207948147B6aa156a819eB826941D
- Actual close: https://explorer.arc.io/tx/0x38e80b478e7ed0c3158d270d1364e0df648c08b25353e3bc3ef5cd55221d03bd
- Block: 28842952. Time: 1 November 2026, 00:07:33 UTC+8.

## Financial result

| Item | Actual USDC |
| --- | ---: |
| Supplier payout | 0.09 |
| Buyer A principal | 0.016 |
| Buyer B principal | 0.0165 |
| Buyer C principal | 0.0125 |
| Total principal outstanding | 0.045 |
| Protected cash per buyer | 0.01 |
| Remaining lender cash | 0.005 |
| Remaining kernel custody | 0.035 |
| Actual purchase fee | 0.013853238 |
| Total funding, setup and purchase gas | 0.216463569 |

The review capped this call at 900,000 gas, 32 Gwei maximum fee and 1 Gwei priority fee, or 0.0288 USDC maximum. The owner-approved total demo budget was 0.75 USDC. The verifier separately accounts for native-18 gas and six-decimal token business values; these represent the same USDC asset.

## Verification and recovery

The setup passed 577 independent checks across 38 transactions. The actual app close then passed 35 checks on the owner Mac and again inside the original Arc Studio workspace, including the exact signer, nonce, target, calldata, value, fee bounds, finality, contract runtime, payout, principal, protected floors and custody.

The hosted Worker projected one `PlanCommitted` source into 28 balanced journal lines and retained one gas record. Nineteen live recovery checks passed after a page reload. The app recovered the same hash and nonce as `Confirmed · books posted`; it did not request another payment. This is a live browser-reload and retained-projection check. The separate ten local Workers runtime tests cover object eviction and other storage failures; do not mistake those tests for a forced eviction of this production object.

Blockscout reports an exact source-code match through its Bytecode Database: Solidity 0.8.28, Cancun, optimizer enabled with one run, expected token and lender constructor arguments. This is code identity, not an external security audit.

Receipts: [close checks](evidence/mainnet-app-close-checks.json), [actual receipt](evidence/mainnet-app-close-receipt.json), [live ledger recovery](evidence/mainnet-worker-recovery.json). The read-only verifier is `scripts/arc-mainnet-close-verify.ts`. It never accesses private keys or broadcasts a transaction.

## Limits and disclosures

All demo participants are owner-controlled fictional businesses. The 0.045 USDC principal is still outstanding. Physical delivery has not been independently verified. This is not a bank account, commercial credit service, underwriting system or audited financial product.

MetaMask displayed a malicious-site warning for the public origin during this controlled demonstration. The owner personally reviewed the warnings and confirmed the transaction; the agent did not override them. That owner decision and a successful transaction do not clear the vendor classification. No wallet-security protections were disabled. Visitors can inspect the public app without connecting a wallet.

Codex assisted development, review, browser operation, verification and export. The contracts, app and checks were developed or verified within the same Arc Studio project. The deployed Workers source matches the recorded Studio checkpoint. Mainnet signing remained with the owner.

[Mainnet walkthrough](https://arc-business-operating-account.swmengappdev.workers.dev/demo/) · [Direct MP4](https://arc-business-operating-account.swmengappdev.workers.dev/demo/mainnet-walkthrough.mp4)

## Submission status

DoraHacks confirmed the existing Build was submitted to Arc Microgrants and is under review on 1 November 2026. The owner approved both final agreements. [Build](https://dorahacks.io/build/50661) · [Submission receipt](evidence/dorahacks-submission-2026-11-01.json).
