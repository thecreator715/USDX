#!/usr/bin/env node
// USDX keeper: runs without a browser. It trades from the receiver wallet to hold USDX at $1.00
// in the AMM pool, keeps standing DEX quotes around $1.00, and (when ISSUER_SEED is set)
// burns deposited BONSAI and mints USDX for them.
//
//   RECEIVER_SEED=sEd... [ISSUER_SEED=sEd...] LIVE=1 node keeper.mjs
//
// Without LIVE=1 it only prints what it would do. Seeds come from the environment, never from files.
import xrpl from 'xrpl';
import fs from 'node:fs';

const C = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
import { readFileSync as _rf } from 'node:fs';
// load KEY=VALUE lines from keeper/.env or ./.env (git-ignored); real environment variables win
for (const f of [new URL('./.env', import.meta.url), new URL('../.env', import.meta.url)]) {
  try { for (const l of _rf(f, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !l.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (_) {}
}
const E = process.env, LIVE = E.LIVE === '1';
const K = {
  band: (+E.BAND_BPS || 50) / 1e4, maxPct: (+E.MAX_TRADE_PCT || 20) / 100, slip: (+E.SLIP_BPS || 100) / 1e4,
  every: (+E.INTERVAL_SEC || 30) * 1000, pool: E.DEX_POOL || E.PEG_POOL_PRIMARY || 'bonsai', pegPools: (!E.PEG_POOL || E.PEG_POOL === 'both') ? ['bonsai', 'xrp'] : [E.PEG_POOL],
  hook: E.ALERT_WEBHOOK || '', floor: +E.PEG_FLOOR || 0.99,
  dexSize: +E.DEX_SIZE_USD || 500, dexSp: (+E.DEX_SPREAD_BPS || 30) / 1e4, ratio: +C.collateralRatioPercent || 100,
};
const log = (...a) => console.log(new Date().toISOString(), ...a);
const cc = s => { s = String(s).trim(); if (/^[0-9A-Fa-f]{40}$/.test(s)) return s.toUpperCase(); if (s.length === 3) return s; return Buffer.from(s, 'utf8').toString('hex').toUpperCase().padEnd(40, '0'); };
const BI = C.bonsai.issuer, UI = C.usdx.issuer, RECV = C.receiver;
const BONSAI = { currency: cc(C.bonsai.currency), issuer: BI }, USDX = { currency: cc(C.usdx.currency), issuer: UI };
const isUsdx = a => a && typeof a === 'object' && cc(a.currency) === USDX.currency && a.issuer === UI;
const aval = a => typeof a === 'string' ? Number(a) / 1e6 : Number(a.value);
const memo = (t, o) => ({ Memo: { MemoType: xrpl.convertStringToHex(t), MemoData: xrpl.convertStringToHex(JSON.stringify(o)) } });
const other = (kind, v) => kind === 'xrp' ? String(Math.round(v * 1e6)) : { ...BONSAI, value: Number(v).toFixed(6) };
const otherAsset = kind => kind === 'xrp' ? { currency: 'XRP' } : BONSAI;
const floor6 = n => (Math.floor(n * 1e6 + 1e-9) / 1e6).toFixed(6);

if (!E.RECEIVER_SEED) { console.error('Set RECEIVER_SEED (the seed of ' + RECV + ').'); process.exit(1); }
const recv = xrpl.Wallet.fromSeed(E.RECEIVER_SEED);
if (recv.address !== RECV) { console.error(`RECEIVER_SEED belongs to ${recv.address}, but config.json receiver is ${RECV}.`); process.exit(1); }
const iss = E.ISSUER_SEED ? xrpl.Wallet.fromSeed(E.ISSUER_SEED) : null;
if (iss && iss.address !== UI) { console.error(`ISSUER_SEED belongs to ${iss.address}, but config.json usdx issuer is ${UI}.`); process.exit(1); }

let client;
async function connect() {
  if (client && client.isConnected()) return client;
  let last;
  for (const u of C.servers) { try { const c = new xrpl.Client(u); await c.connect(); client = c; return c; } catch (e) { last = e; } }
  throw last || new Error('no XRPL server reachable');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const req = async r => {
  for (let a = 0; ; a++) {
    try { return (await (await connect()).request(r)).result; }
    catch (e) {
      const m = String(e && e.message || e);
      if (/rate limit|slowDown|too much load|units quota/i.test(m) && a < 8) {
        const t = /retry in ~?(\d+)\s*ms/i.exec(m);
        await sleep((t ? +t[1] : 3000) + 400 + Math.random() * 600); continue;
      }
      throw e;
    }
  }
};
let FEEBUMP = 1;
async function submit1(tx, wallet) {
  if (!LIVE) { log('DRY RUN', tx.TransactionType, JSON.stringify(tx.Amount || tx.TakerGets || tx.OfferSequence || '')); return 'dryrun'; }
  const c = await connect(), busy = /rate limit|slowDown|too much load|units quota/i;
  let prep; for (let a = 0; ; a++) { try { prep = await c.autofill(tx); if (FEEBUMP > 1) prep.Fee = String(Math.ceil(Number(prep.Fee) * FEEBUMP)); if (prep.LastLedgerSequence) prep.LastLedgerSequence += 30; break; } catch (e) { if (busy.test(String(e.message || e)) && a < 10) { await sleep(3000 + Math.random() * 1000); continue; } throw e; } }
  const signed = wallet.sign(prep), sub = await req({ command: 'submit', tx_blob: signed.tx_blob }), er = sub.engine_result || '';
  if (/^(tem|tef|tel)/.test(er) && er !== 'tefALREADY' && er !== 'tefPAST_SEQ') throw new Error(er + ' ' + tx.TransactionType);
  for (let i = 0; i < 90; i++) {
    await sleep(i ? 1000 : 2500); let r = null;
    try { r = await req({ command: 'tx', transaction: signed.hash }); } catch (e) { if (!/txnNotFound|rate limit|slowDown|too much load|units quota/i.test(String(e.message || e))) throw e; if (/rate limit|slowDown|too much load|units quota/i.test(String(e.message || e))) { await sleep(8000); continue; } }
    if (r && r.validated) { const code = (r.meta || r.metaData || {}).TransactionResult; if (code !== 'tesSUCCESS') throw new Error(code + ' ' + tx.TransactionType); return signed.hash; }
    if (!r && prep.LastLedgerSequence && (await req({ command: 'ledger_current' })).ledger_current_index > prep.LastLedgerSequence + 2) throw new Error('transaction expired before validation, nothing applied');
  }
  throw new Error('timed out waiting for validation of ' + signed.hash);
}
// sends a transaction and survives expiry, fee spikes and rate limits. Only retries when nothing was applied.
async function submit(tx, wallet, label) {
  const name = label || tx.TransactionType; let last;
  for (let a = 0; a < 4; a++) {
    FEEBUMP = 1 + a * 1.5;
    try { const h = await submit1(tx, wallet); FEEBUMP = 1; if (a) log(`${name}: confirmed on attempt ${a + 1}`); return h; }
    catch (e) {
      last = e; const m = String(e && e.message || e);
      const retry = /expired before validation|tefPAST_SEQ|tefMAX_LEDGER|telINSUF_FEE_P|terQUEUED|terPRE_SEQ|rate limit|slowDown|too much load|units quota/i.test(m);
      log(`ERROR ${name} (attempt ${a + 1}/4): ${m}${retry && a < 3 ? ' → retrying with a higher fee' : ''}`);
      if (!retry) break; await sleep(4000 + a * 4000);
    }
  }
  FEEBUMP = 1; throw last;
}
const lines = async a => (await req({ command: 'account_lines', account: a, ledger_index: 'validated', limit: 400 })).lines;
const xrpBal = async a => { try { return Number((await req({ command: 'account_info', account: a, ledger_index: 'validated' })).account_data.Balance) / 1e6; } catch { return 0; } };
const bal = (ls, x) => Number((ls.find(z => cc(z.currency) === cc(x.currency) && z.account === x.issuer) || { balance: 0 }).balance);

async function xrpUsd() {
  try { const j = await (await fetch('https://api.coinbase.com/v2/prices/XRP-USD/spot')).json(); if (+j.data.amount > 0) return +j.data.amount; } catch {}
  const j = await (await fetch('https://api.kraken.com/0/public/Ticker?pair=XRPUSD')).json(); const k = Object.keys(j.result)[0]; return +j.result[k].c[0];
}
async function prices() {
  const xrp = { currency: 'XRP' }, [ask, bid, amm] = await Promise.all([
    req({ command: 'book_offers', taker_gets: BONSAI, taker_pays: xrp, limit: 30 }).catch(() => null),
    req({ command: 'book_offers', taker_gets: xrp, taker_pays: BONSAI, limit: 30 }).catch(() => null),
    req({ command: 'amm_info', asset: xrp, asset2: BONSAI }).catch(() => null)]);
  // Depth-aware BONSAI/XRP price: pool first, then order-book mid, ignoring dust offers under MIN_DEPTH_XRP (default 5).
  const MIN = +E.MIN_DEPTH_XRP || 5, asks = [], bids = [];
  for (const o of ask?.offers || []) { const g = Number(o.taker_gets_funded?.value ?? o.TakerGets.value), x = Number(typeof o.taker_pays_funded === 'string' ? o.taker_pays_funded : o.TakerPays) / 1e6; if (g > 0 && x > 0) asks.push({ p: x / g, x }); }
  for (const o of bid?.offers || []) { const x = Number(typeof o.taker_gets_funded === 'string' ? o.taker_gets_funded : o.TakerGets) / 1e6, g = Number(o.TakerPays.value); if (g > 0 && x > 0) bids.push({ p: x / g, x }); }
  asks.sort((a, b) => a.p - b.p); bids.sort((a, b) => b.p - a.p);
  let pool = null; if (amm?.amm) { const { amount, amount2 } = amm.amm, x = typeof amount === 'string' ? amount : amount2, t = typeof amount === 'string' ? amount2 : amount; if (x && t && +t.value > 0) pool = { p: (Number(x) / 1e6) / Number(t.value), x: Number(x) / 1e6 }; }
  const sa = asks.find(o => o.x >= MIN), sb = bids.find(o => o.x >= MIN), man = +E.MANUAL_BONSAI_XRP;
  let bx, how, thin = false;
  if (man > 0) { bx = man; how = 'manual price'; }
  else if (pool && pool.x >= MIN) { bx = pool.p; how = 'AMM pool'; }
  else if (sa && sb) { bx = (sa.p + sb.p) / 2; how = 'order book mid'; }
  else if (sa || sb) { bx = (sa || sb).p; how = 'order book one side'; }
  else if (pool) { bx = pool.p; how = `thin AMM pool (${pool.x.toFixed(2)} XRP)`; thin = true; }
  else if (asks[0] || bids[0]) { bx = (asks[0] || bids[0]).p; how = 'thin order book'; thin = true; }
  else throw new Error('no BONSAI/XRP market found');
  const xu = await xrpUsd(); return { xrpUsd: xu, bonsaiXrp: bx, bonsaiUsd: bx * xu, how, thin };
}
async function poolInfo(kind) {
  try {
    const a = (await req({ command: 'amm_info', asset: otherAsset(kind), asset2: USDX, ledger_index: 'validated' })).amm;
    const uFirst = isUsdx(a.amount), u = uFirst ? a.amount : a.amount2, o = uFirst ? a.amount2 : a.amount;
    return { ro: aval(o), ru: aval(u), fee: a.trading_fee / 100000, acct: a.account, lpTotal: Number(a.lp_token && a.lp_token.value || 0) };
  } catch { return null; }
}

// right after a validated transaction the load-balanced public servers can still answer with the previous ledger, so wait until the reserves have actually moved
async function freshPool(kind, before) {
  let p = null;
  for (let i = 0; i < 10; i++) {
    p = await poolInfo(kind);
    if (p && (!before || Math.abs(p.ru - before.ru) > 1e-9 || Math.abs(p.ro - before.ro) > 1e-9)) return p;
    await sleep(1000);
  }
  return p;
}
const PENDING_BURN = { v: 0 };   // USDX recovered from pools, retired once every pool is back in the band

const lastAlert = {};
// log loudly and, if ALERT_WEBHOOK is set (Slack/Discord style {content}), post it. Same message is throttled to once per 15 min.
async function alert(msg) {
  log('ALERT:', msg); const now = Date.now(); if (lastAlert[msg] && now - lastAlert[msg] < 900000) return; lastAlert[msg] = now;
  if (K.hook) { try { await fetch(K.hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'USDX Treasury: ' + msg, text: 'USDX Treasury: ' + msg }) }); } catch (e) { log('webhook failed:', e.message); } }
}
// ---- smart peg defence -------------------------------------------------------------------------------------------
// USDX price in a pool = (other asset reserve / USDX reserve) x USD value of the other asset. The keeper moves it back to $1.00 with
// whichever of these tools the treasury can actually afford, cheapest first:
//   below $1 (too much USDX in the pool):  1) withdraw USDX single-sided from the treasury's LP tokens   2) buy USDX with the other asset   -> burn what it recovered
//   above $1 (too little USDX in the pool): 1) deposit treasury USDX single-sided   2) burn BONSAI, mint collateralised USDX, deposit it   3) withdraw the other asset single-sided
const MINT_ON = E.PEG_MINT !== '0';
const lpBal = async (pool) => { const ls = await lines(recv.address); const l = ls.find(z => z.account === pool.acct); return l ? Number(l.balance) : 0; };
const fmt6 = n => Number(n).toFixed(6);
const MIN_ACT = +E.PEG_MIN_USDX || 0.0005;   // pools are small, so corrections of a fraction of a cent matter
let OFFBAND = false;   // set while any pool is outside the band: the keeper then loops fast until it is restored
async function pegStep(px, kind, depth = 0) {
  const uu = kind === 'xrp' ? px.xrpUsd : px.bonsaiUsd, pool = await poolInfo(kind), nm = kind === 'xrp' ? 'XRP' : 'BONSAI';
  if (!pool) return log(`no ${kind}/USDX pool yet`);
  const price = pool.ro / pool.ru * uu;
  if (OFFBAND || Math.abs(price - 1) > K.band || Date.now() - (pegStep.last || 0) > 60000) { pegStep.last = Date.now(); log(`${kind}/USDX pool: USDX $${price.toFixed(5)} (${((price - 1) * 1e4).toFixed(0)} bps) · reserves ${pool.ro.toFixed(2)} ${nm} / ${pool.ru.toFixed(2)} USDX`); }
  if (price < K.floor) await alert(`USDX is $${price.toFixed(4)} in the ${kind}/USDX pool, below the $${K.floor} floor`);
  if (Math.abs(price - 1) <= K.band) return 'ok';
  OFFBAND = true;
  const cap = Math.abs(price - 1) > 0.01 ? 0.9 : K.maxPct, ls = await lines(recv.address);
  const usdxInv = bal(ls, USDX), bonsaiInv = bal(ls, BONSAI), xrpInv = Math.max(0, (await xrpBal(recv.address)) - 5);
  const otherInv = kind === 'xrp' ? xrpInv : bonsaiInv, lp = pool.lpTotal > 0 ? await lpBal(pool) : 0, share = pool.lpTotal > 0 ? lp / pool.lpTotal : 0;
  const AS = { Asset: otherAsset(kind), Asset2: USDX }, memoP = o => [memo('USDX/PEG', { v: 1, price, pool: kind, ...o })];
  let acted = false;
  if (price < 1) {
    // need = USDX to remove so that other/USDX x unitUsd = 1
    const need = Math.min(pool.ru * (1 - price), pool.ru * cap);
    if (need < MIN_ACT) return log(`correction of ${need.toFixed(6)} USDX is below the ${MIN_ACT} minimum action`);
    let got = 0;
    const out = Math.min(need, share * pool.ru * 0.9);
    if (out >= MIN_ACT) {
      try {
        log(`USDX below $1: withdrawing ${fmt6(out)} USDX from the pool with the treasury's LP tokens (${(share * 100).toFixed(2)}% of the pool)`);
        await submit({ TransactionType: 'AMMWithdraw', Account: recv.address, ...AS, Amount: { ...USDX, value: fmt6(out) }, Flags: 524288 }, recv, 'AMMWithdraw USDX'); got += out; acted = true;
      } catch (e) { log(`LP withdraw failed: ${e.message}`); }
    }
    const left = need - got;
    if (left >= MIN_ACT) {
      const p2 = acted ? await freshPool(kind, pool) : pool; if (!p2) return;
      const k = p2.ro * p2.ru, ru2 = Math.sqrt(k * uu), ro2 = Math.sqrt(k / uu), full = p2.ru - ru2, du = Math.min(left, full); // pStar = 1/uu
      if (du >= MIN_ACT && full > 0) {
        const dx = (ro2 - p2.ro) * (du / full), sendMax = dx / (1 - p2.fee) * (1 + K.slip);
        if (otherInv >= sendMax) {
          try { log(`USDX below $1: buying ${fmt6(du)} USDX with up to ${sendMax.toFixed(4)} ${nm}`); await submit({ TransactionType: 'Payment', Account: recv.address, Destination: recv.address, Amount: { ...USDX, value: fmt6(du) }, SendMax: other(kind, sendMax), Memos: memoP({ side: 'buy', usdx: du }) }, recv, 'peg buy'); got += du; acted = true; }
          catch (e) { log(`peg buy failed: ${e.message}`); }
        } else log(`peg buy needs ${sendMax.toFixed(4)} ${nm}, treasury has ${otherInv.toFixed(4)}. Add ${nm} to the receiver or LP tokens to defend the floor.`);
      }
    }
    if (got > 0) PENDING_BURN.v += got;   // retired once the pools are back in the band, so corrections are not slowed by an extra transaction each
  } else {
    const need = Math.min(pool.ru * (price - 1), pool.ru * cap);   // USDX to add so the price returns to $1
    if (need < MIN_ACT) return log(`correction of ${need.toFixed(6)} USDX is below the ${MIN_ACT} minimum action`);
    let added = 0;
    const have = Math.max(0, usdxInv - Math.min(0.5, usdxInv * 0.1));
    if (have >= MIN_ACT) {
      const x = Math.min(need, have);
      try { log(`USDX above $1: depositing ${fmt6(x)} treasury USDX into the pool`); await submit({ TransactionType: 'AMMDeposit', Account: recv.address, ...AS, Amount: { ...USDX, value: fmt6(x) }, Flags: 524288 }, recv, 'AMMDeposit USDX'); added += x; acted = true; }
      catch (e) { log(`USDX deposit failed: ${e.message}`); }
    }
    let left = need - added;
    if (left >= MIN_ACT && MINT_ON && iss && bonsaiInv > 0 && px.bonsaiUsd > 0) {
      // collateralised mint: burn BONSAI worth the USDX, issue exactly that much USDX, put it in the pool
      const x = Math.min(left, bonsaiInv * px.bonsaiUsd * 100 / K.ratio * 0.98), bonsaiBurn = x * K.ratio / 100 / px.bonsaiUsd;
      if (x >= MIN_ACT && bonsaiBurn <= bonsaiInv) {
        try {
          const dep = 'PEGMINT-' + Date.now();
          log(`USDX above $1 and the pool is short of USDX: burning ${bonsaiBurn.toFixed(4)} BONSAI to mint ${fmt6(x)} USDX`);
          const burn = await submit({ TransactionType: 'Payment', Account: recv.address, Destination: BI, Amount: { ...BONSAI, value: bonsaiBurn.toFixed(6) }, Memos: [memo('USDX/BURN', { v: 1, dep, bonsai: bonsaiBurn, to: recv.address })] }, recv, 'burn BONSAI');
          await submit({ TransactionType: 'Payment', Account: UI, Destination: recv.address, Amount: { ...USDX, value: fmt6(x) }, Memos: [memo('USDX/RECEIPT', { v: 1, dep, burn, bonsai: bonsaiBurn, rateUsd: px.bonsaiUsd, ratio: K.ratio, usdx: x })] }, iss, 'mint USDX');
          log(`MINTED ${fmt6(x)} USDX to the treasury · backed by ${bonsaiBurn.toFixed(4)} BONSAI burned`);
          await submit({ TransactionType: 'AMMDeposit', Account: recv.address, ...AS, Amount: { ...USDX, value: fmt6(x) }, Flags: 524288 }, recv, 'AMMDeposit USDX'); added += x; acted = true; left -= x;
        } catch (e) { log(`mint-and-deposit failed: ${e.message}`); }
      }
    }
    if (left >= MIN_ACT && share > 0) {
      const p2 = acted ? await freshPool(kind, pool) : pool; if (!p2) return;
      const y = Math.min(p2.ro - p2.ru / uu, p2.ro * cap, share * p2.ro * 0.9);   // other asset to remove so the price returns to $1
      if (y > 0) {
        const amt = kind === 'xrp' ? String(Math.floor(y * 1e6)) : { ...BONSAI, value: fmt6(y) };
        if (kind !== 'xrp' || Math.floor(y * 1e6) > 0) {
          try { log(`USDX above $1: withdrawing ${y.toFixed(4)} ${nm} from the pool with the treasury's LP tokens`); await submit({ TransactionType: 'AMMWithdraw', Account: recv.address, ...AS, Amount: amt, Flags: 524288 }, recv, 'AMMWithdraw ' + nm); acted = true; }
          catch (e) { log(`LP withdraw failed: ${e.message}`); }
        }
      }
    } else if (left >= MIN_ACT && !acted) log(`USDX above $1 by ${((price - 1) * 1e4).toFixed(0)} bps but the treasury has no USDX, no BONSAI to burn and no LP tokens. Fund the receiver to defend the ceiling.`);
  }
  if (acted) { const p3 = await freshPool(kind, pool); if (p3) { const pr3 = p3.ro / p3.ru * uu; log(`after rebalancing: USDX $${pr3.toFixed(5)} in the ${kind} pool`); return Math.abs(pr3 - 1) > K.band ? 'again' : 'fixed'; } }
  return acted ? 'fixed' : 'stuck';
}

const DEX_MIN = +E.DEX_MIN_USDX || 1;
async function dexFail(side, e) {
  log(`DEX ${side} quote failed: ${e.message}`);
  if (/INSUF_RESERVE|tecUNFUNDED|tecNO_LINE|tecFROZEN/.test(e.message)) {
    try {
      const ai = (await req({ command: 'account_info', account: recv.address, ledger_index: 'current' })).account_data, si = (await req({ command: 'server_info' })).info.validated_ledger || {};
      const need = (si.reserve_base_xrp || 1) + (si.reserve_inc_xrp || 0.2) * (ai.OwnerCount + 1);
      log(`DIAGNOSIS: receiver has ${Number(ai.Balance) / 1e6} XRP, ${ai.OwnerCount} owned objects, reserve with one more offer = ${need.toFixed(2)} XRP ${Number(ai.Balance) / 1e6 < need ? '→ ADD XRP to the receiver' : '(XRP looks sufficient, so the offer was rejected for another reason)'}`);
    } catch (x) { log('diagnosis failed:', x.message); }
    K.dexPause = Date.now() + 30 * 60000; log('DEX quotes paused for 30 min to avoid wasting fees; pools are still defended.');
  }
}
async function dexStep(px) {
  if (K.dexPause && Date.now() < K.dexPause) return;
  try {   // skip quoting (and its failing, fee-wasting offers) while the receiver has no XRP above its reserve
    const ai = (await req({ command: 'account_info', account: recv.address, ledger_index: 'current' })).account_data, si = (await req({ command: 'server_info' })).info.validated_ledger || {};
    const need = (si.reserve_base_xrp || 1) + (si.reserve_inc_xrp || 0.2) * (ai.OwnerCount + 2);
    if (Number(ai.Balance) / 1e6 < need) { K.dexPause = Date.now() + 10 * 60000; return log(`DEX quotes skipped: receiver has ${(Number(ai.Balance) / 1e6).toFixed(2)} XRP, needs ${need.toFixed(2)} XRP to hold another offer. Add XRP to the receiver.`); }
  } catch {}
  const kind = K.pool, uu = kind === 'xrp' ? px.xrpUsd : px.bonsaiUsd, sellP = (1 + K.dexSp) / uu, buyP = (1 - K.dexSp) / uu, size = K.dexSize;
  const ls = await lines(recv.address), usdxInv = bal(ls, USDX), otherInv = kind === 'xrp' ? (await xrpBal(recv.address)) - 5 : bal(ls, BONSAI);
  const offers = (await req({ command: 'account_offers', account: recv.address, limit: 200 })).offers || [], keep = { sell: false, buy: false };
  for (const o of offers) {
    const g = o.taker_gets, p = o.taker_pays, ug = isUsdx(g), up = isUsdx(p); if (!(ug || up)) continue;
    const oth = ug ? p : g; const ok = kind === 'xrp' ? typeof oth === 'string' : (typeof oth === 'object' && cc(oth.currency) === BONSAI.currency && oth.issuer === BI); if (!ok) continue;
    const side = ug ? 'sell' : 'buy', usdx = ug ? aval(g) : aval(p), pr = aval(oth) / usdx, tgt = side === 'sell' ? sellP : buyP;
    if (Math.abs(pr / tgt - 1) < 0.001 && usdx >= size * 0.5 && !keep[side]) keep[side] = true;
    else { log(`replacing stale ${side} quote at ${pr.toPrecision(6)}`); await submit({ TransactionType: 'OfferCancel', Account: recv.address, OfferSequence: o.seq }, recv); }
  }
  if (!keep.sell) { try { const n = Math.min(size, usdxInv * 0.95); if (n >= DEX_MIN) { log(`posting sell quote ${n.toFixed(2)} USDX @ ${sellP.toPrecision(6)}`); await submit({ TransactionType: 'OfferCreate', Account: recv.address, TakerGets: { ...USDX, value: n.toFixed(6) }, TakerPays: other(kind, n * sellP), Flags: 65536, Memos: [memo('USDX/QUOTE', { v: 1, side: 'sell', usdx: n, px: sellP })] }, recv); } else log('sell quote skipped: not enough USDX');  } catch (e) { await dexFail('sell', e); } }
  if (!keep.buy) { try { const n = Math.min(size, Math.max(0, otherInv) * 0.95 / buyP); if (n >= DEX_MIN) { log(`posting buy quote ${n.toFixed(2)} USDX @ ${buyP.toPrecision(6)}`); await submit({ TransactionType: 'OfferCreate', Account: recv.address, TakerGets: other(kind, n * buyP), TakerPays: { ...USDX, value: n.toFixed(6) }, Flags: 65536, Memos: [memo('USDX/QUOTE', { v: 1, side: 'buy', usdx: n, px: buyP })] }, recv); } else log('buy quote skipped: not enough of the other asset');  } catch (e) { await dexFail('buy', e); } }
}

// Burn deposited BONSAI and mint USDX. Needs ISSUER_SEED. Reads state from the ledger, so it is safe to restart.
const parse = e => {
  const t = e.tx_json || e.tx || {}, meta = e.meta || {}; let mt = null, mm = null;
  (t.Memos || []).forEach(m => { try { const ty = xrpl.convertHexToString(m.Memo.MemoType); if (ty.startsWith('USDX/')) { mt = ty; mm = JSON.parse(xrpl.convertHexToString(m.Memo.MemoData)); } } catch {} });
  return { t, hash: e.hash || t.hash, ok: e.validated !== false && meta.TransactionResult === 'tesSUCCESS', mt, mm, d: meta.delivered_amount || t.Amount };
};
async function history(addr, max) { const out = []; let marker; while (out.length < max) { const r = await req({ command: 'account_tx', account: addr, limit: 200, marker, ledger_index_min: -1, ledger_index_max: -1 }); out.push(...r.transactions); marker = r.marker; if (!marker) break; } return out; }
async function processDeposits(px) {
  if (!iss) return;
  if (px.thin) log(`note: the BONSAI price comes from a ${px.how}; minting at the live market price anyway.`);
  const rt = await history(RECV, 200), it = await history(UI, 400);   // recent pages only: cheap, and well inside the public servers' quota
  const deposits = [], burns = {}, receipts = new Set(), tburns = [];
  rt.map(parse).forEach(p => {
    if (!p.ok || p.t.TransactionType !== 'Payment') return;
    if (p.t.Destination === RECV && p.mt === 'USDX/MINT' && p.d && typeof p.d === 'object' && cc(p.d.currency) === BONSAI.currency && p.d.issuer === BI) deposits.push({ hash: p.hash, from: p.t.Account, value: Number(p.d.value) });
    if (p.t.Account === RECV && p.t.Destination === BI && p.mt === 'USDX/BURN' && p.mm) { burns[p.mm.dep] = p.hash; if (/^(TREASURY|GENESIS)-/.test(String(p.mm.dep)) && p.d && typeof p.d === 'object') tburns.push({ hash: p.mm.dep, burnHash: p.hash, from: p.mm.to || RECV, value: Number(p.d.value) }); }
  });
  it.map(parse).forEach(p => { if (p.ok && p.t.Account === UI && p.mt === 'USDX/RECEIPT' && p.mm) receipts.add(p.mm.dep); });
  // burns signed by the receiver wallet itself in the app (treasury mode): the burn is already on-chain, only the mint is missing
  for (const b of tburns.filter(x => !receipts.has(x.hash))) {
    const usdx = Number(floor6(b.value * px.bonsaiUsd * 100 / K.ratio)); if (!(usdx > 0)) continue;
    log(`treasury burn ${b.burnHash.slice(0, 10)}: ${b.value} BONSAI -> ${usdx} USDX to ${b.from}`);
    try { await submit({ TransactionType: 'Payment', Account: UI, Destination: b.from, Amount: { ...USDX, value: usdx.toFixed(6) }, Memos: [memo('USDX/RECEIPT', { v: 1, dep: b.hash, burn: b.burnHash, bonsai: b.value, rateUsd: px.bonsaiUsd, ratio: K.ratio, usdx })] }, iss).then(h => log(`MINTED ${usdx} USDX to ${b.from} · ${h}`)); }
    catch (e) { log('treasury mint failed:', e.message); }
  }
  for (const d of deposits.filter(x => !receipts.has(x.hash))) {
    const usdx = Number(floor6(d.value * px.bonsaiUsd * 100 / K.ratio)); if (!(usdx > 0)) continue;
    log(`deposit ${d.hash.slice(0, 10)}: ${d.value} BONSAI from ${d.from} -> ${usdx} USDX`);
    try {
      const burn = burns[d.hash] || await submit({ TransactionType: 'Payment', Account: RECV, Destination: BI, Amount: { ...BONSAI, value: d.value.toFixed(6) }, Memos: [memo('USDX/BURN', { v: 1, dep: d.hash, bonsai: d.value })] }, recv);
      await submit({ TransactionType: 'Payment', Account: UI, Destination: d.from, Amount: { ...USDX, value: usdx.toFixed(6) }, Memos: [memo('USDX/RECEIPT', { v: 1, dep: d.hash, burn, bonsai: d.value, rateUsd: px.bonsaiUsd, ratio: K.ratio, usdx })] }, iss);
    } catch (e) { log('deposit failed:', e.message); }
  }
}

// ---- USDX yield: a guaranteed 5% APY paid daily to every holder (snapshot at the first cycle of each UTC day) ----
const YIELD_APY = (E.YIELD === '0') ? 0 : (+E.YIELD_APY || +C.yieldApyPercent || 0) / 100;
const YIELD_MIN = +E.YIELD_MIN_USDX || 0.0001, YIELD_BATCH = +E.YIELD_BATCH || 40;
let YIELD_DONE = '';
const utcDay = () => new Date().toISOString().slice(0, 10);
async function holders(excl) {
  const out = []; let marker;
  do { const r = await req({ command: 'account_lines', account: UI, ledger_index: 'validated', limit: 400, marker }); marker = r.marker;
    for (const l of r.lines) if (cc(l.currency) === USDX.currency && Number(l.balance) < 0 && !excl.has(l.account)) out.push({ addr: l.account, bal: -Number(l.balance) }); } while (marker);
  return out;
}
async function yieldStep(px) {
  if (!iss || !YIELD_APY) return;
  const day = utcDay(); if (day < (E.YIELD_START || C.yieldStart || '2026-12-01')) return; if (YIELD_DONE === day) return;   // rewards begin December 2026

  const rt = (await history(RECV, 400)).map(parse);
  if (rt.some(p => p.ok && p.t.Account === RECV && p.mt === 'USDX/YIELDDONE' && p.mm && p.mm.day === day)) { YIELD_DONE = day; return; }
  const excl = new Set([UI, RECV]);
  for (const k of ['bonsai', 'xrp']) { const p = await poolInfo(k).catch(() => null); if (p && p.acct) excl.add(p.acct); }
  const hs = (await holders(excl)).filter(h => h.bal * YIELD_APY / 365 >= YIELD_MIN);
  const it = (await history(UI, 1000)).map(parse), paid = new Set();
  it.forEach(p => { if (p.ok && p.t.Account === UI && p.mt === 'USDX/YIELD' && p.mm && p.mm.day === day) paid.add(p.t.Destination); });
  const todo = hs.filter(h => !paid.has(h.addr)).map(h => ({ ...h, amt: Number(floor6(h.bal * YIELD_APY / 365)) })).filter(h => h.amt >= YIELD_MIN);
  const total = hs.reduce((s, h) => s + Number(floor6(h.bal * YIELD_APY / 365)), 0);
  log(`yield ${day}: ${hs.length} eligible holders, ${paid.size} already paid today, ${todo.length} to pay, ${total.toFixed(6)} USDX for the day at ${(YIELD_APY * 100).toFixed(2)}% APY`);
  if (!todo.length && paid.size === 0 && hs.length === 0) { YIELD_DONE = day; return; }
  // 1) collateral: burn treasury BONSAI worth the new USDX before issuing it (once per day)
  const covered = rt.some(p => p.ok && p.t.Account === RECV && p.t.Destination === BI && p.mt === 'USDX/COVER' && p.mm && p.mm.day === day && p.mm.kind === 'yield');
  let burned = 0;
  if (!covered && total > 0) {
    const need = total * 100 / K.ratio / px.bonsaiUsd, have = bal(await lines(RECV), BONSAI), amt = Math.min(need, have);
    if (amt > 0) { try { await submit({ TransactionType: 'Payment', Account: RECV, Destination: BI, Amount: { ...BONSAI, value: floor6(amt) }, Memos: [memo('USDX/COVER', { v: 1, kind: 'yield', day, usdx: total, bonsai: amt, rateUsd: px.bonsaiUsd })] }, recv); burned = amt; log(`yield cover: burned ${floor6(amt)} BONSAI`); } catch (e) { log('yield cover failed:', e.message); } }
    if (amt < need) { log(`yield cover SHORT by ${floor6(need - amt)} BONSAI`); await alert(`USDX yield for ${day} is short of collateral by ${floor6(need - amt)} BONSAI. Add BONSAI to the treasury.`); }
  }
  // 2) pay holders (a batch per cycle so a run never overruns; the rest follow next cycle)
  let n = 0;
  for (const h of todo.slice(0, YIELD_BATCH)) {
    try { await submit({ TransactionType: 'Payment', Account: UI, Destination: h.addr, Amount: { ...USDX, value: h.amt.toFixed(6) }, Memos: [memo('USDX/YIELD', { v: 1, day, apy: YIELD_APY, bal: h.bal })] }, iss); n++; }
    catch (e) { log(`yield to ${h.addr} failed:`, e.message); }
  }
  log(`yield: paid ${n} holders this cycle, ${Math.max(0, todo.length - n)} remaining`);
  if (todo.length - n <= 0 && LIVE) { try { await submit({ TransactionType: 'Payment', Account: RECV, Destination: UI, Amount: '1', Memos: [memo('USDX/YIELDDONE', { v: 1, day, holders: hs.length, usdx: total, bonsaiBurned: burned })] }, recv); YIELD_DONE = day; log('yield: day complete'); } catch (e) { log('yield marker failed:', e.message); } }
}

// ---- XRPL Batch (XLS-56): withdraw/deposit on both pools in ONE transaction, so both pools are corrected in the same ledger ----
let BATCH_OK = E.BATCH !== '0';
const INNER = 0x40000000;   // tfInnerBatchTxn
async function fastBatch(px) {
  if (!BATCH_OK || K.pegPools.length < 2) return false;
  const ls = await lines(recv.address); let usdxLeft = Math.max(0, bal(ls, USDX) - Math.min(0.5, bal(ls, USDX) * 0.1)); const ops = [], before = {};
  for (const kind of K.pegPools) {
    const uu = kind === 'xrp' ? px.xrpUsd : px.bonsaiUsd, pool = await poolInfo(kind); if (!pool) continue;
    const price = pool.ru > 0 ? pool.ro / pool.ru * uu : 1; if (Math.abs(price - 1) <= K.band) continue;
    const AS = { Asset: otherAsset(kind), Asset2: USDX };
    if (price < 1) {
      const need = Math.min(pool.ru * (1 - price), pool.ru * 0.9), lp = pool.lpTotal > 0 ? await lpBal(pool) : 0, share = pool.lpTotal > 0 ? lp / pool.lpTotal : 0, out = Math.min(need, share * pool.ru * 0.9);
      if (out >= MIN_ACT) { ops.push({ kind, out, tx: { TransactionType: 'AMMWithdraw', Account: recv.address, ...AS, Amount: { ...USDX, value: fmt6(out) }, Flags: 524288 } }); before[kind] = pool; }
    } else {
      const need = Math.min(pool.ru * (price - 1), pool.ru * 0.9), x = Math.min(need, usdxLeft);
      if (x >= MIN_ACT) { usdxLeft -= x; ops.push({ kind, out: 0, tx: { TransactionType: 'AMMDeposit', Account: recv.address, ...AS, Amount: { ...USDX, value: fmt6(x) }, Flags: 524288 } }); before[kind] = pool; }
    }
  }
  if (ops.length < 2) return false;   // one pool off: the normal path handles it with a single transaction
  try {
    log(`BATCH re-peg: ${ops.map(o => `${o.kind} ${o.tx.TransactionType} ${o.tx.Amount.value}`).join(' + ')} in one transaction`);
    await submit({ TransactionType: 'Batch', Account: recv.address, Flags: 524288 /* tfIndependent: each pool is corrected on its own */, RawTransactions: ops.map(o => ({ RawTransaction: { ...o.tx, Flags: o.tx.Flags + INNER } })), Memos: [memo('USDX/PEG', { v: 1, batch: ops.length })] }, recv, 'Batch re-peg');
    PENDING_BURN.v += ops.reduce((a, o) => a + o.out, 0);
    for (const o of ops) await freshPool(o.kind, before[o.kind]);
    return true;
  } catch (e) {
    const m = String(e && e.message || e);
    if (/temINVALID|temDISABLED|temMALFORMED|temBAD|tefNO|tecBATCH|not supported|unknown|Invalid|Unsupported/i.test(m)) { BATCH_OK = false; log('Batch not usable here, using single transactions from now on:', m); }
    else log('batch re-peg failed, falling back to single transactions:', m);
    return false;
  }
}

// re-peg loop: as soon as a pool leaves the band, keep correcting (and re-reading the price) until it is back, then return to the slow cycle
async function repeg(px) {
  let again = false;
  await fastBatch(px).catch(e => log('batch:', e.message));
  for (const kind of K.pegPools) {
    let r = '', n = 0;
    do {
      try { r = await pegStep(px, kind); } catch (e) { log(`peg ${kind}:`, e.message); await alert(`peg defence failed in the ${kind} pool: ${e.message}`); r = 'stuck'; }
      if (r === 'again') { n++; px = await prices().catch(() => px); }
    } while (r === 'again' && n < 8);
    if (r === 'again') { again = true; log(`${kind}: still outside the band after ${n} corrections, continuing`); }
  }
  if (!again && PENDING_BURN.v > 0.000001) {
    try { const have = bal(await lines(recv.address), USDX), burn = Math.min(have, PENDING_BURN.v); PENDING_BURN.v = 0;
      if (burn >= 0.000001) { await submit({ TransactionType: 'Payment', Account: recv.address, Destination: UI, Amount: { ...USDX, value: fmt6(burn) }, Memos: [memo('USDX/PEGBURN', { v: 1, usdx: burn })] }, recv, 'burn recovered USDX'); log(`retired ${fmt6(burn)} USDX`); } }
    catch (e) { log('retire failed:', e.message); }
  }
  OFFBAND = again;   // fast loop only while corrections are actually moving the price; a pool that cannot be corrected falls back to the normal cycle
}

async function cycle() {
  const px = await prices(); log(`BONSAI $${px.bonsaiUsd.toFixed(10)} (${px.how}) · XRP $${px.xrpUsd.toFixed(4)}`);
  await processDeposits(px).catch(e => log('processor:', e.message));
  await yieldStep(px).catch(e => log('yield:', e.message));
  await repeg(px);
  await dexStep(px).catch(e => log('dex:', e.message));
}
log(LIVE ? 'LIVE mode: transactions will be submitted' : 'DRY RUN: nothing is submitted. Set LIVE=1 to trade.');
log(`receiver ${RECV}${iss ? ' · issuer key loaded, deposits will be processed' : ' · no issuer key, deposits are not processed'} · defending pools ${K.pegPools.join(' + ')} · DEX quotes in ${K.pool}`);
// Main loop. The peg is checked every few seconds (and every 2 s while a pool is off the peg); deposits, yield and DEX quotes are heavier on the public
// servers' rate limit, so they run once a minute and never while a correction is under way.
const POLL = (+E.PEG_POLL_SEC || 8) * 1000, HEAVY = (+E.HEAVY_SEC || 60) * 1000; let lastHeavy = 0;
for (;;) {
  try {
    const px = await prices(), heavy = !OFFBAND && Date.now() - lastHeavy >= HEAVY;
    if (heavy) {
      lastHeavy = Date.now(); log(`BONSAI $${px.bonsaiUsd.toFixed(10)} (${px.how}) · XRP $${px.xrpUsd.toFixed(4)}`);
      await processDeposits(px).catch(e => log('processor:', e.message));
      await yieldStep(px).catch(e => log('yield:', e.message));
    }
    await repeg(px);
    if (heavy && !OFFBAND) await dexStep(px).catch(e => log('dex:', e.message));
  } catch (e) { log('cycle error:', e.message); }
  await new Promise(r => setTimeout(r, OFFBAND ? 2000 : POLL));
}
