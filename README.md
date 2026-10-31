# Arc Business Operating Account

Can a business fund its next order without spending cash already promised elsewhere?

This Arc Studio application puts protected cash, exact purchase terms, customer escrow, prefunded credit and accounting into one lifecycle. Customer orders and group purchases use the same non-upgradeable Solidity kernel. Owners keep distinct signing authority; funds share contract custody under explicit rules.

**Current status: verified Arc Testnet prototype. Mainnet deployment and public hosted app are not complete.** This is a controlled demonstration with fictional businesses and a prefunded lender. It is not a bank or commercial credit service.

[Arc Studio project](https://studio.arc.io/app/46704d22-91ee-404d-8ff7-7ad873e3c289) · [Testnet verification report](docs/reviews/arc-testnet-rehearsal-2026-10-31.md) · [Source provenance](docs/source-provenance.json)

## What works

- Owner-approved terms reserve exact cash, credit and supplier capacity without creating premature debt.
- Incomplete purchases cannot close. A successful close pays approved recipients and records each borrower's principal.
- Protected cash remains unavailable for settlement; refundable escrow, collections and repayments are separate actions.
- Durable wallet intent and event-backed books recover the original transaction without resending it.

A real MetaMask testnet close paid **0.90 test USDC**, recorded **0.45 test principal**, and retained **0.10 per buyer**. The additional mixed demo still has that principal outstanding. The separate customer-order and group baseline runs repaid all principal.

Independent verification passed **1,393 public-chain checks across 140 transactions**. Local evidence includes **177 Arc VM release tests**, **182 accounting checks** and **47 browser regressions**. These are separate verification scopes. [Actual testnet close](https://explorer.testnet.arc.io/tx/0x30218840328659d6090bcb964c36c63bddf9ce86f18d9d884f4ac83d5c10b81a).

## Run

Install the Bun and Foundry versions named in the project files, then:

```sh
bun install
cp .env.example .env.local
bun run dev
```

The default configuration has no deployment and invents no balances. The frontend and books API run together. To exercise a fresh local scenario, run the test commands below. Real Arc deployments require a validated manifest, the matching immutable opening checkpoint and a reliable RPC. Never replace a current ledger with a historical checkpoint.

## Verify

```sh
bun run check
bun run check:integration
forge test
python3 scripts/verify-release-artifact.py
python3 docs/build-pack/tools/verify_fixtures.py
bun run integration:test
bunx vite build
```

Browser tests additionally require the pinned Python Playwright dependencies and Chromium: see `tests/browser-requirements.txt` and `tests/browser.py`. The local integration/browser runners own temporary local chains and use public test credentials. Those credentials must never be used for real funds.

The historical Arc rehearsal operator scripts refer to evidence and private test-actor state from the original Studio run. They are published for inspection, not as instructions to replay funding or settlements. This source repository omits live databases, wallet secrets, raw browser/runtime logs and private environment files. The complete verified evidence archive remains with the builder.

## Trust and limits

One fixed lender-owned pool provides only prefunded, bounded credit. Reservations are not debt. All withdrawals preserve commitments and protected floors. Financial close, delivery evidence, collection and repayment stay distinct. The API records books; it cannot authorize a wallet transaction.

The system does not provide bank integration, commercial underwriting, tax reporting, independently verified physical delivery, privacy, autonomous signing or an external security audit. The reviewed runtime has 101 bytes of size headroom. Contract changes require a fresh release-artifact check.

The project uses OpenZeppelin, viem, React and forge-std. Third-party notices and file-level licenses are retained. No new repository-wide license grant is added by this export.
