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
async function submit(tx, wallet) {
  if (!LIVE) { log('DRY RUN', tx.TransactionType, JSON.stringify(tx.Amount || tx.TakerGets || tx.OfferSequence || '')); return 'dryrun'; }
  const c = await connect(), busy = /rate limit|slowDown|too much load|units quota/i;
  let prep; for (let a = 0; ; a++) { try { prep = await c.autofill(tx); break; } catch (e) { if (busy.test(String(e.message || e)) && a < 10) { await sleep(3000 + Math.random() * 1000); continue; } throw e; } }
  const signed = wallet.sign(prep), sub = await req({ command: 'submit', tx_blob: signed.tx_blob }), er = sub.engine_result || '';
  if (/^(tem|tef|tel)/.test(er) && er !== 'tefALREADY' && er !== 'tefPAST_SEQ') throw new Error(er + ' ' + tx.TransactionType);
  for (let i = 0; i < 90; i++) {
    await sleep(i ? 2000 : 1200); let r = null;
    try { r = await req({ command: 'tx', transaction: signed.hash }); } catch (e) { if (!/txnNotFound|rate limit|slowDown|too much load|units quota/i.test(String(e.message || e))) throw e; if (/rate limit|slowDown|too much load|units quota/i.test(String(e.message || e))) { await sleep(8000); continue; } }
    if (r && r.validated) { const code = (r.meta || r.metaData || {}).TransactionResult; if (code !== 'tesSUCCESS') throw new Error(code + ' ' + tx.TransactionType); return signed.hash; }
    if (!r && prep.LastLedgerSequence && (await req({ command: 'ledger_current' })).ledger_current_index > prep.LastLedgerSequence + 2) throw new Error('transaction expired before validation, nothing applied');
  }
  throw new Error('timed out waiting for validation of ' + signed.hash);
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
    return { ro: aval(o), ru: aval(u), fee: a.trading_fee / 100000 };
  } catch { return null; }
}

const lastAlert = {};
// log loudly and, if ALERT_WEBHOOK is set (Slack/Discord style {content}), post it. Same message is throttled to once per 15 min.
async function alert(msg) {
  log('ALERT:', msg); const now = Date.now(); if (lastAlert[msg] && now - lastAlert[msg] < 900000) return; lastAlert[msg] = now;
  if (K.hook) { try { await fetch(K.hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'USDX Treasury: ' + msg, text: 'USDX Treasury: ' + msg }) }); } catch (e) { log('webhook failed:', e.message); } }
}
async function pegStep(px, kind) {
  const uu = kind === 'xrp' ? px.xrpUsd : px.bonsaiUsd, pool = await poolInfo(kind);
  if (!pool) return log(`no ${kind}/USDX pool yet`);
  const price = pool.ro / pool.ru * uu; log(`USDX = $${price.toFixed(5)} in the ${kind} pool (${((price - 1) * 1e4).toFixed(0)} bps)`);
  if (price < K.floor) await alert(`USDX is $${price.toFixed(4)} in the ${kind}/USDX pool, below the $${K.floor} floor`);
  if (Math.abs(price - 1) <= K.band) return;
  const pStar = 1 / uu, k = pool.ro * pool.ru, ru2 = Math.sqrt(k / pStar), ro2 = Math.sqrt(k * pStar);
  const cap = price < 0.99 ? Math.min(0.5, K.maxPct * 2) : K.maxPct, ls = await lines(recv.address);
  const usdxInv = bal(ls, USDX), otherInv = kind === 'xrp' ? (await xrpBal(recv.address)) - 3 : bal(ls, BONSAI);
  if (price < 1) {
    const full = pool.ru - ru2, du = Math.min(full, pool.ru * cap); if (du < 1) return;
    const dx = (ro2 - pool.ro) * (du / full), sendMax = dx / (1 - pool.fee) * (1 + K.slip);
    if (otherInv < sendMax) return log(`peg defence needs ${sendMax.toFixed(2)} ${kind}, treasury has ${Math.max(0, otherInv).toFixed(2)}`);
    log(`USDX below $1: buying ${du.toFixed(2)} USDX with up to ${sendMax.toFixed(2)}`);
    await submit({ TransactionType: 'Payment', Account: recv.address, Destination: recv.address, Amount: { ...USDX, value: du.toFixed(6) }, SendMax: other(kind, sendMax), Memos: [memo('USDX/PEG', { v: 1, side: 'buy', usdx: du, price, pool: kind })] }, recv);
    await submit({ TransactionType: 'Payment', Account: recv.address, Destination: UI, Amount: { ...USDX, value: du.toFixed(6) }, Memos: [memo('USDX/PEGBURN', { v: 1, usdx: du })] }, recv);
  } else {
    const full = ru2 - pool.ru, dux = Math.min(full, pool.ru * cap); if (dux < 1) return;
    const out = (pool.ro - ro2) * (dux / full) * (1 - K.slip), sendMax = dux / (1 - pool.fee) * (1 + K.slip);
    if (usdxInv < sendMax) return log(`USDX above $1 but treasury has ${usdxInv.toFixed(2)} USDX, needs ${sendMax.toFixed(2)}`);
    log(`USDX above $1: selling up to ${sendMax.toFixed(2)} USDX`);
    await submit({ TransactionType: 'Payment', Account: recv.address, Destination: recv.address, Amount: other(kind, out), SendMax: { ...USDX, value: sendMax.toFixed(6) }, Memos: [memo('USDX/PEG', { v: 1, side: 'sell', usdx: dux, price, pool: kind })] }, recv);
  }
}

