#!/usr/bin/env node
// Pupate's mainnet launch, step by step. Each step reads the chain and IMD first and refuses to repeat
// what is done, so the whole thing can be run again after any interruption. The two steps that spend
// IMD write the order down before they pay and pick the same order up on a rerun; they never pay twice
// for one step. See README.md in this directory and docs/deployment.md.
//
//   node script/mainnet/launch.mjs status     balances, gas, what is done
//   node script/mainnet/launch.mjs pre        DeployPreLaunch: timelock, FloorFeed, Cocoon        (gas only)
//   node script/mainnet/launch.mjs question   Permit2 allowance if needed, the floor question to the
//                                             oracle, its attestation, the question hash          (0.5 IMD)
//   node script/mainnet/launch.mjs manifest   fill launch.json, commit and push, free import and
//                                             launch check                                        (nothing)
//   node script/mainnet/launch.mjs open       launch.open, follow the swarm's job to a live launch,
//                                             verify token, hook and pool on-chain                (0.5 IMD)
//   node script/mainnet/launch.mjs post       PostLaunch: wire, vest, pin the question, hand over  (gas only)
//   node script/mainnet/launch.mjs report     the first floor report, from the kept attestation    (gas only)
//   node script/mainnet/launch.mjs finish     keeper/addresses.mainnet.json, the site snippet, the links
//
// Environment, from .env or the environment: MAINNET_RPC_URL, KEEPER_PRIVATE_KEY (deployer, DEVELOPER,
// OPERATOR, the wallet that pays IMD), optional ETHERSCAN_API_KEY (source verification),
// MAX_BASE_FEE_GWEI (default 1: no transaction is sent above it). Nothing secret is ever printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { POOL_KEY, ROOT, castLocal, fmtEth, fmtGwei, readDotEnv, run } from '../local/common.mjs';
import { ACTION_PRICE, ImdError, createImd, newRequestToken, paymentSigner } from '../../keeper/lib/imd.mjs';
import { FLOOR_PANEL, findRequestId, floorCheckInput, floorQuoteInput, mapApiAttestation, verifyAttestation } from '../../keeper/lib/oracle.mjs';

const CHAIN_ID = 1;
const MAINNET = {
  poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  universalRouter: '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af',
  quoter: '0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  collection: '0x0000eC93127BAA929E58E97dd0095A2BFb38ec1D',
  imd: '0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7',
  seaport: '0x0000000000000068F116a894984e2DB1123eB395',
  attester: '0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982',
};
const REPO_URL = 'https://github.com/pupate-IMD/PUPATE';
const IMD_API = process.env.IMD_API || 'https://api.imd.fun';
/** Progress lives inside the project (ignored by git), never in the shared temp directory. */
const LAUNCH_DIR = join(ROOT, 'keeper', '.launch');
const PROGRESS_FILE = join(LAUNCH_DIR, 'progress.json');
const ATTESTATION_FILE = join(LAUNCH_DIR, 'first-attestation.json');
const REQUEST_FILE = join(LAUNCH_DIR, 'launch.request.json');
const TOKEN_FILE = join(ROOT, 'keeper', '.imd', 'token');
const ADDRESSES_FILE = join(ROOT, 'keeper', 'addresses.mainnet.json');
const LAUNCH_JSON = join(ROOT, 'launch.json');
const REQUEST_TEMPLATE = join(ROOT, 'keeper', 'questions', 'launch.check.json');
const DEVELOPER_SHARE_WEI = 50_000_000n * 10n ** 18n;
const MAX_UINT256 = (1n << 256n) - 1n;
const SEL = { balanceOf: '0x70a08231', allowance: '0xdd62ed3e', openedAt: '0x38930203' };
/** PoolManager's Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick). */
const INITIALIZE_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
/** How an oracle request or a launch can end without what was asked for. */
const ORACLE_DEAD = /^(disagreed|blocked|mismatch|refused|failed)$/i;

const dotenv = readDotEnv();
const env = (k) => process.env[k] || dotenv[k] || '';
const RPC = env('MAINNET_RPC_URL');
const KEY = env('KEEPER_PRIVATE_KEY');
const MAX_BASE_FEE_GWEI = Number(env('MAX_BASE_FEE_GWEI') || 1);
if (!RPC) fail('MAINNET_RPC_URL is not set');
if (!/^0x[0-9a-fA-F]{64}$/.test(KEY)) fail('KEEPER_PRIVATE_KEY is not set or not a 0x-prefixed 32-byte key');

const steps = { status, pre, question, manifest, open, post, report, finish };
const cmd = process.argv[2] || 'status';
if (!steps[cmd]) fail(`unknown step ${cmd}; one of: ${Object.keys(steps).join(', ')}`);
// Deferred by one tick: a step that reaches a helper declared further down before its first await
// (manifest does) must find this module fully evaluated.
Promise.resolve()
  .then(() => steps[cmd]())
  .catch((e) => {
    const body = e instanceof ImdError ? `\n${JSON.stringify(e.body, null, 1).slice(0, 2500)}` : '';
    console.error(`\n${cmd} failed: ${scrub(e.stack || e.message)}${scrub(body)}`);
    console.error(`progress: ${PROGRESS_FILE}`);
    process.exitCode = 1;
  });

// ------------------------------------------------------------------ status

