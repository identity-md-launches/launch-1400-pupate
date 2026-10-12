import type { Metadata } from "next";
import Link from "next/link";
import { Aside, Doc } from "@/components/docs/Doc";

export const metadata: Metadata = { title: "The reference price" };

export default function Oracle() {
  return (
    <Doc slug="oracle">
      <h2>Why a reference price</h2>
      <p>
        The vault must know what a seat is worth before it buys one, and it must not take anyone’s word for it. The
        reference is the collection’s floor: <b>the lowest active listing OpenSea reports for it</b>, read by a panel of
        seats and signed by the IMD oracle. The vault buys only at or under the floor plus its tolerance, so the most it
        ever pays is a few percent above the cheapest seat on the market.
      </p>

      <h2>Where it comes from</h2>
      <p>
        The IMD oracle. A request names a question, a panel size and a quorum; a panel of seats answers independently,
        and when enough of them agree the oracle signs an <b>attestation</b> with the answer, the panel’s size, quorum
        and agreement, and a validity window. For this question twenty seats each read the collection’s floor on OpenSea,
        and eleven must agree within 2%. IMD’s on-chain evidence can count and sum logs and read pool prices, none of
        which yields the price of a seat, so the panel reads the marketplace. The signature is EIP-712, domain{" "}
        <code>IdentityMD Oracle</code> version 2, bound to the contract that asked: an attestation issued to one consumer
        is worthless to another.
      </p>
      <p>Each request costs 0.5 IMD. The developer’s keeper pays for them, up to one every six hours; anyone else may too.</p>

      <h2>What FloorFeed checks</h2>
      <p>
        <code>FloorFeed.report(attestation, signature)</code> is callable by anyone. It stores the price only when all of
        these hold:
      </p>
      <table>
        <thead>
          <tr>
            <th>Check</th>
            <th>Rule</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Signer</td>
            <td>Recovers to the IMD oracle’s attester address, for FloorFeed’s own address and chain.</td>
          </tr>
          <tr>
            <td>Question</td>
            <td>Matches the one pinned question hash. Any other question is refused.</td>
          </tr>
          <tr>
            <td>Evidence chain</td>
            <td>Names the chain fixed at deployment, where the collection lives.</td>
          </tr>
          <tr>
            <td>Panel</td>
            <td>Quorum at least 4 and a majority of the panel; agreement at least the quorum and within the panel.</td>
          </tr>
          <tr>
            <td>Validity</td>
            <td>Valid for at least the freshness window, not issued in the future, not older than the window.</td>
          </tr>
          <tr>
            <td>Order</td>
            <td>Issued after the report already stored.</td>
          </tr>
          <tr>
            <td>Answer</td>
            <td>One non-zero <code>uint256</code>.</td>
          </tr>
          <tr>
            <td>Rise limit</td>
            <td>At most 25% higher per 6 hours since the stored report was issued. Falls are not limited.</td>
          </tr>
        </tbody>
      </table>
      <p>
        A report is fresh for 6 hours after it was issued. Without a fresh report the vault does not buy, and the split
        falls back to 50/50 until the next one arrives.
      </p>

      <h2>The rise limit</h2>
      <p>
        A floor read from a marketplace can be wrong for a while, by mistake or by design. The limit caps how fast a
        higher one can reach the vault: the stored price
        may rise by at most 25% per 6 hours, measured between the issue times of two reports, whether or not the earlier
        report is still fresh. A report held back until the previous one lapses gains nothing, and reports in quick
        succession cannot compound. A genuine jump larger than the limit is reflected once enough time has passed; until
        then the vault simply buys less.
      </p>
      <p>
        Setting the question (a timelocked action) clears the stored price, and the first report after that is not
        limited. Setting the same hash again is the way to clear a bad value.
      </p>

      <Aside>
        The <Link href="/feed/#proof">Feed page</Link> shows a real attestation and runs the signature, panel, validity
        and answer checks in your browser. Change the answer by one and the signature check fails.
      </Aside>
    </Doc>
  );
}
