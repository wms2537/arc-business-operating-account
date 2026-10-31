import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPublicClient,http,erc20Abi,toBytes } from 'viem';
import { KERNEL_ABI,RELEASE_ID } from '../src/lib/kernel-abi';
import { record,hex,json } from '../src/lib/boundary';
const endpoints=['https://rpc.testnet.arc.io','https://rpc.blockdaemon.testnet.arc.io','https://rpc.drpc.testnet.arc.io','https://rpc.quicknode.testnet.arc.io'];
const expected='768b5bff3015eab39363f7472f3dcaed3709025395e90d6620090d021523009b',token='0x3600000000000000000000000000000000000000';
const digest=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
if(digest(await readFile('contracts/BusinessKernel.sol'))!==expected||RELEASE_ID.sourceSha256!==expected)throw Error('Kernel identity changed');
if(digest(await readFile('contracts/IBusinessKernel.sol'))!==RELEASE_ID.interfaceSha256)throw Error('Interface identity changed');
const artifact=record(JSON.parse(await readFile('contracts/release-out/BusinessKernel.sol/BusinessKernel.json','utf8'))),runtime=hex(record(artifact.deployedBytecode).object),creation=hex(record(artifact.bytecode).object);
if(toBytes(runtime).length!==24475)throw Error('Unexpected release runtime size');
const attempts:{rpc:string;status:string;detail?:string}[]=[];
await mkdir('docs/evidence/arc-testnet',{recursive:true});
let passed=false;
for(const rpc of endpoints){
 const client=createPublicClient({transport:http(rpc,{retryCount:0,timeout:15000})});
 try{
  const chainId=await client.getChainId();if(chainId!==5042002)throw Error('Network is not Arc testnet');
  const [decimals,code,latest,finalized,gasPrice,fees]=await Promise.all([
   client.readContract({address:token,abi:erc20Abi,functionName:'decimals'}),client.getBytecode({address:token}),client.getBlock(),client.getBlock({blockTag:'finalized'}),client.getGasPrice(),client.estimateFeesPerGas()]);
  if(decimals!==6||!code||code==='0x'||!finalized.hash||finalized.number===null)throw Error('Token code, precision or finality is unavailable');
  attempts.push({rpc,status:'passed'});
  const report={status:'preflight-passed',scope:'Read-only Arc testnet preflight; no transaction submitted',authorization:'User authorized Arc testnet deployment and real-wallet verification using testnet funds only in the existing WMHY Studio project.',checkedAt:new Date().toISOString(),rpc,chainId,usdcAddress:token,erc20Decimals:decimals,nativeDecimals:18,kernelSourceSha256:expected,interfaceSourceSha256:RELEASE_ID.interfaceSha256,runtimeBytes:toBytes(runtime).length,creationBytecodeSha256:digest(toBytes(creation)),release:RELEASE_ID,abiFunctions:KERNEL_ABI.filter(x=>x.type==='function').length,latestBlock:{number:latest.number,hash:latest.hash,timestamp:latest.timestamp,transactions:latest.transactions.length,gasLimit:latest.gasLimit,gasUsed:latest.gasUsed},finalizedBlock:{number:finalized.number,hash:finalized.hash,timestamp:finalized.timestamp},gasPrice,fees,attempts,walletIdentityVerified:false,transactionsSubmitted:0,credentialsPresent:{circleApi:['CIRCLE_DEVELOPER_CONTROLLED_API_KEY','CIRCLE_API_KEY','CIRCLE_SCP_API_KEY'].some(k=>!!process.env[k]),circleEntitySecret:['CIRCLE_ENTITY_SECRET','ENTITY_SECRET','CIRCLE_SCP_ENTITY_SECRET'].some(k=>!!process.env[k])}};
  await writeFile('docs/evidence/arc-testnet/preflight.json',json(report));console.log('ARC_TESTNET_PREFLIGHT',json({rpc,chainId,decimals,runtimeBytes:report.runtimeBytes,latestBlock:report.latestBlock,gasPrice,fees,credentialsPresent:report.credentialsPresent}));passed=true;break;
 }catch(error){attempts.push({rpc,status:'failed',detail:(error instanceof Error?error.message:String(error)).slice(0,900)});}
}
if(!passed){await writeFile('docs/evidence/arc-testnet/preflight-failures.json',json({status:'failed',attempts,transactionsSubmitted:0}));console.error(json(attempts));process.exitCode=1;}
