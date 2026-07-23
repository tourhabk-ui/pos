/**
 * Клиентское сжатие фото перед отправкой (чат Кузьмича и т.п.).
 *
 * Телефоны снимают фото на 8–15 МБ, а бэкенд принимает до 5 МБ. Раньше это был
 * тупик: `alert('слишком большое')` и всё. Теперь большое фото прозрачно
 * ужимается в браузере (canvas → JPEG) под лимит — турист просто отправляет
 * снимок, не думая про мегабайты. Ведар: деградировать достойно, не отказывать.
 *
 * Только браузер (canvas/createImageBitmap). Возвращает и файл, и dataURL —
 * dataURL уже посчитан из результата, второй проход FileReader не нужен.
 */

export interface CompressedImage {
  /** Готовый к отправке файл (исходный, если сжатие не потребовалось). */
  file: File;
  /** data:URL результата — для превью и base64-пейлоада. */
  dataUrl: string;
  /** Пришлось ли сжимать (для честной подписи в UI). */
  compressed: boolean;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read error'));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', quality));
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') + '.jpg';
}

/**
 * Ужимает изображение под `maxBytes`, если оно больше. Сначала ограничивает
 * размерность (`maxDimension`), затем понижает качество и, при нужде, ещё и
 * масштаб, пока не влезет. Не-изображения и уже-мелкие файлы возвращает как есть.
 */
export async function compressImageToLimit(
  file: File,
  maxBytes = 5_000_000,
  maxDimension = 2048,
): Promise<CompressedImage> {
  if (!file.type.startsWith('image/') || file.size <= maxBytes) {
    return { file, dataUrl: await blobToDataUrl(file), compressed: false };
  }

  const bitmap = await createImageBitmap(file);
  let scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));

  // До 6 попыток: качество вниз, потом масштаб вниз. Останавливаемся, как только
  // блоб влезает в лимит либо упёрлись в разумный минимум качества/размера.
  let best: Blob | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    ctx.drawImage(bitmap, 0, 0, w, h);

    const quality = Math.max(0.4, 0.85 - attempt * 0.12);
    const blob = await canvasToBlob(canvas, quality);
    if (blob) {
      best = blob;
      if (blob.size <= maxBytes) break;
    }
    scale *= 0.8; // не влезло — уменьшаем и линейный размер
  }
  bitmap.close?.();

  if (!best) {
    // Canvas не сработал (напр. очень старый браузер) — отдаём исходник как есть.
    return { file, dataUrl: await blobToDataUrl(file), compressed: false };
  }

  const outFile = new File([best], baseName(file.name), { type: 'image/jpeg' });
  return { file: outFile, dataUrl: await blobToDataUrl(best), compressed: true };
}
