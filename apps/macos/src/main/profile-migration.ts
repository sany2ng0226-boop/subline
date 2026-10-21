import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function migrateLegacyProfile({ targetDir, sourceDirs, log = console.log }: {
  targetDir: string;
  sourceDirs: string[];
  log?: (message: string) => void;
}): void {
  const report = (message: string) => {
    try { log(`[profile-migration] ${message}`); } catch { /* Logging must not prevent startup. */ }
  };
  const exists = (file: string) => {
    try { fs.lstatSync(file); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  let failed = false;
  const attempt = (operation: () => void) => {
    try { operation(); } catch (error) { failed = true; report(String(error)); }
  };
  attempt(() => {
    const marker = path.join(targetDir, '.profile-migrated.json');
    if (exists(marker)) return;
    fs.mkdirSync(targetDir, { recursive: true });
    const sources: string[] = [];
    const transfer = (source: string, target: string, model: boolean) => {
      if (exists(target)) return;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (model) {
        try {
          fs.linkSync(source, target);
          report(`Linked ${source} -> ${target}`);
          return;
        } catch (error) {
          if (exists(target)) return;
          report(`Link unavailable for ${source}: ${String(error)}; copying`);
        }
      }
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
        if (exists(target)) return;
        fs.renameSync(temporary, target);
        report(`Copied ${source} -> ${target}`);
      } finally {
        if (exists(temporary)) fs.unlinkSync(temporary);
      }
    };
    const walk = (source: string, target: string) => {
      if (!exists(source)) return;
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || /(?:\.(?:part|tmp|temp)(?:\.|$)|~$)/i.test(entry.name)) continue;
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (entry.isDirectory()) attempt(() => walk(from, to));
        else if (entry.isFile()) attempt(() => transfer(from, to, true));
      }
    };
    for (const source of sourceDirs) {
      attempt(() => {
        if (path.resolve(source) === path.resolve(targetDir) || !exists(source)) return;
        if (fs.realpathSync(source) === fs.realpathSync(targetDir)) return;
        sources.push(source);
        walk(path.join(source, 'models'), path.join(targetDir, 'models'));
        for (const name of ['archives.json', 'archive-library.json', 'settings.json']) {
          const from = path.join(source, name);
          attempt(() => {
            if (exists(from) && fs.lstatSync(from).isFile()) transfer(from, path.join(targetDir, name), false);
          });
        }
      });
    }
    // A partial migration is retried on the next launch; existing destination files still win.
    if (!failed) {
      fs.writeFileSync(marker, JSON.stringify({ sources, time: new Date().toISOString() }, null, 2), { flag: 'wx' });
      report(`Migration complete from ${sources.length} source(s)`);
    }
  });
}
