/**
 * Load and chaos for the M5 ciphertext relay (tools/relay.js).
 *
 *   node tools/load-relay.js --self-check
 *   node tools/load-relay.js --clients=1000 --send=50          # the measured run
 *   node tools/load-relay.js --chaos                           # kill it mid-backlog, restart on its log
 *   node tools/load-relay.js --failover                        # kill it mid-backlog, fail over to a standby node
 *   node tools/load-relay.js --clients=1000 --send=50 --out=docs/reports/relay-load.json
 *
 * Every mode ends by grading the run against latency and loss thresholds
 * (--p95-max, --p99-max, --loss-max, --dup-max; --chaos and --failover also
 * against --failover-max for the recovery window). The defaults are the
 * brief's own row limits, an exceeded threshold fails the process, and the
 * verdicts travel in the JSON report so a report cannot claim a pass the run
 * did not earn.
 *
 * Why this exists: the brief's budget has a "10,000 concurrent users, p95 under
 * 200 ms" row and a "kill any server node, lose zero data" row, and the only
 * honest way to move either is to have a server tier to measure and to kill.
 * The static site still needs no server; this is the M5 relay contract
 * (src/collab/mesh.js) as a real process, and everything below is a client of
 * it - 1,000 virtual clients, each with one long-poll drain open and paced
 * posts going out, all talking to the relay over loopback.
 *
 * The load is genuine, not synthesized from counters: every envelope is sealed
 * with AES-256-GCM under a key this harness derives at startup and the relay
 * never sees, posted as { from, to, ct }, and opened on the receiving side, so
 * a delivery count only advances when a real ciphertext round-tripped. Latency
 * is send-to-delivery: senders and receivers stamp with timeOrigin + now(),
 * the same wall clock across this machine's processes and only across one
 * machine (see the clock's own comment).
 *
 * One generator process saturates its own event loop above ~1,500 envelopes/s,
 * so fleets of 500 clients or more are split across four generator processes
 * (--shards) of 250 clients each, with one parent process owning the relay and
 * reconciling the per-process snapshots - sent keys, received keys, latencies -
 * into the fleet-wide loss/duplication/latency numbers. Each generator stops on
 * a quiet window after its sends are acked, because a shard cannot know how
 * many envelopes other shards addressed to its clients; stopping early can only
 * surface as loss at the merge, never as a silent pass.
 *
 * Three modes:
 *
 *   --self-check   fast functional suite against a spawned relay: round trip,
 *                  long-poll, broadcast-once-per-peer, inspect blindness,
 *                  validation and caps, auth, and durability across a
 *                  SIGKILL-and-restart. This is the relay's test suite; it
 *                  deliberately lives here so the published test totals of the
 *                  browser/Node suites do not move.
 *   (default)      the measured run: 1,000 clients split across shards, 50
 *                  envelopes each at one per 250 ms (4,000/s while in flight),
 *                  drains live, then reports latency, loss, duplicates,
 *                  throughput and the relay's own CPU and memory.
 *   --chaos        stage 1 delivers normally, then delivery is paused, a burst
 *                  is accepted, the relay is killed with SIGKILL mid-backlog,
 *                  restarted on the same log, and every envelope accepted
 *                  before the kill must be delivered after it - zero loss.
 *   --failover     the same pause-and-burst beat, but the node is not
 *                  restarted: a second relay (the standby) is already
 *                  listening, the fleet switches its destination to it, and
 *                  every envelope the dead node had accepted but not yet
 *                  delivered is re-posted from the client-side outbox. The
 *                  service keeps running on the standby, and the run measures
 *                  kill-to-first-accepted-post, kill-to-first-delivery, and
 *                  the zero-loss / zero-duplicate accounting across two nodes.
 *
 * What the numbers do not claim: loopback on one machine, one relay process,
 * no TLS, no proxy, no disk contention. They are reported against those
 * conditions in docs/LOAD_CHAOS.md and not extrapolated to the brief's rows.
 */
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import http, { Agent } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './cdp.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relayPath = join(root, 'tools/relay.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Epoch-based timestamp. Within one process a performance.now() difference is
 * exact; across the generator processes of a sharded run, timeOrigin + now()
 * gives every process the same wall clock (same machine), which is what the
 * cross-process delivery latency needs. Same-machine only - docs/LOAD_CHAOS.md
 * says so.
 */
const nowEpoch = () => performance.timeOrigin + performance.now();

const args = parseArgs();
const cfg = {
  clients: Number(args.clients || 1000),
  send: Number(args.send || 50),
  burst: Number(args.burst || 20),
  interval: Number(args.interval || 200),
  size: Number(args.size || 256),
  seed: Number(args.seed || 42),
  keySeed: Number(args['key-seed'] || args.seed || 42),
  shards: Number(args.shards || 1),
  timeoutMs: Number(args.timeout || 180) * 1000,
  drainTimeoutMs: Number(args['drain-timeout'] || 30) * 1000,
  quietMs: Number(args['quiet-ms'] || 2500),
  rampMs: Number(args['ramp-ms'] || 2000),
  selfCheck: Boolean(args['self-check']),
  chaos: Boolean(args.chaos),
  failover: Boolean(args.failover),
  generate: Boolean(args.generate),
  shard: Number(args.shard || 0),
  idOffset: Number(args['id-offset'] || 0),
  totalClients: Number(args['total-clients'] || 0),
  port: Number(args.port || 0),
  out: typeof args.out === 'string' ? resolve(args.out) : null,
  keep: Boolean(args.keep),
  // Thresholds. The defaults are the brief's own row limits (p95 under 200 ms,
  // no loss, no duplication); the recovery window is this harness's own bar,
  // 2 s - the same back-off the WebRTC carrier uses before an ICE restart.
  p95Max: args['p95-max'] === undefined ? 200 : Number(args['p95-max']),
  // p99 is reported in every artifact but only gated when a flag asks for it.
  // The brief's row is a p95 bar ("10,000 concurrent users at p95 < 200 ms"),
  // and a loopback p99 measures straggler scheduling on a busy laptop as much
  // as the service - the committed clean run itself had p99 649 ms.
  p99Max: args['p99-max'] === undefined ? null : Number(args['p99-max']),
  lossMax: args['loss-max'] === undefined ? 0 : Number(args['loss-max']),
  dupMax: args['dup-max'] === undefined ? 0 : Number(args['dup-max']),
  failoverMax: args['failover-max'] === undefined ? 2000 : Number(args['failover-max']),
  postSend: Number(args['post-send'] || 5),
};
// One generator process saturates its own event loop above ~1,500 envelopes/s
// (measured on this machine: p95 jumps from single-digit to hundreds of
// milliseconds), so the default measured run splits the fleet across four
// processes, each staying under that knee. Small runs stay in one process.
// Chaos and failover stay in one process too: their pause/kill/hand-over beats
// are coordinated from one event loop.
if (!cfg.chaos && !cfg.failover && !cfg.generate && !args.shards && cfg.clients >= 500) cfg.shards = 4;

// ----------------------------------------------------------------- utilities
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentiles(values, ps = [50, 95, 99]) {
  if (!values.length) return Object.fromEntries(ps.map((p) => [p, null]));
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return Object.fromEntries(ps.map((p) => [p, Math.round(at(p) * 10) / 10]));
}

/**
 * HTTP helper built on the node:http agents below. Responses are small JSON
 * documents; the interesting cost is connection handling, not parsing.
 */
function request(agent, port, method, path, body, timeoutMs = 30000, headers = null) {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* non-JSON error page */
          }
          resolvePromise({ status: res.statusCode, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out: ${method} ${path}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeAgent(maxSockets) {
  // Keep every socket the run opens. With a small free-socket cap the pool
  // destroys and re-creates connections continuously at this concurrency, and
  // the resulting connect bursts overflow the relay's accept queue (seen as
  // ECONNREFUSED). The relay's idle timeout is minutes, so kept sockets stay
  // usable for the whole run.
  return new Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets, scheduling: 'lifo' });
}

// -------------------------------------------------------------- relay process
class Relay {
  constructor({ data, extra = [] }) {
    this.data = data;
    this.extra = extra;
    this.port = 0;
    this.proc = null;
    this.stderr = '';
  }

