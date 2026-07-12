/**
 * Кириллические шрифты для PDFKit.
 *
 * Встроенные Helvetica/Helvetica-Bold — это AFM-шрифты с WinAnsi-кодировкой,
 * кириллицу они НЕ содержат: русский текст в PDF превращался в кракозябры
 * («pdf нет» — скриншот владельца 2026-07-12). Регистрируем DejaVu Sans
 * (свободная лицензия, public/fonts/DejaVu-LICENSE.txt) ПОД ИМЕНАМИ
 * встроенных шрифтов: зарегистрированные шрифты в PDFKit перекрывают
 * стандартные, поэтому все .font('Helvetica') в генераторах начинают
 * отдавать кириллицу без правок.
 *
 * public/ копируется в standalone-образ (Dockerfile) — файлы доступны
 * по process.cwd()/public/fonts и в дев-режиме, и на проде.
 */

import path from 'path';
import fs from 'fs';

const FONTS_DIR = path.join(process.cwd(), 'public', 'fonts');

export function registerCyrillicFonts(doc: PDFKit.PDFDocument): void {
  try {
    const regular = path.join(FONTS_DIR, 'DejaVuSans.ttf');
    const bold = path.join(FONTS_DIR, 'DejaVuSans-Bold.ttf');
    if (fs.existsSync(regular)) doc.registerFont('Helvetica', regular);
    if (fs.existsSync(bold)) doc.registerFont('Helvetica-Bold', bold);
  } catch {
    // Файлы шрифтов недоступны — остаются встроенные (латиница)
  }
}
