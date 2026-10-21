import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

async function main() {
  let write = false;
  let mode;
  let version;
  let build;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check' || arg === '--write') {
      if (mode && mode !== arg) throw new Error('--check and --write are mutually exclusive');
      mode = arg;
      write = arg === '--write';
    } else if (arg === '--set' || arg === '--build') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--set') version = value;
      else build = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (build !== undefined && !/^[1-9]\d*$/.test(build)) {
    throw new Error('--build must be a positive integer');
  }

  const changes = [];
  async function packageVersion(path, target) {
    const before = await readFile(path, 'utf8');
    const pkg = JSON.parse(before);
    if (typeof pkg.version !== 'string') throw new Error(`Missing version: ${path}`);
    if (pkg.version !== target) {
      // Replace only the top-level version value, preserving all other formatting.
      let depth = 0;
      const tokens = /"(?:\\.|[^"\\])*"|[{}]/g;
      let match;
      let after;
      while ((match = tokens.exec(before))) {
        if (match[0] === '{') depth++;
        else if (match[0] === '}') depth--;
        else if (depth === 1 && JSON.parse(match[0]) === 'version') {
          const value = /^\s*:\s*("(?:\\.|[^"\\])*")/.exec(before.slice(tokens.lastIndex));
          if (!value) continue;
          const start = tokens.lastIndex + value[0].length - value[1].length;
          after = before.slice(0, start) + JSON.stringify(target) + before.slice(start + value[1].length);
          break;
        }
      }
      if (!after) throw new Error(`Cannot locate version: ${path}`);
      changes.push({ path, after, diffs: [`version: ${pkg.version} -> ${target}`] });
    }
    return pkg.version;
  }

  const rootPackage = join(root, 'package.json');
  const current = JSON.parse(await readFile(rootPackage, 'utf8')).version;
  version ??= current;
  const parsed = typeof version === 'string' && semver.exec(version);
  if (!parsed) throw new Error('Version must be valid SemVer (X.Y.Z with optional prerelease/build metadata)');
  await packageVersion(rootPackage, version);
  for (const folder of ['apps', 'packages']) {
    const entries = await readdir(join(root, folder), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const path = join(root, folder, entry.name, 'package.json');
      try {
        await packageVersion(path, version);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  const path = join(root, 'apps/ios/ios/App/App.xcodeproj/project.pbxproj');
  const before = await readFile(path, 'utf8');
  let after = before;
  const diffs = [];
  const settings = [['MARKETING_VERSION', parsed.slice(1, 4).join('.')]];
  if (build !== undefined) settings.push(['CURRENT_PROJECT_VERSION', build]);
  for (const [key, target] of settings) {
    let count = 0;
    after = after.replace(new RegExp(`(\\b${key}\\s*=\\s*)([^;]+)(;)`, 'g'), (match, prefix, old, suffix) => {
      count++;
      if (old.trim() === target) return match;
      diffs.push(`${key}: ${old.trim()} -> ${target}`);
      return `${prefix}${target}${suffix}`;
    });
    if (!count) throw new Error(`Missing ${key} in ${relative(root, path)}`);
  }
  if (after !== before) changes.push({ path, after, diffs });

  for (const change of changes) {
    console.log(`${relative(root, change.path)}\n${change.diffs.map(diff => `  ${diff}`).join('\n')}`);
  }
  if (write) {
    // The root is first in the plan, so --set updates the source before its consumers.
    for (const change of changes) await writeFile(change.path, change.after);
  }
  console.log(changes.length ? `${write ? 'Updated' : 'Would update'} ${changes.length} file(s).` : 'Versions are in sync.');
  if (!write && changes.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
