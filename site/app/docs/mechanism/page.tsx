import type { Metadata } from "next";
import Link from "next/link";
import { Aside, Doc } from "@/components/docs/Doc";

export const metadata: Metadata = { title: "How it works" };

export default function Mechanism() {
  return (
    <Doc slug="mechanism">
      <h2>One pool, one hook</h2>
      <p>
        PUPATE trades in a single Uniswap v4 pool against ETH, opened by IMD’s launch factory. The pool carries a hook,
        <b> PupateHook</b>, which is where the tax lives. The token itself is a plain ERC-20, as IMD requires: fixed supply,
        no fee, no limit, no pause, no mint.
      </p>
      <p>
        Nobody can add liquidity once the transaction that opened the pool has ended. IMD’s factory initialises and seeds
        the pool in that one transaction, so the only position the pool ever has is the factory’s. This closes the one way of trading around a
        swap tax: resting liquidity just above or below the price and letting takers fill it. Removing liquidity is never
        blocked.
      </p>

      <h2>The tax</h2>
      <p>
        Every buy and every sell pays <b>6% of the ETH side</b> of the trade. On a buy that is 6% of the ETH the trader
        pays; on a sell it is 6% of the ETH the pool pays out. The pool’s own 1.25% fee applies as well and goes to the
        liquidity position, which IMD holds.
      </p>
      <p>
        For the first 93 minutes after the open the <b>buy</b> tax runs a schedule: 99% at the open, one percentage point
        lower each minute, until it meets the standing 6%. Sells pay 6% from the first block. This is a Dutch auction on
        the opening supply: whoever buys early pays for it, and the payment goes to the vault instead of to a sniper. A
        wallet cap cannot do that job, because a hook sees the router, not the buyer.
      </p>
      <p>
        The tax is taken inside the swap as PoolManager claims. No ETH moves during a swap. <b>Anyone</b> can call{" "}
        <code>flush()</code>, which turns the claims into ETH and hands the hook’s whole balance to the vault.
      </p>

      <h2>The split</h2>
      <p>
        The vault, <b>Cocoon</b>, receives the flushed tax and splits it on arrival:
      </p>
      <table>
        <thead>
          <tr>
            <th>Share</th>
            <th>Where it goes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="num">85%</td>
            <td>The strategy: divided between the seat pot and the burn pot by the mode of that moment.</td>
          </tr>
          <tr>
            <td className="num">10%</td>
            <td>The developer balance. It pays for oracle reports, keeper gas and the machines behind working seats.</td>
          </tr>
          <tr>
            <td className="num">5%</td>
            <td>The IMD burn balance: ETH offered for IMD, which is sent to the dead address.</td>
          </tr>
        </tbody>
      </table>

      <h2>Modes</h2>
      <p>
        The strategy share is not split by a fixed rule but by where the market is. The mode is read fresh on every
        deposit; rows are checked top to bottom and the first match applies.
      </p>
      <table>
        <thead>
          <tr>
            <th>Condition</th>
            <th>Mode</th>
            <th className="num">Seat pot</th>
            <th className="num">Burn pot</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>No fresh oracle report</td>
            <td>Neutral</td>
            <td className="num">50%</td>
            <td className="num">50%</td>
          </tr>
          <tr>
            <td>The vault holds no seats</td>
            <td>Spinning (accumulate)</td>
            <td className="num">70%</td>
            <td className="num">30%</td>
          </tr>
          <tr>
            <td>Reference price at or under the average the vault paid</td>
            <td>Spinning (accumulate)</td>
            <td className="num">70%</td>
            <td className="num">30%</td>
          </tr>
          <tr>
            <td>Reference price above that average</td>
            <td>Shedding (burn)</td>
            <td className="num">30%</td>
            <td className="num">70%</td>
          </tr>
        </tbody>
      </table>
      <p>
        In words: while seats are cheap relative to what the vault holds, most of the tax buys more of them. Once the
        market has moved above the vault’s cost, most of the tax burns PUPATE instead, and the seats already held are left
        to sell into that market.
      </p>

      <h2>The burn</h2>
      <p>
        <code>burn()</code> spends the burn pot on PUPATE in the launch pool and destroys what it buys. One call may move
        the pool price by at most 5%, and calls must be at least 5 blocks apart, so a large pot is spent in several steps
        and is not worth sandwiching: every other trader pays the tax on both legs. The vault’s own swaps are the only
        untaxed ones, which is why their parameters are fixed in code. The caller receives 0.5% of the ETH spent.
      </p>
      <p>
        ETH that reaches the vault from a filled listing, or from anyone who simply sends ETH to it, goes to the burn pot.
      </p>

      <h2>Where the money can go</h2>
      <p>Pot ETH leaves the vault for exactly three reasons, and an invariant test checks it across random sequences of every action:</p>
      <ul>
        <li>to Seaport, to buy a seat;</li>
        <li>to the launch pool, to buy PUPATE that is then burned;</li>
        <li>to the caller, as a reward of at most 1% of what the step spent.</li>
      </ul>
      <p>
        The developer balance and the IMD burn balance are separate pots with their own exits (
        <code>claimDeveloper</code> and the IMD auction). The vault’s balance always equals its four pots added together.
      </p>

      <Aside>
        The <Link href="/flow/">Flow</Link> page draws this with live figures, and the <Link href="/feed/">Feed</Link> page
        breaks down any trade you type in.
      </Aside>
    </Doc>
  );
}