  start() {
    return new Promise((resolvePromise, reject) => {
      const proc = spawn(process.execPath, [relayPath, '--port=0', `--data=${this.data}`, ...this.extra], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = proc;
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`relay did not start within 10s: ${this.stderr}`)), 10000);
      proc.stdout.on('data', (d) => {
        buf += d;
        const m = /listening on http:\/\/[^:]+:(\d+)/.exec(buf);
        if (m && !this.port) {
          clearTimeout(timer);
          this.port = Number(m[1]);
          resolvePromise(this);
        }
      });
      proc.stderr.on('data', (d) => {
        this.stderr += d;
      });
      proc.on('exit', (code) => {
        if (!this.port) {
          clearTimeout(timer);
          reject(new Error(`relay exited with ${code}: ${this.stderr}`));
        }
      });
    });
  }

  /** Hard kill, the way a machine dies; waits for the process to actually exit. */
  kill() {
    return new Promise((resolvePromise) => {
      const proc = this.proc;
      this.proc = null;
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
        resolvePromise();
        return;
      }
      proc.once('exit', () => resolvePromise());
      proc.kill('SIGKILL');
    });
  }
}

async function statsOf(agent, port) {
  const r = await request(agent, port, 'GET', '/relay/stats', undefined, 10000);
  return r.json;
}

// ------------------------------------------------------------------- tracker
class Tracker {
  constructor() {
    this.records = new Map(); // `${from}#${seq}` -> record
    this.latencies = [];
    this.postRtts = [];
    this.c = {
      attempted: 0,
      acked: 0,
      rejected: 0,
      transportFailed: 0,
      delivered: 0,
      duplicates: 0,
      unknown: 0,
      misrouted: 0,
      undecryptable: 0,
    };
  }

  expect(from, seq, stage) {
    const rec = { from, seq, stage, sentAt: nowEpoch(), ackedAt: null, deliveredAt: null };
    this.records.set(`${from}#${seq}`, rec);
    this.c.attempted += 1;
    return rec;
  }

  acked(rec) {
    rec.ackedAt = nowEpoch();
    this.postRtts.push(rec.ackedAt - rec.sentAt);
    this.c.acked += 1;
  }

  delivered(from, seq) {
    const rec = this.records.get(`${from}#${seq}`);
    if (!rec) {
      this.c.unknown += 1;
      return;
    }
    if (rec.deliveredAt !== null) {
      this.c.duplicates += 1;
      return;
    }
    rec.deliveredAt = nowEpoch();
    this.latencies.push(rec.deliveredAt - rec.sentAt);
    this.c.delivered += 1;
  }
}

// -------------------------------------------------------------- virtual client
class VirtualClient {
  constructor(run, index) {
    this.run = run;
    this.id = `c${String(run.cfg.idOffset + index + 1).padStart(4, '0')}`;
    this.index = index;
    this.n = 0;
    this.stopped = false;
    this.paused = false;
    this.reconnects = 0;
    this.jitter = run.rng();
    this.startTask = null;
    this.sendTask = null;
    this.drainTask = null;
    // The client-side outbox: every envelope this client posted (or attempted),
    // kept so that a node death can be answered by re-posting what the dead
    // node had accepted but not yet delivered. This is exactly the behaviour
    // the browser carrier (src/collab/relay.js) implements on failover.
    this.outbox = new Map(); // `${from}#${seq}` -> envelope
  }

  start() {
    // A cold fleet dialling in at once is a connection storm the OS refuses
    // part of (ECONNREFUSED from the listener's accept queue). Real clients
    // arrive staggered, so the fleet ramps in over --ramp-ms; the steady-state
    // offered rate is unchanged.
    const ramp = (this.index / this.run.cfg.clients) * this.run.cfg.rampMs;
    this.startTask = (async () => {
      if (ramp > 0) await sleep(ramp);
      if (this.stopped) return;
      this.sendTask = this.sendLoop();
      this.drainTask = this.drainLoop();
    })();
  }

  async sendLoop() {
    const startAt = performance.now() + (this.index / this.run.cfg.clients) * this.run.cfg.interval;
    for (let i = 0; i < this.run.cfg.send && !this.stopped; i += 1) {
      const at = startAt + i * this.run.cfg.interval * (0.9 + 0.2 * this.jitter);
      await this.until(at);
      if (this.stopped) return;
      await this.sendOne('main');
    }
  }

  async burstLoop(count) {
    for (let i = 0; i < count && !this.stopped; i += 1) await this.sendOne('burst');
  }

  async until(target) {
    while (!this.stopped) {
      const d = target - performance.now();
      if (d <= 0) return;
      await sleep(Math.min(d, 50));
    }
  }

  pickTarget() {
    const space = this.run.cfg.totalClients || this.run.cfg.clients;
    if (space === 1) return this.id;
    for (;;) {
      const other = `c${String(1 + Math.floor(this.run.rng() * space)).padStart(4, '0')}`;
      if (other !== this.id) return other;
    }
  }

  seal(payload) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.run.key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  }

  open(ct) {
    const buf = Buffer.from(ct, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.run.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
  }

  async sendOne(stage) {
    const seq = this.n;
    this.n += 1;
    if (this.run.firstSendAt === 0) this.run.firstSendAt = nowEpoch();
    const record = this.run.tracker.expect(this.id, seq, stage);
    const body = { q: seq, t: record.sentAt, st: stage, pad: '' };
    body.pad = 'x'.repeat(Math.max(0, this.run.cfg.size - JSON.stringify(body).length));
    const envelope = { from: this.id, to: this.pickTarget(), ct: this.seal(body) };
    this.outbox.set(`${envelope.from}#${body.q}`, envelope);
    try {
      const r = await request(this.run.postAgent, this.run.port, 'POST', '/relay/post', envelope, 15000);
      if (r.status === 200) {
        this.run.tracker.acked(record);
        this.run.sentKeys.push(`${envelope.from}#${body.q}`);
        if (this.run.sampleCtBytes === null) this.run.sampleCtBytes = envelope.ct.length;
      } else {
        this.run.tracker.c.rejected += 1;
        this.run.lastReject = `${r.status} ${r.json && r.json.error}`;
      }
    } catch (err) {
      if (!this.stopped) {
        this.run.tracker.c.transportFailed += 1;
        this.run.lastReject = String(err && err.message);
        if (this.run.transportEvents.length < 300) {
          this.run.transportEvents.push({
            at: Math.round(nowEpoch() - this.run.startedAt),
            code: err && err.code ? err.code : null,
          });
        }
      }
    }
  }

  async drainLoop() {
    while (!this.stopped) {
      if (this.paused) {
        await sleep(50);
        continue;
      }
      let r;
      try {
        r = await request(this.run.drainAgent, this.run.port, 'GET', `/relay/drain?peer=${this.id}&wait=15`, undefined, 20000);
      } catch {
        if (this.stopped) return;
        if (this.paused) continue;
        this.reconnects += 1;
        await sleep(50);
        continue;
      }
      if (!r.json || !r.json.ok || !Array.isArray(r.json.envelopes)) {
        this.reconnects += 1;
        await sleep(50);
        continue;
      }
      for (const env of r.json.envelopes) this.receive(env);
    }
  }

  /**
   * Post-failover traffic: a handful of numbered sends on the standby, so the
   * run proves the service kept working after the node died rather than only
   * that the backlog was recovered.
   */
  async postFailover(count) {
    for (let i = 0; i < count && !this.stopped; i += 1) await this.sendOne('post-failover');
  }

  /**
   * Re-post one outbox envelope to whatever node `run.port` now points at.
   * The failover run calls this for exactly the census set - envelopes the
   * dead node had accepted but not yet delivered - so a re-post cannot show up
   * as a duplicate at the receiver.
   */
  async repost(key) {
    const envelope = this.outbox.get(key);
    if (!envelope) return { key, ok: false, error: 'not in outbox' };
    try {
      const r = await request(this.run.postAgent, this.run.port, 'POST', '/relay/post', envelope, 15000);
      if (r.status === 200) return { key, ok: true };
      return { key, ok: false, error: `${r.status} ${r.json && r.json.error}` };
    } catch (err) {
      return { key, ok: false, error: String(err && err.message) };
    }
  }

  receive(env) {
    if (env.to !== this.id && env.to !== '*') this.run.misrouted += 1;
    let payload;
    try {
      payload = this.open(env.ct);
    } catch {
      this.run.undecryptable += 1;
      return;
    }
    this.run.receivedCount += 1;
    this.run.received.push(`${env.from}#${payload.q}`);
    this.run.latencies.push(nowEpoch() - payload.t);
    this.run.lastReceiveAt = nowEpoch();
    if (this.run.standbyWatchFrom && !this.run.firstStandbyReceiveAt && this.run.lastReceiveAt >= this.run.standbyWatchFrom) {
      this.run.firstStandbyReceiveAt = this.run.lastReceiveAt;
    }
    // Own-send bookkeeping for the single-process chaos run; a sharded parent
    // reconciles the raw pair lists instead (a receipt here may belong to a
    // client another generator process is tracking).
    this.run.tracker.delivered(env.from, payload.q);
  }
}

