# Arc Business Account testnet verification, 31 October 2026

The existing [Arc Studio project](https://studio.arc.io/app/46704d22-91ee-404d-8ff7-7ad873e3c289) completed its Arc Testnet rehearsal, including an actual MetaMask application transaction, reload recovery and ledger restart/rebuild. All three deployed contracts match the reviewed release and have verified explorer sources. The delivery receipt alongside the final archive records its source and evidence hash checks.

## The approved wallet close

[Group #2 transaction](https://explorer.testnet.arc.io/tx/0x30218840328659d6090bcb964c36c63bddf9ce86f18d9d884f4ac83d5c10b81a)

The operator signed `commitPlan(2)` on the mixed kernel. At block 69973114, the contract paid **0.90 test USDC** to the supplier, recorded **0.45 test USDC principal** across buyers #2, #3 and #4, and retained **0.10 test USDC protected cash per buyer**. Buyer principal is 0.160000, 0.165000 and 0.125000 respectively. Lender cash is 1.500000. The wallet paid only the actual close fee of **0.01649195 test USDC**.

That extra mixed-group principal remains outstanding for the live demonstration. The completed customer-order and group-purchase baseline runs repaid all principal. The 30-test-USDC funding transfer had a separate fee of 0.00184905, for total operator gas of 0.018341 test USDC across funding and close. Funding and close must not be repeated when resuming this project.

## Verified results

| Verification | Result |
| --- | --- |
| Independent public-chain readback | 1,393 passing assertions, 140 confirmed transactions, 23 paired native/ERC-20 transfers |
| Preserved baseline | 1,350 assertions across 137 transactions, before the additional live UI sequence |
| Actual MetaMask reload recovery | Same intent, nonce 3 and transaction; wallet pending nonce stayed 4; zero resubmissions |
| Financial posting | Exactly one close journal source and one native-18 gas record |
| API recovery | All three ledgers rebuilt and reopened with identical content digests |
| Live desktop and phone | Six screens each, 12 captures total; 788px desktop preview and 390px phone; no page-level horizontal overflow |
| Local contract verification | 177 tests against Arc VM release bytecode |
| Local accounting integration | 182 checks passed |
| Local browser regressions | 47 checks passed using the isolated test provider |
| Code and build | Passing type/lint checks and production build |

The actual MetaMask and public-chain evidence is separate from the local Anvil browser regression evidence. The public readback reconciles the native-18 USDC balance, six-decimal ERC-20 view, paired events, finality, exact calldata and receipt fees. Conservation includes the controlled test actors' gas; operator-paid gas is checked separately. Assertions about the baseline balances remain at their original historical blocks.

| Deployment | Arc Testnet contract |
| --- | --- |
| co | [0x9204227043039758FCDEC55E24c65726e0546baF](https://explorer.testnet.arc.io/address/0x9204227043039758FCDEC55E24c65726e0546baF) |
| cp | [0xe973E0Ac0461Af522aDa229FB726D182238E687a](https://explorer.testnet.arc.io/address/0xe973E0Ac0461Af522aDa229FB726D182238E687a) |
| mixed | [0x86A4f981c1D0ad93E528f7120050b99A549171c8](https://explorer.testnet.arc.io/address/0x86A4f981c1D0ad93E528f7120050b99A549171c8) |

All runtimes match the reviewed 24,475-byte release. Kernel SHA-256 is `768b5bff3015eab39363f7472f3dcaed3709025395e90d6620090d021523009b`; interface SHA-256 is `38c02c51dc633f2bd4e922967b53e50ac0ab8323be0cce972c52190c9e283f3a`. The compiler is Solidity 0.8.28 with Cancun, optimizer runs 1 and via IR. This leaves 101 bytes beneath the runtime limit.

## Scenario coverage

The customer-order baseline paid 6.000000 to the supplier and 0.500000 for freight. It ended with merchant cash 6.500000, lender cash 2.000000 and zero principal. Its actual close was replayed through an injected accounting failure, atomic rollback, restart and rebuild.

The group baseline rejected the incomplete 75-unit A/B close. Its complete 100-unit close paid 0.900000 and recorded each buyer's principal separately. Three buyer-signed delivery receipts, opening-receivable collection and subsequent repayment were distinct events. It ended with 0.100000 per buyer, lender cash 0.500000 and zero principal.

The mixed baseline proved shared pool liquidity, reserved account cash and supplier capacity cannot be reused. A 0.050000 pool top-up admitted the last buyer. Release/rejoin and supplier revocation freed the exact reservations. A cancelled customer order retained its escrow until a separate 4.000000 refund. The later UI close is additional to this baseline and leaves the 0.450000 principal described above.

The live close review exposed a cash-summary scope error, which was fixed before signing. It now shows protected cash for the actual plan participants. Two regression checks cover that correction.

## Evidence and continuation

Start with `docs/evidence/arc-testnet/live-checkpoint.json`. The public readback is `rehearsal/independent-chain-verification.json`; the earlier baseline is `rehearsal/baseline-independent-chain-verification.json`. Actual wallet proof is in `rehearsal/wallet-ui-close.json`, `wallet-ui-recovery.json` and `rehearsal/live-api-recovery.json`. Explorer success logs are retained beside the deployment manifests. Earlier HTTP429 and incomplete verification logs are diagnostic history.

`docs/evidence/arc-testnet/snapshot-index.json` identifies six consistent SQLite backups made through the backup API, with integrity checks and hashes. Live and historical baseline databases are separate. UI screenshots and their observed state are in the archive's `delivery/live-ui` directory; their hashes are recorded in `live-ui-capture-index.json`. These are captures of the real embedded Studio preview.

Use `docs/arc-testnet-setup.md` and `public.env.example` to reopen the exported app. Browser-held wallet intent history stays with its original preview origin. Test-actor private keys remain outside the project and export; this package contains public evidence only. Use the original Studio session to continue those actors. No further signing is needed to inspect or rebuild the retained evidence.

This is a verified testnet rehearsal. No mainnet deployment, production rollout, paid upgrade or grant submission is included.
