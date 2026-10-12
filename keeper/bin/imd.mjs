#!/usr/bin/env node
// imd: Pupate's command line for the IMD control plane.
//
//   node bin/imd.mjs capabilities
//   node bin/imd.mjs check <action> <body.json>          free check, nothing held
//   node bin/imd.mjs import <github-url> [contracts|site|code] [ref]
//   node bin/imd.mjs rehearse <action> <body.json>       everything but the payment: check, quote, the
//                                                        challenge and both signatures, then stop
//   node bin/imd.mjs request <action> <body.json>        quote, pay (two signatures), wait for admission
//   node bin/imd.mjs status <orderId>
//   node bin/imd.mjs attestation <oracleRequestId>       the typed data and signature for FloorFeed
//   node bin/imd.mjs floor-body <floorFeedAddress> [consumerChainId]   write questions/floor.quote.json
//
// Environment: IMD_API (default https://api.imd.fun), IMD_PAID_TOKEN (kept in .imd/token when
// unset), KEEPER_PRIVATE_KEY (for request). IMD is paid on the chain the quote names.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImd, newRequestToken, paymentSigner } from '../lib/imd.mjs';
import { floorCheckInput, floorQuoteInput } from '../lib/oracle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = process.env.IMD_API || 'https://api.imd.fun';
const [cmd, ...args] = process.argv.slice(2);

function readJson(file) {
  return JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8'));
}

function requestToken() {
  if (process.env.IMD_PAID_TOKEN) return process.env.IMD_PAID_TOKEN;
  const dir = join(root, '.imd');
  const file = join(dir, 'token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dir, { recursive: true });
  const token = newRequestToken();
  writeFileSync(file, token + '\n', { mode: 0o600 });
  console.error(`new request token written to ${file}; it is what reads your orders later`);
  return token;
}

function signer() {
  const key = process.env.KEEPER_PRIVATE_KEY;
  if (!key) throw new Error('KEEPER_PRIVATE_KEY is needed to pay');
  return paymentSigner(key);
}

function print(v) {
  console.log(JSON.stringify(v, null, 2));
}

/**
 * What IMD's free check accepts. An oracle question is checked in a short form (the full body is
 * refused there with `Unrecognized keys`) and quoted in full; every other action is checked as it is.
 */
function checkInput(action, input) {
  if (action !== 'oracle.request') return input;
  const short = {};
  for (const k of ['question', 'panelSize', 'answerType', 'evidence', 'chainId', 'toleranceBps', 'head']) {
    if (input[k] !== undefined) short[k] = input[k];
  }
  return short;
}

async function main() {
  switch (cmd) {
    case 'capabilities':
      return print(await createImd({ api }).capabilities());

    case 'check': {
      const [action, file] = args;
      const body = readJson(file);
      const input = body.action && body.input ? body.input : body;
      const out = await createImd({ api }).check(action, checkInput(action, input));
      print(out);
      process.exitCode = out.blockers?.length ? 2 : 0;
      return;
    }

    case 'import': {
      const [url, kind = 'contracts', ref] = args;
      return print(await createImd({ api }).importRepo(url, kind, ref));
    }

    case 'request': {
      const [action, file] = args;
      const body = readJson(file);
      const input = body.action && body.input ? body.input : body;
      const imd = createImd({ api, token: requestToken(), signer: signer() });
      const check = await imd.check(action, checkInput(action, input));
      if (check.blockers?.length) {
        print(check);
        throw new Error('the check has blockers; nothing was quoted');
      }
      const { order } = await imd.quote(action, input);
      console.error(`quoted order ${order.id}: ${order.quote.amount} atomic IMD, expires ${order.quote.expiresAt}`);
      await imd.pay(order.id);
      console.error('paid; waiting for admission');
      const final = await imd.waitAdmitted(order.id);
      return print(final);
    }

    case 'rehearse': {
      // The paid flow to its last free step. The quote expires by itself; the signatures are discarded.
      const [action, file] = args;
      const body = readJson(file);
      const input = body.action && body.input ? body.input : body;
      const imd = createImd({ api, token: requestToken(), signer: signer() });
      const check = await imd.check(action, checkInput(action, input));
      if (check.blockers?.length) {
        print(check);
        throw new Error('the check has blockers; nothing was quoted');
      }
      const { order } = await imd.quote(action, input);
      const ch = await imd.challenge(order.id);
      const { payment } = await imd.sign(ch);
      const permit = payment.payload.permit2Authorization;
      print({
        order: order.id,
        price: order.quote.payment.amount,
        asset: order.quote.payment.asset,
        payTo: order.quote.payment.payTo,
        payer: permit.from,
        spender: permit.spender,
        permitValidForSeconds: Number(permit.deadline) - Math.floor(Date.now() / 1000),
        quoteValidForSeconds: order.quote.expiresAt - Math.floor(Date.now() / 1000),
        suggestions: (check.suggestions || []).map((s) => s.code),
        submitted: false,
      });
      return;
    }

    case 'status':
      return print(await createImd({ api, token: requestToken() }).status(args[0]));

    case 'attestation':
      return print(await createImd({ api }).oracleAttestation(args[0]));

    case 'floor-body': {
      const [feed, consumerChainId = '1'] = args;
      if (!feed) throw new Error('floor-body needs the FloorFeed address');
      const checkBody = { action: 'oracle.request', input: floorCheckInput(1) };
      const quoteBody = { action: 'oracle.request', input: floorQuoteInput(feed, consumerChainId, 1) };
      mkdirSync(join(root, 'questions'), { recursive: true });
      writeFileSync(join(root, 'questions', 'floor.check.json'), JSON.stringify(checkBody, null, 2) + '\n');
      writeFileSync(join(root, 'questions', 'floor.quote.json'), JSON.stringify(quoteBody, null, 2) + '\n');
      console.error('wrote questions/floor.check.json and questions/floor.quote.json');
      return;
    }

    default:
      console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n').replace(/^\/\/ ?/gm, ''));
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e.message);
  if (e.body) console.error(JSON.stringify(e.body, null, 2));
  process.exitCode = 1;
});