// ------------------------------------------------------------------- the run
class Run {
  constructor(cfg) {
    this.cfg = cfg;
    this.rng = mulberry32(cfg.seed);
    // One key for the whole fleet, derived from --key-seed so that separate
    // generator processes share it. The relay never receives it.
    this.key = createHash('sha256').update(`relay-key-${cfg.keySeed}`).digest();
    this.tracker = new Tracker();
    this.port = 0;
    this.sampleCtBytes = null;
    this.lastReject = null;
    this.postAgent = makeAgent(cfg.clients * 3 + 64);
    this.drainAgent = makeAgent(cfg.clients + 64);
    this.relayData = null;
    this.clients = [];
    this.relay = null;
    this.peakRssMiB = 0;
    this.samples = 0;
    this.sampling = false;
    this.startedAt = 0;
    this.firstSendAt = 0;
    this.sentKeys = [];
    this.received = [];
    this.latencies = [];
    this.receivedCount = 0;
    this.lastReceiveAt = 0;
    this.misrouted = 0;
    this.undecryptable = 0;
    this.transportEvents = [];
    this.standbyWatchFrom = 0; // epoch ms when the failover watch started
    this.firstStandbyReceiveAt = 0;
    this.clientById = new Map();
  }

  async startRelay(extra = []) {
    // First call owns the data directory; a restart (chaos mode kills the
    // process and starts it again) must reuse the same log, not a fresh one.
    if (!this.relayData) this.relayData = mkdtempSync(join(tmpdir(), 'relay-load-'));
    this.relay = await new Relay({ data: this.relayData, extra }).start();
    this.port = this.relay.port;
    return this.relay;
  }

  stats() {
    return statsOf(this.postAgent, this.port);
  }

  startClients() {
    this.startedAt = nowEpoch();
    for (let i = 0; i < this.cfg.clients; i += 1) this.clients.push(new VirtualClient(this, i));
    for (const client of this.clients) this.clientById.set(client.id, client);
    for (const client of this.clients) client.start();
  }

  /**
   * One process worth of raw numbers. `sentKeys` is what this process posted
   * successfully; `received`/`latencies` cover every envelope its clients saw,
   * including ones addressed from other generator processes. The parent
   * reconciles the union of all snapshots into the fleet-wide result.
   */
  snapshot(durationMs) {
    const t = this.tracker;
    return {
      shard: this.cfg.shard,
      clients: this.cfg.clients,
      idOffset: this.cfg.idOffset,
      send: this.cfg.send,
      durationMs: Math.round(durationMs),
      startedAt: this.startedAt,
      firstSendAt: this.firstSendAt,
      lastReceiveAt: this.lastReceiveAt,
      lastReject: this.lastReject,
      reconnects: this.clients.reduce((sum, c) => sum + c.reconnects, 0),
      ctChars: this.sampleCtBytes,
      misrouted: this.misrouted,
      undecryptable: this.undecryptable,
      sends: {
        attempted: t.c.attempted,
        acked: t.c.acked,
        rejected: t.c.rejected,
        transportFailed: t.c.transportFailed,
      },
      sentKeys: this.sentKeys,
      received: this.received,
      latencies: this.latencies,
      postRtts: t.postRtts,
      transportEvents: this.transportEvents,
    };
  }

  /** Resolves once `value()` is true, or the deadline passes. Returns whether it happened. */
  async waitFor(value, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (value()) return true;
      if (performance.now() > deadline) return false;
      await sleep(50);
    }
  }

  startSampling(periodMs = 500) {
    this.sampler = setInterval(async () => {
      if (this.sampling) return;
      this.sampling = true;
      try {
        const s = await this.stats();
        if (s) {
          this.peakRssMiB = Math.max(this.peakRssMiB, s.rssMiB);
          this.samples += 1;
        }
      } catch {
        /* the relay may be dead in chaos mode; that is part of the test */
      } finally {
        this.sampling = false;
      }
    }, periodMs);
  }

  stopSampling() {
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
  }

  async stopAll() {
    for (const client of this.clients) client.stopped = true;
    this.postAgent.destroy();
    this.drainAgent.destroy();
    await Promise.allSettled(this.clients.flatMap((c) => [c.startTask, c.sendTask, c.drainTask]));
    if (this.relay) await this.relay.kill();
    if (!this.cfg.keep && this.relayData) rmSync(this.relayData, { recursive: true, force: true });
  }

  summary({ mode, durationMs, relayBefore, relayAfter, extra = {} }) {
    const t = this.tracker;
    const lat = t.latencies;
    const lost = t.c.acked - t.c.delivered;
    return {
      mode,
      conditions: {
        clients: this.cfg.clients,
        shards: this.cfg.shards,
        sendPerClient: this.cfg.send,
        burstPerClient: this.cfg.chaos ? this.cfg.burst : 0,
        intervalMs: this.cfg.interval,
        payloadBytes: this.cfg.size,
        ctChars: this.sampleCtBytes,
        seed: this.cfg.seed,
        transport: 'loopback http/1.1, keep-alive, one relay process, no TLS',
        fsync: false,
      },
      run: {
        attempted: t.c.attempted,
        acked: t.c.acked,
        rejected: t.c.rejected,
        transportFailed: t.c.transportFailed,
        delivered: t.c.delivered,
        lost,
        duplicates: t.c.duplicates,
        unknown: t.c.unknown,
        misrouted: this.misrouted,
        undecryptable: this.undecryptable,
        reconnects: this.clients.reduce((sum, c) => sum + c.reconnects, 0),
        durationMs: Math.round(durationMs),
        throughputPerSec: Math.round((t.c.delivered / Math.max(1, durationMs)) * 1000),
        latencyMs: percentiles(lat),
        maxLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => Math.max(a, b), 0) * 10) / 10 : null,
        postRttMs: percentiles(t.postRtts),
      },
      relay: {
        rssMiB: relayAfter ? relayAfter.rssMiB : null,
        peakRssMiB: Math.round(this.peakRssMiB * 10) / 10,
        heapUsedMiB: relayAfter ? relayAfter.heapUsedMiB : null,
        cpuUserMsBefore: relayBefore ? relayBefore.cpuUserMs : null,
        cpuUserMsAfter: relayAfter ? relayAfter.cpuUserMs : null,
        cpuUserMsDelta: relayBefore && relayAfter ? relayAfter.cpuUserMs - relayBefore.cpuUserMs : null,
        sampleCount: this.samples,
        pendingAtEnd: relayAfter ? relayAfter.pending : null,
        postsSeenByServer: relayAfter ? relayAfter.posts : null,
        deliveriesSeenByServer: relayAfter ? relayAfter.deliveries : null,
      },
      ...extra,
    };
  }
}

function ok(label, value) {
  console.log(`  ok   ${label.padEnd(28)} ${value}`);
}

function fail(label, value) {
  console.log(`  FAIL ${label.padEnd(28)} ${value}`);
}

// ---------------------------------------------------------------- thresholds
/**
 * Grade a finished run against the thresholds. The defaults are the brief's
 * own row limits for latency and loss; the recovery window is this harness's
 * bar. Every verdict is printed, written into the JSON report, and any breach
 * fails the process - a run that "passed" only in prose cannot leave a report.
 */