async function status() {
  const p = loadProgress();
  const deployer = castLocal('wallet', 'address', '--private-key', KEY);
  const balance = BigInt(await rpc('eth_getBalance', [deployer, 'latest']));
  const imd = BigInt(await rpc('eth_call', [{ to: MAINNET.imd, data: SEL.balanceOf + pad(deployer) }, 'latest']));
  const head = await rpc('eth_getBlockByNumber', ['latest', false]);
  console.log(`deployer ${deployer}: ${fmtEth(balance)}, ${fmtIMD(imd)} | block ${Number(head.number)}, base fee ${fmtGwei(BigInt(head.baseFeePerGas))} (cap ${MAX_BASE_FEE_GWEI} gwei)`);
  const done = ['cocoon', 'questionHash', 'baseCommit', 'token', 'vesting', 'reported', 'finished'].map((k) => `${k}:${p[k] ? 'done' : '-'}`);
  console.log(`steps: ${done.join('  ')}`);
  for (const [k, v] of Object.entries(p)) console.log(`  ${k.padEnd(14)} ${typeof v === 'object' ? JSON.stringify(v).slice(0, 220) : v}`);
}

// ------------------------------------------------------------------ pre

async function pre() {
  const p = loadProgress();
  const deployer = await ready(p);
  if (p.cocoon) {
    console.log(`already done: Cocoon ${p.cocoon}, FloorFeed ${p.feed}, timelock ${p.timelock}`);
    return;
  }
  step('DeployPreLaunch on mainnet (timelock, FloorFeed, Cocoon)');
  const out = forgeScript('script/DeployPreLaunch.s.sol:DeployPreLaunch', {
    DEVELOPER: deployer,
    OPERATOR: deployer,
    ORACLE_ATTESTER: MAINNET.attester,
    COLLECTION: MAINNET.collection,
    POOL_MANAGER: MAINNET.poolManager,
    IMD: MAINNET.imd,
    SEAPORT: MAINNET.seaport,
    EVIDENCE_CHAIN_ID: '1',
  });
  p.timelock = grab(out, 'TimelockController');
  p.feed = grab(out, 'FloorFeed');
  p.cocoon = grab(out, 'Cocoon');
  p.fromBlock = Math.min(...broadcastReceipts('DeployPreLaunch.s.sol').map((r) => r.block));
  p.deployer = deployer;
  saveProgress(p);
  await settled('the pre-launch contracts', async () => (await hasCode(p.cocoon)) && (await hasCode(p.feed)) && (await hasCode(p.timelock)));
  console.log(`Cocoon ${p.cocoon}\nFloorFeed ${p.feed}\nTimelock ${p.timelock}\nfrom block ${p.fromBlock}`);
}

// ------------------------------------------------------------------ question (0.5 IMD)

async function question() {
  const p = loadProgress();
  const deployer = await ready(p);
  if (!p.feed) throw new Error('run `pre` first');
  if (p.questionHash && existsSync(ATTESTATION_FILE)) {
    console.log(`already done: oracle request ${p.oracle?.requestId}, questionHash ${p.questionHash}, floor ${fmtEth(BigInt(p.floorWei))}`);
    return;
  }
  await permit2Allowance(deployer);

  step(`the floor question, to a panel of ${FLOOR_PANEL.size} (quorum ${FLOOR_PANEL.quorum}, within ${FLOOR_PANEL.toleranceBps / 100}%), with FloorFeed as its consumer`);
  const admitted = await paidOrder(p, 'oracle', 'oracle.request', floorQuoteInput(p.feed, CHAIN_ID, 1), floorCheckInput(1));
  const requestId = findRequestId(admitted);
  if (!requestId) throw new Error(`the admission names no oracle request: ${JSON.stringify(admitted.admission).slice(0, 400)}`);
  p.oracle.requestId = requestId;
  saveProgress(p);
  console.log(`  oracle request ${requestId}  ${IMD_API}/oracle/requests/${requestId}`);

  step('the panel');
  const imd = imdClient();
  const until = Date.now() + 60 * 60_000;
  let last = '';
  let record = null;
  for (;;) {
    record = await imd.oracleRequest(requestId);
    if (record.questionHash && p.oracle.questionHash !== record.questionHash) {
      p.oracle.questionHash = record.questionHash;
      saveProgress(p);
    }
    const answered = (record.members || []).filter((m) => m.ok).length;
    const line = `${record.status} · ${answered} of ${record.panelSize} answered`;
    if (line !== last) {
      console.log(`  ${new Date().toISOString()} ${line}`);
      last = line;
    }
    if (record.status === 'attested') break;
    if (ORACLE_DEAD.test(String(record.status))) {
      p.oracle.ended = record.status;
      saveProgress(p);
      printMembers(record);
      throw new Error(`the oracle request ended as ${record.status}${record.failure ? `: ${JSON.stringify(record.failure).slice(0, 400)}` : ''}. The 0.5 IMD bought the panel, not an answer. To ask again, move "oracle" aside in ${PROGRESS_FILE} and rerun; that is a new payment.`);
    }
    if (Date.now() > until) throw new Error('the panel has not finished after an hour; rerun `question`, it follows the same request');
    await sleep(15_000);
  }
  printMembers(record);

  step('the attestation');
  const json = await imd.oracleAttestation(requestId);
  const signed = mapApiAttestation(json);
  const a = signed.attestation;
  const verified = await verifyAttestation({ chainId: CHAIN_ID, feed: p.feed, attestation: a, signature: signed.signature, attester: MAINNET.attester });
  if (!verified.ok) throw new Error(`the attestation is not signed by IMD's attester for this FloorFeed (recovered ${verified.signer})`);
  const floor = BigInt(a.answer);
  const problems = [];
  if (a.questionHash.toLowerCase() !== String(record.questionHash).toLowerCase()) problems.push(`questionHash ${a.questionHash} is not the request's ${record.questionHash}`);
  if (a.chainId !== 1n) problems.push(`evidence chain ${a.chainId}`);
  if (a.answerType !== 3) problems.push(`answer type ${a.answerType}`);
  if (a.quorum < 4 || a.quorum * 2 <= a.panelSize || a.agreed < a.quorum) problems.push(`panel ${a.agreed}/${a.quorum}/${a.panelSize} is below what FloorFeed accepts`);
  if (a.expiresAt - a.issuedAt < 6n * 3600n) problems.push('valid for less than the six-hour freshness window');
  if (floor < 5n * 10n ** 16n || floor > 1000n * 10n ** 18n) problems.push(`floor ${fmtEth(floor)} is outside 0.05 to 1,000 ETH`);
  if (problems.length) throw new Error(`the attestation would not be accepted by FloorFeed:\n  ${problems.join('\n  ')}`);
  mkdirSync(LAUNCH_DIR, { recursive: true });
  writeFileSync(ATTESTATION_FILE, JSON.stringify(json, null, 2));
  p.questionHash = a.questionHash;
  p.floorWei = floor.toString();
  p.attestationIssuedAt = Number(a.issuedAt);
  saveProgress(p);
  console.log(`  signed by ${verified.signer}; ${a.agreed} of ${a.panelSize} agreed (quorum ${a.quorum})`);
  console.log(`  questionHash ${p.questionHash}\n  floor ${fmtEth(floor)}, issued ${new Date(Number(a.issuedAt) * 1000).toISOString()}, fresh for six hours\n  kept in ${ATTESTATION_FILE}`);
}

