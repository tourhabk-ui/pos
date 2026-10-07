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

describe('подпись места и разрешение на публикацию (владелец 04.10)', () => {
  const FORM = readFileSync('components/places/PhotoUpload.tsx', 'utf8');
  const API = readFileSync('app/api/places/[id]/photos/route.ts', 'utf8');
  const MIG = readFileSync('migrations/1164_user_place_photos_publish_consent.sql', 'utf8');

  it('подпись по умолчанию — название места', () => {
    expect(FORM).toMatch(/useState\(placeName\)/);
  });

  it('без галочки кнопка неактивна и согласие уходит на сервер', () => {
    expect(FORM).toMatch(/disabled=\{busy \|\| !consent\}/);
    expect(FORM).toMatch(/fd\.append\('publish_consent', 'yes'\)/);
  });

  it('сервер отказывает без согласия ДО хранилища и пишет момент согласия', () => {
    const consentAt = API.indexOf("formData.get('publish_consent') !== 'yes'");
    const uploadAt = API.indexOf('uploadToS3(');
    expect(consentAt).toBeGreaterThan(-1);
    expect(consentAt).toBeLessThan(uploadAt);
    expect(API).toMatch(/publish_consent_at, phash\)\s*VALUES \(\$1, \$2, \$3, \$4, \$5, NOW\(\), \$6\)/);
  });

  it('колонка заведена миграцией, у старых строк — NULL, а не выдуманное «да»', () => {
    expect(MIG).toMatch(/ADD COLUMN IF NOT EXISTS publish_consent_at TIMESTAMPTZ;/);
    expect(MIG).not.toMatch(/DEFAULT|UPDATE/);
  });
});
