import React, { useEffect, useMemo, useState } from "react";
import { useAccount, useConnect, useDisconnect, useWalletClient } from "wagmi";
import {
  encodeFunctionData,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { KERNEL_ABI, RELEASE_ID } from "./lib/kernel-abi";
import {
  api,
  parseDeployments,
  parseBooks,
  type Deployment,
  type BookView,
} from "./lib/app-api";
import {
  snapshot,
  approvalData,
  type Snapshot,
  type PlanTerms,
} from "./lib/kernel-client";
import { validateDeployment, networkSettings } from "./lib/deployment";
import {
  address,
  uint,
  parseMoney,
  money,
  sameAddress,
  record,
  hex,
} from "./lib/boundary";
import {
  forms,
  deadline,
  type FormAction,
  type Field,
} from "./lib/action-forms";
import {
  browserIntentStore,
  submitIntent,
  withWalletLock,
  restoreInterruptedIntents,
  reconcileIntent,
  type Intent,
} from "./lib/transactions";
import { parseChallenge, receiptMessage } from "./lib/receipt-evidence";
import "./business.css";

type Screen =
  | "Account"
  | "Operations"
  | "Operation detail"
  | "Funding"
  | "Books"
  | "Evidence";
type Review = {
  title: string;
  to: Address;
  data: Hex;
  rows: { label: string; value: string }[];
};
const short = (s: string) =>
  s.length > 20 ? s.slice(0, 10) + "…" + s.slice(-6) : s;
const fail = (e: unknown) => (e instanceof Error ? e.message : String(e));
function FieldInput({
  field,
  value,
  onChange,
  readOnly = false,
}: {
  field: Field;
  value: string;
  onChange: (s: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label className="field">
      {field.label}
      <input
        aria-label={field.label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={field.kind === "time" ? "datetime-local" : "text"}
        inputMode={
          field.kind === "money"
            ? "decimal"
            : field.kind === "quantity"
              ? "numeric"
              : "text"
        }
        readOnly={readOnly}
        required
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
}
function ActionForm({
  action,
  defaults = {},
  fixed = [],
  blocked,
  review,
}: {
  action: FormAction;
  defaults?: Record<string, string>;
  fixed?: string[];
  blocked: string | null;
  review: (r: Omit<Review, "to">) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => ({
      ...defaults,
      ...(action.id === "collectSalesBalance"
        ? { reference: keccak256(toBytes(crypto.randomUUID())) }
        : {}),
    })),
    [error, setError] = useState("");
  return (
    <details className="action-form">
      <summary>{action.label}</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            setError("");
            review({
              title: action.label,
              data: action.build(values),
              rows: action.fields.map((f) => ({
                label: f.label,
                value: values[f.key] ?? "",
              })),
            });
          } catch (error) {
            setError(fail(error));
          }
        }}
      >
        <div className="form-grid">
          {action.fields.map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              value={values[field.key] ?? ""}
              readOnly={fixed.includes(field.key)}
              onChange={(value) =>
                setValues((v) => ({ ...v, [field.key]: value }))
              }
            />
          ))}
        </div>
        {blocked && <p className="hint">{blocked}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={!!blocked}>
          Review {action.label.toLowerCase()}
        </button>
      </form>
    </details>
  );
}
function DraftForm({
  kind,
  blocked,
  review,
}: {
  kind: 0 | 1;
  blocked: string | null;
  review: (r: Omit<Review, "to">) => void;
}) {
  const [v, setV] = useState<Record<string, string>>({}),
    [buyers, setBuyers] = useState<Record<string, string>[]>([{}]),
    [error, setError] = useState("");
  const common: Field[] = [
    { key: "goodsOffer", label: "Goods offer ID", kind: "quantity" },
    { key: "goodsPayee", label: "Goods payee wallet", kind: "address" },
    { key: "goodsQuantity", label: "Goods quantity", kind: "quantity" },
    {
      key: "expiry",
      label: "Operation expiry (your local time)",
      kind: "time",
    },
    { key: "reference", label: "Commercial reference label" },
  ];
  const sale: Field[] = [
    { key: "merchant", label: "Merchant wallet", kind: "address" },
    { key: "account", label: "Merchant account ID", kind: "quantity" },
    { key: "ownCash", label: "Merchant own cash (USDC)", kind: "money" },
    { key: "draw", label: "Credit draw (USDC)", kind: "money" },
    { key: "limit", label: "Credit ceiling (USDC)", kind: "money" },
    { key: "customer", label: "Customer wallet", kind: "address" },
    { key: "escrow", label: "Required customer escrow (USDC)", kind: "money" },
    { key: "sale", label: "Sale consideration (USDC)", kind: "money" },
    { key: "freightOffer", label: "Freight offer ID", kind: "quantity" },
    { key: "freightPayee", label: "Freight payee wallet", kind: "address" },
    { key: "freightQuantity", label: "Freight quantity", kind: "quantity" },
  ];
  const buyerFields: Field[] = [
    { key: "owner", label: "Buyer wallet", kind: "address" },
    { key: "account", label: "Buyer account ID", kind: "quantity" },
    { key: "quantity", label: "Buyer quantity", kind: "quantity" },
    { key: "cash", label: "Buyer own cash (USDC)", kind: "money" },
    { key: "draw", label: "Buyer credit draw (USDC)", kind: "money" },
    { key: "limit", label: "Buyer credit ceiling (USDC)", kind: "money" },
  ];
  return (
    <details className="action-form">
      <summary>
        Draft {kind === 1 ? "customer order" : "group purchase"}
      </summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const zero: Address = "0x0000000000000000000000000000000000000000",
              m = (s: string) => parseMoney(s, { allowZero: true });
            const buyerTerms =
              kind === 0
                ? buyers.map((b) => ({
                    owner: address(b.owner),
                    accountId: uint(b.account),
                    quantity: uint(b.quantity),
                    ownCash: m(b.cash),
                    creditDraw: m(b.draw),
                    creditLimit: m(b.limit),
                  }))
                : [];
            const saleParty =
              kind === 1
                ? {
                    merchantOwner: address(v.merchant),
                    merchantAccountId: uint(v.account),
                    merchantCash: m(v.ownCash),
                    creditDraw: m(v.draw),
                    creditLimit: m(v.limit),
                    customerAddress: address(v.customer),
                    requiredEscrow: parseMoney(v.escrow),
                    saleValue: parseMoney(v.sale),
                  }
                : {
                    merchantOwner: zero,
                    merchantAccountId: 0n,
                    merchantCash: 0n,
                    creditDraw: 0n,
                    creditLimit: 0n,
                    customerAddress: zero,
                    requiredEscrow: 0n,
                    saleValue: 0n,
                  };
            const offerRefs = [
              {
                offerId: uint(v.goodsOffer),
                quantity: uint(v.goodsQuantity),
                payee: address(v.goodsPayee),
              },
              ...(kind === 1
                ? [
                    {
                      offerId: uint(v.freightOffer),
                      quantity: uint(v.freightQuantity),
                      payee: address(v.freightPayee),
                    },
                  ]
                : []),
            ];
            if (!v.reference?.trim())
              throw Error(
                "Enter an opaque commercial reference; do not include confidential documents",
              );
            const terms: PlanTerms = {
              kind,
              buyers: buyerTerms,
              saleParty,
              lenderPoolId:
                (kind === 1
                  ? saleParty.creditDraw
                  : buyerTerms.reduce((n, b) => n + b.creditDraw, 0n)) > 0n
                  ? 1n
                  : 0n,
              offerRefs,
              expiry: deadline(v.expiry),
              commercialRef: keccak256(toBytes(v.reference)),
            };
            const rows = [...common, ...(kind === 1 ? sale : [])].map((f) => ({
              label: f.label,
              value: v[f.key] ?? "",
            }));
            buyers.forEach((b, i) => {
              if (kind === 0)
                buyerFields.forEach((f) =>
                  rows.push({
                    label: `Buyer ${i + 1}: ${f.label}`,
                    value: b[f.key] ?? "",
                  }),
                );
            });
            review({
              title:
                kind === 1
                  ? "Draft immutable customer order"
                  : "Draft immutable group purchase",
              data: encodeFunctionData({
                abi: KERNEL_ABI,
                functionName: "draftPlan",
                args: [terms],
              }),
              rows,
            });
            setError("");
          } catch (error) {
            setError(fail(error));
          }
        }}
      >
        <p className="hint">
          Terms become immutable when drafted. Each party approves and reserves
          separately. Drafting moves no funds.
        </p>
        <div className="form-grid">
          {[...common, ...(kind === 1 ? sale : [])].map((f) => (
            <FieldInput
              key={f.key}
              field={f}
              value={v[f.key] ?? ""}
              onChange={(value) => setV((old) => ({ ...old, [f.key]: value }))}
            />
          ))}
        </div>
        {kind === 0 &&
          buyers.map((b, i) => (
            <fieldset key={i}>
              <legend>Buyer {i + 1}</legend>
              <div className="form-grid">
                {buyerFields.map((f) => (
                  <FieldInput
                    key={f.key}
                    field={{ ...f, label: `Buyer ${i + 1}: ${f.label}` }}
                    value={b[f.key] ?? ""}
                    onChange={(value) =>
                      setBuyers((old) =>
                        old.map((row, j) =>
                          i === j ? { ...row, [f.key]: value } : row,
                        ),
                      )
                    }
                  />
                ))}
              </div>
              {buyers.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    setBuyers((old) => old.filter((_, j) => j !== i))
                  }
                >
                  Remove buyer
                </button>
              )}
            </fieldset>
          ))}
        {kind === 0 && buyers.length < 8 && (
          <button
            type="button"
            onClick={() => setBuyers((old) => [...old, {}])}
          >
            Add buyer
          </button>
        )}
        {blocked && <p className="hint">{blocked}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={!!blocked}>
          Review immutable terms
        </button>
      </form>
    </details>
  );
}
export default function App() {
  const [screen, setScreen] = useState<Screen>("Account"),
    [deployments, setDeployments] = useState<Deployment[]>([]),
    [selected, setSelected] = useState(""),
    [books, setBooks] = useState<BookView | null>(null),
    [live, setLive] = useState<Snapshot | null>(null),
    [accountId, setAccountId] = useState(""),
    [planId, setPlanId] = useState(""),
    [entity, setEntity] = useState(""),
    [review, setReview] = useState<Review | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [intents, setIntents] = useState<Intent[]>([]),
    [allowance, setAllowance] = useState("");
  const { address: signer, chainId, isConnected } = useAccount(),
    { connect, connectors, error: connectError } = useConnect(),
    { disconnect } = useDisconnect(),
    { data: wallet } = useWalletClient();
  const deployment = deployments.find(
      (d) => d.manifest.instanceId === selected,
    ),
    manifest = deployment?.manifest;
  const store = useMemo(() => browserIntentStore(localStorage), []);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => {
    setLoading(true);
    setRefreshKey((key) => key + 1);
  };
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!deployment) {
        setBooks(null);
        setLive(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      try {
        await validateDeployment(deployment.client, deployment.manifest);
        const b = parseBooks(
          await api("/api/books?deployment=" + deployment.manifest.instanceId),
        );
        if (b.deployment !== deployment.manifest.instanceId)
          throw Error("Books response belongs to another deployment");
        const state = await snapshot(
          deployment.client,
          deployment.manifest.kernelAddress,
          b.accounts.map((a) => a.id),
          b.plans,
          signer,
        );
        if (!active) return;
        setBooks(b);
        setLive(state);
        setAccountId((id) =>
          b.accounts.some((a) => a.id === id)
            ? id
            : (b.accounts.find((a) => signer && sameAddress(a.owner, signer))
                ?.id ??
              b.accounts[0]?.id ??
              ""),
        );
        setPlanId((id) =>
          b.plans.some((p) => p.id === id) ? id : (b.plans[0]?.id ?? ""),
        );
        setIntents(store.list());
      } catch (e) {
        if (active) {
          setLive(null);
          setBooks(null);
          setError(fail(e));
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [deployment, signer, store, refreshKey]);
  useEffect(() => {
    let active = true;
    api("/api/deployments")
      .then(parseDeployments)
      .then((ds) => {
        if (active) {
          setDeployments(ds);
          setSelected(ds[0]?.manifest.instanceId ?? "");
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setError(
            "The books service is unavailable. Account actions will remain disabled until it reconnects.",
          );
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const contextKey = selected + ":" + (signer ?? "") + ":" + (chainId ?? "");
  const [reviewContext, setReviewContext] = useState(contextKey);
  if (reviewContext !== contextKey) {
    setReviewContext(contextKey);
    setReview(null);
  }
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (!active) return;
        restoreInterruptedIntents(store);
        setIntents(store.list());
      })
      .catch((e) => {
        if (active) setError(fail(e));
      });
    return () => {
      active = false;
    };
  }, [store]);
  useEffect(() => {
    if (!review) return;
    const dialog = document.querySelector<HTMLElement>(
        '[aria-labelledby="review-title"]',
      ),
      previous = document.activeElement;
    if (!dialog) return;
    const controls = () =>
      Array.from(
        dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
      );
    controls()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setReview(null);
      }
      if (event.key !== "Tab") return;
      const list = controls(),
        first = list[0],
        last = list[list.length - 1];
      if (!first) return;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [review, busy]);
  const account = live?.accounts.find((a) => a.id === accountId),
    accountInfo = books?.accounts.find((a) => a.id === accountId),
    plan = books?.plans.find((p) => p.id === planId),
    planLive = live?.plans.find((p) => p.id === planId);
  const blocked = !manifest
    ? "No verified deployment is configured."
    : loading
      ? "Refreshing confirmed state."
      : !live
        ? "Verified chain reads are unavailable."
        : !isConnected || !signer
          ? "Connect the wallet that owns this action."
          : chainId !== manifest.chainId
            ? `Switch your wallet to ${networkSettings(manifest.environment).label} (${manifest.chainId}).`
            : !wallet
              ? "Wallet is connecting."
              : busy
                ? "Wait for the current action to finish."
                : null;
  const ownsAccount =
      !!signer && !!accountInfo && sameAddress(signer, accountInfo.owner),
    isLender =
      !!signer && !!manifest && sameAddress(signer, manifest.lenderAddress);
  const ownBlocked =
      blocked ??
      (!ownsAccount
        ? "This view belongs to another wallet. Connect its owner to act."
        : null),
    lenderBlocked =
      blocked ?? (!isLender ? "Connect the lender pool owner to act." : null);
  const protectedCashFor = (id: bigint) => {
    const participant = live?.accounts.find((row) => row.id === id.toString());
    return participant ? `${money(participant.floor)} USDC` : "Unavailable";
  };
  const requestReview = (r: Omit<Review, "to">) => {
    if (manifest) setReview({ ...r, to: manifest.kernelAddress });
  };
  const act = (
    action: FormAction,
    reason: string | null = blocked,
    defaults: Record<string, string> = {},
    fixed: string[] = [],
  ) => (
    <ActionForm
      key={
        action.id +
        planId +
        accountId +
        (action.id === "collectSalesBalance" ? intents.length : "")
      }
      action={action}
      blocked={reason}
      defaults={defaults}
      fixed={fixed}
      review={requestReview}
    />
  );
  const work = async (task: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(fail(e));
    } finally {
      setBusy(false);
      try {
        setIntents(store.list());
      } catch (e) {
        setError(fail(e));
      }
    }
  };
  const submit = () =>
    work(async () => {
      if (!deployment || !review || !wallet || !signer || blocked)
        throw Error(blocked ?? "Wallet unavailable");
      const checkedSigner = signer;
      const intent = await withWalletLock(
        deployment.manifest.chainId,
        checkedSigner,
        () =>
          submitIntent({
            client: deployment.client,
            manifest: deployment.manifest,
            store,
            to: review.to,
            data: review.data,
            purpose: review.title,
            wallet: {
              identity: async () => {
                const addresses = await wallet.getAddresses();
                const current = addresses[0];
                if (!current || !sameAddress(current, checkedSigner))
                  throw Error("Connected account changed. Review again.");
                return { address: current, chainId: await wallet.getChainId() };
              },
              send: (input) =>
                wallet.sendTransaction({
                  account: checkedSigner,
                  chain: networkSettings(deployment.manifest.environment).chain,
                  to: input.to,
                  data: input.data,
                  value: input.value,
                  nonce: input.nonce,
                }),
            },
          }),
      );
      setReview(null);
      setNotice(
        intent.state.kind === "unknown"
          ? "Wallet response is uncertain. Use Recover status; do not submit again."
          : intent.state.kind === "rejected"
            ? "The wallet request was declined."
            : "Transaction submitted. Recover status checks the receipt and book progress.",
      );
      refresh();
    });
  const recover = (intent: Intent) =>
    work(async () => {
      if (!deployment) throw Error("Select the original deployment");
      const result = await reconcileIntent(
        deployment.client,
        deployment.manifest,
        store,
        intent,
        BigInt(books?.height ?? 0),
      );
      setNotice(
        result.state.kind === "confirmed"
          ? `Transaction confirmed. Books ${result.state.books}.`
          : result.state.kind === "unknown"
            ? result.state.detail
            : `Transaction ${result.state.kind}.`,
      );
      refresh();
    });
  const signedReceipt = (buyerAccount: string) =>
    work(async () => {
      if (!deployment || !wallet || !signer || blocked)
        throw Error(blocked ?? "Wallet unavailable");
      const result = record(
        await api("/api/receipt/challenge?deployment=" + selected, {
          planId,
          buyerAccount,
        }),
      );
      const challenge = parseChallenge(result.challenge);
      if (
        !sameAddress(challenge.buyer, signer) ||
        (await wallet.getChainId()) !== challenge.chainId
      )
        throw Error("Connect the named buyer on the deployment network");
      const signature = await wallet.signMessage({
        account: signer,
        message: receiptMessage(challenge),
      });
      await api("/api/receipt/confirm?deployment=" + selected, {
        challenge,
        signature,
      });
      setNotice(
        "Buyer-signed delivery receipt recorded. Cash and debt are unchanged.",
      );
      refresh();
    });
  const navigation: Screen[] = [
    "Account",
    "Operations",
    "Operation detail",
    "Funding",
    "Books",
    "Evidence",
  ];
  const txList = intents.filter((i) => i.deployment === selected);
  return (
    <div className="business-app">
      <header className="topbar">
        <div>
          <div className="eyebrow">ARC BUSINESS ACCOUNT</div>
          <h1>Business, settled.</h1>
        </div>
        <div className="wallet-control">
          {isConnected ? (
            <>
              <span className="address" title={signer}>
                {signer ? short(signer) : "Wallet connected"}
              </span>
              <button onClick={() => disconnect()}>Disconnect</button>
            </>
          ) : (
            <button
              className="primary"
              onClick={() => {
                const connector = connectors[0];
                if (connector) connect({ connector });
                else setError("No injected browser wallet was found.");
              }}
            >
              Connect wallet
            </button>
          )}
        </div>
      </header>
      <div className="statusbar">
        <span className="status-dot" />
        <strong>
          {manifest
            ? networkSettings(manifest.environment).label
            : "No deployment configured"}
        </strong>
        <span>
          {manifest
            ? `Chain ${manifest.chainId}`
            : "Contract verified locally; no Arc deployment"}
        </span>
        {deployment && (
          <button onClick={() => void refresh()} disabled={loading || busy}>
            {loading ? "Refreshing…" : "Refresh state"}
          </button>
        )}
      </div>
      {deployments.length > 1 && (
        <label className="field deployment-picker">
          Deployment
          <select
            value={selected}
            onChange={(e) => {
              setBooks(null);
              setLive(null);
              setLoading(true);
              setSelected(e.target.value);
              setReview(null);
            }}
          >
            {deployments.map((d) => (
              <option key={d.manifest.instanceId} value={d.manifest.instanceId}>
                {d.manifest.opening.fixtureVersion} ·{" "}
                {short(d.manifest.kernelAddress)}
              </option>
            ))}
          </select>
        </label>
      )}
      <nav aria-label="Business account screens">
        {navigation.map((tab) => (
          <button
            key={tab}
            className={screen === tab ? "active" : ""}
            aria-current={screen === tab ? "page" : undefined}
            onClick={() => setScreen(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>
      <main>
        <div aria-live="polite">
          {loading && (
            <p className="notice">Loading confirmed account state…</p>
          )}
          {(error || connectError) && (
            <p role="alert" className="error">
              {error || connectError?.message}
            </p>
          )}
          {notice && <p className="notice">{notice}</p>}
          {books?.syncError && (
            <p className="error">Books need attention: {books.syncError}</p>
          )}
        </div>
        {!manifest && (
          <section className="empty-state">
            <div className="eyebrow">READY FOR THE NEXT REHEARSAL</div>
            <h2>Connect verified settlement before moving funds.</h2>
            <p>
              The wallet and accounting application requires a verified
              deployment and its opening checkpoint. No account balance, payment
              or delivery is assumed here.
            </p>
            <div className="empty-facts">
              <span>
                Verified kernel
                <br />
                <strong>
                  {RELEASE_ID.runtimeBytes.toLocaleString()} runtime bytes
                </strong>
              </span>
              <span>
                Supported environments
                <br />
                <strong>Local test chain · Arc Testnet</strong>
              </span>
            </div>
          </section>
        )}
        {screen === "Account" && (
          <>
            <section className="section-heading">
              <div>
                <div className="eyebrow">FUNDED CLAIMS</div>
                <h2>Your business account</h2>
                <p>
                  Protected cash and reservations are part of the funded claim.
                </p>
              </div>
              {books && (
                <label className="field">
                  View account
                  <select
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                  >
                    {books.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.entity} · #{a.id}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </section>
            {account ? (
              <>
                <div className="metrics">
                  <Metric label="Funded claim" value={money(account.cash)} />
                  <Metric
                    label="Available cash"
                    value={money(account.availableCash)}
                    accent
                  />
                  <Metric label="Protected cash" value={money(account.floor)} />
                  <Metric
                    label="Reserved cash"
                    value={money(account.aggregateHeld)}
                  />
                </div>
                <div className="split">
                  <section className="panel">
                    <h3>Account actions</h3>
                    <p className="hint">
                      Owner:{" "}
                      <span className="address">{accountInfo?.owner}</span>
                    </p>
                    {act(forms.depositCash, ownBlocked, { accountId }, [
                      "accountId",
                    ])}
                    {act(
                      forms.withdrawCash,
                      ownBlocked,
                      { accountId, to: signer ?? "" },
                      ["accountId"],
                    )}
                    {act(
                      forms.setProtectedFloor,
                      ownBlocked,
                      { accountId, amount: money(account.floor) },
                      ["accountId"],
                    )}
                    {act(
                      forms.recordOpeningCheckpoint,
                      ownBlocked,
                      { accountId },
                      ["accountId"],
                    )}
                  </section>
                  <section className="panel">
                    <h3>Borrowing and custody</h3>
                    <dl>
                      <dt>Outstanding principal</dt>
                      <dd>{money(account.outstandingPrincipal)} USDC</dd>
                      <dt>Active reservations</dt>
                      <dd>{account.activePlanCount.toString()}</dd>
                      <dt>Physical kernel USDC</dt>
                      <dd>{live ? money(live.custody) : "—"}</dd>
                      <dt>Unallocated surplus</dt>
                      <dd>{live ? money(live.surplus) : "—"}</dd>
                    </dl>
                    <p className="hint">
                      Surplus is a reconciliation exception. It cannot be
                      assigned or spent through these account actions.
                    </p>
                  </section>
                </div>
              </>
            ) : (
              <p className="hint">
                {manifest
                  ? "No business account has been indexed for this deployment."
                  : "Account reads will appear after deployment is configured."}
              </p>
            )}
            {act(
              forms.openAccount,
              blocked ??
                (live?.signerAccount
                  ? "This wallet already has an account."
                  : null),
            )}
            <Allowance
              value={allowance}
              setValue={setAllowance}
              blocked={blocked}
              approve={() => {
                try {
                  if (!manifest) throw Error("No deployment");
                  const amount = parseMoney(allowance);
                  setReview({
                    title: "Approve exact USDC allowance",
                    to: manifest.usdcAddress,
                    data: approvalData(manifest.kernelAddress, amount),
                    rows: [
                      { label: "Spender", value: manifest.kernelAddress },
                      { label: "Allowance (USDC)", value: money(amount) },
                    ],
                  });
                } catch (e) {
                  setError(fail(e));
                }
              }}
            />
          </>
        )}
        {screen === "Operations" && (
          <>
            <section className="section-heading">
              <div>
                <div className="eyebrow">IMMUTABLE TERMS</div>
                <h2>Operations</h2>
                <p>
                  Draft terms, obtain each party’s approval, then reserve and
                  settle.
                </p>
              </div>
            </section>
            <div className="operation-list">
              {books?.plans.map((p) => (
                <button
                  className="operation-row"
                  key={p.id}
                  onClick={() => {
                    setPlanId(p.id);
                    setScreen("Operation detail");
                  }}
                >
                  <span className="operation-id">#{p.id}</span>
                  <span>
                    <strong>
                      {p.terms.kind === 1 ? "Customer order" : "Group purchase"}
                    </strong>
                    <small>
                      {p.terms.offerRefs[0]?.quantity.toString()} goods units ·{" "}
                      {short(p.termsHash)}
                    </small>
                  </span>
                  <span className="pill">
                    {live?.plans.find((x) => x.id === p.id)?.status ?? p.status}
                  </span>
                  <span>→</span>
                </button>
              ))}
              {!books?.plans.length && (
                <p className="hint">No confirmed operations yet.</p>
              )}
            </div>
            <div className="split">
              <section className="panel">
                <h3>New operation</h3>
                <DraftForm kind={1} blocked={blocked} review={requestReview} />
                <DraftForm kind={0} blocked={blocked} review={requestReview} />
              </section>
              <section className="panel">
                <h3>Supplier offers</h3>
                {books?.offers.map((o) => (
                  <div className="compact-row" key={o.id}>
                    <strong>Offer #{o.id}</strong>
                    <span>
                      {money(o.price)} USDC / unit · {o.minimumFill.toString()}{" "}
                      minimum
                    </span>
                    <small className="address">Payee {o.payee}</small>
                  </div>
                ))}
                {act(forms.createOffer, blocked, { to: signer ?? "" })}
                {act(forms.revokeOffer, blocked)}
              </section>
            </div>
          </>
        )}
        {screen === "Operation detail" && (
          <>
            <section className="section-heading">
              <div>
                <div className="eyebrow">PARTIES & PERFORMANCE</div>
                <h2>
                  {plan
                    ? `${plan.terms.kind === 1 ? "Customer order" : "Group purchase"} #${plan.id}`
                    : "Choose an operation"}
                </h2>
              </div>
              {books && (
                <label className="field">
                  Operation
                  <select
                    value={planId}
                    onChange={(e) => {
                      setPlanId(e.target.value);
                      setReview(null);
                    }}
                  >
                    <option value="">Select operation</option>
                    {books.plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        #{p.id} ·{" "}
                        {p.terms.kind === 1
                          ? "Customer order"
                          : "Group purchase"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </section>
            {plan && planLive ? (
              <>
                <div className="readiness">
                  <span className="pill">{planLive.status}</span>
                  <strong>
                    {planLive.statusCode === 0
                      ? planLive.ready
                        ? "Ready for financial close"
                        : planLive.blockedReason
                      : planLive.statusCode === 1
                        ? "Financial close confirmed"
                        : "Reservations released"}
                  </strong>
                </div>
                <div className="split">
                  <section className="panel">
                    <h3>Fixed funding and payouts</h3>
                    <dl>
                      <dt>Terms hash</dt>
                      <dd className="address">{plan.termsHash}</dd>
                      <dt>Expires</dt>
                      <dd>
                        {new Date(
                          Number(plan.terms.expiry) * 1000,
                        ).toLocaleString()}
                      </dd>
                      {plan.terms.offerRefs.map((r, i) => (
                        <React.Fragment key={r.offerId.toString()}>
                          <dt>{i === 0 ? "Goods" : "Freight"} allocation</dt>
                          <dd>
                            {r.quantity.toString()} units ·{" "}
                            {money(
                              r.quantity *
                                (books?.offers.find(
                                  (o) => o.id === r.offerId.toString(),
                                )?.price ?? 0n),
                            )}{" "}
                            USDC
                            <br />
                            <small className="address">{r.payee}</small>
                          </dd>
                        </React.Fragment>
                      ))}
                      {plan.terms.kind === 1 ? (
                        <>
                          <dt>Merchant own cash</dt>
                          <dd>
                            {money(plan.terms.saleParty.merchantCash)} USDC
                          </dd>
                          <dt>Credit draw</dt>
                          <dd>{money(plan.terms.saleParty.creditDraw)} USDC</dd>
                          <dt>Required escrow</dt>
                          <dd>
                            {money(plan.terms.saleParty.requiredEscrow)} USDC
                          </dd>
                          <dt>Recognized receivable</dt>
                          <dd>
                            {money(planLive.sales.recognizedReceivable)} USDC
                          </dd>
                          <dt>Expected balance before acceptance</dt>
                          <dd>
                            {planLive.sales.accepted
                              ? "Accepted"
                              : money(
                                  plan.terms.saleParty.saleValue -
                                    plan.terms.saleParty.requiredEscrow,
                                ) + " USDC"}
                          </dd>
                        </>
                      ) : (
                        plan.terms.buyers.map((b, i) => (
                          <React.Fragment key={b.accountId.toString()}>
                            <dt>
                              Buyer {i + 1} · account #{b.accountId.toString()}
                            </dt>
                            <dd>
                              {b.quantity.toString()} units · own{" "}
                              {money(b.ownCash)} + credit {money(b.creditDraw)}{" "}
                              USDC
                              <br />
                              <small className="address">{b.owner}</small>
                            </dd>
                          </React.Fragment>
                        ))
                      )}
                    </dl>
                  </section>
                  <section className="panel">
                    <h3>Authorized actions</h3>
                    <p className="hint">
                      The connected signer determines permissions. Viewing
                      another account does not grant its authority.
                    </p>
                    {plan.terms.kind === 1 ? (
                      <>
                        {[
                          forms.joinMerchant,
                          forms.leaveMerchant,
                          forms.acknowledgeGoods,
                          forms.acknowledgeFreight,
                        ].map((a) =>
                          act(
                            a,
                            blocked ??
                              (!signer ||
                              !sameAddress(
                                signer,
                                plan.terms.saleParty.merchantOwner,
                              )
                                ? "Connect the named merchant wallet."
                                : null),
                            { planId },
                            ["planId"],
                          ),
                        )}
                        {[
                          forms.fundCustomerEscrow,
                          forms.withdrawCustomerEscrow,
                          forms.acceptSalesOrder,
                          forms.collectSalesBalance,
                        ].map((a) =>
                          act(
                            a,
                            blocked ??
                              (!signer ||
                              !sameAddress(
                                signer,
                                plan.terms.saleParty.customerAddress,
                              )
                                ? "Connect the named customer wallet."
                                : null),
                            { planId },
                            ["planId"],
                          ),
                        )}
                      </>
                    ) : (
                      plan.terms.buyers.map((b, i) => (
                        <div key={b.accountId.toString()}>
                          <h4>Buyer {i + 1}</h4>
                          {[forms.joinBuyer, forms.leaveBuyer].map((a) =>
                            act(
                              a,
                              blocked ??
                                (!signer || !sameAddress(signer, b.owner)
                                  ? "Connect this buyer wallet."
                                  : null),
                              { planId, index: i.toString() },
                              ["planId", "index"],
                            ),
                          )}
                          <button
                            disabled={
                              !!blocked ||
                              !signer ||
                              !sameAddress(signer, b.owner) ||
                              planLive.statusCode !== 1
                            }
                            onClick={() =>
                              void signedReceipt(b.accountId.toString())
                            }
                          >
                            Sign goods receipt for {b.quantity.toString()} units
                          </button>
                        </div>
                      ))
                    )}
                    {act(
                      forms.approveLenderPlan,
                      lenderBlocked,
                      { planId, index: "0" },
                      ["planId"],
                    )}
                    {act(
                      forms.revokeLenderApproval,
                      lenderBlocked,
                      { planId, index: "0" },
                      ["planId"],
                    )}
                    {plan.terms.offerRefs.map((r, i) => {
                      const offer = books?.offers.find(
                          (o) => o.id === r.offerId.toString(),
                        ),
                        reason =
                          blocked ??
                          (!signer ||
                          !offer ||
                          !sameAddress(signer, offer.owner)
                            ? "Connect the owner of this supplier offer."
                            : null);
                      return (
                        <div key={i}>
                          <h4>
                            {i === 0 ? "Goods supplier" : "Freight provider"}
                          </h4>
                          {act(
                            forms.approveSupplierPlan,
                            reason,
                            {
                              planId,
                              index: i.toString(),
                              quantity: r.quantity.toString(),
                            },
                            ["planId", "index", "quantity"],
                          )}
                          {act(
                            forms.revokeOfferApproval,
                            reason,
                            { planId, index: i.toString() },
                            ["planId", "index"],
                          )}
                        </div>
                      );
                    })}
                    {act(
                      forms.commitPlan,
                      blocked ??
                        (!planLive.ready
                          ? "The operation is not ready. Resolve the reason above."
                          : null),
                      { planId },
                      ["planId"],
                    )}
                    {act(
                      forms.cancelPlan,
                      blocked ??
                        (planLive.statusCode !== 0
                          ? "Only an open operation can be cancelled."
                          : null),
                      { planId },
                      ["planId"],
                    )}
                    {act(forms.releaseExpiredPlan, blocked, { planId }, [
                      "planId",
                    ])}
                    <Allowance
                      value={allowance}
                      setValue={setAllowance}
                      blocked={blocked}
                      approve={() => {
                        try {
                          if (!manifest) throw Error("No deployment");
                          const amount = parseMoney(allowance);
                          setReview({
                            title: "Approve exact USDC allowance",
                            to: manifest.usdcAddress,
                            data: approvalData(manifest.kernelAddress, amount),
                            rows: [
                              {
                                label: "Allowance (USDC)",
                                value: money(amount),
                              },
                              {
                                label: "Spender",
                                value: manifest.kernelAddress,
                              },
                            ],
                          });
                        } catch (e) {
                          setError(fail(e));
                        }
                      }}
                    />
                  </section>
                </div>
                <section className="panel">
                  <h3>Current reservations and approvals</h3>
                  <p className="hint">
                    Read together at block {live?.block.toString()}. Expired
                    approvals cannot authorize financial close.
                  </p>
                  {planLive.participants.map((p) => (
                    <div className="compact-row" key={p.accountId.toString()}>
                      <strong>
                        Account #{p.accountId.toString()} ·{" "}
                        {p.joined ? "Joined" : "Not joined"}
                      </strong>
                      <span>
                        Cash held {money(p.cashHeld)} · credit reserved{" "}
                        {money(p.creditReserved)} USDC
                      </span>
                      <span>
                        Lender approved {money(p.approvedDraw)} USDC ·{" "}
                        {p.approvalExpiry === 0n
                          ? "No approval"
                          : new Date(
                              Number(p.approvalExpiry) * 1000,
                            ).toLocaleString()}
                        {live &&
                        p.approvalExpiry > 0n &&
                        p.approvalExpiry < live.timestamp
                          ? " · Expired"
                          : ""}
                      </span>
                    </div>
                  ))}
                  {planLive.supplierApprovals.map((p) => (
                    <div className="compact-row" key={p.offerId.toString()}>
                      <strong>Offer #{p.offerId.toString()}</strong>
                      <span>
                        {p.approvedQuantity.toString()} units approved ·{" "}
                        {p.approvalExpiry === 0n
                          ? "No approval"
                          : new Date(
                              Number(p.approvalExpiry) * 1000,
                            ).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </section>
                <section className="panel">
                  <h3>Confirmed accounting timeline</h3>
                  {books?.journals
                    .filter((j) => j.plan === planId)
                    .filter(
                      (j, i, all) =>
                        all.findIndex((x) => x.source === j.source) === i,
                    )
                    .map((j) => (
                      <div className="timeline-row" key={j.source}>
                        <span>
                          {new Date(j.timestamp * 1000).toLocaleString()}
                        </span>
                        <strong>{j.kind}</strong>
                        <small className="address">{j.source}</small>
                      </div>
                    ))}
                </section>
              </>
            ) : (
              <p className="hint">
                Select a confirmed operation from the Operations screen.
              </p>
            )}
          </>
        )}
        {screen === "Funding" && (
          <>
            <section className="section-heading">
              <div>
                <div className="eyebrow">FUNDED CREDIT</div>
                <h2>Funding and repayments</h2>
                <p>
                  Reservations remain undrawn. Principal begins at financial
                  close.
                </p>
              </div>
            </section>
            {live && (
              <div className="metrics">
                <Metric
                  label="Lender funded claim"
                  value={money(live.pool.cash)}
                />
                <Metric
                  label="Reserved lending"
                  value={money(live.pool.reserved)}
                />
                <Metric
                  label="Available to lend"
                  value={money(live.pool.available)}
                  accent
                />
              </div>
            )}
            <div className="split">
              <section className="panel">
                <h3>Lender controls</h3>
                {act(forms.depositPool, lenderBlocked)}
                <Allowance
                  value={allowance}
                  setValue={setAllowance}
                  blocked={lenderBlocked}
                  approve={() => {
                    try {
                      if (!manifest) throw Error("No deployment");
                      const amount = parseMoney(allowance);
                      setReview({
                        title: "Approve exact USDC allowance",
                        to: manifest.usdcAddress,
                        data: approvalData(manifest.kernelAddress, amount),
                        rows: [
                          { label: "Allowance (USDC)", value: money(amount) },
                          { label: "Spender", value: manifest.kernelAddress },
                        ],
                      });
                    } catch (e) {
                      setError(fail(e));
                    }
                  }}
                />
                {act(forms.withdrawPool, lenderBlocked, { to: signer ?? "" })}
                {act(forms.setBorrowerLimit, lenderBlocked, { accountId })}
              </section>
              <section className="panel">
                <h3>Principal by borrower</h3>
                {books?.loans.map((l) => (
                  <div className="compact-row" key={l.id}>
                    <strong>
                      Loan #{l.id} · account #{l.borrower}
                    </strong>
                    <span>{money(l.outstanding)} USDC outstanding</span>
                    {act(
                      forms.repayLoan,
                      blocked ??
                        (!signer ||
                        !books.accounts.some(
                          (a) =>
                            a.id === l.borrower && sameAddress(a.owner, signer),
                        )
                          ? "Connect the borrower account owner."
                          : null),
                      { loanId: l.id, amount: money(l.outstanding) },
                      ["loanId"],
                    )}
                  </div>
                ))}
                {!books?.loans.length && (
                  <p className="hint">No funded principal has been indexed.</p>
                )}
              </section>
            </div>
            <section className="panel">
              <h3>Opening receivables</h3>
              <p className="hint">
                Collections increase the buyer’s funded claim. Repayment
                requires a separate borrower transaction. Registration must
                match the retained opening books.
              </p>
              {act(forms.registerReceivable, ownBlocked, { accountId }, [
                "accountId",
              ])}
              {act(forms.collectReceivable, blocked)}
            </section>
          </>
        )}
        {screen === "Books" && (
          <>
            <section className="section-heading">
              <div>
                <div className="eyebrow">SOURCE-BOUND JOURNALS</div>
                <h2>Books</h2>
                <p>
                  Six-decimal USDC books, with native gas evidence kept
                  separately.
                </p>
              </div>
              {books && (
                <label className="field">
                  Entity
                  <select
                    value={entity}
                    onChange={(e) => setEntity(e.target.value)}
                  >
                    <option value="">All entities</option>
                    {[...new Set(books.balances.map((b) => b.entity))]
                      .sort()
                      .map((e) => (
                        <option key={e}>{e}</option>
                      ))}
                  </select>
                </label>
              )}
            </section>
            {books ? (
              <>
                <div className="readiness">
                  <strong>Books through block {books.height}</strong>
                  <span>
                    {live
                      ? `Chain read at ${live.block}; ${live.block - BigInt(books.height)} blocks ahead`
                      : "Chain read unavailable"}
                  </span>
                  <span>
                    Rule version 2 · immutable opening #
                    {manifest?.opening.block}
                  </span>
                </div>
                <div className="split">
                  <section className="panel">
                    <h3>Account balances</h3>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Entity / account</th>
                            <th>Debit balance (USDC)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {books.balances
                            .filter((b) => !entity || b.entity === entity)
                            .map((b) => (
                              <tr key={b.entity + b.account}>
                                <td>
                                  <small>{b.entity}</small>
                                  <br />
                                  {b.account}
                                </td>
                                <td className="number">{money(b.amount)}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                  <section className="panel">
                    <h3>Recovery and reconciliation</h3>
                    <p>
                      Rebuild replays retained confirmed blocks and signed
                      receipts from the same immutable opening checkpoint. It
                      does not submit a transaction.
                    </p>
                    <p className="hint">
                      Rebuild is an operator command. The public application
                      cannot reset the ledger or relay chain writes.
                    </p>
                    {books.issues.length ? (
                      books.issues.map((i) => (
                        <p
                          className={i.blocking ? "error" : "notice"}
                          key={i.source}
                        >
                          {i.detail}
                        </p>
                      ))
                    ) : (
                      <p className="success">
                        No projection exceptions recorded.
                      </p>
                    )}
                    <h4>Separate gas evidence</h4>
                    {books.fees.slice(-8).map((f) => (
                      <div className="compact-row" key={f.tx}>
                        <span>
                          {f.amount} atomic {f.asset} units · {f.decimals}{" "}
                          decimals
                        </span>
                        <small className="address">{f.tx}</small>
                      </div>
                    ))}
                  </section>
                </div>
                <section className="panel">
                  <h3>Journal entries</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Source / event</th>
                          <th>Entity</th>
                          <th>Account</th>
                          <th>Debit</th>
                          <th>Credit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {books.journals
                          .filter((j) => !entity || j.entity === entity)
                          .map((j) => (
                            <tr key={j.id}>
                              <td>
                                {j.kind}
                                <br />
                                <small className="address" title={j.source}>
                                  {short(j.source)}
                                </small>
                              </td>
                              <td>{j.entity}</td>
                              <td>{j.account}</td>
                              <td className="number">
                                {j.side === "debit" ? money(j.amount) : ""}
                              </td>
                              <td className="number">
                                {j.side === "credit" ? money(j.amount) : ""}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            ) : (
              <p className="hint">
                A configured deployment and its opening checkpoint are required
                for books.
              </p>
            )}
          </>
        )}
        {screen === "Evidence" && (
          <>
            <section className="section-heading">
              <div>
                <div className="eyebrow">VERIFIABLE BOUNDARIES</div>
                <h2>Evidence</h2>
                <p>
                  Contract identity, deployment provenance and delivery
                  evidence.
                </p>
              </div>
            </section>
            <div className="split">
              <section className="panel">
                <h3>Verified contract artifact</h3>
                <dl>
                  <dt>Kernel source SHA-256</dt>
                  <dd className="address">{RELEASE_ID.sourceSha256}</dd>
                  <dt>Runtime</dt>
                  <dd>{RELEASE_ID.runtimeBytes} / 24,576 bytes</dd>
                  <dt>Compiler</dt>
                  <dd>
                    Solidity {RELEASE_ID.compiler} · release · optimizer{" "}
                    {RELEASE_ID.optimizerRuns} · via IR
                  </dd>
                  <dt>Normalized runtime hash</dt>
                  <dd className="address">
                    {RELEASE_ID.normalizedRuntimeHash}
                  </dd>
                </dl>
              </section>
              <section className="panel">
                <h3>Deployment provenance</h3>
                {manifest ? (
                  <dl>
                    <dt>Environment</dt>
                    <dd>{manifest.environment}</dd>
                    <dt>Kernel</dt>
                    <dd className="address">{manifest.kernelAddress}</dd>
                    <dt>Deployment transaction</dt>
                    <dd className="address">
                      {manifest.deploymentTransaction}
                    </dd>
                    <dt>Opening block / hash</dt>
                    <dd>
                      {manifest.opening.block}
                      <br />
                      <span className="address">{manifest.opening.hash}</span>
                    </dd>
                    <dt>Deployment instance</dt>
                    <dd className="address">{manifest.instanceId}</dd>
                  </dl>
                ) : (
                  <p>
                    No deployment is configured. Local contract and integration
                    checks do not establish Arc testnet or production execution.
                  </p>
                )}
              </section>
            </div>
            <section className="panel">
              <h3>Buyer-signed delivery receipts</h3>
              <p>
                These signatures record the buyer’s full goods allocation. They
                do not authorize payments or grant spending allowance.
              </p>
              {books?.receipts.length ? (
                books.receipts.map((r, i) => (
                  <details key={i}>
                    <summary>Retained signed receipt {i + 1}</summary>
                    <pre>{JSON.stringify(r, null, 2)}</pre>
                  </details>
                ))
              ) : (
                <p className="hint">
                  No signed group delivery evidence recorded.
                </p>
              )}
            </section>
          </>
        )}
        {txList.length > 0 && (
          <section className="panel transaction-panel">
            <h3>Saved wallet transactions</h3>
            <p className="hint">
              Recovery looks up the original signer, nonce, target and call. It
              never resends.
            </p>
            {txList.map((i) => (
              <div className="transaction-row" key={i.id}>
                <div>
                  <strong>{i.purpose}</strong>
                  <small>
                    {i.state.kind === "confirmed"
                      ? `Confirmed · books ${i.state.books}`
                      : i.state.kind}{" "}
                    · nonce {i.nonce}
                  </small>
                  {"hash" in i.state && (
                    <span className="address">{i.state.hash}</span>
                  )}
                </div>
                <button
                  disabled={busy || i.state.kind === "rejected"}
                  onClick={() => void recover(i)}
                >
                  Recover status
                </button>
              </div>
            ))}
          </section>
        )}
      </main>
      <footer>
        Amounts are actual USDC units. Local test-chain balances are test funds.
        Physical delivery and statutory reporting remain outside contract
        execution.
      </footer>
      {review && (
        <div className="dialog-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-title"
            className="review-dialog"
          >
            <h2 id="review-title">{review.title}</h2>
            <p>Review the exact call before opening your wallet.</p>
            <dl>
              <dt>Signer</dt>
              <dd className="address">{signer}</dd>
              <dt>Network</dt>
              <dd>
                {manifest?.environment} · {manifest?.chainId}
              </dd>
              <dt>Target</dt>
              <dd className="address">{review.to}</dd>
              {review.rows.map((r, i) => (
                <React.Fragment key={i}>
                  <dt>{r.label}</dt>
                  <dd className="address">{r.value}</dd>
                </React.Fragment>
              ))}
              {account && review.rows.some((row) => row.label === "Business account ID" && row.value === account.id) && (
                <>
                  <dt>Current protected / available cash</dt>
                  <dd>
                    {money(account.floor)} / {money(account.availableCash)} USDC
                  </dd>
                </>
              )}
            </dl>
            {review.title === "Commit financial close" && plan && (
              <p className="notice">
                This closes the immutable operation #{plan.id}, pays its
                approved suppliers, consumes its cash and escrow, and creates
                the approved principal. The exact funding and payee amounts are
                listed below.
              </p>
            )}
            {review.title === "Commit financial close" && plan && (
              <dl aria-label="Financial close amounts">
                <dt>Terms hash</dt>
                <dd className="address">{plan.termsHash}</dd>
                {plan.terms.kind === 1 ? (
                  <>
                    <dt>Merchant cash</dt>
                    <dd>{money(plan.terms.saleParty.merchantCash)} USDC</dd>
                    <dt>Merchant protected cash</dt>
                    <dd>{protectedCashFor(plan.terms.saleParty.merchantAccountId)}</dd>
                    <dt>New principal</dt>
                    <dd>{money(plan.terms.saleParty.creditDraw)} USDC</dd>
                    <dt>Customer escrow consumed</dt>
                    <dd>{money(plan.terms.saleParty.requiredEscrow)} USDC</dd>
                  </>
                ) : (
                  plan.terms.buyers.map((b) => (
                    <React.Fragment key={b.accountId.toString()}>
                      <dt>Buyer #{b.accountId.toString()}</dt>
                      <dd>
                        {money(b.ownCash)} cash + {money(b.creditDraw)} new
                        principal · {b.quantity.toString()} units
                      </dd>
                      <dt>Protected cash · buyer #{b.accountId.toString()}</dt>
                      <dd>{protectedCashFor(b.accountId)}</dd>
                    </React.Fragment>
                  ))
                )}
                {plan.terms.offerRefs.map((r) => (
                  <React.Fragment key={r.offerId.toString()}>
                    <dt>Payee · offer #{r.offerId.toString()}</dt>
                    <dd>
                      {money(
                        r.quantity *
                          (books?.offers.find(
                            (o) => o.id === r.offerId.toString(),
                          )?.price ?? 0n),
                      )}{" "}
                      USDC
                      <br />
                      <span className="address">{r.payee}</span>
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            )}
            <div className="dialog-actions">
              <button onClick={() => setReview(null)} disabled={busy}>
                Back
              </button>
              <button
                className="primary"
                onClick={() => void submit()}
                disabled={!!blocked}
              >
                {busy ? "Waiting for wallet…" : "Confirm in wallet"}
              </button>
            </div>
            {blocked && <p className="hint">{blocked}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className={"metric" + (accent ? " accent" : "")}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>USDC</small>
    </div>
  );
}
function Allowance({
  value,
  setValue,
  blocked,
  approve,
}: {
  value: string;
  setValue: (v: string) => void;
  blocked: string | null;
  approve: () => void;
}) {
  return (
    <details className="action-form">
      <summary>Approve exact token allowance</summary>
      <p className="hint">
        Allowance is a separate wallet transaction. It does not deposit, fund
        escrow, or settle a receivable.
      </p>
      <FieldInput
        field={{
          key: "allowance",
          label: "Exact allowance (USDC)",
          kind: "money",
        }}
        value={value}
        onChange={setValue}
      />
      <button disabled={!!blocked} onClick={approve}>
        Review allowance
      </button>
      {blocked && <p className="hint">{blocked}</p>}
    </details>
  );
}
