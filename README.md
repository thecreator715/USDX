# USDX Treasury

XRPL mainnet app for USDX, a token minted by burning BONSAI at its dollar value.

- `index.html` is the whole app. It needs no build step.
- `config.json` sets the XRPL servers (tried in order), the BONSAI and USDX issuers, the receiver wallet and the collateral ratio. Edit it to change what the site connects to. Settings saved in a visitor's browser override it.
- Wallet seeds are never stored in this repo or in the browser. They are typed in at runtime and live only in that tab's memory.

## Publish on GitHub Pages

Repo Settings, Pages, deploy from branch `main`, folder `/ (root)`.

## Flow

1. A user sends BONSAI to the receiver wallet with a mint memo.
2. The receiver returns that BONSAI to its issuer, which burns it.
3. The USDX issuer pays USDX to the user, priced at the BONSAI market price.

The Peg & Pools page keeps USDX at $1.00 with the BONSAI/USDX and XRP/USDX AMM pools, and checks that burned BONSAI covers all USDX outstanding.