/** IMD moves the payment through Permit2, so the token allows Permit2 once (the x402 convention: unlimited). */
async function permit2Allowance(deployer) {
  step('Permit2 allowance for IMD (one-time)');
  const read = async () => BigInt(await rpc('eth_call', [{ to: MAINNET.imd, data: SEL.allowance + pad(deployer) + pad(MAINNET.permit2) }, 'latest']));
  const allowance = await read();
  if (allowance >= 10n * ACTION_PRICE) {
    console.log(`  already ${allowance === MAX_UINT256 ? 'unlimited' : fmtIMD(allowance)}`);
    return;
  }
  const r = run('cast', ['send', MAINNET.imd, 'approve(address,uint256)', MAINNET.permit2, MAX_UINT256.toString(), '--rpc-url', RPC, '--private-key', KEY, '--json'], { quiet: true });
  if (r.status !== 0) throw new Error(`approve failed: ${scrub(r.stdout + r.stderr)}`);
  const receipt = JSON.parse(r.stdout);
  console.log(`  approved Permit2 for IMD: ${receipt.transactionHash} (gas ${Number(receipt.gasUsed)})`);
  await settled('the allowance', async () => (await read()) >= 10n * ACTION_PRICE);
}

function printMembers(record) {
  const members = record.members || [];
  if (!members.length) return;
  console.log(`  answers (${record.agreement?.agreed ?? '?'} agreed, quorum ${record.quorum}; signed answer ${record.agreement?.answer ? fmtEth(BigInt(record.agreement.answer)) : 'none'}):`);
  for (const m of members) {
    const ans = m.answer?.answer;
    console.log(`    seat ${String(m.tokenId).padStart(4)}  ${m.ok ? (ans && /^\d+$/.test(ans) ? fmtEth(BigInt(ans)) : String(ans)) : `no answer (${m.reason ?? 'unknown'})`}  ${String(m.answer?.recipe?.source ?? '').slice(0, 90)}`);
  }
}

// ------------------------------------------------------------------ manifest (free)

