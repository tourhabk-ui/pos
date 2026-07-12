/**
 * Кириллические шрифты для PDFKit.
 *
 * Встроенные Helvetica/Helvetica-Bold — AFM-шрифты с WinAnsi-кодировкой,
 * кириллицу они НЕ содержат: русский текст в PDF превращался в кракозябры.
 * Регистрируем DejaVu Sans (свободная лицензия,
 * public/fonts/DejaVu-LICENSE.txt) ПОД ИМЕНАМИ встроенных шрифтов:
 * зарегистрированные перекрывают стандартные, все .font('Helvetica')
 * в генераторах отдают кириллицу без правок.
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
  } catch {
    return null;
  }
}

// Читаются один раз на процесс (~1.4 МБ суммарно)
const REGULAR = readFont('DejaVuSans.ttf');
const BOLD = readFont('DejaVuSans-Bold.ttf');

/** Есть ли кириллический шрифт (для smoke-тестов и health-проверок). */
export const DEFAULT_PDF_FONT: Buffer | null = REGULAR;

export function registerCyrillicFonts(doc: PDFKit.PDFDocument): void {
  try {
    if (REGULAR) doc.registerFont('Helvetica', REGULAR);
    if (BOLD) doc.registerFont('Helvetica-Bold', BOLD);
  } catch {
    // Файлы шрифтов недоступны — остаются встроенные (латиница)
  }
}
