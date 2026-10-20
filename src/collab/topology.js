/**
 * M5 - topology policy for a room.
 *
 * The brief asks for a hybrid: a full mesh while a room is small, and a relayed
 * tree once it is not. This module is the policy half of that: a deterministic
 * planner that every peer computes from the same sorted peer list, so the room
 * agrees on the shape without a coordinator.
 *
 * Determinism matters more than optimality here. Any peer can be the root
 * (the lowest id wins), every peer computes the same parent and children, and
 * no message is needed to elect anything. The planner is pure, which is also
 * why it can be tested exhaustively in Node.
 *
 * It is deliberately honest about its scope: `mode: 'tree'` describes the
 * forwarding plan, not a change to the WebRTC signalling. Links are still
 * opened by the copy-paste invite flow; a peer that is not a tree neighbour
 * simply does not forward traffic for the room.
 */

/**
 * @param {string[]} ids      peer ids in the room, including this one
 * @param {{meshLimit?: number, fanout?: number}} [options]
 * @returns {{mode: 'mesh'|'tree', root: string|null, order: string[],
 *            parent: Map<string,string|null>, children: Map<string,string[]>,
 *            depth: Map<string,number>}}
 */
export function planTopology(ids, options = {}) {
  const meshLimit = options.meshLimit ?? 6;
  const fanout = Math.max(1, options.fanout ?? 4);
  if (!Number.isInteger(meshLimit) || meshLimit < 1) throw new Error('meshLimit must be a positive integer');
  const order = [...new Set((ids || []).map(String))].sort();
  if (!order.length) throw new Error('a topology needs at least one peer');
  if (order.length <= meshLimit) {
    return {
      mode: 'mesh',
      root: null,
      order,
      parent: new Map(order.map((id) => [id, null])),
      children: new Map(order.map((id) => [id, []])),
      depth: new Map(order.map((id) => [id, 0])),
    };
  }

  const root = order[0];
  const parent = new Map([[root, null]]);
  const children = new Map([[root, []]]);
  const depth = new Map([[root, 0]]);
  const queue = [root];
  let next = 1;
  while (next < order.length && queue.length) {
    const node = queue.shift();
    const kids = [];
    while (next < order.length && kids.length < fanout) {
      const child = order[next++];
      parent.set(child, node);
      children.set(child, []);
      depth.set(child, (depth.get(node) || 0) + 1);
      kids.push(child);
      queue.push(child);
    }
    children.set(node, kids);
  }
  if (parent.size !== order.length) throw new Error('topology planner left peers unconnected');
  return { mode: 'tree', root, order, parent, children, depth };
}

/** Everyone a peer exchanges room traffic with directly. */
export function neighbors(plan, id) {
  if (plan.mode === 'mesh') return plan.order.filter((peer) => peer !== id);
  const up = plan.parent.get(id);
  return [...(up ? [up] : []), ...(plan.children.get(id) || [])];
}

/**
 * Who to forward a frame to, given who it came from. In mesh mode that is
 * everyone else; in tree mode it is every neighbour except the sender, which is
 * what makes tree flooding loop-free without a hop counter.
 */
export function forwardTargets(plan, selfId, fromId = null) {
  return neighbors(plan, selfId).filter((id) => id !== fromId);
}

/** A short, stable description for the UI and the logs. */
export function describeTopology(plan) {
  if (plan.mode === 'mesh') return `mesh · ${plan.order.length} peers, every pair connected`;
  const maxDepth = Math.max(...plan.depth.values());
  return `relayed tree · ${plan.order.length} peers, root ${plan.root}, depth ${maxDepth}, fan-out ≤ ${Math.max(1, ...[...plan.children.values()].map((c) => c.length))}`;
}
