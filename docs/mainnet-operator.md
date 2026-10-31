# Small mainnet demo

The owner approved a 0.75 USDC total cap for the wallet `0x40e4CCd3Db59580b23F5dB16e1F9e1BCf6d2Bf8E` on Arc mainnet, chain 5042. The code prepares one group-purchase contract using the reviewed, unchanged Solidity release. It is not a completed deployment.

The fixed funding transfer is 0.65 USDC: 0.225 USDC of demo capital plus up to 0.425 USDC for dedicated demo-account gas. Funding and the final wallet close have separate gas ceilings of 30,000 and 900,000 units, both at at most 32 Gwei. The maximum wallet outflow under those ceilings is 0.67976 USDC. The full approved cap remains 0.75 USDC; unused funding stays in the dedicated local accounts and is not automatically spent or returned.

Business amounts: lender pool 0.05 USDC; buyers 0.03, 0.025 and 0.02 USDC; collection payer 0.10 USDC. The group buys 100 units at 0.0009 USDC each. Closing pays the supplier 0.09 USDC, creates 0.045 USDC principal across the buyers, and preserves 0.01 USDC cash for each buyer. Collection and repayment are separate later actions. The setup runner stops before the purchase close.

## Human-operated steps

1. On the owner's Mac, run `bun run scripts/arc-mainnet-prepare.ts prepare`. Type `PREPARE` after reading its explanation. This creates unfunded demo identities, checks the reviewed artifact and current fees, and writes a public funding proposal. It sends no transaction. Do not enter your MetaMask private key or seed.
2. Review `docs/evidence/arc-mainnet/rehearsal/funding-request.json`. Transfer the exact 0.65 native USDC to its generated destination only after confirming Arc mainnet, the owner account, and the fee ceiling in MetaMask. Keep the transaction hash. Never fund twice.
3. Run `bun run scripts/arc-mainnet-run.ts funding <hash>` to verify that exact receipt. This command only reads the chain.
4. Run `bun run scripts/arc-mainnet-run.ts setup`. Read its summary and type `SEND SETUP` only when ready to authorize deployment and the setup transactions. This is the step that signs and sends from the dedicated demo wallets. The application close remains a separate MetaMask action.
5. After setup, import the public `cp-manifest.json` and operation receipts into the existing Studio application, configure the mainnet read-only backend, and verify the ready group before requesting the application close. `close-request.json` records the exact target, calldata and fee limits. The app binds its mainnet wallet request to this demo fixture, the approved owner, and `commitPlan(1)`. It supplies the fixed gas and fee ceilings and rejects a quote above them. Do not increase those limits in MetaMask. The app reserves one paid mainnet close attempt per wallet. A reverted or uncertain attempt must be recovered and its fee reconciled before any new budget review; do not clear its saved intent to retry. A failed funding transfer must likewise be reconciled before another attempt.

An agent may inspect the public plan, receipts and on-chain state. A human must run the steps that create/access the private wallet vault and authorize financial actions. The runner is deliberately interactive and must not be launched by an agent.

## Retained state

Private keys and signed transactions remain in `~/.local/share/arc-business-operating-account/mainnet-5042-v1/`, outside the repository. Keep that folder private and retain it for recovery. Public evidence goes under `docs/evidence/arc-mainnet/rehearsal/`. No private key is printed or included in the public evidence.

The runner records a signed transaction's hash before broadcasting. A resumed operation reconciles that same hash and does not choose a new nonce. Changed terms, missing vaults, duplicate identities, wrong networks, excessive fees and insufficient fixed funding stop the run. A crash can leave `runner.lock` in the private vault; inspect running processes before removing only that lock. Do not delete the vault or operation receipts.

Network details and alternate RPC source: https://docs.arc.io/arc/references/connect-to-arc . Native gas uses 18 decimals, while the USDC contract interface uses six: https://docs.arc.io/arc/references/gas-and-fees . Both represent the same balance.
