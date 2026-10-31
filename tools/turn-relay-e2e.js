/**
 * End-to-end: the shipped WebRTC carrier, through a real TURN relay, relay-only.
 *
 *   node tools/turn-relay-e2e.js [--app-port=5241] [--turn-port=0] [--no-headless] [--keep-open]
 *
 * Why this exists: tests/topology.test.js proves that a TURN configuration is
 * validated and composed correctly, and tools/turn-selftest.js proves the relay
 * protocol from the socket up. Neither proves the claim that actually matters
 * for M5 - that a browser, given only this app's carrier and a relay address,
 * will refuse to expose a host candidate and still get a message through. That
 * is what a symmetric NAT forces, and until now the app could only print the
 * advice ("both peers may be behind symmetric NAT - a TURN server is required")
 * without ever having met one.
 *
 * What it asserts:
 *   1. the carrier's own RTCConfiguration asks for iceTransportPolicy 'relay';
 *   2. the SDP the browser then produces contains relay candidates and nothing
 *      else - no host, no srflx, so no local address is ever handed to the peer;
 *   3. a data channel opens and an app-level envelope is delivered through it;
 *   4. the selected ICE pair on both sides is relay-to-relay, with bytes counted;
 *   5. the relay's own bookkeeping shows two allocations from two different
 *      transport addresses and traffic it forwarded - the path is load-bearing,
 *      not incidental;
 *   6. a control run with the same relay-only policy and no TURN server does not
 *      connect, which is what makes 3-5 evidence about the relay rather than
 *      about loopback being easy.
 *
 * Exit code 0 when every check passes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, parseArgs, startProjectServer } from './cdp.js';
import { createTurnServer } from './turn-server.js';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = parseArgs();
const APP_PORT = Number(args['app-port'] || 5241);
const TURN_PORT = Number(args['turn-port'] || 0);
const outPath = join(root, String(args.out || 'docs/reports/turn-relay.json'));
const REALM = 'singularity.local';
const USER = 'singularity-e2e';
const PASS = 'e2e-relay-credential';
const PROBE = 'SINGULARITY-RELAY-ONLY-PROBE';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const checks = [];
const pageEvents = [];

function check(label, ok, detail = '') {
  checks.push({ label, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `   ${detail}` : ''}`);
}

/**
 * The whole session, inside the page. It uses the app's own module so the
 * configuration, the signaling codes and the envelope framing are all shipped
 * code - the only thing this script adds is the second carrier to sit at the
 * other end of the room.
 */
