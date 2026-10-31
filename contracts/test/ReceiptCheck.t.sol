// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import "../BusinessKernel.sol";
import "../IBusinessKernel.sol";

// ---------------------------------------------------------------------------
// Controlled ERC-20 test double
// ---------------------------------------------------------------------------

/**
 * @notice A minimal ERC-20 where balanceOf is honest (updated only when
 *         tokens actually move) and transferFrom behaviour is configurable.
 *         NoOp and Short modes now consume the caller's allowance before
 *         returning, so rollback assertions about allowance are meaningful.
 */
contract ControlledERC20 {
    string  public name     = "Controlled";
    string  public symbol   = "CTL";
    uint8   public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    enum Mode { Normal, NoOp, Short, FalseReturn, Excess }
    Mode    public transferFromMode;
    uint256 public shortfall;

    function setMode(Mode m, uint256 sf) external {
        transferFromMode = m;
        shortfall        = sf;
    }

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

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
        require(balanceOf[msg.sender] >= amount, "ERC20: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    /**
     * Normal  — honest transfer, consumes allowance.
     * NoOp    — consumes allowance, moves nothing, returns true.
     * Short   — consumes allowance, moves (amount-shortfall), returns true.
     * FalseReturn — consumes allowance, moves nothing, returns false.
     */
    function transferFrom(address from, address to, uint256 amount)
        external returns (bool)
    {
        if (transferFromMode == Mode.Normal) {
            require(balanceOf[from] >= amount, "ERC20: balance");
            require(allowance[from][msg.sender] >= amount, "ERC20: allowance");
            allowance[from][msg.sender] -= amount;
            balanceOf[from] -= amount;
            balanceOf[to]   += amount;
            emit Transfer(from, to, amount);
            return true;
        }
        if (transferFromMode == Mode.FalseReturn) {
            require(allowance[from][msg.sender] >= amount, "ERC20: allowance");
            allowance[from][msg.sender] -= amount;
            return false;
        }
        // NoOp and Short: consume allowance first (meaningful rollback test).
        require(allowance[from][msg.sender] >= amount, "ERC20: allowance");
        allowance[from][msg.sender] -= amount;
        if (transferFromMode == Mode.NoOp) {
            return true; // allowance consumed, nothing moved
        }
        // Short: move (amount - shortfall).
        uint256 actual = transferFromMode == Mode.Excess ? amount + 1 : (amount > shortfall ? amount - shortfall : 0);
        if (actual > 0) {
            require(balanceOf[from] >= actual, "ERC20: balance");
            balanceOf[from] -= actual;
            balanceOf[to]   += actual;
            emit Transfer(from, to, actual);
        }
        return true;
    }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

contract ReceiptCheckTest is Test {
    uint256 internal constant AMOUNT = 100_000; // 0.1 USDC at 6 decimals

    ControlledERC20 internal tok;
    BusinessKernel  internal kernel;

    address internal lender   = makeAddr("rc_lender");
    address internal depositor = makeAddr("rc_depositor");

    uint256 internal accId;

    function setUp() public {
        tok    = new ControlledERC20();
        kernel = new BusinessKernel(address(tok), lender);
        vm.prank(depositor);
        accId = kernel.openAccount();
        tok.mint(depositor, AMOUNT);
        vm.prank(depositor);
        tok.approve(address(kernel), AMOUNT);
    }

    // ── RC-01: positive control — honest transferFrom ─────────────────────

    function test_RC01_HonestTransferSucceeds() public {
        vm.prank(depositor);
        kernel.depositCash(accId, AMOUNT);

        (,uint256 cash,,,,) = kernel.getAccount(accId);
        assertEq(cash,                           AMOUNT, "RC01: a.cash");
        assertEq(tok.balanceOf(address(kernel)), AMOUNT, "RC01: kernel balance");
        assertEq(tok.balanceOf(depositor),       0,      "RC01: caller debited");
        assertEq(tok.allowance(depositor, address(kernel)), 0, "RC01: allowance consumed");
    }

    // ── RC-02: no-op transferFrom — consumes allowance, moves nothing ──────
    // The token's transferFrom decrements allowance and then returns true
    // without moving tokens. _receiveExact detects the balance delta is zero
    // and reverts. The EVM rolls back ALL state changes made during this
    // transaction, including the allowance decrement inside the token contract.

    function test_RC02_NoOpTransferRejected() public {
        tok.setMode(ControlledERC20.Mode.NoOp, 0);

        uint256 kernelBalBefore    = tok.balanceOf(address(kernel));
        uint256 depositorBalBefore = tok.balanceOf(depositor);
        uint256 allowanceBefore    = tok.allowance(depositor, address(kernel));

        vm.expectRevert(BK_TransferReceiptMismatch.selector);
        vm.prank(depositor);
        kernel.depositCash(accId, AMOUNT);

        // All state in all contracts rolls back on revert.
        (,uint256 cash,,,,) = kernel.getAccount(accId);
        assertEq(cash,                                    0,                  "RC02: no phantom credit");
        assertEq(tok.balanceOf(address(kernel)),          kernelBalBefore,    "RC02: kernel bal rolled back");
        assertEq(tok.balanceOf(depositor),                depositorBalBefore, "RC02: depositor bal rolled back");
        assertEq(tok.allowance(depositor, address(kernel)), allowanceBefore,  "RC02: allowance rolled back");
    }

    // ── RC-03: short-receipt — consumes allowance, moves amount-1 ─────────
    // The token moves AMOUNT-1 tokens and returns true. _receiveExact detects
    // the balance delta (AMOUNT-1) != AMOUNT and reverts. Full rollback.

    function test_RC03_ShortReceiptRejected() public {
        tok.setMode(ControlledERC20.Mode.Short, 1);

        uint256 kernelBalBefore    = tok.balanceOf(address(kernel));
        uint256 depositorBalBefore = tok.balanceOf(depositor);
        uint256 allowanceBefore    = tok.allowance(depositor, address(kernel));

        vm.expectRevert(BK_TransferReceiptMismatch.selector);
        vm.prank(depositor);
        kernel.depositCash(accId, AMOUNT);

        (,uint256 cash,,,,) = kernel.getAccount(accId);
        assertEq(cash,                                    0,                  "RC03: no phantom credit");
        assertEq(tok.balanceOf(address(kernel)),          kernelBalBefore,    "RC03: kernel bal rolled back");
        assertEq(tok.balanceOf(depositor),                depositorBalBefore, "RC03: depositor bal rolled back");
        assertEq(tok.allowance(depositor, address(kernel)), allowanceBefore,  "RC03: allowance rolled back");
    }

    // ── RC-04: positive control after mode reset ──────────────────────────

    function test_RC04_HonestTransferAfterModeReset() public {
        tok.setMode(ControlledERC20.Mode.NoOp, 0);
        tok.setMode(ControlledERC20.Mode.Normal, 0);

        vm.prank(depositor);
        kernel.depositCash(accId, AMOUNT);

        (,uint256 cash,,,,) = kernel.getAccount(accId);
        assertEq(cash,                           AMOUNT, "RC04: a.cash");
        assertEq(tok.balanceOf(address(kernel)), AMOUNT, "RC04: kernel balance");
        assertEq(tok.balanceOf(depositor),       0,      "RC04: caller debited");
    }

    // ── RC-05: false-return — SafeERC20 rejects before receipt check ──────
    // This distinguishes a false transferFrom return (handled by SafeERC20)
    // from a true-return receipt mismatch (handled by _receiveExact).

    // ── RC-05: false-return — SafeERC20 rejects, full rollback ──────────────
    // transferFrom returns false. OZ SafeERC20 detects this and reverts with
    // SafeERC20FailedOperation before _receiveExact even reads the balance.
    // The selector distinguishes this path from BK_TransferReceiptMismatch.
    // All state including allowance decremented inside the token rolls back.

    function test_RC05_FalseReturnRejected() public {
        tok.setMode(ControlledERC20.Mode.FalseReturn, 0);
        // Mint extra so caller balance is not the failure cause.
        tok.mint(depositor, AMOUNT);
        vm.prank(depositor);
        tok.approve(address(kernel), AMOUNT * 2);

        uint256 depositorBalBefore = tok.balanceOf(depositor);
        uint256 allowanceBefore    = tok.allowance(depositor, address(kernel));

        bytes4 sFailed = bytes4(keccak256("SafeERC20FailedOperation(address)"));
        vm.expectRevert(abi.encodeWithSelector(sFailed, address(tok)));
        vm.prank(depositor);
        kernel.depositCash(accId, AMOUNT);

        // Full rollback: credit, token balances, and allowance all unchanged.
        (,uint256 cash,,,,) = kernel.getAccount(accId);
        assertEq(cash,                                    0,                 "RC05: no phantom credit");
        assertEq(tok.balanceOf(address(kernel)),          0,                 "RC05: kernel bal rolled back");
        assertEq(tok.balanceOf(depositor),                depositorBalBefore, "RC05: depositor bal rolled back");
        assertEq(tok.allowance(depositor, address(kernel)), allowanceBefore,  "RC05: allowance rolled back");
    }

    function test_RC06_ExcessReceiptRejectedWithFullRollback() public {
        tok.mint(depositor, 1);
        tok.setMode(ControlledERC20.Mode.Excess, 0);
        vm.prank(depositor);
        vm.expectRevert(BK_TransferReceiptMismatch.selector);
        kernel.depositCash(accId, AMOUNT);
        (,uint256 cash,,,,) = kernel.getAccount(accId);
        assertEq(cash, 0);
        assertEq(kernel.accountedCustody(), 0);
        assertEq(tok.balanceOf(address(kernel)), 0);
        assertEq(tok.balanceOf(depositor), AMOUNT + 1);
        assertEq(tok.allowance(depositor, address(kernel)), AMOUNT);
        tok.setMode(ControlledERC20.Mode.Normal, 0);
        vm.prank(depositor); kernel.depositCash(accId, AMOUNT);
        assertEq(tok.balanceOf(address(kernel)), AMOUNT);
        assertEq(kernel.accountedCustody(), AMOUNT);
    }

}
