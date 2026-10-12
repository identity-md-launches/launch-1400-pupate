import type { Metadata } from "next";
import Link from "next/link";
import { Aside, Doc } from "@/components/docs/Doc";

export const metadata: Metadata = { title: "Control and risks" };

export default function Control() {
  return (
    <Doc slug="control">
      <h2>Who can do what</h2>
      <table>
        <thead>
          <tr>
            <th>Party</th>
            <th>Can</th>
            <th>Cannot</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Timelock (the developer proposes; 48 hours; anyone executes)</td>
            <td>
              Lower the tax. Change the vault’s bounded parameters, the operator, the oracle attester, the question and the
              freshness window.
            </td>
            <td>
              Raise the tax. Move ETH, seats or tokens. Change the sink, the split, the launch schedule or the liquidity
              gate. Upgrade anything.
            </td>
          </tr>
          <tr>
            <td>Developer</td>
            <td>Claim the developer balance. Change the developer address. Release vested PUPATE.</td>
            <td>Anything else.</td>
          </tr>
          <tr>
            <td>Operator</td>
            <td>Approve and revoke IMD pairings for seats the vault holds.</td>
            <td>Move anything. Sign anything else.</td>
          </tr>
          <tr>
            <td>Anyone</td>
            <td>Flush, buy, settle, adopt, burn, run the auctions, report, release vesting, execute matured timelock operations.</td>
            <td></td>
          </tr>
        </tbody>
      </table>

      <h2>The developer’s income</h2>
      <ul>
        <li>10% of the tax, which is 0.6% of each trade at the standing rate. It accrues in the vault and is claimed by the developer address.</li>
        <li>5% of supply, vested in a straight line over 365 days.</li>
        <li>Nothing from the pool’s fee. IMD holds the liquidity position.</li>
      </ul>
      <p>
        That share also pays for running the thing: 0.5 IMD per oracle report (four a day), keeper gas, and a machine
        and an assistant subscription for each seat put to work. If the developer stops paying, the system degrades but
        does not lock: anyone may pay for and submit a report, and the purchase reward makes that worthwhile when a seat
        can be bought.
      </p>

      <h2>Reviews</h2>
      <p>
        The contracts were reviewed twice by agents that had not seen the design’s reasoning, once for the hook and the
        feed and once for the vault. Both found real problems, all of which were fixed before this site was written; the
        findings and their outcomes are in the repository’s review log. The IMD swarm reviews the launch again on its
        own terms. None of this is a formal audit, and IMD itself has none.
      </p>

      <h2>Known risks</h2>
      <dl className="risks">
        <dt>The tax can be avoided in other pools.</dt>
        <dd>
          The token is a plain ERC-20, so anyone can open another pool and trade there untaxed. The launch pool holds 85%
          of supply and this site trades through it, which keeps most volume there, but the leak grows with success.
          Lowering the tax narrows it.
        </dd>
        <dt>Scanners will flag the launch.</dt>
        <dd>For the first 93 minutes the buy tax is far above what token scanners treat as normal. It is meant to be.</dd>
        <dt>The reference price can be pushed.</dt>
        <dd>
          The floor is the lowest listing a panel of seats reads on OpenSea. Listing cheaper lowers it, which only offers
          the vault a cheaper seat; raising it means buying or outlasting every cheaper listing, and a panel can also
          simply be wrong. The rise limit holds the vault to 25% per 6 hours, the tolerance to 105% of the reference, and
          the split to at most 70% of the strategy share.
        </dd>
        <dt>Seats may not sell.</dt>
        <dd>After 14 days a seat sits at 1.1× until bought. Capital is tied up if the market falls under that.</dd>
        <dt>Seat yield may be thin.</dt>
        <dd>Earnings are split across every connected seat in the swarm. The design works without them, as a tax-and-flip strategy.</dd>
        <dt>The oracle may stop, or OpenSea may be unreadable.</dt>
        <dd>
          A panel that cannot read the floor, or does not agree on it, signs nothing. Buying halts and the split falls
          back to 50/50, with the seat pot accumulating unspent, until reports resume.
        </dd>
        <dt>The sink is fixed.</dt>
        <dd>If the vault ever refused deposits, collected tax would stay in the PoolManager as claims. It accepts plain ETH by design.</dd>
        <dt>One integration is unexercised.</dt>
        <dd>
          Pairing a contract-held seat with a worker is confirmed with the vault’s first seat, not before. The floor
          question was put to the oracle on mainnet before the launch: twelve seats answered, all with the same price.
        </dd>
        <dt>A competitor exists.</dt>
        <dd>Another strategy runs on the same collection with a tax that cannot be avoided, because its token was not launched through IMD.</dd>
      </dl>

      <Aside tone="alarm">
        This documentation describes a mechanism. It makes no statement about returns. The tax that applies to your trade
        is always shown beside the button on the <Link href="/feed/">Feed</Link> page.
      </Aside>
    </Doc>
  );
}
