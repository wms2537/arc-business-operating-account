#!/usr/bin/env python3
"""Check specification arithmetic and illustrative journals, not production code.

No network, wallet, cryptographic authorization, Solidity or database is tested.
Amounts use integer token units. Every fixture runs at business and demo scales.
"""
import json
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = json.loads((ROOT / 'fixtures/scenarios.json').read_text())


def verify(scale):
    checks = []

    def ok(condition, label):
        if not condition:
            raise AssertionError(f'scale={scale}: {label}')
        checks.append(label)

    def units(value):
        exact = Decimal(str(value)) * Decimal(10 ** FIXTURES['erc20_decimals']) / Decimal(scale)
        if exact != exact.to_integral_value():
            raise AssertionError(f'not exactly representable: {value} at scale {scale}')
        return int(exact)

    journals = []
    balances = {}
    keys = set()

    def entry(entity, event, debits, credits):
        key = (entity, event, 'journal-rules-v1')
        ok(key not in keys, f'unique journal: {entity}/{event}')
        keys.add(key)
        ds = {name: units(value) for name, value in debits.items()}
        cs = {name: units(value) for name, value in credits.items()}
        ok(all(x >= 0 for x in list(ds.values()) + list(cs.values())), f'nonnegative journal: {entity}/{event}')
        ok(sum(ds.values()) == sum(cs.values()), f'balanced journal: {entity}/{event}')
        ledger = balances.setdefault(entity, {})
        for account, amount in ds.items():
            ledger[account] = ledger.get(account, 0) + amount
        for account, amount in cs.items():
            ledger[account] = ledger.get(account, 0) - amount
        journals.append({'entity': entity, 'event': event, 'debits': ds, 'credits': cs})

    s = FIXTURES['customer_order']
    m = units(s['merchant_initial_deposited_cash'])
    lender = units(s['lender_initial_deposited_cash'])
    customer = units(s['customer_initial_external_cash'])
    protected = units(s['merchant_protected_cash'])
    own = units(s['merchant_own_reservation'])
    credit = units(s['loan_principal'])
    supplier_pay = units(s['supplier_payout'])
    freight_pay = units(s['inbound_freight_payout'])
    escrow = supplier = freight = debt = 0
    kernel = m + lender
    total = units(s['expected']['global_cash'])
    checkpoints = []

    def sale_checkpoint(label):
        ok(kernel == m + lender + escrow, f'sale backing: {label}')
        ok(kernel + customer + supplier + freight == total, f'sale conservation: {label}')
        ok(m >= protected, f'sale protection: {label}')
        checkpoints.append({'label': label, 'kernel': kernel, 'merchant': m, 'lender': lender,
                            'customer_external': customer, 'customer_escrow': escrow,
                            'supplier': supplier, 'freight': freight, 'principal': debt})

    sale_checkpoint('opening')
    ok(kernel == units(s['expected']['kernel_before_customer_escrow']), 'sale initial kernel')
    escrow = units(s['customer_refundable_escrow'])
    customer -= escrow
    kernel += escrow
    sale_checkpoint('customer escrow funded')
    ok(kernel == units(s['expected']['kernel_after_customer_escrow']), 'sale escrow kernel')
    ok(m - protected - own == 0, 'sale own cash fully reserved without borrowing protected cash')
    ok(lender - credit == units('500'), 'sale lender unreserved liquidity')
    ok(debt == 0, 'sale reservation creates no principal')
    ok(own + credit + escrow == supplier_pay + freight_pay, 'sale sources equal uses')

    # Reference arithmetic only. Actual atomicity must be verified on contracts.
    m -= own
    lender -= credit
    debt += credit
    escrow = 0
    supplier += supplier_pay
    freight += freight_pay
    kernel -= supplier_pay + freight_pay
    sale_checkpoint('financial close')
    ok(kernel == units(s['expected']['kernel_after_close']), 'sale post-close kernel')
    ok(m == units(s['expected']['merchant_cash_after_close']), 'sale post-close merchant cash')
    ok(lender == units(s['expected']['lender_cash_after_close']), 'sale post-close lender cash')

    collection = units(s['remaining_customer_collection'])
    customer -= collection
    kernel += collection
    principal_repayment = min(collection, debt)
    lender += principal_repayment
    m += collection - principal_repayment
    debt -= principal_repayment
    sale_checkpoint('collection and authorized repayment')
    ok(kernel == units(s['expected']['kernel_after_collection']), 'sale terminal kernel')
    ok(m == units(s['expected']['merchant_terminal_cash']), 'sale terminal merchant cash')
    ok(lender == units(s['expected']['lender_terminal_cash']), 'sale terminal lender cash')
    ok(customer == 0 and debt == 0, 'sale customer balance and debt cleared')
    ok(supplier_pay == units(s['supplier_unit_price']) * s['supplier_quantity'], 'sale supplier quantity and unit price')

    entry('merchant', 'opening', {'Cash': '3000'}, {'Opening equity': '3000'})
    entry('lender', 'opening', {'Cash': '2000'}, {'Opening equity': '2000'})
    entry('customer', 'opening', {'Cash': '10000'}, {'Opening equity': '10000'})
    entry('customer', 'escrow-funded', {'Refundable escrow': '4000'}, {'Cash': '4000'})
    entry('merchant', 'financial-close', {'Supplier prepayment': '6000', 'Freight prepayment': '500'},
          {'Cash': '1000', 'Loan principal': '1500', 'Customer advance liability': '4000'})
    entry('lender', 'financial-close', {'Loan receivable': '1500'}, {'Cash': '1500'})
    entry('customer', 'financial-close', {'Purchase advance': '4000'}, {'Refundable escrow': '4000'})
    entry('supplier', 'financial-close', {'Cash': '6000'}, {'Customer advance liability': '6000'})
    entry('freight', 'financial-close', {'Cash': '500'}, {'Customer advance liability': '500'})
    entry('merchant', 'goods-and-inbound-freight-accepted', {'Inventory': '6500'},
          {'Supplier prepayment': '6000', 'Freight prepayment': '500'})
    entry('supplier', 'supply-accepted', {'Customer advance liability': '6000'}, {'Revenue': '6000'})
    entry('freight', 'service-accepted', {'Customer advance liability': '500'}, {'Revenue': '500'})
    entry('merchant', 'sale-accepted', {'Customer advance liability': '4000', 'Accounts receivable': '6000'}, {'Revenue': '10000'})
    entry('merchant', 'sale-cost-recognized', {'Cost of goods sold': '6500'}, {'Inventory': '6500'})
    entry('customer', 'sale-accepted', {'Purchased goods': '10000'}, {'Purchase advance': '4000', 'Accounts payable': '6000'})
    entry('customer', 'balance-paid', {'Accounts payable': '6000'}, {'Cash': '6000'})
    entry('merchant', 'balance-collected', {'Cash': '6000'}, {'Accounts receivable': '6000'})
    entry('merchant', 'principal-repaid', {'Loan principal': '1500'}, {'Cash': '1500'})
    entry('lender', 'principal-repaid', {'Cash': '1500'}, {'Loan receivable': '1500'})
    ok(balances['merchant']['Cash'] == m, 'sale journal cash agrees with kernel claim')
    ok(balances['lender']['Cash'] == lender, 'sale lender journal agrees with kernel claim')
    ok(balances['customer']['Cash'] == customer, 'sale customer journal agrees with external balance')
    ok(balances['merchant']['Loan principal'] == 0 and balances['lender']['Loan receivable'] == 0,
       'sale principal agrees across entities')
    ok(-balances['merchant']['Revenue'] - balances['merchant']['Cost of goods sold'] == units('3500'),
       'sale simplified profit agrees with increase in merchant cash')
    for account in ['Supplier prepayment', 'Freight prepayment', 'Inventory', 'Accounts receivable', 'Customer advance liability']:
        ok(balances['merchant'].get(account, 0) == 0, f'sale temporary account cleared: {account}')

    g = FIXTURES['collective_purchase']
    buyer_cash = {b['id']: units(b['initial_cash']) for b in g['buyers']}
    buyer_debt = {b['id']: 0 for b in g['buyers']}
    lender = units(g['lender_initial_deposited_cash'])
    customer = units(g['external_customer_initial_cash'])
    supplier = 0
    kernel = sum(buyer_cash.values()) + lender
    global_cash = units(g['expected']['global_cash'])
    group_checkpoints = []

    def group_checkpoint(label):
        ok(kernel == sum(buyer_cash.values()) + lender, f'group backing: {label}')
        ok(kernel + supplier + customer == global_cash, f'group conservation: {label}')
        ok(all(buyer_cash[b['id']] >= units(b['protected_cash']) for b in g['buyers']), f'group protection: {label}')
        group_checkpoints.append({'label':label, 'kernel':kernel, 'buyers':dict(buyer_cash), 'lender':lender,
                                  'customer_external':customer, 'supplier':supplier, 'principal':dict(buyer_debt)})

    group_checkpoint('opening')
    ab = g['buyers'][:2]
    ok(sum(b['quantity'] for b in ab) == 75, 'A and B cannot meet exact 100-unit close')
    ok(sum(units(b['own_reservation']) for b in ab) == units('350'), 'A and B own hold')
    ok(sum(units(b['credit_reserved']) for b in ab) == units('325'), 'A and B funded credit hold')
    ok(sum(b['quantity'] for b in g['buyers']) == g['required_quantity'] == g['supplier_capacity'], 'group exact fill')
    ok(sum(units(b['credit_reserved']) for b in g['buyers']) <= lender, 'all group credit is funded')
    ok(units('160') + units('165') > units(g['negative_fixtures']['insufficient_lender_cash']),
       '300 lender fixture cannot reserve A and B simultaneously')
    ok(g['negative_fixtures']['insufficient_supplier_capacity'] < g['required_quantity'], '99 capacity cannot satisfy 100 units')

    entry('group-lender', 'opening', {'Cash':'500'}, {'Opening equity':'500'})
    entry('group-customer', 'opening', {'Cash':'1000'},
          {'Opening payable A':'160', 'Opening payable B':'165', 'Opening payable C':'125', 'Opening equity':'550'})
    for b in g['buyers']:
        bid=b['id']; entity='buyer-'+bid
        opening_equity = str(Decimal(b['initial_cash']) + Decimal(b['opening_receivable']))
        entry(entity,'opening', {'Cash':b['initial_cash'], 'Opening accounts receivable':b['opening_receivable']}, {'Opening equity':opening_equity})
        amount=units(b['supplier_allocation'])
        own=units(b['own_reservation']); borrowed=units(b['credit_reserved'])
        ok(amount == own+borrowed == b['quantity'] * units(g['supplier_unit_price']), f'group allocation sources: {bid}')
        ok(borrowed <= units(b['credit_limit']), f'group credit approval ceiling: {bid}')
        buyer_cash[bid] -= own
        lender -= borrowed
        buyer_debt[bid] += borrowed
        supplier += amount
        kernel -= amount
        entry(entity,'financial-close', {'Supplier prepayment':b['supplier_allocation']}, {'Cash':b['own_reservation'], 'Loan principal':b['credit_reserved']})
        entry('group-lender','draw-'+bid, {'Loan receivable '+bid:b['credit_reserved']}, {'Cash':b['credit_reserved']})
        entry('group-supplier','advance-'+bid, {'Cash':b['supplier_allocation']}, {'Customer advance '+bid:b['supplier_allocation']})
        entry(entity,'goods-received', {'Inventory':b['supplier_allocation']}, {'Supplier prepayment':b['supplier_allocation']})
        entry('group-supplier','delivered-'+bid, {'Customer advance '+bid:b['supplier_allocation']}, {'Revenue':b['supplier_allocation']})
    group_checkpoint('financial close')
    ok(kernel == units(g['expected']['kernel_after_close']), 'group post-close kernel')
    ok(lender == units(g['expected']['lender_cash_after_close']), 'group post-close lender')
    ok(sum(buyer_debt.values()) == units(g['expected']['principal_after_close']), 'group total principal')

    # Collect identified opening AR. Repayment is an explicit separate action.
    for b in g['buyers']:
        bid=b['id']; entity='buyer-'+bid; receipt=units(b['opening_receivable'])
        customer-=receipt; kernel+=receipt; buyer_cash[bid]+=receipt
        entry(entity,'opening-ar-collected', {'Cash':b['opening_receivable']}, {'Opening accounts receivable':b['opening_receivable']})
        entry('group-customer','opening-payable-paid-'+bid, {'Opening payable '+bid:b['opening_receivable']}, {'Cash':b['opening_receivable']})
    group_checkpoint('all opening AR collected; no repayment yet')
    ok(sum(buyer_debt.values()) == units('450'), 'group collection alone does not reduce principal')
    ok(lender == units('50'), 'group collection alone does not repay lender')
    ok(sum(buyer_cash.values()) == units('750'), 'group all collected funds credited to buyers')
    ok(sum(units(b['opening_receivable']) for b in g['buyers']) == units(g['external_customer_opening_payables']),
       'group opening receivables mirror customer payables')

    for b in g['buyers']:
        bid=b['id']; entity='buyer-'+bid
        ok(buyer_cash[bid]-units(b['protected_cash']) >= buyer_debt[bid], f'group repayment preserves floor: {bid}')
        repayment=buyer_debt[bid]
        buyer_cash[bid]-=repayment; lender+=repayment; buyer_debt[bid]=0
        entry(entity,'principal-repaid', {'Loan principal':b['credit_reserved']}, {'Cash':b['credit_reserved']})
        entry('group-lender','repayment-'+bid, {'Cash':b['credit_reserved']}, {'Loan receivable '+bid:b['credit_reserved']})
        group_checkpoint('collection and repayment '+bid)
        ok(balances[entity]['Cash'] == buyer_cash[bid], f'group journal cash agrees: {bid}')
        ok(balances[entity]['Opening accounts receivable'] == 0 and balances[entity]['Loan principal'] == 0, f'group AR and loan cleared: {bid}')
        ok('Revenue' not in balances[entity], f'group receipt does not invent revenue: {bid}')
    ok(kernel == units(g['expected']['kernel_after_collections']), 'group terminal kernel')
    ok(lender == units(g['expected']['terminal_lender_cash']), 'group terminal lender cash')
    ok(customer == units(g['expected']['terminal_external_customer_cash']), 'group terminal external customer cash')
    ok(sum(buyer_cash.values()) == units(g['expected']['terminal_buyer_cash']), 'group terminal buyer cash')
    ok(sum(buyer_debt.values()) == 0, 'group principal fully repaid')
    ok(balances['group-customer']['Cash'] == customer, 'group customer cash journal agrees with external funds')
    ok(all(balances['group-customer']['Opening payable '+b['id']] == 0 for b in g['buyers']),
       'group customer opening payables cleared')

    # Reference state enumeration illustrates scope, it does not test EVM rollback.
    sequential = ['0000', '1000', '1100', '1110', '1111']
    atomic = ['0000', '1111']
    ok(len(sequential)-len(atomic) == 3, 'illustrative four-step model has three partial states')
    return {'scale_divisor':scale, 'checks_passed':len(checks), 'journal_count':len(journals),
            'sales_checkpoints':checkpoints, 'group_checkpoints':group_checkpoints,
            'scope':'Reference arithmetic, balances and journals only. No contract, authorization, integration, UI or security claim.'}


def main():
    results=[verify(1), verify(FIXTURES['onchain_scale_divisor'])]
    report={'status':'passed', 'results':results, 'implementation_status':'No application or contract implementation tested.'}
    output=ROOT/'evidence/spec-validation.json'
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report,indent=2)+'\n')
    for result in results:
        print(f"scale 1/{result['scale_divisor']}: {result['checks_passed']} checks, {result['journal_count']} balanced journals")
    print('Specification fixtures passed. Production implementation remains untested.')


if __name__ == '__main__':
    main()
