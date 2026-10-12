# Review log

Independent reviews of this repository, what they found, and what was done about it. The swarm's
adversarial review at launch is separate and comes on top of these.

## 2026-10-06: Plan 2 (PupateToken, PupateHook, FloorFeed)

Reviewer: an agent that had not seen the implementation plan's reasoning. It compared the hook's tax
against a hookless twin pool in all four swap modes (5,000 fuzz runs per mode, with and without a v4
protocol fee), checked the delta accounting against the vendored v4-core, ran 56 mutants of `src/`
against the test suite, and tried third-party denial of service on swaps and `flush`.

### Clean

- Tax amount in every swap mode, at every point of the launch schedule, after the tax is lowered, and
  with a protocol fee set: exactly floor(gross ETH × rate / 10,000).
- Hook delta accounting against `Hooks.sol` and `PoolManager.sol`.
- Partial fills: exact-ETH swaps revert, exact-token swaps fill partly and are taxed on what moved.
- The sink's exemption in all four modes.
- Conservation after trading in every mode, lowering the tax, flushing and withdrawing all liquidity.
- No way for a third party to make swaps or `flush` revert: donated claims, forced ETH and free price
  moves do not block anything.
- `PupateToken`, `ITaxSink`.

### Findings and outcomes

| # | Finding | Severity | Outcome |
|---|---|---|---|
| 1 | FloorFeed's 25% move cap only applied while the previous report was fresh. At the documented cadence the previous report had always lapsed, so the cap almost never applied to a scheduled report but always applied to the correction after a bad one. Reports a second apart could also compound (2 ETH to 11.9 ETH in 8 seconds). | High | **Fixed.** Replaced by a rise limit of 25% per 6 hours measured between issue times, applied whether or not the previous report is fresh. Falls are not limited. Covered by `test/FloorFeed.t.sol` (held-back attestation, quick succession, stale base, two fuzz tests). |
| 2 | Trades made by providing liquidity pay no tax. A seller who rests PUPATE as a narrow position just above the price is filled by buyers without paying the sell tax; a buyer who rests ETH just under the price at the open avoids the launch tax (one such trade received 101,045,666 PUPATE for 1 ETH against 994,240 by swapping). Each matched trade is taxed once, on the taker. | High | **Fixed.** `beforeAddLiquidity` admits liquidity only into the launch pool and only in the block that opened it (hook flags `0x18CC`); removing liquidity is never gated. Tests: `test_liquidityCanBeAddedOnlyInTheBlockTheLaunchPoolOpened`, `test_liquidityCanStillBeRemovedAfterTheOpeningBlock`, `test_noPoolOnTheHookTakesLiquidityBeforeTheLaunchPoolOpens`, `test_aSecondNativePoolIsNotTheLaunchPoolAndTakesNoLiquidity`. The gate is safe only because IMD's factory initialises the pool and seeds it in one transaction. Verified on launch 775: its deployment transaction `0x9eeabe67…11ad2` (from the launch wallet `0xcecc…a551` to the factory `0x12c63b58…a96f`) contains both `PoolManager.Initialize` and `PoolManager.ModifyLiquidity` for the same pool, with the factory as the liquidity sender. Recorded in the spec's known risks. |
| 3 | FloorFeed pinned only the question hash. It accepted a panel of 100 with quorum 1, `agreed` above the panel size, an inverted block window, and an attestation valid for 60 seconds that cut a 6-hour report short and voided earlier honest ones. | Medium | **Fixed.** Quorum at least 4 and a majority of the panel, `agreed` within the panel, validity at least the freshness window, and the evidence chain fixed at deployment. The block window is not checked; the oracle sets it. Whether a requester can vary these fields under the same question hash is still to be confirmed on Sepolia. |
| 4 | `flush` hands over the hook's whole ETH balance, so donated claims or forced ETH are delivered too, and `totalTax` no longer equals deliveries. | Low | **Kept, documented.** Delivering forced ETH to the vault is better than stranding it. The spec and `test_flushAlsoDeliversEthForcedIntoTheHook` state that nothing downstream may assume equality. |

