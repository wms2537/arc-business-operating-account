import { type Hex, type Address, type PublicClient, decodeFunctionData, erc20Abi, keccak256, toBytes, toHex, pad } from "viem";
import { type DeploymentManifest } from "../src/lib/deployment";
import { sameAddress } from "../src/lib/boundary";
import {
  record,
  text,
  integer,
  uint,
  address,
  hash,
  hex,
  array,
  json,
} from "../src/lib/boundary";
export type RawLog = {
  address: Address;
  data: Hex;
  topics: [Hex, ...Hex[]];
  index: number;
};
export type RawTransaction = {
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  nonce: number;
  value: string;
  status: "success" | "reverted";
  gasUsed: string;
  effectiveGasPrice: string;
  index: number;
  logs: RawLog[];
};
export type RawBlock = {
  height: number;
  hash: Hex;
  parent: Hex;
  timestamp: number;
  transactions: RawTransaction[];
};
export function parseRawBlock(value: unknown): RawBlock {
  const b = record(value);
  return {
    height: integer(b.height),
    hash: hash(b.hash),
    parent: hash(b.parent),
    timestamp: integer(b.timestamp),
    transactions: array(b.transactions).map((t) => {
      const v = record(t);
      const status = v.status;
      if (status !== "success" && status !== "reverted")
        throw Error("Unconfirmed receipt");
      return {
        hash: hash(v.hash),
        from: address(v.from),
        to: v.to === null ? null : address(v.to),
        input: hex(v.input),
        nonce: integer(v.nonce),
        value: uint(v.value).toString(),
        status,
        gasUsed: uint(v.gasUsed).toString(),
        effectiveGasPrice: uint(v.effectiveGasPrice).toString(),
        index: integer(v.index),
        logs: array(v.logs).map((l) => {
          const a = record(l),
            topics = array(a.topics).map(hex),
            first = topics[0];
          if (!first) throw Error("Event without a topic");
          return {
            address: address(a.address),
            data: hex(a.data),
            topics: [first, ...topics.slice(1)],
            index: integer(a.index),
          };
        }),
      };
    }),
  };
}

