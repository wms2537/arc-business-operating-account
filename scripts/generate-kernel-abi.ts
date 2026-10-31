import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { keccak256, toBytes } from "viem";
import { record, array, integer, hex } from "../src/lib/boundary";
const artifact = record(
  JSON.parse(
    await readFile(
      "contracts/release-out/BusinessKernel.sol/BusinessKernel.json",
      "utf8",
    ),
  ),
);
const runtime = record(artifact.deployedBytecode);
const abi = array(artifact.abi);
const code = hex(runtime.object);
const ranges = Object.values(record(runtime.immutableReferences))
  .flatMap(array)
  .map((value) => {
    const range = record(value);
    return { start: integer(range.start), length: integer(range.length) };
  });
const bytes = toBytes(code);
for (const range of ranges) {
  if (range.start + range.length > bytes.length)
    throw Error("Invalid immutable range");
  bytes.fill(0, range.start, range.start + range.length);
}
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const identity = {
  sourceSha256: digest(await readFile("contracts/BusinessKernel.sol")),
  interfaceSha256: digest(await readFile("contracts/IBusinessKernel.sol")),
  abiSha256: digest(JSON.stringify(abi)),
  runtimeBytes: bytes.length,
  normalizedRuntimeHash: keccak256(bytes),
  immutableRanges: ranges,
  compiler: "0.8.28",
  profile: "release",
  viaIR: true,
  optimizerRuns: 1,
};
if (
  identity.runtimeBytes !== 24475 ||
  identity.sourceSha256 !==
    "768b5bff3015eab39363f7472f3dcaed3709025395e90d6620090d021523009b"
)
  throw Error("Verified release changed");
await writeFile(
  "src/lib/kernel-abi.ts",
  "// Generated from the verified release artifact by scripts/generate-kernel-abi.ts.\nexport const KERNEL_ABI = " +
    JSON.stringify(abi, null, 2) +
    " as const;\nexport const RELEASE_ID = " +
    JSON.stringify(identity, null, 2) +
    " as const;\n",
);
console.log(JSON.stringify(identity));
