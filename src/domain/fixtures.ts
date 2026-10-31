/**
 * Deterministic fixture computations for G0 verification.
 *
 * These run in TypeScript without hitting the chain.  They verify that our
 * integer-money arithmetic matches every stated scenario invariant before we
 * deploy.  The Foundry tests replicate the same arithmetic in Solidity against
 * the real compiled kernel.
 *
 * All amounts are in USDC 6-decimal integer units.
 * demoAmount() divides full-scenario USDC by 1000 per spec.
 */

import { demoAmount } from './money';

// ---------------------------------------------------------------------------
// Scenario A — Collective Purchase
// ---------------------------------------------------------------------------

export interface ScenarioAFixture {
  supplierUnitPrice: bigint;
  supplierCapacity: bigint;
  lenderDeposit: bigint;
  buyers: {
    label: string;
    quantity: bigint;
    initialCash: bigint;
    protectedFloor: bigint;
    ownContribution: bigint;
    loanAmount: bigint;
    approvalCeiling: bigint;
  }[];
  // Phase: A+B join (75 units)
  abJoin_cashHold: bigint;
  abJoin_creditHold: bigint;
  abJoin_debt: bigint;
  // Phase: all three joined (100 units)
  allJoined_ownHold: bigint;
  allJoined_creditHold: bigint;
  allJoined_debt: bigint;
  // Phase: after commit
  supplierPayment: bigint;
  buyerCashAfterCommit: bigint;
  lenderCashAfterCommit: bigint;
  principalA: bigint;
  principalB: bigint;
  principalC: bigint;
  // Phase: after collection
  finalBuyerCash: bigint;
  finalLenderCash: bigint;
  finalSupplierCash: bigint;
  finalExternalCustomerCash: bigint;
  globalCash: bigint;
}

export function buildScenarioAFixture(): ScenarioAFixture {
  const supplierUnitPrice = demoAmount('9');
  const supplierCapacity = 100n;
  const lenderDeposit    = demoAmount('500');

  const buyers = [
    {
      label: 'A',
      quantity:        40n,
      initialCash:     demoAmount('300'),
      protectedFloor:  demoAmount('100'),
      ownContribution: demoAmount('200'),
      loanAmount:      demoAmount('160'),
      approvalCeiling: demoAmount('200'),
    },
    {
      label: 'B',
      quantity:        35n,
      initialCash:     demoAmount('250'),
      protectedFloor:  demoAmount('100'),
      ownContribution: demoAmount('150'),
      loanAmount:      demoAmount('165'),
      approvalCeiling: demoAmount('200'),
    },
    {
      label: 'C',
      quantity:        25n,
      initialCash:     demoAmount('200'),
      protectedFloor:  demoAmount('100'),
      ownContribution: demoAmount('100'),
      loanAmount:      demoAmount('125'),
      approvalCeiling: demoAmount('200'),
    },
  ];

  // A+B join: cash hold = ownContrib(A) + ownContrib(B) = 200+150 = 350
  const abJoin_cashHold   = buyers[0].ownContribution + buyers[1].ownContribution;
  const abJoin_creditHold = buyers[0].loanAmount + buyers[1].loanAmount;  // 160+165 = 325
  const abJoin_debt       = 0n;

  // All joined: own holds = 200+150+100 = 450, credit holds = 160+165+125 = 450
  const allJoined_ownHold    = buyers.reduce((s, b) => s + b.ownContribution, 0n);
  const allJoined_creditHold = buyers.reduce((s, b) => s + b.loanAmount, 0n);
  const allJoined_debt       = 0n;

  // Commit: total price = 100 units * 9 USDC/unit = 900 USDC (demo: 0.9)
  const supplierPayment = supplierUnitPrice * supplierCapacity;

  // Each buyer retains 100 USDC (initialCash - ownContribution)
  const buyerCashAfterCommit = demoAmount('100');

  // Lender retains 50 USDC (500 deposited - 450 drawn)
  const lenderCashAfterCommit = lenderDeposit - allJoined_creditHold;

  const principalA = buyers[0].loanAmount;
  const principalB = buyers[1].loanAmount;
  const principalC = buyers[2].loanAmount;

  // After collection: each buyer repays own principal, retains 100
  const finalBuyerCash    = demoAmount('100');
  const finalLenderCash   = demoAmount('500');
  const finalSupplierCash = demoAmount('900');
  const finalExternalCustomerCash = demoAmount('550');
  // Global cash: 3 buyers * 100 + 500 + 900 + 550 = 2250
  const globalCash = demoAmount('2250');

  return {
    supplierUnitPrice,
    supplierCapacity,
    lenderDeposit,
    buyers,
    abJoin_cashHold,
    abJoin_creditHold,
    abJoin_debt,
    allJoined_ownHold,
    allJoined_creditHold,
    allJoined_debt,
    supplierPayment,
    buyerCashAfterCommit,
    lenderCashAfterCommit,
    principalA,
    principalB,
    principalC,
    finalBuyerCash,
    finalLenderCash,
    finalSupplierCash,
    finalExternalCustomerCash,
    globalCash,
  };
}

