/**
 * GET /api/photos/images/:dir/:filename
 *
 * Отдаёт загруженные фото из /tmp/tourhab-uploads/
 * Нужен на Timeweb где public/ — read-only в standalone-билде.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';

const UPLOAD_ROOT = path.resolve('/tmp', 'tourhab-uploads');

/**
 * Лежит ли путь СТРОГО внутри каталога загрузок.
 *
 * До 01.09 проверка была `filePath.startsWith(UPLOAD_ROOT)` — без
 * разделителя. Сосед `/tmp/tourhab-uploads-x/...` начинается с той же строки
 * и проходил. Сравнение через `relative`: пустая строка — сам корень (не
 * файл), `..` в начале — вышли наружу, абсолютный путь — другой диск.
 */
export function isInsideUploadRoot(filePath: string, root: string = UPLOAD_ROOT): boolean {
  const rel = path.relative(root, filePath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path;

  // Валидация: только images/{dir}/{filename}.jpg
  if (!segments || segments.length < 2) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Защита от path traversal — с разделителем, см. isInsideUploadRoot.
  const filePath = path.resolve(UPLOAD_ROOT, ...segments);
  if (!isInsideUploadRoot(filePath)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : 'application/octet-stream';

    return new NextResponse(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}
