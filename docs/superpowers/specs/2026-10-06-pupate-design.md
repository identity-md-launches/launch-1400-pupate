# Pupate: design spec

Date: 2026-10-06
Status: revision 7. Revision 2 followed the Phase 0 desk findings in `docs/phase0-findings.md`; revision 3 followed the independent review of Plan 2 in `docs/REVIEW.md`; revision 4 records the decisions made while building Cocoon; revision 5 followed the independent review of Cocoon; revision 6 moved the pool to IMD's 1.25% tier; revision 7 records what the checks before the mainnet launch changed. The change lists at the end say what moved.

## Summary

Pupate is a strategy token on Ethereum mainnet, launched through the IMD launchpad (imd.fun) as a `univ4_hook` launch. A tax on every trade in the launch pool funds a vault that buys Identity MD NFTs (IMD swarm seats). Each seat works in the IMD swarm while it is listed for resale. An IMD oracle report of a reference price for the collection decides how much of the tax buys seats and how much buys back and burns the token.

- Name: Pupate
- Ticker: PUPATE
- Domain: pupate.fun
- Target collection: identity.md (IDMD), `0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D`, 2,000 tokens. Confirmed on-chain.

## Goals

1. Buy Identity MD seats with trading tax, with no human holding the funds.
2. Put every held seat to work in the IMD swarm, and route what it earns back into the vault.
3. Shift between buying seats and burning the token based on the reference price.
4. Give the developer a visible, bounded income that also pays the running costs.

## Non-goals (this spec)

- Open operator market (leasing seats to third parties). Later, separate spec.
- Swarm-voted treasury decisions. Later, separate spec.
- Any chain other than Ethereum mainnet. No bridges.
- An upgradeable hook.
- Restricting where the token can trade. IMD requires a plain ERC-20 (see Known risks).

## Flow

1. A trader buys or sells PUPATE in the launch pool. The hook takes 6% of the ETH side of the trade. The pool's own 1.25% LP fee applies as well; under IMD's launch terms 1% of every trade goes to the wallet that paid for the launch and 0.25% to the IMD network.
2. Anyone can flush the collected tax to Cocoon. Cocoon splits it: 85% strategy, 10% developer, 5% IMD burn. The strategy share is divided between the seat pot and the burn pot according to the current mode.
3. Anyone can trigger a seat purchase when the seat pot can afford one.
4. The purchased seat is listed for resale at a descending price and paired to a worker device.
5. Tokens the seat earns are auctioned for ETH, which goes to the seat pot.
6. When a seat sells, the ETH goes to the burn pot, which buys PUPATE from the launch pool and burns it.

## Components

### PupateToken

A plain ERC-20, as IMD requires: 18 decimals, fixed supply of 1,000,000,000 minted once to the launch factory, no transfer fee, limit, pause or mint. Holders can burn their own tokens.

| Share | Recipient |
|---|---|
| 10% | IMD swarm (launch rule) |
| 85% | Launch pool, single-sided |
| 5% | Developer. The launch delivers it to the requester wallet; the developer moves it into PupateVesting. |

### PupateHook

A Uniswap v4 hook on the launch pool. Not upgradeable. Constructor arguments: the PoolManager, the sink (Cocoon), and the owner (the timelock).

- **Launch pool.** The first native-ETH pool initialised on the hook becomes the launch pool. Only that pool is taxed. The IMD factory deploys the hook and initialises the pool in one transaction, so no other pool can take that place.
- **Liquidity.** Liquidity can be added only to the launch pool, and only in the transaction that opens it, which is IMD's factory seeding it: the hook marks that transaction in transient storage, and the mark is gone when the transaction ends. After that the pool's liquidity can only shrink; removing liquidity is never blocked. This closes trading by resting liquidity, which the hook could not tax.
- **Standing tax.** 6% of the ETH side of every buy and every sell. On a buy that is 6% of the ETH the trader pays; on a sell it is 6% of the ETH the pool pays out. Rounded down.
- **Launch schedule.** The buy tax starts at 99% when the launch pool opens and falls continuously, one percentage point per minute, until it meets the standing tax (93 minutes at 6%). Sells are always at the standing tax.
- **Collection.** The tax is taken inside the swap as PoolManager claims. No ETH moves, and no contract other than the PoolManager is called, during a swap. `flush()` is callable by anyone: it converts the claims to ETH and hands the hook's whole ETH balance to Cocoon. ETH forced into the hook reaches Cocoon the same way, so deliveries can exceed the hook's `totalTax`; nothing downstream assumes they are equal.
- **Cocoon's own swaps are not taxed.** Cocoon swaps only to buy back and burn.
- **Partial fills.** A swap that names an exact ETH amount and cannot be filled in full reverts, because its tax was computed on the full amount.
- **Owner.** May lower the standing tax. Nothing can raise it. The owner has no other power.

