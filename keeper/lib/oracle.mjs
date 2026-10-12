// Floor reports: when one is due, and where the attestation comes from.
//   local  signs one with LOCAL_ATTESTER_KEY the way script/local/ReportLocal.s.sol does (fork only)
//   imd    the paid IMD flow (0.5 IMD): check (short form), quote (full body), pay, wait for
//          admission, then follow the oracle request to its attestation. The mapping of the API's
//          JSON to the struct follows the real attestation in test/OracleAttestation.t.sol.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeAbiParameters, hexToBigInt, keccak256, pad, recoverTypedDataAddress, toHex, zeroHash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { KEEPER_ROOT } from './config.mjs';
import { ImdError, createImd, newRequestToken } from './imd.mjs';
import { fmtDuration, log } from './log.mjs';

export const ANSWER_TYPE_UINT256 = 3;

export const ATTESTATION_TYPES = {
  OracleAttestation: [
    { name: 'requestId', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'questionHash', type: 'bytes32' },
    { name: 'answerType', type: 'uint8' },
    { name: 'answer', type: 'bytes' },
    { name: 'figure', type: 'uint256' },
    { name: 'fromBlock', type: 'uint64' },
    { name: 'toBlock', type: 'uint64' },
    { name: 'blockHash', type: 'bytes32' },
    { name: 'panelJobId', type: 'bytes32' },
    { name: 'panelSize', type: 'uint16' },
    { name: 'quorum', type: 'uint16' },
    { name: 'agreed', type: 'uint16' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
};

export const domainFor = (chainId, feed) => ({ name: 'IdentityMD Oracle', version: '2', chainId, verifyingContract: feed });

// ------------------------------------------------------------------ when

/**
 * A report is due when none is stored, when the stored one is stale or goes stale within `leadSec`,
 * or when it is older than `everySec`. Times are chain time (block.timestamp), as FloorFeed sees it.
 */
export function reportDue({ issuedAt, expiresAt, maxAge, now, everySec, leadSec, force }) {
  if (force) return { due: true, reason: 'forced' };
  if (issuedAt === 0n) return { due: true, reason: 'no report stored' };
  const byAge = issuedAt + maxAge;
  const freshUntil = byAge < expiresAt ? byAge : expiresAt;
  if (now > freshUntil) return { due: true, reason: `stale for ${fmtDuration(now - freshUntil)}` };
  if (now + BigInt(leadSec) >= freshUntil) return { due: true, reason: `stale in ${fmtDuration(freshUntil - now)}` };
  if (now >= issuedAt + BigInt(everySec)) return { due: true, reason: `older than REPORT_EVERY (${fmtDuration(now - issuedAt)})` };
  return { due: false, reason: `fresh for ${fmtDuration(freshUntil - now)}` };
}

// ------------------------------------------------------------------ verification

/** Recover the signer the way FloorFeed does (domain = the feed on this chain). */
export async function verifyAttestation({ chainId, feed, attestation, signature, attester }) {
  let signer = null;
  try {
    signer = await recoverTypedDataAddress({
      domain: domainFor(chainId, feed),
      types: ATTESTATION_TYPES,
      primaryType: 'OracleAttestation',
      message: attestation,
      signature,
    });
  } catch {
    signer = null;
  }
  return { ok: signer !== null && attester && signer.toLowerCase() === attester.toLowerCase(), signer };
}

export const attestedFloor = (attestation) => hexToBigInt(attestation.answer);

// ------------------------------------------------------------------ local (fork only)

/**
 * The attestation ReportLocal signs: uint256 answer, panel 5/4/4, the feed's evidence chain, issued
 * at the chain's clock (and newer than the stored report), valid 24 hours.
 */
export async function localAttestation({ pub, chainId, feed, attesterKey, floorWei, prevIssuedAt, questionHash, evidenceChainId }) {
  const account = privateKeyToAccount(attesterKey);
  const block = await pub.getBlock({ blockTag: 'latest' });
  let issuedAt = block.timestamp;
  if (issuedAt <= prevIssuedAt) issuedAt = prevIssuedAt + 1n;
  const tag = (s) => keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'uint64' }], [s, issuedAt]));
  const attestation = {
    requestId: tag('pupate-local'),
    chainId: BigInt(evidenceChainId),
    questionHash,
    answerType: ANSWER_TYPE_UINT256,
    answer: pad(toHex(BigInt(floorWei)), { size: 32 }),
    figure: 0n,
    fromBlock: block.number > 7200n ? block.number - 7200n : 0n,
    toBlock: block.number,
    blockHash: block.hash,
    panelJobId: tag('pupate-local-panel'),
    panelSize: 5,
    quorum: 4,
    agreed: 4,
    issuedAt,
    expiresAt: issuedAt + 86_400n,
  };
  const signature = await account.signTypedData({
    domain: domainFor(chainId, feed),
    types: ATTESTATION_TYPES,
    primaryType: 'OracleAttestation',
    message: attestation,
  });
  return { attestation, signature, signer: account.address };
}

// ------------------------------------------------------------------ the IMD API's JSON -> struct

