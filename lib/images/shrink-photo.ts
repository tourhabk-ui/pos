/**
 * Сжатие полевого снимка на телефоне перед отправкой.
 *
 * Извлечено из формы /field-check (владелец 21.08) при переносе
 * «Наблюдения» на экран маршрута: два полевых контура — проверки записей и
 * наблюдения — сжимают фото ОДНИМ способом, иначе лимиты приёмников
 * (MAX_BYTES у обоих photo-роутов) разойдутся с тем, что шлют телефоны.
 *
 * Возвращает base64 без префикса data:. Старый браузер или битый файл —
 * null: снимка не будет, но запись уйдёт (фото не блокирует отправку).
 */

export const PHOTO_MAX_SIDE = 1280;
export const PHOTO_QUALITY = 0.72;

export async function shrinkPhoto(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const url = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
    const comma = url.indexOf(',');
    return comma < 0 ? null : url.slice(comma + 1);
  } catch {
    return null;
  }
}
