import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

// createRelay serializes writes in its single-process transaction queue.
export function fileMaintenanceStore(stateFile) {
  const memory = new Map();
  const filename = key => stateFile + '.' + key + '.json';
  return {
    async get(key) {
      if (!stateFile) return { value: memory.get(key) ?? null };
      try { return { value: JSON.parse(await readFile(filename(key), 'utf8')) }; }
      catch (error) { if (error.code === 'ENOENT') return { value: null }; throw error; }
    },
    async put(key, value) {
      if (!stateFile) { memory.set(key, value); return; }
      const path = filename(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path + '.tmp', JSON.stringify(value), { mode: 0o600 });
      await rename(path + '.tmp', path);
    },
  };
}
