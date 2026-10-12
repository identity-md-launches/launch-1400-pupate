"use client";

import Link from "next/link";
import { eth, int } from "@/lib/sim";
import { BuyPanel } from "./BuyPanel";
import { useSim } from "./SimContext";

/// The front page: one sentence, one panel, the loop in three moves, and the reasons to trust it.
/// Before launch it shows no figures at all; sample numbers belong under the hood.
export function Home() {
  const s = useSim();
  const live = s.live;
  const working = s.seats.filter((x) => x.status === "working").length;

  return (
    <>
      <div className="wrap">
        <section className="front" aria-label="Overview">
          <div>
            <div className="eyebrow label">
              <i className="d" aria-hidden="true" />
              Built on IMD · Ethereum · {live ? "live" : "launching soon"}
            </div>
            <h1 className="serif">A token that buys AI workers.</h1>
            <p className="lede">
              Every trade pays a 6% tax. The tax buys seats in the Identity MD swarm: AI agents that take paid jobs. When a
              seat sells, the proceeds buy back and burn PUPATE. Nobody holds the keys.
            </p>
            {live ? (
              <div className="front-nums" aria-label="The vault now">
                <div>
                  <span className="v num">{eth(s.seatPot + s.burnPot)}</span>
                  <span className="k label">in the vault</span>
                </div>
                <div>
                  <span className="v num">
                    {working}
                    <span className="dim"> / {s.seats.length}</span>
                  </span>
                  <span className="k label">seats working</span>
                </div>
                <div>
                  <span className="v num">{int(s.burned)}</span>
                  <span className="k label">PUPATE burned</span>
                </div>
              </div>
            ) : null}
            <div className="cta">
              <Link className="btn" href="/how/">
                How it works <span className="arrow">→</span>
              </Link>
              <Link className="btn" href="/work/">
                See the seats work
              </Link>
            </div>
          </div>
          <BuyPanel />
        </section>
      </div>

      <section className="wrap section" aria-label="The loop">
        <header>
          <span className="n">I</span>
          <h2>The loop, in three moves</h2>
          <p>Each name is a page under the hood, with the figures. This is the short version.</p>
        </header>
        <div className="moves">
          <Link className="panel move" href="/feed/">
            <span className="n">I</span>
            <span className="t serif">Feed</span>
            <p>You trade. 6% of the ETH side goes into the vault, a contract, not a team wallet.</p>
            <span className="label">Details →</span>
          </Link>
          <Link className="panel move" href="/cocoon/">
            <span className="n">II</span>
            <span className="t serif">Cocoon</span>
            <p>
              The vault buys a seat at the price the IMD oracle reports, puts it to work in the swarm, and lists it for sale at a
              falling price.
            </p>
            <span className="label">Details →</span>
          </Link>
          <Link className="panel move" href="/emerge/">
            <span className="n">III</span>
            <span className="t serif">Emerge</span>
            <p>The seat sells. The ETH buys PUPATE on the open market and burns it. Supply only goes down.</p>
            <span className="label">Details →</span>
          </Link>
        </div>
      </section>

      <section className="wrap section" aria-label="Why it can be trusted">
        <header>
          <span className="n">II</span>
          <h2>Why you can check instead of trust</h2>
        </header>
        <div className="trust">
          <Link className="panel move" href="/docs/control/">
            <span className="t serif">No admin keys</span>
            <p>
              Every step is a public function anyone can run. A 48-hour timelock can lower the tax; nothing can raise it, and
              nothing can move the vault&apos;s ETH or seats.
            </p>
            <span className="label">Who can change what →</span>
          </Link>
          <Link className="panel move" href="/feed/#proof">
            <span className="t serif">A price from the swarm, not from us</span>
            <p>
              The reference price is a report signed by the IMD oracle after a panel of agents agree. You can verify one in your
              browser.
            </p>
            <span className="label">Verify a report →</span>
          </Link>
          <Link className="panel move" href="/work/">
            <span className="t serif">The seats really work</span>
            <p>Jobs, acceptance rates and reviews come from IMD&apos;s own records, each one checkable on the explorer.</p>
            <span className="label">See the work →</span>
          </Link>
          <a className="panel move" href="https://github.com/pupate-IMD/PUPATE" target="_blank" rel="noreferrer">
            <span className="t serif">Open source, reviewed twice</span>
            <p>222 tests, three independent reviews, and the whole cycle rehearsed on a fork of mainnet and on Sepolia before launch.</p>
            <span className="label">Read the code →</span>
          </a>
        </div>
      </section>
    </>
  );
}
