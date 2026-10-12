# v2 design: Chrysalis Cards, a mined collectible backed by real work

Status: design only, for after the hackathon launch. Nothing here changes the launched contracts.
Written 2026-10-08 after the project owner asked for a "POW" feature in the spirit of
[imdworkers.fun](https://imdworkers.fun/).

## What WORKERS does, in one paragraph

WORKERS is a browser-mining NFT platform on IMD. A visitor's browser hashes nonces until it finds a
hash under an epoch difficulty; the wallet address is inside the hash, so a solution belongs to its
finder. Each solution is the right to mint one of 3,333 worker NFTs for a fee in IMD (0.25–5 IMD by
epoch). Minted workers are activated (0.15 IMD) to emit a second token, $WORK, which can be staked
(7/14/30 days at 1×/2×/4×) for IMD from the mint fees, or burned against a 50M $WORK pool. $WORK was
launched through IMD paired with IMD on Robinhood Chain, with a 2% trade fee and a 50%→2% opening
fee decay. The proof of work is the distribution mechanism; the hashes do no useful work.

## Why not copy it

Pupate's claim is the opposite of a hash: the vault's seats do real, judged work in the IMD swarm,
and the site now proves it from IMD's own records (`/work`). Bolting hash-mining onto the token would
blur that. A second emission token would dilute PUPATE's one story (tax → seats → burn). And any new
contract is new audit surface: not before the launch.

## What fits: mine a card of a seat that worked

Every seat the vault buys already has a drawing: the chrysalis of its number, which turns into its
butterfly when the seat sells (the emergence cards on the seat sheets). v2 turns those into
collectibles whose **distribution** is a browser proof of work, like WORKERS, but whose **meaning**
is Pupate's: each card is a seat the vault really held, carrying the work that seat really did.

- **Card** = ERC-721 "Chrysalis Card" for one `(tokenId, round)` the vault has held (the vault's
  `seats(tokenId).round` already distinguishes repurchases). A bounded number of editions per seat
  (say 33). Art on-chain: the same deterministic SVG as the site, so no server.
- **Mining** = the browser searches nonces for `keccak(minter, seatId, epoch, nonce) < target`, as
  WORKERS does, so a solution is bound to the wallet. Difficulty adjusts per epoch toward a target
  cadence (for example one solution per minute network-wide) so neither a GPU farm nor a phone is
  shut out entirely; a per-wallet cap per epoch limits farms.
- **Mint fee in PUPATE, burned.** A solution lets the finder mint by paying a fee in PUPATE that the
  Mine contract burns through `PupateToken.burnFrom`. Mining therefore feeds the token's one sink
  instead of a treasury: more cards, less supply. (Alternative: a fee in ETH sent to the vault's seat
  pot through `depositTax`-like plain ETH, which the vault books as proceeds; this buys more seats.
  Pick one at build time; PUPATE burn is the simpler story.)
- **Metamorphosis on-chain.** A card minted while the vault holds the seat is a chrysalis; when the
  seat's listing fills (`SeatSold`), `tokenURI` flips to the butterfly. No admin: the Card contract
  reads `Cocoon.seats(tokenId).held` and the event, nothing else.
- **Rarity from real work.** The IMD oracle can attest a number for a pinned question just as
  FloorFeed consumes the floor; a second feed, "accepted jobs of seat X", lets the card's traits (and
  edition count) follow the work the seat actually did while the vault held it. This is the part no
  hash-mining project can copy: the proof of work in the hash is spent on a proof of work by a seat.

## Contracts (new, not changes)

| Contract | Does | Owner |
|---|---|---|
| `ChrysalisCards` (ERC-721) | Mints `(seat, round, edition)`; on-chain SVG; `tokenURI` reads Cocoon for held/sold; traits read the work feed | none, or the existing 48-hour timelock for the three bounded knobs |
| `CardMine` | Epochs, difficulty retarget, solution verification (`keccak256(abi.encode(minter, seat, epoch, nonce)) < target`), replay guard, per-wallet cap, fee in PUPATE burned via `burnFrom` | same |
| `WorkFeed` (optional) | FloorFeed's twin for "accepted jobs of seat X", reported from IMD oracle attestations | timelock |

Cocoon, PupateHook, PupateToken, FloorFeed are not touched. The Cards only read them.

## Economics to decide at build time

- Editions per seat (33?), fee per epoch (flat, or rising like WORKERS), epoch length, target cadence,
  per-wallet cap, whether unsolved epochs roll over.
- Secondary royalty: **5% on resale, to the developer treasury** (owner decision, 2026-10-10). The token
  stays keyless; the card market is the developer's revenue, stated plainly on the Mine page. Enforced
  with a creator-token transfer validator (whitelisted operators and a Seaport zone of our own),
  since ERC-2981 alone is a signal marketplaces may ignore.
- Mint fee: **in PUPATE, always, and burned** (owner decision, 2026-10-10). Miners must buy PUPATE in
  the pool to mint, which pays the tax and feeds the vault; the fee itself leaves supply. This is the
  flywheel: trade → tax → seats → cards to mine → PUPATE bought and burned → fewer tokens, more seats.