type Scope=Pick<DeploymentManifest,'kernelAddress'|'usdcAddress'>;
const NATIVE_USDC=address('0xfffffffffffffffffffffffffffffffffffffffe');
const TRANSFER=keccak256(toBytes('Transfer(address,address,uint256)'));
const APPROVAL=keccak256(toBytes('Approval(address,address,uint256)'));
export function isDirectDeploymentCall(tx:Pick<RawTransaction,'to'|'input'>,scope:Scope):boolean{
 if(!tx.to)return false;
 if(sameAddress(tx.to,scope.kernelAddress))return true;
 if(!sameAddress(tx.to,scope.usdcAddress))return false;
 try{
  const call=decodeFunctionData({abi:erc20Abi,data:tx.input});
  if(call.functionName==='approve'||call.functionName==='transfer')return sameAddress(call.args[0],scope.kernelAddress);
  if(call.functionName==='transferFrom')return sameAddress(call.args[0],scope.kernelAddress)||sameAddress(call.args[1],scope.kernelAddress);
 }catch{return false;}
 return false;
}
export function isDeploymentTransaction(tx:Pick<RawTransaction,'to'|'input'|'logs'>,scope:Scope):boolean{
 if(isDirectDeploymentCall(tx,scope))return true;
 const party=pad(scope.kernelAddress,{size:32}).toLowerCase();
 return tx.logs.some(log=>{
  if(sameAddress(log.address,scope.kernelAddress))return true;
  if(!sameAddress(log.address,scope.usdcAddress)&&!sameAddress(log.address,NATIVE_USDC))return false;
  if(log.topics[0]!==TRANSFER&&log.topics[0]!==APPROVAL)return false;
  return log.topics[1]?.toLowerCase()===party||log.topics[2]?.toLowerCase()===party;
 });
}
type TransactionInput=Pick<RawTransaction,'hash'|'from'|'to'|'input'|'nonce'>&{value:bigint};
async function captureReceipt(client:PublicClient,tx:TransactionInput,blockHash:Hex,height:bigint):Promise<RawTransaction>{
 const r=await client.getTransactionReceipt({hash:tx.hash});
 if(r.blockHash!==blockHash||r.blockNumber!==height||r.transactionHash!==tx.hash||!sameAddress(r.from,tx.from))throw Error('Receipt/block/transaction mismatch during capture');
 return{hash:tx.hash,from:tx.from,to:tx.to,input:tx.input,nonce:tx.nonce,value:tx.value.toString(),status:r.status,gasUsed:r.gasUsed.toString(),effectiveGasPrice:r.effectiveGasPrice.toString(),index:r.transactionIndex,logs:r.logs.map((log):RawLog=>{
  if(log.logIndex===null||log.blockHash!==blockHash||log.removed)throw Error('Removed or unconfirmed log');
  const first=log.topics[0];if(!first)throw Error('Event has no topic');
  return{address:log.address,data:log.data,topics:[first,...log.topics.slice(1)],index:log.logIndex};
 })};
}
export async function captureBlock(client:PublicClient,height:bigint):Promise<RawBlock>{
 const block=await client.getBlock({blockNumber:height,includeTransactions:true});
 if(!block.hash||block.number!==height)throw Error('Block is not confirmed');
 const blockHash=block.hash,transactions=await Promise.all(block.transactions.map(tx=>captureReceipt(client,tx,blockHash,height)));
 const canonical=await client.getBlock({blockNumber:height});if(canonical.hash!==blockHash)throw Error('Chain changed during block capture');
 return parseRawBlock({height:Number(height),hash:blockHash,parent:block.parentHash,timestamp:Number(block.timestamp),transactions:transactions.sort((a,b)=>a.index-b.index)});
}
/** Retain contiguous finalized headers and only this deployment's relevant receipts. */
export async function captureDeploymentRange(client:PublicClient,from:bigint,to:bigint,scope:Scope):Promise<RawBlock[]>{
 return captureRange(client,from,to,scope,Number.POSITIVE_INFINITY,10);
}
/** Return a contiguous prefix when retained evidence reaches the Worker memory budget. */
export async function captureDeploymentPrefix(client:PublicClient,from:bigint,to:bigint,scope:Scope):Promise<RawBlock[]>{
 return captureRange(client,from,to,scope,262144,5);
}
async function captureRange(client:PublicClient,from:bigint,to:bigint,scope:Scope,byteLimit:number,headerBatch:number):Promise<RawBlock[]>{
 if(to<from)return[];if(to-from+1n>100n)throw Error('Deployment capture is limited to 100 blocks per batch');
 const anchor=await client.getBlock({blockNumber:to});if(!anchor.hash)throw Error('Capture anchor is not confirmed');
 const party=pad(scope.kernelAddress,{size:32}),range={fromBlock:toHex(from),toBlock:toHex(to)};
 const found=await Promise.all([
  client.request({method:'eth_getLogs',params:[{...range,address:scope.kernelAddress}]}),
  client.request({method:'eth_getLogs',params:[{...range,address:[scope.usdcAddress,NATIVE_USDC],topics:[[TRANSFER,APPROVAL],party]}]}),
  client.request({method:'eth_getLogs',params:[{...range,address:[scope.usdcAddress,NATIVE_USDC],topics:[[TRANSFER,APPROVAL],null,party]}]})
 ]);
 const candidates=new Set<string>(),logBlocks=new Map<string,string>();
 for(const log of found.flat()){
  if(log.removed||log.transactionHash===null||log.blockHash===null||log.blockNumber===null)throw Error('Unconfirmed candidate log');
  const height=BigInt(log.blockNumber);if(height<from||height>to)throw Error('Log outside requested range');
  const key=height.toString(),prior=logBlocks.get(key),canonical=log.blockHash.toLowerCase();if(prior&&prior!==canonical)throw Error('Conflicting log block hashes');
  logBlocks.set(key,canonical);candidates.add(log.transactionHash.toLowerCase());
 }
 const blocks:RawBlock[]=[];let previous:Hex|undefined,bytes=0;
 capture:for(let base=from;base<=to;base+=BigInt(headerBatch)){
  const count=to-base+1n<BigInt(headerBatch)?to-base+1n:BigInt(headerBatch);
  const heights=Array.from({length:Number(count)},(_,i)=>base+BigInt(i));
  const headers=await Promise.all(heights.map(height=>client.getBlock({blockNumber:height,includeTransactions:true})));
  for(let i=0;i<headers.length;i++){const height=heights[i],block=headers[i];if(!block.hash||block.number!==height)throw Error('Missing canonical block');
  if(previous&&block.parentHash!==previous)throw Error('Noncontiguous capture');
  const logHash=logBlocks.get(height.toString());if(logHash&&logHash!==block.hash.toLowerCase())throw Error('Log/header fork mismatch');
  const selected=block.transactions.filter(tx=>candidates.has(tx.hash.toLowerCase())||isDirectDeploymentCall(tx,scope));
  const transactions:RawTransaction[]=[];for(const tx of selected)transactions.push(await captureReceipt(client,tx,block.hash,height));
  const captured=parseRawBlock({height:Number(height),hash:block.hash,parent:block.parentHash,timestamp:Number(block.timestamp),transactions:transactions.sort((a,b)=>a.index-b.index)}),size=json(captured).length;
  if(blocks.length&&bytes+size>byteLimit)break capture;
  blocks.push(captured);previous=block.hash;bytes+=size;
  if(bytes>=byteLimit)break capture;
 }
 }
 const last=blocks[blocks.length-1];if(!last)throw Error('No block captured');
 const canonical=await client.getBlock({blockNumber:BigInt(last.height)}),endCanonical=BigInt(last.height)===to?canonical:await client.getBlock({blockNumber:to});
 if(canonical.hash!==last.hash||endCanonical.hash!==anchor.hash)throw Error('Chain changed during bounded capture');
 return blocks;
}
