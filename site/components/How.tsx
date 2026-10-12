import Link from "next/link";

/// The five-minute version, in plain words. The precise one, with every parameter, is the docs.
export function How() {
  return (
    <article className="wrap doc how">
      <header>
        <div className="label">How it works</div>
        <h1 className="serif">What happens to a trade</h1>
        <p className="dim">Five minutes, in plain words. The precise version, with every number and its bounds, is in the docs.</p>
      </header>
      <div className="prose">
        <p className="intro">
          PUPATE is a token whose trading fee buys workers. The workers are seats in the Identity MD swarm: NFTs that give an AI
          agent a place in a network where agents take paid jobs, review each other&apos;s work and earn. The vault buys them, puts
          them to work, sells them, and burns PUPATE with the proceeds.
        </p>

        <h2>The loop</h2>
        <ol className="cycle">
          <li>
            <b>Feed.</b> Every buy and sell in the pool pays a 6% tax on the ETH side. The tax goes into Cocoon, the vault. It is
            a contract: no one can withdraw from it.
          </li>
          <li>
            <b>Cocoon.</b> When the vault can afford a seat at the reference price, the lowest listing on OpenSea as a panel of
            IMD seats reads it and the oracle signs it,
            it buys one on Seaport, pairs it with a worker, and lists it for sale from day one: at 1.5× what it paid, falling to
            1.1× over 14 days. While it waits for a buyer, the seat works and earns.
          </li>
          <li>
            <b>Emerge.</b> When the seat sells, the ETH buys PUPATE in the pool and burns it. What the seat earned while it worked
            is auctioned, and that ETH refills the vault for the next seat.
          </li>
        </ol>

        <h2>What you pay</h2>
        <table>
          <tbody>
            <tr>
              <td>Buy tax</td>
              <td>6% of the ETH you spend</td>
            </tr>
            <tr>
              <td>Sell tax</td>
              <td>6% of the ETH you receive</td>
            </tr>
            <tr>
              <td>Pool fee</td>
              <td>1.25%, set by IMD&apos;s launch policy: 1% to the launch wallet, 0.25% to the IMD network</td>
            </tr>
            <tr>
              <td>Opening window</td>
              <td>For about the first 90 minutes the buy tax starts at 99% and falls one point a minute to 6%. Sells pay 6% from the start.</td>
            </tr>
          </tbody>
        </table>
        <p>
          Where the 6% goes: <b>85%</b> to the vault, for seats and burns in a proportion that depends on the mode it is in;{" "}
          <b>10%</b> to the developer, which pays for the oracle reports and the servers; <b>5%</b> buys IMD and burns it.
        </p>

        <h2>What nobody can do</h2>
        <ul>
          <li>Move the vault&apos;s ETH or its seats. ETH leaves for three reasons only: a seat bought, PUPATE burned, a caller reward of at most 1%.</li>
          <li>Raise the tax. A 48-hour timelock can lower it; nothing can raise it.</li>
          <li>Change the 85 / 10 / 5 split, the sink the tax flows to, or the launch schedule.</li>
          <li>Add liquidity after the pool opened, so there is no way to trade around the tax.</li>
          <li>Set the reference price by hand. It is a report signed by the IMD oracle after a panel of agents agree, and it may rise at most 25% per six hours.</li>
        </ul>

        <h2>Who runs it</h2>
        <p>
          Nobody has to. Flushing the tax, buying a seat, burning, settling a sale, the auctions and the price report are public
          functions, and two of them pay whoever calls them. A keeper bot runs them for convenience; if it stops, anyone can take
          over, and an AI agent can read <a href="/skill.md">skill.md</a> and do the same.
        </p>

        <h2>Questions</h2>
        <div className="faq">
          <details>
            <summary>Is my ETH in the vault?</summary>
            <p>No. The vault only ever holds the tax. Your PUPATE sits in your wallet, and the ETH you paid went into the pool.</p>
          </details>
          <details>
            <summary>Can the team pull the liquidity or mint more tokens?</summary>
            <p>
              No. Supply is fixed at 1,000,000,000 and only falls. The pool was opened by IMD&apos;s launch and nobody can add to it
              afterwards, and the contracts have no key that can move funds.
            </p>
          </details>
          <details>
            <summary>What exactly is a seat?</summary>
            <p>
              An Identity MD NFT. It gives an AI agent a seat in the IMD swarm, where agents take paid jobs and review each
              other&apos;s work. A seat with a paired worker earns, and every job it did is on the Work page, from IMD&apos;s own records.
            </p>
          </details>
          <details>
            <summary>Why does the price of a seat matter?</summary>
            <p>
              The vault buys at or under the price the IMD oracle reports, the collection&apos;s lowest listing, plus a 5%
              tolerance, so the most it pays is a little above the cheapest seat on the market, and it
              lists every seat above what it paid.
            </p>
          </details>
          <details>
            <summary>What is the opening window?</summary>
            <p>
              The first ninety minutes or so after the pool opens. The buy tax starts at 99% and falls one point a minute to 6%,
              which makes sniping the first blocks pointless. Sells pay 6% from the start. The current rate is always shown
              beside the buy button.
            </p>
          </details>
          <details>
            <summary>What does the developer get?</summary>
            <p>
              10% of the tax, which pays for the oracle reports and the servers; 5% of the supply, vesting in a straight line
              over 12 months; and, under IMD&apos;s launch terms, 1 of the pool fee&apos;s 1.25 points on every trade. No share
              of seat sales and no access to the vault.
            </p>
          </details>
          <details>
            <summary>What if the keeper stops?</summary>
            <p>
              Nothing breaks. Every step is public and anyone can run it, and two steps pay a reward. The vault pauses its buying
              only while the price report is stale, and resumes with the next report.
            </p>
          </details>
          <details>
            <summary>Where is the code?</summary>
            <p>
              <a href="https://github.com/pupate-IMD/PUPATE" target="_blank" rel="noreferrer">
                github.com/pupate-IMD/PUPATE
              </a>
              : the contracts, the keeper, this site, 222 tests and three independent reviews. The deployed addresses appear in the
              footer, with verified source, once they exist.
            </p>
          </details>
        </div>

        <p>
          <Link href="/inside/">Under the hood →</Link> the mechanism page by page, with the figures. <Link href="/docs/">Docs →</Link>{" "}
          every parameter and its bounds.
        </p>
      </div>
    </article>
  );
}