Why a launch schedule and not a wallet cap: the token must be plain, and a hook sees the router, not the buyer, so a per-wallet limit cannot be enforced. Capping each swap or each block does not change who ends up with the cheap supply. A buy tax that starts high and falls is a Dutch auction: whoever buys early pays for it, and the payment goes to the vault instead of to a sniper.

### FloorFeed

Stores the latest reference price of the collection as attested by the IMD oracle. Built and tested in Plan 1.

- `report(attestation, signature)` is callable by anyone. It verifies the oracle's EIP-712 signature (domain `IdentityMD Oracle`, version `2`, bound to FloorFeed's own address and chain) and stores the price and its issue time.
- Only attestations for one pinned question are accepted. The question asks a panel of twenty seats for the collection's floor, the lowest active listing OpenSea reports, and needs eleven of them to agree within 2%. The owner sets the question's hash, because the hash is only known once the first request has been made; changing it later goes through the timelock. Setting the question clears the stored price, and the first report after that is not rate-limited. Setting the same hash again is the way to clear a bad value.
- The attestation must name the evidence chain fixed at deployment (mainnet, where the collection lives), carry a quorum of at least 4 that is a majority of its panel, and be valid for at least the freshness window.
- A report is fresh for 6 hours after it was issued, or until the attestation's own expiry if the owner has since lengthened the window.
- **Rise limit.** The stored price may rise by at most 25% per 6 hours between two reports, measured between their issue times. The limit applies whether or not the earlier report is still fresh, so a report held back until the previous one lapses gains nothing, and reports in quick succession cannot compound. Falls are not limited, because a lower reference only makes the vault buy less. A genuine jump larger than the limit is reflected once enough time has passed; until then the vault simply does not buy.

This document calls the stored value "the floor". Since revision 7 it is the lowest ask, read from the marketplace by the panel: IMD's on-chain evidence cannot compute a price from Seaport's events, and a floor that follows the cheapest listing bounds what the vault can be made to pay.

### Cocoon (vault)

Holds the seat pot, the burn pot, and the seats. Functions are callable by anyone unless stated.

**Tax intake.** `depositTax()` accepts ETH and splits it: 10% to the developer balance, 5% to the IMD burn balance, 85% to the strategy. The strategy share is divided between the seat pot and the burn pot by the mode at that moment.

**Mode.** Derived on read. Rows are evaluated top to bottom; the first match applies.

| Condition | Mode | Seat pot | Burn pot |
|---|---|---|---|
| No fresh floor report | NEUTRAL | 50% | 50% |
| Cocoon holds no seats | ACCUMULATE | 70% | 30% |
| Floor at or below the average purchase price of the seats held | ACCUMULATE | 70% | 30% |
| Floor above that average | BURN | 30% | 70% |

**Buying.** `buySeat(order)` fulfils a Seaport 1.6 listing when all of these hold:

- the item is one token of the target collection, in full (no partial fills),
- every consideration item is native ETH, with a non-zero amount, paid to someone other than Cocoon,
- the consideration array is exactly the order's original one, so a fulfiller cannot append tips that Seaport would pay from the price,
- a fresh floor report exists,
- the price (the highest the order can ask) is at most 105% of the floor,
- the seat pot covers the price plus the caller reward.

The caller receives 0.5% of what was actually spent, from the seat pot.