async function manifest() {
  const p = loadProgress();
  if (!p.cocoon) throw new Error('run `pre` first');
  step('launch.json with the Cocoon and timelock addresses');
  let text = readFileSync(LAUNCH_JSON, 'utf8');
  // Lowercase, as IMD takes addresses everywhere else.
  const cocoon = p.cocoon.toLowerCase();
  const timelock = p.timelock.toLowerCase();
  const filled = text.replace('<COCOON_ADDRESS>', cocoon).replace('<TIMELOCK_ADDRESS>', timelock);
  if (filled !== text) {
    writeFileSync(LAUNCH_JSON, filled);
    text = filled;
  }
  const args = JSON.parse(text).hook.constructorArgs;
  if (args[0] !== '$poolManager' || args[1] !== cocoon || args[2] !== timelock) throw new Error(`launch.json constructorArgs are ${JSON.stringify(args)}, not the PoolManager placeholder, Cocoon and the timelock`);
  const dirty = git(['status', '--porcelain']).trim();
  if (dirty) {
    git(['add', '-A', '--', 'launch.json', 'keeper/questions']);
    const staged = git(['diff', '--cached', '--name-only']).trim();
    if (staged) {
      git(['commit', '-q', '-m', 'launch manifest: the Cocoon and timelock addresses on mainnet']);
      console.log(`  committed: ${staged.split(/\r?\n/).join(', ')}`);
    }
    const rest = git(['status', '--porcelain']).trim();
    if (rest) throw new Error(`the working tree has other uncommitted changes; commit or stash them first:\n${rest}`);
  }
  git(['push']);
  const head = git(['rev-parse', 'HEAD']).trim();

  step('IMD reads the repository (free)');
  const imd = imdClient();
  const imported = await imd.importRepo(REPO_URL, 'contracts');
  if (!imported.ok) throw new Error(`IMD cannot import the repository: ${JSON.stringify(imported.problems).slice(0, 600)}`);
  if (imported.source.baseCommit !== head) throw new Error(`IMD sees commit ${imported.source.baseCommit} on GitHub, not local HEAD ${head}`);
  console.log(`  ${imported.source.repoUrl} at ${head.slice(0, 10)} (${imported.source.sizeKb} KB)`);

  step('the launch request and the free check');
  const body = JSON.parse(readFileSync(REQUEST_TEMPLATE, 'utf8'));
  body.input.repoUrl = imported.source.repoUrl;
  body.input.baseCommit = head;
  mkdirSync(LAUNCH_DIR, { recursive: true });
  writeFileSync(REQUEST_FILE, JSON.stringify(body, null, 2) + '\n');
  const check = await imd.check('launch.open', body.input);
  if (check.blockers?.length) throw new Error(`the launch check has blockers:\n${JSON.stringify(check.blockers, null, 2).slice(0, 1500)}`);
  console.log(`  no blockers; plan: ${(check.plan || []).map((s) => s.short || s.title).join(' → ')}`);
  if (check.suggestions?.length) console.log(`  suggestions: ${JSON.stringify(check.suggestions).slice(0, 600)}`);
  p.baseCommit = head;
  p.repoUrl = imported.source.repoUrl;
  saveProgress(p);
  console.log(`  request body kept in ${REQUEST_FILE}`);
}

// ------------------------------------------------------------------ open (0.5 IMD)

async function open() {
  const p = loadProgress();
  const deployer = await ready(p);
  if (!p.baseCommit || !existsSync(REQUEST_FILE)) throw new Error('run `manifest` first');
  if (p.token) {
    console.log(`already done: token ${p.token}, hook ${p.hook}, launch #${p.launch?.launchNumber}`);
    return;
  }
  const head = git(['rev-parse', 'HEAD']).trim();
  if (head !== p.baseCommit && !p.launch?.orderId) throw new Error(`HEAD is ${head.slice(0, 10)} but the request was prepared for ${p.baseCommit.slice(0, 10)}; run \`manifest\` again`);
  await permit2Allowance(deployer);

  step('launch.open');
  const body = JSON.parse(readFileSync(REQUEST_FILE, 'utf8'));
  const admitted = await paidOrder(p, 'launch', 'launch.open', body.input);
  const result = admitted.admission?.result;
  if (result?.kind !== 'job' || !result.jobId) throw new Error(`the admission names no job: ${JSON.stringify(admitted.admission).slice(0, 400)}`);
  p.launch.jobId = result.jobId;
  saveProgress(p);
  console.log(`  job ${result.jobId}  ${IMD_API}/jobs/${result.jobId}`);

  step('the swarm: audit of the code as it is, the manifest, four specialist audits, the judge, the deployment');
  const imd = imdClient();
  const until = Date.now() + 6 * 3600_000;
  let last = '';
  let launch = null;
  for (;;) {
    const job = await imd.job(result.jobId);
    const nodes = (job.nodes || []).map((n) => `${n.key ?? n.skill ?? '?'}:${n.status ?? n.state ?? '?'}`).join(' ');
    let line = `job ${job.state}${job.blockedReason ? ` (${job.blockedReason})` : ''} · launch ${job.launch?.status ?? 'not attached'}`;
    if (job.launch?.id) {
      p.launch.launchId = job.launch.id;
      launch = await imd.launch(job.launch.id);
      p.launch.launchNumber = launch.launchNumber;
      saveProgress(p);
      line += ` #${launch.launchNumber}${launch.parkedReason ? ` · ${launch.parkedReason}` : ''}${launch.deployFailure ? ` · deploy: ${JSON.stringify(launch.deployFailure).slice(0, 200)}` : ''}`;
    }
    if (`${line}|${nodes}` !== last) {
      console.log(`  ${new Date().toISOString()} ${line}\n      ${nodes}`);
      last = `${line}|${nodes}`;
    }
    if (launch?.status === 'parked') {
      p.launch.parked = launch.parkedReason;
      saveProgress(p);
      throw new Error(`IMD parked the launch: ${launch.parkedReason}\nThe job: https://explorer.imd.fun/jobs/${result.jobId}  (record: ${IMD_API}/jobs/${result.jobId}, admission checks: ${IMD_API}/launches/${job.launch.id})\nThe 0.5 IMD is spent. Answer the findings, commit, run \`manifest\`, move "launch" aside in ${PROGRESS_FILE}, and \`open\` again as a new payment.`);
    }
    if (launch?.status === 'live' && (launch.artifacts || []).some((x) => x.role === 'hook') && (launch.artifacts || []).some((x) => x.role === 'token')) break;
    if (/^(failed|cancelled|canceled|rejected)$/i.test(String(job.state))) throw new Error(`the job ended as ${job.state}: ${job.blockedReason ?? ''}`);
    if (Date.now() > until) throw new Error('the launch is not live after six hours; rerun `open`, it follows the same job');
    await sleep(20_000);
  }
  const token = launch.artifacts.find((x) => x.role === 'token');
  const hook = launch.artifacts.find((x) => x.role === 'hook');
  const distributor = launch.artifacts.find((x) => x.role === 'distributor');

  step('checking the launch on-chain');
  await settled('the launch transaction', async () => (await hasCode(hook.address)) && (await hasCode(token.address)));
  const receipt = await rpc('eth_getTransactionReceipt', [hook.txHash]);
  const init = receipt.logs.find((l) => l.address.toLowerCase() === MAINNET.poolManager.toLowerCase() && l.topics[0] === INITIALIZE_TOPIC && `0x${l.data.slice(2 + 64 * 2 + 24, 2 + 64 * 3)}`.toLowerCase() === hook.address.toLowerCase());
  if (!init) throw new Error(`the launch transaction ${hook.txHash} has no Initialize event for the hook`);
  const word = (i) => init.data.slice(2 + 64 * i, 2 + 64 * (i + 1));
  const poolKey = { fee: parseInt(word(0), 16), tickSpacing: parseInt(word(1), 16) };
  const currency0 = `0x${init.topics[2].slice(26)}`;
  const currency1 = `0x${init.topics[3].slice(26)}`;
  const checks = [
    ['hook.sink() is Cocoon', call(hook.address, 'sink()(address)')[0], p.cocoon],
    ['hook.owner() is the timelock', call(hook.address, 'owner()(address)')[0], p.timelock],
    ['token.totalSupply() is 1e27', call(token.address, 'totalSupply()(uint256)')[0], String(10n ** 27n)],
    ['pool currency0 is native ETH', currency0, '0x0000000000000000000000000000000000000000'],
    ['pool currency1 is the token', currency1, token.address],
    ['pool id is the hook\'s launch pool', call(hook.address, 'launchPool()(bytes32)')[0], init.topics[1]],
    ['hook.buyTaxBps() is in its opening window or at 6%', String(BigInt(call(hook.address, 'buyTaxBps()(uint256)')[0]) >= 600n), 'true'],
  ];
  let bad = 0;
  for (const [name, got, want] of checks) {
    const ok = String(got).toLowerCase() === String(want).toLowerCase();
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${got}, want ${want}`}`);
  }
  const mine = BigInt(await rpc('eth_call', [{ to: token.address, data: SEL.balanceOf + pad(deployer) }, 'latest']));
  console.log(`  pool key: fee ${poolKey.fee}, tick spacing ${poolKey.tickSpacing}; the deployer holds ${fmtPupate(mine)} to vest`);
  if (bad) throw new Error(`${bad} launch check(s) failed; nothing recorded. Look before running \`post\`.`);
  p.token = token.address;
  p.hook = hook.address;
  p.distributor = distributor?.address ?? null;
  p.poolKey = poolKey;
  p.poolId = init.topics[1];
  p.launchTx = hook.txHash;
  p.launchBlock = Number(receipt.blockNumber);
  saveProgress(p);
  console.log(`token ${p.token}\nhook ${p.hook}\nlaunch #${launch.launchNumber} ${launch.id}\ntx ${p.launchTx}`);
}