### Lower-severity notes carried into Plan 3

- `flush` reverts with `AlreadyUnlocked` inside any unlock, so Cocoon cannot flush from its own swap callback.
- Right after the open the spot price sits above every position, so a 1-wei sell moves it to the maximum for free. Cocoon's `burn()` price-impact guard must not trust the spot price alone there.
- Every Cocoon code path that reaches `poolManager.swap` is an untaxed trade (99% discount at the open), so `burn()`'s swap parameters must be fixed in code.
- `setMaxAge` applies retroactively: raising it can make a lapsed report fresh again. Intended; pinned by `test_raisingMaxAgeRevivesAnOlderReport`.
- The attestation's `chainId` is read as the evidence chain (it sits beside the block window). FloorFeed takes it as a constructor argument so a Sepolia FloorFeed can read mainnet sales. To be confirmed in the rehearsal.
- `figure` in the attestation is ignored; its meaning is unconfirmed. The `answer` bytes carry the price.
- The constructor does not check that `sink_` has code. The deployment checklist must verify the sink address before the launch is paid for.

### Tests added after the review

Hook: exact-out sell partial fills, exact-out sells during the launch window, the sink's exemption in
every mode, the `LaunchPoolSet` and sell-side `Taxed` events, forced ETH in `flush`. FloorFeed: the
suite was rewritten around the new rules (49 tests), including each expiry rule on its own, the domain
chain id, every zero-address check, ownership transfer, and the events.

## 2026-10-06: Plan 3 (Cocoon, libraries, PupateVesting)

Reviewer: an agent that had not seen the plan's reasoning, with the mock Seaport fixture and the real
PoolManager; no mainnet RPC, so nothing ran against live Seaport. It wrote nine proof tests, all of
which passed against the code as reviewed.

### Clean

- `isValidSignature` against Seaport: digests built under the Worker domain cannot equal a Seaport
  order digest; contract orders and zones naming Cocoon fail elsewhere. The operator can sign nothing else.
- Reentrancy: the lock covers every ETH-moving function; `unlockCallback` needs the PoolManager and
  the lock; Seaport's own guard blocks filling Cocoon's listings mid-purchase.
- `burn()`: the limit `sqrt(0.95)` gives a 5.02% maximum move, the clamp and the settle/take of the
  real deltas are right, the reward is held back, and a 12% round-trip tax makes sandwiching a 5% move
  unprofitable.
- Arithmetic across the casts, `Decay`, the IMD demand and the split rounding; SeatListing salts and
  windows; PupateVesting; Decay; WorkerAuthorization; parameter bounds; developer rotation.

### Findings and outcomes

