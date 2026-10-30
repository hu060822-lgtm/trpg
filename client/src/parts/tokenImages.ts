import { useEffect, useState } from 'react';
import type { Api } from '../api';
import type { Token } from '../../../src/table/types';

/**
 * Token pictures: fetched once per token and version (the API needs the sign-in header, so an <img src> cannot fetch
 * them itself), kept as object URLs for the whole session, and shrunk in the browser before upload.
 */
const cache = new Map<string, Promise<string | null>>();

export function useTokenImages(api: Api, roomId: string, tokens: Token[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const wanted = tokens.filter((t) => t.imageVersion > 0).map((t) => `${t.id}:${t.imageVersion}`).join(',');
  useEffect(() => {
    let live = true;
    const list = wanted ? wanted.split(',') : [];
    void Promise.all(list.map(async (k) => {
      const [id] = k.split(':');
      const key = `${roomId}:${k}`;
      if (!cache.has(key)) cache.set(key, api.tokenImage(roomId, id).then((b) => URL.createObjectURL(b)).catch(() => { cache.delete(key); return null; }));
      return [id, await cache.get(key)!] as const;
    })).then((pairs) => { if (live) setUrls(Object.fromEntries(pairs.filter((p): p is readonly [string, string] => !!p[1]))); });
    return () => { live = false; };
  }, [api, roomId, wanted]);
  return urls;
}

/** Crops a picture to a square around its middle and shrinks it to 256 × 256, as WebP (PNG where WebP is missing). */
export async function shrinkImage(file: Blob, side = 256): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const s = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = side; canvas.height = side;
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - s) / 2, (bitmap.height - s) / 2, s, s, 0, 0, side, side);
  bitmap.close();
  const as = (type: string) => new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, 0.86));
  const webp = await as('image/webp');
  if (webp && webp.type === 'image/webp') return webp;
  const png = await as('image/png');
  if (!png) throw new Error('這張圖片讀不出來，換一張試試');
  return png;
}
