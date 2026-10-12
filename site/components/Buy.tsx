"use client";

import Link from "next/link";
import { useState } from "react";
import { BuyPanel } from "./BuyPanel";
import { useAddresses, useSim } from "./SimContext";

function CopyAddress({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      // The address is selectable text beside the button.
    }
  }
  return (
    <button className="btn" type="button" onClick={copy}>
      {done ? "Copied" : "Copy address"}
    </button>
  );
}

/// The Buy page: the panel, how to use it in three steps, what to expect, and the contract address
/// (or, before launch, the plain statement that there is none yet).
export function Buy() {
  const s = useSim();
  const a = useAddresses();
  const live = !!s.live;
  const token = a?.token ?? null;

  return (
    <section className="wrap buy-page" aria-label="Buy PUPATE">
      <div className="buy-grid">
        <div>
          <div className="label">{live ? "Live on Ethereum" : "Before launch"}</div>
          <h1 className="serif">{live ? "Buy PUPATE" : "PUPATE is not for sale yet."}</h1>
          <p className="lede">
            {live
              ? "A swap into the launch pool, on Ethereum, paired with ETH. Six percent of the ETH side goes into the vault; the rest buys your PUPATE at the pool price."
              : "There is no token and no contract address yet. The panel on this page is the real swap, running against sample figures so you can see how a trade will look; nothing is sent. At launch it switches to the live pool, and the address appears here and on @pupateIMD. Until then, anything that calls itself PUPATE is not."}
          </p>

          <h2 className="serif sub-h">How to buy, in three steps</h2>
          <ol className="buy-steps">
            <li>
              <b>Have ETH on Ethereum mainnet.</b> The pool is on Ethereum, not an L2. Keep a little extra for gas.
            </li>
            <li>
              <b>Connect a wallet.</b> MetaMask, Rabby, Rainbow or any WalletConnect wallet, with the Connect button at the top
              or in the panel.
            </li>
            <li>
              <b>Enter an amount and confirm.</b> The panel shows what you receive after the tax and the pool fee before you
              sign. Selling works the same way, with two one-time approvals (Permit2).
            </li>
          </ol>

          <h2 className="serif sub-h">What to expect</h2>
          <ul className="buy-notes">
            <li>
              <b>Tax: 6%</b> of the ETH side on every buy and sell. It funds the vault that buys the seats, not a team wallet.
            </li>
            <li>
              <b>Opening window:</b> in the first ninety minutes after the pool opens the buy tax starts at 99% and falls one
              point a minute to 6%. The panel shows the rate of the moment; buying later in the window costs less.
            </li>
            <li>
              <b>Slippage 1%</b> by default; <b>pool fee 1.25%</b>, set by IMD&apos;s launch policy (1% to the launch wallet,
              0.25% to the IMD network).
            </li>
            <li>
              Supply is fixed at 1,000,000,000 and only falls as the vault burns. Nobody can mint, pause or raise the tax.
            </li>
          </ul>

          <h2 className="serif sub-h">Contract address</h2>
          {live && token ? (
            <div className="panel buy-addr">
              <div className="label">PUPATE token · Ethereum</div>
              <div className="num addr-line">{token}</div>
              <div className="cta">
                <CopyAddress text={token} />
                <a className="btn" href={`https://etherscan.io/token/${token}`} target="_blank" rel="noreferrer">
                  Etherscan ↗
                </a>
                <a className="btn" href={`https://app.uniswap.org/explore/tokens/ethereum/${token}`} target="_blank" rel="noreferrer">
                  Uniswap ↗
                </a>
              </div>
            </div>
          ) : (
            <div className="empty">
              No address yet. It will be published here and on{" "}
              <a href="https://x.com/pupateIMD" target="_blank" rel="noreferrer">
                @pupateIMD
              </a>{" "}
              at launch, and nowhere else first. Every other contract Pupate relies on is listed in the footer under
              Contracts.
            </div>
          )}

          <p className="dim" style={{ marginTop: 20 }}>
            Want to understand what you are buying first? <Link href="/how/">How it works →</Link>
          </p>
        </div>
        <BuyPanel preview />
      </div>
    </section>
  );
}
