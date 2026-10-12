import type { Metadata } from "next";
import { Aside, Doc } from "@/components/docs/Doc";

export const metadata: Metadata = { title: "Parameters" };

const TUNABLE = [
  ["Standing tax", "6%", "can only be lowered", "PupateHook.lowerTax"],
  ["Seat pot share while spinning", "70%", "30% to 70%", "accumulateSeatBps"],
  ["Listing start", "1.5× cost", "1.1× to 3×", "listStartX"],
  ["Listing end", "1.1× cost", "1.0× to 1.5×, not above the start", "listEndX"],
  ["Listing decay", "14 days", "1 to 60 days", "listDecay"],
  ["Price tolerance above the reference", "5%", "0% to 10%", "toleranceBps"],
  ["Caller reward", "0.5% of ETH spent", "0% to 1%", "callerRewardBps"],
  ["Burn price impact per call", "5%", "1% to 10%", "burnImpactBps"],
  ["Blocks between burns", "5", "1 to 300", "burnSpacing"],
  ["Harvest auction start price", "1 ETH", "0.01 to 100 ETH", "harvestStartWei"],
  ["IMD auction start demand", "20,000 IMD per ETH", "100 to 10,000,000 IMD per ETH", "imdStartPerEth"],
  ["Report freshness", "6 hours", "1 to 24 hours", "FloorFeed.setMaxAge"],
  ["Oracle attester", "IMD's signer", "any address", "FloorFeed.setAttester"],
  ["Oracle question", "the collection's floor on OpenSea, by a panel of 20", "any hash; setting it clears the stored price", "FloorFeed.setQuestion"],
  ["Operator", "the developer", "any address", "Cocoon.setOperator"],
];

const FIXED = [
  ["Supply", "1,000,000,000 PUPATE"],
  ["Allocation", "85% pool · 10% IMD swarm · 5% developer, vested over 365 days"],
  ["Launch schedule", "99% buy tax at the open, one point lower a minute, 6% after 93 minutes"],
  ["Liquidity gate", "liquidity enters only the launch pool, only in the transaction that opened it"],
  ["Split of the tax", "85% strategy · 10% developer · 5% IMD burn"],
  ["Pool fee", "1.25%, set by IMD's launch policy: 1% to the launch wallet, 0.25% to the IMD network"],
  ["Neutral split", "50% seat pot · 50% burn pot while no report is fresh"],
  ["Target collection", "identity.md, 0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D"],
  ["Evidence chain", "fixed at deployment: the chain the collection lives on"],
  ["Rise limit", "25% per 6 hours between reports"],
  ["Minimum quorum", "4, and a majority of the panel"],
  ["Auction curve", "halves every 2 hours, zero from 48 hours"],
  ["Hook sink", "Cocoon"],
  ["Timelock delay", "48 hours"],
  ["Where pot ETH can go", "a seat purchase, a PUPATE burn, or the caller reward"],
];

export default function Parameters() {
  return (
    <Doc slug="parameters">
      <p className="intro">
        Two kinds of numbers. The first kind the 48-hour timelock can move, but only inside bounds written into the
        contracts. The second kind nobody can move.
      </p>

      <h2>Tunable, within bounds</h2>
      <table>
        <thead>
          <tr>
            <th>Parameter</th>
            <th>At launch</th>
            <th>Bounds</th>
            <th>Where</th>
          </tr>
        </thead>
        <tbody>
          {TUNABLE.map(([name, start, bounds, where]) => (
            <tr key={name}>
              <td>{name}</td>
              <td className="num">{start}</td>
              <td className="num">{bounds}</td>
              <td>
                <code>{where}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        A change to the listing terms applies to seats bought after it. A change to an auction’s start value does not
        move an auction already running. Raising the report freshness can make a lapsed report fresh again; that is
        intended and pinned by a test.
      </p>

      <h2>Fixed</h2>
      <table>
        <tbody>
          {FIXED.map(([name, value]) => (
            <tr key={name}>
              <td>{name}</td>
              <td className="num">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <Aside>
        The bounds are enforced by <code>Cocoon._checkParams</code>, <code>FloorFeed.setMaxAge</code> and{" "}
        <code>PupateHook.lowerTax</code>; a proposal outside them reverts when the timelock executes it.
      </Aside>
    </Doc>
  );
}
