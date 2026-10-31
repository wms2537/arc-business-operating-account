import { vi } from "vitest";
import { decodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, toBytes, toHex } from "viem";
import { KERNEL_ABI } from "../../src/lib/kernel-abi";
import { parseManifest } from "../../src/lib/deployment";
import { array, record, hex, address, sameAddress, integer } from "../../src/lib/boundary";
import { parseRawBlock } from "../../server/chain";
import seedInput from "../mainnet-bootstrap.json";
import artifact from "../../release/business-kernel.json";

/** Local test responses only. No requests reach the public Arc endpoint. */
export function installRpcFixture(extraBlocks: number) {
 const seed=record(seedInput),m=parseManifest(seed.manifest),blocks=array(seed.blocks).map(parseRawBlock),tip=blocks[blocks.length-1],target=tip.height+extraBlocks;
 const digest=(height:number)=>height===tip.height?tip.hash:keccak256(toBytes(`local-worker-future-${height}`));
 const reply=(request:unknown):unknown=>{
  const r=record(request),params=r.params===undefined?[]:array(r.params);let result:unknown;
  switch(r.method){
   case "eth_chainId":result=toHex(5042);break;
   case "eth_blockNumber":result=toHex(target);break;
   case "eth_getCode":result=artifact.deployedBytecode;break;
   case "eth_getLogs":result=[];break;
   case "eth_getTransactionReceipt":result={transactionHash:m.deploymentTransaction,transactionIndex:"0x0",blockHash:m.opening.hash,blockNumber:toHex(BigInt(m.deploymentBlock)),from:m.lenderAddress,to:null,contractAddress:m.kernelAddress,cumulativeGasUsed:"0x0",gasUsed:"0x0",logs:[],status:"0x1",effectiveGasPrice:"0x0",type:"0x2"};break;
   case "eth_getBlockByNumber":{
    const quantity=params[0];if(quantity!=="latest"&&quantity!=="finalized"&&(typeof quantity!=="string"||!/^0x[0-9a-fA-F]+$/.test(quantity)))throw Error("Invalid local block quantity");
    const n=quantity==="latest"||quantity==="finalized"?target:integer(Number(BigInt(String(quantity)))),known=blocks.find(b=>b.height===n),opening=n===Number(m.opening.block);
    result={number:toHex(n),hash:opening?m.opening.hash:known?.hash??digest(n),parentHash:known?.parent??digest(n-1),timestamp:toHex(opening?BigInt(m.opening.timestamp):BigInt(known?.timestamp??tip.timestamp+n-tip.height)),transactions:[],gasLimit:"0x1c9c380",gasUsed:"0x0",difficulty:"0x0",size:"0x0",baseFeePerGas:toHex(20000000000n)};break;
   }
   case "eth_call":{
    const call=record(params[0]);
    if(sameAddress(address(call.to),m.usdcAddress)){result=encodeFunctionResult({abi:erc20Abi,functionName:"decimals",result:6});break;}
    const decoded=decodeFunctionData({abi:KERNEL_ABI,data:hex(call.data)}),atOpening=params[1]===toHex(BigInt(m.opening.block));
    if(decoded.functionName==="usdc")result=encodeFunctionResult({abi:KERNEL_ABI,functionName:"usdc",result:m.usdcAddress});
    else if(decoded.functionName==="lender")result=encodeFunctionResult({abi:KERNEL_ABI,functionName:"lender",result:m.lenderAddress});
    else if(decoded.functionName==="getPool")result=encodeFunctionResult({abi:KERNEL_ABI,functionName:"getPool",result:[m.lenderAddress,50000n,atOpening?0n:45000n]});
    else if(decoded.functionName==="getAccount"){const a=m.opening.accounts.find(a=>BigInt(a.id)===decoded.args[0]);if(!a)throw Error("Unknown test account");result=encodeFunctionResult({abi:KERNEL_ABI,functionName:"getAccount",result:[a.owner,BigInt(a.cash),10000n,atOpening?0n:BigInt(a.cash)-10000n,atOpening?0n:1n,0n]});}
    else if(decoded.functionName==="accountedCustody"||decoded.functionName==="totalCustody")result=encodeFunctionResult({abi:KERNEL_ABI,functionName:decoded.functionName,result:125000n});
    else throw Error(`Unexpected test call ${decoded.functionName}`);
    break;
   }
   default:throw Error(`Unexpected local RPC ${String(r.method)}`);
  }
  return {jsonrpc:"2.0",id:r.id,result};
 };
 vi.stubGlobal("fetch",async(input:Request|string|URL,init?:RequestInit):Promise<Response>=>{
  const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
  if(url!=="https://rpc.blockdaemon.mainnet.arc.io"&&url!=="https://rpc.blockdaemon.mainnet.arc.io/")throw Error("Unexpected local test destination");
  const body=init?.body??(input instanceof Request?await input.text():null);
  if(typeof body!=="string")throw Error("Expected a JSON request body");const value:unknown=JSON.parse(body);
  return new Response(JSON.stringify(Array.isArray(value)?value.map(reply):reply(value)),{headers:{"content-type":"application/json"}});
 });
 return {tip:tip.height,target};
}
