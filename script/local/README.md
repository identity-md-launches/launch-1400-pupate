# Local launch harness

A private dress rehearsal of the mainnet launch: an anvil fork of Ethereum mainnet (chain id 31337)
on which Pupate's whole stack is deployed the way the IMD launch factory deploys it, so the site's
live-data layer and real swaps through the Universal Router can be tried end to end without IMD or
testnet funds. Nothing here touches `src/` or `test/`.

## Run it

    node script/local/up.mjs           # start anvil, deploy everything, write site/public/addresses.local.json
    node script/local/smoke.mjs        # buy, flush, feed, post-window buy, sell; exits non-zero on a failed check
    node script/local/up.mjs status    # is the fork up, which block, which addresses
    node script/local/up.mjs down      # stop anvil and remove the addresses file (--keep keeps it)

Needs Foundry (`anvil`, `forge`, `cast`), Node 22+, and `MAINNET_RPC_URL` in `.env` or the environment.
The URL is read as a value only; it is never printed, and the scripts redact it from error output.
anvil's own log (which does echo its fork endpoint) goes to `%TEMP%\pupate-local\anvil.log`, outside
the repository, next to `anvil.pid`.

Optional environment: `FORK_BLOCK` pins the fork to a block, `FLOOR_WEI` sets the first report
(default 2.8 ether), `ANVIL_PORT` moves the RPC off 8545. `up` refuses to start when something already
answers on the port with chain id 31337; run `down` first. Each `up` takes about a minute.

## What `up` does

1. Starts `anvil --fork-url $MAINNET_RPC_URL --chain-id 31337` detached (pid in the temp dir) and
   waits for it. Then clears the EIP-7702 delegation that all ten of anvil's default accounts carry on
   mainnet (their keys are public, so a sweeper delegated them to `0x8a67…408a`; the fork inherits that
   code, and without this step every wei paid to account #1 by a sell, or to the developer by
   `claimDeveloper`, is forwarded away in the same transaction). `anvil_setCode(account, 0x)` makes them
   plain EOAs again.
2. Confirms with `eth_getCode` that the PoolManager, Universal Router, V4 Quoter, StateView, Permit2,
   Seaport 1.6, the identity.md collection, the IMD token and the CREATE2 factory all have code on the fork.
3. `script/DeployPreLaunch.s.sol`, unchanged, from account #0 (DEVELOPER and OPERATOR), with
   `ORACLE_ATTESTER` = account #9, the mainnet collection, PoolManager and IMD, `EVIDENCE_CHAIN_ID` 1,
   Seaport by default.
4. `script/local/LaunchLocal.s.sol`: the launch as IMD's factory performs it. `PupateToken` (the whole
   supply to the deployer, as it goes to the factory); a CREATE2 salt mined until the address carries
   exactly the hook flags `0x18CC`, predicted against the default CREATE2 factory
   `0x4e59b44847b379578588920cA78FbF26c0B4956C` that forge broadcasts through (it exists on mainnet);
   `PupateHook(poolManager, cocoon, timelock)` at that address; `LocalLaunchFactory`; 85% of supply
   transferred to it; and one call, `open`, that initialises the ETH/PUPATE pool (fee 12500, tick spacing
   60, `sqrtPriceX96 = 792281625142643375935439503360000`, 1 ETH = 100,000,000 PUPATE, a 10 ETH opening
   valuation) and seeds it in the same transaction, because `PupateHook.beforeAddLiquidity` admits
   liquidity only in the transaction that opened the pool. The seed is the single-sided position of
   `test/utils/PoolSetup.sol::_openParams`: from tick −887220 up to 184200, the tick-spacing boundary at or
   below the opening tick 184216, liquidity `tokens * 2^96 / (sqrtP(upper) − sqrtP(lower))`; it needs no
   ETH and buys walk the price down into it. The 8158 wei of rounding dust goes back to the deployer.
   Finally the 10% swarm share goes to account #8 (`SWARM_SHARE_TO`), so that the deployer is left with
   exactly the 5% that reaches the requester's wallet on mainnet.
