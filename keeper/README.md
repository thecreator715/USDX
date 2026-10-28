# USDX keeper

Runs on a machine that stays on (your Mac, a server) so the peg is defended without a browser tab open.

```
cd keeper
npm install
RECEIVER_SEED=sEd... node keeper.mjs            # dry run: prints what it would do
RECEIVER_SEED=sEd... LIVE=1 node keeper.mjs     # trades for real
```

Add `ISSUER_SEED=sEd...` to also burn deposited BONSAI and mint USDX for it.

Each cycle (default 30 s) it:
1. reads the BONSAI price from the XRPL order book and AMM (lowest wins) and XRP/USD from Coinbase or Kraken;
2. burns BONSAI that users deposited and mints their USDX (only with `ISSUER_SEED`);
3. checks the USDX pool price. Below $1 it buys USDX from the pool and sends it to the issuer to retire it. Above $1 it sells its own USDX into the pool;
4. keeps a sell and a buy quote on the DEX around $1.00 and re-posts them when the BONSAI price moves.

Settings come from `../config.json` and these optional variables: `PEG_POOL` (`bonsai` or `xrp`), `BAND_BPS` (50), `MAX_TRADE_PCT` (20), `SLIP_BPS` (100), `DEX_SIZE_USD` (500), `DEX_SPREAD_BPS` (30), `INTERVAL_SEC` (30).

Seeds are read from the environment only. Never put them in a file in this repo.
