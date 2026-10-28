const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ProcessExit extends Error {
  constructor(code) {
    super(`process exited with code ${code}`);
    this.code = code;
  }
}

class Memory {
  constructor(memory) { this.memory = memory; }
  get bytes() { return new Uint8Array(this.memory.buffer); }
  get view() { return new DataView(this.memory.buffer); }
  read32(offset) { return this.view.getUint32(offset, true); }
  write32(offset, value) { this.view.setUint32(offset, value, true); }
  write(offset, bytes) { this.bytes.set(bytes, offset); }
}

export class MemFS {
  static async create(module, write) {
    const fs = new MemFS();
    fs.write = write;
    const names = ['abort', 'host_write', 'host_read', 'memfs_log', 'copy_in', 'copy_out'];
    const env = Object.fromEntries(names.map(name => [name, fs[name].bind(fs)]));
    const instance = await WebAssembly.instantiate(module, { env });
    fs.exports = instance.exports;
    fs.mem = new Memory(fs.exports.memory);
    fs.exports.init();
    return fs;
  }

  addDirectory(path) {
    const bytes = encoder.encode(path);
    this.mem.write(this.exports.GetPathBuf(), bytes);
    this.exports.AddDirectoryNode(bytes.length);
  }

  addFile(path, bytes) {
    if (typeof bytes === 'string') bytes = encoder.encode(bytes);
    const name = encoder.encode(path);
    this.mem.write(this.exports.GetPathBuf(), name);
    const inode = this.exports.AddFileNode(name.length, bytes.length);
    this.mem.write(this.exports.GetFileNodeAddress(inode), bytes);
  }

  getFile(path) {
    const name = encoder.encode(path);
    this.mem.write(this.exports.GetPathBuf(), name);
    const inode = this.exports.FindNode(name.length);
    const offset = this.exports.GetFileNodeAddress(inode);
    const size = this.exports.GetFileNodeSize(inode);
    return this.mem.bytes.slice(offset, offset + size);
  }

  abort() { throw new Error('virtual filesystem aborted'); }
  host_write(fd, iovs, count, written) { return this.host.writeVectors(fd, iovs, count, written); }
  host_read(fd, iovs, count, read) { return this.host.readVectors(fd, iovs, count, read); }
  memfs_log(offset, size) { this.write(2, this.mem.bytes.slice(offset, offset + size)); }
  copy_out(dst, src, size) { this.host.mem.write(dst, this.mem.bytes.slice(src, src + size)); }
  copy_in(dst, src, size) { this.mem.write(dst, this.host.mem.bytes.slice(src, src + size)); }
}

export function unpackSysroot(buffer, fs) {
  const bytes = new Uint8Array(buffer);
  const text = (offset, size) => decoder.decode(bytes.subarray(offset, offset + size)).replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const name = text(offset, 100);
    if (!name) break;
    const prefix = text(offset + 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(text(offset + 124, 12).trim(), 8) || 0;
    const type = text(offset + 156, 1);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) throw new Error('invalid toolchain archive');
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('invalid toolchain archive path');
    if (type === '5') fs.addDirectory(path.replace(/\/$/, ''));
    else if (type === '0' || type === '') fs.addFile(path, bytes.subarray(offset + 512, offset + 512 + size));
    else throw new Error(`unsupported toolchain archive entry: ${path}`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

export class WasmProcess {
  static async create(module, { fs, argv = [], stdin = '', write = () => {} } = {}) {
    const host = new WasmProcess();
    host.argv = argv.map(arg => encoder.encode(arg + '\0'));
    host.input = encoder.encode(stdin);
    host.inputPosition = 0;
    host.write = write;
    const wasi = fs ? { ...fs.exports } : {};
    Object.assign(wasi, {
      proc_exit: code => { throw new ProcessExit(code); },
      args_sizes_get: (count, size) => {
        host.mem.write32(count, host.argv.length);
        host.mem.write32(size, host.argv.reduce((sum, arg) => sum + arg.length, 0));
        return 0;
      },
      args_get: (pointers, buffer) => {
        for (const arg of host.argv) {
          host.mem.write32(pointers, buffer);
          host.mem.write(buffer, arg);
          pointers += 4;
          buffer += arg.length;
        }
        return 0;
      },
      environ_sizes_get: (count, size) => {
        host.mem.write32(count, 0);
        host.mem.write32(size, 0);
        return 0;
      },
      environ_get: () => 0,
      random_get: (offset, size) => {
        const bytes = new Uint8Array(host.mem.memory.buffer, offset, size);
        for (let i = 0; i < size; i += 65536) crypto.getRandomValues(bytes.subarray(i, Math.min(size, i + 65536)));
        return 0;
      },
      clock_time_get: (clock, precision, output) => {
        if (clock !== 0 && clock !== 1) return 28;
        const milliseconds = clock === 0 ? Date.now() : performance.now();
        host.mem.view.setBigUint64(output, BigInt(Math.floor(milliseconds * 1e6)), true);
        return 0;
      },
      poll_oneoff: () => 52,
    });
    if (!fs) {
      Object.assign(wasi, {
        fd_write: host.writeVectors.bind(host),
        fd_read: host.readVectors.bind(host),
        fd_close: fd => fd <= 2 ? 0 : 8,
        fd_seek: () => 70,
        fd_tell: () => 70,
        fd_sync: () => 0,
        fd_datasync: () => 0,
        fd_fdstat_get: (fd, output) => {
          if (fd > 2) return 8;
          host.mem.write(output, new Uint8Array(24));
          host.mem.bytes[output] = 2;
          return 0;
        },
        fd_prestat_get: () => 8,
        fd_prestat_dir_name: () => 8,
        path_open: () => 76,
      });
    }
    for (const item of WebAssembly.Module.imports(module)) {
      if (item.module !== 'wasi_unstable' || item.kind !== 'function') throw new Error(`unsupported program import: ${item.module}.${item.name}`);
      if (!Object.hasOwn(wasi, item.name)) {
        if (fs) throw new Error(`unsupported compiler syscall: ${item.name}`);
        wasi[item.name] = () => 76;
      }
    }
    const instance = await WebAssembly.instantiate(module, { wasi_unstable: wasi });
    host.exports = instance.exports;
    host.mem = new Memory(instance.exports.memory);
    if (fs) fs.host = host;
    return host;
  }

  writeVectors(fd, iovs, count, written) {
    if (fd !== 1 && fd !== 2) return 8;
    let size = 0;
    for (let i = 0; i < count; i++) {
      const offset = this.mem.read32(iovs + i * 8);
      const length = this.mem.read32(iovs + i * 8 + 4);
      this.write(fd, new Uint8Array(this.mem.memory.buffer, offset, length));
      size += length;
    }
    this.mem.write32(written, size);
    return 0;
  }

  readVectors(fd, iovs, count, read) {
    if (fd !== 0) return 8;
    let size = 0;
    for (let i = 0; i < count; i++) {
      const offset = this.mem.read32(iovs + i * 8);
      const length = this.mem.read32(iovs + i * 8 + 4);
      const available = Math.min(length, this.input.length - this.inputPosition);
      this.mem.write(offset, this.input.subarray(this.inputPosition, this.inputPosition + available));
      this.inputPosition += available;
      size += available;
      if (available < length) break;
    }
    this.mem.write32(read, size);
    return 0;
  }

  run() {
    try {
      this.exports._start();
      return 0;
    } catch (error) {
      if (error instanceof ProcessExit) return error.code;
      throw error;
    }
  }
}