- Art: the binary-outline language of the brand (every contour a line of 0s and 1s seeded by the seat
  number, jade digits for the wing, a gold band), on-chain SVG with a two-glyph font; prototype in
  brand/previews/ (not tracked).
- Which seats are mineable: only seats the vault holds now (scarce, live) or any seat it ever held
  (a growing catalogue). Holding-only keeps the mining tied to the vault's present work.

## Risks

- Browser mining is energy and attention spent for a lottery; some users dislike it. Keep the mint
  fee the real price and the hash only the queue.
- GPU miners outcompete phones; caps and retargeting only soften that.
- A card market can distract from the token. Cards must stay a lens on the seats, not a second product
  line: no emissions, no staking, no "card token".
- New contracts need the same treatment as the first set: tests, invariants, two independent reviews,
  the swarm's review if launched through IMD as `evm_contracts`.

## Sequence

1. After the mainnet launch and the hackathon submission.
2. Spec revision (this document → a numbered spec), then the Card and Mine contracts with Foundry tests
   and invariants (no mint without a valid solution; fee always burned; `tokenURI` never lies about
   held/sold; caps hold), then review.
3. The browser miner in the site (a Web Worker, adjustable power, the same design language), the
   mint flow through the existing wallet layer, cards on the seat sheets.
4. Optional: the work feed through the IMD oracle, for traits.

Rough size: two small contracts and a miner UI, two to three weeks including review.

## Metamorphosis as the mining loop (owner's direction, 2026-10-12)

The hash work is not a lottery ticket for one mint; it is how a card grows through four stages, each
gated by proof of work from the miner's CPU or GPU, and the last one by the seat's real life.

| Stage | How it is reached | What the miner does | Burn |
|---|---|---|---|
| **Egg** | a solution under the epoch target (`keccak(minter, seat, epoch, nonce) < target`) plus the mint fee | one solution, CPU or GPU | mint fee in PUPATE, burned |
| **Larva** | the egg hatches on the first feed | **feeds** the card: keeps mining and submits solutions in batches; each accepted batch raises the card's `work` counter; the card's drawing fills in as `work` grows | none beyond gas (optionally a small PUPATE fee per batch, burned) |
| **Chrysalis** | `work` reaches the pupation threshold, which scales with the seat's real accepted jobs (via the work feed): a harder-working seat makes a card that takes more mining to pupate | stops; the card is sealed for a cocoon period of N epochs | pupation fee in PUPATE, burned |
| **Butterfly** | the cocoon period has passed **and** the seat's listing has sold (`Cocoon.SeatSold`), or, failing a sale, after a long ceiling (e.g. 90 days) so no card is stuck | nothing; the metamorphosis is the seat's | none |

Why this fits better than a plain mint race:

- **Breadth, not depth.** Each card can absorb at most `cap` solutions per epoch. A GPU farm cannot
  push one card through the larva stage faster than a phone; it can only raise more eggs, and every
  egg burns PUPATE. The GPU's advantage becomes burn volume, which is what the token wants.
- **CPU and GPU both count.** The puzzle is plain keccak256 over `(minter, seat, epoch, nonce)`, so
  the browser miner (a Web Worker on CPU, a WebGPU compute shader where available) and a standalone
  CLI miner (Node for CPU, OpenCL/CUDA for GPU, same puzzle) submit the same kind of solution. A
  solution is bound to the minter's address, so pools and relays cannot steal it.
- **Difficulty and price rise together.** The epoch target retargets toward a network-wide cadence
  (for example one accepted solution per ten seconds) and the mint fee rises per epoch (×1.25), as
  decided; later miners work harder and burn more per card.
- **Real work sets the bar.** The pupation threshold reads the seat's accepted jobs from the work feed
  (IMD's records, through the oracle). Cards of seats that worked more are harder to pupate and
  rarer as butterflies: the proof of work in the hash is spent on a proof of work by a seat.
- **Gas stays small.** Solutions are submitted in batches (`feed(cardId, nonces[])`, one transaction
  per epoch per card); each nonce costs one keccak and a compare. At today's mainnet fees that is
  cents.

State machine on-chain (`ChrysalisCards`): `stage ∈ {Egg, Larva, Chrysalis, Butterfly}`, `work`,
`pupatedAtEpoch`, `seat`, `round`; `tokenURI` draws the stage. `CardMine`: epochs, target, per-card
and per-wallet caps, batch verification, fees burned through `PupateToken.burnFrom`. Cocoon,
PupateHook, PupateToken and FloorFeed are read, never changed. Resale royalty 5% to the developer,
enforced with a creator-token transfer validator and a Seaport zone of our own.

Still after the mainnet launch and the first cocoon; the numbers (cap, cadence, cocoon period,
pupation formula, fees) are set when the contracts are built and reviewed, and published on the Mine
page before mining opens.
