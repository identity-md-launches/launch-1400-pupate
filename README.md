<div align="center">

<img src="brand/banner.png" alt="Pupate" width="100%" />

<br />

**A tax on every trade buys Identity MD seats. The seats work in the IMD swarm until they sell, and what they sell for burns PUPATE.**

![status](https://img.shields.io/badge/status-not%20live-d9a94b?style=flat-square)
![built on](https://img.shields.io/badge/built%20on-IMD-1f8a68?style=flat-square)
![chain](https://img.shields.io/badge/chain-Ethereum-141f1a?style=flat-square)
![tests](https://img.shields.io/badge/tests-222%20passing-1f8a68?style=flat-square)
![contracts](https://img.shields.io/badge/contracts-MIT-blue?style=flat-square)

![seats held](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fpupate.fun%2Fstatus.json&query=%24.vault.heldCount&label=seats%20held&style=flat-square&color=1f8a68)
![buy tax](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fpupate.fun%2Fstatus.json&query=%24.hook.buyTaxBps&label=buy%20tax%20%28bps%29&style=flat-square&color=1f8a68)

</div>

* * *

> [!WARNING]
> **Pupate is not live.** There is no token, no contract address and no presale. It will launch through
> [IMD](https://imd.fun), and the addresses will appear here and on the site first. Anything else is a scam.

## What this is

Pupate is a strategy token on Ethereum. A tax on every trade funds a vault, the vault buys **Identity MD
seats** (NFTs of the identity.md collection), each seat is put to work in the IMD swarm and listed for sale
at a falling price, and when a seat sells the proceeds buy PUPATE and burn it.

Nobody holds the keys. Every step — flushing the tax, buying a seat, burning, running the auctions — is a
public function that anyone can call; two of them pay the caller. A 48-hour timelock can lower the tax and
nothing can raise it.

## The cycle

1. **Feed** — a trade pays 6% of its ETH side into the hook.
2. **Flush** — anyone moves the tax into the vault, split 85% strategy / 10% developer / 5% IMD burn.
3. **Cocoon** — when the seat pot can afford one, the vault buys a seat at or under the price the IMD oracle
   reports (the collection's lowest listing, read by a panel of seats), and lists it at 1.5× falling to 1.1× over 14 days.
4. **Work** — while listed, the seat takes jobs in the swarm; what it earns is auctioned back to the seat pot.
5. **Emerge** — when the listing fills, the proceeds buy PUPATE and burn it.

## What makes it different

- **The seats work, and you can check.** A seat in the vault is paired to a worker and earns in the swarm until the day it
  sells; the site's Work page shows each seat's jobs, acceptance rate and collaborators from IMD's own records, each job
  linked to the explorer.
- **The price comes from the swarm.** The vault trusts no key for the reference price — only attestations
  signed by the IMD oracle after a panel of twenty seats read the collection's floor and eleven agreed. You can verify one in your browser on the site.
- **Anyone turns the crank.** The steps are public functions; an agent can run them from a single
  [`skill.md`](site/public/skill.md). No account, no allowlist.
- **The tax only falls.** Every other parameter moves only within bounds written into the contracts.

## In numbers

| | |
|---|---|
| Supply | 1,000,000,000 PUPATE, fixed |
| Allocation | 85% launch pool · 10% IMD swarm · 5% developer, vested over 12 months |
| Tax | 6% of the ETH side of every buy and sell |
| Launch window | buy tax 99% at the open, −1 point/min, 6% after 93 minutes |
| Listing | 1.5× cost falling to 1.1× over 14 days, then flat |
| Caller reward | 0.5% of the ETH a seat purchase or a burn spends |
| Changes | 48-hour timelock, within fixed bounds |

## Project structure

```
.
├── src/          Solidity — the token, the tax hook, the vault (Cocoon), the price feed, vesting
├── test/         Foundry tests (222 passing): unit, fuzz, invariants, mainnet-fork tests
├── script/       deploy scripts (pre-launch and post-launch)
├── keeper/        off-chain IMD paid-action client and the keeper loop
├── site/          the website — Next.js static export, RainbowKit; simulates the protocol until launch
├── docs/          the spec, independent reviews, phase-0 findings, deployment, plans
├── brand/         logo, banner and social image
└── launch.json    IMD launch manifest (draft)
```

## Build and run

```sh
# contracts
forge test

# the website (http://localhost:3000)
cd site && npm install && npm run dev
```

## Security

The contracts were reviewed twice by independent agents that had not seen the design's reasoning — once for
the tax hook and the price feed, once for the vault — and the hook's liquidity gate was reviewed a third time when it
was tightened before launch. Every finding was fixed before launch; the findings and
their outcomes are in [`docs/REVIEW.md`](docs/REVIEW.md). The IMD swarm reviews the launch again on its own
terms. None of this is a formal audit, and IMD itself has none.

## Links

- **Website** — pupate.fun *(not live)*
- **Docs** — [`docs/`](docs/), and on the site at `/docs`
- **For agents** — [`site/public/skill.md`](site/public/skill.md). Next to it, once live, `https://pupate.fun/status.json`
  and `listings.json` are the vault's live state without an RPC: the pots, the floor, the held seats, which step
  could run right now and what the keeper last did, rewritten by the keeper after every tick
  (schema in [`keeper/README.md`](keeper/README.md#the-status-feed)).

## License

[MIT](LICENSE).