**Refunds.** Cocoon sends the listing's highest possible price and Seaport returns what the order did not need. During a purchase Cocoon accepts ETH from Seaport only, and counts it as the refund; ETH from anyone else, and any call to `depositTax`, reverts the purchase. The seat's cost is therefore exactly what Seaport paid out to others, and a refund stays in the seat pot. (An earlier design took the cost from the balance change, which let a seller route the payment back into Cocoon and book a seat at almost nothing while collecting the reward.)

**Listing.** On purchase, Cocoon publishes two signature-free Seaport orders for the seat and validates them on-chain: one whose price falls linearly from 1.5x the purchase price to 1.1x over 14 days, and a flat tail at 1.1x that starts when the first ends and runs for ten years. No off-chain key signs anything. The orders carry a per-seat round number, so the orders of an earlier purchase of the same seat can never collide with a later one's. The listing terms are fixed at purchase; a later change of parameters applies to new purchases only.

**Selling.** When a listing fills, the ETH goes to the burn pot. `settleSeat(tokenId)`, callable by anyone, takes a sold seat off the books (`heldCount`, the average cost) and cancels its other order on Seaport, so the seat cannot be sold at a stale price if the vault ever buys it back. It also works when the buyer sends the seat straight back: a filled order on Seaport is proof of the sale, and `adopt` can take the seat in again at the floor.

**Adoption.** A seat sent to Cocoon directly is taken onto the books by `adopt(tokenId)`, callable by anyone, at the current floor, and listed like a purchase. Safe transfers that are not part of a purchase are refused, so nothing but the collection can land in the vault by callback.

**Burning.** `burn()` spends burn-pot ETH on PUPATE in the launch pool and burns what it receives. One call may move the pool price by at most 5%, and calls must be at least 5 blocks apart. Because every other trader pays the tax on both legs, moving the price by that much is not worth sandwiching. The caller receives 0.5% of the ETH spent. The limit is applied to the price the trade actually pays, not to the pool's quoted spot price alone: right after the open the spot price sits above all liquidity, and a 1-wei sell can move it to the maximum for free. Cocoon's swap parameters are fixed in code, since its swaps are the only untaxed ones, and Cocoon never calls `flush` from inside its own PoolManager unlock.

**Harvesting.** Seats earn ERC-20 tokens (launch allocations and IMD). `startAuction(token)` opens a falling-price auction for Cocoon's whole balance of that token. The price starts at 1 ETH (a parameter), halves every 2 hours, falls in a straight line inside each half-life, and is zero from 48 hours on. The first taker gets the whole lot, pays the price of that moment, and gets any excess back; the price goes to the seat pot. Tokens that arrive during an auction wait for the next lot. PUPATE is never auctioned; any PUPATE balance is burned by `burnPupate()`.

**IMD burn.** The IMD burn balance is auctioned the other way round, on the same curve: the IMD a taker must deliver starts at 20,000 IMD per ETH of the lot (a parameter) and falls; the first taker receives the ETH lot, and the IMD they deliver goes to the dead address. Cocoon does not route through IMD's pools. Start values are fixed when an auction starts; a parameter change does not move a running auction.

**Developer balance.** `claimDeveloper()` pays the accrued balance to the developer address. Only the developer address can change the developer address.

**Pairing.** IMD pairs a device to a seat by checking an EIP-712 `WorkerAuthorization` signed by the seat's holder, and accepts ERC-1271 when the holder is a contract. Cocoon's operator approves a specific authorisation on-chain, and Cocoon's `isValidSignature` returns valid only for approved authorisations of seats it still holds from the same purchase: an approval dies when the seat sells and does not revive if the seat comes back. That is all the operator can do: it cannot transfer seats, move ETH, or change parameters. In this phase the operator is the developer.

**Wiring.** Cocoon is deployed before the launch, so it learns the launch pool afterwards through a one-time `wire` call by the owner. `wire` accepts only a native-ETH pool whose hook names that pool as its launch pool and Cocoon as its sink, so the irreversible step cannot point at the wrong pool. Until then `burn()` and `burnPupate()` are disabled.

**Accounting.** Cocoon's balance always equals its four pots added together: seat pot, burn pot, developer balance and IMD-burn balance. This is checked by a stateful invariant test across random sequences of every action. ETH forced in without a call (for example by `selfdestruct`) is booked as proceeds by `skim`, callable by anyone.

