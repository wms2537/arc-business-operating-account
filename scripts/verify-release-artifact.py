#!/usr/bin/env python3
"""Run the repository's assertions against release-profile deployment bytecode.

Run from the repository root after installing dependencies. Only fixture
construction changes in a temporary copy; production sources and assertions
remain untouched. No RPC, wallet, or deployed-chain transaction is used.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def main():
    root = Path.cwd().resolve()
    forge = os.environ.get("FORGE_BIN", "forge")
    evidence = root / "docs/evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    (root / "work").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="release-check-", dir=root / "work") as temp:
        stage = Path(temp)
        artifacts = stage / "release-artifacts"
        env = dict(os.environ, FOUNDRY_PROFILE="release")
        build = subprocess.run(
            [forge, "build", "--skip", "test", "--skip", "script", "--quiet",
             "--out", str(artifacts), "--cache-path", str(stage / "release-cache")],
            cwd=root, env=env, capture_output=True, text=True,
        )
        if build.returncode:
            print(build.stdout + build.stderr)
            return build.returncode

        artifact_path = artifacts / "BusinessKernel.sol/BusinessKernel.json"
        artifact = json.loads(artifact_path.read_text())
        runtime = bytes.fromhex(artifact["deployedBytecode"]["object"].removeprefix("0x"))
        if len(runtime) > 24576:
            raise RuntimeError(f"Runtime too large: {len(runtime)} bytes")

        suite_root = stage / "suite"
        suite_root.mkdir()
        hashes = {}
        for source in (root / "contracts").rglob("*.sol"):
            if not source.is_file():
                continue
            relative = source.relative_to(root)
            if any(part in {"out", "cache", "release-out", "release-cache"} for part in relative.parts):
                continue
            target = suite_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
            hashes[str(relative)] = hashlib.sha256(source.read_bytes()).hexdigest()
        (suite_root / "lib").symlink_to(root / "lib", target_is_directory=True)
        (suite_root / "node_modules").symlink_to(root / "node_modules", target_is_directory=True)
        shutil.copy2(root / "remappings.txt", suite_root / "remappings.txt")
        permission = json.dumps(str(artifacts))
        (suite_root / "foundry.toml").write_text(
            '[profile.default]\nsrc="contracts"\ntest="contracts/test"\n'
            'out="test-out"\ncache_path="test-cache"\nlibs=["lib"]\n'
            'solc_version="0.8.28"\nevm_version="cancun"\n'
            'optimizer=true\noptimizer_runs=200\n'
            f'fs_permissions=[{{access="read",path={permission}}}]\n'
        )

        # Match only the known 2-arg fixture constructor form:
        #   new BusinessKernel(token_expr, lender_expr)
        # where token_expr  = address(<ident>)
        #       lender_expr = address(<ident>) | <ident> (bare address variable)
        # Fail if any other BusinessKernel construction is found.
        replacements = 0
        pat = re.compile(
            r"new BusinessKernel\("
            r"(address\([A-Za-z0-9_.]+\))"   # group 1: token arg
            r",\s*"
            r"([A-Za-z0-9_.]+(?:\([A-Za-z0-9_.]*\))?)"  # group 2: lender arg
            r"\)"
        )
        for test in (suite_root / "contracts/test").glob("*.sol"):
            text = test.read_text()
            text, count = pat.subn(r"_deployReleaseArtifact(\1, \2)", text)
            if "new BusinessKernel" in text:
                raise RuntimeError(f"Unrecognized constructor in {test.name}")
            replacements += count
            test.write_text(text)
        if not replacements:
            raise RuntimeError("No kernel fixture deployments found")

        helper = '''
    function _deployReleaseArtifact(address token, address lend) internal returns (BusinessKernel) {
        bytes memory creation = vm.getCode(ARTIFACT);
        bytes memory initCode = abi.encodePacked(creation, abi.encode(token, lend));
        address deployed;
        assembly ("memory-safe") { deployed := create(0, add(initCode, 32), mload(initCode)) }
        require(deployed != address(0), "Release artifact deployment failed");
        assertLe(deployed.code.length, 24576, "Release runtime exceeds chain limit");
        return BusinessKernel(payable(deployed));
    }
'''.replace("ARTIFACT", json.dumps(str(artifact_path)))
        for filename, anchor in [
            ("KernelBase.t.sol", "abstract contract KernelBase is Test {"),
            ("ContendTests.t.sol", "contract ContentionTest is Test {"),
            ("ApprovalExpiry.t.sol", "contract ApprovalExpiryTest is Test {"),
            ("SinglePool.t.sol", "contract SinglePoolTest is Test {"),
            ("ReceiptCheck.t.sol", "contract ReceiptCheckTest is Test {"),
            ("ReceiptPaths.t.sol", "contract ReceiptPathsTest is Test {"),
            ("ReentrancyTests.t.sol", "contract ReentrancyCallbackTest is Test {"),
        ]:
            path = suite_root / "contracts/test" / filename
            text = path.read_text()
            if anchor not in text:
                raise RuntimeError(f"Fixture anchor changed: {filename}")
            path.write_text(text.replace(anchor, anchor + "\n" + helper, 1))

        test_env = dict(os.environ)
        test_env.pop("FOUNDRY_PROFILE", None)
        result = subprocess.run([forge, "test", "--json", "-vv"], cwd=suite_root,
                                env=test_env, capture_output=True, text=True)
        if not result.stdout.strip():
            print(result.stderr)
            return result.returncode or 1
        suites = json.loads(result.stdout)
        counts = {"Success": 0, "Failure": 0, "Skipped": 0}
        for suite in suites.values():
            for test in suite.get("test_results", {}).values():
                status = test["status"]
                counts[status] = counts.get(status, 0) + 1
        report = {
            "status": "passed" if result.returncode == 0 else "failed",
            "scope": "Local EVM tests deploying release-profile creation bytecode; no Arc runtime or testnet claim.",
            "runtime_bytes": len(runtime),
            "runtime_template_sha256": hashlib.sha256(runtime).hexdigest(),
            "fixture_deployments_replaced": replacements,
            "tests": counts,
            "source_sha256": hashes,
            "compiler": "0.8.28",
            "release_profile": "via_ir=true, optimizer=true, optimizer_runs=1, evm_version=cancun",
        }
        (evidence / "release-artifact-verification.json").write_text(json.dumps(report, indent=2) + "\n")
        (evidence / "release-artifact-test-results.json").write_text(json.dumps(suites, indent=2) + "\n")
        print("RELEASE_ARTIFACT", report["status"], "runtime_bytes", len(runtime))
        print("TESTS", json.dumps(counts, sort_keys=True))
        print("Evidence: docs/evidence/release-artifact-verification.json")
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
