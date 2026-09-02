/**
 * Сторож: путь к фото лежит СТРОГО внутри каталога загрузок.
 *
 * До 01.09 `/api/photos` сравнивал префикс без разделителя:
 * `filePath.startsWith('/tmp/tourhab-uploads')`. Сосед
 * `/tmp/tourhab-uploads-x/...` начинается с той же строки и проходил.
 * Эксплуатируемость низкая (нужен соседний каталог с таким префиксом), но
 * это классическая форма ошибки, и чинится она одним `path.relative`.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { isInsideUploadRoot } from '@/app/api/photos/[...path]/route';

const ROOT = path.resolve('/tmp', 'tourhab-uploads');

describe('isInsideUploadRoot', () => {
  it('файл внутри каталога — да', () => {
    expect(isInsideUploadRoot(path.resolve(ROOT, 'images', 'a', 'b.jpg'), ROOT)).toBe(true);
  });

  it('сосед с тем же префиксом — нет', () => {
    expect(isInsideUploadRoot(path.resolve('/tmp', 'tourhab-uploads-x', 'b.jpg'), ROOT)).toBe(false);
  });

  it('выход через .. — нет', () => {
    expect(isInsideUploadRoot(path.resolve(ROOT, '..', 'etc', 'passwd'), ROOT)).toBe(false);
  });

  it('сам корень — не файл', () => {
    expect(isInsideUploadRoot(ROOT, ROOT)).toBe(false);
  });

  it('роут строит путь через resolve, а не join+startsWith', () => {
    // Держит форму починки: join нормализует `..`, но startsWith без
    // разделителя пропускает соседа.
    const fs = require('fs') as typeof import('fs');
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/photos/[...path]/route.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/filePath\.startsWith\(UPLOAD_ROOT\)/);
    expect(src).toMatch(/isInsideUploadRoot\(filePath\)/);
  });
});
