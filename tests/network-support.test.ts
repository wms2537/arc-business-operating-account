import { KERNEL_ABI, RELEASE_ID } from "../src/lib/kernel-abi";
import { record, array, hex, sameAddress, address } from "../src/lib/boundary";
import { expect, test } from "bun:test";
import { createPublicClient, custom, keccak256, toBytes, toHex, encodeFunctionResult, decodeFunctionData, erc20Abi } from "viem";
import { parseManifest, manifestIdentity, validateDeployment, networkSettings, deploymentRpcUrl, type DeploymentManifest } from "../src/lib/deployment";
import { reconcileIntent, type Intent, type IntentStore } from "../src/lib/transactions";
import { Books } from "../server/books";
import { type RawBlock } from "../server/chain";
import fixture from "../docs/evidence/arc-testnet/rehearsal/cp-manifest.json";
const testnet = parseManifest(fixture);
const candidate = { ...testnet, environment: "arc-mainnet", chainId: 5042 } satisfies Omit<DeploymentManifest, "instanceId">;
const mainnet = () => parseManifest({ ...candidate, instanceId: manifestIdentity(candidate) });
test("mainnet accepts only its own network and identity", () => {
  const m = mainnet(); expect(m.chainId).toBe(5042); expect(m.environment).toBe("arc-mainnet"); expect(m.instanceId).not.toBe(testnet.instanceId);
});
test("testnet remains unchanged", () => { expect(parseManifest(fixture)).toEqual(testnet); });
for (const [environment, chainId] of [["arc-mainnet", 5042002], ["arc-testnet", 5042], ["local-anvil", 5042], ["arc-mainnet", 1], ["ethereum", 1]]) {
  test(`reject mismatched network ${environment}/${chainId}`, () => { expect(() => parseManifest({ ...testnet, environment, chainId })).toThrow(); });
}
test("changing the chain cannot reuse a deployment identity", () => { expect(() => parseManifest(candidate)).toThrow("Deployment identity mismatch"); });
test("mainnet rejects a non-system USDC address", () => { expect(() => parseManifest({ ...candidate, usdcAddress: "0x1000000000000000000000000000000000000000" })).toThrow("Arc USDC mismatch"); });
test("mainnet retains the reviewed source gate", () => { expect(() => parseManifest({ ...candidate, sourceSha256: "bad" })).toThrow("Source artifact mismatch"); });
test("mainnet fees use native USDC and do not post a reverted business event", () => {
 const m=mainnet(), books=new Books(":memory:",m), initial=books.balances();
 try {
  const block:RawBlock={height:Number(m.opening.block)+1,hash:keccak256(toBytes("mainnet-fee-unit-fixture")),parent:m.opening.hash,timestamp:Number(m.opening.timestamp)+1,transactions:[{hash:keccak256(toBytes("reverted-unit-transaction")),from:m.lenderAddress,to:m.kernelAddress,input:"0x",nonce:0,value:"0",status:"reverted",gasUsed:"21000",effectiveGasPrice:"25000000000",index:0,logs:[]}]};
  books.capture(block);books.project();expect(books.balances()).toEqual(initial);expect(books.fees()).toHaveLength(1);expect(books.fees()[0]).toMatchObject({asset:"native USDC",decimals:18,amount:"525000000000000"});
 } finally {books.close();}
});
for(const wrong of ["chain","instance"]) test(`testnet intent cannot recover on mainnet by changing only ${wrong}`,async()=>{
 const m=mainnet();let requests=0,saves=0;
 const client=createPublicClient({transport:custom({request:async()=>{requests++;throw Error("RPC must not be touched");}})});
 const store:IntentStore={list:()=>[],save:()=>{saves++;}};
 const intent:Intent={id:"network-isolation",deployment:wrong==="chain"?testnet.instanceId:m.instanceId,chainId:wrong==="chain"?5042:5042002,signer:m.lenderAddress,nonce:0,to:m.kernelAddress,data:"0x",value:"0",fromBlock:m.opening.block,createdAt:1,purpose:"Unit fixture only",state:{kind:"unknown",detail:"not sent"}};
 await expect(reconcileIntent(client,m,store,intent,BigInt(m.opening.block))).rejects.toThrow("another deployment");expect(requests).toBe(0);expect(saves).toBe(0);
});

