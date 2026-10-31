// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import "../BusinessKernel.sol";
import "../IBusinessKernel.sol";

/**
 * Reentrancy / callback tests.
 *
 * The callback actor in every test is the actual EVM msg.sender when the
 * re-entrant call reaches the kernel.  Because a token contract is always
 * msg.sender for calls it initiates, each reentrant token contract owns its
 * own funded account or pool — it is literally the authorized party.
 * No vm.prank is used inside any token to impersonate a different address.
 *
 * Three scenarios:
 *
 * RECB01 — Propagated inbound callback.
 *   DepositReentrantToken owns accT on the kernel (token-contract as owner).
 *   transferFrom re-enters kernel.depositCash(accT, ...) — valid except the
 *   guard.  The inner call reverts with ReentrancyGuardReentrantCall; OZ
 *   SafeERC20 propagates the revert; outer depositCash reverts with the same
 *   error.  Full rollback.  Positive control: disarmed token, same deposit.
 *
 * RECB02 — Caught outbound callback.
 *   CaughtPayoutToken owns accT on the kernel.  token.transfer (outgoing
 *   payout from commitPlan) calls kernel.withdrawCash(accT,...) — valid
 *   except the guard.  Token wraps the inner call in try/catch and swallows
 *   the revert.  token.transfer returns true normally.  The outer commitPlan
 *   succeeds.  Positive control: separate withdrawCash on accT outside
 *   reentrancy succeeds.
 *
 * RECB03 — Propagated outbound callback, second-transfer trigger + full
 *   rollback.
 *   PropagatedPayoutToken owns accT on the kernel.  Fires on the SECOND
 *   transfer call (freight-payee payout).  First supplier payout (goods
 *   payee) executes normally, moving tokens out of the kernel.  Second
 *   transfer triggers the re-entrant withdrawCash, which hits the guard.
 *   The propagated revert rolls back the entire commitPlan transaction:
 *   first payment, second payment, loan principal, escrow consumption, plan
 *   status — all revert.  Verified via token balance + kernel state checks.
 *   Retry with token disarmed commits successfully.
 */

// ---------------------------------------------------------------------------
// Token doubles
// ---------------------------------------------------------------------------

/**
 * @notice Inbound-reentrant token.
 *   The token contract itself is the authorized actor: it owns accT on the
 *   kernel and has deposited sufficient cash into it. When armed, transferFrom
 *   re-enters kernel.depositCash(accT, amount) with msg.sender == address(this).
 */
contract DepositReentrantToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    string public name     = "ReentrantDeposit";
    string public symbol   = "RDT";
    uint8  public decimals = 6;

    BusinessKernel public kernel;
    uint256        public accT;   // account owned by this token contract
    bool           public armed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setKernel(address k, uint256 tokenAccId) external {
        kernel = BusinessKernel(payable(k));
        accT   = tokenAccId;
    }

    function arm(bool a) external { armed = a; }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    /**
     * @dev Moves tokens honestly, then — if armed — calls
     *      kernel.depositCash(accT, amount) as msg.sender == address(this).
     *      The token contract owns accT, so the call is authorized by ownership;
     *      only the reentrancy guard rejects it.
     */
    function transferFrom(address from, address to, uint256 amount)
        external returns (bool)
    {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);

        if (armed) {
            // The reentrant call. msg.sender inside depositCash will be
            // address(this) (the token contract), which is the owner of accT.
            kernel.depositCash(accT, amount);
        }
        return true;
    }
}

/**
 * @notice Outbound-reentrant token (caught variant).
 *   transfer calls kernel.withdrawCash(accT, ...) — token contract owns accT.
 *   The inner revert is caught; transfer returns true.
 *   Outer operation (commitPlan) proceeds normally.
 */
