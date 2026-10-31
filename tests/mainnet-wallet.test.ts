import { test, expect } from "bun:test";
import { encodeFunctionData } from "viem";
import { KERNEL_ABI } from "../src/lib/kernel-abi";
import { parseManifest, manifestIdentity, type DeploymentManifest } from "../src/lib/deployment";
import { MAINNET_DEMO_OWNER, MAINNET_DEMO_FIXTURE, MAINNET_CLOSE_LIMITS, mainnetDemoLimits, checkMainnetCloseQuote } from "../src/lib/mainnet-demo";
import fixture from "../docs/evidence/arc-testnet/rehearsal/cp-manifest.json";
const testnet=parseManifest(fixture);
const base={...testnet,environment:"arc-mainnet",chainId:5042,opening:{...testnet.opening,fixtureVersion:MAINNET_DEMO_FIXTURE}} satisfies Omit<DeploymentManifest,"instanceId">;
const manifest=parseManifest({...base,instanceId:manifestIdentity(base)});
const close=encodeFunctionData({abi:KERNEL_ABI,functionName:"commitPlan",args:[1n]});
test("mainnet close has a fixed maximum fee of 0.0288 USDC",()=>{const limits=mainnetDemoLimits(manifest,MAINNET_DEMO_OWNER,manifest.kernelAddress,close);expect(limits).toEqual(MAINNET_CLOSE_LIMITS);expect(limits && limits.gas*limits.maxFeePerGas).toBe(28800000000000000n);});
test("other operators, targets, groups and mainnet deployments cannot spend",()=>{
 expect(()=>mainnetDemoLimits(manifest,manifest.lenderAddress,manifest.kernelAddress,close)).toThrow();
 expect(()=>mainnetDemoLimits(manifest,MAINNET_DEMO_OWNER,manifest.usdcAddress,close)).toThrow();
 expect(()=>mainnetDemoLimits(manifest,MAINNET_DEMO_OWNER,manifest.kernelAddress,encodeFunctionData({abi:KERNEL_ABI,functionName:"commitPlan",args:[2n]}))).toThrow();
 expect(()=>mainnetDemoLimits({...manifest,opening:{...manifest.opening,fixtureVersion:"other"}},MAINNET_DEMO_OWNER,manifest.kernelAddress,close)).toThrow();
});
test("testnet actions retain their existing wallet behavior",()=>{expect(mainnetDemoLimits(testnet,testnet.lenderAddress,testnet.usdcAddress,"0x")).toBeUndefined();});
test("mainnet fee spikes and oversized calls stop before a wallet request",()=>{
 checkMainnetCloseQuote(MAINNET_CLOSE_LIMITS,700000n,25000000000n,26000000000n);
 for(const estimate of [0n,900000n])expect(()=>checkMainnetCloseQuote(MAINNET_CLOSE_LIMITS,estimate,25000000000n,26000000000n)).toThrow();
 expect(()=>checkMainnetCloseQuote(MAINNET_CLOSE_LIMITS,700000n,32000000000n,32000000000n)).toThrow();
 expect(()=>checkMainnetCloseQuote(MAINNET_CLOSE_LIMITS,700000n,25000000000n,32000000001n)).toThrow();
 expect(()=>checkMainnetCloseQuote(MAINNET_CLOSE_LIMITS,700000n,null,26000000000n)).toThrow();
});

