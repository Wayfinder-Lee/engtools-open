/**
 * 手机端照片质量与压缩。
 * - compressForUpload：EXIF 摆正 + 压缩到 ≤1.4M chars（服务端 413 红线），长边底线 1280
 * - analyzeQuality：256px 缩略上的亮度均值 + 拉普拉斯方差，只打角标不弹卡
 */

/** 服务端硬上限（mupload.js MAX_DATAURL_CHARS）留 1% 余量。 */
const MAX_CHARS = 1_400_000;

export interface CompressResult {
  dataUrl: string;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// 解码（含 EXIF 方向处理）
// ---------------------------------------------------------------------------

/**
 * 读 JPEG EXIF orientation（1-8）。零依赖 ~20 行：APP1 → TIFF → IFD0 → tag 0x0112。
 * 只在老内核（不认 EXIF 的 X5 等）回退路径里用；现代浏览器解码时已自动摆正。
 */
function readExifOrientation(buf: ArrayBuffer): number {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 <= v.byteLength) {
    const marker = v.getUint16(off);
    off += 2;
    if (marker === 0xffe1 && v.getUint32(off + 2) === 0x45786966) { // 'Exif'
      const tiff = off + 8;
      const little = v.getUint16(tiff) === 0x4949;
      const u16 = (p: number) => v.getUint16(p, little);
      const u32 = (p: number) => v.getUint32(p, little);
      const ifd = tiff + u32(tiff + 4);
      const n = u16(ifd);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (u16(e) === 0x0112) return u16(e + 8) || 1;
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00) break;
    off += v.getUint16(off); // 段长度，跳到下一段
  }
  return 1;
}

/** 按 EXIF orientation 生成摆正用的 canvas 变换参数。 */
function orientationTransform(o: number, w: number, h: number): { cw: number; ch: number; tf: [number, number, number, number, number, number] } {
  // 5-8 交换宽高；矩阵把原图各角映射到摆正后的位置
  switch (o) {
    case 2: return { cw: w, ch: h, tf: [-1, 0, 0, 1, w, 0] };
    case 3: return { cw: w, ch: h, tf: [-1, 0, 0, -1, w, h] };
    case 4: return { cw: w, ch: h, tf: [1, 0, 0, -1, 0, h] };
    case 5: return { cw: h, ch: w, tf: [0, 1, 1, 0, 0, 0] };
    case 6: return { cw: h, ch: w, tf: [0, 1, -1, 0, h, 0] };
    case 7: return { cw: h, ch: w, tf: [0, -1, -1, 0, h, w] };
    case 8: return { cw: h, ch: w, tf: [0, -1, 1, 0, 0, w] };
    default: return { cw: w, ch: h, tf: [1, 0, 0, 1, 0, 0] };
  }
}

/**
 * 解码为摆正后的位图。优先 createImageBitmap({imageOrientation:'from-image'})；
 * 失败回退 <img>，且只在「引擎确实不按 EXIF 摆正」时才手动预旋转。
 * ⚠️ iOS 13–14 的 WKWebView（微信 iOS 内核）没有 createImageBitmap，但 <img>/drawImage
 * 已自动摆正（与 CSS image-orientation: from-image 同批落地）——对这种引擎再手动旋转
 * 会双重旋转，上传照片横躺。用 CSS.supports 探测引擎是否自动摆正（不支持该属性的老
 * X5 恰好也是不自动摆正的那批）。
 */
async function decodeOriented(file: File): Promise<{ src: CanvasImageSource; w: number; h: number; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { src: bmp, w: bmp.width, h: bmp.height, release: () => bmp.close() };
    } catch { /* 落到 <img> 路径 */ }
  }
  let engineOrientsExif = false;
  try {
    engineOrientsExif = typeof CSS !== 'undefined' && CSS.supports?.('image-orientation', 'from-image') === true;
  } catch { engineOrientsExif = false; }
  const buf = await file.slice(0, 128 * 1024).arrayBuffer();
  const orientation = readExifOrientation(buf);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    const url = URL.createObjectURL(file);
    el.onload = () => { URL.revokeObjectURL(url); resolve(el); };
    el.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    el.src = url;
  });
  if (orientation === 1 || engineOrientsExif) {
    // 无需摆正 / 引擎已自动摆正：原样绘制
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return { src: canvas, w: canvas.width, h: canvas.height, release: () => { canvas.width = 0; canvas.height = 0; } };
  }
  const { cw, ch, tf } = orientationTransform(orientation, img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(...tf);
  ctx.drawImage(img, 0, 0);
  return { src: canvas, w: cw, h: ch, release: () => { canvas.width = 0; canvas.height = 0; } };
}

