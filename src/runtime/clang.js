import { MemFS, WasmProcess, unpackSysroot } from './wasm-host.js';

const encoder = new TextEncoder();
const STANDARDS = {
  c: ['c89', 'c99', 'c11', 'gnu11'],
  cpp: ['c++98', 'c++11', 'c++14', 'c++17'],
};
const ASSETS = new URL('../../assets/toolchain/', import.meta.url);
const MAX_OUTPUT = 1024 * 1024;
const MAX_WRITES = 4096;

export function validateProject(source, options = {}) {
  const language = options.language ?? 'c';
  if (!Object.hasOwn(STANDARDS, language)) throw new Error('choose C or C++');
  const standard = options.standard ?? (language === 'cpp' ? 'c++17' : 'c11');
  if (!STANDARDS[language].includes(standard)) throw new Error(`unsupported ${language} standard: ${standard}`);
  if (typeof source !== 'string' || encoder.encode(source).length > 1024 * 1024) throw new Error('source exceeds the 1 MiB limit');
  if (typeof options.stdin !== 'undefined' && (typeof options.stdin !== 'string' || encoder.encode(options.stdin).length > 1024 * 1024)) throw new Error('stdin exceeds the 1 MiB limit');
  const files = options.files ?? {};
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('extra files must be a filename-to-source map');
  if (Object.keys(files).length > 32) throw new Error('at most 32 extra files are supported');
  let bytes = encoder.encode(source).length;
  for (const [name, content] of Object.entries(files)) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inc)$/.test(name) || name === 'main.c' || name === 'main.cpp') throw new Error(`invalid or reserved extra filename: ${name}`);
    if (typeof content !== 'string' || encoder.encode(content).length > 1024 * 1024) throw new Error(`extra file exceeds the 1 MiB limit: ${name}`);
    bytes += encoder.encode(content).length;
  }
  if (bytes > 4 * 1024 * 1024) throw new Error('project exceeds the 4 MiB limit');
  const memoryBytes = options.maxHeapBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 2 * 1024 * 1024 || memoryBytes > 128 * 1024 * 1024 || memoryBytes % 65536) throw new Error('program memory limit must be 2–128 MiB in 64 KiB pages');
  return { language, standard, files, memoryBytes };
}