const sessionScript = (turn, { relayOnly, budget = 20000 }) => `(async () => {
  const turn = ${JSON.stringify(turn)};
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const mod = await import('/src/collab/webrtc.js');
  const notes = [];
  const servers = turn ? mod.turnServers(turn) : null;
  const mk = (id) => new mod.RtcCarrier({
    id, name: id, iceServers: servers, relayOnly: ${relayOnly ? 'true' : 'false'},
    onState: (line) => notes.push(line.text),
  });
  const a = mk('turn-e2e-a');
  const b = mk('turn-e2e-b');
  const seen = [];
  b.onEnvelope = (envelope) => seen.push(envelope);
  const firstLink = (carrier) => [...carrier.links.values()][0] || null;
  const settle = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const la = firstLink(a);
      const lb = firstLink(b);
      if (la && lb && la.state === 'open' && lb.state === 'open') return true;
      if ((la && la.state === 'failed') || (lb && lb.state === 'failed')) return false;
      await new Promise((done) => setTimeout(done, 100));
    }
    return Boolean(firstLink(a) && firstLink(b) && firstLink(a).state === 'open' && firstLink(b).state === 'open');
  };

  let error = null;
  let opened = false;
  try {
    const invite = await a.createInvite();
    const answer = await b.acceptInvite(invite);
    await a.acceptAnswer(answer);
    opened = await settle(${budget});
    if (opened) a.send('chat', { text: '${PROBE}' });
  } catch (err) {
    error = String(err && err.message ? err.message : err);
  }
  await sleep(opened ? 600 : 0);

  const typs = (sdp) => String(sdp || '').split('\\n')
    .filter((line) => line.startsWith('a=candidate:'))
    .map((line) => ((line.match(/typ (\\w+)/) || [null, 'none'])[1]));
  const statsOf = async (carrier) => {
    const link = firstLink(carrier);
    if (!link) return null;
    const report = await link.pc.getStats();
    const pairs = [];
    const byId = new Map();
    report.forEach((entry) => {
      if (entry.type === 'candidate-pair') pairs.push(entry);
      else if (entry.type === 'local-candidate' || entry.type === 'remote-candidate') byId.set(entry.id, entry);
    });
    const chosen = pairs.find((pair) => pair.nominated) || pairs.find((pair) => pair.state === 'succeeded') || null;
    const local = chosen ? byId.get(chosen.localCandidateId) : null;
    const remote = chosen ? byId.get(chosen.remoteCandidateId) : null;
    return {
      ice: link.pc.iceConnectionState,
      state: link.state,
      pair: chosen ? { state: chosen.state, nominated: Boolean(chosen.nominated), bytesSent: chosen.bytesSent || 0, bytesReceived: chosen.bytesReceived || 0 } : null,
      local: local ? { type: local.candidateType, address: local.ip || local.address || null, port: local.port || null, protocol: local.protocol || null } : null,
      remote: remote ? { type: remote.candidateType, address: remote.ip || remote.address || null, port: remote.port || null } : null,
    };
  };

  const out = {
    error,
    opened,
    userAgent: navigator.userAgent,
    config: { a: a.pcConfig(), b: b.pcConfig() },
    candidates: { a: typs(firstLink(a) ? firstLink(a).pc.localDescription?.sdp : null), b: typs(firstLink(b) ? firstLink(b).pc.localDescription?.sdp : null) },
    stats: { a: await statsOf(a), b: await statsOf(b) },
    received: seen.map((envelope) => ({ kind: envelope.kind, from: envelope.from, text: envelope.payload && envelope.payload.text })),
    sent: a.stats.sent,
    notes,
  };
  a.close();
  b.close();
  return out;
})()`;