// ---------------------------------------------------------------------------
// 压缩
// ---------------------------------------------------------------------------

/** canvas → JPEG dataURL，方向已摆正的位图缩放到 maxPx。 */
function renderToDataUrl(src: CanvasImageSource, w: number, h: number, maxPx: number, quality: number): string {
  let { width, height } = { width: w, height: h };
  if (Math.max(width, height) > maxPx) {
    const ratio = maxPx / Math.max(width, height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * 压缩到可上传：1600/0.75 起步；超 1.4M chars 逐级降 (1280, 0.6)、(1280, 0.45)。
 * 底线 1280 —— 不再缩边，只降质量；仍超就原样返回（服务端会 413，比糊掉强）。
 */
export async function compressForUpload(file: File): Promise<CompressResult> {
  const decoded = await decodeOriented(file);
  try {
    const steps: [number, number][] = [[1600, 0.75], [1280, 0.6], [1280, 0.45]];
    for (const [maxPx, q] of steps) {
      const dataUrl = renderToDataUrl(decoded.src, decoded.w, decoded.h, maxPx, q);
      if (dataUrl.length <= MAX_CHARS) {
        const [w, h] = scaledDims(maxPx, decoded.w, decoded.h);
        return { dataUrl, w, h };
      }
    }
    // 底线 1280 仍超：原样返回最后一级（服务端 413 兜底，不无限压）
    const dataUrl = renderToDataUrl(decoded.src, decoded.w, decoded.h, 1280, 0.45);
    const [w, h] = scaledDims(1280, decoded.w, decoded.h);
    return { dataUrl, w, h };
  } finally {
    decoded.release();
  }
}

function scaledDims(maxPx: number, ow: number, oh: number): [number, number] {
  if (Math.max(ow, oh) <= maxPx) return [ow, oh];
  const r = maxPx / Math.max(ow, oh);
  return [Math.round(ow * r), Math.round(oh * r)];
}

// ---------------------------------------------------------------------------
// 质量分析（只打角标：方差 < 60 → 糊；亮度 < 70 → 暗。阈值待真机校准）
// ---------------------------------------------------------------------------

export const BLUR_THRESHOLD = 60;
export const BRIGHT_THRESHOLD = 70;

export interface Quality {
  blur: number;   // 拉普拉斯方差，越低越糊
  bright: number; // 亮度均值 0-255
}

/** 256px 缩略上算亮度均值与拉普拉斯方差（零依赖，密集小字会有系统误差，仅作角标）。 */
export async function analyzeQuality(file: File): Promise<Quality> {
  const decoded = await decodeOriented(file);
  try {
    const s = 256;
    const k = Math.min(1, s / Math.max(decoded.w, decoded.h));
    const tw = Math.max(1, Math.round(decoded.w * k));
    const th = Math.max(1, Math.round(decoded.h * k));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(decoded.src, 0, 0, tw, th);
    const d = ctx.getImageData(0, 0, tw, th).data;
    const gray = new Float32Array(tw * th);
    let sum = 0;
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      const g = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      gray[i] = g;
      sum += g;
    }
    const bright = sum / gray.length;
    // 拉普拉斯方差（跳过 1px 边界）
    let lSum = 0;
    let lSq = 0;
    let n = 0;
    for (let y = 1; y < th - 1; y++) {
      for (let x = 1; x < tw - 1; x++) {
        const i = y * tw + x;
        const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - tw] - gray[i + tw];
        lSum += lap;
        lSq += lap * lap;
        n += 1;
      }
    }
    const mean = n ? lSum / n : 0;
    const blur = n ? lSq / n - mean * mean : 0;
    return { blur: Math.round(blur), bright: Math.round(bright) };
  } finally {
    decoded.release();
  }
}

// ---------------------------------------------------------------------------
// 缩略图（桌面轮询网格用；服务端 THUMB_MAX_CHARS=24000，超了宁可不带）
// ---------------------------------------------------------------------------

/** 生成 ~300px 缩略 dataURL；超过服务端上限返回 undefined（桌面端会再拉整图前先显示占位）。 */
export async function makeThumb(dataUrl: string): Promise<string | undefined> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('缩略图解码失败'));
    el.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  const maxPx = 300;
  let { width, height } = { width: img.naturalWidth, height: img.naturalHeight };
  if (Math.max(width, height) > maxPx) {
    const r = maxPx / Math.max(width, height);
    width = Math.round(width * r);
    height = Math.round(height * r);
  }
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
  const out = canvas.toDataURL('image/jpeg', 0.55);
  return out.length <= 24000 ? out : undefined;
}