export function compileDiagnostic(text, stage) {
  const match = /([^\s:]+\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)):(\d+):(\d+):\s+(?:fatal )?error:\s*([^\n]+)/.exec(text);
  return {
    stage,
    message: match ? match[4] : text.trim() || `${stage.toLowerCase()} failed`,
    line: match ? Number(match[2]) : 1,
    col: match ? Number(match[3]) : 1,
    ...(match ? { file: match[1].replace(/^\/?project\//, '') } : {}),
  };
}

async function loadAsset(name, manifest, fetchAsset) {
  const response = await fetchAsset(new URL(name + '.gz', ASSETS));
  if (response.status !== 200 || !response.body) throw new Error(`toolchain asset ${name} unavailable (HTTP ${response.status}: ${response.statusText}${response.body ? '' : '; empty body'})`);
  const compressed = response.body.pipeThrough(new DecompressionStream('gzip'));
  const bytes = await new Response(compressed).arrayBuffer();
  const expected = manifest.files[name];
  if (bytes.byteLength !== expected.bytes) throw new Error(`toolchain asset size mismatch: ${name}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== expected.sha256) throw new Error(`toolchain asset integrity mismatch: ${name}`);
  return bytes;
}

export async function compileAndRun(source, options = {}) {
  let stage = 'Toolchain';
  let diagnostics = '';
  let output = '';
  let outputBytes = 0;
  let outputWrites = 0;
  const decoders = new Map([[1, new TextDecoder()], [2, new TextDecoder()]]);
  const status = (phase, text) => options.onStatus?.({ phase, text });
  const write = (fd, bytes) => {
    if (!bytes.length) return;
    outputBytes += bytes.length;
    if (outputBytes > MAX_OUTPUT) throw new Error('output limit exceeded (1 MiB)');
    const text = decoders.get(fd).decode(bytes, { stream: true });
    if (stage === 'Runtime') {
      // Bound message traffic while forwarding even small fflush writes promptly.
      if (++outputWrites > MAX_WRITES) throw new Error('output limit exceeded (4096 writes)');
      output += text;
      if (text) options.onOutput?.(text);
    } else diagnostics += text;
  };
  try {
    const project = validateProject(source, options);
    status('loading', 'Loading local Clang 8.0.1 toolchain (about 18.4 MiB on first run)…');
    const fetchAsset = options.fetchAsset ?? fetch;
    const response = await fetchAsset(new URL('manifest.json', ASSETS));
    if (!response.ok) throw new Error(`toolchain manifest unavailable (HTTP ${response.status})`);
    const manifest = await response.json();
    const [fsModule, clangModule, lldModule, sysroot] = await Promise.all([
      loadAsset('memfs.wasm', manifest, fetchAsset).then(bytes => WebAssembly.compile(bytes)),
      loadAsset('clang.wasm', manifest, fetchAsset).then(bytes => WebAssembly.compile(bytes)),
      loadAsset('lld.wasm', manifest, fetchAsset).then(bytes => WebAssembly.compile(bytes)),
      loadAsset('sysroot.tar', manifest, fetchAsset),
    ]);
    const fs = await MemFS.create(fsModule, write);
    unpackSysroot(sysroot, fs);
    fs.addDirectory('project');
    const entry = project.language === 'cpp' ? 'main.cpp' : 'main.c';
    const files = { [entry]: source, ...project.files };
    for (const [name, content] of Object.entries(files)) fs.addFile(`project/${name}`, content);
    const objects = [];
    let cpp = project.language === 'cpp';
    stage = 'Compile';
    for (const name of Object.keys(files).filter(name => /\.(c|cc|cpp|cxx)$/.test(name))) {
      status('compiling', `Compiling ${name} with Clang…`);
      const language = name.endsWith('.c') ? 'c' : 'c++';
      cpp ||= language === 'c++';
      const standard = language === 'c' ? (project.language === 'c' ? project.standard : 'c11') : (project.language === 'cpp' ? project.standard : 'c++17');
      const obj = `project/${name}.o`;
      const process = await WasmProcess.create(clangModule, {
        fs, write,
        argv: ['clang', '-cc1', '-emit-obj', '-disable-free', '-triple', 'wasm32-unknown-wasi', '-isysroot', '/',
          '-internal-isystem', '/include/c++/v1', '-internal-isystem', '/include', '-internal-isystem', '/lib/clang/8.0.1/include',
          '-I', '/project', '-ferror-limit', '10', '-fno-color-diagnostics', '-O0', `-std=${standard}`, '-x', language,
          '-o', obj, `project/${name}`],
      });
      if (process.run() !== 0) return { ok: false, output, diagnostics, error: compileDiagnostic(diagnostics, stage) };
      objects.push(obj);
    }
    stage = 'Link';
    status('linking', 'Linking WebAssembly and standard libraries…');
    const lib = 'lib/wasm32-wasi';
    const linker = await WasmProcess.create(lldModule, {
      fs, write,
      argv: ['wasm-ld', '--no-threads', '-z', 'stack-size=1048576', `--max-memory=${project.memoryBytes}`, `-L${lib}`,
        `${lib}/crt1.o`, ...objects, ...(cpp ? ['-lc++', '-lc++abi'] : []), '-lc',
        'lib/clang/8.0.1/lib/wasi/libclang_rt.builtins-wasm32.a', '-o', 'project/program.wasm'],
    });
    if (linker.run() !== 0) return { ok: false, output, diagnostics, error: compileDiagnostic(diagnostics, stage) };
    const module = await WebAssembly.compile(fs.getFile('project/program.wasm'));
    for (const decoder of decoders.values()) diagnostics += decoder.decode();
    stage = 'Runtime';
    const process = await WasmProcess.create(module, { argv: [entry], stdin: options.stdin ?? '', write });
    status('running', 'Running WebAssembly (execution timer started)…');
    const exitCode = process.run();
    for (const decoder of decoders.values()) {
      const tail = decoder.decode();
      output += tail;
      if (tail) options.onOutput?.(tail);
    }
    return { ok: exitCode === 0, exitCode, output, diagnostics, memoryBytes: process.mem.memory.buffer.byteLength,
      ...(exitCode ? { error: { stage, message: `program exited with status ${exitCode}`, line: 1, col: 1 } } : {}) };
  } catch (error) {
    for (const decoder of decoders.values()) {
      const tail = decoder.decode();
      if (stage === 'Runtime') {
        output += tail;
        if (tail) options.onOutput?.(tail);
      } else diagnostics += tail;
    }
    return { ok: false, output, diagnostics, error: { stage, message: error.message, line: 1, col: 1 } };
  }
}