contract CaughtPayoutToken {
    uint256 public callbackAttempts;
    uint256 public callbackFailures;
    uint256 public callbackSuccesses;
    bytes4 public callbackError;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    string public name     = "CaughtPayout";
    string public symbol   = "CPT";
    uint8  public decimals = 6;

    BusinessKernel public kernel;
    uint256        public accT;      // account owned by this token contract
    address        public withdrawTo;
    uint256        public withdrawAmt;
    bool           public armed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setKernel(address k, uint256 tokenAccId, address to_, uint256 amt) external {
        kernel      = BusinessKernel(payable(k));
        accT        = tokenAccId;
        withdrawTo  = to_;
        withdrawAmt = amt;
    }

    function arm(bool a) external { armed = a; }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /**
     * @dev Moves tokens, then — if armed — attempts kernel.withdrawCash as
     *      msg.sender == address(this) (token owns accT).
     *      The guard revert is caught; transfer still returns true.
     */
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);

        if (armed) {
            // Attempt the withdrawCash re-entry; catch the guard revert.
            callbackAttempts++;
            try kernel.withdrawCash(accT, withdrawTo, withdrawAmt) {
                callbackSuccesses++;
            } catch (bytes memory reason) {
                callbackFailures++;
                callbackError = bytes4(reason);
            }
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external returns (bool)
    {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/**
 * @notice Outbound-reentrant token (propagated variant, second-transfer trigger).
 *   Counts transfer calls. On the SECOND call (freight-payee payout in
 *   commitPlan), calls kernel.withdrawCash(accT, ...) and does NOT catch the
 *   revert — it propagates, rolling back the entire commitPlan.
 *   Token contract owns accT.
 */
contract PropagatedPayoutToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    string public name     = "PropagatedPayout";
    string public symbol   = "PPT";
    uint8  public decimals = 6;

    BusinessKernel public kernel;
    uint256        public accT;
    address        public withdrawTo;
    uint256        public withdrawAmt;
    bool           public armed;
    uint256        public transferCount;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setKernel(address k, uint256 tokenAccId, address to_, uint256 amt) external {
        kernel      = BusinessKernel(payable(k));
        accT        = tokenAccId;
        withdrawTo  = to_;
        withdrawAmt = amt;
    }

    function arm(bool a) external {
        armed = a;
        if (a) transferCount = 0; // reset counter on each arm
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /**
     * @dev On the SECOND transfer call (when armed), calls kernel.withdrawCash
     *      without catching the revert — rolls back the entire commitPlan.
     */
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);

        if (armed) {
            transferCount += 1;
            if (transferCount == 2) {
                // Fire on second transfer: propagate the guard revert.
                kernel.withdrawCash(accT, withdrawTo, withdrawAmt);
            }
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        external returns (bool)
    {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

contract ReentrancyCallbackTest is Test {
    uint256 internal constant D = 1000;
    function u(uint256 x) internal pure returns (uint256) { return x * D; }

    bytes4 internal constant GUARD_ERR =
        bytes4(keccak256("ReentrancyGuardReentrantCall()"));

    // ── RECB01 ────────────────────────────────────────────────────────────
    // Propagated inbound callback.
    //
    // Positive control (RECB01a): disarmed token, outer deposit succeeds.
    // Propagated (RECB01b): armed token, inner depositCash re-enters, guard
    //   fires, revert propagates, entire transaction rolls back.

    function test_RECB01a_DepositCash_PositiveControl() public {
        address actor = makeAddr("recb01_actor");
        DepositReentrantToken tok = new DepositReentrantToken();
        BusinessKernel kernel = new BusinessKernel(address(tok), actor);

        // Token contract opens its own account: msg.sender == address(tok).
        vm.prank(address(tok));
        uint256 accT = kernel.openAccount();
        tok.setKernel(address(kernel), accT);

        // Fund token's own account (for the re-entrant deposit attempt).
        tok.mint(address(tok), u(200));
        vm.prank(address(tok)); tok.approve(address(kernel), u(200));

        // Fund actor account.
        vm.prank(actor); uint256 accA = kernel.openAccount();
        tok.mint(actor, u(100));
        vm.prank(actor); tok.approve(address(kernel), u(100));

        // Positive control: disarmed, deposit succeeds.
        tok.arm(false);
        vm.prank(actor);
        kernel.depositCash(accA, u(100));
        (,uint256 cash,,,,) = kernel.getAccount(accA);
        assertEq(cash, u(100), "RECB01a: deposit credited");
        assertEq(tok.balanceOf(address(kernel)), u(100), "RECB01a: kernel balance");
    }

    function test_RECB01b_DepositCash_PropagatedCallback() public {
        address actor = makeAddr("recb01b_actor");
        DepositReentrantToken tok = new DepositReentrantToken();
        BusinessKernel kernel = new BusinessKernel(address(tok), actor);

        // Token contract opens accT — token is msg.sender, owns accT.
        vm.prank(address(tok));
        uint256 accT = kernel.openAccount();
        tok.setKernel(address(kernel), accT);

        // Fund token's account and allowance (needed for re-entrant deposit).
        tok.mint(address(tok), u(200));
        vm.prank(address(tok)); tok.approve(address(kernel), u(200));

        // Fund actor account for the outer deposit.
        vm.prank(actor); uint256 accA = kernel.openAccount();
        tok.mint(actor, u(100));
        vm.prank(actor); tok.approve(address(kernel), u(100));

        uint256 kernelBalBefore = tok.balanceOf(address(kernel));
        uint256 actorBalBefore  = tok.balanceOf(actor);
        uint256 allowBefore     = tok.allowance(actor, address(kernel));

        tok.arm(true);

        // The outer depositCash triggers transferFrom which re-enters
        // depositCash(accT). The inner call hits the guard; the revert
        // propagates through safeTransferFrom back to the outer call.
        vm.expectRevert(GUARD_ERR);
        vm.prank(actor);
        kernel.depositCash(accA, u(100));

        // Full rollback — all state in all contracts restored.
        (,uint256 cashA,,,,) = kernel.getAccount(accA);
        assertEq(cashA,                                   0,              "RECB01b: accA not credited");
        assertEq(tok.balanceOf(address(kernel)),          kernelBalBefore, "RECB01b: kernel bal rolled back");
        assertEq(tok.balanceOf(actor),                    actorBalBefore,  "RECB01b: actor bal rolled back");
        assertEq(tok.allowance(actor, address(kernel)),   allowBefore,     "RECB01b: allowance rolled back");
    }

    // ── RECB02 ────────────────────────────────────────────────────────────
    // Caught outbound callback.
    //
    // CaughtPayoutToken owns accT with funded cash.  commitPlan triggers
    // token.transfer; the token calls kernel.withdrawCash(accT,...), hits the
    // guard, catches the revert, and returns true.  commitPlan succeeds.
    //
    // Positive control (RECB02a): outside reentrancy, the same withdrawCash
    //   on accT succeeds — confirms the failure was the guard, not ownership
    //   or insufficient funds.
    // Caught (RECB02b): commitPlan with armed token succeeds; then proves
    //   accT state is unchanged (no phantom withdrawal).

    struct CB02Fix {
        CaughtPayoutToken tok;
        BusinessKernel    kernel;
        uint256           pool;
        uint256           accM;
        uint256           accT;   // owned by the token contract
        uint256           planId;
        uint256           tokFunds;
    }

    function _cb02Setup() private returns (CB02Fix memory f) {
        address lender   = makeAddr("recb02_lend");
        address merch    = makeAddr("recb02_merch");
        address supG     = makeAddr("recb02_supG");
        address supF     = makeAddr("recb02_supF");
        address customer = makeAddr("recb02_cust");

        f.tok    = new CaughtPayoutToken();
        f.kernel = new BusinessKernel(address(f.tok), lender);
        f.pool   = f.kernel.POOL_ID();

        vm.prank(merch); f.accM = f.kernel.openAccount();
        // Token contract opens its own account.
        vm.prank(address(f.tok)); f.accT = f.kernel.openAccount();

        uint256 exp = block.timestamp + 7 days;
        vm.prank(supG); uint256 offG = f.kernel.createOffer(supG, u(60), 100, 100, exp);
        vm.prank(supF); uint256 offF = f.kernel.createOffer(supF, u(500), 1, 1, exp);

        // Fund lender pool.
        f.tok.mint(lender, u(2000));
        vm.prank(lender); f.tok.approve(address(f.kernel), u(2000));
        vm.prank(lender); f.kernel.depositPool(f.pool, u(2000));
        vm.prank(lender); f.kernel.setBorrowerLimit(f.pool, f.accM, u(2000));

        // Fund merchant cash.
        f.tok.mint(merch, u(3000));
        vm.prank(merch); f.tok.approve(address(f.kernel), u(3000));
        vm.prank(merch); f.kernel.depositCash(f.accM, u(3000));
        vm.prank(merch); f.kernel.setProtectedFloor(f.accM, u(2000));

        // Fund token's own account — this is the authorized callback actor.
        f.tokFunds = u(500);
        f.tok.mint(address(f.tok), f.tokFunds);
        vm.prank(address(f.tok)); f.tok.approve(address(f.kernel), f.tokFunds);
        vm.prank(address(f.tok)); f.kernel.depositCash(f.accT, f.tokFunds);

        // Draft and approve plan.
        f.planId = _draftCOPlan(f.kernel, f.pool, f.accM, merch, supG, supF,
                                 offG, offF, customer, exp, bytes32("cb02"));
        vm.prank(lender); f.kernel.approveLenderPlan(f.planId, 0, u(1500), exp);
        vm.prank(supG);   f.kernel.approveSupplierPlan(f.planId, 0, 100, exp);
        vm.prank(supF);   f.kernel.approveSupplierPlan(f.planId, 1, 1,   exp);
        vm.prank(merch);  f.kernel.joinMerchant(f.planId);

        f.tok.mint(customer, u(4000));
        vm.prank(customer); f.tok.approve(address(f.kernel), u(4000));
        vm.prank(customer); f.kernel.fundCustomerEscrow(f.planId);
    }

    function test_RECB02a_WithdrawFromTokenAccount_PositiveControl() public {
        CB02Fix memory f = _cb02Setup();
        address withdrawTo = makeAddr("recb02_wdTo");

        // Outside reentrancy, the token-contract can withdraw its own cash.
        vm.prank(address(f.tok));
        f.kernel.withdrawCash(f.accT, withdrawTo, f.tokFunds);

        assertEq(f.tok.balanceOf(withdrawTo), f.tokFunds, "RECB02a: withdrawal succeeded");
    }

    function test_RECB02b_CommitPlan_CaughtCallback_Succeeds() public {
        CB02Fix memory f = _cb02Setup();
        address withdrawTo = makeAddr("recb02_wdTo2");

        // Wire the token to attempt withdrawCash(accT,...) on each transfer.
        f.tok.setKernel(address(f.kernel), f.accT, withdrawTo, f.tokFunds);
        f.tok.arm(true);

        // commitPlan triggers transfers to goods/freight payees.
        // Each transfer attempts the re-entrant withdrawCash; guard fires;
        // token catches the revert; transfer returns true; commitPlan completes.
        f.kernel.commitPlan(f.planId);

        (,IBusinessKernel.PlanStatus status,,,) = f.kernel.getPlan(f.planId);
        assertTrue(status == IBusinessKernel.PlanStatus.Committed,
            "RECB02b: plan committed despite caught callback");

        // accT cash is unchanged — no phantom withdrawal occurred.
        (,uint256 cashT,,,,) = f.kernel.getAccount(f.accT);
        assertEq(cashT, f.tokFunds, "RECB02b: token account cash unchanged");

        // withdrawTo received nothing — the withdrawal was blocked.
        assertEq(f.tok.balanceOf(withdrawTo), 0, "RECB02b: no phantom transfer to withdrawTo");
        assertEq(f.tok.callbackAttempts(),2,"one callback per payout");
        assertEq(f.tok.callbackFailures(),2);
        assertEq(f.tok.callbackSuccesses(),0);
        assertEq(f.tok.callbackError(),GUARD_ERR,"actual guard error caught");
        assertEq(f.tok.balanceOf(makeAddr("recb02_supG")),u(6000));
        assertEq(f.tok.balanceOf(makeAddr("recb02_supF")),u(500));
        (,,,,,uint256 debt) = f.kernel.getAccount(f.accM);
        assertEq(debt,u(1500),"principal created exactly once");
        assertEq(f.kernel.accountedCustody(),f.kernel.totalCustody());
    }

    // ── RECB03 ────────────────────────────────────────────────────────────
    // Propagated outbound callback, second-transfer trigger.
    //
    // PropagatedPayoutToken fires on the SECOND transfer (freight payee).
    // First supplier payment (goods payee) moves tokens out of the kernel.
    // Second payment triggers the re-entrant withdrawCash; guard fires;
    // revert propagates; entire commitPlan reverts — including the first
    // payment.  Token balances, plan status, loan, escrow, holds all revert.
    // Retry with token disarmed confirms full recovery.

    struct CB03Fix {
        PropagatedPayoutToken tok;
        BusinessKernel        kernel;
        uint256               pool;
        uint256               accM;
        uint256               accT;
        uint256               planId;
        uint256               tokFunds;
        address               supG;
        address               supF;
    }

    function _cb03Setup() private returns (CB03Fix memory f) {
        address lender   = makeAddr("recb03_lend");
        address merch    = makeAddr("recb03_merch");
        f.supG           = makeAddr("recb03_supG");
        f.supF           = makeAddr("recb03_supF");
        address customer = makeAddr("recb03_cust");

        f.tok    = new PropagatedPayoutToken();
        f.kernel = new BusinessKernel(address(f.tok), lender);
        f.pool   = f.kernel.POOL_ID();

        vm.prank(merch); f.accM = f.kernel.openAccount();
        vm.prank(address(f.tok)); f.accT = f.kernel.openAccount();

        uint256 exp = block.timestamp + 7 days;
        vm.prank(f.supG); uint256 offG = f.kernel.createOffer(f.supG, u(60),  100, 100, exp);
        vm.prank(f.supF); uint256 offF = f.kernel.createOffer(f.supF, u(500), 1,   1,   exp);

        f.tok.mint(lender, u(2000));
        vm.prank(lender); f.tok.approve(address(f.kernel), u(2000));
        vm.prank(lender); f.kernel.depositPool(f.pool, u(2000));
        vm.prank(lender); f.kernel.setBorrowerLimit(f.pool, f.accM, u(2000));

        f.tok.mint(merch, u(3000));
        vm.prank(merch); f.tok.approve(address(f.kernel), u(3000));
        vm.prank(merch); f.kernel.depositCash(f.accM, u(3000));
        vm.prank(merch); f.kernel.setProtectedFloor(f.accM, u(2000));

        f.tokFunds = u(500);
        f.tok.mint(address(f.tok), f.tokFunds);
        vm.prank(address(f.tok)); f.tok.approve(address(f.kernel), f.tokFunds);
        vm.prank(address(f.tok)); f.kernel.depositCash(f.accT, f.tokFunds);

        f.planId = _draftCOPlan(f.kernel, f.pool, f.accM, merch, f.supG, f.supF,
                                 offG, offF, customer, exp, bytes32("cb03"));
        vm.prank(lender); f.kernel.approveLenderPlan(f.planId, 0, u(1500), exp);
        vm.prank(f.supG); f.kernel.approveSupplierPlan(f.planId, 0, 100, exp);
        vm.prank(f.supF); f.kernel.approveSupplierPlan(f.planId, 1, 1,   exp);
        vm.prank(merch);  f.kernel.joinMerchant(f.planId);

        f.tok.mint(customer, u(4000));
        vm.prank(customer); f.tok.approve(address(f.kernel), u(4000));
        vm.prank(customer); f.kernel.fundCustomerEscrow(f.planId);
    }

    function test_RECB03_PropagatedCallback_SecondTransfer_FullRollback() public {
        CB03Fix memory f = _cb03Setup();
        address withdrawTo = makeAddr("recb03_wdTo");

        // Pre-rollback snapshot of total tokens in the kernel.
        uint256 kernelBalBefore = f.tok.balanceOf(address(f.kernel));
        bytes32 beforeState = _commitState(f);

        // Wire: second transfer triggers withdrawCash from accT (token owns it).
        f.tok.setKernel(address(f.kernel), f.accT, withdrawTo, f.tokFunds);
        f.tok.arm(true);

        // commitPlan: first transfer (goods payee supG) fires normally.
        // Second transfer (freight payee supF) triggers re-entrant withdrawCash.
        // Guard fires; revert propagates; entire commitPlan rolls back.
        vm.expectRevert(GUARD_ERR);
        f.kernel.commitPlan(f.planId);

        assertEq(_commitState(f),beforeState,"commit rollback restored all financial state");
        assertEq(f.tok.transferCount(),0,"both transfer counters rolled back");

        // ── Plan state rolled back ─────────────────────────────────────────
        (,IBusinessKernel.PlanStatus status,,,) = f.kernel.getPlan(f.planId);
        assertTrue(status == IBusinessKernel.PlanStatus.Open,
            "RECB03: plan still Open after rollback");

        // ── First payment rolled back ─────────────────────────────────────
        // supG received no tokens (transfer to supG was rolled back).
        assertEq(f.tok.balanceOf(f.supG), 0, "RECB03: first supplier payout rolled back");

        // ── Second payment rolled back ─────────────────────────────────────
        assertEq(f.tok.balanceOf(f.supF), 0, "RECB03: second supplier payout rolled back");

        // ── Kernel token balance unchanged ────────────────────────────────
        assertEq(f.tok.balanceOf(address(f.kernel)), kernelBalBefore,
            "RECB03: kernel token balance unchanged after rollback");

        // ── Escrow not consumed ────────────────────────────────────────────
        (,uint256 escrowAmt,,bool withdrawn) = f.kernel.getEscrow(f.planId);
        assertEq(escrowAmt, u(4000), "RECB03: escrow amount unchanged");
        assertFalse(withdrawn,       "RECB03: escrow not consumed");

        // ── Loan not created; join-time reservation still live ────────────
        // joinMerchant reserved creditDraw=u(1500) on the pool. commitPlan
        // would have consumed it (reserved -= creditDraw). After rollback the
        // reservation is still live — poolReserved == u(1500).
        (,uint256 poolCash, uint256 poolReserved) = f.kernel.getPool(f.pool);
        assertEq(poolReserved, u(1500), "RECB03: join-time reservation preserved after rollback");
        // Pool cash unchanged (no principal moved to merchant).
        assertEq(poolCash, u(2000), "RECB03: pool cash unchanged");

        // ── Recovery: disarm and retry ─────────────────────────────────────
        f.tok.arm(false);
        f.kernel.commitPlan(f.planId);

        (,IBusinessKernel.PlanStatus statusAfter,,,) = f.kernel.getPlan(f.planId);
        assertTrue(statusAfter == IBusinessKernel.PlanStatus.Committed,
            "RECB03: plan committed after recovery");

        // After commit, goods and freight payees received tokens.
        assertEq(f.tok.balanceOf(f.supG), u(6000), "RECB03: exact goods payment after recovery");
        assertEq(f.tok.balanceOf(f.supF), u(500), "RECB03: exact freight payment after recovery");
        (,,,,,uint256 debtAfter) = f.kernel.getAccount(f.accM);
        assertEq(debtAfter,u(1500));
        (,,,uint256 principal,uint256 outstanding) = f.kernel.getLoan(1);
        assertEq(principal,u(1500)); assertEq(outstanding,u(1500));
        assertEq(f.kernel.accountedCustody(),f.kernel.totalCustody());
    }

    // ── shared fixture helper ─────────────────────────────────────────────

    function _draftCOPlan(
        BusinessKernel k,
        uint256 pool, uint256 accM,
        address merch, address supG, address supF,
        uint256 offG, uint256 offF,
        address customer, uint256 exp, bytes32 ref
    ) private returns (uint256 planId) {
        IBusinessKernel.OfferRef[] memory refs = new IBusinessKernel.OfferRef[](2);
        refs[0] = IBusinessKernel.OfferRef(offG, 100, supG);
        refs[1] = IBusinessKernel.OfferRef(offF, 1,   supF);
        IBusinessKernel.BuyerTerms[] memory buyers = new IBusinessKernel.BuyerTerms[](0);
        IBusinessKernel.PlanTerms memory terms;
        terms.kind              = IBusinessKernel.WorkflowKind.CustomerOrder;
        terms.buyers            = buyers;
        terms.lenderPoolId      = pool;
        terms.offerRefs         = refs;
        terms.expiry            = exp;
        terms.commercialRef     = ref;
        terms.saleParty.merchantOwner     = merch;
        terms.saleParty.merchantAccountId = accM;
        terms.saleParty.merchantCash      = u(1000);
        terms.saleParty.creditDraw        = u(1500);
        terms.saleParty.creditLimit       = u(2000);
        terms.saleParty.customerAddress   = customer;
        terms.saleParty.requiredEscrow    = u(4000);
        terms.saleParty.saleValue         = u(10000);
        (planId,) = k.draftPlan(terms);
    }

    function _readState(BusinessKernel k, bytes memory data) private view returns (bytes32) {
        (bool ok,bytes memory result) = address(k).staticcall(data);
        require(ok,"snapshot getter failed");
        return keccak256(result);
    }
    function _commitState(CB03Fix memory f) private view returns (bytes32 h) {
        BusinessKernel k=f.kernel;
        h=keccak256(abi.encode(k.totalCustody(),k.accountedCustody(),
            f.tok.balanceOf(f.supG),f.tok.balanceOf(f.supF),f.tok.balanceOf(address(f.tok))));
        h=keccak256(abi.encode(h,_readState(k,abi.encodeCall(k.getAccount,(f.accM))),
            _readState(k,abi.encodeCall(k.getAccount,(f.accT))),
            _readState(k,abi.encodeCall(k.getPool,(f.pool)))));
        h=keccak256(abi.encode(h,_readState(k,abi.encodeCall(k.getPlan,(f.planId))),
            _readState(k,abi.encodeCall(k.getEscrow,(f.planId))),
            _readState(k,abi.encodeCall(k.getMerchantParticipation,(f.planId)))));
        h=keccak256(abi.encode(h,_readState(k,abi.encodeCall(k.getLoan,(uint256(1)))),
            _readState(k,abi.encodeCall(k.getBorrowerUsage,(f.pool,f.accM))),
            _readState(k,abi.encodeCall(k.getOffer,(uint256(1)))),
            _readState(k,abi.encodeCall(k.getOffer,(uint256(2))))));
    }
    function test_RECB03a_PropagatedTokenOutflowAuthorizedOutsideCallback() public {
        CB03Fix memory f=_cb03Setup();
        address destination=makeAddr("cb03_authorized_control");
        vm.prank(address(f.tok)); f.kernel.withdrawCash(f.accT,destination,f.tokFunds);
        assertEq(f.tok.balanceOf(destination),f.tokFunds);
        (,uint256 cash,,,,)=f.kernel.getAccount(f.accT);
        assertEq(cash,0);
    }
    function test_RECB01c_TokenOwnedDepositAuthorizedOutsideCallback() public {
        DepositReentrantToken tok=new DepositReentrantToken();
        BusinessKernel k=new BusinessKernel(address(tok),address(this));
        vm.prank(address(tok)); uint256 account=k.openAccount();
        tok.setKernel(address(k),account);
        tok.mint(address(tok),u(100));
        vm.prank(address(tok)); tok.approve(address(k),u(100));
        vm.prank(address(tok)); k.depositCash(account,u(100));
        (,uint256 cash,,,,)=k.getAccount(account);
        assertEq(cash,u(100)); assertEq(k.totalCustody(),u(100));
    }

}
