/**
 * The deck: the futuristic layer around the eight modules.
 *
 * Everything here is either a *readout* (the activity waveform, the ticker, the
 * dial's labels - all driven by real measurements or real state) or *chrome*
 * (frame corners, the attitude rail, the boot scan, the warp wipe). The chrome
 * is decorative, pointer-inert and hidden from assistive technology, and it is
 * switched off wholesale by M7's "Visual effects" control, which is why nothing
 * load-bearing lives in this file.
 *
 * Two rules from the rest of the codebase apply here and shape every line:
 *   - no markup sinks: DOM is built with `el()`/`createElement`, never innerHTML;
 *   - no inline styles: the CSP forbids style attributes, so every visual
 *     variation is a class or a data attribute, and every SVG geometry value is
 *     a presentation attribute (which the CSP does not govern).
 */
import { el, clear } from '../security/policy.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const svg = (tag, props = {}, children = []) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') node.textContent = value;
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) if (child) node.appendChild(child);
  return node;
};

const motionIsReduced = () => document.documentElement.dataset.motion === 'reduced';

// ---------------------------------------------------------------- waveform

const WAVE_SAMPLES = 64;

/**
 * A rolling plot of one real metric. It prefers the 3D frame rate while the
 * engine is running (that is the number the brief scores) and falls back to
 * document operations per second, which is always meaningful: it is the CRDT
 * doing work.
 */
function createWaveform() {
  const width = 260;
  const height = 34;
  const label = el('b', { class: 'deck-label', text: 'DOC OPS · 1 S' });
  const value = el('i', { class: 'deck-value', text: '0/s' });
  const grid = [];
  for (let i = 1; i < 4; i += 1) {
    const y = (height / 4) * i;
    grid.push(svg('line', { class: 'wave-grid', x1: 0, y1: y.toFixed(1), x2: width, y2: y.toFixed(1) }));
  }
  const line = svg('polyline', { class: 'wave-line', points: '' });
  const area = svg('path', { class: 'wave-area', d: '' });
  const cursor = svg('line', { class: 'wave-cursor', x1: width, y1: 0, x2: width, y2: height });
  const node = svg(
    'svg',
    {
      class: 'wave',
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': 'Live activity waveform',
    },
    [...grid, area, line, cursor],
  );

  const samples = [];
  let peak = 1;

  return {
    node,
    label,
    value,
    /** Push one reading. `fps` may be null when no renderer is running. */
    push(reading) {
      const isFps = Number.isFinite(reading.fps) && reading.fps > 0;
      samples.push(isFps ? reading.fps : reading.opsDelta);
      if (samples.length > WAVE_SAMPLES) samples.shift();
      peak = Math.max(isFps ? 60 : 1, ...samples);
      const step = width / Math.max(1, WAVE_SAMPLES - 1);
      const points = [];
      for (let i = 0; i < samples.length; i += 1) {
        const x = (width - (samples.length - 1 - i) * step).toFixed(2);
        const y = (height - (Math.min(samples[i], peak) / peak) * (height - 2) - 1).toFixed(2);
        points.push(`${x},${y}`);
      }
      line.setAttribute('points', points.join(' '));
      area.setAttribute(
        'd',
        points.length ? `M${points[0].split(',')[0]},${height} L${points.join(' L')} L${points[points.length - 1].split(',')[0]},${height} Z` : '',
      );
      label.textContent = isFps ? 'FRAME RATE · 1 S' : 'DOC OPS · 1 S';
      value.textContent = isFps ? `${Math.round(reading.fps)} fps` : `${reading.opsDelta}/s`;
    },
  };
}

// ------------------------------------------------------------------ ticker

/** A marquee of real facts. Nothing here is invented; it re-reads live state. */
function createTicker(facts) {
  const track = el('div', { class: 'deck-track' });
  const node = el('div', { class: 'deck-ticker', 'aria-hidden': 'true' }, [track]);
  let last = '';
  return {
    node,
    update(readings) {
      const items = [...facts(), ...readings].filter(Boolean);
      const signature = items.join(' | ');
      if (signature === last) return;
      last = signature;
      clear(track);
      // Duplicated once so the CSS translation loops seamlessly: -50% lands on
      // the identical second copy.
      for (const pass of [0, 1]) {
        for (const item of items) {
          track.appendChild(el('span', { class: 'deck-fact', text: item, 'aria-hidden': pass === 0 ? 'false' : 'true' }));
        }
      }
    },
  };
}

// -------------------------------------------------------------------- dial

/**
 * The module dial: a radial selector. It exists because the eight modules are a
 * ring you jump around, not a list you scroll - and because a keyboard-driven
 * radial menu is the one piece of sci-fi interface language that is genuinely
 * faster than a menu bar once it is in muscle memory.
 */