5. `script/PostLaunch.s.sol`, unchanged: wires Cocoon, vests the deployer's 5% for 12 months, pins
   `QUESTION_HASH`, hands FloorFeed and Cocoon to the timelock. `QUESTION_HASH` is keccak256 of the exact
   bytes of `keeper/questions/floor.question.txt` (268 bytes, LF-terminated). This is a local stand-in:
   the real `questionHash` is not derivable from the text (`docs/phase0-findings.md` §4) and comes from
   the IMD API's response to the first oracle request.
6. `script/local/ReportLocal.s.sol`: signs an attestation with account #9's key exactly as
   `test/fork/CocoonSeaport.fork.t.sol::_report` does (EIP-712 over
   `OracleAttestation.domainSeparator(block.chainid, feed)`, `answerType` 3, `answer = abi.encode(floorWei)`,
   panel 5 / quorum 4 / agreed 4, `chainId` = the feed's evidence chain, issued now, valid 24 hours) and
   calls `FloorFeed.report`. `FLOOR_WEI` and `ISSUED_AT` are overridable; each report must be newer than
   the last.
7. Reads back the wiring, prints the token distribution and the gas of every transaction, and writes
   `site/public/addresses.local.json` (git-ignored):

        { "chainId": 31337, "fromBlock": <block of the pre-launch deploy>,
          "token", "hook", "cocoon", "feed", "timelock", "vesting",
          "poolManager", "universalRouter", "quoter", "permit2", "collection", "imd", "seaport",
          "poolKey": { "fee": 12500, "tickSpacing": 60 }, "attester": <account #9> }

The deployed addresses are a function of account #0's mainnet nonce at the fork head (it changes as
the sweeper bots use the account), so always read them from the file. On the 2026-10-08 runs they were
token `0xf268…8943`, hook `0xe5ab…18Cc`, Cocoon `0xc381…764d`, FloorFeed `0x5C1e…69a0`, timelock
`0x17d9…da95`, vesting `0x58D2…2547`. The site's wagmi config lists mainnet and Sepolia only; to point
it at the fork, add viem's `foundry` chain (id 31337, `http://127.0.0.1:8545`) and read this file. Pool
state can be read through StateView `0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227` (`getSlot0(poolId)`);
the pool id is logged by step 4.

## Mainnet contracts

From developers.uniswap.org/docs/protocols/v4/deployments (Ethereum row), confirmed with `eth_getCode`
on the fork and then exercised by the smoke test:

| | address | code on the fork |
|---|---|---|
| PoolManager | `0x000000000004444c5dc75cB358380D2e3dE08A90` | 24,009 bytes |
| Universal Router | `0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af` | 19,499 bytes |
| V4 Quoter | `0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203` | 5,820 bytes |
| StateView | `0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227` | 3,531 bytes |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9,152 bytes |

The same table also lists Universal Router 2.1.1 (`0x4c82…2cca`) and 2.1.2 (`0x2361…De85`); the
harness uses the primary row. Its verified source (Sourcify) has the five-field
`ExactInputSingleParams { poolKey, zeroForOne, amountIn, amountOutMinimum, hookData }`; the
`minHopPriceX36` field on v4-periphery's main branch is newer than this deployment.

## The smoke test

`smoke.mjs` drives everything with `cast` from account #1. A buy is
`execute(bytes commands, bytes[] inputs, uint256 deadline)` with command `V4_SWAP` (0x10),
`inputs[0] = abi.encode(actions, params)`, actions `SWAP_EXACT_IN_SINGLE` (0x06) + `SETTLE_ALL` (0x0c) +
`TAKE_ALL` (0x0f), `params[0] = abi.encode(ExactInputSingleParams{poolKey, zeroForOne: true, amountIn,
amountOutMinimum: 0, hookData: ""})`, `params[1] = abi.encode(ETH, amountIn)`,
`params[2] = abi.encode(PUPATE, 0)`, with `amountIn` as the call's value. A sell is the mirror with
`zeroForOne: false`, after `PUPATE.approve(Permit2)` and `Permit2.approve(PUPATE, router, amount, expiry)`.

Results of the run on 2026-10-08 (fork head 26145944, a few seconds after the open, buy tax 98.9%):

| step | result |
|---|---|
| (a) buy 0.1 ETH | `Taxed(router, buy, 0.09887 ETH, 9887 bps)`; `totalTax` +0.09887 ETH exactly; 0.00113 ETH reached the pool; buyer received 111,394.314 PUPATE; 232,925 gas. Quoter said 106,465.98 PUPATE one block earlier (the rate fell 5 bps in between). |
| (b) `flush()` | 0.09887 ETH flushed in mode ACCUMULATE (the floor is fresh, no seat held): seatPot +0.0588277 (59.5%), burnPot +0.0252119 (25.5%), developerBalance +0.009887 (10%), imdBurnBalance +0.0049435 (5%); Cocoon's balance equals the four pots to the wei. |
| (c) `feed.latest()` | `(2800000000000000000, true)` |
| (d) +6000 s | `buyTaxBps()` = 600; a 0.01 ETH buy pays 0.0006 ETH and returns 925,512.57 PUPATE, equal to the Quoter's quote to the wei (gas estimate 88,167). |
| (e) sell 518,453.442 PUPATE | pool paid 0.005137 ETH, `Taxed(sell, 0.000308 ETH, 600 bps)` = 6% of it, buyer's balance rose by exactly 0.004829 ETH minus gas. |

## Gas (anvil receipts, mainnet fork)

| transaction | gas |
|---|---|
| `PupateToken` deploy | 415,644 |
| `PupateHook` deploy through the CREATE2 factory (includes the ~12 KB init code as calldata) | 1,390,744 |
| pool `initialize` + single-sided seed, one transaction (`LocalLaunchFactory.open`) | 289,486 |
| the three together | 2,095,874 |
| `LocalLaunchFactory` deploy (local only; IMD's factory already exists) | 1,066,836 |
| pre-launch: TimelockController / FloorFeed / Cocoon | 1,596,864 / 1,228,324 / 5,460,652 |
| post-launch: `wire` / `PupateVesting` / `setQuestion` / 2 × `transferOwnership` | 106,343 / 409,114 / 53,224 / 28,702 + 28,687 |
| `FloorFeed.report` | 91,868 |

IMD's factory does the three launch steps in one transaction, plus its own bookkeeping (launch 775 also
deployed a MerkleDistributor for the swarm share), so take 2.1M as the floor and `docs/deployment.md`'s
3.5M as the allowance. Against the 0.05 ETH ceiling, 2.1M gas allows 23.9 gwei per gas and 3.5M allows
14.3 gwei.

## Where this differs from the real flow

- The hook and the token are deployed by the deployer EOA and the default CREATE2 factory, not by IMD's
  factory contract; the pool is opened and seeded by `LocalLaunchFactory`, which keeps the LP position
  (IMD's factory keeps the real one). The order, the arguments, the price, the share and the one-
  transaction open+seed are the same.
- The 10% swarm share goes to anvil account #8 instead of IMD's distributor.
- `QUESTION_HASH` is keccak256 of the question file; the attester is anvil account #9 instead of IMD's
  oracle signer; attestations carry the fork's block numbers as their evidence window.
- The deployer, developer and operator are all account #0.
- anvil's default accounts are stripped of the EIP-7702 delegation they have on mainnet (above).
- anvil's clock starts at the fork head's timestamp and advances with the wall clock; the smoke test
  moves it 6000 s with `evm_increaseTime`, so after a smoke run the launch window is over and the floor
  report ages accordingly. `down` then `up` gives a fresh launch.

## Files

- `LocalLaunchFactory.sol`: open and seed in one call (`open(PoolKey, sqrtPriceX96)`), `IUnlockCallback`.
- `LaunchLocal.s.sol`: token, mined hook, factory, 85% transfer, `open`, swarm share. Env: `POOL_MANAGER`,
  `COCOON`, `TIMELOCK`, `POOL_FEE`, `TICK_SPACING`, `SWARM_SHARE_TO`.
- `ReportLocal.s.sol`: a signed floor report. Env: `FEED`, `ATTESTER_KEY`, `FLOOR_WEI`, `ISSUED_AT`.
- `up.mjs`: `up` / `status` / `down`. `smoke.mjs`: the checks above. `common.mjs`: accounts, mainnet
  addresses, RPC and `cast` helpers (plain-text `cast call` output is parsed, not `--json`, because cast
  emits uint256 values as bare JSON numbers that JavaScript rounds past 2^53).
- Broadcast records land in `broadcast/<Script>.s.sol/31337/` (git-ignored). With `--unlocked` the node
  signs, so forge's recorded transaction hashes do not line up with its stored receipts; `up` takes each
  receipt from the node and keys it by nonce.