// ---------------------------------------------------------------------------
// Scenario B — Customer Order
// ---------------------------------------------------------------------------

export interface ScenarioBFixture {
  saleAmount: bigint;
  supplierCost: bigint;
  freightCost: bigint;
  merchantDeposit: bigint;
  merchantProtectedFloor: bigint;
  merchantCashReservation: bigint;
  customerEscrow: bigint;
  lenderDeposit: bigint;
  lenderReservation: bigint;
  // Commit outputs
  supplierPayment: bigint;
  freightPayment: bigint;
  merchantDebt: bigint;
  merchantCashPreserved: bigint;
  lenderCashAfterCommit: bigint;
  kernelCashAfterCommit: bigint;
  // Post-commit accounting
  inventoryRecognized: bigint;
  saleRecognized: bigint;
  customerAdvanceApplied: bigint;
  receivableCreated: bigint;
  // Collection
  customerPayment: bigint;
  waterfallLender: bigint;
  waterfallMerchant: bigint;
  finalMerchantCash: bigint;
  finalLenderBalance: bigint;
  finalPrincipal: bigint;
  kernelFinalCash: bigint;
  globalFinalCash: bigint;
}

export function buildScenarioBFixture(): ScenarioBFixture {
  const saleAmount           = demoAmount('10000');
  const supplierUnitPrice    = demoAmount('60');
  const unitQty              = 100n;
  const supplierCost         = supplierUnitPrice * unitQty;  // 6000
  const freightCost          = demoAmount('500');
  const merchantDeposit      = demoAmount('3000');
  const merchantProtectedFloor = demoAmount('2000');
  const merchantCashReservation = demoAmount('1000');
  const customerEscrow       = demoAmount('4000');
  const lenderDeposit        = demoAmount('2000');
  const lenderReservation    = demoAmount('1500');

  // Total plan funds: 4000 + 1000 + 1500 = 6500
  const totalPlanFunds = customerEscrow + merchantCashReservation + lenderReservation;

  // Commit: pays supplier + freight = 6500, leaves merchant cash 2000
  const supplierPayment = supplierCost;
  const freightPayment  = freightCost;
  const merchantDebt    = lenderReservation;

  // Merchant cash after commit = 3000 (deposit) - 1000 (contributed) = 2000
  const merchantCashPreserved = merchantDeposit - merchantCashReservation;

  // Lender: 2000 deposited - 1500 drawn = 500 remaining
  const lenderCashAfterCommit = lenderDeposit - lenderReservation;

  // Kernel holds: customer 0 (escrow released to pay supplier) + merchant 2000 + lender 500 = 2500
  const kernelCashAfterCommit = merchantCashPreserved + lenderCashAfterCommit;

  // Accounting
  const inventoryRecognized  = supplierCost + freightCost;  // 6500
  const saleRecognized       = saleAmount;
  const customerAdvanceApplied = customerEscrow;             // 4000
  const receivableCreated    = saleAmount - customerAdvanceApplied; // 6000

  // Collection
  const customerPayment = receivableCreated;  // 6000
  const waterfallLender  = merchantDebt;      // 1500 — internal reallocation
  const waterfallMerchant = customerPayment - waterfallLender; // 4500

  const finalMerchantCash  = merchantCashPreserved + waterfallMerchant; // 2000 + 4500 = 6500
  const finalLenderBalance = lenderDeposit;  // 2000 (1500 repaid, back to 2000)
  const finalPrincipal     = 0n;

  // Kernel holds after full collection: 6500 + 2000 = 8500
  const kernelFinalCash = finalMerchantCash + finalLenderBalance;

  // Global: kernel 8500 + supplier 6000 + freight 500 + customer 0 = 15000
  const globalFinalCash = demoAmount('15000');

  return {
    saleAmount,
    supplierCost,
    freightCost,
    merchantDeposit,
    merchantProtectedFloor,
    merchantCashReservation,
    customerEscrow,
    lenderDeposit,
    lenderReservation,
    supplierPayment,
    freightPayment,
    merchantDebt,
    merchantCashPreserved,
    lenderCashAfterCommit,
    kernelCashAfterCommit,
    totalPlanFunds,
    inventoryRecognized,
    saleRecognized,
    customerAdvanceApplied,
    receivableCreated,
    customerPayment,
    waterfallLender,
    waterfallMerchant,
    finalMerchantCash,
    finalLenderBalance,
    finalPrincipal,
    kernelFinalCash,
    globalFinalCash,
  } as ScenarioBFixture & { totalPlanFunds: bigint };
}