// ------------------------------------------------------------------ post

async function post() {
  const p = loadProgress();
  const deployer = await ready(p);
  if (!p.token) throw new Error('run `open` first');
  if (!p.questionHash) throw new Error('run `question` first: PostLaunch pins the question hash');
  if (p.vesting && String(call(p.cocoon, 'owner()(address)')[0]).toLowerCase() === p.timelock.toLowerCase()) {
    console.log(`already done: vesting ${p.vesting}; FloorFeed and Cocoon belong to the timelock`);
    return;
  }
  step('PostLaunch (wire, vest, pin the question, hand over to the timelock)');
  const mine = BigInt(await rpc('eth_call', [{ to: p.token, data: SEL.balanceOf + pad(deployer) }, 'latest']));
  console.log(`  the deployer holds ${fmtPupate(mine)}${near(mine, DEVELOPER_SHARE_WEI) ? '' : ' (not the expected 5%: whatever is there is vested)'}`);
  const out = forgeScript('script/PostLaunch.s.sol:PostLaunch', {
    COCOON: p.cocoon,
    FEED: p.feed,
    TIMELOCK: p.timelock,
    TOKEN: p.token,
    HOOK: p.hook,
    DEVELOPER: deployer,
    QUESTION_HASH: p.questionHash,
    POOL_FEE: String(p.poolKey?.fee ?? POOL_KEY.fee),
    TICK_SPACING: String(p.poolKey?.tickSpacing ?? POOL_KEY.tickSpacing),
    ...(p.vesting ? { VESTING: p.vesting } : process.env.VESTING ? { VESTING: process.env.VESTING } : {}),
  });
  p.vesting = grab(out, 'PupateVesting');
  saveProgress(p);
  await settled('the post-launch wiring', async () =>
    String(call(p.cocoon, 'wired()(bool)')[0]) === 'true' &&
    (await hasCode(p.vesting)) &&
    String(call(p.cocoon, 'owner()(address)')[0]).toLowerCase() === p.timelock.toLowerCase() &&
    String(call(p.feed, 'owner()(address)')[0]).toLowerCase() === p.timelock.toLowerCase() &&
    String(call(p.feed, 'questionHash()(bytes32)')[0]).toLowerCase() === p.questionHash.toLowerCase());
  console.log(`vesting ${p.vesting}, holding ${fmtPupate(BigInt(call(p.token, 'balanceOf(address)(uint256)', p.vesting)[0]))}`);
}

