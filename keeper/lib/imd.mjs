// The IMD paid-action client: free checks, quotes, the two-signature payment, and polling.
// Follows https://imd.fun/docs/#paid, whose reference flow this mirrors step for step. Network: the IMD
// control plane only; the server pays the gas of the payment itself. The paying wallet needs IMD and a
// one-time allowance from IMD to Permit2.
import { randomBytes, randomUUID } from 'node:crypto';
import { x402Client } from '@x402/core/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { sha256, stringToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const IMD_TOKEN = '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7';
/** What one paid action costs today, in atomic IMD. `pay` refuses a quote that asks for more. */
export const ACTION_PRICE = 500_000_000_000_000_000n;

/** Canonical JSON: sorted keys, no whitespace, integers only, no undefined. */
export function canon(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export class ImdError extends Error {
  constructor(status, body) {
    super(`IMD ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * The signer a payment needs: the wallet's own key as a viem account (`address` and `signTypedData`).
 * A wallet client will not do: the x402 client reads `signer.address`, which a wallet client lacks.
 */
export function paymentSigner(privateKey) {
  return privateKeyToAccount(privateKey);
}

const QUOTE_APPROVAL_TYPES = {
  QuoteApproval: [
    { name: 'resource', type: 'string' },
    { name: 'requesterScopeHash', type: 'bytes32' },
    { name: 'quoteId', type: 'string' },
    { name: 'quoteHash', type: 'bytes32' },
    { name: 'paymentHash', type: 'bytes32' },
    { name: 'action', type: 'string' },
    { name: 'asset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'payTo', type: 'address' },
    { name: 'expiresAt', type: 'uint256' },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {string} [o.api] control plane, default https://api.imd.fun
 * @param {string} [o.token] the request token (random 32-byte hex); it reads your orders later
 * @param {{address: string, signTypedData: Function}} [o.signer] the paying wallet's own key, as `paymentSigner` returns it
 */
export function createImd({ api = 'https://api.imd.fun', token, signer } = {}) {
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  /** This machine's clock minus the plane's, in seconds, from the Date header of its last answer. */
  let clockAheadSec = 0;

  /** One request. A body-less POST carries no Content-Type: the plane reads one as an empty JSON body and refuses it. */
  async function call(method, path, { body, headers } = {}) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...auth, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const served = Date.parse(res.headers.get('date') ?? '');
    if (Number.isFinite(served)) clockAheadSec = (Date.now() - served) / 1000;
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  async function expect(method, path, opts, ok = [200, 201, 202]) {
    const { status, json } = await call(method, path, opts);
    if (!ok.includes(status)) throw new ImdError(status, json);
    return json;
  }

  /** A read, patient with `busy`: the plane sheds record reads under load and asks to be tried again. */
  async function read(path, { tries = 40 } = {}) {
    for (let i = 0; ; i++) {
      const { status, json } = await call('GET', path);
      const busy = status === 429 || status === 503 || json?.error === 'busy';
      if (!busy) {
        if (status !== 200) throw new ImdError(status, json);
        return json;
      }
      if (i + 1 >= tries) throw new ImdError(status, json);
      await sleep(Math.min(2000 * (i + 1), 15_000));
    }
  }

  /** Step 1 of a payment: the 402 challenge of a quoted order. Free; nothing is signed or sent. */
  async function challenge(orderId) {
    const { status, json } = await call('POST', `/requests/${orderId}/submit`);
    if (status !== 402) throw new ImdError(status, json);
    return json;
  }

  /**
   * Steps 2 and 3: the Permit2 payment as a stock x402 client makes it (without extensions), and the
   * EIP-712 approval of that exact payment for this quote. Signs, sends nothing. Refuses a challenge
   * that asks for more than `maxAmount` or for another asset.
   */
  async function sign(ch, { maxAmount = ACTION_PRICE } = {}) {
    if (!signer) throw new Error('a signer is needed to pay');
    const req = ch.accepts[0];
    const q = ch.quote;
    if (BigInt(req.amount) > maxAmount || BigInt(q.payment.amount) > maxAmount) {
      throw new Error(`the quote asks for ${req.amount} atomic IMD, more than the ${maxAmount} this call allows`);
    }
    if (String(req.asset).toLowerCase() !== IMD_TOKEN || String(q.payment.asset).toLowerCase() !== IMD_TOKEN) {
      throw new Error(`the quote asks to be paid in ${req.asset}, not IMD`);
    }
    const client = x402Client.fromConfig({
      schemes: [{ network: req.network, client: new ExactEvmScheme(signer) }],
      // The x402 client pays in its default assets only unless told otherwise: IMD on this network,
      // and never more than this call allows.
      spendControls: {
        allowedAssets: [{ network: req.network, asset: IMD_TOKEN, maxAmountPerPayment: maxAmount.toString() }],
      },
    });
    // The x402 client sets the permit's deadline to this machine's clock plus maxTimeoutSeconds, and the
    // plane refuses a window that ends later than its own clock plus the same (invalid_payment_window).
    // A local clock that runs a few seconds fast is enough for that, so the window is cut by the measured
    // difference and a margin. The deadline is what gets signed; `accepted` below stays the challenge's own.
    const window = Math.max(30, Math.floor(req.maxTimeoutSeconds - clockAheadSec - 20));
    // eslint-disable-next-line no-unused-vars
    const { extensions, ...generated } = await client.createPaymentPayload({
      x402Version: 2,
      resource: ch.resource,
      accepts: [{ ...req, maxTimeoutSeconds: window }],
    });
    const payment = JSON.parse(JSON.stringify({ ...generated, accepted: req }));
    const permit = payment.payload?.permit2Authorization;
    if (!permit || String(permit.from).toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error('the payment payload does not name this wallet as the payer');
    }
    if (BigInt(permit.deadline) >= BigInt(q.expiresAt)) {
      throw new Error(`the permit's deadline ${permit.deadline} does not fall before the quote's expiry ${q.expiresAt}`);
    }
    const quoteSignature = await signer.signTypedData({
      domain: { name: 'IdentityMD Paid Action', version: '1', chainId: Number(String(q.payment.network).slice(7)) },
      types: QUOTE_APPROVAL_TYPES,
      primaryType: 'QuoteApproval',
      message: {
        resource: ch.resourceUrl,
        requesterScopeHash: `0x${ch.requesterScopeHash}`,
        quoteId: q.id,
        quoteHash: `0x${q.quoteHash}`,
        paymentHash: sha256(stringToBytes(canon(payment))),
        action: q.action,
        asset: q.payment.asset,
        amount: BigInt(q.payment.amount),
        payTo: q.payment.payTo,
        expiresAt: BigInt(q.expiresAt),
      },
    });
    return { payment, quoteSignature };
  }

  /** Step 4: send both signatures. This is the call that spends. The same bytes can be sent again if the answer is lost. */
  function submit(orderId, { payment, quoteSignature }) {
    return expect(
      'POST',
      `/requests/${orderId}/submit`,
      { body: { quoteSignature }, headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payment) } },
      [200, 202],
    );
  }

  return {
    /** What a quote would say. Free, no token, nothing held. An oracle question is checked in its short form. */
    check: (action, input) => expect('POST', '/requests/check', { body: { action, input } }),

    /** Register a public GitHub repository as a starting source. Free. */
    importRepo: (url, kind, ref) => expect('POST', '/requests/import', { body: { url, ref, kind } }),

    capabilities: () => read('/requests/capabilities'),

    /** Reserve a price for 600 seconds. Reuse the same requestKey to retry the same quote. */
    quote: (action, input, requestKey = randomUUID()) =>
      expect('POST', '/requests/quote', { body: { requestKey, action, input } }),

    /** `{status, order, payment, admission}`. Reading never charges. */
    status: (orderId) => read(`/requests/${orderId}`),

    /** Every order a wallet paid or tried to pay for, newest first: for a caller who lost the token. */
    paidBy: (address) => read(`/requests/paid-by/${String(address).toLowerCase()}`),

    oracleRequest: (requestId) => read(`/oracle/requests/${requestId}`),
    /** Not through `read`: before the panel has answered this is a 404, which the caller polls through. */
    oracleAttestation: (requestId) => expect('GET', `/oracle/requests/${requestId}/attestation`),

    job: (jobId) => read(`/jobs/${jobId}`),
    launch: (launchId) => read(`/launches/${launchId}`),
    launches: (limit = 100) => read(`/launches?limit=${limit}`),

    challenge,
    sign,
    submit,

    /** Pay for a quoted order: challenge, sign twice with the same wallet, submit. */
    async pay(orderId, opts) {
      return submit(orderId, await sign(await challenge(orderId), opts));
    },

    /**
     * Poll until the order is admitted. A refused admission (the catalog changed between quote and
     * payment) charges nothing and is thrown with its problems; so is a failed or expired payment.
     */
    async waitAdmitted(orderId, { everyMs = 5000, timeoutMs = 15 * 60_000 } = {}) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const s = await read(`/requests/${orderId}`);
        if (s.admission?.result?.kind === 'refused') throw new ImdError(409, s);
        if (s.status === 'admitted') return s;
        if (s.status === 'payment_failed' || s.status === 'expired') throw new ImdError(409, s);
        if (Date.now() > until) throw new Error(`order ${orderId} still ${s.status} after ${timeoutMs} ms`);
        await sleep(everyMs);
      }
    },
  };
}

export function newRequestToken() {
  return randomBytes(32).toString('hex');
}