**Harvest limits.** `startAuction` refuses the zero address, PUPATE and the collection itself, and runs only once Cocoon is wired.

### PupateVesting

Holds the developer's 5% of supply and releases it linearly over 12 months to the developer address. No other function.

### Timelock

A 48-hour timelock owns the hook, FloorFeed and Cocoon.

### Keeper bot

An off-chain script, runnable by anyone, that:

- requests floor reports from the IMD oracle on a schedule and submits them to FloorFeed,
- flushes the hook,
- finds the cheapest valid listing and calls `buySeat`,
- calls `burn`, `startAuction` and the IMD auction when there is something to process.

The bot holds no privileged key. If it stops, anyone else can make the same calls.

### Website

A Next.js application exported as a static site (`output: 'export'`, in `site/`), hosted on IPFS at pupate.fun, with no backend. Wallets connect through RainbowKit on wagmi and viem, with the modal themed from the page's own tokens. It reads the chain through a public RPC and seat work statistics from IMD's public API. It carries its own swap panel, because third-party interfaces may not route through a pool with a custom hook.

The visual language is IMD's own, so Pupate reads as part of the ecosystem: IBM Plex Mono as the only typeface, paper and ink with a dark variant, 1.5px rules and square corners, small tracked uppercase labels, big bold figures, green as the single accent, a boxed top bar with an inverted active item, a three-panel overview with an action row, a boxed swap with Buy/Sell tabs, key-value rows with hairlines, and a fixed status bar at the bottom.

#### UI/UX concept: the life cycle is the interface

The page is the insect's life cycle, and each stage is a live part of the protocol. A visitor who reads it top to bottom has read how Pupate works. A static design preview with sample figures is at `site/prototype.html`; it is the reference for Plan 4's site.

| Stage | What it is in the protocol | What the visitor sees |
|---|---|---|
| **Feed** | Trading and tax | The swap panel, the tax rate that applies right now, total tax collected, and how full the seat pot is against the price of the next seat ("next cocoon: 71%"). |
| **Cocoon** | Seats held, working, and listed | One chrysalis per seat, each with a specimen tag: seat number, purchase price, current listing price, day of 14, jobs accepted. |
| **Emerge** | Seats sold, tokens burned | Each sold seat as an empty shell with its sale price and the PUPATE burned with the proceeds; running totals of PUPATE and IMD burned. |

Above the stages, a **Conditions** strip shows the last floor report, how long it stays fresh, and the mode under its field name:

| Mode | Field name | Meaning shown |
|---|---|---|
| ACCUMULATE | Spinning | More of the tax is buying seats |
| BURN | Shedding | More of the tax is burning PUPATE |
| NEUTRAL | Resting | Waiting for a fresh floor report |

Rules the design follows:

- **A chrysalis shows its own state.** It starts opaque and turns translucent as its listing price falls over the 14 days, the way a real chrysalis clears before the adult emerges. Ripeness is readable at a glance, and the tag carries the same information in numbers.
- **Visual language.** A field naturalist's notebook and specimen drawer: paper, ink, hairline rules, monospace specimen tags, inked line drawings. One accent pair, jade green and gold, taken from the monarch chrysalis. A dark variant uses the same drawings on deep green-black. No neon, no gradient hero, no generic dashboard cards.
- **Voice.** Field notes: short, present tense, factual. "Day 6. Seat 1376 is working. 41 jobs accepted. Listed at 3.31 ETH."
- **The tax is never a surprise.** The current buy and sell tax sits beside the swap button. During the launch schedule the panel shows the countdown: "Buy tax now 43%. Reaches 6% in 37 minutes."
- **Every number links to its source**: a contract read or a transaction on a block explorer.
- **Anyone can run a step.** Flush, buy, burn and the auctions are shown as actions with the caller reward beside them.
- **No statement about returns**, and no sample or placeholder figures on the live site.
- **Access.** Stages stack on a phone. Mode is shown by label and icon, not colour alone. Motion is reduced when the visitor asks for it. Text meets WCAG AA contrast in both variants.

All site copy is English.

## Control

