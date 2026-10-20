#!/usr/bin/env node
/**
 * Sets manual code signing on the App target's Release configuration only.
 *
 * Passing signing settings on the xcodebuild command line would apply them to
 * every target, including Swift package targets that cannot take a
 * provisioning profile. Editing just the App target avoids that. Used by the
 * signed path of .github/workflows/build-ios.yml; values come from
 * scripts/ci/import-signing.sh (environment variables).
 */
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import xcode from 'xcode';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const file = path.join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const env = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`::error::${name} is not set`);
    process.exit(1);
  }
  return value;
};
const quote = (value) => `"${value.replace(/"/g, '\\"')}"`;

const settings = {
  CODE_SIGN_STYLE: 'Manual',
  DEVELOPMENT_TEAM: env('SIGN_TEAM_ID'),
  CODE_SIGN_IDENTITY: quote(env('SIGN_IDENTITY')),
  PROVISIONING_PROFILE_SPECIFIER: quote(env('SIGN_PROFILE_NAME')),
  PRODUCT_BUNDLE_IDENTIFIER: env('SIGN_BUNDLE_ID'),
};

const project = xcode.project(file);
project.parseSync();
const objects = project.hash.project.objects;
const target = Object.values(objects.PBXNativeTarget).find((t) => typeof t === 'object' && t.name === 'App');
const list = objects.XCConfigurationList[target.buildConfigurationList];
let changed = 0;
for (const ref of list.buildConfigurations) {
  const config = objects.XCBuildConfiguration[ref.value];
  if (config.name !== 'Release') continue;
  Object.assign(config.buildSettings, settings);
  changed += 1;
}
if (changed !== 1) {
  console.error('::error::Could not find the App target Release configuration');
  process.exit(1);
}
writeFileSync(file, project.writeSync());
console.log(`Manual signing configured for App/Release: team ${settings.DEVELOPMENT_TEAM}, bundle ${settings.PRODUCT_BUNDLE_IDENTIFIER}`);