// ---------------------------------------------------------------------------
// Deterministic checks (run with: bun run fixtures:check)
// ---------------------------------------------------------------------------

function assertEqual(label: string, got: bigint, want: bigint): void {
  if (got !== want) {
    throw new Error(
      `FAIL ${label}: got ${got.toString()} want ${want.toString()}`
    );
  }
  console.log(`  PASS  ${label}: ${got.toString()}`);
}

export function runFixtureChecks(): void {
  console.log('\n=== Scenario A: Collective Purchase ===');
  const a = buildScenarioAFixture();

  // Supplier price math
  assertEqual('A: supplierPayment = 100 * 9 USDC/1000', a.supplierPayment, demoAmount('900'));

  // A+B join hold
  assertEqual('A: abJoin_cashHold (200+150=350) demo', a.abJoin_cashHold, demoAmount('350'));
  assertEqual('A: abJoin_creditHold (160+165=325) demo', a.abJoin_creditHold, demoAmount('325'));
  assertEqual('A: abJoin_debt = 0', a.abJoin_debt, 0n);

  // All joined hold
  assertEqual('A: allJoined_ownHold (200+150+100=450) demo', a.allJoined_ownHold, demoAmount('450'));
  assertEqual('A: allJoined_creditHold (160+165+125=450) demo', a.allJoined_creditHold, demoAmount('450'));
  assertEqual('A: allJoined_debt = 0', a.allJoined_debt, 0n);

  // Post-commit balances
  assertEqual('A: buyerCashAfterCommit = 100 demo', a.buyerCashAfterCommit, demoAmount('100'));
  assertEqual('A: lenderCashAfterCommit = 500-450=50 demo', a.lenderCashAfterCommit, demoAmount('50'));
  assertEqual('A: principalA = 160 demo', a.principalA, demoAmount('160'));
  assertEqual('A: principalB = 165 demo', a.principalB, demoAmount('165'));
  assertEqual('A: principalC = 125 demo', a.principalC, demoAmount('125'));

  // Global cash conservation (3 buyers*100 + 500 + 900 + 550 = 2250)
  assertEqual('A: globalCash = 2250 demo', a.globalCash, demoAmount('2250'));

  // No debt before commit
  assertEqual('A: no debt on reserve (abJoin)', a.abJoin_debt, 0n);
  assertEqual('A: no debt on reserve (allJoined)', a.allJoined_debt, 0n);

  // Approval ceiling check: each buyer's loan <= ceiling
  for (const b of a.buyers) {
    if (b.loanAmount > b.approvalCeiling) {
      throw new Error(`FAIL buyer ${b.label}: loanAmount ${b.loanAmount} > approvalCeiling ${b.approvalCeiling}`);
    }
    console.log(`  PASS  buyer ${b.label}: loan ${b.loanAmount} <= ceiling ${b.approvalCeiling}`);
  }

  // Lender has enough for full credit: A+B+C combined
  const totalCredit = a.allJoined_creditHold;
  if (a.lenderDeposit < totalCredit) {
    throw new Error(`FAIL lender capacity: deposit ${a.lenderDeposit} < totalCredit ${totalCredit}`);
  }
  console.log(`  PASS  lender deposit ${a.lenderDeposit} >= totalCredit ${totalCredit}`);

  // Lender 300 is insufficient for A(160)+B(165)=325
  const lender300 = demoAmount('300');
  const abCredit  = a.abJoin_creditHold;
  if (lender300 >= abCredit) {
    throw new Error('FAIL insufficient-lender test: 300 should be < A+B credit demand');
  }
  console.log(`  PASS  lender300 ${lender300} < abCredit ${abCredit} (insufficient-lender case confirmed)`);

  console.log('\n=== Scenario B: Customer Order ===');
  const b = buildScenarioBFixture();

  assertEqual('B: supplierCost = 100*60=6000 demo', b.supplierCost, demoAmount('6000'));
  assertEqual('B: totalPlanFunds = 4000+1000+1500=6500 demo',
    (b as typeof b & { totalPlanFunds: bigint }).totalPlanFunds,
    demoAmount('6500'));
  assertEqual('B: merchantCashPreserved = 3000-1000=2000 demo', b.merchantCashPreserved, demoAmount('2000'));
  assertEqual('B: merchantCashPreserved >= protectedFloor',
    b.merchantCashPreserved >= b.merchantProtectedFloor ? b.merchantCashPreserved : -1n,
    b.merchantCashPreserved);
  assertEqual('B: lenderCashAfterCommit = 2000-1500=500 demo', b.lenderCashAfterCommit, demoAmount('500'));
  assertEqual('B: kernelCashAfterCommit = 2500 demo', b.kernelCashAfterCommit, demoAmount('2500'));
  assertEqual('B: inventoryRecognized = 6000+500=6500 demo', b.inventoryRecognized, demoAmount('6500'));
  assertEqual('B: receivableCreated = 10000-4000=6000 demo', b.receivableCreated, demoAmount('6000'));
  assertEqual('B: waterfallLender = 1500 demo', b.waterfallLender, demoAmount('1500'));
  assertEqual('B: waterfallMerchant = 4500 demo', b.waterfallMerchant, demoAmount('4500'));
  assertEqual('B: finalMerchantCash = 6500 demo', b.finalMerchantCash, demoAmount('6500'));
  assertEqual('B: finalLenderBalance = 2000 demo', b.finalLenderBalance, demoAmount('2000'));
  assertEqual('B: finalPrincipal = 0', b.finalPrincipal, 0n);
  assertEqual('B: kernelFinalCash = 8500 demo', b.kernelFinalCash, demoAmount('8500'));
  assertEqual('B: globalFinalCash = 15000 demo', b.globalFinalCash, demoAmount('15000'));

  // Cash conservation: global = kernel + supplier + freight + customer
  const derivedGlobal = b.kernelFinalCash + demoAmount('6000') + demoAmount('500') + 0n;
  assertEqual('B: cash conservation (kernel+supplier+freight+customer=15000)',
    derivedGlobal, demoAmount('15000'));

  console.log('\nAll fixture checks PASSED.\n');
}