function thresholdVerdicts(summary, cfg) {
  const r = summary.run;
  const rows = [];
  const add = (metric, value, limit, unit) => {
    if (value == null) return;
    rows.push({ metric, value, limit, unit, ok: value <= limit });
  };
  // Latency gates apply to the measured run. The chaos and failover beats
  // deliberately pause delivery while a backlog builds, so envelopes that wait
  // out the pause would gate the pause window, not the service; those two
  // modes gate their recovery window instead, and still gate loss and
  // duplication like everyone else.
  if (!summary.chaos && !summary.failover) {
    add('latency p95', r.latencyMs[95], cfg.p95Max, 'ms');
    if (cfg.p99Max != null) add('latency p99', r.latencyMs[99], cfg.p99Max, 'ms');
  }
  add('envelopes lost', r.lost, cfg.lossMax, 'envelopes');
  add('envelopes duplicated', r.duplicates, cfg.dupMax, 'envelopes');
  if (summary.chaos) add('kill to recovered', summary.chaos.killToReadyMs, cfg.failoverMax, 'ms');
  if (summary.failover) add('kill to failover', summary.failover.failoverMs, cfg.failoverMax, 'ms');
  return rows;
}

function printThresholds(rows) {
  for (const row of rows) {
    const label = `${row.metric} <= ${row.limit} ${row.unit}`;
    if (row.ok) ok(label, `${row.value} ${row.unit}`);
    else fail(label, `${row.value} ${row.unit}`);
  }
  return rows.every((row) => row.ok);
}

// -------------------------------------------------------------------- measure
/** Wait for every send to be acknowledged, then for every ack to be delivered. */
async function runTraffic(run, cfg) {
  const sendsDone = () => run.clients.every((c) => c.n >= cfg.send);
  const allAcked = () => run.tracker.c.acked === run.tracker.c.attempted;
  const sendsOk = await run.waitFor(() => sendsDone() && allAcked(), cfg.timeoutMs);
  const deliveredAll = await run.waitFor(
    () => run.receivedCount === run.tracker.c.acked && run.tracker.c.acked > 0,
    cfg.drainTimeoutMs,
  );
  return { sendsOk, deliveredAll };
}

// ------------------------------------------------------------------ summaries
/**
 * Fleet-wide reconciliation. Every generator process reports the keys it
 * posted successfully (`sentKeys`) and every key its clients received, in
 * arrival order (`received`). The merge counts a key as delivered once, flags
 * a second sighting as a duplicate wherever it happened - across processes
 * included - and treats receipts of never-sent keys as unknown. Delivery
 * duration runs from the fleet's first client start to the last receipt, so
 * the throughput is what the fleet actually sustained, quiet tails excluded.
 */
function buildSummary({ parts, conditions, relay, durationMs }) {
  const sent = new Set();
  for (const p of parts) for (const k of p.sentKeys) sent.add(k);
  const seen = new Set();
  let delivered = 0;
  let duplicates = 0;
  let unknown = 0;
  for (const p of parts) {
    for (const k of p.received) {
      if (seen.has(k)) {
        duplicates += 1;
        continue;
      }
      seen.add(k);
      if (sent.has(k)) delivered += 1;
      else unknown += 1;
    }
  }
  const latencies = parts.flatMap((p) => p.latencies);
  const postRtts = parts.flatMap((p) => p.postRtts);
  const sum = (fn) => parts.reduce((acc, p) => acc + fn(p), 0);
  const acked = sum((p) => p.sends.acked);
  const lastReceipt = Math.max(0, ...parts.map((p) => p.lastReceiveAt || 0));
  const firstSend = Math.min(...parts.map((p) => p.firstSendAt || Infinity));
  const deliveryMs =
    lastReceipt > 0 && Number.isFinite(firstSend) ? lastReceipt - firstSend : durationMs;
  return {
    mode: 'measure',
    conditions: { ...conditions, ctChars: parts.find((p) => p.ctChars != null)?.ctChars ?? null },
    run: {
      attempted: sum((p) => p.sends.attempted),
      acked,
      rejected: sum((p) => p.sends.rejected),
      transportFailed: sum((p) => p.sends.transportFailed),
      lastReject: parts.find((p) => p.lastReject)?.lastReject ?? null,
      transportEvents: parts
        .flatMap((p) => p.transportEvents || [])
        .sort((a, b) => a.at - b.at)
        .slice(0, 200),
      delivered,
      lost: acked - delivered,
      duplicates,
      unknown,
      misrouted: sum((p) => p.misrouted),
      undecryptable: sum((p) => p.undecryptable),
      reconnects: sum((p) => p.reconnects),
      durationMs: Math.round(deliveryMs),
      throughputPerSec: Math.round((delivered / Math.max(1, deliveryMs)) * 1000),
      latencyMs: percentiles(latencies),
      maxLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => Math.max(a, b), 0) * 10) / 10 : null,
      postRttMs: percentiles(postRtts),
    },
    relay,
    shards: parts.map((p) => ({
      shard: p.shard,
      clients: p.clients,
      idOffset: p.idOffset,
      durationMs: p.durationMs,
      acked: p.sends.acked,
      received: p.received.length,
      latencyMs: percentiles(p.latencies),
    })),
  };
}

function relayBlock(run, relayBefore, relayAfter) {
  return {
    rssMiB: relayAfter ? relayAfter.rssMiB : null,
    peakRssMiB: Math.round(run.peakRssMiB * 10) / 10,
    heapUsedMiB: relayAfter ? relayAfter.heapUsedMiB : null,
    cpuUserMsBefore: relayBefore ? relayBefore.cpuUserMs : null,
    cpuUserMsAfter: relayAfter ? relayAfter.cpuUserMs : null,
    cpuUserMsDelta: relayBefore && relayAfter ? relayAfter.cpuUserMs - relayBefore.cpuUserMs : null,
    sampleCount: run.samples,
    pendingAtEnd: relayAfter ? relayAfter.pending : null,
    postsSeenByServer: relayAfter ? relayAfter.posts : null,
    deliveriesSeenByServer: relayAfter ? relayAfter.deliveries : null,
  };
}

/** Print the measured run and return whether every claim held. */
function printLoadSummary(summary, lastReject = null) {
  const c = summary.conditions;
  const r = summary.run;
  console.log(
    `relay load: ${c.clients.toLocaleString('en-US')} clients` +
      (c.shards > 1 ? ` (${c.shards} generator processes x ${c.clientsPerShard})` : '') +
      `, ${r.attempted.toLocaleString('en-US')} envelopes of ~${c.payloadBytes} B payload ` +
      `(${c.ctChars} B ct on the wire)`,
  );
  let clean = true;
  const lastErr = lastReject || summary.run.lastReject;
  if (r.acked === r.attempted && r.rejected === 0 && r.transportFailed === 0) {
    ok('posts acknowledged', `${r.acked.toLocaleString('en-US')}/${r.attempted.toLocaleString('en-US')}`);
  } else {
    clean = false;
    fail('posts acknowledged', `${r.acked}/${r.attempted} (rejected ${r.rejected}, transport ${r.transportFailed}${lastErr ? `; last: ${lastErr}` : ''})`);
  }
  if (r.lost === 0 && r.duplicates === 0 && r.unknown === 0) {
    ok('delivered', `${r.delivered.toLocaleString('en-US')} in ${(r.durationMs / 1000).toFixed(1)} s (${r.throughputPerSec.toLocaleString('en-US')}/s), 0 lost, 0 duplicated`);
  } else {
    clean = false;
    fail('delivered', `${r.delivered}/${r.acked}, lost ${r.lost}, duplicated ${r.duplicates}, unknown ${r.unknown}, misrouted ${r.misrouted}, undecryptable ${r.undecryptable}`);
  }
  ok('send-to-delivery latency', `p50 ${r.latencyMs[50]} ms, p95 ${r.latencyMs[95]} ms, p99 ${r.latencyMs[99]} ms, max ${r.maxLatencyMs} ms`);
  ok('post round trip', `p50 ${r.postRttMs[50]} ms, p95 ${r.postRttMs[95]} ms`);
  ok('relay process', `rss ${summary.relay.rssMiB} MiB (peak ${summary.relay.peakRssMiB} MiB), heap ${summary.relay.heapUsedMiB} MiB, cpu ${summary.relay.cpuUserMsDelta} ms user, ${summary.relay.sampleCount} samples`);
  ok('server counters', `posts ${summary.relay.postsSeenByServer}, deliveries ${summary.relay.deliveriesSeenByServer}, pending ${summary.relay.pendingAtEnd}`);
  return clean;
}

