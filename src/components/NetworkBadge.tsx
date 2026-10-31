import { useAccount } from 'wagmi';
import { arcTestnet } from 'viem/chains';

export function NetworkBadge() {
  const { isConnected, chainId } = useAccount();
  const mismatch = isConnected && chainId !== arcTestnet.id;
  const label = mismatch
    ? `Wallet network ${chainId ?? 'unknown'}: Arc Testnet required`
    : 'Arc Testnet prototype';

  return (
    <div className="rounded-full px-3 py-1 text-xs font-semibold" style={{
      background: mismatch ? 'rgba(232,109,122,0.18)' : 'rgba(172,198,233,0.15)',
      color: mismatch ? 'var(--danger)' : 'var(--accent)',
      border: '1px solid var(--border)',
    }}>
      {label}
    </div>
  );
}
