/** Read-only mainnet verification. It does not read the private vault or send transactions. */
import { readdir, writeFile } from "node:fs/promises";
import { encodeDeployData, formatUnits, parseEventLogs, type Address } from "viem";
import { client, DATA, OWNER, TOKEN, ACTOR_FUNDING, ACTOR_GAS_CAP, MAX_FEE, ROLES, readJson, publicPlan, reviewedBytecode } from "./arc-mainnet-prepare";
import { KERNEL_ABI } from "../src/lib/kernel-abi";
import { array, record, text, address, hash, uint, integer, json, sameAddress } from "../src/lib/boundary";
import { parseManifest, validateDeployment } from "../src/lib/deployment";
import { readAccount, readPlan, decodeTerms } from "../src/lib/kernel-client";

type Check = { name: string; actual: unknown; expected: unknown };
const checks: Check[] = [];
function equal(name: string, actual: unknown, expected: unknown) { if(json(actual)!==json(expected))throw Error(`${name}: ${json(actual)} != ${json(expected)}`);checks.push({name,actual,expected}); }
async function verify() {
 const actors=array(await readJson(`${DATA}/actors.json`)).map(value=>{const r=record(value);return{name:text(r.name),address:address(r.address)};});
 equal("public plan is unchanged",await readJson(`${DATA}/plan.json`),publicPlan(actors));
 const actor=(name:string):Address=>{const a=actors.find(a=>a.name===name);if(!a)throw Error(`Missing actor ${name}`);return a.address;};
 equal("mainnet chain",await client.getChainId(),5042);
 const manifest=parseManifest(await readJson(`${DATA}/cp-manifest.json`));
 equal("mainnet environment",manifest.environment,"arc-mainnet");
 equal("mainnet fixture",manifest.opening.fixtureVersion,"mainnet-small-group-2026-10-31");
 equal("lender role",manifest.lenderAddress.toLowerCase(),actor("cp-1").toLowerCase());
 await validateDeployment(client,manifest);
 const snapshot=await client.getBlock({blockTag:"finalized"});
 const files=(await readdir(`${DATA}/operations`)).filter(f=>f.endsWith('.json')&&!f.endsWith('-receipt.json')).sort();
 const ids=["deploy",...[0,1,2,3,4,6,7].map(i=>`fund-${i}`),...[1,2,3].map(i=>`open-${i}`),...[1,2,3,6,7].map(i=>`allowance-${i}`),"pool",...[1,2,3].flatMap(i=>[`cash-${i}`,`floor-${i}`,`limit-${i}`]),"offer","draft","supplier-approval",...[1,2,3].flatMap(i=>[`lender-approval-${i}`,`receivable-${i}`,`join-${i}`])].sort();
 equal("exact setup operation set",files.map(f=>f.slice(0,-5)),ids);
 const receipts=[];let fees=0n;
 const nonces=new Map<string,number[]>();
 for(const file of files){
  const op=record(await readJson(`${DATA}/operations/${file}`)),id=text(op.id),from=address(op.from),txHash=hash(op.hash),role=text(op.actor);
  equal(`${id} public role`,from.toLowerCase(),actor(role).toLowerCase());
  const [tx,receipt]=await Promise.all([client.getTransaction({hash:txHash}),client.getTransactionReceipt({hash:txHash})]);
  equal(`${id} chain`,tx.chainId,5042);equal(`${id} sender`,tx.from.toLowerCase(),from.toLowerCase());
  equal(`${id} target`,tx.to?.toLowerCase()??null,op.to===null?null:address(op.to).toLowerCase());
  equal(`${id} calldata`,tx.input,op.data);equal(`${id} value`,tx.value,uint(op.value));equal(`${id} nonce`,tx.nonce,integer(op.nonce));
  equal(`${id} gas limit`,tx.gas,uint(op.gas));equal(`${id} fee ceiling`,tx.maxFeePerGas,MAX_FEE);
  equal(`${id} success`,receipt.status,"success");equal(`${id} finalized`,receipt.blockNumber<=snapshot.number,true);
  equal(`${id} canonical hash`,(await client.getBlock({blockNumber:receipt.blockNumber})).hash,receipt.blockHash);
  const fee=receipt.gasUsed*receipt.effectiveGasPrice;fees+=fee;
  const saved=record(await readJson(`${DATA}/operations/${id}-receipt.json`));equal(`${id} retained hash`,saved.transactionHash,txHash);equal(`${id} retained fee`,uint(saved.gasUsed)*uint(saved.effectiveGasPrice),fee);
  const values=nonces.get(role)??[];values.push(tx.nonce);nonces.set(role,values);
  receipts.push({id,hash:txHash,from:tx.from,to:tx.to,nonce:tx.nonce,block:receipt.blockNumber,gasUsed:receipt.gasUsed,feeNativeWei:fee});
 }
 for(const role of ROLES){const values=(nonces.get(role)??[]).sort((a,b)=>a-b);equal(`${role} contiguous nonces`,values,values.map((_,i)=>i));equal(`${role} nonce count at snapshot`,await client.getTransactionCount({address:actor(role),blockNumber:snapshot.number}),values.length);}
 equal("actor fees within cap",fees<=ACTOR_GAS_CAP,true);
 const deployed=await client.getTransaction({hash:manifest.deploymentTransaction});
 equal("reviewed creation code",deployed.input,encodeDeployData({abi:KERNEL_ABI,bytecode:await reviewedBytecode(),args:[TOKEN,actor("cp-1")]}));
 equal("deployment origin",deployed.from.toLowerCase(),actor("master").toLowerCase());
 const draft=record(await readJson(`${DATA}/operations/draft.json`)),draftTx=await client.getTransaction({hash:hash(draft.hash)}),terms=decodeTerms(draftTx.input);
 const draftReceipt=await client.getTransactionReceipt({hash:draftTx.hash}),drafted=parseEventLogs({abi:KERNEL_ABI,logs:draftReceipt.logs,eventName:"PlanDrafted"}).filter(e=>sameAddress(e.address,manifest.kernelAddress));
 equal("one draft event",drafted.length,1);equal("draft plan identity",drafted[0].args.planId,1n);equal("retained plan terms hash",(await readPlan(client,manifest.kernelAddress,1n,snapshot.number)).termsHash,drafted[0].args.termsHash);
 equal("group workflow",terms.kind,0);equal("lender pool",terms.lenderPoolId,1n);equal("buyer count",terms.buyers.length,3);
 const buyerRoles=[2,6,7],cash=[30000n,25000n,20000n],own=[20000n,15000n,10000n],loans=[16000n,16500n,12500n],units=[40n,35n,25n];
 let totalCost=0n;
 for(let i=0;i<3;i++){
  const id=BigInt(i+1),b=terms.buyers[i],a=await readAccount(client,manifest.kernelAddress,id,snapshot.number);
  equal(`buyer ${id} terms`,{owner:b.owner.toLowerCase(),account:b.accountId,quantity:b.quantity,ownCash:b.ownCash,creditDraw:b.creditDraw,creditLimit:b.creditLimit},{owner:actor(`cp-${buyerRoles[i]}`).toLowerCase(),account:id,quantity:units[i],ownCash:own[i],creditDraw:loans[i],creditLimit:loans[i]});
  equal(`buyer ${id} account`,{owner:a.owner.toLowerCase(),cash:a.cash,floor:a.floor,held:a.aggregateHeld,active:a.activePlanCount,principal:a.outstandingPrincipal,available:a.availableCash},{owner:actor(`cp-${buyerRoles[i]}`).toLowerCase(),cash:cash[i],floor:10000n,held:own[i],active:1n,principal:0n,available:0n});
  totalCost+=b.ownCash+b.creditDraw;
 }
 equal("total purchase funding",totalCost,90000n);equal("offer reference",terms.offerRefs.map(o=>({id:o.offerId,quantity:o.quantity,payee:o.payee.toLowerCase()})),[{id:1n,quantity:100n,payee:actor("cp-4").toLowerCase()}]);
 const options={address:manifest.kernelAddress,abi:KERNEL_ABI,blockNumber:snapshot.number};
 equal("open plan",(await readPlan(client,manifest.kernelAddress,1n,snapshot.number)).status,"Open");
 equal("ready group",(await client.readContract({...options,functionName:"planReadiness",args:[1n]}))[0],true);
 const pool=await client.readContract({...options,functionName:"getPool",args:[1n]});equal("pool cash and reservations",[pool[1],pool[2]],[50000n,45000n]);
 equal("accounted custody",await client.readContract({...options,functionName:"accountedCustody"}),125000n);
 const balances=await Promise.all([...actors,{name:"kernel",address:manifest.kernelAddress}].map(async a=>({...a,nativeWei:await client.getBalance({address:a.address,blockNumber:snapshot.number})})));
 equal("native USDC conservation",balances.reduce((n,a)=>n+a.nativeWei,0n)+fees,ACTOR_FUNDING);
 const funding=record(await readJson(`${DATA}/funding-confirmed.json`));
 equal("owner funding identity",sameAddress(text(funding.from),OWNER),true);
 const result={status:"setup-verified-ready-for-wallet-close",chainId:5042,kernel:manifest.kernelAddress,deployment:manifest.instanceId,block:snapshot.number,blockHash:snapshot.hash,setupTransactions:receipts.length,actorFeesNativeWei:fees,actorFeesUSDC:formatUnits(fees,18),fundingFeeNativeWei:uint(funding.feeNativeWei),businessCapitalMicroUSDC:"225000",principalBeforeCloseMicroUSDC:"0",supplierPayoutOnCloseMicroUSDC:"90000",principalOnCloseMicroUSDC:"45000",protectedEachMicroUSDC:"10000",checks,receipts,balances,privateVaultAccessed:false,transactionsSentByVerifier:0};
 await writeFile(`${DATA}/setup-independent-verification.json`,json(result)+"\n");console.log(json({status:result.status,checks:checks.length,setupTransactions:receipts.length,kernel:manifest.kernelAddress,actorFeesUSDC:result.actorFeesUSDC}));
}
if(import.meta.main)await verify();
