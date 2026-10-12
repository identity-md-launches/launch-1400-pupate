# Phase 0 desk findings

Date: 2026-10-06. Everything here came from free, read-only calls. Nothing was paid or deployed.

Status key: `ANSWERED` (evidence in hand), `PARTIAL` (strong indication, not proven), `OPEN` (needs a paid or on-chain test).

## 1. Does IMD admit a hook that takes a 6% tax? `PARTIAL`

- Launch 168 (`identity-md-launches/launch-168-release-tollgate-symbol-toll`) is a `univ4_hook` launch whose hook charges 2% in native ETH on every buy and sell (`BUY_FEE_BPS = 200`, `SELL_FEE_BPS = 200` in `src/TollgateHook.sol`).
- Launch 551 describes a hook that charges 4% on swaps, settled in ETH, sent to a fixed address.
- `POST https://api.imd.fun/requests/check` with a `launch.open` body describing a 6% ETH fee returned no blocker about the fee. Its only blockers were `bad_path_count` on the request shape ("expected between 1 and 16 allowed paths"), which is about how the body lists writable paths, not about the design.
- The latest mainnet `univ4_hook` policy (version 19) has no field that limits a hook's own fee.

Not proven until a launch is actually admitted and reviewed. Review by the swarm can still park a launch.

## 2. The deployer fee `OPEN`, and the spec's number is wrong

- The check states: "Pool fee: 0.3% to liquidity providers (0.05% or 1% if you ask). It cannot be zero." Policy fee tiers are `[500, 3000, 10000]`.
- The spec says 1.25% with 1% to the paying wallet. That figure came from a summary of the docs and is not what the check or the policy say.
- Policy `owners.lpPosition` is `0xcecc29b037f5064fcdf45a5c318f132ef76aa551` (the IMD launch wallet). So the LP position, and with it the pool fee, is held by IMD. Whether any of it is passed on to the requester is not stated anywhere I could read.

Treat the deployer fee as zero until shown otherwise.

## 3. Can a contract-owned seat be paired? `PARTIAL`

- Launch 246 (`WorkerWallet.sol`) is an ERC-1271 wallet that holds a seat and lets a rotating worker key sign for it on allowed EIP-712 domains. Launch 440 (SEATLEASE) states the network "accepts ERC-1271 from contract owners".
- The IMD6900 README says ERC-1271 support for pairing "requires IMD confirmation before reliance".
- IMD6900's `src/strategies/IMDSeatStrategy.sol` implements the pattern in production code: the operator approves a digest on-chain with `authorizeWorker`, and `isValidSignature` returns valid only for approved digests of seats still held. Its type string is `WorkerAuthorization(bytes32 deviceKey,address wallet,uint256 tokenId,bytes32 nonce,uint64 expiresAt,string relayOrigin)`.
- No live pairing by a contract owner was verified. None of the 25 largest holders is a contract, and the IMD6900 strategy address could not be matched to a seat owner.

Needs one real pairing attempt on a seat held by a contract.

## 4. Oracle attestations `ANSWERED` for verification, `PARTIAL` for the floor question

Verified:

- Our EIP-712 encoding recovers the live oracle signer `0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982` from a real attestation (`test/OracleAttestation.t.sol`).
- Domain: name `IdentityMD Oracle`, version `2`, `chainId`, `verifyingContract` = the consumer named in the request. An attestation is bound to one consuming contract.
- The `uint256` answer type is signed as `uint8` value `3`.
- `questionHash` is the same for two separate requests asking the same question, so it can be pinned at deployment. It is not `keccak256` or `sha256` of the question text alone; take it from the API response of the first request.
- A request carries `panelSize` (5 to 100), `quorum`, `toleranceBps`, `validForSeconds` (21600 in the example), `guards.sources`, and `consumer {chainId, verifyingContract}`.
- Each request costs 0.5 IMD. Six-hourly reports cost 2 IMD a day.

Floor question:

- Lowest asks are not on-chain (Seaport orders are signed off-chain) and OpenSea's API needs a key, so the question has to be built from on-chain sales.
- Almost every attested request so far is an on-chain read over a block window: Uniswap v4 spot prices as a median over evenly spaced blocks, or event counts for a pool. The panel is practised at this kind of question.
- A draft question, the median total price of Seaport 1.6 `OrderFulfilled` sales of the collection for ETH or WETH over the window, passed `POST /requests/check` with no blockers. The check normalised it to `evidence: "chain"`, a 24-hour window, panel 5, quorum 4, and suggested tighter wording.
- The check does not return `questionHash`, and the hash is not derivable from the question text, so FloorFeed cannot take it as a constructor argument. It is set after the first request.

