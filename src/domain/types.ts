/**
 * Core domain types for the Business Account kernel.
 *
 * All monetary amounts are integer bigint in USDC 6-decimal units.
 * No floating point on any money path.
 *
 * Two workflow families share one kernel:
 *   WorkflowKind.CollectivePurchase  — Scenario A: group buyers, lender, shared supplier offer
 *   WorkflowKind.CustomerOrder       — Scenario B: single merchant, customer escrow, lender credit
 */

// ---------------------------------------------------------------------------
// Kernel entity identifiers
// ---------------------------------------------------------------------------

/** Opaque account ID — maps to a logical sub-account inside the kernel contract. */
export type AccountId = bigint;

/** Immutable plan ID created by the kernel on commit. */
export type PlanId = bigint;

/** Supplier offer ID. */
export type OfferId = bigint;

/** Journal entry sequence number (monotonically increasing per projection). */
export type JournalSeq = bigint;

// ---------------------------------------------------------------------------
// Kernel on-chain state shapes (mirrors contract storage)
// ---------------------------------------------------------------------------

export type WorkflowKind = 'CollectivePurchase' | 'CustomerOrder';

export type PlanStatus =
  | 'Draft'       // parties assembling
  | 'Ready'       // all authorizations collected, readiness check passes
  | 'Committed'   // close executed: supplier paid, principal created
  | 'Cancelled'   // pre-close cancel: escrow released, holds freed
  | 'Disputed';   // post-close dispute recorded (no transfer reversal)

export type AuthorizationRole =
  | 'Buyer'         // collective purchase participant
  | 'Lender'        // credit provider
  | 'Customer'      // deposits refundable escrow
  | 'Merchant'      // receives net proceeds after close
  | 'Supplier';     // receives payment on commit

export interface Authorization {
  role: AuthorizationRole;
  signer: `0x${string}`;
  /** Exact plan terms this signer authorized — immutable after signing. */
  planTermsHash: `0x${string}`;
  expiry: bigint;           // Unix seconds
  revokedAt: bigint | null; // null = not revoked
}

export interface SupplierOffer {
  offerId: OfferId;
  supplier: `0x${string}`;
  token: `0x${string}`;
  unitPrice: bigint;  // USDC 6-dec
  capacity: bigint;   // units remaining
  expiry: bigint;
}

// ---------------------------------------------------------------------------
// Plan allocations (per-party, in 6-decimal USDC token units)
// ---------------------------------------------------------------------------

export interface BuyerAllocation {
  account: AccountId;
  signer: `0x${string}`;
  quantity: bigint;
  ownContribution: bigint;  // own cash reserved
  creditAmount: bigint;     // funded credit reserved
  approvalCeiling: bigint;  // max credit the buyer approved
  principal: bigint;        // created on commit (0 before commit)
}

export interface CustomerAllocation {
  escrowAmount: bigint;    // refundable pre-close
  escrowReleased: boolean; // true after commit
}

export interface MerchantAllocation {
  cashReservation: bigint;
  protectedFloor: bigint;
  debt: bigint;
}

export interface LenderAllocation {
  account: AccountId;
  signer: `0x${string}`;
  creditReservation: bigint;
  totalPrincipal: bigint;
}

// ---------------------------------------------------------------------------
// Plan — collective purchase
// ---------------------------------------------------------------------------

export interface CollectivePurchasePlan {
  kind: 'CollectivePurchase';
  planId: PlanId;
  status: PlanStatus;
  offerId: OfferId;
  totalQuantity: bigint;
  totalPrice: bigint;
  buyers: BuyerAllocation[];
  lender: LenderAllocation | null;
  authorizations: Authorization[];
  expiry: bigint;
  committedAt: bigint | null;
}

// ---------------------------------------------------------------------------
// Plan — customer order
// ---------------------------------------------------------------------------

export interface CustomerOrderPlan {
  kind: 'CustomerOrder';
  planId: PlanId;
  status: PlanStatus;
  offerId: OfferId;
  saleAmount: bigint;
  freightCost: bigint;
  totalSupplierCost: bigint;
  customer: CustomerAllocation;
  merchant: MerchantAllocation;
  lender: LenderAllocation | null;
  authorizations: Authorization[];
  expiry: bigint;
  committedAt: bigint | null;
  /** Post-commit accounting phase */
  goodsAcknowledged: boolean;
  freightAcknowledged: boolean;
  customerAccepted: boolean;
  receivable: bigint;       // 0 before customer acceptance
  collectedAmount: bigint;  // cumulative repayment
}

// ---------------------------------------------------------------------------
// Account (logical sub-account in kernel custody)
// ---------------------------------------------------------------------------

export interface KernelAccount {
  accountId: AccountId;
  owner: `0x${string}`;
  /** Balance freely withdrawable after reservations and floor. */
  availableCash: bigint;
  /** Total cash reserved across all active plans. */
  totalHeld: bigint;
  /** Protected floor — cannot be lowered while holds or debt active. */
  protectedFloor: bigint;
  /** Total debt (funded credit drawn). */
  totalDebt: bigint;
  /** Lender's funded credit pool (separate from merchant cash). */
  fundedCredit: bigint;
  /** Non-withdrawable surplus from unrequested transfers. */
  surplus: bigint;
}

// ---------------------------------------------------------------------------
// Accounting journal entry
// ---------------------------------------------------------------------------

export type JournalEntryType =
  | 'OpeningBalance'
  | 'CashDeposit'
  | 'CreditDeposit'
  | 'CashReservation'
  | 'CreditReservation'
  | 'CustomerEscrowDeposit'
  | 'SupplierPayment'          // prepayment on commit
  | 'FreightPayment'           // prepayment on commit
  | 'PrincipalCreated'         // funded credit draw on commit
  | 'InventoryRecognized'      // goods + freight ack → inventory asset
  | 'SaleRecognized'           // customer acceptance → revenue + receivable
  | 'AdvanceLiabilityApplied'  // customer advance reduces receivable
  | 'CashCollection'           // customer pays receivable
  | 'LenderRepayment'          // internal reallocation, no external transfer
  | 'PrincipalSettled'         // principal zeroed after repayment
  | 'EscrowReleased'           // customer escrow → merchant cash on commit
  | 'EscrowRefunded'           // customer escrow returned on cancel
  | 'HoldReleased'             // cancelled plan frees reservations
  | 'DisputeRecorded';         // post-close, no transfer reversal

export interface JournalEntry {
  seq: JournalSeq;
  planId: PlanId | null;
  type: JournalEntryType;
  debitAccount: string;
  creditAccount: string;
  amount: bigint;       // 6-dec USDC units
  /** On-chain event log index that sourced this entry. */
  sourceEventId: string;
  timestamp: bigint;    // Unix seconds
  note: string;
}

// ---------------------------------------------------------------------------
// Kernel global state (read from contract)
// ---------------------------------------------------------------------------

export interface KernelState {
  contractAddress: `0x${string}`;
  usdcAddress: `0x${string}`;
  chainId: number;
  totalCustody: bigint;   // sum of all logical account claims
  accounts: KernelAccount[];
  offers: SupplierOffer[];
  plans: (CollectivePurchasePlan | CustomerOrderPlan)[];
  journalEntries: JournalEntry[];
  lastSyncedBlock: bigint;
  isSyncing: boolean;
}
