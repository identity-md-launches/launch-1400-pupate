import type { Metadata } from "next";
import { Aside, Doc } from "@/components/docs/Doc";

export const metadata: Metadata = { title: "Launch and contracts" };

const KNOWN = [
  ["identity.md collection", "0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D"],
  ["Seaport 1.6", "0x0000000000000068F116a894984e2DB1123eB395"],
  ["IMD token", "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7"],
  ["IMD oracle signer", "0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982"],
];
const PENDING = ["PUPATE token", "PupateHook", "Cocoon", "FloorFeed", "PupateVesting", "Timelock"];

export default function Launch() {
  return (
    <Doc slug="launch">
      <h2>Through IMD</h2>
      <p>
        Pupate launches through IMD’s launchpad as a <code>univ4_hook</code> launch. The request points at the public
        repository and one commit; the swarm reviews the code, deploys the token and the hook from that commit, and opens
        and seeds the pool in one transaction. The launch rule gives 10% of supply to the swarm that did the work and
        puts 85% into the pool, single-sided. The developer’s 5% is delivered to the requesting wallet and moved into the
        vesting contract straight after.
      </p>

      <h2>Order of deployment</h2>
      <ol>
        <li>
          <b>Before the launch:</b> the timelock, FloorFeed and Cocoon are deployed, so the hook can take the vault and
          the timelock as constructor arguments. The first oracle request is made with FloorFeed as its consumer, which
          fixes the question hash.
        </li>
        <li>
          <b>The launch:</b> IMD deploys PupateToken and PupateHook and opens the pool. On-chain checks follow: the
          hook’s sink is Cocoon, its owner is the timelock, its launch pool is the intended one.
        </li>
        <li>
          <b>After the launch:</b> Cocoon is wired to the pool (it refuses any pool whose hook does not name it as the
          sink), PupateVesting is deployed and funded, the question is pinned, and FloorFeed and Cocoon are handed to the
          timelock. From here every change waits 48 hours.
        </li>
        <li>
          <b>Then:</b> the first report, the keeper, this site at pupate.fun, and the first paired seat.
        </li>
      </ol>
      <p>The whole sequence is rehearsed on Sepolia first, against a FloorFeed that reads mainnet sales.</p>

      <h2>The launch window</h2>
      <p>
        For 93 minutes after the open the buy tax falls from 99% to 6%, one point a minute. Sells pay 6% from the first
        block. The tax of the moment is shown beside the trade button; there is no reason to buy in the first minutes
        unless you want to pay for the vault’s first seat. Whoever does, does exactly that.
      </p>

      <h2>Contracts</h2>
      <table>
        <tbody>
          {KNOWN.map(([name, address]) => (
            <tr key={name}>
              <td>{name}</td>
              <td className="num">
                <a href={`https://etherscan.io/address/${address}`} target="_blank" rel="noreferrer">
                  {address}
                </a>
              </td>
            </tr>
          ))}
          {PENDING.map((name) => (
            <tr key={name}>
              <td>{name}</td>
              <td className="dim">published here with verified source at launch</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Built with</h2>
      <ul>
        <li>Uniswap v4 core 1.0.2 for the pool and the hook.</li>
        <li>Seaport 1.6 for every seat order, signature-free and validated on-chain.</li>
        <li>The IMD oracle for the reference price, and IMD’s worker authorisation for pairing.</li>
        <li>OpenZeppelin’s TimelockController for the 48-hour delay.</li>
        <li>Foundry: 222 tests, including fuzz and stateful invariant tests, plus mainnet-fork tests of the Seaport path and of the launch through IMD’s own factory.</li>
      </ul>

      <Aside tone="gold">
        Until the addresses above are filled in, nothing claiming to be Pupate is Pupate. Do not send anything to an
        address that is not published here or on the site’s footer.
      </Aside>
    </Doc>
  );
}
