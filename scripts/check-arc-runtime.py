from pathlib import Path
import subprocess,os,json,hashlib,tempfile
root=Path.cwd();assert root.resolve()==Path('/home/user/app')
expected=json.loads((root/'docs/evidence/release-artifact-verification.json').read_text())
source=(root/'scripts/verify-release-artifact.py').read_text()
old='[forge, "test", "--json", "-vv"]';assert source.count(old)==1
source=source.replace(old,'[forge, "test", "--network", "arc", "--json", "-vv"]')
source=source.replace('evidence = root / "docs/evidence"','evidence = root / "docs/evidence/arc-testnet/runtime"')
source=source.replace('Local EVM tests deploying release-profile creation bytecode; no Arc runtime or testnet claim.','Local Arc VM (--network arc) executing release-profile creation bytecode; no public network transaction.')
source=source.replace('Evidence: docs/evidence/','Evidence: docs/evidence/arc-testnet/runtime/')
with tempfile.TemporaryDirectory(prefix='arc-runtime-harness-') as temp:
 script=Path(temp)/'verify.py';script.write_text(source)
 env={**os.environ,'FORGE_BIN':os.environ.get('ARC_FORGE','/tmp/arc-business-arc-foundry/v0.8.0-2/arc-forge'),'FOUNDRY_FUZZ_RUNS':'256','FOUNDRY_FUZZ_SEED':'0x'+'0'*60+'c0de'}
 result=subprocess.run(['python3',str(script)],env=env,capture_output=True,text=True)
 out=root/'docs/evidence/arc-testnet/runtime';out.mkdir(parents=True,exist_ok=True);(out/'command.log').write_text(result.stdout+result.stderr)
 print('ARC_RUNTIME_EXIT',result.returncode,flush=True);print((result.stdout+result.stderr)[-2200:],flush=True)
 if result.returncode:raise SystemExit(result.returncode)
 report=json.loads((out/'release-artifact-verification.json').read_text())
 assert report['tests']=={'Success':177,'Failure':0,'Skipped':0},report['tests']
 assert report['runtime_template_sha256']==expected['runtime_template_sha256'],'Arc toolchain changed the reviewed runtime bytes'
 assert report['source_sha256']==expected['source_sha256'],'Contract source changed'
 (out/'identity-check.json').write_text(json.dumps({'status':'passed','network':'local-arc-vm','tests':report['tests'],'runtimeBytes':report['runtime_bytes'],'sameReviewedRuntime':True,'sameSources':True,'originalHarnessSha256':hashlib.sha256((root/'scripts/verify-release-artifact.py').read_bytes()).hexdigest(),'adaptedHarnessSha256':hashlib.sha256(source.encode()).hexdigest(),'adaptation':'Add --network arc and isolate evidence outputs; all assertions and release bytecode deployment retained.','publicNetworkTransactions':0},indent=2)+'\n')
 print('ARC_RUNTIME_IDENTITY_PASS',report['tests'],flush=True)