// ------------------------------------------------------------------ report

async function report() {
  const p = loadProgress();
  await ready(p);
  if (!p.vesting) throw new Error('run `post` first');
  if (p.reported) {
    console.log('already done');
    return;
  }
  if (String(call(p.feed, 'latest()(uint256,bool)')[1]) === 'true') {
    console.log('the feed already has a fresh report');
    p.reported = true;
    saveProgress(p);
    return;
  }
  step('the first floor report, from the attestation the question produced');
  const signed = mapApiAttestation(JSON.parse(readFileSync(ATTESTATION_FILE, 'utf8')));
  const a = signed.attestation;
  const age = Math.floor(Date.now() / 1000) - Number(a.issuedAt);
  if (age > 6 * 3600) {
    console.log(`  the kept attestation is ${(age / 3600).toFixed(1)} h old, past the six-hour window: FloorFeed would refuse it.`);
    console.log('  Nothing is lost: the keeper buys a new one when the vault first needs a price (0.5 IMD).');
    p.reported = 'skipped: the first attestation went stale before the launch';
    saveProgress(p);
    return;
  }
  const tuple = `(${a.requestId},${a.chainId},${a.questionHash},${a.answerType},${a.answer},${a.figure},${a.fromBlock},${a.toBlock},${a.blockHash},${a.panelJobId},${a.panelSize},${a.quorum},${a.agreed},${a.issuedAt},${a.expiresAt})`;
  const sig = 'report((bytes32,uint256,bytes32,uint8,bytes,uint256,uint64,uint64,bytes32,bytes32,uint16,uint16,uint16,uint64,uint64),bytes)';
  const sim = run('cast', ['call', p.feed, sig, tuple, signed.signature, '--rpc-url', RPC], { quiet: true });
  if (sim.status !== 0) throw new Error(`FloorFeed would refuse the report: ${scrub(sim.stdout + sim.stderr).slice(0, 600)}`);
  const r = run('cast', ['send', p.feed, sig, tuple, signed.signature, '--rpc-url', RPC, '--private-key', KEY, '--json'], { quiet: true });
  if (r.status !== 0) throw new Error(`report failed: ${scrub(r.stdout + r.stderr)}`);
  const receipt = JSON.parse(r.stdout);
  console.log(`  ${receipt.transactionHash} status ${receipt.status} gas ${Number(receipt.gasUsed)}`);
  await settled('the first report', async () => String(call(p.feed, 'latest()(uint256,bool)')[1]) === 'true');
  p.reported = true;
  saveProgress(p);
  console.log(`  feed.latest() = ${call(p.feed, 'latest()(uint256,bool)').join(', ')}`);
}

// ------------------------------------------------------------------ finish

async function finish() {
  const p = loadProgress();
  if (!p.vesting) throw new Error('run `post` first');
  const poolKey = p.poolKey ?? { fee: POOL_KEY.fee, tickSpacing: POOL_KEY.tickSpacing };
  const addresses = {
    chainId: CHAIN_ID,
    fromBlock: p.fromBlock,
    token: p.token,
    hook: p.hook,
    cocoon: p.cocoon,
    feed: p.feed,
    timelock: p.timelock,
    vesting: p.vesting,
    poolManager: MAINNET.poolManager,
    universalRouter: MAINNET.universalRouter,
    quoter: MAINNET.quoter,
    permit2: MAINNET.permit2,
    collection: MAINNET.collection,
    imd: MAINNET.imd,
    seaport: MAINNET.seaport,
    poolKey,
    attester: MAINNET.attester,
    distributor: p.distributor ?? null,
    launchId: p.launch?.launchId ?? null,
    launchNumber: p.launch?.launchNumber ?? null,
    launchTx: p.launchTx ?? null,
    oracleRequestId: p.oracle?.requestId ?? null,
    questionHash: p.questionHash,
  };
  writeFileSync(ADDRESSES_FILE, JSON.stringify(addresses, null, 2) + '\n');
  p.finished = true;
  saveProgress(p);
  console.log(`wrote ${ADDRESSES_FILE}\n`);
  console.log('site/lib/addresses.ts, MAINNET:');
  console.log(`export const MAINNET: Addresses | null = {
  chainId: 1,
  fromBlock: ${p.fromBlock},
  token: "${p.token}",
  hook: "${p.hook}",
  cocoon: "${p.cocoon}",
  feed: "${p.feed}",
  timelock: "${p.timelock}",
  vesting: "${p.vesting}",
  poolManager: UNISWAP[1].poolManager,
  universalRouter: UNISWAP[1].universalRouter,
  quoter: UNISWAP[1].quoter,
  permit2: PERMIT2,
  collection: COLLECTION,
  imd: IMD,
  seaport: SEAPORT,
  poolKey: { fee: ${poolKey.fee}, tickSpacing: ${poolKey.tickSpacing} },
};`);
  console.log(`\nlinks:
  token      https://etherscan.io/token/${p.token}
  hook       https://etherscan.io/address/${p.hook}
  Cocoon     https://etherscan.io/address/${p.cocoon}
  FloorFeed  https://etherscan.io/address/${p.feed}
  launch tx  https://etherscan.io/tx/${p.launchTx}
  IMD launch ${IMD_API}/launches/${p.launch?.launchId} (launch #${p.launch?.launchNumber}); explorer https://explorer.imd.fun/launches
  IMD job    https://explorer.imd.fun/jobs/${p.launch?.jobId} (record: ${IMD_API}/jobs/${p.launch?.jobId})
  oracle     ${IMD_API}/oracle/requests/${p.oracle?.requestId}
  Uniswap    https://app.uniswap.org/explore/tokens/ethereum/${p.token}
  buy        https://pupate.fun/buy/`);
}