function createDial({ modules, onSelect, onClose }) {
  let root = null;
  let index = 0;
  let restoreFocus = null;

  const slots = () =>
    root ? [...root.querySelectorAll('.dial-slot')] : [];

  const paint = () => {
    for (const [i, slot] of slots().entries()) slot.dataset.active = String(i === index);
    const current = modules[index];
    if (root && current) {
      root.querySelector('.dial-name').textContent = current.label;
      root.querySelector('.dial-note').textContent = `${index + 1} of ${modules.length} · Enter to open · Esc to close`;
    }
  };

  const move = (delta) => {
    index = (index + delta + modules.length) % modules.length;
    paint();
    const slot = slots()[index];
    if (slot) slot.focus();
  };

  const choose = (at = index) => {
    index = at;
    const target = modules[index];
    close();
    if (target) onSelect(target.id);
  };

  const onKey = (event) => {
    const key = event.key;
    if (key === 'Escape') {
      event.preventDefault();
      close();
    } else if (key === 'ArrowRight' || key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (key === 'ArrowLeft' || key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (key === 'Home') {
      event.preventDefault();
      index = 0;
      paint();
    } else if (key === 'End') {
      event.preventDefault();
      index = modules.length - 1;
      paint();
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      choose();
    } else if (/^[1-9]$/.test(key) && Number(key) <= modules.length) {
      event.preventDefault();
      choose(Number(key) - 1);
    }
  };

  const open = () => {
    if (root) return;
    restoreFocus = document.activeElement;
    root = el('div', { class: 'dial', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Module dial' }, [
      el('div', { class: 'dial-stage' }, [
        el('span', { class: 'dial-ring', 'aria-hidden': 'true' }),
        el('span', { class: 'dial-sweep', 'aria-hidden': 'true' }),
        el('div', { class: 'dial-core' }, [
          el('b', { class: 'dial-name', text: modules[0].label }),
          el('i', { class: 'dial-note', text: '' }),
        ]),
        ...modules.map((module, i) =>
          el(
            'button',
            {
              type: 'button',
              class: `dial-slot dial-slot-${i}`,
              dataset: { index: String(i), active: String(i === index) },
              onclick: () => choose(i),
              onkeydown: onKey,
            },
            [
              el('b', { class: 'dial-slot-n', text: module.tag || module.id }),
              el('span', { class: 'dial-slot-l', text: module.short }),
              module.note ? el('i', { class: 'dial-slot-s', text: module.note }) : null,
            ],
          ),
        ),
      ]),
    ]);
    document.body.appendChild(root);
    paint();
    const slot = slots()[index];
    if (slot) slot.focus();
  };

  function close() {
    if (!root) return;
    root.remove();
    root = null;
    if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus();
    onClose();
  }

  return { open, close, isOpen: () => Boolean(root), move };
}

// ------------------------------------------------------------------- mount

/**
 * @param {object} options
 * @param {Array<{id:string,tag:string,label:string,short:string,note:string}>} options.modules
 *   panels in order; `tag` and `note` are display strings, so the dial can show
 *   the real score each module is carrying rather than a decorative label
 * @param {(id:string) => void} options.onSelect called with the chosen panel id
 * @param {() => string[]} options.facts static-ish facts for the ticker
 */
export function mountHud({ modules, onSelect, facts }) {
  const html = document.documentElement;
  const frame = document.getElementById('hud');
  const deck = document.getElementById('deck');

  const wave = createWaveform();
  const ticker = createTicker(facts);
  let waveSlot = null;
  if (deck) {
    waveSlot = el('div', { class: 'deck-wave', 'aria-hidden': 'true' }, [wave.label, wave.node, wave.value]);
    deck.appendChild(waveSlot);
    deck.appendChild(ticker.node);
  }

  // One boot sweep: the deck resolving, not a loader pretending to be one.
  if (frame && !motionIsReduced()) {
    frame.dataset.boot = '1';
    setTimeout(() => {
      if (frame.isConnected) frame.dataset.boot = '';
    }, 1500);
  }

  // Depth: the pointer picks one of nine parallax zones. No inline styles, so
  // the zone is a data attribute and the movement lives in the stylesheet.
  let lastPointer = 0;
  const onPointerMove = (event) => {
    if (motionIsReduced() || html.dataset.fx === 'off') return;
    const now = event.timeStamp || Date.now();
    if (now - lastPointer < 120) return;
    lastPointer = now;
    const zone = `${event.clientY < innerHeight / 3 ? 'n' : event.clientY > (innerHeight * 2) / 3 ? 's' : 'c'}${event.clientX < innerWidth / 3 ? 'w' : event.clientX > (innerWidth * 2) / 3 ? 'e' : 'c'}`;
    if (html.dataset.pointer !== zone) html.dataset.pointer = zone;
  };
  addEventListener('pointermove', onPointerMove, { passive: true });

  const dial = createDial({ modules, onSelect, onClose: () => html.removeAttribute('data-dial') });

  const api = {
    /** A warp wipe over the incoming panel: one element, one animation. */
    warp(node) {
      if (!node || motionIsReduced() || html.dataset.fx === 'off') return;
      const scan = el('span', { class: 'warp-scan', 'aria-hidden': 'true' });
      node.appendChild(scan);
      scan.addEventListener('animationend', () => scan.remove(), { once: true });
      setTimeout(() => scan.remove(), 1200);
    },
    /** Called once a second by the app's telemetry sampler. */
    update(reading) {
      wave.push(reading);
      ticker.update(reading.lines);
    },
    openDial() {
      dial.open();
      html.dataset.dial = 'open';
    },
    closeDial: () => dial.close(),
    dialOpen: () => dial.isOpen(),
    dialMove: (delta) => dial.move(delta),
  };

  return api;
}
