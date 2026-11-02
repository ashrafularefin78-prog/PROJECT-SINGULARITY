/* M3 playground driver - external for the same CSP reason as playground/c.js:
   `script-src 'self'` with no 'unsafe-inline' refuses an inline module, and a
   refused module leaves the canvas at its default 300x150 with the status line
   still saying "starting". */
import { Renderer } from '../src/graphics/renderer.js';
import { loadGltf } from '../src/graphics/gltf.js';

const canvas = document.getElementById('c');
const status = document.getElementById('status');
const dpr = window.devicePixelRatio || 1;
canvas.width = Math.floor(canvas.clientWidth * dpr);
canvas.height = Math.floor(480 * dpr);

try {
  const renderer = new Renderer(canvas, { instances: 5000, particles: 50000, shadows: true });
  renderer.init();
  renderer.start();
  status.textContent = 'renderer running; loading sample model…';
  const url = new URL('../assets/models/singularity-core.glb', import.meta.url).href;
  loadGltf(url)
    .then((meshes) => {
      const summary = renderer.attachModel(meshes, { spin: 0.18 });
      status.textContent = `sample model: ${summary.meshes} meshes, ${summary.triangles.toLocaleString()} triangles`;
    })
    .catch((err) => {
      status.textContent = `model failed: ${err.message}`;
    });
} catch (err) {
  status.textContent = `engine unavailable: ${err.message}`;
}
