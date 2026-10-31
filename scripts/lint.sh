#!/usr/bin/env bash
set -u
lint_exit=0
# Oxlint discovers scripts/tsconfig.json for Bun tooling and the root project for browser code.
bunx oxlint --type-aware src scripts --fix || lint_exit=1
bunx oxlint --fix . || lint_exit=1
exit "$lint_exit"
