# Pupate keeper and IMD client

Off-chain tools. Nothing here holds a privileged key: every on-chain step the keeper runs is a public
function of the contracts, and if the keeper stops, anyone can make the same calls (see
`site/public/skill.md` for the human and agent description of each step).

    npm install                      # Node 22+, viem; nothing else

## The keeper

`bin/keeper.mjs` is the loop that keeps the protocol moving. Each tick it reads the whole state in
one multicall and the seats Cocoon holds (from its `SeatBought` / `SeatAdopted` / `SeatSold` logs,
cached in `.state/<chainId>.json`), prints one status line, decides the steps below in order, and
finally rewrites the [status feed](#the-status-feed) (`status.json`, `listings.json`) for anyone
reading the vault without an RPC:

| step | call | when |
|---|---|---|
| a. report | `FloorFeed.report(attestation, sig)` | no report stored, or the stored one is stale or goes stale within `REPORT_LEAD`, or it is older than `REPORT_EVERY`, or `--force-report` |
| b. flush | `PupateHook.flush()` | the hook's ETH claims on the PoolManager are at least `MIN_FLUSH_WEI` |
| c. settle | `Cocoon.settleSeat(id)` | a held seat's owner is no longer Cocoon, or either of its two Seaport orders shows `totalFilled != 0` |
| d. buy | `Cocoon.buySeat(order, [])` | the floor is fresh and the cheapest listing that passes `_checkOrder` client-side, is under `floor × (1 + toleranceBps)`, is live on Seaport and is covered by the seat pot (price plus reward) |
| e. burn | `Cocoon.burn()` | wired, the burn pot is at least `MIN_BURN_WEI`, and `burnSpacing` blocks have passed since `lastBurnBlock` |
| f. auctions | `Cocoon.startAuction(token)` / `Cocoon.startImdAuction()` | a `HARVEST_TOKENS` balance with no running auction / an IMD-burn balance of at least `MIN_IMD_AUCTION_WEI` with no running IMD auction. The keeper never takes an auction. |

Every call is simulated with `eth_call` first; a revert is logged by its decoded custom error
(`skip burn: TooSoon (3 blocks)`, `skip buySeat #1376 …: PriceAboveFloor`) and skipped, and no failure
stops the loop. Transactions go out with a sequential nonce and EIP-1559 fees from the node; when
base fee plus tip is above `GAS_PRICE_CAP_GWEI` the keeper waits instead of sending. Each receipt is
logged with its hash, gas and status. After a step that changed state the tick re-reads the state, so
a flush and the buy or burn it makes possible can happen in the same tick.

### Run it

    node bin/keeper.mjs --status                 # print the state and exit
    node bin/keeper.mjs --once                   # one tick (cron)
    node bin/keeper.mjs --loop                   # a tick every LOOP_EVERY seconds (pm2 / systemd)
    node bin/keeper.mjs --once --force-report    # report now, whatever the age of the stored one
    DRY_RUN=1 node bin/keeper.mjs --once         # simulate everything, send nothing

Two ways to keep it running on a small VPS:

- **`--loop` under a supervisor.** `pm2 start bin/keeper.mjs --name pupate-keeper -- --loop`, or a
  systemd unit with `ExecStart=/usr/bin/node /opt/pupate/keeper/bin/keeper.mjs --loop`,
  `Restart=always`, `EnvironmentFile=/etc/pupate-keeper.env`. SIGTERM finishes the current tick.
- **`--once` from cron.** `*/5 * * * * cd /opt/pupate/keeper && node bin/keeper.mjs --once >> keeper.log 2>&1`.
  Reports are only attempted every `REPORT_RETRY` seconds, so a tight cron is safe.

Logs are one line per decision, ISO-timestamped:

    2026-10-08T07:41:03.120Z [tick 12] block 26146001 | floor 2.8 ETH fresh (stale in 5h12m) | hook claims 0.1877 ETH | pots seat 0.0645 ETH burn 0.0276 ETH dev 0.0108 ETH imd 0.0054 ETH | held 0 | mode ACCUMULATE | supply 1,000,000,000 PUPATE | imd auction none | keeper 9999.9 ETH
    2026-10-08T07:41:03.410Z [tick 12] sent flush 0.1877 ETH -> 0x… (gas 85132, block 26146002)
    2026-10-08T07:41:03.900Z [tick 12] skip burn: TooSoon (3 blocks)
    2026-10-08T07:41:03.901Z [tick 12] idle: report fresh for 5h12m; no seats held; buy: no LISTING_SOURCE

### Environment

Read from the environment, then from the repository's `.env`. Secrets are used as values only and
never printed.

| variable | default | meaning |
|---|---|---|
| `RPC` | `http://127.0.0.1:8545` on chain 31337, otherwise required | the chain's JSON-RPC URL |
| `KEEPER_PRIVATE_KEY` | – | the sending key. Without it the keeper only simulates (as `DRY_RUN=1`). Also the wallet that pays IMD for reports. |
| `ADDRESSES` | `site/public/addresses.local.json` | an addresses JSON (`chainId`, `fromBlock`, `token`, `hook`, `cocoon`, `feed`, `poolManager`, `collection`, `seaport`, `imd`, `poolKey`, …) |
| `COCOON`, `HOOK`, `FEED`, `TOKEN`, `COLLECTION`, `SEAPORT`, `POOL_MANAGER`, `IMD`, `CHAIN_ID`, `FROM_BLOCK` | from the file | explicit addresses; each overrides the file |
| `LOOP_EVERY` | `15` | seconds between ticks in `--loop` |
| `REPORT_EVERY` | `21600` | a report older than this is due |
| `REPORT_LEAD` | `1800` | report when the stored one goes stale within this many seconds |
| `REPORT_RETRY` | `300` | do not attempt a due report more often than this |
| `MIN_FLUSH_WEI` | `0.005` ETH | flush only when the hook holds at least this |
| `MIN_BURN_WEI` | `0.01` ETH | burn only when the burn pot holds at least this (a dust burn costs more gas than it moves) |
| `MIN_IMD_AUCTION_WEI` | `0.01` ETH | start the IMD auction only for a lot of at least this |
| `GAS_PRICE_CAP_GWEI` | `30` | above this (base fee plus tip) the keeper waits; `maxFeePerGas` never exceeds it |
| `TX_TIMEOUT` | `180` | seconds to wait for a receipt |
| `ATTESTATION_SOURCE` | unset | `imd` (the paid IMD oracle flow) or `local` (fork only: sign with `LOCAL_ATTESTER_KEY`). Unset: reports are never attempted, and a due report is noted in the idle line |
| `LOCAL_ATTESTER_KEY`, `LOCAL_FLOOR_WEI` | –, `2.8e18` | for `local`: the feed's attester key (anvil #9 on the fork) and the floor to sign |
| `ALLOW_LOCAL_ATTESTER` | unset | `1` lets `local` run on a chain other than 31337 |
| `IMD_API`, `IMD_PAID_TOKEN`, `PAYMENT_CHAIN_ID`, `ATTESTATION_TIMEOUT` | `https://api.imd.fun`, `.imd/token`, `1`, `1800` | the IMD control plane, the request token that reads your orders, the chain the 0.5 IMD is paid on, how long to wait for an attestation |
| `LISTING_SOURCE` | unset | `opensea` (OpenSea API v2, cheapest first) or `file` (a JSON array of `{ parameters, signature }`). Unset: the keeper never buys |
| `LISTINGS_FILE` | `keeper/listings.json` | for `file` |
| `OPENSEA_API_KEY`, `OPENSEA_API`, `OPENSEA_CHAIN` | –, `https://api.opensea.io`, `ethereum` | for `opensea` |
| `HARVEST_TOKENS` | none | comma list of ERC-20s to auction when Cocoon holds a balance |
| `LOG_CHUNK` | `50000` | blocks per `eth_getLogs` call when scanning seat events |
| `DRY_RUN` | unset | `1`: simulate every step, never send (also `--dry-run`) |
| `STATUS_DIR` | `site/public` | where `status.json` and `listings.json` are rewritten after every tick and on `--status` (see [the status feed](#the-status-feed)); relative to the repository root; an empty string disables the feed |

### Safety gates

- The keeper refuses to start when the RPC's chain id is not the configured one.
- Nothing is sent without `KEEPER_PRIVATE_KEY`; without it, or with `DRY_RUN=1`, every step stops after
  its `eth_call` and logs what it would send.
- The paid IMD path spends 0.5 IMD per report and runs only with `ATTESTATION_SOURCE=imd` set
  explicitly and a key present; otherwise it stops after the free `check`. A paid order is written to
  the state file (`pendingReport`) before payment and resumed after a crash instead of being paid again.
- `ATTESTATION_SOURCE=local` is refused off chain 31337 unless `ALLOW_LOCAL_ATTESTER=1`.
- Every attestation is verified locally (signer against `feed.attester()`, question against
  `feed.questionHash()`) before `report` is simulated.
- Listings go through the client-side copy of `Cocoon._checkOrder` (one ERC-721 of the collection,
  full order, native ETH only, no item paid to Cocoon, original item count, FULL_OPEN or
  FULL_RESTRICTED, within tolerance of the floor, not already held) plus Seaport's `getOrderStatus`
  (not cancelled, not filled, validated on-chain when there is no signature) before the simulation.
  OpenSea's signed zone (`0x000056F7…D100`) is dropped because its orders need extra data.
- Gas price cap, sequential nonce, receipt wait, one purchase per tick.
- The keeper never takes an auction and never holds Cocoon's ETH; its only income is the caller reward
  of `buySeat` and `burn`.

### The status feed

After every tick, and on `--status`, the keeper writes two JSON files to `STATUS_DIR` (default
`site/public`, so the dev server serves them at `http://localhost:3000/status.json` and the static
export at `https://pupate.fun/status.json` once the site is live). They are what an IMD agent, a
judge or a third-party keeper reads instead of an RPC: the vault's state, what each step would do
right now, and whether this keeper is alive. Each file is written to a temp file and renamed into
place, so a reader never sees a partial one. `lib/status.mjs` builds them; the `steps` block calls
the same decision functions the tick itself runs (`lib/actions.mjs`), on the same state, so the file
never says "ready" where the keeper would have skipped.

Conventions: every integer is a decimal string (wei, seconds, bps, block numbers), `chainId` and
`block` are plain numbers, the `*Eth` fields are floats for humans, times are unix seconds in the
chain's clock and ISO strings for the keeper's own clock.

**`status.json`** (`"schema": "pupate-status/1"`)

| field | meaning |
|---|---|
| `generatedAt`, `chainId`, `block`, `blockTimestamp` | when the file was written, and the block the state was read at |
| `addresses` | `token`, `hook`, `cocoon`, `feed`, `timelock`, `collection`, `seaport`, `universalRouter`, `quoter` |
| `hook` | `buyTaxBps`, `taxBps`, `openedAt`, `totalTaxWei`, `claimsWei` (the tax waiting on the PoolManager, what `flush` would move) |
| `feed` | `floorWei`, `floorEth`, `issuedAt`, `freshUntil`, `fresh`, `reportSource` (this keeper's `ATTESTATION_SOURCE`), and `lastRequestId`, `lastRequestAt` (the IMD oracle request behind the newest report this keeper fetched, `null` until it has fetched one; the site's oracle panel loads that request and verifies it in the browser) |
| `vault` | `seatPotWei`, `burnPotWei`, `developerWei`, `imdBurnWei`, `heldCount`, `heldCostWei`, `mode` (`NEUTRAL`, `ACCUMULATE` or `BURN`), `seatShareBps`, `wired`, `lastBurnBlock`, `burnSpacing`, `params` (every field of `getParams()`) |
| `seats[]` | each held seat: `tokenId`, `costWei`, `boughtAt`, `round`, `filled` (sold, `settleSeat` due), and `listing` { `startWei`, `endWei`, `startTime`, `decayEnd`, `priceNowWei`, `priceNowEth` }: Cocoon's falling Seaport order, its price at `blockTimestamp` computed with `lib/listings.mjs`'s port of `SeatListing` (Seaport's linear interpolation, rounded up) |
| `auctions` | `imd`: `{ lotWei, lotEth, demandWei, startedAt }` or `null`; `harvest[]`: `{ token, lotWei, startWei, startedAt, priceNowWei }` for each running `HARVEST_TOKENS` auction |
| `supply` | `totalWei`, `burnedWei` (1,000,000,000 PUPATE minus `totalSupply`) |
| `steps` | `flush`, `buySeat`, `burn`, `startImdAuction`, `settle`, `startAuction`, `report`, each `{ ready, why }`: what the keeper would do with this state, under this keeper's thresholds (`MIN_FLUSH_WEI`, `MIN_BURN_WEI`, `MIN_IMD_AUCTION_WEI`, `LISTING_SOURCE`). `buySeat` adds `bestListingWei` (the cheapest listing that passes `_checkOrder` and is open on Seaport, when there is one), `ceilingWei` (floor × (1 + tolerance)), `affordableWei` (what the seat pot covers after the reward) and `source`; `settle` adds `tokenIds` |
| `keeper` | `lastTickAt` (ISO; the site turns red past ten minutes), `lastActions` (the last 20 transactions with a receipt: `{ at, action, hash, gasUsed, block, status }`, kept in the state file), `listingSource`, `attestationSource`, `dryRun`, `address` |

**`listings.json`** (`"schema": "pupate-listings/1"`): the market the buy step last looked at, with
`source`, `fetchedAt`, `floorWei`, `fresh`, `ceilingWei`, `affordableWei` and `listings[]`, each
`{ ref, tokenId, priceWei, priceEth, offerer, endTime, withinTolerance, passesOrderRules, ok, reason }`
and never a signature or the raw order. `withinTolerance` is price ≤ `ceilingWei`; `passesOrderRules`
is `_checkOrder`'s structural rules plus, for the five cheapest candidates, Seaport's `getOrderStatus`
(not cancelled, not filled, validated when unsigned); `reason` names the rule that failed. Only the
`opensea` source is published: `file` is the operator's own list and `none` fetches nothing, so both
leave `listings` an empty array (the `note` field says which). Listings are only fetched when the
keeper itself would look (a fresh floor and a seat pot), which keeps the OpenSea calls to one per tick.

    curl -s https://pupate.fun/status.json | jq '.steps, .keeper.lastTickAt'
    node bin/keeper.mjs --status           # prints the summary and rewrites both files

### Untested

- **OpenSea source.** `lib/listings.mjs::listingsFromOpenSea` maps `/api/v2/orders/ethereum/seaport/listings`
  (`protocol_data.parameters` + `signature`) to the AdvancedOrder, but no API key was available here.
  Run it with `DRY_RUN=1` first; it prints what it would buy.
- **The paid IMD path, past its last free step.** `lib/oracle.mjs::imdAttestation` uses the same client as
  `bin/imd.mjs request`: a check in the short form, a quote of the full body, the Permit2 payment and the
  EIP-712 quote approval signed by the keeper's own account, admission, then the oracle request named in
  `admission.result.requestId` until it is attested or ends without an answer. The client has paid for and followed one
  request on mainnet, the launch's first floor question (`script/mainnet/launch.mjs question`), and
  `mapApiAttestation` recovers IMD's attester from its attestation. What has not run live is the keeper's
  own loop around it (the pending order in the state file, the resume after a crash): the keeper's first
  report should still be run with `--once --force-report` and watched.

### The fork test

With the local fork up (`node script/local/up.mjs`, fresh so the launch window is open):

    node keeper/test/fork.mjs

It buys 0.2 ETH of PUPATE from anvil #1 through the Universal Router, runs the keeper `--once` with
`ATTESTATION_SOURCE=local` (anvil #9 signs) and `LISTING_SOURCE=file` as anvil #2, forces a report,
has the real holder of seat 1376 list it on Seaport at 2.8 ETH (validated on-chain, no signature),
funds the pot from anvil #3, lets the keeper buy, has anvil #4 fill Cocoon's falling order, and lets the
keeper settle and burn. It prints PASS/FAIL per assertion and the gas of every transaction the keeper
sent, and exits non-zero on a failure. anvil's keys are derived from its public mnemonic inside the
test and passed to the keeper's environment only.

## IMD client

`bin/imd.mjs` talks to IMD's control plane: free checks, quotes, the two-signature payment (a Permit2
transfer of 0.5 IMD plus an EIP-712 approval of the quote), and polling. It is how Pupate pays for
oracle reports and for the launch itself.

    node bin/imd.mjs capabilities
    node bin/imd.mjs floor-body 0xFLOORFEED          # writes questions/floor.*.json
    node bin/imd.mjs check oracle.request questions/floor.check.json
    KEEPER_PRIVATE_KEY=0x… node bin/imd.mjs request oracle.request questions/floor.quote.json

Before the first paid request, the paying wallet approves Permit2 for IMD once:

    cast send 0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7 'approve(address,uint256)' \
      0x000000000022D473030F116dDEE9F6B43aC78BA3 $(cast max-uint) --rpc-url $RPC --private-key $KEY

Permit2 only moves what a fresh signature of the wallet allows, so the allowance is unlimited, as the
x402 client's own approval is; a finite one would stop the keeper's reports when it ran out.

The request token (`IMD_PAID_TOKEN`, or `.imd/token`) is what reads your orders later; keep it.

## The floor question

`questions/floor.question.txt` is the wording FloorFeed is pinned to: the collection's floor, the lowest
active listing OpenSea reports, answered by a panel of twenty seats of which eleven must agree within
2% (`lib/oracle.mjs::FLOOR_PANEL`). It is panel evidence because IMD's chain evidence runs a fixed set
of recipes (log counts and sums, rankings, a view-call comparison, v4 spot prices) and none yields the
price of a seat. The oracle's `questionHash` is derived from the body, so a change of wording, panel or
definitions means a new question and a timelocked `setQuestion`. The check takes the short form
(`floorCheckInput`); the definitions, the guards and the consumer travel with the quote body
(`floorQuoteInput`), which the keeper builds with the configured FloorFeed as the consumer.

## Files

- `bin/keeper.mjs` the loop; `bin/imd.mjs` the IMD command line.
- `lib/config.mjs` environment and addresses; `lib/chain.mjs` clients, revert decoding, the transaction
  path; `lib/state.mjs` the multicall, the seat cache, the status line; `lib/listings.mjs` Cocoon's own
  Seaport orders (a port of `src/cocoon/SeatListing.sol`), `_checkOrder` client-side, the listing sources;
  `lib/oracle.mjs` report timing, the local signer, the paid IMD flow; `lib/actions.mjs` the six steps and
  their decision functions; `lib/status.mjs` the status feed (`status.json`, `listings.json`);
  `lib/abi.mjs` the ABI slices; `lib/log.mjs` formatting; `lib/imd.mjs` the IMD client.
- `test/fork.mjs` the fork test. `.state/` (git-ignored) the seat cache and the test's listings file.

## The work feed (`work.json`)

Proof of work for the seats: IMD's own record of what each seat has done, condensed. After each tick
the keeper writes `STATUS_DIR/work.json` (schema `pupate-work/1`, the contract in `site/lib/work.ts`)
for every seat the vault holds plus the seats in `WORK_SEATS`, refreshed at most every `WORK_EVERY`
seconds (default 600) because a busy seat's record on `api.imd.fun/seats/<tokenId>` is megabytes and
that endpoint does not allow browser reads. Per seat: paired/online, runtime and model, attempts and
how many were accepted, rejected or failed, the newest jobs with explorer links, and collaborators.
The site's Work page, seat sheets and cocoon cards read it.

| Variable | Meaning |
|---|---|
| `WORK_SEATS` | Comma-separated seat token ids to show besides the vault's own (for example `1,1477`), useful before the vault holds any. Default none. |
| `WORK_EVERY` | Seconds between re-reads of IMD's seat records. Default 600. |
