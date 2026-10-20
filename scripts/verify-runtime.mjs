#!/usr/bin/env node
/**
 * Verifies the extracted Python.xcframework on any operating system by
 * reading the Mach-O headers directly (no lipo/otool needed):
 *
 *  - Info.plist lists a device slice and a simulator slice
 *  - the device binary is arm64 and built for the iOS platform
 *  - the simulator binary contains arm64 (and x86_64) for the iOS Simulator
 *  - headers, the standard library and compiled extension modules are present
 *  - the build helper used by the Xcode build phase exists
 *  - the Python version matches python-runtime/runtime.lock.json
 *
 * Usage: node scripts/verify-runtime.mjs [path/to/Python.xcframework]
 */
import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xcf = path.resolve(process.argv[2] ?? path.join(root, 'ios', 'App', 'Python.xcframework'));
const lock = JSON.parse(readFileSync(path.join(root, 'python-runtime', 'runtime.lock.json'), 'utf8'));
const results = [];
const check = (ok, message) => results.push({ ok, message });

const CPU = { 0x0100000c: 'arm64', 0x01000007: 'x86_64', 0x0000000c: 'arm' };
const PLATFORM = { 1: 'macOS', 2: 'iOS', 7: 'iOS Simulator' };
const LC_BUILD_VERSION = 0x32;
const LC_VERSION_MIN_IPHONEOS = 0x25;

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  readSync(fd, buf, 0, length, offset);
  return buf;
}

/** Returns [{arch, platform, minos}] for a thin or fat Mach-O file. */
function machoSlices(file) {
  const fd = openSync(file, 'r');
  try {
    const magic = readAt(fd, 0, 4).readUInt32BE(0);
    const slices = [];
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const count = readAt(fd, 4, 4).readUInt32BE(0);
      const is64 = magic === 0xcafebabf;
      const size = is64 ? 32 : 20;
      for (let i = 0; i < count; i++) {
        const entry = readAt(fd, 8 + i * size, size);
        const offset = is64 ? Number(entry.readBigUInt64BE(8)) : entry.readUInt32BE(8);
        slices.push(thinInfo(fd, offset));
      }
    } else {
      slices.push(thinInfo(fd, 0));
    }
    return slices;
  } finally {
    closeSync(fd);
  }
}

function thinInfo(fd, base) {
  const header = readAt(fd, base, 32);
  const magic = header.readUInt32LE(0);
  if (magic !== 0xfeedfacf) throw new Error(`not a 64-bit little-endian Mach-O at offset ${base}`);
  const cputype = header.readUInt32LE(4);
  const ncmds = header.readUInt32LE(16);
  const sizeofcmds = header.readUInt32LE(20);
  const cmds = readAt(fd, base + 32, sizeofcmds);
  let platform = 'unknown';
  let minos = '';
  let pos = 0;
  for (let i = 0; i < ncmds; i++) {
    const cmd = cmds.readUInt32LE(pos);
    const cmdsize = cmds.readUInt32LE(pos + 4);
    if (cmd === LC_BUILD_VERSION) {
      platform = PLATFORM[cmds.readUInt32LE(pos + 8)] ?? `platform ${cmds.readUInt32LE(pos + 8)}`;
      const v = cmds.readUInt32LE(pos + 12);
      minos = `${v >> 16}.${(v >> 8) & 0xff}`;
    } else if (cmd === LC_VERSION_MIN_IPHONEOS) {
      platform = 'iOS';
      const v = cmds.readUInt32LE(pos + 8);
      minos = `${v >> 16}.${(v >> 8) & 0xff}`;
    }
    pos += cmdsize;
  }
  return { arch: CPU[cputype] ?? `cpu 0x${cputype.toString(16)}`, platform, minos };
}

function plistLibraries(plist) {
  const libs = [];
  for (const m of plist.matchAll(/<dict>([\s\S]*?)<\/dict>/g)) {
    const block = m[1];
    const id = /<key>LibraryIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(block)?.[1];
    if (!id) continue;
    const archs = [...(/<key>SupportedArchitectures<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(block)?.[1] ?? '').matchAll(/<string>([^<]+)<\/string>/g)].map((a) => a[1]);
    const variant = /<key>SupportedPlatformVariant<\/key>\s*<string>([^<]+)<\/string>/.exec(block)?.[1] ?? 'device';
    libs.push({ id, archs, variant });
  }
  return libs;
}

