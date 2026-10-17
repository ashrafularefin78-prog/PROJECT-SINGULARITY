/**
 * M5's untrusted relay, as an actual small server.
 *
 *   node tools/relay.js [--port=8890] [--host=127.0.0.1] [--data=.tools/relay-data]
 *                       [--token=<secret>] [--max-ct=65536] [--max-queue=20000]
 *                       [--max-pending=200000] [--max-broadcast=1000]
 *                       [--compact-mb=32] [--fsync] [--verbose] [--help]
 *
 * The browser app carries an in-memory CiphertextRelay (src/collab/mesh.js):
 * it stores and forwards opaque envelopes and is structurally unable to read
 * them. This is the same contract, same envelope shape, in front of a durable
 * append-only log, so a deployment can move signaling and document envelopes
 * between machines with no plaintext anywhere in the middle:
 *
 *   POST /relay/post    { to, from, header?, ct }      -> { ok, seq }
 *   GET  /relay/drain   ?peer=<id>&wait=<seconds>      -> { ok, envelopes: [...] }
 *   GET  /relay/inspect                                -> what the relay can read
 *   GET  /relay/stats                                  -> counters + memory
 *
 * The rules, chosen to be the weakest useful set:
 *
 *   - Only the contract crosses the boundary. `to` and `from` are validated as
 *     routing ids, `ct` is an opaque string under a size cap, `header` an
 *     opaque object under a size cap. Anything else in the body is dropped,
 *     not stored: the server has no field it could read a message from.
 *   - Store-and-forward, at-least-once. A drain response removes exactly what
 *     it returns, and both the post and the removal are written to the log
 *     before either side is answered. A crash between a log write and an HTTP
 *     response can therefore duplicate an envelope but never lose one;
 *     receivers dedupe, the way the app's ratchet and CRDT already do for
 *     out-of-order delivery.
 *   - Long-poll drains (`wait`): an idle client costs one open request instead
 *     of one request per poll interval. tools/load-relay.js drives this path.
 *   - `to: "*"` is a broadcast: it is delivered once to every peer that drains,
 *     with the per-peer delivery marks in the same log.
 *
 * Durability is against process death, not power loss: every accepted post is
 * written through the OS page cache before the 200 goes out, which is what the
 * kill-the-relay chaos run in tools/load-relay.js exercises. `--fsync` makes
 * writes power-loss durable at a large throughput cost.
 *
 * No dependencies beyond Node's `http`. Kept standalone (its own argument
 * parser, same shape as tools/cdp.js's) so the relay can be deployed as a
 * single file next to any static host.
 */
import { createServer } from 'node:http';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const VERSION = 'relay-1';
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_HEADER_BYTES = 4096;
const MAX_WAIT_S = 20;

function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    else out._.push(arg);
  }
  return out;
}

