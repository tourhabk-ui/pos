/**
 * Подвал карточки места ведёт к форме загрузки на самой карточке, а не в
 * канал публикаций @kamchatka_real (решение владельца 04.10). Туда турист
 * писать не может, и ничто не возвращает снимок оттуда на карточку —
 * обещание без механизма.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const FOOTER = readFileSync('components/places/PlaceFooter.tsx', 'utf8');
const LINK = readFileSync('components/places/AddPhotoLink.tsx', 'utf8');
const CARD = readFileSync('app/places/[id]/_PlaceDetailClient.tsx', 'utf8');

describe('«Был тут? Добавь фото»', () => {
  it('подвал не зовёт загружать фото в канал', () => {
    expect(FOOTER).not.toMatch(/t\.me\/kamchatka_real/);
    expect(FOOTER).not.toMatch(/Поделись фото/);
    expect(FOOTER).toMatch(/<AddPhotoLink \/>/);
  });

  it('ссылка — якорь формы загрузки, раскрывающий <details>', () => {
    expect(LINK).toMatch(/href=\{`#\$\{PLACE_PHOTO_UPLOAD_ANCHOR\}`\}/);
    expect(LINK).toMatch(/closest\('details'\)/);
  });

  it('якорь стоит на PhotoUpload карточки места', () => {
    expect(CARD).toMatch(/<div id=\{PLACE_PHOTO_UPLOAD_ANCHOR\}[^>]*>\s*<PhotoUpload /);
  });
});