if (!existsSync(xcf)) {
  console.error(`Python.xcframework not found at ${xcf}. Run scripts/fetch-python-runtime.sh (or .ps1) first.`);
  process.exit(2);
}

const libs = plistLibraries(readFileSync(path.join(xcf, 'Info.plist'), 'utf8'));
const device = libs.find((l) => l.variant === 'device');
const simulator = libs.find((l) => l.variant === 'simulator');
check(!!device && device.archs.includes('arm64'), `Info.plist device slice: ${device?.id} (${device?.archs.join(', ')})`);
check(!!simulator, `Info.plist simulator slice: ${simulator?.id} (${simulator?.archs.join(', ')})`);

for (const lib of [device, simulator].filter(Boolean)) {
  const binary = path.join(xcf, lib.id, 'Python.framework', 'Python');
  check(existsSync(binary), `${lib.id}: Python.framework/Python exists`);
  if (!existsSync(binary)) continue;
  const slices = machoSlices(binary);
  const expectedPlatform = lib.variant === 'simulator' ? 'iOS Simulator' : 'iOS';
  for (const arch of lib.archs) {
    const slice = slices.find((s) => s.arch === arch);
    check(!!slice && slice.platform === expectedPlatform, `${lib.id}: ${arch} slice built for ${slice?.platform ?? 'missing'} (minimum ${slice?.minos || '?'})`);
  }
  const headers = path.join(xcf, lib.id, 'Python.framework', 'Headers', 'Python.h');
  check(existsSync(headers), `${lib.id}: Headers/Python.h present`);
  const patch = existsSync(path.join(xcf, lib.id, 'Python.framework', 'Headers', 'patchlevel.h'))
    ? readFileSync(path.join(xcf, lib.id, 'Python.framework', 'Headers', 'patchlevel.h'), 'utf8')
    : '';
  const version = /#define PY_VERSION\s+"([^"]+)"/.exec(patch)?.[1];
  check(version === lock.pythonVersion, `${lib.id}: headers declare Python ${version} (lock file: ${lock.pythonVersion})`);
  for (const arch of lib.archs) {
    const dynload = path.join(xcf, lib.id, `lib-${arch}`, `python${lock.pythonMinor}`, 'lib-dynload');
    const modules = existsSync(dynload) ? readdirSync(dynload).filter((f) => f.endsWith('.so')) : [];
    check(modules.length > 40, `${lib.id}: lib-${arch} has ${modules.length} compiled stdlib modules`);
    const sample = modules.find((f) => f.startsWith('_ssl')) ?? modules[0];
    if (sample) {
      const s = machoSlices(path.join(dynload, sample))[0];
      check(s.arch === arch, `${lib.id}: ${sample} is ${s.arch} for ${s.platform}`);
    }
  }
}

const stdlib = path.join(xcf, 'lib', `python${lock.pythonMinor}`);
for (const f of ['os.py', 'encodings/__init__.py', 'json/__init__.py', 'pathlib/__init__.py', 'unittest/__init__.py', 'ssl.py', 'sqlite3/__init__.py']) {
  check(existsSync(path.join(stdlib, f)), `standard library contains ${f}`);
}
const stdlibFiles = (() => {
  let n = 0;
  const walk = (d) => { for (const e of readdirSync(d)) { const p = path.join(d, e); if (statSync(p).isDirectory()) walk(p); else n++; } };
  if (existsSync(stdlib)) walk(stdlib);
  return n;
})();
check(stdlibFiles > 1000, `standard library has ${stdlibFiles} files`);
const helper = ['build_utils.sh', 'utils.sh'].find((f) => existsSync(path.join(xcf, 'build', f)));
check(!!helper, `build helper present: build/${helper}`);
check(existsSync(path.join(xcf, 'build', 'iOS-dylib-Info-template.plist')), 'framework Info.plist template present');

for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.message}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} checks passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
