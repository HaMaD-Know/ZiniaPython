#!/usr/bin/env node
/**
 * Static integrity check of the iOS project. Runs on any OS (no Xcode needed)
 * and fails loudly if the native integration is not wired up:
 *
 *  - every Swift/Objective-C source in ios/App/App/ZiniaPython is compiled
 *  - Python.xcframework is linked (weak) and embedded (signed on copy)
 *  - the Python build phases exist and run in the documented order
 *  - required build settings are present in Debug and Release
 *  - both plugins are registered with the bridge, and the method names in the
 *    Swift plugins match the TypeScript plugin interfaces
 *  - Info.plist, bridging header and runtime lock file are consistent
 *
 * Usage: node scripts/check-ios-project.mjs
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import xcode from 'xcode';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iosApp = path.join(root, 'ios', 'App');
const failures = [];
const passes = [];
const check = (ok, message) => (ok ? passes : failures).push(message);
const read = (p) => readFileSync(path.join(root, p), 'utf8');

// --- project file -----------------------------------------------------------
const project = xcode.project(path.join(iosApp, 'App.xcodeproj', 'project.pbxproj'));
project.parseSync();
const objects = project.hash.project.objects;
const entries = (section) => Object.entries(objects[section] ?? {}).filter(([k, v]) => !k.endsWith('_comment') && typeof v === 'object');
const unquote = (s) => (typeof s === 'string' ? s.replace(/^"(.*)"$/, '$1') : s);

const target = entries('PBXNativeTarget').find(([, t]) => unquote(t.name) === 'App')?.[1];
check(!!target, 'App target exists');

const phaseNames = target.buildPhases.map((p) => p.comment);
const order = ['Resources', 'Install ZiniaPython runtime package', 'Process Python libraries', 'Embed Frameworks'];
const positions = order.map((name) => phaseNames.indexOf(name));
check(positions.every((p) => p >= 0), `build phases present: ${order.join(', ')}`);
check(positions.every((p, i) => i === 0 || p > positions[i - 1]), `build phase order: ${phaseNames.join(' -> ')}`);

const sourcesPhase = entries('PBXSourcesBuildPhase').map(([, v]) => v)[0];
const compiled = new Set(sourcesPhase.files.map((f) => f.comment.replace(/ in Sources$/, '')));
const nativeDir = path.join(iosApp, 'App', 'ZiniaPython');
const nativeSources = readdirSync(nativeDir).filter((f) => /\.(swift|m)$/.test(f));
for (const file of nativeSources) check(compiled.has(file), `${file} is compiled into the App target`);
for (const file of ['AppDelegate.swift', 'SceneDelegate.swift']) check(compiled.has(file), `${file} is compiled`);

// Every file reference points at a file that exists.
const groups = [...entries('PBXGroup'), ...entries('PBXVariantGroup')].map(([id, g]) => ({ id, ...g }));
const parentOf = new Map();
for (const g of groups) for (const child of g.children ?? []) parentOf.set(child.value, g);
const resolveRef = (id, ref) => {
  const parts = [unquote(ref.path)];
  let parent = parentOf.get(id);
  while (parent) {
    if (parent.path) parts.unshift(unquote(parent.path));
    parent = parentOf.get(parent.id);
  }
  return path.join(iosApp, ...parts);
};
const generated = new Set(['capacitor.config.json', 'config.xml', 'public', 'App.app', 'Python.xcframework']);
for (const [id, ref] of entries('PBXFileReference')) {
  const name = unquote(ref.path);
  if (ref.sourceTree === 'BUILT_PRODUCTS_DIR' || generated.has(path.basename(name))) continue;
  const file = ref.sourceTree === 'SOURCE_ROOT' ? path.join(iosApp, name) : resolveRef(id, ref);
  check(existsSync(file), `file reference exists: ${path.relative(root, file)}`);
}

// Python.xcframework: linked weakly and embedded with signing.
const buildFiles = entries('PBXBuildFile').map(([id, v]) => ({ id, ...v }));
const frameworksPhase = entries('PBXFrameworksBuildPhase').map(([, v]) => v)[0];
const linked = frameworksPhase.files.map((f) => buildFiles.find((b) => b.id === f.value)).find((b) => b?.fileRef_comment === 'Python.xcframework');
check(!!linked, 'Python.xcframework is in Link Binary With Libraries');
check(JSON.stringify(linked?.settings ?? {}).includes('Weak'), 'Python.xcframework is weakly linked (missing framework becomes a diagnostic, not a crash)');
const embedPhase = entries('PBXCopyFilesBuildPhase').map(([, v]) => v).find((p) => unquote(p.name) === 'Embed Frameworks');
const embedded = embedPhase?.files.map((f) => buildFiles.find((b) => b.id === f.value)).find((b) => b?.fileRef_comment === 'Python.xcframework');
check(String(embedPhase?.dstSubfolderSpec) === '10', 'Embed Frameworks copies into Frameworks/');
check(JSON.stringify(embedded?.settings ?? {}).includes('CodeSignOnCopy'), 'Python.xcframework is embedded and signed on copy');

// Shell phases call the scripts that exist.
for (const [, phase] of entries('PBXShellScriptBuildPhase')) {
  const script = unquote(phase.shellScript);
  const m = /scripts\/([\w.-]+\.sh)/.exec(script);
  check(!!m && existsSync(path.join(iosApp, 'scripts', m[1])), `shell phase "${unquote(phase.name)}" runs an existing script`);
  check(String(phase.alwaysOutOfDate) === '1', `shell phase "${unquote(phase.name)}" runs on every build`);
}

// Build settings in both target configurations.
const configList = objects.XCConfigurationList[target.buildConfigurationList];
for (const ref of configList.buildConfigurations) {
  const cfg = objects.XCBuildConfiguration[ref.value];
  const s = cfg.buildSettings;
  const name = unquote(cfg.name);
  check(s.ENABLE_USER_SCRIPT_SANDBOXING === 'NO', `${name}: User Script Sandboxing is off (docs step 6)`);
  check(unquote(s.SWIFT_OBJC_BRIDGING_HEADER) === 'App/App-Bridging-Header.h', `${name}: bridging header configured`);
  check(JSON.stringify(s.HEADER_SEARCH_PATHS ?? '').includes('Python.framework/Headers'), `${name}: Python headers on the header search path`);
  check(JSON.stringify(s.FRAMEWORK_SEARCH_PATHS ?? '').includes('$(PROJECT_DIR)'), `${name}: framework search path includes $(PROJECT_DIR)`);
  check(s.CLANG_WARN_QUOTED_INCLUDE_IN_FRAMEWORK_HEADER === 'NO', `${name}: quoted-include warning disabled (docs step 6)`);
  check(Number(s.IPHONEOS_DEPLOYMENT_TARGET) >= 15, `${name}: deployment target ${s.IPHONEOS_DEPLOYMENT_TARGET} >= 15 (Capacitor 8)`);
}

// --- plugin registration and API consistency ----------------------------------
const bridgeVC = read('ios/App/App/ZiniaPython/ZiniaBridgeViewController.swift');
check(/registerPluginInstance\(ZiniaPythonPlugin\(\)\)/.test(bridgeVC), 'ZiniaPythonPlugin is registered with the bridge');
check(/registerPluginInstance\(ZiniaFilesPlugin\(\)\)/.test(bridgeVC), 'ZiniaFilesPlugin is registered with the bridge');
check(/rootViewController = ZiniaBridgeViewController\(\)/.test(read('ios/App/App/SceneDelegate.swift')), 'SceneDelegate uses ZiniaBridgeViewController');
check(read('ios/App/App/Base.lproj/Main.storyboard').includes('customClass="ZiniaBridgeViewController"'), 'Main.storyboard uses ZiniaBridgeViewController');

const swiftMethods = (file) => new Set([...read(file).matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((m) => m[1]));
const swiftJsName = (file) => /jsName = "(\w+)"/.exec(read(file))?.[1];
const tsMethods = (file, iface) => {
  const src = read(file);
  const body = src.slice(src.indexOf(`export interface ${iface}`));
  const block = body.slice(0, body.indexOf('\n}\n'));
  return new Set([...block.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]).filter((m) => !['addListener', 'removeAllListeners'].includes(m)));
};
for (const [swift, ts, iface, jsName] of [
  ['ios/App/App/ZiniaPython/ZiniaPythonPlugin.swift', 'src/plugins/zinia-python.ts', 'ZiniaPythonPlugin', 'ZiniaPython'],
  ['ios/App/App/ZiniaPython/ZiniaFilesPlugin.swift', 'src/plugins/zinia-files.ts', 'ZiniaFilesPlugin', 'ZiniaFiles'],
]) {
  check(swiftJsName(swift) === jsName, `${path.basename(swift)} jsName is "${jsName}"`);
  check(read(ts).includes(`registerPlugin<${iface}>('${jsName}'`), `${path.basename(ts)} registers "${jsName}"`);
  const native = swiftMethods(swift);
  const web = tsMethods(ts, iface);
  const missingNative = [...web].filter((m) => !native.has(m));
  const missingWeb = [...native].filter((m) => !web.has(m));
  check(missingNative.length === 0, `${jsName}: every TypeScript method exists natively${missingNative.length ? ` (missing: ${missingNative})` : ''}`);
  check(missingWeb.length === 0, `${jsName}: every native method is typed in TypeScript${missingWeb.length ? ` (missing: ${missingWeb})` : ''}`);
  const swiftSource = read(swift);
  const notImplemented = [...native].filter((m) => !new RegExp(`@objc func ${m}\\(_ call: CAPPluginCall\\)`).test(swiftSource));
  check(notImplemented.length === 0, `${jsName}: every declared method has an @objc implementation${notImplemented.length ? ` (missing: ${notImplemented})` : ''}`);
}

// --- other configuration ------------------------------------------------------
check(read('ios/App/App/App-Bridging-Header.h').includes('#import "ZiniaPython/ZPInterpreter.h"'), 'bridging header imports ZPInterpreter.h');
const plist = read('ios/App/App/Info.plist');
for (const key of ['UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace']) check(plist.includes(`<key>${key}</key>`), `Info.plist declares ${key}`);
check(!plist.includes('<string>armv7</string>'), 'Info.plist does not require armv7');
const lock = JSON.parse(read('python-runtime/runtime.lock.json'));
check(/^https:\/\//.test(lock.url) && /^[0-9a-f]{64}$/.test(lock.sha256), 'python-runtime/runtime.lock.json pins a URL and SHA-256');
const interp = read('ios/App/App/ZiniaPython/ZPInterpreter.m');
for (const [needle, what] of [
  ['preconfig.utf8_mode = 1', 'UTF-8 mode'],
  ['config.buffered_stdio = 0', 'unbuffered stdio'],
  ['config.write_bytecode = 0', 'no bytecode writing'],
  ['config.install_signal_handlers = 1', 'signal handlers'],
  ['config.use_system_logger = 1', 'system logger'],
  ['PyImport_AppendInittab("_zinia_native"', 'native bridge module'],
]) check(interp.includes(needle), `interpreter configuration: ${what} (docs step 8)`);
check(existsSync(path.join(root, 'python', 'zinia', 'bridge.py')), 'runtime package python/zinia exists');

const appId = /appId: '([^']+)'/.exec(read('capacitor.config.ts'))?.[1];
const bundleIds = new Set([...read('ios/App/App.xcodeproj/project.pbxproj').matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map((m) => m[1]));
check(bundleIds.size === 1 && bundleIds.has(appId), `bundle identifier matches capacitor.config.ts (${appId})`);

// --- report -------------------------------------------------------------------
for (const p of passes) console.log(`  ok   ${p}`);
for (const f of failures) console.log(`  FAIL ${f}`);
console.log(`\n${passes.length} checks passed, ${failures.length} failed.`);
process.exit(failures.length ? 1 : 0);
