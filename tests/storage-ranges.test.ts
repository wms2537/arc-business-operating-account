import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toBytes } from "viem";
import { Books } from "../server/books";
import { parseManifest } from "../src/lib/deployment";
import { json, hex } from "../src/lib/boundary";
import type { RawBlock } from "../server/chain";
import fixture from "../docs/evidence/arc-testnet/rehearsal/cp-manifest.json";
const manifest=parseManifest(fixture);
function emptyRange(count:number):RawBlock[]{let parent=manifest.opening.hash;return Array.from({length:count},(_,i)=>{const hash=keccak256(toBytes(`local-storage-range-fixture-${i}`));const block={height:Number(manifest.opening.block)+i+1,hash,parent,timestamp:Number(manifest.opening.timestamp)+i+1,transactions:[]};parent=hash;return block;});}

test("one retained range preserves 100 contiguous headers across reopen and rebuild",async()=>{
 const folder=await mkdtemp(join(tmpdir(),"arc-range-")),path=join(folder,"books.sqlite");let books=new Books(path,manifest);
 try{const before=books.balances(),blocks=emptyRange(100);books.captureRange(blocks);books.captureRange(blocks);expect(books.db.query<{n:number},[]>("SELECT COUNT(*) n FROM raw_ranges").get()?.n).toBe(1);expect(books.db.query<{n:number},[]>("SELECT COUNT(*) n FROM raw_blocks").get()?.n).toBe(0);expect(books.project()).toBe(100);expect(books.progress().height).toBe(blocks[99].height);expect(books.balances()).toEqual(before);const digest=books.digest();books.close();books=new Books(path,manifest);expect(books.digest()).toBe(digest);expect(await books.rebuild()).toBe(digest);books.capture(blocks[20]);expect(books.project()).toBe(0);}finally{books.close();await rm(folder,{recursive:true,force:true});}
});
test("range conflicts, overlap and missing headers cannot advance accounting",()=>{
 const books=new Books(":memory:",manifest);try{const blocks=emptyRange(100);books.captureRange(blocks);expect(()=>books.captureRange(blocks.slice(50))).toThrow("overlapping");expect(()=>books.capture({...blocks[20],timestamp:1})).toThrow("Conflicting");expect(()=>books.captureRange([blocks[0],blocks[2]])).toThrow("Noncontiguous");expect(books.progress().height).toBe(Number(manifest.opening.block));expect(books.project()).toBe(100);}finally{books.close();}
});
test("a corrupted retained range rolls back the entire batch and stays quarantined",()=>{
 const books=new Books(":memory:",manifest);try{const blocks=emptyRange(3),before=books.balances();books.captureRange(blocks);blocks[1]={...blocks[1],parent:manifest.opening.hash};books.db.query("UPDATE raw_ranges SET payload=?").run(json(blocks));expect(()=>books.project()).toThrow("parent mismatch");expect(books.progress().height).toBe(Number(manifest.opening.block));expect(books.balances()).toEqual(before);expect(books.issues().filter(i=>i.blocking)).toHaveLength(1);expect(()=>books.project()).toThrow();}finally{books.close();}
});
test("schema 2 evidence migrates without changing its ledger or opening identity",async()=>{
 const folder=await mkdtemp(join(tmpdir(),"arc-v2-")),path=join(folder,"books.sqlite");let books=new Books(path,manifest);
 try{const blocks=emptyRange(2);for(const b of blocks)books.capture(b);books.project();const digest=books.digest();books.db.exec("DROP TABLE raw_ranges; DROP TABLE raw_range_parts; PRAGMA user_version=2;");books.close();books=new Books(path,manifest);expect(books.digest()).toBe(digest);expect(books.db.query<{user_version:number},[]>("PRAGMA user_version").get()?.user_version).toBe(4);expect(await books.rebuild()).toBe(digest);}finally{books.close();await rm(folder,{recursive:true,force:true});}
});

test("oversized block evidence is retained losslessly below the Worker row limit",async()=>{const books=new Books(":memory:",manifest);try{const block:RawBlock={...emptyRange(1)[0],transactions:[{hash:keccak256(toBytes("local-large-reverted-call")),from:manifest.lenderAddress,to:manifest.kernelAddress,input:hex("0x"+"11".repeat(1100000)),nonce:0,value:"0",status:"reverted",gasUsed:"21000",effectiveGasPrice:"25000000000",index:0,logs:[]}]};books.captureRange([block]);expect(books.db.query<{n:number},[]>("SELECT MAX(LENGTH(payload)) n FROM raw_range_parts").get()?.n).toBeLessThanOrEqual(262144);expect(books.project()).toBe(1);expect(books.fees()).toHaveLength(1);const digest=books.digest();expect(await books.rebuild()).toBe(digest);books.capture(block);expect(books.project()).toBe(0);}finally{books.close();}});