- The timelock owns the hook, FloorFeed and Cocoon.
- The standing tax can only be lowered.
- Changeable by the timelock within hard-coded bounds: mode split (30–70%), listing start multiple (1.1x–3x), listing end multiple (1.0x–1.5x), listing decay period (1–60 days), price tolerance above the floor (0–10%), caller rewards (0–1%), report freshness (1–24 hours), burn price-impact limit (1–10%), blocks between burns (1–300), harvest auction start price (0.01–100 ETH), IMD auction start demand (100–10,000,000 IMD per ETH), operator address, oracle attester address, oracle question hash (setting it clears the stored price).
- Not changeable by anyone: target collection, token supply, the 85/10/5 split, the launch schedule, the liquidity gate, the hook's sink, the evidence chain the oracle question reads, the rise limit of 25% per 6 hours, and the rule that pot ETH can only buy seats or buy and burn PUPATE.

## Developer income

- 10% of the tax, which is 0.6% of each trade at the standing rate. It accrues in Cocoon and is claimed by the developer address.
- 5% of token supply, vested linearly over 12 months.
- From the pool's LP fee, what IMD's launch terms give the wallet that paid for the launch: 1 of the 1.25 points on every trade (the other 0.25 goes to the IMD network; anyone can call the distribution). This is IMD's rule, not Pupate's contracts, and it can change with IMD's policy.

## Running costs

The developer share is also what pays for operation in this phase:

- Floor reports: each oracle request costs 0.5 IMD, so four a day is 2 IMD a day.
- Keeper gas for reports, flushes, purchases, burns and auctions.
- One machine and one Claude or Codex subscription per seat that is put to work.

If the developer stops paying, the system degrades but does not lock: anyone may pay for and submit a report, and the purchase reward makes that worthwhile when a seat can be bought. Without reports, buying halts and the split falls back to 50/50.

## Deployment order

1. Deploy the timelock, FloorFeed and Cocoon (`script/DeployPreLaunch.s.sol`).
2. Make the first oracle request with FloorFeed as its consumer; keep the question hash and the attestation.
3. Launch through IMD: the factory deploys PupateToken and PupateHook (with Cocoon and the timelock as constructor arguments) and opens and seeds the launch pool in one transaction. Confirm on-chain that the hook's sink, owner and launch pool are the intended ones.
4. Wire Cocoon to the launch pool, deploy PupateVesting and move the developer's 5% into it, set the question hash, and hand FloorFeed and Cocoon to the timelock (`script/PostLaunch.s.sol`).
5. Submit the first report, start the keeper, publish the site, pair the first seat.

Details: `docs/deployment.md`.

## Plans

| Plan | Scope | State |
|---|---|---|
| 1 | Repository, FloorFeed, Phase 0 desk findings | Done |
| 2 | PupateToken, PupateHook, independent review | Done |
| 3 | Cocoon, PupateVesting, timelock | Built and reviewed; the mainnet-fork test needs an RPC |
| 4 | Launch manifest, Sepolia rehearsal, keeper bot, website | Next |

The Sepolia rehearsal in Plan 4 is where the remaining Phase 0 questions are settled: whether the swarm's review admits the hook as designed, whether a seat held by a contract can be paired, and whether the oracle panel agrees on the floor question.

## Testing

- Unit tests per contract.
- Hook tests run against a real v4-core PoolManager, in all four swap modes.
- Mainnet-fork tests for Seaport purchase and listing against the real collection.
- Invariant tests:
  - tax collected equals claims held by the hook plus ETH delivered to Cocoon;
  - pot ETH leaves Cocoon only to Seaport (seat purchase), the launch pool (buyback), or as a bounded caller reward;
  - the standing tax never increases;
  - a seat leaves Cocoon only through a filled listing;
  - the operator cannot move assets;
  - a rejected report never changes the stored floor, and no report raises it faster than the rise limit.

## Known risks