/** bytes32 from a 0x-hex of up to 32 bytes or a UUID; short values are right-padded (the real requestId is a UUID padded that way). */
function bytes32(v) {
  if (v === undefined || v === null || v === '') return zeroHash;
  let s = String(v).trim();
  if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
  s = s.replace(/-/g, '');
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length > 64) throw new Error(`not a bytes32: ${v}`);
  return `0x${s.toLowerCase().padEnd(64, '0')}`;
}

function answerBytes(v) {
  if (typeof v === 'string' && /^0x/i.test(v)) {
    const body = v.slice(2);
    return `0x${body.toLowerCase().padStart(64, '0')}`;
  }
  return pad(toHex(BigInt(v)), { size: 32 });
}

/** The fields FloorFeed needs, typed for viem, from whatever envelope the API uses. */
export function mapApiAttestation(json) {
  const m = json.attestation ?? json.message ?? json.typedData?.message ?? json;
  const signature = json.signature ?? json.sig ?? m.signature ?? json.attestation?.signature;
  if (!signature) throw new Error('the attestation response carries no signature');
  const at = m.answerType;
  const answerType = typeof at === 'number' ? at : String(at) === 'uint256' ? ANSWER_TYPE_UINT256 : Number(at);
  return {
    attestation: {
      requestId: bytes32(m.requestId),
      chainId: BigInt(m.chainId),
      questionHash: bytes32(m.questionHash),
      answerType,
      answer: answerBytes(m.answer),
      figure: BigInt(m.figure ?? 0),
      fromBlock: BigInt(m.fromBlock ?? 0),
      toBlock: BigInt(m.toBlock ?? 0),
      blockHash: bytes32(m.blockHash),
      panelJobId: bytes32(m.panelJobId),
      panelSize: Number(m.panelSize),
      quorum: Number(m.quorum),
      agreed: Number(m.agreed),
      issuedAt: BigInt(m.issuedAt),
      expiresAt: BigInt(m.expiresAt),
    },
    signature,
    domain: json.domain ?? json.typedData?.domain ?? null,
    signer: json.signer ?? null,
  };
}

// ------------------------------------------------------------------ the paid IMD flow

/** The floor question FloorFeed is pinned to; the wording must never change (the hash is the pin). */
export function floorQuestion() {
  return readFileSync(join(KEEPER_ROOT, 'questions', 'floor.question.txt'), 'utf8').trim();
}

/**
 * How the floor question is put to the panel. It is answered from public marketplaces, not from a
 * chain recipe: IMD's chain evidence can count and sum logs and read v4 pool prices, and none of those
 * yields the price of a seat. So twenty seats each read the collection's floor on OpenSea, eleven must
 * agree within 2%, and the oracle signs that answer. FloorFeed asks for a quorum of at least four that
 * is also a majority of the panel, which eleven of twenty is.
 */
export const FLOOR_PANEL = { size: 20, quorum: 11, toleranceBps: 200 };

/** The short form IMD's free check takes for an oracle question; it refuses the full body. */
export function floorCheckInput(evidenceChainId = 1) {
  return {
    question: floorQuestion(),
    panelSize: FLOOR_PANEL.size,
    answerType: 'uint256',
    evidence: 'panel',
    chainId: Number(evidenceChainId),
    toleranceBps: FLOOR_PANEL.toleranceBps,
  };
}

/**
 * The full body that is quoted and paid for, with this feed as the consumer. Keep it byte for byte
 * the same between requests: the oracle's questionHash, which FloorFeed pins, is derived from it.
 */
export function floorQuoteInput(feed, consumerChainId, evidenceChainId = 1) {
  return {
    v: 1,
    question: floorQuestion(),
    chainId: Number(evidenceChainId),
    window: { hours: 24 },
    answerType: 'uint256',
    evidence: 'panel',
    panelSize: FLOOR_PANEL.size,
    quorum: FLOOR_PANEL.quorum,
    toleranceBps: FLOOR_PANEL.toleranceBps,
    validForSeconds: 86400,
    definitions: {
      'floor price':
        'The lowest price at which one token of the collection can be bought now through an active fixed-price listing, as OpenSea reports it for the collection: its collection floor price. Offers, bids, last sales, and expired or cancelled listings do not count.',
      wei: 'The ETH figure OpenSea reports, unrounded, times 10^18. Example: 1.90927932 ETH is 1909279320000000000. Do not convert from a USD figure and do not use a rounded display value.',
      missing:
        'If OpenSea reports no floor price for the collection or cannot be reached, report unavailable. Never substitute a figure from another marketplace, a last sale or an offer.',
    },
    // Sanity bounds on the answer, in wei: 0.05 ETH to 1,000 ETH.
    guards: { min: '50000000000000000', max: '1000000000000000000000' },
    // IMD takes addresses in lowercase only (a checksummed one is refused at the quote).
    consumer: { chainId: Number(consumerChainId), verifyingContract: String(feed).toLowerCase() },
  };
}

