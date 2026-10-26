/**
 * 图片压缩：Canvas 缩放 + JPEG 输出。
 * 从 llm.ts 抽出（原样搬运）——扫码上传的移动端也要用，而不只是 OCR 前处理。
 */

/**
 * 压缩图片：用 Canvas 缩放到最长边 ≤ maxPx，再以指定 quality 输出 JPEG imageDataUrl。
 * 大幅减小 OCR 请求体，避免后端超限和超时。
 */
export async function compressImage(file: File, maxPx = 1600, quality = 0.75): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (Math.max(width, height) > maxPx) {
        const ratio = maxPx / Math.max(width, height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('Canvas not supported')); return; }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}
