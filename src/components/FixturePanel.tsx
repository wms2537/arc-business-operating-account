/**
 * FixturePanel — shows computed demo amounts for both scenarios side by side.
 * All values are derived from the deterministic fixture functions (no fabrication).
 */
import React from 'react';
import { buildScenarioAFixture, buildScenarioBFixture } from '@/domain/fixtures';
import { displayUsdc } from '@/domain/money';
import { CheckCircle, Info } from 'lucide-react';

const glass = {
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    backdropFilter: 'blur(16px) saturate(160%)',
    WebkitBackdropFilter: 'blur(16px) saturate(160%)',
  } as React.CSSProperties,
};

function Row({ label, value, success }: { label: string; value: string; success?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b py-2 last:border-0" style={{ borderColor: 'var(--border)' }}>
      <span className="text-xs" style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="mono text-xs tabular-nums font-medium" style={{ color: success ? 'var(--success)' : 'var(--ink-2)' }}>
        {value}
      </span>
    </div>
  );
}

export function FixturePanel() {
  const a = buildScenarioAFixture();
  const b = buildScenarioBFixture();

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {/* Scenario A */}
      <div className="rounded-2xl p-5" style={glass.card}>
        <div className="mb-3 flex items-center gap-2">
          <CheckCircle className="size-4" style={{ color: 'var(--success)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
            Scenario A — Collective Purchase
          </span>
        </div>
        <p className="mb-4 text-xs leading-relaxed" style={{ color: 'var(--subtle)' }}>
          3 buyers, 1 lender, 100 units at 9 USDC each. All amounts on-chain are
          divided by 1000.
        </p>

        <Row label="Supplier price/unit" value={displayUsdc(a.supplierUnitPrice)} />
        <Row label="Supplier payment (commit)" value={displayUsdc(a.supplierPayment)} success />
        <Row label="A+B cash hold" value={displayUsdc(a.abJoin_cashHold)} />
        <Row label="A+B credit hold" value={displayUsdc(a.abJoin_creditHold)} />
        <Row label="All joined own hold" value={displayUsdc(a.allJoined_ownHold)} />
        <Row label="All joined credit hold" value={displayUsdc(a.allJoined_creditHold)} />
        <Row label="Debt on reserve" value={displayUsdc(a.abJoin_debt)} />
        <Row label="Buyer cash after commit" value={displayUsdc(a.buyerCashAfterCommit)} />
        <Row label="Lender cash after commit" value={displayUsdc(a.lenderCashAfterCommit)} />
        <Row label="Principal A" value={displayUsdc(a.principalA)} />
        <Row label="Principal B" value={displayUsdc(a.principalB)} />
        <Row label="Principal C" value={displayUsdc(a.principalC)} />
        <Row label="Global cash (final)" value={displayUsdc(a.globalCash)} success />
      </div>

      {/* Scenario B */}
      <div className="rounded-2xl p-5" style={glass.card}>
        <div className="mb-3 flex items-center gap-2">
          <CheckCircle className="size-4" style={{ color: 'var(--success)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
            Scenario B — Customer Order
          </span>
        </div>
        <p className="mb-4 text-xs leading-relaxed" style={{ color: 'var(--subtle)' }}>
          Merchant + customer escrow + lender credit. Payouts, inventory, sale recognition,
          receivable collection.
        </p>

        <Row label="Sale amount" value={displayUsdc(b.saleAmount)} />
        <Row label="Supplier cost (100 × 60)" value={displayUsdc(b.supplierCost)} />
        <Row label="Freight" value={displayUsdc(b.freightCost)} />
        <Row label="Customer escrow" value={displayUsdc(b.customerEscrow)} />
        <Row label="Merchant reservation" value={displayUsdc(b.merchantCashReservation)} />
        <Row label="Lender reservation" value={displayUsdc(b.lenderReservation)} />
        <Row label="Supplier payout (commit)" value={displayUsdc(b.supplierPayment)} success />
        <Row label="Freight payout (commit)" value={displayUsdc(b.freightPayment)} success />
        <Row label="Merchant debt created" value={displayUsdc(b.merchantDebt)} />
        <Row label="Merchant protected cash" value={displayUsdc(b.merchantCashPreserved)} />
        <Row label="Inventory recognized" value={displayUsdc(b.inventoryRecognized)} />
        <Row label="Receivable created" value={displayUsdc(b.receivableCreated)} />
        <Row label="Final merchant cash" value={displayUsdc(b.finalMerchantCash)} success />
        <Row label="Final lender balance" value={displayUsdc(b.finalLenderBalance)} />
        <Row label="Final principal" value={displayUsdc(b.finalPrincipal)} />
        <Row label="Global cash (final)" value={displayUsdc(b.globalFinalCash)} success />
      </div>

      {/* Scale note */}
      <div className="col-span-1 md:col-span-2 flex items-start gap-2 rounded-xl px-4 py-3"
        style={{ background: 'rgba(172,198,233,0.09)', border: '1px solid rgba(172,198,233,0.18)' }}
      >
        <Info className="mt-0.5 size-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
        <p className="text-xs leading-relaxed" style={{ color: 'var(--subtle)' }}>
          <strong style={{ color: 'var(--accent)' }}>Demo scale:</strong> All monetary amounts are
          divided by 1000 for on-chain testing (quantities and IDs unchanged). Scenario A supplier
          payout is 0.900000 USDC; Scenario B payouts are 6.000000 and 0.500000 USDC.
          Values above are the actual on-chain demo amounts, derived deterministically from
          the canonical fixture definitions.
        </p>
      </div>
    </div>
  );
}
