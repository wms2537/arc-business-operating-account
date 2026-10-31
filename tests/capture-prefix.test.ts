import { test, expect } from "bun:test";
import { createPublicClient, custom, keccak256, toBytes, toHex } from "viem";
import { captureDeploymentPrefix, captureDeploymentRange } from "../server/chain";
import { array, address, hex } from "../src/lib/boundary";
const scope={kernelAddress:address("0x1000000000000000000000000000000000000000"),usdcAddress:address("0x3600000000000000000000000000000000000000")};
const digest=(s:string)=>keccak256(toBytes(s));
function fixture(changeEnd:boolean){let endReads=0;
 const client=createPublicClient({transport:custom({request:async({method,params})=>{const p=array(params);
  if(method==="eth_getLogs")return[];
  if(method==="eth_getBlockByNumber"){
   const n=Number(BigInt(hex(p[0]))),full=p[1]===true;let hash=digest("block"+n);
   if(n===103&&!full&&++endReads===2&&changeEnd)hash=digest("changed-end-anchor");
   const transaction={hash:digest("transaction"+n),from:scope.usdcAddress,to:scope.kernelAddress,input:"0x"+"11".repeat(150000),nonce:toHex(n-101),value:"0x0",gas:"0x5208",gasPrice:toHex(25000000000n),blockHash:hash,blockNumber:toHex(n),transactionIndex:"0x0",type:"0x0"};
   return{number:toHex(n),hash,parentHash:digest("block"+(n-1)),timestamp:toHex(n),transactions:full?[transaction]:[transaction.hash],gasLimit:"0x1c9c380",gasUsed:"0x5208",difficulty:"0x0",size:"0x0"};
  }
  if(method==="eth_getTransactionReceipt"){
   const n=[101,102,103].find(n=>digest("transaction"+n)===p[0]);if(n===undefined)throw Error("Unknown local receipt");
   return{transactionHash:digest("transaction"+n),transactionIndex:"0x0",blockHash:digest("block"+n),blockNumber:toHex(n),from:scope.usdcAddress,to:scope.kernelAddress,contractAddress:null,cumulativeGasUsed:"0x5208",gasUsed:"0x5208",logs:[],status:"0x0",effectiveGasPrice:toHex(25000000000n),type:"0x0"};
  }
  throw Error("Unexpected local RPC method: "+method);
 }})});return client;
}
test("bounded capture resumes every block without changing full-range callers",async()=>{
 const client=fixture(false),seen:number[]=[];let from=101n;
 while(from<=103n){const prefix=await captureDeploymentPrefix(client,from,103n,scope);expect(prefix).toHaveLength(1);seen.push(prefix[0].height);from=BigInt(prefix[0].height)+1n;}
 expect(seen).toEqual([101,102,103]);expect(await captureDeploymentRange(fixture(false),101n,103n,scope)).toHaveLength(3);
});
test("partial capture still rejects a changed original log-range anchor",async()=>{
 await expect(captureDeploymentPrefix(fixture(true),101n,103n,scope)).rejects.toThrow("Chain changed during bounded capture");
});
