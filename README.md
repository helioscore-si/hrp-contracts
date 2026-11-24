# HELIOS PRIME (HRP) contracts

Public source disclosure for the deployed HELIOS PRIME token and primary sale on **BNB Smart Chain (chain ID 56)**. [Русская версия](README.ru.md).

| Contract | BSC mainnet address |
| --- | --- |
| HRPToken | [`0x4c1B827fB12033f67BA0Cc2B5E56acbd777FF1A4`](https://bscscan.com/address/0x4c1B827fB12033f67BA0Cc2B5E56acbd777FF1A4) |
| TokenSale | [`0x36BE17219da82f050e7A17B69e6C9da293614074`](https://bscscan.com/address/0x36BE17219da82f050e7A17B69e6C9da293614074) |
| Payment token: USDT on BSC | [`0x55d398326f99059fF775485246999027B3197955`](https://bscscan.com/address/0x55d398326f99059fF775485246999027B3197955) |

Website: <https://helioscore.si>. These addresses identify contracts; do not send funds to them manually as a substitute for the purchase flow.

## Scope and verification

This repository contains the original Solidity sources, local EVM tests, the small purchase/receipt helpers used by those tests, and a read-only deployment verification script. It does not include the production website, customer database, KYC records, operational keys, or server configuration.

`deployments/bsc-mainnet.json` records a **point-in-time** chain snapshot. `exactRuntimeMatch` means the compiled deployed bytecode, including metadata and the on-chain immutable values, matched the runtime at the recorded block. State such as the owner, treasury, pause and transfer flags may subsequently change. Re-run verification for a fresh snapshot.

**No independent external security audit has been completed.** Build verification and local tests are not an audit or a guarantee. Publishing this repository does not change contracts, enable transfers, create liquidity, or assign a market price to HRP. Some original Solidity comments say “pre-release”; they are preserved byte-for-byte for reproducibility. Deployment information is in the snapshot, not those historical comments.

## Reproduce the build and tests

Use Node.js 22 or newer with npm:

```sh
npm ci --ignore-scripts
npm test
```

Pinned compiler: **solc 0.8.38**, optimizer enabled with **200 runs**, **Paris EVM**. OpenZeppelin Contracts **5.6.1**. See `package-lock.json` for dependency integrity hashes. Solidity sources are unchanged from the disclosure input; preserve their paths and contents to reproduce metadata.

Tests run in a local Ganache EVM with generated test accounts and mock USDT. They do not spend real funds or deploy to mainnet. They cover supply, the ten-lot bonus threshold, cross-round bonuses, caps, payment routing, pause/hold, owner restrictions, replay protection, deadline/minimum output checks, reentrancy, transaction rollback and receipt validation. This is a focused contract suite, not the complete private portal/KYC integration suite. Ganache may print a JavaScript fallback notice; the compiler may warn about a future reserved identifier in the pinned OpenZeppelin dependency.

```sh
npm run verify:mainnet
# Optional read-only RPC override (POSIX shell):
BSC_RPC_URL=https://your-bsc-rpc.example npm run verify:mainnet
```

The verification script only reads RPC data; it has no signing key or transaction submission. RPC availability and historical-state support depend on the provider. It replaces the local snapshot file after a successful check.

## Token and sale rules

- Symbol **HRP**, **18 decimals**, fixed supply **20,000,000 HRP**. No external mint, burn, or proxy upgrade entry point.
- Initial allocation: **19,600,000 HRP** to the company vault and **400,000 HRP** to the reserve. One-time sale binding funds **3,790,000 HRP** from the company allocation, leaving **15,810,000 HRP** there immediately after funding.
- One lot purchases **100 HRP for 100 USDT**. The sale price is not a guaranteed market or redemption price.
- Five rounds have paid-lot caps `2000 / 6000 / 8000 / 10000 / 1000` and bonus rates `100% / 60% / 40% / 20% / 10%`.
- Before ten cumulative paid lots, no token bonus is delivered. The purchase crossing ten lots receives the current round's bonus on all cumulative lots; later purchases receive the current rate on new lots only. Accumulation is per buyer address. A purchase cannot span a round; round progression is an owner action.
- Primary purchases close at **2027-01-25 07:00:00 UTC**. Previously reserved external payments have separate settlement windows.
- The token bonus is separate from off-chain partner commissions and cumulative privileges. Those programs are not implemented by these two contracts.

## Governance, admission and transfer restrictions

The token and sale use `Ownable2Step`; the snapshot identifies each current owner and its Safe signers. Sensitive transfer-policy, treasury and service-role configuration validates a two-owner, threshold-two governance contract with no enabled modules. Other owner-only actions include sale pause and round advancement. Revisions prevent stale transfer-policy, treasury and service-role actions from executing.

**Snapshot warning (2026-11-24, block 135486561):** HRPToken is owned by Safe `0xBabfE0Fc7C1de0d283B2cf95E61D570aBF5E6c79`, while TokenSale is owned by Safe `0xA2aA81FCF7dd61D77bd09AFF680c997Ca989E437`. Both report two owners, threshold two and no enabled modules. Ownership is not aligned: sale functions using `_requireGovernance` (`setTreasury`, `setAdmissionSigner`, `setSettlementOperator`) require matching ownership and will revert in this snapshot. This does not by itself prove purchases are unavailable; no production purchase was made for this publication. Ordinary token transfers were locked and the sale pause flag was false. The repository only discloses this state and does not repair or change it.

Ordinary HRP transfers are controlled by a global lock, including company and reserve transfers. The bound sale has a dedicated delivery route while ordinary transfers are locked. The optional buyback hook requires a separately configured contract and holder allowance; this repository does not provide a buyback payment contract or promise redemption. Ownership renunciation is disabled.

Direct `buy` requires an admitted address. `buyAuthorized` accepts a short-lived EIP-712 purchase authorization from the configured admission signer, binding chain, sale, buyer, lots, round, order ID, expiry, minimum HRP and revision. KYC is enforced by the portal/service, not by passport checks inside Solidity.

ERC20/TRC20 payment settlement relies on an authorized service attesting finalized source-chain payments within a Safe-configured lot budget. **The BSC contract cannot independently prove Ethereum or TRON payment validity.** Service compromise is a trust risk. Reservations, payment identifiers and order state prevent duplicate settlement but do not replace source-chain verification. HRP remains a BSC token regardless of the USDT payment network.

## Layout and licensing

- `contracts/`: original production Solidity; `contracts/test/`: test-only contracts.
- `test/`: local EVM suite and bonus reference model.
- `integration/`, `server/receipt-verifier.mjs`: unsigned purchase and read-only receipt helpers used by tests.
- `scripts/`: local compiler and read-only mainnet verifier.
- `deployments/`: public, dated verification evidence.

The original project sources retain `SPDX-License-Identifier: UNLICENSED`. Public visibility is source disclosure, not a grant of an MIT or other open-source license. Third-party packages keep their own licenses; see `THIRD-PARTY-NOTICES.md`.