| # | Finding | Severity | Outcome |
|---|---|---|---|
| 1 | The seat's cost was the balance change during the purchase, and `receive` swallowed any ETH while a purchase was in flight. A seller could list with the payment routed back to Cocoon, buy through `buySeat` themselves, book the seat at 1 wei, collect the 0.5% reward, buy the 1-wei listing back and repeat, draining the seat pot 0.5% per cycle with the balance identity intact. Routing everything back booked a cost of zero, which froze the seat on the books and flipped the mode. | Critical | **Fixed.** `_checkOrder` rejects any consideration item paid to Cocoon and any zero amount. During a purchase `receive` accepts ETH from Seaport only and counts it as the refund; the cost is price minus refund. `test_rejectsOrdersThatPayCocoon`, `test_rejectsZeroAmountItems`, `test_ethFromAnyoneButSeaportDuringAPurchaseRevertsThePurchase`, `test_costIsWhatSeaportPaidOutAndTheRewardIsOnIt`. |
| 2 | Seaport pays consideration items beyond `totalOriginalConsiderationItems` ("tips") from the fulfiller's value, and `_checkOrder` summed whatever array it was given. A keeper could append a tip to itself up to the ceiling, so every purchase would cost the ceiling. | High | **Fixed.** The consideration array must be exactly the original. `test_rejectsConsiderationThatIsNotTheOriginal`; a legitimate two-item split is still accepted. |
| 3 | `depositTax` reachable mid-purchase from a payout recipient or a zone credited the pots and shrank the booked cost, breaking the balance identity. | Medium | **Fixed.** `depositTax` and `skim` revert while a purchase is in flight; non-Seaport ETH reverts the purchase (finding 1). |
| 4 | `startAuction` accepted the collection (a lot of seats) and, before `wire`, PUPATE. | Low | **Fixed.** Rejects the collection, PUPATE and the zero address, and requires the wire. `test_auctionsRejectTheCollectionAndNeedTheWire`. |
| 5 | A pairing approval keyed on ownership alone revived if a sold seat came back by plain transfer, under a departed operator and an expired message. | Low | **Fixed.** Approvals record the seat's purchase round and are valid only while that round is held. `test_pairingApprovalDoesNotReviveWhenTheSeatComesBack`. |
| 6 | A buyer who filled a listing and sent the seat straight back froze its books: `settleSeat` saw it held, `adopt` saw it recorded, and the old flat tail stayed live at the old price. | Low | **Fixed.** `settleSeat` accepts a filled Seaport order as proof of sale; `adopt` then re-records at the floor. `test_aSeatSentBackBeforeSettleCanBeSettledAndAdopted`. |
| 7 | The caller reward was 0.5% of the order's maximum price, not of what was spent. | Low | **Fixed.** Reward on the spend. |
| — | `wire` did not check that the hook had opened its pool; forced ETH broke the `==` identity; IMD's `transferFrom` to the dead address is unverified. | Info | `wire` now requires `openedAt != 0`; `skim` books forced ETH; the IMD transfer is checked in the fork test (Plan 4). |

### Carried into Plan 4

- The fork test should also cover a FULL_RESTRICTED (zoned) order, a two-item consideration as
  OpenSea builds it, the refund path, a repurchase (round 1), `adopt`, and a fulfiller tip being refused.
- No invariant yet tracks the ETH exit paths or "a seat leaves only through a filled listing"; the
  handler settles in the same call, so stale states never persist. Worth adding before launch.
- Cocoon's runtime is 24,191 bytes against the 24,576 limit. Any further addition should come with
  a trim or a split.

## Before the mainnet launch (2026-10-12)

One change to a reviewed contract, made after reading how IMD's own audit treats hook launches, and reviewed independently before it was launched.

| # | Finding | Severity | Outcome |
|---|---|---|---|
| 1 | The liquidity gate admitted liquidity for the whole block that opened the launch pool. A transaction placed behind the launch in the same block could add a one-sided ETH range and take PUPATE from sellers without paying the buy tax, including during the 99% opening window. IMD's audit judge parked launch #1183 for the same class of gate ("exempts the whole opening timestamp, not the factory's opening transaction"). | Medium | **Fixed.** The gate is the opening transaction: `afterInitialize` sets a transient-storage mark, `beforeAddLiquidity` requires it, and the EVM clears it when the transaction ends. `test_theOpeningTransactionSeedsTheLaunchPool`, `test_liquidityIsClosedOnceTheOpeningTransactionEnds`, `test_liquidityStaysClosedInLaterBlocks`, `test_inTheOpeningTransactionOnlyTheLaunchPoolTakesLiquidity`. The fixture opens and seeds in one call, as the factory does; the suite passes in forge's default mode and with `--isolate`, and the launch was replayed on a fork of mainnet with the real PoolManager. |