Open:

- Whether a panel agrees within tolerance on the floor question in practice. Needs one paid request.
- Whether the attestation's `chainId` is the evidence chain, as its place beside the block window suggests, or the consumer's chain. FloorFeed takes the evidence chain as a constructor argument; a Sepolia FloorFeed reading mainnet sales in the rehearsal settles it.
- Whether a requester can vary panel size, quorum or validity under the same `questionHash`. FloorFeed enforces minimums on-chain either way (quorum at least 4 and a majority, validity at least the freshness window).

## 5. Token split and token rules `ANSWERED`

From the check:

- "Split: 10% to the swarm, the other 90% is yours: 80% into the pool unless you choose otherwise, the rest to your wallet."
- "Supply: 1,000,000,000 with 18 decimals, minted once."
- "Transfers: plain, with no fees, limits, pausing or minting."
- "Pool: paired with ETH, opening at a 20 ETH market cap" (Sepolia). Mainnet policy: 10 ETH default, 100 ETH maximum.

So 85% to the pool and 5% to the requester wallet is expressible. The 5% arrives in the wallet unvested; vesting is ours to add by sending it to a vesting contract.

## 6. Collection `ANSWERED`, Seaport path `OPEN`

- `0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D` on Ethereum mainnet: `name()` = `identity.md`, `symbol()` = `IDMD`, `totalSupply()` = `2000`.
- Buying and listing through Seaport 1.6 is untested; it needs a mainnet-fork test in Plan 3.

## Launch format (new information)

- A launch is described by `launch.json` at the repository root: `kind`, `hook {contract, constructorArgs, permissions}`, `token {contract, name, symbol, decimals}`, `pool {pairedCurrency, fee, tickSpacing, initialPrice}`, `notes`.
- The token contract has a zero-argument constructor and mints the whole supply to `msg.sender` (the factory).
- In launch 168 the hook's only constructor argument is the PoolManager address. Hook permissions live in the low 14 bits of its address, so it is deployed by CREATE2 with a mined salt.
- Launch 697 (`evm_project`) lists extra contracts in a `contracts` array with `$owner`, `$token` and `$contract:Name` placeholders. Whether a `univ4_hook` manifest accepts the same array is not known.
- The tax pattern in launch 168: take the fee inside the swap as ERC-6909 claims (`poolManager.mint(hook, 0, fee)`), settle to ETH later with `poolManager.take`. No external call during a swap.
- Reference toolchain: solc 0.8.26, `cancun`, optimizer 200 runs, `via_ir = false`, `bytecode_hash = "none"`, `cbor_metadata = false`, dependencies vendored. Ours matches.

## The hook tax can be avoided in other pools `ANSWERED`

- The check fixes the token for a `univ4_hook` launch: "Transfers: plain, with no fees, limits, pausing or minting."
- A hook only sees swaps in pools that use it. Anyone can open another pool for a plain token and trade there untaxed.
- IMD6900 closes this hole in its token: `src/strategies/BaseStrategy.sol` reverts `InvalidTransfer` unless a transient transfer allowance has been set for the swap. That is only possible because IMD6900 was deployed outside the IMD launchpad.
- Under IMD's rules there is no technical fix. It is recorded as a known risk in the spec.

## A mainnet launch that pays for a seat (launch 775)

`identity-md-launches/launch-775-ransom-for-seat-1376` is a live mainnet `univ4_hook` launch and the closest precedent to Pupate's hook.

- Manifest: `"constructorArgs": ["$poolManager"]`, permissions `afterInitialize`, `beforeSwap`, `afterSwap`, `beforeSwapReturnDelta`, `afterSwapReturnDelta` (address flags `0x10CC`).
- "The first native ETH pool initialized with the hook becomes `launchPool`; other pools initialize and trade without hook fees." Its notes ask the factory to deploy and initialise atomically for that reason.
- 2% hook fee in native ETH beside the 0.3% LP fee, collected as ERC-6909 claims; swap callbacks only mint claims.
- Before-swap fee modes reject partial fills.
- It buys IMD through two fixed Uniswap v4 routes: POOL4 (1% LP fee, tick spacing 60, the POOL4 hook) and a plain ETH/IMD pool (1% LP fee, tick spacing 200, no hook), with its own price guards.
- Its deployment transaction `0x9eeabe6776c0747c37a4d3646083abd04d21a023fdfdbe325d33c52aa5011ad2` (block 26130900, from the launch wallet `0xcecc…a551` to the factory `0x12c63b581d07093f6126bc02263c58f7eadaa96f`) deploys the hook, the token and a `MerkleDistributor`, and the PoolManager emits `Initialize` and `ModifyLiquidity` for the pool in that same transaction with the factory as sender. So the factory deploys, opens and seeds the pool atomically, as the launch's notes asked.

