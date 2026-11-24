# Third-party dependencies

Dependencies are installed from npm, not vendored into this repository. Their original license and copyright files remain in the installed packages. See `package-lock.json` for transitive dependencies and exact integrity hashes.

| Dependency | Version | License | Role |
| --- | --- | --- | --- |
| @openzeppelin/contracts | 5.6.1 | MIT | Solidity libraries |
| ethers | 6.17.0 | MIT | EVM interfaces, test and read-only RPC helpers |
| ganache | 7.9.2 | MIT | Local test chain only |
| solc (solc-js wrapper) | 0.8.38 | MIT | JavaScript compiler interface; compiler components retain their upstream licenses |

No third-party license is replaced by the project's UNLICENSED identifier. Inspect the corresponding installed package before redistributing bundled dependencies.
