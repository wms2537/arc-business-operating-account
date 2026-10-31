# Arc Business Operating Account

Can a business fund its next order without spending cash already promised elsewhere?

This Arc Studio application puts protected cash, exact purchase terms, customer escrow, prefunded credit and accounting into one lifecycle. Customer orders and group purchases use the same non-upgradeable Solidity kernel. Owners keep distinct signing authority; funds share contract custody under explicit rules.

**Current status: the public Cloudflare Workers app completed a verified Arc mainnet purchase on 1 November 2026.** It paid 0.09 USDC to the demo supplier, recorded 0.045 USDC of borrower principal and retained 0.01 USDC for each buyer. The principal remains outstanding. The [Arc Microgrants submission](https://dorahacks.io/build/50661) is under review. This is a controlled demonstration with fictional businesses and a prefunded lender, not a bank or commercial credit service.

[Public mainnet app](https://arc-business-operating-account.swmengappdev.workers.dev/) · [Arc Studio project](https://studio.arc.io/app/46704d22-91ee-404d-8ff7-7ad873e3c289) · [Testnet verification report](docs/reviews/arc-testnet-rehearsal-2026-10-31.md) · [Source provenance](docs/source-provenance.json)

## What works

- Owner-approved terms reserve exact cash, credit and supplier capacity without creating premature debt.
- Incomplete purchases cannot close. A successful close pays approved recipients and records each borrower's principal.
- Protected cash remains unavailable for settlement; refundable escrow, collections and repayments are separate actions.
- Durable wallet intent and event-backed books recover the original transaction without resending it.

A real MetaMask testnet close paid **0.90 test USDC**, recorded **0.45 test principal**, and retained **0.10 per buyer**. The additional mixed demo still has that principal outstanding. The separate customer-order and group baseline runs repaid all principal.

Independent verification passed **1,393 public-chain checks across 140 transactions**. Local evidence includes **177 Arc VM release tests**, **182 accounting checks** and **47 browser regressions**. These are separate verification scopes. [Actual testnet close](https://explorer.testnet.arc.io/tx/0x30218840328659d6090bcb964c36c63bddf9ce86f18d9d884f4ac83d5c10b81a).

## Mainnet adapter status

The app now recognizes Arc Mainnet 5042 separately from Arc Testnet 5042002 and local Anvil 31337. Its parser, wallet chain, paced RPC, finalized event capture and native-USDC fee labels are covered by 17 network tests, including wrong-network and altered-runtime rejection. All 182 accounting and 47 browser regression checks still pass. Solidity is unchanged. These adapter checks are separate from the mainnet deployment and setup verification below. The official Blockdaemon alternate RPC is available; the primary RPC returned HTTP403 in the build environment. [Adapter receipt](docs/evidence/mainnet-support-checks.json).

## Bounded mainnet preparation

The owner approved a 0.75 USDC total demo budget. The preparation uses 0.225 USDC of business capital, fixed gas ceilings and dedicated keys retained privately on the owner Mac. The app permits one paid group-close attempt from the approved operator, passes its fee ceilings to the wallet, and blocks a second paid attempt after a revert. A human must execute financial actions. The owner executed the funding and setup. The mainnet kernel is `0xc7e3f2C1982207948147B6aa156a819eB826941D`; 38 setup transactions passed 577 independent checks. The owner then confirmed the exact application close in MetaMask. It passed 35 independent transaction and balance checks. The actual close fee was 0.013853238 USDC; total funding, setup and close gas was 0.216463569 USDC. The public ledger retained one settlement event and one gas record after page reload, with 19 recovery checks passing. [Mainnet result and limits](docs/mainnet-demo-2026-11-01.md) · [Transaction](https://explorer.arc.io/tx/0x38e80b478e7ed0c3158d270d1364e0df648c08b25353e3bc3ef5cd55221d03bd).

The new operator and wallet tests passed 16 checks. Together with the existing network suite, Studio passed 33 unit checks, 182 accounting checks, 47 browser checks, type/lint checks and the production build. The operator/wallet tests also passed on the owner Mac. [Human-operated workflow](docs/mainnet-operator.md) · [Verification receipt](docs/evidence/mainnet-operator-checks.json).

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
bun run test:networks
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

## Cloudflare Workers

The same accounting projector runs on Bun/SQLite in Studio and on SQLite-backed Durable Objects in Workers. Each deployment has its own immutable opening checkpoint. Contiguous headers are retained in bounded batches; oversized evidence is split without discarding it. Posting and cursor advancement remain atomic, and signed delivery receipts retain their original authorization checks.

The Workers configuration is in `cloudflare/wrangler.jsonc`. It uses a permanent Worker URL and durable storage. The backend has no signing key and exposes no transaction-broadcast or arbitrary event-ingestion endpoint. The configured mainnet app permits the approved operator's single reviewed purchase-close flow.

Run `bun install --frozen-lockfile` in both the repository root and `cloudflare/`, build the frontend with `bunx vite build`, then run `bun run types`, `bun run typecheck`, `bun run test`, and `bun run dry-run` inside `cloudflare/`. Deployment is a separate step after verification.

The public deployment is https://arc-business-operating-account.swmengappdev.workers.dev/. It runs without the owner Mac and retains the books in a Durable Object. Its deployment and source-parity records are in `docs/evidence/cloudflare-deployment.json` and `docs/evidence/cloudflare-source-checks.json`.

The pinned Workers runtime supports compatibility date `2026-10-30`, which is used for both testing and deployment. The 10 local Workers tests cover projection parity with Studio, real object eviction, rollback, isolation, request limits, large evidence, and catch-up alarms. Passing them does not by itself establish a remote deployment.

[Mainnet walkthrough](https://arc-business-operating-account.swmengappdev.workers.dev/demo/) · [Direct MP4](https://arc-business-operating-account.swmengappdev.workers.dev/demo/mainnet-walkthrough.mp4)
