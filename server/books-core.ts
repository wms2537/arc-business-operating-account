import { networkSettings } from "../src/lib/deployment";
import { isDeploymentTransaction } from "./chain";
import type { SqlDatabase } from "./sqlite-port";
import { createHash } from "node:crypto";
import {
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  concat,
  keccak256,
  erc20Abi,
  type Hex,
  type Address,
} from "viem";
import { KERNEL_ABI } from "../src/lib/kernel-abi";
import { decodeTerms, type PlanTerms } from "../src/lib/kernel-client";
import {
  parseManifest,
  type DeploymentManifest,
  type JournalLine,
} from "../src/lib/deployment";
import {
  parseChallenge,
  parseSignedReceipt,
  verifyReceiptSignature,
  type ReceiptChallenge,
  type SignedReceipt,
} from "../src/lib/receipt-evidence";
import {
  json,
  array,
  record,
  text,
  integer,
  uint,
  address,
  hex,
  hash,
  sameAddress,
  flag,
} from "../src/lib/boundary";
import {
  parseRawBlock,
  type RawBlock,
  type RawTransaction,
  type RawLog,
} from "./chain";

type Account = { owner: Address; entity: string };
type Offer = {
  owner: Address;
  payee: Address;
  price: string;
  capacity: string;
  minimumFill: string;
  expiry: string;
  revoked: boolean;
};
type Plan = {
  input: Hex;
  hash: Hex;
  status: "Open" | "Committed" | "Cancelled" | "Expired";
  goods: string;
  freight: string;
  accepted: boolean;
  goodsReceived: boolean;
  freightReceived: boolean;
  coordinator: Address;
};
type Loan = {
  id: string;
  plan: string;
  borrower: string;
  original: string;
  outstanding: string;
};
type Receivable = {
  account: string;
  payer: Address;
  amount: string;
  remaining: string;
};
export type BookState = {
  accounts: Record<string, Account>;
  offers: Record<string, Offer>;
  plans: Record<string, Plan>;
  loans: Record<string, Loan>;
  receivables: Record<string, Receivable>;
};
function mapped<T>(
  value: unknown,
  parse: (v: Record<string, unknown>) => T,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record(value)).map(([key, v]) => [key, parse(record(v))]),
  );
}
function parseState(value: unknown): BookState {
  const s = record(value);
  return {
    accounts: mapped(s.accounts, (v) => ({
      owner: address(v.owner),
      entity: text(v.entity),
    })),
    offers: mapped(s.offers, (v) => ({
      owner: address(v.owner),
      payee: address(v.payee),
      price: uint(v.price).toString(),
      capacity: uint(v.capacity).toString(),
      minimumFill: uint(v.minimumFill).toString(),
      expiry: uint(v.expiry).toString(),
      revoked: flag(v.revoked),
    })),
    plans: mapped(s.plans, (v) => {
      const status = v.status;
      if (
        status !== "Open" &&
        status !== "Committed" &&
        status !== "Cancelled" &&
        status !== "Expired"
      )
        throw Error("Unknown plan status");
      return {
        input: hex(v.input),
        hash: hash(v.hash),
        status,
        goods: uint(v.goods).toString(),
        freight: uint(v.freight).toString(),
        accepted: flag(v.accepted),
        goodsReceived: flag(v.goodsReceived),
        freightReceived: flag(v.freightReceived),
        coordinator: address(v.coordinator),
      };
    }),
    loans: mapped(s.loans, (v) => ({
      id: uint(v.id).toString(),
      plan: uint(v.plan).toString(),
      borrower: uint(v.borrower).toString(),
      original: uint(v.original).toString(),
      outstanding: uint(v.outstanding).toString(),
    })),
    receivables: mapped(s.receivables, (v) => ({
      account: uint(v.account).toString(),
      payer: address(v.payer),
      amount: uint(v.amount).toString(),
      remaining: uint(v.remaining).toString(),
    })),
  };
}
function termsHash(t: PlanTerms, m: DeploymentManifest): Hex {
  const buyers = keccak256(
    concat(
      t.buyers.map((b) =>
        encodePacked(
          ["address", "uint256", "uint256", "uint256", "uint256", "uint256"],
          [
            b.owner,
            b.accountId,
            b.quantity,
            b.ownCash,
            b.creditDraw,
            b.creditLimit,
          ],
        ),
      ),
    ),
  );
  const refs = keccak256(
    concat(
      t.offerRefs.map((r) =>
        encodePacked(
          ["uint256", "uint256", "address"],
          [r.offerId, r.quantity, r.payee],
        ),
      ),
    ),
  );
  const s = t.saleParty;
  const sale = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        s.merchantOwner,
        s.merchantAccountId,
        s.merchantCash,
        s.creditDraw,
        s.creditLimit,
        s.customerAddress,
        s.requiredEscrow,
        s.saleValue,
      ],
    ),
  );
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        BigInt(m.chainId),
        m.kernelAddress,
        t.kind,
        t.lenderPoolId,
        t.expiry,
        t.commercialRef,
        buyers,
        sale,
        refs,
      ],
    ),
  );
}
export type JournalRow = {
  id: number;
  source: string;
  entity: string;
  account: string;
  side: "debit" | "credit";
  amount: string;
  kind: string;
  plan: string | null;
  timestamp: number;
  rule_version: number;
};
export class Books {
  readonly db: SqlDatabase;
  readonly manifest: DeploymentManifest;
  constructor(database: SqlDatabase, manifest: DeploymentManifest) {
    this.manifest = parseManifest(manifest);
    this.db = database;
    const schema = this.db.schemaVersion();
    const tables =
      this.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '__cf_*'",
        )
        .get()?.n ?? 0;
    if (schema !== 2 && schema !== 3 && schema !== 4 && !(schema === 0 && tables === 0)) {
      this.db.close();
      throw Error(
        "Unsupported or unversioned books schema. Preserve the database and rebuild in a new directory from retained evidence.",
      );
    }
    this.db.transaction(() => {
      this.db.exec(`
   CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1), manifest TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS progress(id INTEGER PRIMARY KEY CHECK(id=1),height INTEGER NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS raw_blocks(height INTEGER PRIMARY KEY,hash TEXT NOT NULL,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS raw_ranges(start_height INTEGER PRIMARY KEY,end_height INTEGER NOT NULL CHECK(end_height>=start_height),payload TEXT NOT NULL,parts INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS raw_range_parts(start_height INTEGER NOT NULL,part INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(start_height,part));
   CREATE INDEX IF NOT EXISTS raw_ranges_end ON raw_ranges(end_height);
   CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY,source TEXT NOT NULL,entity TEXT NOT NULL,account TEXT NOT NULL,side TEXT NOT NULL CHECK(side IN('debit','credit')),amount TEXT NOT NULL,kind TEXT NOT NULL,plan TEXT,timestamp INTEGER NOT NULL,rule_version INTEGER NOT NULL CHECK(rule_version=2),line INTEGER NOT NULL,UNIQUE(source,line));
   CREATE INDEX IF NOT EXISTS journal_entity ON journal(entity,account);
   CREATE TABLE IF NOT EXISTS issues(source TEXT PRIMARY KEY,detail TEXT NOT NULL,blocking INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS fees(tx TEXT PRIMARY KEY,actor TEXT NOT NULL,amount TEXT NOT NULL,asset TEXT NOT NULL,decimals INTEGER NOT NULL,block INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS challenges(nonce TEXT PRIMARY KEY,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS signed_receipts(economic_id TEXT PRIMARY KEY,nonce TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS receipt_postings(economic_id TEXT PRIMARY KEY);
  `);
      if (schema === 3) this.db.exec("ALTER TABLE raw_ranges ADD COLUMN parts INTEGER NOT NULL DEFAULT 0");
      this.db.setSchemaVersion(4);
    }).immediate();
    this.db
      .transaction(() => {
        const prior = this.db
          .query<{ manifest: string }, []>(
            `SELECT manifest FROM identity WHERE id=1`,
          )
          .get();
        if (prior) {
          if (prior.manifest !== json(this.manifest))
            throw Error(
              "Immutable opening checkpoint or deployment differs from database",
            );
        } else {
          this.db
            .query("INSERT INTO identity VALUES(1,?)")
            .run(json(this.manifest));
          this.initialize();
        }
      })
      .immediate();
  }
  close() {
    this.db.close();
  }
  private initialState(): BookState {
    return {
      accounts: Object.fromEntries(
        this.manifest.opening.accounts.map((a) => [
          a.id,
          { owner: a.owner, entity: a.entity },
        ]),
      ),
      offers: {},
      plans: {},
      loans: {},
      receivables: {},
    };
  }
  private initialize() {
    const m = this.manifest;
    this.post(
      "opening",
      "Opening checkpoint",
      null,
      Number(m.opening.timestamp),
      m.opening.lines,
    );
    this.db
      .query("INSERT INTO progress VALUES(1,?,?,?)")
      .run(Number(m.opening.block), m.opening.hash, json(this.initialState()));
    for (const a of m.opening.accounts)
      if (
        this.balance(a.entity, "cash") !== BigInt(a.cash) ||
        this.balance("kernel", "due:account:" + a.id) !== -BigInt(a.cash)
      )
        throw Error("Opening journals do not match account claims");
    if (
      this.balance(this.entity(m.lenderAddress), "cash") !==
        BigInt(m.opening.poolCash) ||
      this.balance("kernel", "due:pool") !== -BigInt(m.opening.poolCash) ||
      this.balance("kernel", "usdc") !== BigInt(m.opening.custody)
    )
      throw Error("Opening journals do not match custody/pool");
  }
  progress() {
    const row = this.db
      .query<{ height: number; hash: string; state: string }, []>(
        "SELECT height,hash,state FROM progress WHERE id=1",
      )
      .get();
    if (!row) throw Error("Opening checkpoint missing");
    return {
      height: integer(row.height),
      hash: hash(row.hash),
      state: parseState(JSON.parse(row.state)),
    };
  }
  entity(owner: Address): string {
    return (
      this.manifest.entities.find((e) => sameAddress(e.address, owner))?.id ??
      owner.toLowerCase()
    );
  }
  account(state: BookState, id: string): Account {
    const a = state.accounts[id];
    if (!a) throw Error(`Missing confirmed account ${id}`);
    return a;
  }
  balance(entity: string, account: string): bigint {
    return this.db
      .query<{ side: string; amount: string }, [string, string]>(
        "SELECT side,amount FROM journal WHERE entity=? AND account=?",
      )
      .all(entity, account)
      .reduce(
        (n, r) => n + (r.side === "debit" ? 1n : -1n) * uint(r.amount),
        0n,
      );
  }
  balances(): { entity: string; account: string; debitBalance: string }[] {
    const result = new Map<
      string,
      { entity: string; account: string; amount: bigint }
    >();
    for (const r of this.journals()) {
      const key = json([r.entity, r.account]);
      const item = result.get(key) ?? {
        entity: r.entity,
        account: r.account,
        amount: 0n,
      };
      item.amount += (r.side === "debit" ? 1n : -1n) * uint(r.amount);
      result.set(key, item);
    }
    return [...result.values()]
      .sort(
        (a, b) =>
          a.entity.localeCompare(b.entity) ||
          a.account.localeCompare(b.account),
      )
      .map((r) => ({
        entity: r.entity,
        account: r.account,
        debitBalance: r.amount.toString(),
      }));
  }
  journals(): JournalRow[] {
    return this.db
      .query<JournalRow, []>(
        "SELECT id,source,entity,account,side,amount,kind,plan,timestamp,rule_version FROM journal ORDER BY timestamp,source,line",
      )
      .all();
  }
  issues() {
    return this.db
      .query<{ source: string; detail: string; blocking: number }, []>(
        "SELECT source,detail,blocking FROM issues ORDER BY source",
      )
      .all();
  }
  fees() {
    return this.db
      .query<
        {
          tx: string;
          actor: string;
          amount: string;
          asset: string;
          decimals: number;
          block: number;
        },
        []
      >("SELECT * FROM fees ORDER BY block,tx")
      .all();
  }
  receipts() {
    return this.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM signed_receipts ORDER BY economic_id",
      )
      .all()
      .map((r) => parseSignedReceipt(JSON.parse(r.payload)));
  }
  digest() {
    return createHash("sha256")
      .update(
        json({
          balances: this.balances(),
          journals: this.journals().map(({ id, ...r }) => r),
          progress: this.progress(),
          receipts: this.receipts(),
        }),
      )
      .digest("hex");
  }
  private post(
    source: string,
    kind: string,
    plan: string | null,
    timestamp: number,
    lines: JournalLine[],
  ) {
    const nonzero = lines.filter((l) => uint(l.amount) > 0n),
      totals = new Map<string, bigint>();
    for (const l of nonzero)
      totals.set(
        l.entity,
        (totals.get(l.entity) ?? 0n) +
          (l.side === "debit" ? 1n : -1n) * uint(l.amount),
      );
    for (const [entity, total] of totals)
      if (total !== 0n)
        throw Error(`Unbalanced ${kind} journal for ${entity}: ${total}`);
    const insert = this.db.query(
      "INSERT INTO journal(source,entity,account,side,amount,kind,plan,timestamp,rule_version,line) VALUES(?,?,?,?,?,?,?,?,2,?)",
    );
    nonzero.forEach((l, i) =>
      insert.run(
        source,
        l.entity,
        l.account,
        l.side,
        l.amount,
        kind,
        plan,
        timestamp,
        i,
      ),
    );
  }
  private rangePayload(range: { start_height: number; payload: string; parts: number }): string {
    if (range.parts === 0) return range.payload;
    const parts = this.db.query<{part:number;payload:string},[number]>("SELECT part,payload FROM raw_range_parts WHERE start_height=? ORDER BY part").all(range.start_height);
    if (parts.length !== range.parts || parts.some((part,index) => part.part !== index)) throw Error("Retained block evidence fragment is missing");
    return parts.map(part => part.payload).join("");
  }
  private readBatch(next: number): RawBlock[] {
    const single = this.db.query<{ payload: string }, [number]>("SELECT payload FROM raw_blocks WHERE height=?").get(next);
    if (single) return [parseRawBlock(JSON.parse(single.payload))];
    const range = this.db.query<{ start_height:number;end_height:number;payload:string;parts:number },[number]>("SELECT start_height,end_height,payload,parts FROM raw_ranges WHERE start_height=?").get(next);
    if (!range) return [];
    const blocks = array(JSON.parse(this.rangePayload(range))).map(parseRawBlock);
    if (!blocks.length || blocks[0].height !== next || blocks[blocks.length - 1].height !== range.end_height) throw Error("Invalid retained block range");
    return blocks;
  }
  capture(block: RawBlock) {
    const b = parseRawBlock(block);
    if (b.height <= Number(this.manifest.opening.block)) return;
    // Large single-block evidence uses the same lossless fragments as batch capture.
    if (json(b).length > 262144) {
      const retained = this.db.query<{payload:string},[number]>("SELECT payload FROM raw_blocks WHERE height=?").get(b.height);
      if (retained) { if (retained.payload !== json(b)) throw Error("Conflicting canonical block"); return; }
      this.captureRange([b]); return;
    }
    const payload = json(b);
    this.db.transaction(() => {
      const range = this.db.query<{start_height:number;payload:string;parts:number},[number,number]>("SELECT start_height,payload,parts FROM raw_ranges WHERE start_height<=? AND end_height>=?").get(b.height,b.height);
      if (range) {
        const saved = array(JSON.parse(this.rangePayload(range))).map(parseRawBlock)[b.height - range.start_height];
        if (json(saved) !== payload) throw Error("Conflicting canonical block in retained range");
        return;
      }
      const existing = this.db.query<{payload:string},[number]>("SELECT payload FROM raw_blocks WHERE height=?").get(b.height);
      if (existing) {
        if (existing.payload !== payload) throw Error("Conflicting canonical block. Projection stopped; preserve evidence and review the reorg.");
        return;
      }
      this.db.query("INSERT INTO raw_blocks VALUES(?,?,?)").run(b.height,b.hash,payload);
    }).immediate();
  }
  /** Retain all headers while bounding each SQL string well below the 2 MB Worker limit. */
  captureRange(input: RawBlock[]) {
    const blocks = input.map(parseRawBlock).filter(b => b.height > Number(this.manifest.opening.block));
    if (!blocks.length) return;
    if (blocks.length > 100) throw Error("Block range exceeds the capture bound");
    for (let i=1;i<blocks.length;i++) if(blocks[i].height!==blocks[i-1].height+1||blocks[i].parent!==blocks[i-1].hash)throw Error("Noncontiguous captured range");
    this.db.transaction(() => {
      const retain = (group: RawBlock[]) => {
        const first=group[0].height,last=group[group.length-1].height,payload=json(group),limit=262144;
        const prior=this.db.query<{start_height:number;end_height:number;payload:string;parts:number},[number,number]>("SELECT start_height,end_height,payload,parts FROM raw_ranges WHERE start_height<=? AND end_height>=?").all(last,first);
        if(prior.length){
          if(prior.length!==1||prior[0].start_height!==first||prior[0].end_height!==last||this.rangePayload(prior[0])!==payload)throw Error("Conflicting or overlapping retained block range");
          return;
        }
        const singles=this.db.query<{n:number},[number,number]>("SELECT COUNT(*) n FROM raw_blocks WHERE height BETWEEN ? AND ?").get(first,last);
        if(singles?.n)throw Error("Range overlaps retained individual blocks; project those blocks before capturing a new range");
        // RawBlock consists only of validated hex, decimal integers and fixed ASCII labels.
        const parts=payload.length>limit?Math.ceil(payload.length/limit):0;
        this.db.query("INSERT INTO raw_ranges VALUES(?,?,?,?)").run(first,last,parts?"":payload,parts);
        for(let part=0;part<parts;part++)this.db.query("INSERT INTO raw_range_parts VALUES(?,?,?)").run(first,part,payload.slice(part*limit,(part+1)*limit));
      };
      let group:RawBlock[]=[],bytes=2;
      for(const block of blocks){const length=json(block).length+1;if(group.length&&bytes+length>262144){retain(group);group=[];bytes=2;}group.push(block);bytes+=length;}
      if(group.length)retain(group);
    }).immediate();
  }
  project(): number {
    let processed = 0;
    for (;;) {
      const next = this.progress().height + 1, blocks = this.readBatch(next);
      if (!blocks.length) break;
      let failedHeight = next;
      try {
        const done = this.db.transaction(() => {
          const p = this.progress();
          if (p.height >= next) return false;
          for (const b of blocks) {
            failedHeight = b.height;
            if (b.height !== p.height + 1) throw Error("Noncontiguous projection");
            if (b.parent !== p.hash) throw Error("Canonical parent mismatch; review reorg before continuing");
            for (const tx of b.transactions) this.applyTransaction(p.state, b, tx);
            p.height = b.height; p.hash = b.hash;
          }
          this.db.query("UPDATE progress SET height=?,hash=?,state=? WHERE id=1").run(p.height, p.hash, json(p.state));
          this.db.query(`DELETE FROM issues WHERE blocking=1 AND source IN (${blocks.map(() => "?").join(",")})`).run(...blocks.map(b => `block:${b.height}`));
          return true;
        }).immediate();
        if (done) processed += blocks.length;
      } catch (error) {
        this.db.query("INSERT INTO issues VALUES(?,?,1) ON CONFLICT(source) DO UPDATE SET detail=excluded.detail,blocking=1").run(`block:${failedHeight}`, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
    this.applyStoredReceipts();
    return processed;
  }
  private applyTransaction(
    state: BookState,
    block: RawBlock,
    tx: RawTransaction,
  ) {
    const relevant = isDeploymentTransaction(tx, this.manifest);
    if (relevant)
      this.db
        .query(
          "INSERT INTO fees VALUES(?,?,?,?,?,?) ON CONFLICT(tx) DO NOTHING",
        )
        .run(
          tx.hash,
          tx.from,
          (uint(tx.gasUsed) * uint(tx.effectiveGasPrice)).toString(),
          networkSettings(this.manifest.environment).feeAsset,
          18,
          block.height,
        );
    if (tx.status === "reverted") {
      if (tx.logs.length) throw Error("Reverted transaction has logs");
      return;
    }
    const before = this.balance("kernel", "usdc");
    for (const log of [...tx.logs].sort((a, b) => a.index - b.index))
      if (sameAddress(log.address, this.manifest.kernelAddress))
        this.applyEvent(state, block, tx, log);
    const expected = this.balance("kernel", "usdc") - before;
    let transfers = 0n;
    for (const log of tx.logs)
      if (sameAddress(log.address, this.manifest.usdcAddress)) {
        let event;
        try {
          event = decodeEventLog({
            abi: erc20Abi,
            data: log.data,
            topics: log.topics,
          });
        } catch {
          continue;
        }
        if (event.eventName === "Transfer") {
          if (sameAddress(event.args.to, this.manifest.kernelAddress))
            transfers += event.args.value;
          if (sameAddress(event.args.from, this.manifest.kernelAddress))
            transfers -= event.args.value;
        }
      }
    if (transfers < expected)
      throw Error("Canonical journals exceed the net token transfer evidence");
    if (transfers > expected)
      this.db
        .query(
          "INSERT INTO issues VALUES(?,?,0) ON CONFLICT(source) DO NOTHING",
        )
        .run(
          `surplus:${tx.hash}`,
          `Unallocated incoming USDC ${transfers - expected}; no funded claim, revenue, or debt repayment was created.`,
        );
  }
  private applyEvent(
    state: BookState,
    block: RawBlock,
    tx: RawTransaction,
    log: RawLog,
  ) {
    const event = decodeEventLog({
      abi: KERNEL_ABI,
      data: log.data,
      topics: log.topics,
    });
    const source = `${tx.hash}:${log.index}`,
      lines: JournalLine[] = [];
    let planId: string | null = null;
    const add = (entity: string, account: string, delta: bigint) => {
      if (delta)
        lines.push({
          entity,
          account,
          side: delta > 0n ? "debit" : "credit",
          amount: (delta < 0n ? -delta : delta).toString(),
        });
    };
    const account = (id: bigint) => this.account(state, id.toString()).entity;
    const lender = this.entity(this.manifest.lenderAddress);
    const plan = (id: bigint) => {
      planId = id.toString();
      const p = state.plans[planId];
      if (!p) throw Error("Missing immutable plan context");
      return { p, t: decodeTerms(p.input), id: planId };
    };
    const loan = (p: string, a: string) => {
      const found = Object.values(state.loans).filter(
        (l) => l.plan === p && l.borrower === a,
      );
      if (found.length !== 1)
        throw Error("Missing or ambiguous funded principal");
      return found[0];
    };
    switch (event.eventName) {
      case "AccountOpened": {
        const a = event.args;
        if (state.accounts[a.accountId.toString()])
          throw Error("Duplicate account");
        state.accounts[a.accountId.toString()] = {
          owner: a.owner,
          entity: this.entity(a.owner),
        };
        break;
      }
      case "OfferCreated": {
        const a = event.args;
        state.offers[a.offerId.toString()] = {
          owner: a.supplierOwner,
          payee: a.payee,
          price: a.unitPrice.toString(),
          capacity: a.capacity.toString(),
          minimumFill: a.minimumFill.toString(),
          expiry: a.expiry.toString(),
          revoked: false,
        };
        break;
      }
      case "OfferRevoked": {
        const offer = state.offers[event.args.offerId.toString()];
        if (!offer) throw Error("Missing offer");
        offer.revoked = true;
        break;
      }
      case "PlanDrafted": {
        const a = event.args;
        if (!tx.to || !sameAddress(tx.to, this.manifest.kernelAddress))
          throw Error(
            "Draft from a contract call requires a trace adapter; context quarantined",
          );
        const t = decodeTerms(tx.input);
        if (
          termsHash(t, this.manifest) !== a.termsHash ||
          t.kind !== a.kind ||
          t.expiry !== a.expiry
        )
          throw Error("Draft input does not match the immutable terms hash");
        for (const r of t.offerRefs)
          if (!state.offers[r.offerId.toString()])
            throw Error("Offer predates supported opening checkpoint");
        state.plans[a.planId.toString()] = {
          input: tx.input,
          hash: a.termsHash,
          status: "Open",
          goods: "0",
          freight: "0",
          accepted: false,
          goodsReceived: false,
          freightReceived: false,
          coordinator: tx.from,
        };
        break;
      }
      case "CashDeposited": {
        const a = event.args,
          e = account(a.accountId);
        add(e, "cash", a.amount);
        add(e, "external", -a.amount);
        add("kernel", "usdc", a.amount);
        add("kernel", `due:account:${a.accountId}`, -a.amount);
        break;
      }
      case "CashWithdrawn": {
        const a = event.args,
          e = account(a.accountId),
          recipient = this.entity(a.to);
        add(e, "cash", -a.amount);
        add(
          e,
          recipient === e ? "external" : `transfer-out:${recipient}`,
          a.amount,
        );
        if (recipient !== e) {
          add(recipient, "external", a.amount);
          add(recipient, `transfer-in:${e}`, -a.amount);
        }
        add("kernel", "usdc", -a.amount);
        add("kernel", `due:account:${a.accountId}`, a.amount);
        break;
      }
      case "PoolDeposited": {
        const a = event.args;
        if (a.poolId !== 1n) throw Error("Unknown pool");
        add(lender, "cash", a.amount);
        add(lender, "external", -a.amount);
        add("kernel", "usdc", a.amount);
        add("kernel", "due:pool", -a.amount);
        break;
      }
      case "PoolWithdrawn": {
        const a = event.args,
          recipient = this.entity(a.to);
        if (a.poolId !== 1n) throw Error("Unknown pool");
        add(lender, "cash", -a.amount);
        add(
          lender,
          recipient === lender ? "external" : `transfer-out:${recipient}`,
          a.amount,
        );
        if (recipient !== lender) {
          add(recipient, "external", a.amount);
          add(recipient, `transfer-in:${lender}`, -a.amount);
        }
        add("kernel", "usdc", -a.amount);
        add("kernel", "due:pool", a.amount);
        break;
      }
      case "CustomerEscrowFunded": {
        const a = event.args,
          { t, id } = plan(a.planId);
        if (
          !sameAddress(t.saleParty.customerAddress, a.customer) ||
          a.amount !== t.saleParty.requiredEscrow
        )
          throw Error("Escrow differs from terms");
        const customer = this.entity(a.customer);
        add(customer, `escrow:${id}`, a.amount);
        add(customer, "external", -a.amount);
        add("kernel", "usdc", a.amount);
        add("kernel", `escrow:${id}`, -a.amount);
        break;
      }
      case "CustomerEscrowWithdrawn": {
        const a = event.args,
          { t, id } = plan(a.planId);
        if (!sameAddress(t.saleParty.customerAddress, a.customer))
          throw Error("Refund recipient differs");
        const customer = this.entity(a.customer);
        add(customer, "external", a.amount);
        add(customer, `escrow:${id}`, -a.amount);
        add("kernel", `escrow:${id}`, a.amount);
        add("kernel", "usdc", -a.amount);
        break;
      }
      case "PrincipalCreated": {
        const a = event.args;
        state.loans[a.loanId.toString()] = {
          id: a.loanId.toString(),
          plan: a.planId.toString(),
          borrower: a.borrowerAccountId.toString(),
          original: a.amount.toString(),
          outstanding: a.amount.toString(),
        };
        break;
      }
      case "PlanCommitted": {
        const a = event.args,
          { p, t, id } = plan(a.planId);
        if (p.status !== "Open" || p.hash !== a.termsHash)
          throw Error("Invalid or duplicate commitment");
        p.status = "Committed";
        p.goods = a.goodsPayout.toString();
        p.freight = a.freightPayout.toString();
        const goods = t.offerRefs[0];
        if (!goods) throw Error("Goods reference missing");
        const offer = state.offers[goods.offerId.toString()];
        if (!offer || BigInt(offer.price) * goods.quantity !== a.goodsPayout)
          throw Error("Goods payout differs from immutable quote");
        let principal = 0n;
        if (t.kind === 0) {
          let total = 0n;
          for (const b of t.buyers) {
            const buyer = account(b.accountId),
              allocation = b.ownCash + b.creditDraw;
            total += allocation;
            principal += b.creditDraw;
            add(buyer, `prepayment:goods:${id}`, allocation);
            add(buyer, "cash", -b.ownCash);
            if (b.creditDraw) {
              const l = loan(id, b.accountId.toString());
              if (BigInt(l.original) !== b.creditDraw)
                throw Error("Buyer principal mismatch");
              add(buyer, `loan-payable:${l.id}`, -b.creditDraw);
              add(lender, `loan-receivable:${l.id}`, b.creditDraw);
            }
            add(lender, "cash", -b.creditDraw);
            add("kernel", `due:account:${b.accountId}`, b.ownCash);
            add("kernel", "due:pool", b.creditDraw);
            add(this.entity(goods.payee), "external", allocation);
            add(
              this.entity(goods.payee),
              `supplier-advance:${id}:${b.accountId}`,
              -allocation,
            );
          }
          if (total !== a.goodsPayout || a.freightPayout !== 0n)
            throw Error("Group allocation mismatch");
        } else {
          const s = t.saleParty,
            merchant = account(s.merchantAccountId),
            customer = this.entity(s.customerAddress),
            freight = t.offerRefs[1];
          if (!freight) throw Error("Freight reference missing");
          const freightOffer = state.offers[freight.offerId.toString()];
          if (
            !freightOffer ||
            BigInt(freightOffer.price) * freight.quantity !== a.freightPayout
          )
            throw Error("Freight payout mismatch");
          principal = s.creditDraw;
          add(merchant, `prepayment:goods:${id}`, a.goodsPayout);
          add(merchant, `prepayment:freight:${id}`, a.freightPayout);
          add(merchant, "cash", -s.merchantCash);
          add(merchant, `customer-advance:${id}`, -s.requiredEscrow);
          if (s.creditDraw) {
            const l = loan(id, s.merchantAccountId.toString());
            if (BigInt(l.original) !== s.creditDraw)
              throw Error("Merchant principal mismatch");
            add(merchant, `loan-payable:${l.id}`, -s.creditDraw);
            add(lender, `loan-receivable:${l.id}`, s.creditDraw);
          }
          add(lender, "cash", -s.creditDraw);
          add(customer, `advance:${id}`, s.requiredEscrow);
          add(customer, `escrow:${id}`, -s.requiredEscrow);
          for (const [ref, amount, leg] of [
            [goods, a.goodsPayout, "goods"],
            [freight, a.freightPayout, "freight"],
          ] as const) {
            const supplier = this.entity(ref.payee);
            add(supplier, "external", amount);
            add(supplier, `supplier-advance:${id}:${leg}`, -amount);
          }
          add("kernel", `due:account:${s.merchantAccountId}`, s.merchantCash);
          add("kernel", "due:pool", s.creditDraw);
          add("kernel", `escrow:${id}`, s.requiredEscrow);
        }
        if (principal !== a.totalPrincipal)
          throw Error("Total principal differs from allocations");
        add("kernel", "usdc", -(a.goodsPayout + a.freightPayout));
        break;
      }
      case "GoodsAcknowledged":
      case "FreightAcknowledged": {
        const a = event.args,
          { p, t, id } = plan(a.planId);
        if (t.kind !== 1 || p.status !== "Committed")
          throw Error("Unsupported receipt event");
        const goods = event.eventName === "GoodsAcknowledged",
          index = goods ? 0 : 1,
          leg = goods ? "goods" : "freight",
          ref = t.offerRefs[index];
        if (
          !ref ||
          ref.quantity !== a.quantity ||
          !sameAddress(tx.from, t.saleParty.merchantOwner)
        )
          throw Error("Receipt actor or quantity differs from terms");
        if (goods ? p.goodsReceived : p.freightReceived)
          throw Error("Duplicate performance evidence");
        if (goods) p.goodsReceived = true;
        else p.freightReceived = true;
        const amount = BigInt(goods ? p.goods : p.freight),
          merchant = account(t.saleParty.merchantAccountId);
        add(merchant, `inventory:${id}`, amount);
        add(merchant, `prepayment:${leg}:${id}`, -amount);
        add(this.entity(ref.payee), `supplier-advance:${id}:${leg}`, amount);
        add(this.entity(ref.payee), "revenue", -amount);
        break;
      }
      case "CustomerAccepted": {
        const a = event.args,
          { p, t, id } = plan(a.planId),
          s = t.saleParty;
        if (
          t.kind !== 1 ||
          !p.goodsReceived ||
          !p.freightReceived ||
          p.accepted ||
          a.saleValue !== s.saleValue ||
          a.advanceApplied !== s.requiredEscrow ||
          a.receivableCreated !== s.saleValue - s.requiredEscrow ||
          !sameAddress(tx.from, s.customerAddress)
        )
          throw Error("Acceptance lacks required performance evidence");
        p.accepted = true;
        const merchant = account(s.merchantAccountId),
          customer = this.entity(s.customerAddress),
          cost = BigInt(p.goods) + BigInt(p.freight);
        add(merchant, `customer-advance:${id}`, a.advanceApplied);
        add(merchant, `ar:sale:${id}`, a.receivableCreated);
        add(merchant, "revenue", -a.saleValue);
        add(merchant, "cogs", cost);
        add(merchant, `inventory:${id}`, -cost);
        add(customer, `inventory:${id}`, a.saleValue);
        add(customer, `advance:${id}`, -a.advanceApplied);
        add(customer, `ap:sale:${id}`, -a.receivableCreated);
        break;
      }
      case "LoanRepaid": {
        const a = event.args,
          l = state.loans[a.loanId.toString()];
        if (!l || BigInt(l.outstanding) - a.amount !== a.remaining)
          throw Error("Principal rollforward mismatch");
        l.outstanding = a.remaining.toString();
        break;
      }
      case "SalesCollected": {
        const a = event.args,
          { p, t, id } = plan(a.planId),
          s = t.saleParty;
        if (!p.accepted || a.amount !== a.principalRepaid + a.merchantCredit)
          throw Error("Ineligible collection or waterfall mismatch");
        const merchant = account(s.merchantAccountId),
          customer = this.entity(s.customerAddress);
        add(merchant, "cash", a.merchantCredit);
        if (a.principalRepaid) {
          const l = loan(id, s.merchantAccountId.toString());
          add(merchant, `loan-payable:${l.id}`, a.principalRepaid);
          add(lender, "cash", a.principalRepaid);
          add(lender, `loan-receivable:${l.id}`, -a.principalRepaid);
        }
        add(merchant, `ar:sale:${id}`, -a.amount);
        add(customer, `ap:sale:${id}`, a.amount);
        add(customer, "external", -a.amount);
        add("kernel", "usdc", a.amount);
        add("kernel", `due:account:${s.merchantAccountId}`, -a.merchantCredit);
        add("kernel", "due:pool", -a.principalRepaid);
        break;
      }
      case "ReceivableRegistered": {
        const a = event.args;
        const beneficiary = account(a.beneficiaryAccountId),
          payer = this.entity(a.boundPayer);
        if (
          this.balance(beneficiary, `ar:opening:${a.beneficiaryAccountId}`) <
            a.amount ||
          -this.balance(payer, `ap:opening:${a.beneficiaryAccountId}`) <
            a.amount
        )
          throw Error("Opening receivable lacks checkpoint provenance");
        state.receivables[a.receivableId.toString()] = {
          account: a.beneficiaryAccountId.toString(),
          payer: a.boundPayer,
          amount: a.amount.toString(),
          remaining: a.amount.toString(),
        };
        break;
      }
      case "ReceivableCollected": {
        const a = event.args,
          r = state.receivables[a.receivableId.toString()];
        if (
          !r ||
          r.account !== a.beneficiaryAccountId.toString() ||
          !sameAddress(r.payer, a.payer) ||
          BigInt(r.remaining) - a.amount !== a.remaining
        )
          throw Error("Receivable collection mismatch");
        r.remaining = a.remaining.toString();
        const buyer = account(a.beneficiaryAccountId),
          customer = this.entity(a.payer);
        add(buyer, "cash", a.amount);
        add(buyer, `ar:opening:${a.beneficiaryAccountId}`, -a.amount);
        add(customer, `ap:opening:${a.beneficiaryAccountId}`, a.amount);
        add(customer, "external", -a.amount);
        add("kernel", "usdc", a.amount);
        add("kernel", `due:account:${a.beneficiaryAccountId}`, -a.amount);
        break;
      }
      case "InternalRepayment": {
        const a = event.args,
          l = state.loans[a.loanId.toString()];
        if (!l || l.borrower !== a.borrowerAccountId.toString())
          throw Error("Repayment loan identity mismatch");
        const buyer = account(a.borrowerAccountId);
        add(buyer, `loan-payable:${l.id}`, a.amount);
        add(buyer, "cash", -a.amount);
        add(lender, "cash", a.amount);
        add(lender, `loan-receivable:${l.id}`, -a.amount);
        add("kernel", `due:account:${a.borrowerAccountId}`, a.amount);
        add("kernel", "due:pool", -a.amount);
        break;
      }
      case "PlanCancelled":
        plan(event.args.planId).p.status = "Cancelled";
        break;
      case "PlanExpiredReleased":
        plan(event.args.planId).p.status = "Expired";
        break;
      case "SurplusObserved":
        this.db
          .query(
            "INSERT INTO issues VALUES(?,?,0) ON CONFLICT(source) DO NOTHING",
          )
          .run(source, `Unallocated surplus ${event.args.amount}`);
        break;
      case "FloorSet":
      case "OpeningCheckpointRecorded":
      case "PoolCreated":
      case "BorrowerLimitSet":
      case "LenderPlanApproved":
      case "SupplierPlanApproved":
      case "CapacityReserved":
      case "CapacityReleased":
      case "CapacityConsumed":
      case "BuyerJoined":
      case "BuyerLeft":
      case "MerchantJoined":
      case "MerchantLeft":
      case "CustomerEscrowWithdrawable":
        break;
      default: {
        const unsupported: never = event;
        throw Error(`Unsupported kernel event ${json(unsupported)}`);
      }
    }
    this.post(source, event.eventName, planId, block.timestamp, lines);
  }
  issueChallenge(
    planId: string,
    buyerAccount: string,
    now = Date.now(),
  ): ReceiptChallenge {
    const state = this.progress().state,
      p = state.plans[planId];
    if (!p || p.status !== "Committed")
      throw Error("Only committed allocations can be received");
    const t = decodeTerms(p.input),
      b = t.buyers.find((b) => b.accountId.toString() === buyerAccount);
    if (t.kind !== 0 || !b) throw Error("Named group buyer not found");
    const c: ReceiptChallenge = {
      version: 1,
      deployment: this.manifest.instanceId,
      chainId: this.manifest.chainId,
      kernel: this.manifest.kernelAddress,
      planId,
      termsHash: p.hash,
      buyerAccount,
      buyer: b.owner,
      quantity: b.quantity.toString(),
      nonce: crypto.randomUUID(),
      issuedAt: now,
      expiresAt: now + 600000,
    };
    this.db.query("INSERT INTO challenges VALUES(?,?)").run(c.nonce, json(c));
    return c;
  }
  async acceptReceipt(
    challenge: ReceiptChallenge,
    signature: Hex,
    now = Date.now(),
  ): Promise<"accepted" | "already-recorded"> {
    const c = parseChallenge(challenge),
      id = `${c.planId}:${c.buyerAccount}`,
      prior = this.db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM signed_receipts WHERE economic_id=?",
        )
        .get(id);
    if (prior) {
      const e = parseSignedReceipt(JSON.parse(prior.payload));
      if (json(e.challenge) === json(c) && e.signature === signature)
        return "already-recorded";
      throw Error("A delivery receipt already exists for this allocation");
    }
    const known = this.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM challenges WHERE nonce=?",
      )
      .get(c.nonce);
    if (!known || known.payload !== json(c))
      throw Error("Unknown or altered receipt challenge");
    const evidence: SignedReceipt = {
      challenge: c,
      signature,
      acceptedAt: now,
    };
    await verifyReceiptSignature(evidence);
    return this.db
      .transaction(() => {
        // Signature verification yields; another request may have committed this exact receipt meanwhile.
        const existing = this.db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM signed_receipts WHERE economic_id=?",
          )
          .get(id);
        if (existing) {
          const saved = parseSignedReceipt(JSON.parse(existing.payload));
          if (
            json(saved.challenge) === json(c) &&
            saved.signature === signature
          )
            return "already-recorded" as const;
          throw Error("A delivery receipt already exists for this allocation");
        }
        this.validateReceiptContext(evidence);
        this.db
          .query("INSERT INTO signed_receipts VALUES(?,?,?)")
          .run(id, c.nonce, json(evidence));
        this.postReceipt(id, evidence);
        return "accepted" as const;
      })
      .immediate();
  }
  private validateReceiptContext(e: SignedReceipt) {
    const c = e.challenge,
      m = this.manifest;
    if (
      c.deployment !== m.instanceId ||
      c.chainId !== m.chainId ||
      !sameAddress(c.kernel, m.kernelAddress)
    )
      throw Error("Receipt deployment mismatch");
    const state = this.progress().state,
      p = state.plans[c.planId];
    if (!p || p.status !== "Committed" || p.hash !== c.termsHash)
      throw Error("Receipt does not match a committed plan");
    const t = decodeTerms(p.input),
      b = t.buyers.find((b) => b.accountId.toString() === c.buyerAccount);
    if (
      t.kind !== 0 ||
      !b ||
      b.quantity.toString() !== c.quantity ||
      !sameAddress(b.owner, c.buyer) ||
      !sameAddress(this.account(state, c.buyerAccount).owner, c.buyer)
    )
      throw Error("Receipt does not match the full buyer allocation");
    return { state, p, t, b };
  }
  private postReceipt(id: string, e: SignedReceipt) {
    if (
      this.db
        .query("SELECT 1 FROM receipt_postings WHERE economic_id=?")
        .get(id)
    )
      return;
    const { state, t, b } = this.validateReceiptContext(e),
      ref = t.offerRefs[0];
    if (!ref) throw Error("Missing goods reference");
    const buyer = this.account(state, b.accountId.toString()).entity,
      supplier = this.entity(ref.payee),
      amount = (b.ownCash + b.creditDraw).toString();
    this.post(
      `signed-receipt:${id}`,
      "Buyer-signed goods receipt",
      e.challenge.planId,
      Math.floor(e.acceptedAt / 1000),
      [
        {
          entity: buyer,
          account: `inventory:${e.challenge.planId}`,
          side: "debit",
          amount,
        },
        {
          entity: buyer,
          account: `prepayment:goods:${e.challenge.planId}`,
          side: "credit",
          amount,
        },
        {
          entity: supplier,
          account: `supplier-advance:${e.challenge.planId}:${b.accountId}`,
          side: "debit",
          amount,
        },
        { entity: supplier, account: "revenue", side: "credit", amount },
      ],
    );
    this.db.query("INSERT INTO receipt_postings VALUES(?)").run(id);
  }
  private applyStoredReceipts() {
    this.db
      .transaction(() => {
        for (const e of this.receipts())
          this.postReceipt(
            `${e.challenge.planId}:${e.challenge.buyerAccount}`,
            e,
          );
      })
      .immediate();
  }
  async rebuild() {
    for (const e of this.receipts()) await verifyReceiptSignature(e);
    this.db
      .transaction(() => {
        this.db.exec(
          "DELETE FROM journal; DELETE FROM progress; DELETE FROM fees; DELETE FROM issues; DELETE FROM receipt_postings;",
        );
        this.initialize();
        for (;;) {
          const p = this.progress(), blocks = this.readBatch(p.height + 1);
          if (!blocks.length) break;
          for (const b of blocks) {
            if (b.height !== p.height + 1 || b.parent !== p.hash) throw Error("Raw chain parent mismatch");
            for (const tx of b.transactions) this.applyTransaction(p.state, b, tx);
            p.height = b.height; p.hash = b.hash;
          }
          this.db.query("UPDATE progress SET height=?,hash=?,state=? WHERE id=1").run(p.height, p.hash, json(p.state));
        }
        for (const e of this.receipts())
          this.postReceipt(
            `${e.challenge.planId}:${e.challenge.buyerAccount}`,
            e,
          );
      })
      .immediate();
    return this.digest();
  }
}
