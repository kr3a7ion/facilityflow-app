/**
 * Resize a photo in the browser before it is uploaded.
 *
 * A phone camera writes 3–6 MB per shot. Twenty jobs a day at three shots each is
 * roughly 2 GB a month over the office wifi and into the nightly backup. At 1600px on
 * the long edge and JPEG quality 0.8 the same photo is around 250 KB and still shows
 * a cracked contactor perfectly well.
 */
export const MAX_EDGE = 1600;
export const QUALITY = 0.8;

export interface Prepared { blob: Blob; filename: string; originalBytes: number; bytes: number }

export async function prepareForUpload(file: File): Promise<Prepared> {
  const originalBytes = file.size;

  // PDFs and anything that is not an image go up untouched.
  if (!file.type.startsWith('image/')) {
    return { blob: file, filename: file.name, originalBytes, bytes: file.size };
  }

  try {
    // imageOrientation honours the EXIF rotation phones write, so photos taken
    // sideways do not arrive sideways.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob) throw new Error('toBlob failed');

    // If resizing somehow made it bigger (a tiny PNG, say), keep the original.
    if (blob.size >= originalBytes && scale === 1) {
      return { blob: file, filename: file.name, originalBytes, bytes: file.size };
    }
    return {
      blob,
      filename: file.name.replace(/\.[^.]+$/, '') + '.jpg',
      originalBytes,
      bytes: blob.size,
    };
  } catch {
    // Canvas is unavailable or the file is not decodable — send what we were given
    // and let the server's size limit be the backstop.
    return { blob: file, filename: file.name, originalBytes, bytes: file.size };
  }
}

export function humanBytes(n: number): string {
  // Gigabytes matter now that this also reports free disk on the host: "26573.3 MB"
  // is a number somebody has to divide in their head before it means anything.
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(n < 10737418240 ? 1 : 0)} GB`;
}
