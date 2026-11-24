# Verification record — 2026-11-24

- Node.js: 24.22.3 (project minimum: 22).
- Clean dependency installation: `npm ci --ignore-scripts --offline` using an existing npm package cache; 353 packages installed. Lock file installation completed successfully.
- Compilation: Solidity 0.8.38+commit.1835d247.Emscripten.clang, optimizer 200, Paris EVM.
- Focused local suite: **55 passed, 0 failed, 0 skipped** (`node --test test/contracts.test.mjs`).
- Mainnet runtime: **exact match for HRPToken and TokenSale**, including metadata and all immutable substitutions, at block **135486561**. See `bsc-mainnet.json`.
- Snapshot reads were routed through a read-only SSH RPC relay because the local Node HTTP transport timed out. No transactions were signed or sent, and no contracts or server settings were changed.
- Governance discrepancy: token and sale owners differ; see both READMEs and the snapshot. Publication is not a declaration that all production workflows are healthy.
- No external independent audit and no real-money purchase were performed for this publication.
