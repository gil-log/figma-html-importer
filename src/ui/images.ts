/**
 * images.ts — 직렬화된 트리가 참조하는 이미지를 바이트로 받아온다
 *
 * Figma 샌드박스는 네트워크·디코딩을 못 하므로 UI 에서 받아서 넘긴다.
 * figma.createImage 는 PNG·JPEG·GIF 만, 최대 4096px 만 받으므로 그 밖의 형식(SVG·WebP·AVIF)이나
 * 큰 이미지는 canvas 로 다시 그려 PNG 로 바꾼다.
 */
import type { DomNodeData, ImageAsset } from '../types';

const MAX_SIZE = 4096;
const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 6;

/** 트리의 <img>/<canvas>/<video poster> 와 CSS background-image url() 수집 */
export function collectImageUrls(root: DomNodeData): string[] {
  const urls = new Set<string>();
  const visit = (n: DomNodeData) => {
    if (n.imageUrl) urls.add(n.imageUrl);
    for (const m of (n.style.backgroundImage || '').matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) urls.add(m[1]);
    n.children.forEach(visit);
  };
  visit(root);
  return Array.from(urls);
}

function isFigmaFormat(b: Uint8Array): boolean {
  return (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) || // PNG
    (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // JPEG
    (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46); // GIF
}

function decode(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = URL.createObjectURL(blob);
  });
}

async function toPng(img: HTMLImageElement): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const w0 = img.naturalWidth || img.width || 1;
  const h0 = img.naturalHeight || img.height || 1;
  const scale = Math.min(1, MAX_SIZE / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('encode failed');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w0, height: h0 };
}

async function loadOne(url: string): Promise<ImageAsset | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const img = await decode(blob);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    URL.revokeObjectURL(img.src);
    if (isFigmaFormat(bytes) && Math.max(width, height) <= MAX_SIZE) return { bytes, width, height };
    return await toPng(img);
  } catch {
    // CORS 로 막혔거나 네트워크 오류 → Figma 쪽에서 회색 자리표시로 그린다
    return null;
  }
}

/** 한 번의 가져오기 안에서 URL 별 결과를 재사용한다 (여러 폭을 나란히 가져올 때 같은 이미지를 다시 받지 않게) */
export type ImageCache = Map<string, Promise<ImageAsset | null>>;

/** URL → 이미지 바이트. 받지 못한 URL 은 빠진다 */
export async function loadImages(urls: string[], cache: ImageCache = new Map()): Promise<Record<string, ImageAsset>> {
  const out: Record<string, ImageAsset> = {};
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      let pending = cache.get(url);
      if (!pending) {
        pending = loadOne(url);
        cache.set(url, pending);
      }
      const asset = await pending;
      if (asset) out[url] = asset;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return out;
}