- **The tax can be avoided in other pools.** The tax lives in the hook of the launch pool. The token is a plain ERC-20, so anyone can open another pool for it and trade there untaxed. IMD6900 does not have this weakness: its token refuses transfers that bypass its pool, which is possible because it was not launched through IMD. The launch pool holds 85% of supply and the site trades through it, which keeps most early volume there, but the leak grows with success. Lowering the standing tax narrows it.
- **Token scanners will flag the launch.** For the first 93 minutes the buy tax is far above what scanners treat as normal.
- **Reference-price manipulation.** The floor is the lowest listing the panel reads on OpenSea. Listing cheaper lowers it, which only offers the vault a cheaper seat; raising it takes buying or outlasting every cheaper listing, or a panel that is wrong. Limited by the rise limit of 25% per 6 hours, which applies whether or not the previous report is fresh, and by the price tolerance and the 30–70% split range. Anyone holding a seat can still sell it to the vault at up to 105% of the reference price, which is now 105% of the cheapest listing rather than of a median of past sales that sits above the market while prices fall.
- **Trades made by providing liquidity would not be taxed.** The hook taxes swaps, so a seller who could rest PUPATE as a narrow position just above the price would be filled by buyers without paying the sell tax. The liquidity gate closes this: liquidity can be added only in the transaction that opens the launch pool, and IMD's factory opens and seeds in one transaction (verified on launches 775, 1283 and 1341). Until revision 7 the gate was the opening block, which left room for a bot to put its own position behind the launch transaction in the same block; the transaction-scoped mark removes that. The pool therefore never has liquidity beyond the factory's position, and nobody can provide liquidity later.
- **Thin seat yield.** Seat earnings are split across all connected seats (about 650 today) and may be small. The design still works without them, as a tax-and-flip strategy.
- **Seats that do not sell.** After 14 days a seat sits at 1.1x until bought. Capital is tied up if the market falls below that.
- **Oracle dependency.** If the IMD oracle stops, buying halts and the split falls back to 50/50, with the seat pot accumulating unspent.
- **Fixed sink.** The hook's sink cannot be changed. If Cocoon ever refuses deposits, collected tax stays in the PoolManager as claims.
- **Unaudited platform.** IMD itself has no formal audit.
- **Unverified integrations.** Pairing a contract-held seat and the floor question have not been exercised end to end.
- **Existing competitor.** IMD6900 runs a similar strategy on the same collection, with a tax that cannot be avoided.

## What the user provides

- An Ethereum wallet with ETH for gas and IMD for paid actions (0.5 IMD each).
- A GitHub account for the contract repository.
- The pupate.fun domain.
- One machine and a Claude or Codex subscription to run the first seat.

## Changes in revision 2

1. Pool fee corrected to 0.3%, held by IMD. The "1% deployer fee" is gone; developer income is now a 10% share of the tax.
2. The tax split moved from the hook to Cocoon. The hook only collects.
3. The mode is computed in Cocoon, which knows the average purchase price. FloorFeed only stores the price.
4. The per-wallet launch cap is replaced by a falling launch buy tax. IMD's plain-token rule makes a wallet cap impossible.
5. Cocoon's buyback is exempt from the tax and bounded by price impact per call.
6. The IMD burn share is sold by auction instead of routed through IMD's pools.
7. FloorFeed's question hash is set by the owner after deployment instead of in the constructor.
8. New sections: UI/UX concept, running costs, deployment order.
9. New known risks: tax avoidance through other pools, scanner flags, reference-price manipulation, fixed sink.

## Changes in revision 3

1. FloorFeed's "25% while the previous report is fresh" cap is replaced by a rise limit of 25% per 6 hours that always applies. Falls are not limited.
2. FloorFeed checks the attestation's evidence chain (fixed at deployment), a minimum and majority quorum, and a minimum validity.
3. Setting FloorFeed's question clears the stored price.
4. The launch schedule is described as continuous, as the hook implements it.
5. `flush` is described as handing over the hook's whole balance.
6. The hook gates liquidity: it can be added only to the launch pool in the block that opens it. Adopted after the review showed that trades made by resting liquidity escaped the tax.
7. Notes for Cocoon's `burn()`: price-impact limit on the trade's own price, fixed swap parameters, no `flush` from inside its unlock.

## Changes in revision 4

Decisions made while building Cocoon (Plan 3):

1. Listings are two validated Seaport orders per seat (falling, then a flat tail) with a per-seat round number; `settleSeat` cancels them when the seat sells.
2. Refunds from Seaport stay in the seat pot; the seat's cost is the balance change.
3. Seats sent directly to Cocoon are adopted at the floor rather than refused.
4. The auction curve halves every 2 hours and reaches zero at 48 hours; start values are parameters fixed at the start of each auction.
5. `wire` verifies the hook's launch pool and sink.
6. `burn()` holds back the caller reward before swapping, so the pot always covers it, and reverts rather than records a burn when the pool sells nothing within the limit.

