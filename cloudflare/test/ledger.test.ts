import { env, exports } from "cloudflare:workers";
import { runInDurableObject, evictDurableObject } from "cloudflare:test";
import { beforeAll, afterAll, test, expect, vi } from "vitest";
import { Books } from "../../server/books-core";
import { DurableSqlite } from "../src/sqlite";
import { parseManifest } from "../../src/lib/deployment";
import { record, text, array } from "../../src/lib/boundary";
import seedInput from "../mainnet-bootstrap.json";

const seed=record(seedInput),manifest=parseManifest(seed.manifest);
beforeAll(()=>{vi.stubGlobal("fetch",async()=>{throw Error("Unexpected outbound request in local Worker test");});});
afterAll(()=>vi.unstubAllGlobals());
const instance=()=>env.LEDGERS.getByName("local-worker-test-"+crypto.randomUUID());

test("the Workers ledger matches the exact verified Studio snapshot",async()=>{
 const stub=instance(),view=await stub.view();expect(view.deployment).toBe(manifest.instanceId);expect(view.balances).toEqual(seed.expectedBalances);
 const result=await runInDurableObject(stub,async(_instance,ctx)=>{await ctx.storage.deleteAlarm();const books=new Books(new DurableSqlite(ctx.storage),manifest);return{digest:books.digest(),ranges:ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM raw_ranges").one().n,singles:ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM raw_blocks").one().n};});
 expect(result.digest).toBe(text(seed.expectedDigest));expect(result.ranges).toBe(Math.ceil(array(seed.blocks).length/100));expect(result.singles).toBe(0);
});
test("SQLite retains accounting and sync status across real object eviction",async()=>{
 const stub=instance();await stub.view();
 const before=await runInDurableObject(stub,async(_instance,ctx)=>{await ctx.storage.deleteAlarm();ctx.storage.sql.exec("INSERT INTO worker_sync VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",JSON.stringify({at:0,target:0,error:"retained local test marker"}));return new Books(new DurableSqlite(ctx.storage),manifest).digest();});
 await evictDurableObject(stub);const view=await stub.view();expect(view.syncError).toBe("retained local test marker");
 const after=await runInDurableObject(stub,async(_instance,ctx)=>{await ctx.storage.deleteAlarm();return new Books(new DurableSqlite(ctx.storage),manifest).digest();});expect(after).toBe(before);
});
test("a failed synchronous storage transaction restores every write",async()=>{
 const stub=instance();await stub.view();
 const result=await runInDurableObject(stub,async(_instance,ctx)=>{await ctx.storage.deleteAlarm();const db=new DurableSqlite(ctx.storage),books=new Books(db,manifest),before=books.digest();let failed=false;
 try{db.transaction(()=>{db.query("UPDATE progress SET height=height+1 WHERE id=1").run();db.query("INSERT INTO fees VALUES(?,?,?,?,?,?)").run("local-rollback-fixture","local-actor","1","native USDC",18,1);throw Error("Injected storage failure");}).immediate();}catch{failed=true;}
 return{failed,before,after:books.digest(),feeRows:db.query<{n:number},[]>("SELECT COUNT(*) n FROM fees WHERE tx='local-rollback-fixture'").get()?.n};});expect(result.failed).toBe(true);expect(result.after).toBe(result.before);expect(result.feeRows).toBe(0);
});
test("separate Durable Object identities cannot share ledger storage",async()=>{
 const first=instance(),second=instance();await first.view();await second.view();
 await runInDurableObject(first,async(_instance,ctx)=>{await ctx.storage.deleteAlarm();ctx.storage.sql.exec("CREATE TABLE local_isolation_marker(value TEXT)");ctx.storage.sql.exec("INSERT INTO local_isolation_marker VALUES('first only')");});
 const found=await runInDurableObject(second,async(_instance,ctx)=>{await ctx.storage.deleteAlarm();return ctx.storage.sql.exec<{n:number}>("SELECT COUNT(*) n FROM sqlite_master WHERE name='local_isolation_marker'").one().n;});expect(found).toBe(0);
});
test("public API rejects unknown deployments and unsupported writes",async()=>{
 const wrong=await exports.default.fetch("https://example.com/api/books?deployment=wrong");expect(wrong.status).toBe(404);
 const write=await exports.default.fetch(`https://example.com/api/reset?deployment=${manifest.instanceId}`,{method:"POST"});expect(write.status).toBe(405);
});
test("receipt origin and body limits run before ledger mutation",async()=>{
 const url=`https://example.com/api/receipt/challenge?deployment=${manifest.instanceId}`;
 const foreign=await exports.default.fetch(url,{method:"POST",headers:{origin:"https://foreign.example","content-type":"application/json"},body:'{}'});expect(foreign.status).toBe(403);
 const oversized=await exports.default.fetch(url,{method:"POST",body:"x".repeat(16385)});expect(oversized.status).toBe(400);expect(await oversized.text()).toContain("Request too large");
});