/** IMD_PAID_TOKEN, or keeper/.imd/token (created once): it is what reads the orders later. */
function requestToken(cfg) {
  if (cfg.imdPaidToken) return cfg.imdPaidToken;
  const dir = join(KEEPER_ROOT, '.imd');
  const file = join(dir, 'token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dir, { recursive: true });
  const token = newRequestToken();
  writeFileSync(file, token + '\n', { mode: 0o600 });
  log(`new IMD request token written to ${file}; keep it, it is what reads your orders later`);
  return token;
}

/**
 * The oracle request id of an admitted order. The admission's result is
 * `{kind: "oracle", requestId, jobId, statusUrl, attestationUrl}`; `GET /requests/paid-by/:address`
 * carries the same object as `result`. Never the order's own `requestKey`, which is also a UUID.
 */
export function findRequestId(o) {
  const r = o?.admission?.result ?? o?.result;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.requestId === 'string' && r.requestId) return r.requestId;
  for (const url of [r.statusUrl, r.attestationUrl]) {
    const m = /\/oracle\/requests\/([0-9a-f-]{36})/i.exec(String(url ?? ''));
    if (m) return m[1];
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Request, pay for and fetch one attestation for `feed`. Spends 0.5 IMD from the keeper's wallet
 * through Permit2, so it runs only when ATTESTATION_SOURCE=imd was set explicitly; with no key or
 * in dry-run it stops after the free check. A paid order survives a crash in `cache.pendingReport`
 * and is resumed instead of paid again.
 */
export async function imdAttestation({ cfg, account, cache, persist, feed, consumerChainId, evidenceChainId, dryRun }) {
  // The keeper's own account signs both the Permit2 payment and the quote approval; IMD is always
  // paid on the chain the quote names, whatever chain the keeper works on.
  const signer = account && !dryRun ? account : null;
  const imd = createImd({ api: cfg.imdApi, token: requestToken(cfg), signer });
  const input = floorQuoteInput(feed, consumerChainId, evidenceChainId);

  let pending = cache.pendingReport;
  if (pending && Date.now() - pending.startedAt > 4 * cfg.attestationTimeoutSec * 1000) {
    log(`abandoning the pending IMD order ${pending.orderId} (started ${new Date(pending.startedAt).toISOString()})`);
    pending = cache.pendingReport = null;
    persist();
  }

  if (!pending) {
    const check = await imd.check('oracle.request', floorCheckInput(evidenceChainId));
    if (check.blockers?.length) throw new Error(`IMD check has blockers: ${JSON.stringify(check.blockers).slice(0, 400)}`);
    if (!signer) {
      log(`dry run: IMD check passed (${check.quote?.amount ?? check.price ?? '0.5 IMD'}); would quote and pay for a floor report to ${feed}`);
      return null;
    }
    const { order } = await imd.quote('oracle.request', input);
    log(`IMD quoted order ${order.id}: ${order.quote?.amount} atomic IMD, expires ${order.quote?.expiresAt}`);
    pending = cache.pendingReport = { orderId: order.id, requestId: null, startedAt: Date.now() };
    persist();
    await imd.pay(order.id);
    log(`IMD order ${order.id} paid; waiting for admission`);
    const admitted = await imd.waitAdmitted(order.id, { timeoutMs: cfg.attestationTimeoutSec * 1000 });
    pending.requestId = findRequestId(admitted);
    persist();
  } else {
    log(`resuming the pending IMD order ${pending.orderId}${pending.requestId ? ` (oracle request ${pending.requestId})` : ''}`);
  }

  if (!pending.requestId) {
    const status = await imd.status(pending.orderId);
    pending.requestId = findRequestId(status);
    persist();
    if (!pending.requestId) {
      throw new Error(`cannot find the oracle request id in order ${pending.orderId} (status ${status.status}; keys ${Object.keys(status).join(',')})`);
    }
  }

  const until = Date.now() + cfg.attestationTimeoutSec * 1000;
  for (;;) {
    try {
      const json = await imd.oracleAttestation(pending.requestId);
      if (json && (json.signature || json.sig || json.attestation?.signature)) {
        // Remembered for the status feed: the site's oracle panel loads this request and verifies it.
        cache.lastOracleRequest = { requestId: pending.requestId, at: new Date().toISOString() };
        cache.pendingReport = null;
        persist();
        return mapApiAttestation(json);
      }
    } catch (e) {
      if (!(e instanceof ImdError) || ![202, 404, 409, 423, 425].includes(e.status)) throw e;
    }
    try {
      const req = await imd.oracleRequest(pending.requestId);
      // IMD's statuses: assessing, reproducing, attested, and the ends without an answer below.
      if (/^(disagreed|blocked|mismatch|refused|failed)$/i.test(String(req?.status))) {
        cache.pendingReport = null;
        persist();
        const why = req.failure ? `: ${typeof req.failure === 'string' ? req.failure : JSON.stringify(req.failure)}` : '';
        throw new Error(`oracle request ${pending.requestId} ended as ${req.status}${why}; the 0.5 IMD bought the panel, not an answer`);
      }
    } catch (e) {
      if (!(e instanceof ImdError)) throw e;
    }
    if (Date.now() > until) {
      throw new Error(`no attestation for oracle request ${pending.requestId} after ${cfg.attestationTimeoutSec}s; it stays pending and is retried next time`);
    }
    await sleep(15_000);
  }
}