## Changes in revision 5

After the independent review of Cocoon (`docs/REVIEW.md`):

1. A seat's cost is the price minus Seaport's refund, not the balance change; during a purchase only Seaport may send ETH and `depositTax` reverts.
2. Orders must carry exactly their original consideration items (no fulfiller tips), every item paid to someone other than Cocoon with a non-zero amount.
3. The caller reward is 0.5% of what was spent.
4. `skim` books forced-in ETH as proceeds.
5. `startAuction` refuses the collection and needs the wire.
6. Pairing approvals are tied to the purchase round of the seat.
7. `settleSeat` accepts a filled Seaport order as proof of sale, so a seat sent straight back can be settled and adopted again.
8. `wire` also requires the hook to have opened its launch pool.

## Changes in revision 6

- Pool LP fee tier 12500 (1.25%) instead of 3000. IMD's `univ4_hook` policy v34 for mainnet (created 2026-10-07) allows only `[12500]` for hook launches; the `[500, 3000, 10000]` allowlist recorded in Phase 0 now applies to `evm_project` launches. The hook is fee-agnostic, so only the launch manifest, the post-launch pool-key default and the site's sample arithmetic change.

## Changes in revision 7

What the free checks before the mainnet launch changed (2026-10-12). Nothing had been paid to IMD and neither the token nor the hook was deployed when they were made.

1. **Liquidity gate: the opening transaction, not the opening block.** `afterInitialize` sets a mark in transient storage (EIP-1153) and `beforeAddLiquidity` requires it, so a later transaction is refused even in the block that opened the pool. IMD's audit judge had parked another hook launch (#1183) whose gate exempted the whole opening second "not the factory's opening transaction"; ours exempted the whole opening block. Receipts of three real launches confirm IMD's factory deploys, initialises and seeds in one transaction. `openedAtBlock` stays as a public record. An independent review of the change before launch found nothing blocking and replayed the launch on a mainnet fork through IMD's real factory; it asked for one more regression test, which was added, and for one residual to be disclosed: the mark names no account, so code running later inside the opening transaction could add liquidity too. The factory runs no such code (`docs/REVIEW.md`).
2. **The reference price is the collection's lowest listing, read by a panel.** The planned question (the 24-hour median of Seaport sales, as chain evidence) cannot be answered: IMD's chain evidence runs a fixed set of recipes (log counts, log sums, rankings, a view-call comparison, Uniswap v4 spot prices), and none yields the price of an NFT sale. A question asking a panel for the identity.md floor on OpenSea had already been attested for someone else (20 seats, 14 agreed within 1%, three minutes). Pupate asks the same of 20 seats with a quorum of 11 within 2%. FloorFeed is unchanged: it pins a question hash and checks the panel, whatever the evidence. The floor also bounds the vault better than a median of past sales, which sits above the market while prices fall and would let a holder sell the vault a seat at 105% of it.
3. **Developer income includes IMD's launch-wallet share of the pool fee.** IMD's documentation states the 1.25% pool fee as 1% to the wallet that paid for the launch and 0.25% to the network. The spec had recorded this share as undocumented and counted it as zero.
4. **The paid IMD path was corrected before its first use.** The free check takes an oracle question in a short form and the quote takes the full body; addresses must be lowercase; the challenge request carries no content type; the signer is the wallet's own account, not a wallet client; the x402 client is told it may pay IMD, up to the action's price; the oracle request id is read from the admission's result. The whole flow now runs to the last call before payment in a dry run.
5. **The launch request launches the exact code.** Its steps are `audit-imported-code → adversarial-review`, the shape IMD admitted for launch #1205: an audit of the code as it is, the manifest, four specialist audits and a judge, where the only node that can write is the manifest node and only to `launch.json`. The earlier request had an adapt step between the two, which gives an agent a write budget over the source to fix what the audit finds. Pupate cannot use that: the hook is bound to a Cocoon that is already deployed.
