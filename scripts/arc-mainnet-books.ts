/** Reconstruct mainnet accounting from public finalized receipts only. */
import { writeFile } from "node:fs/promises";
import { client, DATA, readJson } from "./arc-mainnet-prepare";
import { parseManifest } from "../src/lib/deployment";
import { Books } from "../server/books";
import { captureDeploymentRange } from "../server/chain";
import { reconcileBooks } from "../server/sync";
import { json, record } from "../src/lib/boundary";
const proof=record(await readJson(DATA+"/setup-independent-verification.json"));
if(proof.status!=="setup-verified-ready-for-wallet-close")throw Error("Independent setup verification must pass first");
const manifest=parseManifest(await readJson(DATA+"/cp-manifest.json"));
if(manifest.environment!=="arc-mainnet"||manifest.chainId!==5042)throw Error("Wrong books network");
const books=new Books(DATA+"/cp.sqlite",manifest);
try {
 const target=(await client.getBlock({blockTag:"finalized"})).number;
 while(BigInt(books.progress().height)<target){
  const from=BigInt(books.progress().height)+1n,to=from+99n<target?from+99n:target;
  for(const block of await captureDeploymentRange(client,from,to,manifest))books.capture(block);
  books.project();console.log("MAINNET_BOOKS_PROGRESS",books.progress().height,target.toString());
 }
 await reconcileBooks(client,books);
 if(books.progress().state.plans["1"]?.status!=="Open")throw Error("The setup checkpoint requires the purchase to remain open");
 for(const [entity,expected] of [["buyerA",30000n],["buyerB",25000n],["buyerC",20000n],["lender",50000n]] satisfies [string,bigint][])if(books.balance(entity,"cash")!==expected)throw Error("Opening cash mismatch: "+entity);
 if(books.balance("kernel","usdc")!==125000n||Object.keys(books.progress().state.loans).length!==0)throw Error("Setup created unexpected custody or principal");
 const digest=books.digest();if(await books.rebuild()!==digest)throw Error("Rebuild changed the mainnet setup ledger");
 await reconcileBooks(client,books);
 await writeFile(DATA+"/setup-books.json",json({status:"passed",network:"arc-mainnet",manifest,progress:books.progress(),balances:books.balances(),journals:books.journals(),fees:books.fees(),receipts:books.receipts(),digest,rebuildMatched:true,chainWrites:0})+"\n");
 console.log("MAINNET_SETUP_BOOKS_VERIFIED",manifest.instanceId,digest);
}finally{books.close();}
