/**
 * Кириллические шрифты для PDFKit.
 *
 * Встроенные Helvetica/Helvetica-Bold — AFM-шрифты с WinAnsi-кодировкой,
 * кириллицу они НЕ содержат. Поэтому все генераторы lib/pdf пишут шрифтами
 * `FONT_BODY` / `FONT_BOLD` — DejaVu Sans (свободная лицензия,
 * public/fonts/DejaVu-LICENSE.txt), зарегистрированным ПОД СВОИМИ ИМЕНАМИ.
 *
 * ── Почему не под именем 'Helvetica' (аудит П3, #22, 24.09) ────────────────
 *
 * До 24.09 DejaVu регистрировался под именами встроенных шрифтов в расчёте,
 * что «зарегистрированные перекрывают стандартные». Для обычного начертания
 * это не работало НИКОГДА: конструктор PDFDocument сам зовёт
 * `font('Helvetica')` (initFonts, pdfkit 0.20.2) и кладёт стандартную
 * Helvetica в кэш `_fontFamilies['Helvetica']`, а `font()` смотрит в кэш
 * раньше, чем в реестр. Жирное выходило кириллицей только потому, что
 * 'Helvetica-Bold' в кэше не было. Итог: в ваучере и договоре весь обычный
 * текст — ФИО, тур, дата, пункты договора — был кракозябрами.
 *
 * Свои имена в кэше конструктора не встречаются, поэтому регистрация
 * срабатывает всегда. Сразу после регистрации документ переключается на
 * FONT_BODY — стандартная Helvetica из конструктора остаётся неиспользованной
 * и в PDF не встраивается (сторож pdf-cyrillic-fonts: `/BaseFont /Helvetica`
 * в документе быть не должно).
 *
 * ВАЖНО: только БУФЕРАМИ, не путями. Бандл pdfkit (js/pdfkit.js) собран
 * с виртуальной файловой системой и не умеет открывать реальные пути —
 * registerFont(<path>) падает «Not a supported font format». Файл читаем
 * сами настоящим fs и отдаём pdfkit готовый Buffer.
 */

import path from 'path';
import fs from 'fs';

const FONTS_DIR = path.join(process.cwd(), 'public', 'fonts');

function readFont(file: string): Buffer | null {
  try {
    const p = path.join(FONTS_DIR, file);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  } catch (err) {
    // Не глушим (§4.0): без шрифта документ выйдет латиницей-кракозябрами.
    console.error('[pdf/fonts] не прочитан шрифт', file, err instanceof Error ? err.message : err);
    return null;
  }
}

// Читаются один раз на процесс (~1.4 МБ суммарно)
const REGULAR = readFont('DejaVuSans.ttf');
const BOLD = readFont('DejaVuSans-Bold.ttf');

/** Есть ли кириллический шрифт (для smoke-тестов и health-проверок). */
export const DEFAULT_PDF_FONT: Buffer | null = REGULAR;

/** Имя обычного начертания во всех генераторах lib/pdf. */
export const FONT_BODY = 'Body';
/** Имя жирного начертания во всех генераторах lib/pdf. */
export const FONT_BOLD = 'Body-Bold';

export function registerCyrillicFonts(doc: PDFKit.PDFDocument): void {
  // Нет файла — имя всё равно регистрируется, на стандартную Helvetica:
  // генераторы не должны падать на `font('Body')`. Кириллицы тогда не
  // будет, и об этом уже сказано в логе выше.
  doc.registerFont(FONT_BODY, REGULAR ?? 'Helvetica');
  doc.registerFont(FONT_BOLD, BOLD ?? 'Helvetica-Bold');
  doc.font(FONT_BODY);
}
