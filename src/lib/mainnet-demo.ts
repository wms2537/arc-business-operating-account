import { encodeFunctionData, formatUnits, type Address, type Hex } from "viem";
import { KERNEL_ABI } from "./kernel-abi";
import { address, sameAddress } from "./boundary";
import type { DeploymentManifest } from "./deployment";

export const MAINNET_DEMO_OWNER = address("0x40e4CCd3Db59580b23F5dB16e1F9e1BCf6d2Bf8E");
export const MAINNET_DEMO_FIXTURE = "mainnet-small-group-2026-10-31";
export const MAINNET_CLOSE_LIMITS = { gas: 900000n, maxFeePerGas: 32000000000n, maxPriorityFeePerGas: 1000000000n };
export type WalletFeeLimits = typeof MAINNET_CLOSE_LIMITS;
export const mainnetCloseFeeUSDC = formatUnits(MAINNET_CLOSE_LIMITS.gas * MAINNET_CLOSE_LIMITS.maxFeePerGas, 18);

/** This release authorizes one operator and one mainnet demo close. */
export function mainnetDemoLimits(manifest: DeploymentManifest, signer: Address, to: Address, data: Hex): WalletFeeLimits | undefined {
  if (manifest.environment !== "arc-mainnet") return undefined;
  const expected = encodeFunctionData({ abi: KERNEL_ABI, functionName: "commitPlan", args: [1n] });
  if (manifest.chainId !== 5042 || manifest.opening.fixtureVersion !== MAINNET_DEMO_FIXTURE || !sameAddress(signer, MAINNET_DEMO_OWNER) || !sameAddress(to, manifest.kernelAddress) || data !== expected)
    throw Error("This mainnet demo permits only the approved operator to close group #1. Other financial actions are disabled.");
  return { ...MAINNET_CLOSE_LIMITS };
}
export function checkMainnetCloseQuote(limits: WalletFeeLimits, estimate: bigint, baseFee: bigint | null, gasPrice: bigint) {
  if (estimate <= 0n || (estimate * 110n + 99n) / 100n + 10000n > limits.gas)
    throw Error("The close exceeds its approved gas limit. Nothing was sent.");
  if (baseFee === null || baseFee + limits.maxPriorityFeePerGas > limits.maxFeePerGas || gasPrice > limits.maxFeePerGas)
    throw Error("Current fees exceed the approved ceiling. Nothing was sent.");
}
