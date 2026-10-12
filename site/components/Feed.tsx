"use client";

import { useEffect, useState, type FormEvent } from "react";
import { formatEther } from "viem";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { avgCost, breakdown, buyTax, eth, hm, int, isLaunch, LAUNCH_MINUTES, mode, pct, receiveEstimate, sellTax, splitEth } from "@/lib/sim";
import { Lead } from "./Hero";
import { OracleProof } from "./OracleProof";
import { SLIPPAGE_BPS, useDispatch, useQuote, useSim } from "./SimContext";

export function Feed() {
  const s = useSim();
  const dispatch = useDispatch();
  const { openConnectModal } = useConnectModal();
  const [amount, setAmount] = useState("0.5");
  const [agoSample, setAgoSample] = useState(108 * 60);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => {
      setAgoSample((a) => a + 30);
      setNow(Math.floor(Date.now() / 1000));
    }, 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setAmount(s.buying ? "0.5" : "10000000"), [s.buying]);

  const live = s.live;
  const quote = useQuote(amount, s.buying);
  const m = mode(s);
  const ago = live ? Math.max(0, now - live.floorIssuedAt) : agoSample;
  const left = live ? live.freshUntil - now : 6 * 3600 - agoSample;
  const value = parseFloat(amount.replace(",", "."));

  // Live sells are priced by the quoter: it returns the ETH after tax and fee, so the ETH side the
  // tax applies to is recovered from it. Buys are exact either way: the tax is on the ETH paid.
  const b = live
    ? s.buying
      ? breakdown(s, value)
      : quote.out
        ? splitEth(s, Number(formatEther(quote.out)) / (1 - sellTax(s)), sellTax(s))
        : null
    : breakdown(s, value);
  const dp = b && b.tax < 0.01 ? 5 : 4;

  const estimate = live
    ? quote.out === null
      ? quote.loading
        ? "…"
        : "no quote"
      : s.buying
        ? `${int(Number(formatEther(quote.out)))} PUPATE`
        : `${Number(formatEther(quote.out)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`
    : receiveEstimate(s, value);
  const impliedRate = live && s.buying && quote.out && value > 0 ? Number(formatEther(quote.out)) / value : null;
  const busy = !!live?.pending;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!s.wallet) openConnectModal?.();
    else if (!busy) dispatch({ type: "swap", amount: value, raw: amount });
  }

  return (
    <section className="wrap section" id="feed" aria-label="Feed">
      <header>
        <span className="n">I</span>
        <h2>Feed</h2>
        <p>
          Every buy and sell in the launch pool pays {pct(sellTax(s))} of its ETH side. Anyone can flush what has been collected into the
          vault, which splits it 85% to the strategy, 10% to the developer, 5% to buy and burn IMD.
        </p>
      </header>
      <div className="two">
        <form className="panel swap" onSubmit={submit}>
          <div className="head">
            <span className="serif">Trade in the launch pool</span>
            <span className="label">ETH / PUPATE</span>
          </div>
          <div className="tabs" role="group" aria-label="Direction">
            <button type="button" aria-pressed={s.buying} onClick={() => dispatch({ type: "direction", buying: true })}>
              Buy
            </button>
            <button type="button" aria-pressed={!s.buying} onClick={() => dispatch({ type: "direction", buying: false })}>
              Sell
            </button>
          </div>
          <div className="field">
            <label className="label" htmlFor="amount">
              {s.buying ? "You pay" : "You sell"}
            </label>
            <div className="row">
              <input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
              <span className="unit">{s.buying ? "ETH" : "PUPATE"}</span>
            </div>
          </div>
          <div className="field">
            <span className="label">You receive, after tax and the 1.25% pool fee</span>
            <div className="row">
              <span className="out num">{estimate}</span>
            </div>
          </div>
          <div className="taxline">
            <span className="num">
              {isLaunch(s)
                ? `Buy tax now ${pct(buyTax(s))}. Reaches ${pct(sellTax(s))} in ${Math.max(0, LAUNCH_MINUTES - s.launchMinute)} minutes. Sell tax ${pct(sellTax(s))}.`
                : `Buy tax now ${pct(buyTax(s))}. Sell tax ${pct(sellTax(s))}.`}
            </span>
            <span className="dim num">
              {live
                ? impliedRate
                  ? `1 ETH ≈ ${int(impliedRate)} PUPATE after tax`
                  : `slippage ${pct(SLIPPAGE_BPS / 10_000)}`
                : "1 ETH = 70,400,000 PUPATE"}
            </span>
          </div>
          {b && (
            <div className="calc" aria-label="Where the ETH side of this trade goes">
              <div className="label">Where the {eth(b.eth, dp)} goes</div>
              <div className="bar" role="img" aria-label={`${pct(1 - b.rate)} to the pool, ${pct(b.rate)} tax`}>
                <i className="pool" style={{ flexGrow: b.toPool }} />
                <i className="seats" style={{ flexGrow: b.toSeats }} />
                <i className="burn" style={{ flexGrow: b.toBurn }} />
                <i className="rest" style={{ flexGrow: b.toDeveloper + b.toImd }} />
              </div>
              <Lead k={s.buying ? "Into the pool, for your PUPATE" : "Out of the pool, to you"} v={eth(b.toPool, dp)} />
              <Lead k={`Tax, ${pct(b.rate)}`} v={eth(b.tax, dp)} />
              <Lead k="· buys seats" v={eth(b.toSeats, dp)} />
              <Lead k="· burns PUPATE" v={eth(b.toBurn, dp)} />
              <Lead k="· developer" v={eth(b.toDeveloper, dp)} />
              <Lead k="· burns IMD" v={eth(b.toImd, dp)} />
            </div>
          )}
          <button className="go" type="submit" disabled={busy}>
            {!s.wallet ? "Connect wallet" : busy ? "Sending…" : s.buying ? "Buy PUPATE" : "Sell PUPATE"}
          </button>
          <p className="note">
            {live
              ? s.wallet
                ? `${s.wallet} is connected. Trades are real: the swap goes through Uniswap's router into the launch pool, with ${pct(SLIPPAGE_BPS / 10_000)} slippage. Selling asks for two one-time approvals (Permit2).`
                : "Connect a wallet with RainbowKit. Trades here are real and go through Uniswap's router into the launch pool."
              : s.wallet
                ? `${s.wallet} is connected. Until the contracts are live, trades here change the figures on this page and nothing else.`
                : "Connect a wallet with RainbowKit. Until the contracts are live, trades here are simulated against the sample pool."}
          </p>
        </form>

        <div className="conditions">
          <h3>Conditions</h3>
          <div className={`mode ${m.name.toLowerCase()}`} style={{ marginBottom: 6 }}>
            <i className="d" aria-hidden="true" />
            {m.name}
          </div>
          <p className="dim" style={{ marginBottom: 12, maxWidth: "52ch" }}>
            {m.why}.
          </p>
          <Lead k="Reference price" v={eth(s.floor)} note="the lowest listing on OpenSea, read by an IMD oracle panel" />
          <a className="label jade" href="#proof" style={{ justifySelf: "end" }}>
            Check the oracle yourself ↓
          </a>
          <Lead
            k="Report"
            v={live && !live.floorIssuedAt ? "none yet" : `${hm(ago)} ago`}
            note={left > 0 ? `fresh for ${hm(left)} more` : "stale: the vault is not buying"}
          />
          <Lead k="Waiting in the hook" v={eth(s.hookWaiting)} note="flush it, no reward" />
          <Lead k="Seat pot" v={eth(s.seatPot)} note={`buys the next seat at up to ${live ? 100 + live.toleranceBps / 100 : 105}% of ${eth(s.floor)}`} />
          <Lead k="Burn pot" v={eth(s.burnPot)} note="spent on PUPATE, 5% price impact per call" />
          <Lead k="Average seat cost" v={s.seats.length ? eth(avgCost(s)) : "—"} note={`${s.seats.length} held`} />
          <Lead k="Developer share" v={eth(s.dev)} note="10% of tax, pays oracle reports and seat machines" />
        </div>
      </div>
      <OracleProof />
    </section>
  );
}