const num = (value, fallback) => {
  if (typeof value !== 'string') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

// ------------------------------------------------------------------- config
const args = parseArgs();
if (args.help) {
  console.log(`usage: node tools/relay.js [--port=8890] [--host=127.0.0.1] [--data=<dir>]
                           [--token=<secret>] [--max-ct=65536] [--max-queue=20000]
                           [--max-pending=200000] [--max-broadcast=1000]
                           [--compact-mb=32] [--fsync] [--verbose]`);
  process.exit(0);
}

const config = {
  host: args.host || '127.0.0.1',
  port: num(args.port, 8890),
  data: typeof args.data === 'string' && args.data ? args.data : '.tools/relay-data',
  token: typeof args.token === 'string' && args.token ? args.token : null,
  maxCt: num(args['max-ct'], 65536),
  maxQueue: num(args['max-queue'], 20000),
  maxPending: num(args['max-pending'], 200000),
  maxBroadcast: num(args['max-broadcast'], 1000),
  compactBytes: num(args['compact-mb'], 32) * 1024 * 1024,
  fsync: Boolean(args.fsync),
  verbose: Boolean(args.verbose),
};

mkdirSync(config.data, { recursive: true });
const logPath = join(config.data, 'relay.log');

// -------------------------------------------------------------------- state
let seq = 0;
/** @type {Map<string, Map<number, object>>} peer -> seq -> stored record */
const pendingDirect = new Map();
/** @type {Map<number, { record: object, delivered: Set<string> }>} */
const broadcasts = new Map();
let pendingCount = 0;
const waiters = new Map(); // peer -> Set<waiter entry>
const stats = {
  posts: 0,
  deliveries: 0,
  rejected: { bad: 0, large: 0, queueFull: 0, overflow: 0, broadcastsFull: 0, auth: 0 },
  drains: 0,
  longPolls: 0,
  restarts: 1,
};

let fd = null;
let writtenBytes = 0;

function postRecord(rec) {
  const out = { t: 'post', seq: rec.seq, to: rec.to, from: rec.from, ct: rec.ct, relayedAt: rec.relayedAt };
  if (rec.header !== undefined) out.header = rec.header;
  return out;
}

function append(record) {
  const line = `${JSON.stringify(record)}\n`;
  writeSync(fd, line);
  if (config.fsync) fsyncSync(fd);
  writtenBytes += Buffer.byteLength(line);
}

// ------------------------------------------------------------------ log I/O
function replay() {
  if (!existsSync(logPath)) return;
  const text = readFileSync(logPath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // A torn last line can only come from a process killed mid-write, which
      // means the post it belonged to was never acked; skipping it loses
      // nothing that was promised.
      continue;
    }
    seq = Math.max(seq, num(String(rec.seq ?? ''), 0));
    if (rec.t === 'post') {
      if (rec.to === '*') {
        broadcasts.set(rec.seq, { record: rec, delivered: new Set() });
      } else {
        if (!pendingDirect.has(rec.to)) pendingDirect.set(rec.to, new Map());
        pendingDirect.get(rec.to).set(rec.seq, rec);
        pendingCount += 1;
      }
    } else if (rec.t === 'deliver') {
      const b = broadcasts.get(rec.seq);
      if (b) b.delivered.add(rec.peer);
      const map = pendingDirect.get(rec.peer);
      if (map && map.delete(rec.seq)) pendingCount -= 1;
    } else if (rec.t === 'boot') {
      stats.restarts += 1;
    }
  }
}

/**
 * Rewrite the log with only what is still pending. Synchronous, and therefore
 * atomic with respect to request handling (Node runs one handler at a time),
 * so the close/rename/reopen below cannot race a post.
 */
function compact() {
  const lines = [];
  for (const map of pendingDirect.values()) {
    for (const rec of map.values()) lines.push(JSON.stringify(postRecord(rec)));
  }
  for (const b of broadcasts.values()) {
    lines.push(JSON.stringify(postRecord(b.record)));
    for (const peer of b.delivered) lines.push(JSON.stringify({ t: 'deliver', seq: b.record.seq, peer }));
  }
  const tmp = `${logPath}.tmp`;
  const wasOpen = fd !== null;
  if (wasOpen) closeSync(fd);
  writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '');
  renameSync(tmp, logPath);
  if (wasOpen) fd = openSync(logPath, 'a');
  writtenBytes = existsSync(logPath) ? statSync(logPath).size : 0;
}

function maybeCompact() {
  if (writtenBytes > config.compactBytes) compact();
}

// ------------------------------------------------------------------ delivery
function takeFor(peer) {
  const out = [];
  const map = pendingDirect.get(peer);
  if (map && map.size) {
    for (const rec of map.values()) {
      out.push(rec);
      append({ t: 'deliver', seq: rec.seq, peer });
      stats.deliveries += 1;
      pendingCount -= 1;
    }
    pendingDirect.delete(peer);
  }
  for (const b of broadcasts.values()) {
    if (!b.delivered.has(peer)) {
      b.delivered.add(peer);
      out.push(b.record);
      append({ t: 'deliver', seq: b.record.seq, peer });
      stats.deliveries += 1;
    }
  }
  if (out.length) {
    maybeCompact();
    return out.map((rec) => {
      const env = { to: rec.to, from: rec.from, ct: rec.ct, relayedAt: rec.relayedAt };
      if (rec.header !== undefined) env.header = rec.header;
      return env;
    });
  }
  return out;
}

function removeWaiter(peer, entry) {
  const set = waiters.get(peer);
  if (!set) return;
  set.delete(entry);
  if (!set.size) waiters.delete(peer);
}

function respondWaiter(entry, status, payload) {
  clearTimeout(entry.timer);
  removeWaiter(entry.peer, entry);
  if (!entry.res.writableEnded) sendJson(entry.res, status, payload);
}