// ------------------------------------------------------------------ paying IMD, once

function requestToken() {
  if (process.env.IMD_PAID_TOKEN) return process.env.IMD_PAID_TOKEN;
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  mkdirSync(join(ROOT, 'keeper', '.imd'), { recursive: true });
  const token = newRequestToken();
  writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
  return token;
}

const imdClient = (paying = false) => createImd({ api: IMD_API, token: requestToken(), signer: paying ? paymentSigner(KEY) : undefined });

/**
 * Quote and pay for one action, once, and wait for its admission. The order id is written down before
 * anything is signed. On a rerun the same order is read first: one that was paid is followed, one that
 * was never paid is quoted again, and nothing is ever paid for twice.
 */
async function paidOrder(p, slot, action, input, checkInput = input) {
  const imd = imdClient(true);
  let o = p[slot];
  if (o?.ended) throw new Error(`the last ${action} ended as ${o.ended}; move "${slot}" aside in ${PROGRESS_FILE} to pay for another`);
  if (o?.orderId) {
    let s = await imd.status(o.orderId);
    if ((s.status === 'quoted' || s.status === 'expired') && o.submittedAt) {
      await sleep(20_000); // a payment that was sent a moment ago may not show yet
      s = await imd.status(o.orderId);
    }
    console.log(`  order ${o.orderId}: ${s.status}`);
    if (s.status === 'payment_failed') throw new Error(`the payment failed: ${JSON.stringify(s.payment).slice(0, 400)}. Nothing was charged. Fix it, move "${slot}" aside in ${PROGRESS_FILE} and run again.`);
    if (s.status === 'quoted' || s.status === 'expired') {
      console.log('  it was never paid; quoting again');
      p[`${slot}Unpaid`] = [...(p[`${slot}Unpaid`] || []), o.orderId];
      o = null;
    }
  }
  if (!o) {
    const check = await imd.check(action, checkInput);
    if (check.blockers?.length) throw new Error(`IMD's check has blockers:\n${JSON.stringify(check.blockers, null, 2).slice(0, 1500)}`);
    const { order } = await imd.quote(action, input);
    const amount = BigInt(order.quote.payment.amount);
    if (amount !== ACTION_PRICE) throw new Error(`the quote asks for ${fmtIMD(amount)}, not the ${fmtIMD(ACTION_PRICE)} this step is allowed to spend`);
    o = p[slot] = { orderId: order.id, amount: amount.toString(), quotedAt: new Date().toISOString() };
    saveProgress(p);
    console.log(`  quoted: order ${order.id}, ${fmtIMD(amount)}, good for ${order.quote.expiresAt - Math.floor(Date.now() / 1000)} s`);
    const signedPayment = await imd.sign(await imd.challenge(order.id));
    o.submittedAt = new Date().toISOString();
    saveProgress(p);
    const sent = await imd.submit(order.id, signedPayment);
    console.log(`  paid ${fmtIMD(amount)}: ${sent?.status ?? 'sent'}`);
  }
  const admitted = await imd.waitAdmitted(o.orderId, { timeoutMs: 30 * 60_000 });
  o.admittedAt = new Date().toISOString();
  o.paymentTx = admitted.payment?.transactionHash ?? null;
  saveProgress(p);
  console.log(`  admitted${o.paymentTx ? `; payment ${o.paymentTx}` : ''}`);
  return admitted;
}

// ------------------------------------------------------------------ shared

/** The deployer address, after the chain id, the balance, the base fee and the progress file pass. */
async function ready(p) {
  const chainId = Number(await rpc('eth_chainId'));
  if (chainId !== CHAIN_ID) throw new Error(`MAINNET_RPC_URL answers with chain id ${chainId}`);
  const deployer = castLocal('wallet', 'address', '--private-key', KEY);
  if (p.deployer && p.deployer.toLowerCase() !== deployer.toLowerCase()) throw new Error(`the key in .env is ${deployer}, but this launch was started by ${p.deployer}`);
  const head = await rpc('eth_getBlockByNumber', ['latest', false]);
  const baseFee = BigInt(head.baseFeePerGas);
  const balance = BigInt(await rpc('eth_getBalance', [deployer, 'latest']));
  console.log(`mainnet block ${Number(head.number)}, base fee ${fmtGwei(baseFee)}; ${deployer} holds ${fmtEth(balance)}`);
  if (baseFee > BigInt(Math.round(MAX_BASE_FEE_GWEI * 1e9))) {
    throw new Error(`base fee ${fmtGwei(baseFee)} is above the ${MAX_BASE_FEE_GWEI} gwei cap; wait, or raise MAX_BASE_FEE_GWEI knowingly`);
  }
  if (balance < 2n * 10n ** 15n) throw new Error(`the deployer holds ${fmtEth(balance)}; keep at least 0.002 ETH for gas`);
  await verifyProgress(p, deployer);
  return deployer;
}

/**
 * The progress file is only a note to self; before a step acts on it, the pre-launch addresses are
 * checked against forge's own broadcast record and against the chain, so a tampered or stale file
 * cannot steer a transaction at the wrong contract.
 */
