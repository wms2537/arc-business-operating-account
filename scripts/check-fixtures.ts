/**
 * Deterministic fixture verification script.
 * Run with: bun run fixtures:check
 *
 * Verifies all Scenario A and B invariants without hitting the chain.
 */
import { runFixtureChecks } from '../src/domain/fixtures';

try {
  runFixtureChecks();
  process.exit(0);
} catch (err) {
  console.error('\n' + String(err));
  process.exit(1);
}
