import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { buildPack, PackError, type Pack, type PackFile } from './pack';

export const ZIP_LIMITS = { bytes: 5 * 1024 * 1024, unpacked: 20 * 1024 * 1024, files: 500 };

/**
 * Reads a pack zip. Only JSON at the top level (or inside one wrapping folder) is read; images under assets/ are
 * allowed and ignored for now. Anything that could run, and any path that climbs out of the zip, is refused.
 */
export function readPackZip(zip: Uint8Array): Pack {
  if (zip.byteLength > ZIP_LIMITS.bytes) throw problem('', `檔案太大（上限 ${ZIP_LIMITS.bytes / 1024 / 1024} MB）`);
  let total = 0, count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter: (f) => {
        if (++count > ZIP_LIMITS.files) throw problem('', `檔案數量太多（上限 ${ZIP_LIMITS.files}）`);
        if ((total += f.originalSize) > ZIP_LIMITS.unpacked) throw problem('', '解壓縮後太大');
        return !f.name.endsWith('/');
      },
    });
  } catch (e) {
    if (e instanceof PackError) throw e;
    throw problem('', '不是有效的 zip 檔');
  }
  const names = Object.keys(entries);
  for (const n of names) {
    if (n.includes('..') || n.startsWith('/') || n.includes('\\')) throw problem(n, '路徑不合法');
  }
  // A zip made by right-clicking a folder wraps everything in that folder; look inside it.
  const prefix = names.every((n) => n.includes('/')) && new Set(names.map((n) => n.split('/')[0])).size === 1 ? `${names[0].split('/')[0]}/` : '';
  const files: Partial<Record<PackFile, unknown>> = {};
  for (const n of names) {
    const rel = n.slice(prefix.length);
    if (rel.startsWith('assets/')) {
      if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(rel)) throw problem(rel, 'assets 只能放圖片');
      continue;
    }
    if (rel.startsWith('__MACOSX/') || rel.endsWith('.DS_Store')) continue;
    if (!/^[a-z]+\.json$/.test(rel)) throw problem(rel, '規則包只能有 JSON 檔與 assets/ 底下的圖片');
    try {
      files[rel.slice(0, -5) as PackFile] = JSON.parse(new TextDecoder().decode(entries[n]));
    } catch {
      throw problem(rel, 'JSON 格式錯誤');
    }
  }
  return buildPack(files);
}

/** Loads a pack kept as a folder of JSON files, such as the built-in packs under packs/. */
export function readPackDir(dir: string): Pack {
  const files: Partial<Record<PackFile, unknown>> = {};
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) files[f.slice(0, -5) as PackFile] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return buildPack(files);
}

function problem(file: string, message: string) {
  return new PackError([{ file, path: '', message }]);
}
