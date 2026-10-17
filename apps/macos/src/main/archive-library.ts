import fs from 'node:fs/promises';
import type { ArchiveLibrary, ArchiveRecord } from '@rt/core';

interface LibraryData extends ArchiveLibrary {
  version: 1;
  records: Record<string, { name?: string; folderId?: string | null }>;
}

/** Sidecar metadata keeps existing archive bodies and identifiers untouched. */
export class ArchiveLibraryStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  private async read(): Promise<LibraryData> {
    let raw: string;
    try { raw = await fs.readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, folders: [], lastFolderId: null, records: {} };
      }
      throw error;
    }
    const data = JSON.parse(raw) as LibraryData;
    if (data.version !== 1 || !Array.isArray(data.folders) || !data.records
      || typeof data.records !== 'object' || Array.isArray(data.records)
      || data.folders.some((f) => !f || typeof f.id !== 'string' || typeof f.name !== 'string')) {
      throw new Error('Invalid archive library; original file preserved');
    }
    return data;
  }

  private change(update: (data: LibraryData) => void): Promise<ArchiveLibrary> {
    const next = this.chain.then(async () => {
      const data = await this.read();
      update(data);
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data, null, 2));
      await fs.rename(tmp, this.file);
      return { folders: data.folders, lastFolderId: data.lastFolderId };
    });
    this.chain = next.catch(() => {});
    return next;
  }

  async library(): Promise<ArchiveLibrary> {
    await this.chain;
    const { folders, lastFolderId } = await this.read();
    return { folders, lastFolderId: folders.some((f) => f.id === lastFolderId) ? lastFolderId : null };
  }

  async decorate(records: ArchiveRecord[]): Promise<ArchiveRecord[]> {
    await this.chain;
    const data = await this.read();
    return records.map((r) => {
      const patch = Object.hasOwn(data.records, r.id) ? data.records[r.id] : {};
      const folderId = patch.folderId !== undefined ? patch.folderId : r.folderId;
      return { ...r, ...patch, folderId: data.folders.some((f) => f.id === folderId) ? folderId : null };
    });
  }

  createFolder(name: string): Promise<ArchiveLibrary> {
    return this.change((data) => {
      const clean = this.name(name);
      if (data.folders.some((f) => f.name === clean)) throw new Error('Folder already exists');
      data.folders.push({ id: `f${crypto.randomUUID()}`, name: clean });
    });
  }

  renameFolder(id: string, name: string): Promise<ArchiveLibrary> {
    return this.change((data) => {
      const folder = data.folders.find((f) => f.id === id);
      if (!folder) throw new Error('Folder not found');
      const clean = this.name(name);
      if (data.folders.some((f) => f.id !== id && f.name === clean)) throw new Error('Folder already exists');
      folder.name = clean;
    });
  }

  update(id: string, patch: { name?: string; folderId?: string | null }): Promise<ArchiveLibrary> {
    return this.change((data) => {
      if (patch.folderId !== undefined && patch.folderId !== null
        && !data.folders.some((f) => f.id === patch.folderId)) throw new Error('Folder not found');
      const previous = Object.hasOwn(data.records, id) ? data.records[id] : {};
      Object.defineProperty(data.records, id, { enumerable: true, configurable: true, writable: true,
        value: { ...previous,
          ...(patch.name !== undefined ? { name: this.name(patch.name) } : {}),
          ...(patch.folderId !== undefined ? { folderId: patch.folderId } : {}),
        },
      });
    });
  }

  remember(folderId: string | null): Promise<ArchiveLibrary> {
    return this.change((data) => {
      if (folderId !== null && !data.folders.some((f) => f.id === folderId)) throw new Error('Folder not found');
      data.lastFolderId = folderId;
    });
  }

  private name(value: string): string {
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 120) throw new Error('Invalid name');
    return value.trim();
  }
}