Checked against three real IMD launch transactions (#775, #1283, #1341): the factory deploys the token, the hook and the distributor, initialises the pool and adds its one position in a single transaction.

### Independent review of the change (2026-10-12)

A reviewer that had not written the change was given the diff, the hook and its tests, and asked to break the gate or the launch. Verdict: safe to launch, nothing blocking. It ran the suite on forge 1.7.1 and on forge 1.8.3 (the version IMD's checks build with) in default and `--isolate` modes, mutated the gate to see which tests notice, and replayed the launch on a fork of mainnet through IMD's real `LaunchFactory` (source verified on Sourcify), called as its deployer.

| # | Finding | Severity | Outcome |
|---|---|---|---|
| 1 | The mark is set only where the launch pool is recorded, in the same call frame, so the record and the mark are set or reverted together; it cannot outlive the transaction; the slot is the hook's own; `tload` in a `view` callback is legal. | Clean | No change. |
| 2 | Residual: the mark names no account and is not consumed, so anything that gets control later in the opening transaction can add to the launch pool. With IMD's factory nothing does: `launch()` is callable only by the factory's deployer, and after `initialize` the factory calls only the PoolManager, the launched token and its own registry. Only IMD's own key could use it, by wrapping the launch in a batch. | Low | **Accepted and disclosed.** Consuming the mark on the first add, or binding it to the initialiser, would close it, at the price of making the launch depend on the factory seeding exactly once and from the initialising address; the reviewer recommended leaving the code as it is for this launch. `test_theOpeningTransactionIsTheGateNotTheAccountThatOpens` pins the behaviour, and `launch.json` and the launch request state it. IMD admitted launch #1205 with the same residual, rated low. |
| 3 | The real factory's one transaction passes the gate. A seed into any pool other than the launch pool would revert, so an untaxed seeded pool cannot result. The factory's fee collection (a zero-liquidity `modifyLiquidity`) is routed to the remove callbacks, which the hook does not gate. A harness that initialises and seeds in two transactions now fails, as intended. | Clean | Kept as a test: `test/fork/LaunchFactory.fork.t.sol` launches this repository's token and hook through the real factory on a fork. The launch call uses about 3.4M gas; liquidity offered in the next transaction is refused; a 1 ETH buy at the open pays 0.99 ETH of tax; `claimFees` still collects. |
| 4 | Nothing else changed: ABI, method ids, storage layout and permissions (0x18CC) are identical; the runtime gained one `TSTORE` and one `TLOAD` and lost one `NUMBER`; it has no `DELEGATECALL`, `CALLCODE`, `SELFDESTRUCT` or `CHAINID`. | Clean | No change. |
| 5 | Test gap: nothing showed that a later `initialize` on the hook cannot set the mark again. A mutant that sets it in every `afterInitialize` survived the suite. | Should fix (tests) | **Fixed.** `test_laterPoolsOnTheHookDoNotReopenTheLaunchPool` initialises a second native pool and a pool without ETH in a later transaction, then offers the launch pool liquidity and is refused. It fails against that mutant. |
| 6 | No other blocking candidate in the hook: the constructor has no chain-id or code-existence gate, the launch-pool rule cannot be front-run under this factory, the four tax modes were re-derived against v4's delta accounting, and `unlockCallback` is reachable only through the hook's own `unlock`. | Clean | No change. |
| 7 | The stated test count depended on the forge version, and one older fork test failed `forge fmt --check`. | Note | Counts are stated with their version; the file is formatted. |

After the review the suite is 222 tests on forge 1.7.1, none failing, in default and `--isolate` modes; forge 1.8.3 counts the same suite as 215, because it reports each contract's invariants as one test. Ten are mainnet-fork tests that skip themselves without `MAINNET_RPC_URL`.

The same day, IMD's public records of other hook launches were read for what admission checks: every contract under `src/` must build reproducibly and carry no `CALLCODE`, `DELEGATECALL` or `SELFDESTRUCT` (all of Pupate's are clean, the pre-deployed ones included), seven protected tests run against the creation code (flags against permissions, callbacks refusing callers other than the PoolManager, the token minting the policy's supply to its deployer), and a judge ranks the audit's findings, parking the launch on one that blocks and stays open.