test("mainnet RPC and labels cannot inherit a testnet override",()=>{
 expect(deploymentRpcUrl("arc-mainnet",{ARC_RPC_URL:"https://testnet.invalid",ARC_TESTNET_RPC_URL:"https://other-testnet.invalid"})).toBe("https://rpc.mainnet.arc.io");
 expect(deploymentRpcUrl("arc-mainnet",{ARC_MAINNET_RPC_URL:"https://mainnet.example"})).toBe("https://mainnet.example");
 expect(deploymentRpcUrl("arc-testnet",{ARC_RPC_URL:"https://legacy-testnet.example"})).toBe("https://legacy-testnet.example");
 expect(deploymentRpcUrl("local-anvil",{LOCAL_RPC_URL:"http://127.0.0.1:9999"})).toBe("http://127.0.0.1:9999");
 expect(networkSettings("arc-mainnet")).toMatchObject({label:"Arc Mainnet",arc:true,feeAsset:"native USDC"});
 expect(networkSettings("arc-mainnet").chain.id).toBe(5042);
 expect(networkSettings("arc-testnet").chain.id).toBe(5042002);
 expect(networkSettings("local-anvil")).toMatchObject({arc:false,feeAsset:"local ETH"});
});

for (const [label, code] of [["missing", "0x"], ["truncated", "0x6000"], ["replaced", toHex(new Uint8Array(RELEASE_ID.runtimeBytes))]]) {
 test(`mainnet rejects ${label} runtime before trusting opening balances`, async () => {
  const m=mainnet();
  const client=createPublicClient({transport:custom({request:async({method,params})=>{
   if(method==="eth_chainId")return toHex(5042);
   if(method==="eth_getCode")return code;
   if(method==="eth_call"){
    const call=record(array(params)[0]);
    if(sameAddress(address(call.to),m.usdcAddress))return encodeFunctionResult({abi:erc20Abi,functionName:"decimals",result:6});
    const name=decodeFunctionData({abi:KERNEL_ABI,data:hex(call.data)}).functionName;
    if(name==="usdc")return encodeFunctionResult({abi:KERNEL_ABI,functionName:"usdc",result:m.usdcAddress});
    if(name==="lender")return encodeFunctionResult({abi:KERNEL_ABI,functionName:"lender",result:m.lenderAddress});
    if(name==="getPool")return encodeFunctionResult({abi:KERNEL_ABI,functionName:"getPool",result:[m.lenderAddress,BigInt(m.opening.poolCash),0n]});
    throw Error("Runtime rejection must precede opening account reads");
   }
   if(method==="eth_getBlockByNumber")return {number:toHex(BigInt(m.opening.block)),hash:m.opening.hash,timestamp:toHex(BigInt(m.opening.timestamp)),transactions:[],gasLimit:"0x0",gasUsed:"0x0",difficulty:"0x0",size:"0x0"};
   if(method==="eth_getTransactionReceipt")return {transactionHash:m.deploymentTransaction,transactionIndex:"0x0",blockHash:m.opening.hash,blockNumber:toHex(BigInt(m.deploymentBlock)),from:m.lenderAddress,to:null,contractAddress:m.kernelAddress,cumulativeGasUsed:"0x0",gasUsed:"0x0",logs:[],status:"0x1",effectiveGasPrice:"0x0",type:"0x2"};
   throw Error(`Unexpected unit RPC method: ${method}`);
  }})});
  await expect(validateDeployment(client,m)).rejects.toThrow(/Runtime length|Contract differs/);
 });
}