function writeLoadReport(cfg, summary) {
  if (!cfg.out) return;
  writeFileSync(
    cfg.out,
    `${JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`, ...summary }, null, 2)}\n`,
  );
  console.log(`  report ${cfg.out}`);
}

async function measure(cfg) {
  cfg = { ...cfg, shards: 1 }; // this path is one generator process (see measureSharded)
  const run = new Run(cfg);
  try {
    await run.startRelay();
    const relayBefore = await run.stats();
    run.startSampling();
    const t0 = performance.now();
    run.startClients();

    const { sendsOk, deliveredAll } = await runTraffic(run, cfg);
    if (!sendsOk) console.log('  note   not every send completed before the deadline');
    if (!deliveredAll) console.log('  note   the drain phase hit its deadline before every ack arrived');
    const finished = performance.now();
    const relayAfter = await run.stats();

    const summary = buildSummary({
      parts: [run.snapshot(finished - t0)],
      conditions: {
        clients: cfg.clients,
        shards: 1,
        sendPerClient: cfg.send,
        burstPerClient: 0,
        intervalMs: cfg.interval,
        payloadBytes: cfg.size,
        seed: cfg.seed,
        transport: 'loopback http/1.1, keep-alive, one relay process, no TLS',
        fsync: false,
      },
      relay: relayBlock(run, relayBefore, relayAfter),
      durationMs: finished - t0,
    });
    const clean = printLoadSummary(summary, run.lastReject);
    const gates = thresholdVerdicts(summary, cfg);
    summary.thresholds = gates;
    if (!printThresholds(gates)) console.log('  note   a threshold was exceeded; see the FAIL lines');
    writeLoadReport(cfg, summary);
    return { summary, failed: !clean || !deliveredAll || gates.some((g) => !g.ok) };
  } finally {
    run.stopSampling();
    await run.stopAll();
  }
}

// ------------------------------------------------------- generator (shard mode)
/**
 * One generator process in a sharded run. The parent owns the relay and passes
 * its port in; this process runs its slice of the clients, then writes one
 * snapshot - its sends, every key it received with arrival latencies, and the
 * raw pair lists - for the parent to reconcile across shards.
 */
async function generateShard(cfg) {
  const run = new Run(cfg);
  run.port = cfg.port;
  try {
    run.startClients();
    const t0 = performance.now();
    const sendsOk = await run.waitFor(
      () => run.clients.every((c) => c.n >= cfg.send) && run.tracker.c.acked === run.tracker.c.attempted,
      cfg.timeoutMs,
    );
    // A shard cannot know how many envelopes its clients will be addressed
    // from the other shards, so "done" is a quiet stream: its own sends
    // complete and nothing arrives for longer than any inter-shard start skew.
    // Stopping early would surface as loss in the parent's reconciliation -
    // never as a pass.
    const quietMs = cfg.quietMs;
    const quietDone = await run.waitFor(
      () => sendsOk && run.lastReceiveAt > 0 && nowEpoch() - run.lastReceiveAt > quietMs,
      cfg.timeoutMs + quietMs,
    );
    const finished = performance.now();
    const snapshot = run.snapshot(finished - t0);
    snapshot.sendsOk = sendsOk;
    snapshot.quietDone = quietDone;
    writeFileSync(cfg.out, JSON.stringify(snapshot));
    return sendsOk && quietDone;
  } finally {
    await run.stopAll();
  }
}

// --------------------------------------------------------------- sharded measure
/**
 * The measured run split across several generator processes. One process is
 * enough up to roughly 1,000 envelopes/s; above that its own event loop
 * saturates (client-side p95 climbs into hundreds of milliseconds while the
 * relay sits in single-digit CPU), so the default fleet is four processes, each
 * staying under the knee. The relay process, its log and its budgets are the
 * same as the single-process path.
 */
async function measureSharded(cfg) {
  const per = Math.floor(cfg.clients / cfg.shards);
  const total = per * cfg.shards;
  if (per < 1) throw new Error(`--shards=${cfg.shards} does not fit --clients=${cfg.clients}`);
  if (total !== cfg.clients) console.log(`  note   ${cfg.clients} clients do not divide by ${cfg.shards}; running ${total}`);
  const parent = new Run({ ...cfg, clients: 1, send: 0 });
  const startedAt = performance.now();
  const parts = [];
  let failures = 0;
  try {
    await parent.startRelay();
    const relayBefore = await parent.stats();
    parent.startSampling();
    const children = [];
    for (let i = 0; i < cfg.shards; i += 1) {
      const out = join(parent.relayData, `shard-${i}.json`);
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          '--generate',
          `--shard=${i}`,
          `--clients=${per}`,
          `--id-offset=${i * per}`,
          `--total-clients=${total}`,
          `--send=${cfg.send}`,
          `--interval=${cfg.interval}`,
          `--size=${cfg.size}`,
          `--seed=${cfg.seed + i}`,
          `--key-seed=${cfg.keySeed}`,
          `--port=${parent.port}`,
          `--out=${out}`,
          `--timeout=${Math.round(cfg.timeoutMs / 1000)}`,
          `--drain-timeout=${Math.round(cfg.drainTimeoutMs / 1000)}`,
          `--quiet-ms=${cfg.quietMs}`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const entry = { child, out, stdout: '', stderr: '', code: null };
      child.stdout.on('data', (d) => {
        entry.stdout += d;
      });
      child.stderr.on('data', (d) => {
        entry.stderr += d;
      });
      child.on('exit', (code) => {
        entry.code = code;
      });
      children.push(entry);
    }
    await Promise.all(
      children.map(
        (entry) =>
          new Promise((resolvePromise) => {
            if (entry.code !== null) resolvePromise();
            else entry.child.on('exit', () => resolvePromise());
          }),
      ),
    );
    parent.stopSampling();
    const relayAfter = await parent.stats();

    for (const entry of children) {
      try {
        parts.push(JSON.parse(readFileSync(entry.out, 'utf8')));
      } catch (err) {
        failures += 1;
        const tail = (entry.stderr || entry.stdout || String(err)).trim().slice(-400);
        fail(`shard ${entry.out.match(/shard-(\d+)/)?.[1] ?? '?'}`, `exit ${entry.code}; ${tail}`);
      }
      if (entry.code !== 0) {
        failures += 1;
        if (entry.stderr) fail(`shard ${entry.out.match(/shard-(\d+)/)?.[1] ?? '?'} stderr`, entry.stderr.trim().slice(0, 400));
      }
    }

    const summary = buildSummary({
      parts,
      conditions: {
        clients: total,
        clientsPerShard: per,
        shards: cfg.shards,
        sendPerClient: cfg.send,
        burstPerClient: 0,
        intervalMs: cfg.interval,
        payloadBytes: cfg.size,
        seed: cfg.seed,
        transport: 'loopback http/1.1, keep-alive, one relay process, no TLS',
        generator: `${cfg.shards} processes x ${per} clients`,
        fsync: false,
      },
      relay: relayBlock(parent, relayBefore, relayAfter),
      durationMs: performance.now() - startedAt,
    });
    const clean = printLoadSummary(summary);
    const gates = thresholdVerdicts(summary, cfg);
    summary.thresholds = gates;
    if (!printThresholds(gates)) console.log('  note   a threshold was exceeded; see the FAIL lines');
    writeLoadReport(cfg, summary);
    return { summary, failed: failures > 0 || !clean || gates.some((g) => !g.ok) };
  } finally {
    parent.stopSampling();
    await parent.stopAll();
  }
}

// ---------------------------------------------------------------------- chaos
async function chaos(cfg) {
  // Chaos runs one generator process: the pause/kill/resume beat has to be
  // coordinated from one event loop, and the zero-loss claim does not depend
  // on the offered rate.
  cfg = { ...cfg, shards: 1 };
  const run = new Run(cfg);
  try {
    await run.startRelay();
    run.startSampling();
    const t0 = performance.now();
    run.startClients();

    // Stage 1: normal traffic, fully delivered, while the relay is healthy.
    const stageOne = () => run.clients.every((c) => c.n >= cfg.send && !c.paused) && run.tracker.c.acked === run.tracker.c.attempted;
    await run.waitFor(stageOne, cfg.timeoutMs);
    await run.waitFor(() => run.tracker.c.delivered === run.tracker.c.acked, cfg.drainTimeoutMs);
    const deliveredStageOne = run.tracker.c.delivered;

    // Stage 2: stop delivery, let a burst pile up, then kill the relay outright.
    for (const client of run.clients) client.paused = true;
    run.drainAgent.destroy(); // closes the parked long-polls; the server drops the waiters
    run.drainAgent = makeAgent(cfg.clients + 64);
    await sleep(250);
    await Promise.allSettled(run.clients.map((c) => c.burstLoop(cfg.burst)));
    await run.waitFor(() => run.tracker.c.acked === run.tracker.c.attempted, cfg.timeoutMs);
    await sleep(150); // let any in-flight drain response land before the census

    const expectedPending = run.tracker.c.acked - run.tracker.c.delivered;
    const beforeKill = await run.stats();
    const killStart = performance.now();
    await run.relay.kill();
    const killedAt = performance.now();

    // Same data directory, fresh process: whatever was accepted must replay.
    await run.startRelay();
    const recoveredAt = performance.now();
    const afterRestart = await run.stats();

    // Stage 3: delivery resumes; everything accepted before the kill must arrive.
    for (const client of run.clients) client.paused = false;
    const allDelivered = await run.waitFor(() => run.tracker.c.delivered === run.tracker.c.acked, cfg.drainTimeoutMs * 2);
    const finished = performance.now();
    const relayAfter = await run.stats();
    run.stopSampling();

    const t = run.tracker;
    const recovered = afterRestart ? afterRestart.pending : null;
    const recoveredMatches = recovered !== null && recovered === expectedPending && beforeKill.pending === expectedPending;
    const zeroLoss = recoveredMatches && allDelivered && t.c.acked === t.c.delivered;

    const summary = run.summary({
      mode: 'chaos',
      durationMs: finished - t0,
      relayBefore: null,
      relayAfter,
      extra: {
        chaos: {
          deliveredStageOne,
          acceptedBeforeKill: t.c.acked,
          pendingAtKill: beforeKill.pending,
          expectedPending,
          recoveredFromLog: recovered,
          recoveredMatchesExpected: recoveredMatches,
          deliveredBeforeKill: deliveredStageOne,
          deliveredAfterRestart: t.c.delivered - deliveredStageOne,
          lost: t.c.acked - t.c.delivered,
          duplicated: t.c.duplicates,
          rssMiBAtKill: beforeKill.rssMiB,
          killToExitMs: Math.round(killedAt - killStart),
          killToReadyMs: Math.round(recoveredAt - killStart),
        },
      },
    });
    const r = summary.run;
    const ch = summary.chaos;

    console.log(`relay chaos: ${cfg.clients.toLocaleString('en-US')} clients, ${r.acked.toLocaleString('en-US')} accepted, SIGKILL mid-backlog`);
    ok('attempted / accepted', `${r.attempted.toLocaleString('en-US')} / ${ch.acceptedBeforeKill.toLocaleString('en-US')} (rejected ${r.rejected}, transport ${r.transportFailed})`);
    ok('delivered before kill', ch.deliveredBeforeKill.toLocaleString('en-US'));
    if (recoveredMatches) {
      ok('pending at kill', `${ch.pendingAtKill.toLocaleString('en-US')} - all recovered from the log on restart`);
    } else {
      fail('pending at kill', `stats said ${ch.pendingAtKill}, expected ${expectedPending}; after restart ${recovered}`);
    }
    if (zeroLoss) {
      ok('zero loss', `all ${r.acked.toLocaleString('en-US')} delivered after restart (${ch.deliveredAfterRestart.toLocaleString('en-US')} in the post-restart phase), 0 duplicated`);
    } else {
      fail('zero loss', `delivered ${r.delivered}/${r.acked}, lost ${ch.lost}, duplicated ${ch.duplicated}`);
    }
    ok('outage window', `kill to listening again ${ch.killToReadyMs} ms`);
    ok('send-to-delivery latency', `p50 ${r.latencyMs[50]} ms, p95 ${r.latencyMs[95]} ms, p99 ${r.latencyMs[99]} ms, max ${r.maxLatencyMs} ms`);
    ok('relay process after restart', `rss ${summary.relay.rssMiB} MiB (peak ${summary.relay.peakRssMiB} MiB), cpu ${summary.relay.cpuUserMsAfter} ms user`);

    const gates = thresholdVerdicts(summary, cfg);
    summary.thresholds = gates;
    const gatesPass = printThresholds(gates);
    writeLoadReport(cfg, summary);
    return { summary, failed: !zeroLoss || r.duplicates !== 0 || !gatesPass };
  } finally {
    run.stopSampling();
    await run.stopAll();
  }
}

// -------------------------------------------------------------------- failover
/**
 * Kill the node mid-backlog and continue on a standby instead of restarting.
 *
 * The fleet is one process (the pause/kill/hand-over beat is coordinated from
 * one event loop). A second relay - the standby - listens from the start on
 * its own data directory: the two nodes share nothing, which is the harsh
 * case for failover. Stages:
 *
 *   1. Normal traffic, fully delivered through the primary.
 *   2. Drains pause; a burst per client piles up on the primary (accepted,
 *      not yet delivered). The census of that backlog is the expected
 *      re-post set: acked minus delivered.
 *   3. The primary is SIGKILLed. The fleet switches its destination to the
 *      standby and re-posts exactly the census set from its client-side
 *      outboxes - the behaviour src/collab/relay.js implements when its node
 *      disappears. Loss is impossible (the ciphertexts are still in the
 *      outbox) and duplication is impossible (only the undelivered set is
 *      re-posted).
 *   4. Deliveries resume on the standby, and fresh post-failover traffic runs
 *      to prove the service kept serving, not just recovering.
 *
 * What this is not: node-to-node replication. The standby has none of the
 * primary's history, so the guarantee is the client outbox's, which is exactly
 * the guarantee the shipped carrier gives. The killed node's own log is still
 * complete for its own restart (that is the --chaos run).
 */
async function failover(cfg) {
  cfg = { ...cfg, shards: 1 };
  const run = new Run(cfg);
  const standbyData = mkdtempSync(join(tmpdir(), 'relay-standby-'));
  let standby = null;
  try {
    await run.startRelay();
    standby = await new Relay({ data: standbyData, extra: [] }).start();
    run.startSampling();
    const t0 = performance.now();
    run.startClients();

    // Stage 1: normal traffic, fully delivered through the primary.
    const stageOne = () => run.clients.every((c) => c.n >= cfg.send && !c.paused) && run.tracker.c.acked === run.tracker.c.attempted;
    await run.waitFor(stageOne, cfg.timeoutMs);
    await run.waitFor(() => run.tracker.c.delivered === run.tracker.c.acked, cfg.drainTimeoutMs);
    const deliveredStageOne = run.tracker.c.delivered;

    // Stage 2: pause drains, pile up a burst on the primary, take the census.
    for (const client of run.clients) client.paused = true;
    run.drainAgent.destroy(); // closes the parked long-polls; the server drops the waiters
    run.drainAgent = makeAgent(cfg.clients + 64);
    await sleep(250);
    await Promise.allSettled(run.clients.map((c) => c.burstLoop(cfg.burst)));
    await run.waitFor(() => run.tracker.c.acked === run.tracker.c.attempted, cfg.timeoutMs);
    await sleep(150); // let any in-flight drain response land before the census

    const pendingKeys = [];
    for (const [key, rec] of run.tracker.records) if (rec.ackedAt && rec.deliveredAt === null) pendingKeys.push(key);
    const expectedPending = run.tracker.c.acked - run.tracker.c.delivered;
    const beforeKill = await run.stats();

    // Stage 3: kill the primary, switch the fleet, re-post the census set.
    const killStart = performance.now();
    run.standbyWatchFrom = nowEpoch();
    await run.relay.kill();
    run.port = standby.port;
    let firstRepostAt = 0;
    const reposts = await Promise.all(
      pendingKeys.map(async (key) => {
        const client = run.clientById.get(key.split('#')[0]);
        const result = client ? await client.repost(key) : { key, ok: false, error: 'unknown client' };
        if (result.ok && !firstRepostAt) firstRepostAt = performance.now();
        return result;
      }),
    );
    const reposted = reposts.filter((r) => r.ok).length;
    const repostFailed = reposts.length - reposted;
    const repostErrors = reposts.filter((r) => !r.ok).slice(0, 3).map((r) => `${r.key}: ${r.error}`);
    const afterRepost = await run.stats();

    // Stage 4: drains resume on the standby - everything pending must arrive -
    // then fresh traffic on the new node.
    for (const client of run.clients) client.paused = false;
    const backlogDelivered = await run.waitFor(() => run.tracker.c.delivered === deliveredStageOne + reposted, cfg.drainTimeoutMs * 2);
    const firstReceiveAt = run.firstStandbyReceiveAt;
    await Promise.allSettled(run.clients.map((c) => c.postFailover(cfg.postSend)));
    const allDone = await run.waitFor(
      () => run.tracker.c.acked === run.tracker.c.attempted && run.tracker.c.delivered === run.tracker.c.acked,
      cfg.drainTimeoutMs * 2,
    );
    const finished = performance.now();
    const relayAfter = await run.stats();
    run.stopSampling();

    const t = run.tracker;
    const postFailoverAcked = t.c.acked - (deliveredStageOne + reposted);
    const acceptedBeforeKill = deliveredStageOne + expectedPending;
    const zeroLoss = t.c.acked === t.c.delivered && t.c.delivered > 0 && allDone;
    const failoverMs = firstRepostAt ? Math.round(firstRepostAt - killStart) : null;
    const drainResumeMs = firstReceiveAt && run.standbyWatchFrom ? Math.round(firstReceiveAt - run.standbyWatchFrom) : null;
    const standbyPending = afterRepost ? afterRepost.pending : null;

    const summary = run.summary({
      mode: 'failover',
      durationMs: finished - t0,
      relayBefore: null,
      relayAfter,
      extra: {
        failover: {
          primaryData: run.relayData,
          standbyPort: standby.port,
          deliveredStageOne,
          acceptedBeforeKill,
          pendingAtKill: beforeKill.pending,
          expectedPending,
          reposted,
          repostFailed,
          repostErrors,
          standbyPendingAfterRepost: standbyPending,
          failoverMs,
          drainResumeMs,
          backlogDelivered,
          postFailoverAcked,
          postFailoverDelivered: t.c.delivered - (deliveredStageOne + reposted),
          lost: t.c.acked - t.c.delivered,
          duplicated: t.c.duplicates,
        },
      },
    });
    const r = summary.run;
    const f = summary.failover;
    // Two processes by design; the run's own conditions string must not read
    // "one relay process" like the single-node modes do.
    summary.conditions.transport = 'loopback http/1.1, keep-alive, two relay processes (primary + standby, separate data dirs), no TLS';

    console.log(`relay failover: ${cfg.clients.toLocaleString('en-US')} clients, ${r.acked.toLocaleString('en-US')} accepted, primary SIGKILLed mid-backlog, standby continues`);
    ok('accepted before kill', `${acceptedBeforeKill.toLocaleString('en-US')} (delivered ${deliveredStageOne.toLocaleString('en-US')}, pending ${expectedPending.toLocaleString('en-US')})`);
    if (reposted === expectedPending && pendingKeys.length === expectedPending && repostFailed === 0) {
      ok('re-posted to standby', `${reposted.toLocaleString('en-US')} / ${expectedPending.toLocaleString('en-US')} from client outboxes, 0 failed`);
    } else {
      fail('re-posted to standby', `${reposted}/${expectedPending} (census ${pendingKeys.length}, failed ${repostFailed}${repostErrors.length ? `; ${repostErrors.join('; ')}` : ''})`);
    }
    if (standbyPending === reposted) {
      ok('standby backlog', `${standbyPending.toLocaleString('en-US')} accepted, matches the re-post set`);
    } else {
      fail('standby backlog', `standby reports ${standbyPending}, re-posted ${reposted}`);
    }
    if (zeroLoss && backlogDelivered) {
      ok('zero loss', `all ${r.acked.toLocaleString('en-US')} delivered (${f.postFailoverDelivered.toLocaleString('en-US')} re-posted or new on the standby), 0 lost, 0 duplicated`);
    } else {
      fail('zero loss', `delivered ${r.delivered}/${r.acked}, lost ${f.lost}, duplicated ${f.duplicated}, backlogDelivered ${backlogDelivered}`);
    }
    ok('failover window', `kill to first accepted post ${failoverMs} ms, kill to first delivery ${drainResumeMs} ms (standby listening throughout)`);
    ok('post-failover traffic', `${postFailoverAcked.toLocaleString('en-US')} new envelopes accepted and delivered by the standby`);
    ok('send-to-delivery latency', `p50 ${r.latencyMs[50]} ms, p95 ${r.latencyMs[95]} ms, p99 ${r.latencyMs[99]} ms, max ${r.maxLatencyMs} ms`);
    ok('standby process', `rss ${summary.relay.rssMiB} MiB (peak ${summary.relay.peakRssMiB} MiB), cpu ${summary.relay.cpuUserMsAfter} ms user`);

    const gates = thresholdVerdicts(summary, cfg);
    summary.thresholds = gates;
    const gatesPass = printThresholds(gates);
    writeLoadReport(cfg, summary);
    return {
      summary,
      failed: !zeroLoss || !backlogDelivered || r.duplicates !== 0 || repostFailed !== 0 || !gatesPass,
    };
  } finally {
    run.stopSampling();
    await run.stopAll();
    if (standby) await standby.kill();
    rmSync(standbyData, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------- self-check
async function selfCheck(cfg) {
  const assert = (await import('node:assert/strict')).default;
  let passed = 0;
  let failedCount = 0;
  const check = async (label, fn) => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok   ${label}`);
    } catch (err) {
      failedCount += 1;
      console.log(`  FAIL ${label}\n       ${err && err.message}`);
    }
  };

  const tmpBase = mkdtempSync(join(tmpdir(), 'relay-check-'));
  const relays = [];
  const spawnRelay = async (data, extra = []) => {
    const relay = await new Relay({ data, extra }).start();
    relays.push(relay);
    return relay;
  };
  const agent = makeAgent(32);
  try {
    const data = join(tmpBase, 'main');
    const relay = await spawnRelay(data);
    const j = (method, path, body, timeoutMs) => request(agent, relay.port, method, path, body, timeoutMs);

    await check('round trip with header', async () => {
      const post = await j('POST', '/relay/post', { from: 'alice', to: 'bob', header: { dh: 'abc', n: 1 }, ct: 'CT-ROUNDTRIP' });
      assert.equal(post.status, 200);
      const drain = await j('GET', '/relay/drain?peer=bob');
      assert.equal(drain.json.envelopes.length, 1);
      const env = drain.json.envelopes[0];
      assert.equal(env.ct, 'CT-ROUNDTRIP');
      assert.equal(env.from, 'alice');
      assert.deepEqual(env.header, { dh: 'abc', n: 1 });
      assert.equal(typeof env.relayedAt, 'number');
      const again = await j('GET', '/relay/drain?peer=bob');
      assert.equal(again.json.envelopes.length, 0);
    });

    await check('long-poll wakes on post', async () => {
      const started = performance.now();
      const drainPromise = j('GET', '/relay/drain?peer=carol&wait=5', undefined, 8000);
      await sleep(150);
      await j('POST', '/relay/post', { from: 'alice', to: 'carol', ct: 'CT-LONGPOLL' });
      const drain = await drainPromise;
      const elapsed = performance.now() - started;
      assert.equal(drain.json.envelopes.length, 1);
      assert.equal(drain.json.envelopes[0].ct, 'CT-LONGPOLL');
      assert.ok(elapsed < 3000, `long-poll took ${Math.round(elapsed)} ms`);
    });

    await check('broadcast once per peer', async () => {
      await j('POST', '/relay/post', { from: 'alice', to: '*', ct: 'CT-BCAST' });
      const bob = await j('GET', '/relay/drain?peer=bob');
      const eve = await j('GET', '/relay/drain?peer=eve');
      assert.ok(bob.json.envelopes.some((e) => e.ct === 'CT-BCAST'));
      assert.ok(eve.json.envelopes.some((e) => e.ct === 'CT-BCAST'));
      const bobAgain = await j('GET', '/relay/drain?peer=bob');
      assert.ok(!bobAgain.json.envelopes.some((e) => e.ct === 'CT-BCAST'), 'broadcast redelivered');
    });

    await check('inspect sees no plaintext', async () => {
      const marker = `PLAINTEXT-${randomBytes(6).toString('hex')}`;
      await j('POST', '/relay/post', { from: 'alice', to: 'frank', ct: marker });
      const inspect = await j('GET', '/relay/inspect');
      assert.ok(!JSON.stringify(inspect.json).includes(marker), 'inspect leaked ciphertext contents');
      const entry = inspect.json.sample.find((s) => s.to === 'frank');
      assert.ok(entry, 'the pending envelope is not listed');
      assert.equal(entry.hasCiphertext, true);
      assert.ok(entry.visibleFields.includes('ct'));
      assert.ok(entry.visibleFields.includes('to'));
      await j('GET', '/relay/drain?peer=frank');
    });

    await check('validation and size caps', async () => {
      const bad = await j('POST', '/relay/post', { from: 'bad sender', to: 'bob', ct: 'x' });
      assert.equal(bad.status, 400);
      const empty = await j('POST', '/relay/post');
      assert.equal(empty.status, 400, `empty body should be 400, got ${empty.status}`);
      const big = await j('POST', '/relay/post', { from: 'alice', to: 'bob', ct: 'x'.repeat(70000) });
      assert.equal(big.status, 413, `expected 413, got ${big.status}`);
    });

    await check('per-mailbox queue cap', async () => {
      const tiny = await spawnRelay(join(tmpBase, 'tiny'), ['--max-queue=3']);
      for (let i = 0; i < 3; i += 1) {
        const r = await request(agent, tiny.port, 'POST', '/relay/post', { from: 'alice', to: 'bob', ct: `CT-${i}` });
        assert.equal(r.status, 200);
      }
      const full = await request(agent, tiny.port, 'POST', '/relay/post', { from: 'alice', to: 'bob', ct: 'CT-4' });
      assert.equal(full.status, 429);
      await tiny.kill();
    });

    await check('token auth', async () => {
      const guarded = await spawnRelay(join(tmpBase, 'auth'), ['--token=sesame']);
      const denied = await request(agent, guarded.port, 'POST', '/relay/post', { from: 'alice', to: 'bob', ct: 'x' });
      assert.equal(denied.status, 401);
      const allowed = await request(agent, guarded.port, 'POST', '/relay/post', { from: 'alice', to: 'bob', ct: 'x' }, 5000, {
        authorization: 'Bearer sesame',
      });
      assert.equal(allowed.status, 200);
      await guarded.kill();
    });

    await check('stats reflect traffic', async () => {
      const s = await statsOf(agent, relay.port);
      assert.ok(s, 'no stats');
      assert.ok(s.posts >= 4, `posts ${s.posts}`);
      assert.ok(s.deliveries >= 5, `deliveries ${s.deliveries}`);
      assert.ok(s.rejected.bad >= 2, `rejected.bad ${s.rejected.bad}`);
      assert.ok(typeof s.rssMiB === 'number' && s.rssMiB > 0);
    });

    await check('durability across SIGKILL', async () => {
      for (let i = 0; i < 20; i += 1) {
        const r = await j('POST', '/relay/post', { from: 'alice', to: 'dave', ct: `CT-DUR-${i}` });
        assert.equal(r.status, 200);
      }
      await j('POST', '/relay/post', { from: 'alice', to: 'erin', ct: 'CT-DELIVERED' });
      const erin = await j('GET', '/relay/drain?peer=erin');
      assert.ok(
        erin.json.envelopes.some((e) => e.ct === 'CT-DELIVERED'),
        'the direct envelope did not arrive',
      );

      const before = await j('GET', '/relay/stats');
      assert.equal(before.json.pending, 20, `expected 20 pending before the kill, saw ${before.json.pending}`);
      await relay.kill();
      const restarted = await spawnRelay(data);
      const after = await statsOf(agent, restarted.port);
      assert.equal(after.pending, 20, `expected 20 pending after restart, saw ${after.pending}`);
      assert.equal(after.restarts, 2, `expected restarts=2, saw ${after.restarts}`);
      const drained = await request(agent, restarted.port, 'GET', '/relay/drain?peer=dave');
      const dur = drained.json.envelopes.filter((e) => e.ct.startsWith('CT-DUR-'));
      assert.equal(dur.length, 20, `expected the 20 accepted envelopes after restart, saw ${dur.length}`);
      const daveAgain = await request(agent, restarted.port, 'GET', '/relay/drain?peer=dave');
      assert.equal(daveAgain.json.envelopes.length, 0);
      const erinAfter = await request(agent, restarted.port, 'GET', '/relay/drain?peer=erin');
      assert.ok(!erinAfter.json.envelopes.some((e) => e.ct === 'CT-DELIVERED'), 'a delivered envelope came back after restart');
      const finalStats = await statsOf(agent, restarted.port);
      assert.equal(finalStats.pending, 0, `expected an empty backlog at the end, saw ${finalStats.pending}`);
    });

    await check('thresholds fail a run that misses them', async () => {
      const options = { p95Max: 200, p99Max: 500, lossMax: 0, dupMax: 0, failoverMax: 2000 };
      const breach = thresholdVerdicts({ run: { latencyMs: { 50: 5, 95: 250, 99: 900 }, lost: 3, duplicates: 0 } }, options);
      assert.equal(breach.find((r) => r.metric === 'latency p95').ok, false);
      assert.equal(breach.find((r) => r.metric === 'latency p99').ok, false);
      assert.equal(breach.find((r) => r.metric === 'envelopes lost').ok, false);
      assert.equal(breach.find((r) => r.metric === 'envelopes duplicated').ok, true);
      const clean = thresholdVerdicts({ run: { latencyMs: { 50: 4, 95: 12, 99: 30 }, lost: 0, duplicates: 0 } }, options);
      assert.ok(clean.length >= 4 && clean.every((r) => r.ok));
      // Without --p99-max, a long p99 is reported (it is in every artifact) but
      // must not gate: the brief's bar is a p95 bar.
      const defaultGates = thresholdVerdicts(
        { run: { latencyMs: { 50: 4, 95: 12, 99: 649 }, lost: 0, duplicates: 0 } },
        { p95Max: 200, p99Max: null, lossMax: 0, dupMax: 0 },
      );
      assert.equal(defaultGates.find((r) => r.metric === 'latency p99'), undefined, 'p99 is reported, not gated, unless --p99-max is given');
      assert.ok(defaultGates.every((r) => r.ok), 'a 649 ms p99 under a 12 ms p95 is a pass on the brief\u2019s bar');
      const slowFailover = thresholdVerdicts(
        { run: { latencyMs: { 50: 4, 95: 12, 99: 30 }, lost: 0, duplicates: 0 }, failover: { failoverMs: 2500 } },
        options,
      );
      assert.equal(slowFailover.find((r) => r.metric === 'kill to failover').ok, false);
      const fastFailover = thresholdVerdicts(
        { run: { latencyMs: { 50: 4, 95: 12, 99: 30 }, lost: 0, duplicates: 0 }, failover: { failoverMs: 120 } },
        options,
      );
      assert.equal(fastFailover.find((r) => r.metric === 'kill to failover').ok, true);
    });
  } finally {
    agent.destroy();
    for (const relay of relays) await relay.kill();
    if (!cfg.keep) rmSync(tmpBase, { recursive: true, force: true });
  }

  console.log(`\nrelay self-check: ${passed}/${passed + failedCount} ok`);
  return failedCount === 0;
}

// ----------------------------------------------------------------------- main
const main = async () => {
  if (cfg.selfCheck) {
    const okRun = await selfCheck(cfg);
    process.exitCode = okRun ? 0 : 1;
    return;
  }
  if (cfg.generate) {
    const okShard = await generateShard(cfg);
    process.exitCode = okShard ? 0 : 1;
    return;
  }
  if (cfg.chaos) {
    const { failed } = await chaos(cfg);
    process.exitCode = failed ? 1 : 0;
    return;
  }
  if (cfg.failover) {
    const { failed } = await failover(cfg);
    process.exitCode = failed ? 1 : 0;
    return;
  }
  const { failed } = cfg.shards > 1 ? await measureSharded(cfg) : await measure(cfg);
  process.exitCode = failed ? 1 : 0;
};

main().catch((err) => {
  console.error('load-relay: fatal', err);
  process.exitCode = 1;
});
