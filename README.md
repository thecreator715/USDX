# USDX Treasury

XRPL mainnet app for USDX, a token minted by burning BONSAI at its dollar value.

- `index.html` is the whole app. It needs no build step.
- `config.json` sets the XRPL servers (tried in order), the BONSAI and USDX issuers, the receiver wallet and the collateral ratio. Edit it to change what the site connects to. Settings saved in a visitor's browser override it.
- `bonsaiReceiver` in `config.json` is the BONSAI receiver wallet the app tracks. The BONSAI issuer is the burn address, and every payment into it is listed on the Supply & Burns page.
- Wallet seeds are never stored in this repo or in the browser. They are typed in at runtime and live only in that tab's memory.

## Publish on GitHub Pages

Repo Settings, Pages, deploy from branch `main`, folder `/ (root)`.

## Flow

1. A user sends BONSAI to the receiver wallet with a mint memo.
2. The receiver returns that BONSAI to its issuer, which burns it.
3. The USDX issuer pays USDX to the user, priced at the BONSAI market price.

The Peg & Pools page keeps USDX at $1.00 with the BONSAI/USDX and XRP/USDX AMM pools, and checks that burned BONSAI covers all USDX outstanding.

## Keeper

`keeper/` is a Node script that defends the peg and keeps DEX quotes from the receiver wallet without a browser. See `keeper/README.md`. It starts in dry-run mode.

## Always-on keeper (GitHub Actions)

`.github/workflows/keeper.yml` runs the keeper every 5 minutes on GitHub, so peg defence, DEX quotes and USDX minting
for BONSAI deposits keep running with every browser closed. Add these in **Settings > Secrets and variables > Actions**:
`RECEIVER_SEED`, `ISSUER_SEED` (and optionally `ALERT_WEBHOOK`). Secrets are encrypted and never appear in the repo or the page.

## USDX yield (5% APY)
The keeper pays a guaranteed 5% APY in USDX to every holder, once per UTC day, from a snapshot of balances (issuer, treasury and pool accounts excluded; payouts under 0.0001 USDX are skipped). Each day the treasury first burns BONSAI worth the new USDX (memo `USDX/COVER`, kind `yield`), then the issuer pays holders (memo `USDX/YIELD`), then a `USDX/YIELDDONE` marker closes the day. Set `yieldApyPercent` in `config.json`, or `YIELD=0` to switch it off.