// The RPC and wallet below are local test doubles. No signing or network calls occur.
import { createPublicClient, custom, toHex, encodeFunctionResult, decodeFunctionData, erc20Abi, keccak256, toBytes } from "viem";
import { readFile } from "node:fs/promises";
import { record, array, hex, address, sameAddress } from "../src/lib/boundary";
import { submitIntent, type Intent } from "../src/lib/transactions";
async function submissionFixture(gasPrice: bigint) {
 const runtime=hex(record(JSON.parse(await readFile("release/business-kernel.json","utf8"))).deployedBytecode);
 const client=createPublicClient({transport:custom({request:async({method,params})=>{
  if(method==="eth_chainId")return toHex(5042);
  if(method==="eth_getCode")return runtime;
  if(method==="eth_blockNumber")return toHex(BigInt(manifest.opening.block)+1n);
  if(method==="eth_getTransactionCount")return "0x0";
  if(method==="eth_estimateGas")return toHex(700000n);
  if(method==="eth_gasPrice")return toHex(gasPrice);
  if(method==="eth_call") {
   const call=record(array(params)[0]);
   if(sameAddress(address(call.to),manifest.usdcAddress))return encodeFunctionResult({abi:erc20Abi,functionName:"decimals",result:6});
   const decoded=decodeFunctionData({abi:KERNEL_ABI,data:hex(call.data)});
   if(decoded.functionName==="commitPlan")return "0x";
   if(decoded.functionName==="usdc")return encodeFunctionResult({abi:KERNEL_ABI,functionName:"usdc",result:manifest.usdcAddress});
   if(decoded.functionName==="lender")return encodeFunctionResult({abi:KERNEL_ABI,functionName:"lender",result:manifest.lenderAddress});
   if(decoded.functionName==="getPool")return encodeFunctionResult({abi:KERNEL_ABI,functionName:"getPool",result:[manifest.lenderAddress,BigInt(manifest.opening.poolCash),0n]});
   if(decoded.functionName==="accountedCustody")return encodeFunctionResult({abi:KERNEL_ABI,functionName:"accountedCustody",result:BigInt(manifest.opening.custody)});
   if(decoded.functionName==="getAccount") {const a=manifest.opening.accounts.find(a=>BigInt(a.id)===decoded.args[0]);if(!a)throw Error("Unexpected account");return encodeFunctionResult({abi:KERNEL_ABI,functionName:"getAccount",result:[a.owner,BigInt(a.cash),100000n,0n,0n,0n]});}
   throw Error(`Unexpected contract call: ${decoded.functionName}`);
  }
  if(method==="eth_getBlockByNumber")return {number:toHex(BigInt(manifest.opening.block)),hash:manifest.opening.hash,timestamp:toHex(BigInt(manifest.opening.timestamp)),transactions:[],gasLimit:"0x0",gasUsed:"0x0",difficulty:"0x0",size:"0x0",baseFeePerGas:toHex(25000000000n)};
  if(method==="eth_getTransactionReceipt")return {transactionHash:manifest.deploymentTransaction,transactionIndex:"0x0",blockHash:manifest.opening.hash,blockNumber:toHex(BigInt(manifest.deploymentBlock)),from:manifest.lenderAddress,to:null,contractAddress:manifest.kernelAddress,cumulativeGasUsed:"0x0",gasUsed:"0x0",logs:[],status:"0x1",effectiveGasPrice:"0x0",type:"0x2"};
  throw Error(`Unexpected test RPC: ${method}`);
 }})});
 const intents:Intent[]=[], requests:Array<Parameters<Parameters<typeof submitIntent>[0]["wallet"]["send"]>[0]>=[];
 const options={client,manifest,store:{list:()=>intents,save:(intent:Intent)=>{intents.push(intent);}},to:manifest.kernelAddress,data:close,purpose:"Local unit fixture only",wallet:{identity:async()=>({address:MAINNET_DEMO_OWNER,chainId:5042}),send:async(input:Parameters<Parameters<typeof submitIntent>[0]["wallet"]["send"]>[0])=>{requests.push(input);return keccak256(toBytes("never-broadcast-unit-fixture"));}}};
 return {options,intents,requests};
}
test("actual intent submission passes fixed fee limits to the wallet boundary",async()=>{const f=await submissionFixture(26000000000n);const result=await submitIntent(f.options);expect(result.state.kind).toBe("submitted");expect(f.requests).toHaveLength(1);expect(f.requests[0].feeLimits).toEqual(MAINNET_CLOSE_LIMITS);expect(f.requests[0].value).toBe(0n);});
test("a fee spike creates no intent and never requests the wallet",async()=>{const f=await submissionFixture(32000000001n);await expect(submitIntent(f.options)).rejects.toThrow("fees exceed");expect(f.intents).toHaveLength(0);expect(f.requests).toHaveLength(0);});

test("a reverted mainnet close cannot spend a second gas allowance",async()=>{const f=await submissionFixture(26000000000n);f.intents.push({id:"charged-first-attempt",deployment:manifest.instanceId,chainId:5042,signer:MAINNET_DEMO_OWNER,nonce:0,to:manifest.kernelAddress,data:close,value:"0",fromBlock:manifest.opening.block,createdAt:1,purpose:"Local reverted unit fixture",state:{kind:"reverted",hash:keccak256(toBytes("reverted-unit-fixture")),block:manifest.opening.block}});await expect(submitIntent(f.options)).rejects.toThrow("attempt is already recorded");expect(f.requests).toHaveLength(0);expect(f.intents).toHaveLength(1);});