async function dexStep(px) {
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
  if (!keep.sell) { const n = Math.min(size, usdxInv * 0.95); if (n >= 10) { log(`posting sell quote ${n.toFixed(2)} USDX @ ${sellP.toPrecision(6)}`); await submit({ TransactionType: 'OfferCreate', Account: recv.address, TakerGets: { ...USDX, value: n.toFixed(6) }, TakerPays: other(kind, n * sellP), Flags: 65536, Memos: [memo('USDX/QUOTE', { v: 1, side: 'sell', usdx: n, px: sellP })] }, recv); } else log('sell quote skipped: not enough USDX'); }
  if (!keep.buy) { const n = Math.min(size, Math.max(0, otherInv) * 0.95 / buyP); if (n >= 10) { log(`posting buy quote ${n.toFixed(2)} USDX @ ${buyP.toPrecision(6)}`); await submit({ TransactionType: 'OfferCreate', Account: recv.address, TakerGets: other(kind, n * buyP), TakerPays: { ...USDX, value: n.toFixed(6) }, Flags: 65536, Memos: [memo('USDX/QUOTE', { v: 1, side: 'buy', usdx: n, px: buyP })] }, recv); } else log('buy quote skipped: not enough of the other asset'); }
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
    try { await submit({ TransactionType: 'Payment', Account: UI, Destination: b.from, Amount: { ...USDX, value: usdx.toFixed(6) }, Memos: [memo('USDX/RECEIPT', { v: 1, dep: b.hash, burn: b.burnHash, bonsai: b.value, rateUsd: px.bonsaiUsd, ratio: K.ratio, usdx })] }, iss); }
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

async function cycle() {
  const px = await prices(); log(`BONSAI $${px.bonsaiUsd.toFixed(10)} (${px.how}) · XRP $${px.xrpUsd.toFixed(4)}`);
  await processDeposits(px).catch(e => log('processor:', e.message));
  for (const kind of K.pegPools) await pegStep(px, kind).catch(async e => { log(`peg ${kind}:`, e.message); await alert(`peg defence failed in the ${kind} pool: ${e.message}`); });
  await dexStep(px).catch(e => log('dex:', e.message));
}
log(LIVE ? 'LIVE mode: transactions will be submitted' : 'DRY RUN: nothing is submitted. Set LIVE=1 to trade.');
log(`receiver ${RECV}${iss ? ' · issuer key loaded, deposits will be processed' : ' · no issuer key, deposits are not processed'} · defending pools ${K.pegPools.join(' + ')} · DEX quotes in ${K.pool}`);
for (;;) { try { await cycle(); } catch (e) { log('cycle error:', e.message); } await new Promise(r => setTimeout(r, K.every)); }