## Reference code carries no licence

None of the `identity-md-launches` repositories read here declares a licence. They were read to learn the launch format and the PoolManager conventions; no code was copied. Pupate's contracts are written from scratch against v4-core.

## Changes the spec needs

Applied in spec revision 2.

1. **Pool fee.** Replace "1.25% under current IMD policy" with the 0.3% LP fee (0.05% or 1% on request).
2. **Developer income.** The 1% deployer fee is unconfirmed and may not exist. If the developer is to earn from trading, it has to be a stated share of the hook tax. This is a decision for the project owner.
3. **Launch wallet cap.** The token must be a plain ERC-20, so the "1% per wallet in the first 10 minutes" rule has to live in the hook as a per-swap buy cap, not in the token.
4. **Wiring.** The hook probably cannot take Cocoon's address as a constructor argument. Plan for a one-time `wire` call, as launch 697 does, or confirm that the manifest accepts `$contract:` placeholders for hooks.
5. **Oracle cost.** Add the running cost of reports (0.5 IMD each) and say who pays it. A permissionless keeper will not pay it for free, so the caller reward or the vault has to cover it.
6. **Floor source.** The floor question needs a keyless, reproducible source; the spec currently assumes one exists.

## 2026-10-08 correction: hook pool fee tier

IMD policy v34 (`univ4_hook`, chain 1, created 2026-10-07) sets `feeTiers: [12500]`. The `[500, 3000, 10000]` allowlist quoted above is now the `evm_project` policy (v33), not the hook policy. Pupate's manifest uses 12500. The free `launch.open` check (`keeper/questions/launch.check.json`) passes with the required steps `audit-imported-code → adapt-contract-project → adversarial-review` and returns IMD's ten-step plan without blockers; policy judgement happens at paid admission.

## 2026-10-12 corrections, from the checks before the mainnet launch

- **§4, the floor question.** The draft question (the median of Seaport sales over the window, as chain evidence) passes the wording check but cannot be answered. With `evidence: "chain"` each member answers with a recipe that IMD reruns, and the recipes are a fixed set: `log-sum`, `log-count`, `log-rank`, `call-compare`, `v4-volume-rank`, `univ4-spot`. None can filter Seaport's `OrderFulfilled` by the collection inside its offer array or sum a consideration array. A panel question for the collection's lowest listing on OpenSea was attested twice for another requester (request `62702d2a-1a38-4543-93cc-7ece5ac20a66`: 20 seats, quorum 14, 1% tolerance, attested in about three minutes). Pupate's question is that one with OpenSea as the single source. For reference, the collection had 6 to 43 Seaport sales a day in the week before, 16 in the last 24 hours with a median of 2.35 ETH.
- **§4, the two request bodies.** `POST /requests/check` takes an oracle question in a short form (`question`, `panelSize`, optionally `answerType`, `evidence`, `chainId`, `toleranceBps`, `head`) and refuses the full body with `Unrecognized keys`; `POST /requests/quote` takes the full body with `v: 1`, and wants `consumer.verifyingContract` in lowercase.
- **§2, the deployer fee.** IMD's documentation now states it: the pool fee is 1.25% of every trade, 1% to the paying wallet and 0.25% to the network, and anyone can call the distribution. Treat it as IMD's policy, which can change.
- **§5, the split.** Confirmed on real launches: 10% to a MerkleDistributor, `poolBps` to the pool, and the rest to the requester's wallet in the launch transaction itself (`remainderTo` can name another address).
- **A launch from one's own repository.** With the steps `audit-imported-code → adapt-contract-project → adversarial-review` the swarm audits, an adapt node with a write budget over the repository fixes what the audit found, another agent adds tests, four specialists audit and a judge ranks. With `audit-imported-code → adversarial-review` alone there is no adapt node and no test node: only the manifest node writes, and only `launch.json`. That is the shape for launching exact code, and launch #1205 was admitted in it. Either way a blocking finding that stays unresolved parks the launch. Of the 19 hook launches from #1100 to #1341, 17 went live and 2 were parked, both of them attempts of the project that #1205 then launched. The launch record names its jobs, its requester and its seven admission checks (`provenance`, `findings`, `independent_review`, `bytecode`, `manifest`, `protected_invariants`, `economics`), and a job names its launch, which is how a paid launch is followed to its contracts. IMD builds with forge 1.8.3, which clears transient storage between the top-level calls of a test, so a fixture must open and seed a pool in one call.
