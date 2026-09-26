/**
 * Что лежит в байтах картинки — по сигнатуре, а не по словам клиента.
 *
 * `File.type` и расширение имени задаёт ОТПРАВИТЕЛЬ: до 26.09 /api/upload
 * верил им обоим, принимал image/svg+xml (SVG — это документ со скриптами,
 * отданный с нашего хранилища) и сохранял файл под расширением из имени.
 * Здесь тип выводится из первых байт, и расширение — из выведенного типа.
 *
 * Разрешены ровно три формата витрины: JPEG, PNG, WebP.
 */

export type SniffedImage = { mime: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp' };

export function sniffImage(buf: Uint8Array): SniffedImage | null {
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= PNG.length && PNG.every((b, i) => buf[i] === b)) {
    return { mime: 'image/png', ext: 'png' };
  }
  // WebP: "RIFF" ???? "WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}