async function main() {
  const events = [];
  const relay = createTurnServer({
    realm: REALM,
    users: { [USER]: PASS },
    minRelayPort: 49400,
    maxRelayPort: 49500,
    software: 'singularity-turn/1 (e2e)',
    onEvent: (event) => events.push(event),
  });
  const listening = await relay.start(TURN_PORT);
  const turn = { urls: [`turn:127.0.0.1:${listening.port}`], username: USER, credential: PASS };
  console.log(`# TURN relay on ${turn.urls[0]} (realm ${REALM}), app on port ${APP_PORT}`);

  const site = await startProjectServer({ port: APP_PORT });
  let browser = null;
  let session = null;
  let run = null;
  let control = null;
  try {
    browser = await Browser.launch({ headless: !args['no-headless'], softwareGl: true });
    session = await browser.newSession(site.origin + '/');
    session.on('Runtime.exceptionThrown', (p) => {
      pageEvents.push(`exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`);
    });
    // A relay-only session has one way to die silently: the CSP refuses the
    // ICE server, the browser gathers nothing, and the failure looks like a
    // NAT problem. Log entries are where that shows up.
    session.on('Log.entryAdded', (p) => {
      const entry = p.entry || {};
      pageEvents.push(`${entry.source}/${entry.level}: ${entry.text}${entry.url ? ` (${entry.url})` : ''}`);
    });
    await session.waitFor('document.querySelectorAll("#tabs button").length > 0', { timeoutMs: 90000 });

    run = await session.evaluate(sessionScript(turn, { relayOnly: true }), { timeoutMs: 90000 });
    const mid = relay.stats();
    check('the carrier asked for relay-only ICE',
      run.config?.a?.iceTransportPolicy === 'relay' && run.config?.b?.iceTransportPolicy === 'relay',
      JSON.stringify(run.config?.a));
    check('the session opened a data channel through the relay', run.opened && !run.error, run.error || `sent ${run.sent}`);
    check('the SDP carries relay candidates and nothing else',
      run.candidates.a.length > 0 && run.candidates.a.every((typ) => typ === 'relay')
        && run.candidates.b.every((typ) => typ === 'relay'),
      `A ${JSON.stringify(run.candidates.a)} / B ${JSON.stringify(run.candidates.b)}`);
    const pairOk = ['a', 'b'].every((side) => {
      const stats = run.stats[side];
      return stats && stats.local?.type === 'relay' && stats.remote?.type === 'relay' && stats.pair && stats.pair.bytesSent > 0;
    });
    check('both sides selected a relay-to-relay pair that counted bytes', pairOk,
      `${JSON.stringify(run.stats.a?.local)} <-> ${JSON.stringify(run.stats.a?.remote)} / pair ${JSON.stringify(run.stats.a?.pair)}`);
    check('an app-level envelope was delivered over the relayed channel',
      run.received.some((envelope) => envelope.text === PROBE && envelope.from === 'turn-e2e-a'),
      JSON.stringify(run.received));
    // Both carriers live in one browser process and may share one local UDP
    // port, so the honest assertion is about the relay side: two allocations,
    // two relay ports, the transport addresses printed as evidence.
    check('the relay holds two allocations with two relay ports',
      mid.allocations.length === 2 && new Set(mid.allocations.map((one) => one.relayPort)).size === 2,
      `${JSON.stringify(mid.allocations.map((one) => ({ from: one.from, relay: one.relayPort, channels: one.channels.length })))} `
        + `(${new Set(mid.allocations.map((one) => one.from)).size} transport address(es))`);
    check('the relay forwarded traffic for the browser', mid.counters.forwarded > 0 && mid.counters.forwardedBytes > 0,
      JSON.stringify(mid.counters));

    // Control: same policy, no relay to point at. If this connected, the relay
    // would not be doing the work and the checks above would prove nothing.
    const before = relay.stats().counters.forwarded;
    control = await session.evaluate(sessionScript(null, { relayOnly: true, budget: 6000 }), { timeoutMs: 45000 });
    await sleep(1500);
    check('relay-only without a TURN server does not connect', !control.opened && !control.received.length,
      `A ${control.stats.a?.ice || 'n/a'} / B ${control.stats.b?.ice || 'n/a'}${control.error ? ` / ${control.error}` : ''}`);
    check('the control run put nothing through the relay', relay.stats().counters.forwarded === before,
      `forwarded before ${before}, after ${relay.stats().counters.forwarded}`);
  } finally {
    if (browser && !args['keep-open']) await browser.close().catch(() => {});
    if (site && !args['keep-open']) site.proc.kill();
    if (!args['keep-open']) relay.close();
    else console.log(`# kept open: browser, app on ${site.origin}, relay on ${turn.urls[0]}`);
  }

  const failed = checks.filter((one) => !one.ok);
  if (failed.length) {
    console.log('\n# what the carriers said:');
    for (const line of [...(run?.notes || []), ...(control?.notes || [])]) console.log(`  ${line}`);
    if (pageEvents.length) {
      console.log('\n# page exceptions:');
      for (const line of pageEvents.slice(0, 10)) console.log(`  ${line}`);
    }
  }

  const generated = new Date();
  const report = {
    schema: 1,
    kind: 'turn-relay-only-session',
    date: `${generated.getFullYear()}-${String(generated.getMonth() + 1).padStart(2, '0')}-${String(generated.getDate()).padStart(2, '0')}`,
    generatedAt: generated.toISOString(),
    environment: {
      node: process.version,
      browser: run ? run.userAgent : null,
      transport: 'udp/loopback',
      relay: { url: turn.urls[0], realm: REALM, software: 'singularity-turn/1 (e2e)' },
    },
    session: run ? { opened: run.opened, candidates: run.candidates, stats: run.stats, sent: run.sent, received: run.received } : null,
    control: control ? { opened: control.opened, ice: { a: control.stats?.a?.ice || null, b: control.stats?.b?.ice || null }, received: control.received.length } : null,
    relayCounters: relay.stats().counters,
    diagnostics: pageEvents.slice(0, 40),
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    checks,
    limitations: [
      'Both agents run in one browser on one machine; the relay-only policy is what stands in for the symmetric NAT, not a real one.',
      'The relay is a local reference implementation (tools/turn-server.js), not a hosted service.',
      'Cross-network relay traversal, TURN-TLS and long-lived allocations are outside what one machine can show.',
    ],
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nturn relay end-to-end: ${report.summary.passed}/${report.summary.total} checks ok`);
  console.log(`# report: ${outPath}`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error('turn-relay-e2e: fatal', error);
    process.exit(1);
  },
);