import { runDurableObjectAlarm } from "cloudflare:test";
import { installRpcFixture } from "./rpc-fixture";
import { keccak256, toBytes } from "viem";
import { hex } from "../../src/lib/boundary";
import { parseRawBlock, type RawBlock } from "../../server/chain";

test("verified bootstrap is not re-applied to later mutable ledger records",async()=>{
 const stub=instance();await stub.view();
 const changed=await runInDurableObject(stub,async(_instance,ctx)=>{await ctx.storage.deleteAlarm();ctx.storage.sql.exec("INSERT INTO journal(source,entity,account,side,amount,kind,plan,timestamp,rule_version,line) VALUES(?,?,?,?,?,?,?,?,2,?)","local-post-bootstrap-fixture","buyerA","inventory:local","debit","1","Local test fixture",null,Number(manifest.opening.timestamp),0);ctx.storage.sql.exec("INSERT INTO journal(source,entity,account,side,amount,kind,plan,timestamp,rule_version,line) VALUES(?,?,?,?,?,?,?,?,2,?)","local-post-bootstrap-fixture","buyerA","prepayment:local","credit","1","Local test fixture",null,Number(manifest.opening.timestamp),1);return new Books(new DurableSqlite(ctx.storage),manifest).digest();});
 expect(changed).not.toBe(text(seed.expectedDigest));await evictDurableObject(stub);await stub.view();
 const retained=await runInDurableObject(stub,async(_instance,ctx)=>{await ctx.storage.deleteAlarm();return new Books(new DurableSqlite(ctx.storage),manifest).digest();});expect(retained).toBe(changed);
});
test("stale successful sync status is marked stale after eviction",async()=>{
 const stub=instance();await stub.view();await runInDurableObject(stub,async(_instance,ctx)=>{await ctx.storage.deleteAlarm();ctx.storage.sql.exec("INSERT INTO worker_sync VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",JSON.stringify({at:1,target:0,error:null}));});
 await evictDurableObject(stub);const view=await stub.view();expect(view.syncError).toContain("after idle");await runInDurableObject(stub,(_instance,ctx)=>ctx.storage.deleteAlarm());
});
test("an oversized block survives real Durable Object SQLite storage and rebuild",async()=>{
 const stub=instance();await stub.view();
 const result=await runInDurableObject(stub,async(_instance,ctx)=>{await ctx.storage.deleteAlarm();const books=new Books(new DurableSqlite(ctx.storage),manifest),last=parseRawBlock(array(seed.blocks).at(-1));
 const block:RawBlock={height:last.height+1,hash:keccak256(toBytes("local-large-worker-block")),parent:last.hash,timestamp:last.timestamp+1,transactions:[{hash:keccak256(toBytes("local-large-worker-revert")),from:manifest.lenderAddress,to:manifest.kernelAddress,input:hex("0x"+"11".repeat(1100000)),nonce:99,value:"0",status:"reverted",gasUsed:"21000",effectiveGasPrice:"25000000000",index:0,logs:[]}]};
 books.captureRange([block]);books.project();const digest=books.digest(),rebuilt=await books.rebuild();return{digest,rebuilt,maxPiece:ctx.storage.sql.exec<{n:number}>("SELECT MAX(LENGTH(payload)) n FROM raw_range_parts").one().n};});expect(result.maxPiece).toBeLessThanOrEqual(262144);expect(result.rebuilt).toBe(result.digest);
});
test("alarms report partial catch-up and clear it only after reaching the observed target",async()=>{
 const {tip,target}=installRpcFixture(150),stub=instance();await stub.view();
 expect(await runDurableObjectAlarm(stub)).toBe(true);const partial=await stub.view();expect(partial.progress.height).toBe(tip+100);expect(partial.syncError).toContain("Catching up");
 expect(await runDurableObjectAlarm(stub)).toBe(true);const caught=await stub.view();expect(caught.progress.height).toBe(target);expect(caught.syncError).toBeNull();await runInDurableObject(stub,(_instance,ctx)=>ctx.storage.deleteAlarm());
},60000);