/** Serve the first waiter for `peer` if anything is deliverable for it. */
function flushWaiter(peer) {
  const set = waiters.get(peer);
  if (!set) return;
  for (const entry of [...set]) {
    const envelopes = takeFor(peer);
    if (envelopes.length) {
      respondWaiter(entry, 200, { ok: true, envelopes });
      return;
    }
  }
}

function flushEveryone() {
  for (const peer of [...waiters.keys()]) flushWaiter(peer);
}

// -------------------------------------------------------------------- HTTP
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function authorized(req) {
  if (!config.token) return true;
  return req.headers.authorization === `Bearer ${config.token}`;
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > cap) {
        over = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) reject(Object.assign(new Error(`body exceeds ${cap} bytes`), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function validateEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  if (typeof body.from !== 'string' || !ID_RE.test(body.from)) return { error: 'from must match [A-Za-z0-9._-]{1,64}' };
  if (typeof body.to !== 'string' || (body.to !== '*' && !ID_RE.test(body.to))) {
    return { error: 'to must match [A-Za-z0-9._-]{1,64} or be "*"' };
  }
  if (typeof body.ct !== 'string' || body.ct.length === 0) return { error: 'ct must be a non-empty string' };
  if (Buffer.byteLength(body.ct, 'utf8') > config.maxCt) {
    return { error: `ct exceeds --max-ct (${config.maxCt} bytes)`, status: 413 };
  }
  if (body.header !== undefined) {
    if (typeof body.header !== 'object' || body.header === null || Array.isArray(body.header)) {
      return { error: 'header must be a JSON object when present' };
    }
    if (Buffer.byteLength(JSON.stringify(body.header), 'utf8') > MAX_HEADER_BYTES) {
      return { error: `header exceeds ${MAX_HEADER_BYTES} bytes`, status: 413 };
    }
  }
  return { ok: true };
}

function postEnvelope(body) {
  const check = validateEnvelope(body);
  if (!check.ok) {
    stats.rejected[check.status === 413 ? 'large' : 'bad'] += 1;
    return { status: check.status || 400, payload: { ok: false, error: check.error } };
  }
  if (pendingCount >= config.maxPending) {
    stats.rejected.overflow += 1;
    return { status: 503, payload: { ok: false, error: 'relay backlog is full' } };
  }
  if (body.to === '*' && broadcasts.size >= config.maxBroadcast) {
    stats.rejected.broadcastsFull += 1;
    return { status: 429, payload: { ok: false, error: 'too many live broadcasts' } };
  }
  if (body.to !== '*') {
    const map = pendingDirect.get(body.to);
    if (map && map.size >= config.maxQueue) {
      stats.rejected.queueFull += 1;
      return { status: 429, payload: { ok: false, error: `mailbox for ${body.to} is full` } };
    }
  }
  seq += 1;
  const rec = { seq, to: body.to, from: body.from, ct: body.ct, relayedAt: Date.now() };
  if (body.header !== undefined) rec.header = body.header;
  if (rec.to === '*') {
    broadcasts.set(rec.seq, { record: rec, delivered: new Set() });
  } else {
    if (!pendingDirect.has(rec.to)) pendingDirect.set(rec.to, new Map());
    pendingDirect.get(rec.to).set(rec.seq, rec);
    pendingCount += 1;
  }
  append(postRecord(rec));
  stats.posts += 1;
  maybeCompact();
  if (config.verbose) console.log(`post ${rec.seq} ${rec.from} -> ${rec.to} (${Buffer.byteLength(rec.ct)} B ct)`);
  return {
    status: 200,
    payload: { ok: true, seq: rec.seq, queued: pendingCount },
    wake: rec.to,
    broadcast: rec.to === '*',
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'relay'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/' && req.method === 'GET') {
    const body = [
      `singularity relay ${VERSION} - store-and-forward for { to, from, header, ct }`,
      '',
      '  POST /relay/post     { to, from, header?, ct }  -> { ok, seq }',
      '  GET  /relay/drain    ?peer=<id>&wait=<seconds>  -> { ok, envelopes }',
      '  GET  /relay/inspect                              -> what this server can read',
      '  GET  /relay/stats                                -> counters + memory',
      '',
      'This process holds routing metadata and opaque ciphertext; it has no key material.',
      '',
    ].join('\n');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }

  if (path.startsWith('/relay/') && !authorized(req)) {
    stats.rejected.auth += 1;
    sendJson(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }

  if (path === '/relay/post' && req.method === 'POST') {
    let text;
    try {
      text = await readBody(req, config.maxCt + 8192);
    } catch (err) {
      stats.rejected.large += 1;
      if (!res.headersSent) sendJson(res, err.status || 400, { ok: false, error: err.message });
      return;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      stats.rejected.bad += 1;
      sendJson(res, 400, { ok: false, error: 'body is not JSON' });
      return;
    }
    const result = postEnvelope(body);
    sendJson(res, result.status, result.payload);
    if (result.wake) {
      if (result.broadcast) flushEveryone();
      else flushWaiter(result.wake);
    }
    return;
  }

  if (path === '/relay/drain' && req.method === 'GET') {
    const peer = url.searchParams.get('peer');
    if (!peer || !ID_RE.test(peer)) {
      sendJson(res, 400, { ok: false, error: 'peer must match [A-Za-z0-9._-]{1,64}' });
      return;
    }
    const wait = Math.min(MAX_WAIT_S, Math.max(0, num(url.searchParams.get('wait'), 0)));
    stats.drains += 1;
    const envelopes = takeFor(peer);
    if (envelopes.length) {
      sendJson(res, 200, { ok: true, envelopes });
      return;
    }
    if (wait <= 0) {
      sendJson(res, 200, { ok: true, envelopes: [] });
      return;
    }
    stats.longPolls += 1;
    const entry = { peer, res };
    entry.timer = setTimeout(() => respondWaiter(entry, 200, { ok: true, envelopes: [] }), wait * 1000);
    if (!waiters.has(peer)) waiters.set(peer, new Set());
    waiters.get(peer).add(entry);
    req.on('close', () => {
      if (waiters.has(peer) && waiters.get(peer).has(entry)) {
        clearTimeout(entry.timer);
        removeWaiter(peer, entry);
      }
    });
    return;
  }

  if (path === '/relay/inspect' && req.method === 'GET') {
    const sample = [];
    outer: for (const map of pendingDirect.values()) {
      for (const rec of map.values()) {
        sample.push({
          to: rec.to,
          from: rec.from,
          seq: rec.seq,
          hasCiphertext: typeof rec.ct === 'string',
          ctBytes: Buffer.byteLength(rec.ct, 'utf8'),
          headerBytes: rec.header === undefined ? 0 : Buffer.byteLength(JSON.stringify(rec.header), 'utf8'),
          visibleFields: Object.keys(postRecord(rec)),
        });
        if (sample.length >= 100) break outer;
      }
    }
    sendJson(res, 200, {
      ok: true,
      pending: pendingCount + broadcasts.size,
      pendingDirect: pendingCount,
      broadcasts: broadcasts.size,
      sample,
    });
    return;
  }

  if (path === '/relay/stats' && req.method === 'GET') {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      uptimeMs: Math.round(process.uptime() * 1000),
      posts: stats.posts,
      deliveries: stats.deliveries,
      rejected: stats.rejected,
      drains: stats.drains,
      longPolls: stats.longPolls,
      restarts: stats.restarts,
      pending: pendingCount,
      broadcasts: broadcasts.size,
      peers: pendingDirect.size,
      rssMiB: Math.round((mem.rss / 1048576) * 10) / 10,
      heapUsedMiB: Math.round((mem.heapUsed / 1048576) * 10) / 10,
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: `no route for ${req.method} ${path}` });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('relay: handler failed', err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
  });
});

// Load clients park hundreds of kept-alive sockets against this server. The
// default 5 s idle timeout closes them exactly while a client is about to
// reuse one - visible as 'socket hang up' on the POST side. Keep idle sockets
// open far past any run; headersTimeout must stay the larger of the two.
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

function shutdown(reason) {
  console.log(`relay: ${reason}, closing`);
  for (const set of waiters.values()) {
    for (const entry of [...set]) respondWaiter(entry, 503, { ok: false, error: 'shutting down' });
  }
  server.close(() => {
    if (fd !== null) closeSync(fd);
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --------------------------------------------------------------------- boot
replay();
fd = openSync(logPath, 'a');
compact();
append({ t: 'boot', at: Date.now() });

server.listen({ port: config.port, host: config.host, backlog: 4096 }, () => {
  const addr = server.address();
  console.log(
    `relay listening on http://${config.host}:${addr.port} ` +
      `(log ${logPath}, ct <= ${config.maxCt} B, token ${config.token ? 'required' : 'none'})`,
  );
});