async function verifyProgress(p, deployer) {
  if (!p.cocoon) return;
  const file = join(ROOT, 'broadcast', 'DeployPreLaunch.s.sol', String(CHAIN_ID), 'run-latest.json');
  if (existsSync(file)) {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const deployed = Object.fromEntries(json.transactions.filter((t) => t.contractAddress).map((t) => [t.contractName, t.contractAddress.toLowerCase()]));
    for (const [name, want] of [['Cocoon', p.cocoon], ['FloorFeed', p.feed], ['TimelockController', p.timelock]]) {
      if (deployed[name] && deployed[name] !== want.toLowerCase()) throw new Error(`progress names ${name} ${want}, but the broadcast record has ${deployed[name]}`);
    }
  }
  const attester = call(p.feed, 'attester()(address)')[0];
  if (attester.toLowerCase() !== MAINNET.attester.toLowerCase()) throw new Error(`FloorFeed ${p.feed} has attester ${attester}, not IMD's`);
  const owner = call(p.cocoon, 'owner()(address)')[0].toLowerCase();
  if (owner !== deployer.toLowerCase() && owner !== p.timelock.toLowerCase()) throw new Error(`Cocoon ${p.cocoon} is owned by ${owner}, neither the deployer nor the timelock`);
  if (p.hook) {
    const sink = call(p.hook, 'sink()(address)')[0];
    if (sink.toLowerCase() !== p.cocoon.toLowerCase()) throw new Error(`hook ${p.hook} has sink ${sink}, not Cocoon`);
  }
}

function forgeScript(target, scriptEnv) {
  const args = ['script', target, '--rpc-url', RPC, '--broadcast', '--private-key', KEY, '--slow', '--non-interactive', '--gas-estimate-multiplier', '130', '--retries', '10', '--delay', '8'];
  if (env('ETHERSCAN_API_KEY')) args.push('--verify', '--etherscan-api-key', env('ETHERSCAN_API_KEY'));
  const r = run('forge', args, { env: scriptEnv, quiet: true });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) throw new Error(`forge ${target} failed (exit ${r.status})\n${scrub(out)}`);
  const logs = out.match(/== Logs ==\s*([\s\S]*?)(?:\n\s*\n## |\n\s*\n==|\nSIMULATION|\nSKIPPING|$)/);
  console.log(scrub(logs ? logs[1] : out).trimEnd().replace(/^/gm, '  '));
  return out;
}

function grab(out, label) {
  const m = out.match(new RegExp(`^\\s*${label}\\s+(0x[0-9a-fA-F]{40})\\s*$`, 'm'));
  if (!m) throw new Error(`could not find "${label} 0x..." in the script output`);
  return m[1];
}

function broadcastReceipts(scriptFile) {
  const file = join(ROOT, 'broadcast', basename(scriptFile), String(CHAIN_ID), 'run-latest.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const byHash = new Map((json.receipts || []).map((r) => [r.transactionHash.toLowerCase(), r]));
  return json.transactions.map((t) => {
    const r = t.hash ? byHash.get(String(t.hash).toLowerCase()) : null;
    return { block: r ? Number(r.blockNumber) : NaN, gas: r ? BigInt(r.gasUsed) : 0n };
  });
}

function git(args) {
  const r = run('git', args, { quiet: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
  return r.stdout;
}

function call(to, sig, ...args) {
  const out = run('cast', ['call', to, sig, ...args.map(String), '--rpc-url', RPC]).stdout.trim();
  return out.split(/\r?\n/).map((line) => line.replace(/\s+\[[^\]]*\]\s*$/, '').trim()).filter((line) => line.length);
}

async function rpc(method, params = []) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function hasCode(address) {
  const code = await rpc('eth_getCode', [address, 'latest']);
  return Boolean(code) && code !== '0x';
}

async function settled(what, predicate, { timeoutMs = 300_000, everyMs = 6_000 } = {}) {
  const started = Date.now();
  let agree = 0;
  while (Date.now() - started < timeoutMs) {
    let ok = false;
    try {
      ok = await predicate();
    } catch {
      ok = false;
    }
    agree = ok ? agree + 1 : 0;
    if (agree >= 3) {
      console.log(`  ${what}: final (${Math.round((Date.now() - started) / 1000)} s)`);
      return;
    }
    await sleep(everyMs);
  }
  throw new Error(`${what} did not settle within ${timeoutMs / 1000} s`);
}

function loadProgress() {
  return existsSync(PROGRESS_FILE) ? JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')) : {};
}

function saveProgress(p) {
  mkdirSync(LAUNCH_DIR, { recursive: true });
  writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

const pad = (address) => address.slice(2).toLowerCase().padStart(64, '0');
const fmtIMD = (wei) => `${(Number(wei) / 1e18).toFixed(3)} IMD`;
const fmtPupate = (wei) => `${(Number(wei) / 1e18).toLocaleString('en-US')} PUPATE`;

function near(got, want) {
  try {
    const d = BigInt(got) - BigInt(want);
    return (d < 0n ? -d : d) <= 10n ** 18n;
  } catch {
    return false;
  }
}

function scrub(text) {
  let out = String(text);
  for (const secret of [RPC, KEY, env('ETHERSCAN_API_KEY'), existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '']) {
    if (secret) out = out.split(secret).join('<redacted>');
  }
  try {
    out = out.split(new URL(RPC).host).join('<rpc-host>');
  } catch {
    // not a URL
  }
  return out;
}

function step(title) {
  console.log(`\n== ${title}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}
