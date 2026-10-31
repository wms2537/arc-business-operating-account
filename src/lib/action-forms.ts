import { encodeFunctionData, type Hex } from "viem";
import { KERNEL_ABI } from "./kernel-abi";
import { uint, address, hash, parseMoney } from "./boundary";
export type Field = {
  key: string;
  label: string;
  kind?: "money" | "quantity" | "address" | "time" | "hash";
};
export type FormAction = {
  id: string;
  label: string;
  fields: Field[];
  build: (v: Record<string, string>) => Hex;
};
const a = (key: string, label: string, kind?: Field["kind"]): Field => ({
  key,
  label,
  kind,
});
const money = (v: string) => parseMoney(v),
  zero = (v: string) => parseMoney(v, { allowZero: true }),
  n = (v: string) => uint(v);
export function deadline(value: string): bigint {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time) || time <= Date.now())
    throw Error("Choose a future expiry");
  return BigInt(Math.floor(time / 1000));
}
const plan = a("planId", "Operation ID", "quantity"),
  account = a("accountId", "Business account ID", "quantity"),
  amount = a("amount", "Amount (USDC)", "money"),
  to = a("to", "Recipient wallet", "address"),
  expiry = a("expiry", "Approval expiry (your local time)", "time");
export const forms = {
  openAccount: {
    id: "openAccount",
    label: "Open business account",
    fields: [],
    build: () =>
      encodeFunctionData({ abi: KERNEL_ABI, functionName: "openAccount" }),
  },
  depositCash: {
    id: "depositCash",
    label: "Deposit USDC",
    fields: [account, amount],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "depositCash",
        args: [n(v.accountId), money(v.amount)],
      }),
  },
  withdrawCash: {
    id: "withdrawCash",
    label: "Withdraw USDC",
    fields: [account, to, amount],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "withdrawCash",
        args: [n(v.accountId), address(v.to), money(v.amount)],
      }),
  },
  setProtectedFloor: {
    id: "setProtectedFloor",
    label: "Set protected cash",
    fields: [account, a("amount", "Protected amount (USDC)", "money")],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "setProtectedFloor",
        args: [n(v.accountId), zero(v.amount)],
      }),
  },
  recordOpeningCheckpoint: {
    id: "recordOpeningCheckpoint",
    label: "Record account claim checkpoint",
    fields: [account],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "recordOpeningCheckpoint",
        args: [n(v.accountId)],
      }),
  },
  depositPool: {
    id: "depositPool",
    label: "Fund lender pool",
    fields: [amount],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "depositPool",
        args: [1n, money(v.amount)],
      }),
  },
  withdrawPool: {
    id: "withdrawPool",
    label: "Withdraw lender funds",
    fields: [to, amount],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "withdrawPool",
        args: [1n, address(v.to), money(v.amount)],
      }),
  },
  setBorrowerLimit: {
    id: "setBorrowerLimit",
    label: "Set borrower limit",
    fields: [account, a("amount", "Principal ceiling (USDC)", "money")],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "setBorrowerLimit",
        args: [1n, n(v.accountId), zero(v.amount)],
      }),
  },
  createOffer: {
    id: "createOffer",
    label: "Create supplier offer",
    fields: [
      to,
      a("price", "Price per unit (USDC)", "money"),
      a("capacity", "Total capacity", "quantity"),
      a("minimum", "Minimum fill", "quantity"),
      expiry,
    ],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "createOffer",
        args: [
          address(v.to),
          money(v.price),
          n(v.capacity),
          n(v.minimum),
          deadline(v.expiry),
        ],
      }),
  },
  revokeOffer: {
    id: "revokeOffer",
    label: "Revoke offer",
    fields: [a("offerId", "Offer ID", "quantity")],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "revokeOffer",
        args: [n(v.offerId)],
      }),
  },
  approveLenderPlan: {
    id: "approveLenderPlan",
    label: "Approve exact credit draw",
    fields: [
      plan,
      a("index", "Participant index (starts at 0)", "quantity"),
      amount,
      expiry,
    ],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "approveLenderPlan",
        args: [n(v.planId), n(v.index), zero(v.amount), deadline(v.expiry)],
      }),
  },
  approveSupplierPlan: {
    id: "approveSupplierPlan",
    label: "Approve supplier allocation",
    fields: [
      plan,
      a("index", "Offer index (0 goods, 1 freight)", "quantity"),
      a("quantity", "Exact quantity", "quantity"),
      expiry,
    ],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "approveSupplierPlan",
        args: [n(v.planId), n(v.index), n(v.quantity), deadline(v.expiry)],
      }),
  },
  revokeLenderApproval: {
    id: "revokeLenderApproval",
    label: "Revoke credit approval",
    fields: [plan, a("index", "Participant index", "quantity")],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "revokeLenderApproval",
        args: [n(v.planId), n(v.index)],
      }),
  },
  revokeOfferApproval: {
    id: "revokeOfferApproval",
    label: "Revoke supplier approval",
    fields: [plan, a("index", "Offer index", "quantity")],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "revokeOfferApproval",
        args: [n(v.planId), n(v.index)],
      }),
  },
  joinBuyer: {
    id: "joinBuyer",
    label: "Join group purchase",
    fields: [plan, a("index", "Your buyer index", "quantity")],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "joinBuyer",
        args: [n(v.planId), n(v.index)],
      }),
  },
  leaveBuyer: {
    id: "leaveBuyer",
    label: "Leave group purchase",
    fields: [plan, a("index", "Your buyer index", "quantity")],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "leaveBuyer",
        args: [n(v.planId), n(v.index)],
      }),
  },
  joinMerchant: {
    id: "joinMerchant",
    label: "Reserve merchant funding",
    fields: [plan],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "joinMerchant",
        args: [n(v.planId)],
      }),
  },
  leaveMerchant: {
    id: "leaveMerchant",
    label: "Release merchant reservation",
    fields: [plan],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "leaveMerchant",
        args: [n(v.planId)],
      }),
  },
  fundCustomerEscrow: {
    id: "fundCustomerEscrow",
    label: "Fund exact customer escrow",
    fields: [plan],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "fundCustomerEscrow",
        args: [n(v.planId)],
      }),
  },
  withdrawCustomerEscrow: {
    id: "withdrawCustomerEscrow",
    label: "Withdraw refundable escrow",
    fields: [plan],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "withdrawCustomerEscrow",
        args: [n(v.planId)],
      }),
  },
  commitPlan: {
    id: "commitPlan",
    label: "Commit financial close",
    fields: [plan],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "commitPlan",
        args: [n(v.planId)],
      }),
  },
  cancelPlan: {
    id: "cancelPlan",
    label: "Cancel open operation",
    fields: [plan],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "cancelPlan",
        args: [n(v.planId)],
      }),
  },
  releaseExpiredPlan: {
    id: "releaseExpiredPlan",
    label: "Release expired reservations",
    fields: [plan],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "releaseExpiredPlan",
        args: [n(v.planId)],
      }),
  },
  acknowledgeGoods: {
    id: "acknowledgeGoods",
    label: "Acknowledge goods received",
    fields: [plan],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "acknowledgeGoods",
        args: [n(v.planId)],
      }),
  },
  acknowledgeFreight: {
    id: "acknowledgeFreight",
    label: "Acknowledge freight received",
    fields: [plan],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "acknowledgeFreight",
        args: [n(v.planId)],
      }),
  },
  acceptSalesOrder: {
    id: "acceptSalesOrder",
    label: "Accept delivered order",
    fields: [plan],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "acceptSalesOrder",
        args: [n(v.planId)],
      }),
  },
  collectSalesBalance: {
    id: "collectSalesBalance",
    label: "Pay sales balance",
    fields: [
      plan,
      a("reference", "Unique payment reference (32-byte hash)", "hash"),
      amount,
    ],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "collectSalesBalance",
        args: [n(v.planId), hash(v.reference), money(v.amount)],
      }),
  },
  repayLoan: {
    id: "repayLoan",
    label: "Repay principal from free cash",
    fields: [a("loanId", "Loan ID", "quantity"), amount],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "repayLoan",
        args: [n(v.loanId), money(v.amount)],
      }),
  },
  registerReceivable: {
    id: "registerReceivable",
    label: "Register opening receivable",
    fields: [
      a("receivableId", "Receivable ID", "quantity"),
      account,
      a("payer", "Named payer wallet", "address"),
      amount,
      a("reference", "Opening evidence reference (32-byte hash)", "hash"),
    ],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "registerReceivable",
        args: [
          n(v.receivableId),
          n(v.accountId),
          address(v.payer),
          money(v.amount),
          hash(v.reference),
        ],
      }),
  },
  collectReceivable: {
    id: "collectReceivable",
    label: "Pay opening receivable",
    fields: [
      a("receivableId", "Receivable ID", "quantity"),
      a("reference", "Unique payment reference (32-byte hash)", "hash"),
      amount,
    ],
    build: (v) =>
      encodeFunctionData({
        abi: KERNEL_ABI,
        functionName: "collectReceivable",
        args: [n(v.receivableId), hash(v.reference), money(v.amount)],
      }),
  },
} satisfies Record<string, FormAction>;
