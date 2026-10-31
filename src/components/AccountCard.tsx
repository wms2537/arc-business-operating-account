/**
 * AccountCard — displays a single kernel logical account's state.
 * Balances are actual on-chain amounts read from the kernel.
 * Simulated values are never shown.
 */
import { Shield, Lock, TrendingDown, Layers } from 'lucide-react';
import { formatMoneyFixed } from '@/domain/money';

interface AccountCardProps {
  label: string;
  accountId: bigint | null;
  availableCash: bigint;
  totalHeld: bigint;
  protectedFloor: bigint;
  totalDebt: bigint;
  fundedCredit: bigint;
  isLoading?: boolean;
  note?: string;
}

const glass = {
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    backdropFilter: 'blur(16px) saturate(160%)',
    WebkitBackdropFilter: 'blur(16px) saturate(160%)',
  } as React.CSSProperties,
  inner: {
    background: 'var(--surface-muted)',
    border: '1px solid var(--border)',
    borderRadius: '10px',
  } as React.CSSProperties,
};

function fmt(v: bigint) {
  return formatMoneyFixed(v, 6);
}

import React from 'react';

export function AccountCard({
  label,
  accountId,
  availableCash,
  totalHeld,
  protectedFloor,
  totalDebt,
  fundedCredit,
  isLoading,
  note,
}: AccountCardProps) {
  return (
    <div className="rounded-2xl p-5" style={glass.card}>
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div
            className="text-xs font-semibold uppercase tracking-widest"
            style={{ color: 'var(--subtle)' }}
          >
            {label}
          </div>
          {accountId != null && (
            <div className="mono mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
              Account #{accountId.toString()}
            </div>
          )}
        </div>
        {note && (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ background: 'rgba(172,198,233,0.18)', color: 'var(--accent)' }}
          >
            {note}
          </span>
        )}
      </div>

      {/* Hero amount */}
      <div className="mb-4">
        <div className="text-xs" style={{ color: 'var(--subtle)' }}>
          Available USDC
        </div>
        <div className="display mt-1 text-3xl font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
          {isLoading ? (
            <span className="inline-block h-8 w-36 animate-pulse rounded-lg bg-white/10" />
          ) : (
            fmt(availableCash)
          )}
        </div>
      </div>

      {/* Detail rows */}
      <div className="space-y-2">
        <DetailRow
          icon={<Lock className="size-3.5" />}
          label="Held (reserved)"
          value={totalHeld}
          color="var(--warn)"
          isLoading={isLoading}
        />
        <DetailRow
          icon={<Shield className="size-3.5" />}
          label="Protected floor"
          value={protectedFloor}
          color="var(--muted)"
          isLoading={isLoading}
        />
        <DetailRow
          icon={<TrendingDown className="size-3.5" />}
          label="Outstanding debt"
          value={totalDebt}
          color={totalDebt > 0n ? 'var(--danger)' : 'var(--muted)'}
          isLoading={isLoading}
        />
        {fundedCredit > 0n && (
          <DetailRow
            icon={<Layers className="size-3.5" />}
            label="Funded credit pool"
            value={fundedCredit}
            color="var(--success)"
            isLoading={isLoading}
          />
        )}
      </div>
    </div>
  );
}

function DetailRow({
  icon,
  label,
  value,
  color,
  isLoading,
}: {
  icon: React.ReactNode;
  label: string;
  value: bigint;
  color: string;
  isLoading?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.04)' }}>
      <div className="flex items-center gap-2" style={{ color: 'var(--subtle)' }}>
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <span className="mono text-xs tabular-nums" style={{ color }}>
        {isLoading ? (
          <span className="inline-block h-3.5 w-20 animate-pulse rounded bg-white/10" />
        ) : (
          fmt(value) + ' USDC'
        )}
      </span>
    </div>
  );
}
