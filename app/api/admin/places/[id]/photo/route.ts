/**
 * POST /api/admin/places/[id]/photo
 *
 * Upload a photo for a place. Server-side resize to canonical 1280x720 via sharp,
 * UPSERT into ai_route_images (linked to place via route_id = places.ark_id).
 *
 * FormData:
 *   file         — image (jpg/png/webp/heic), up to 20 MB
 *   author       — кто снял (необязательно): «Ю. Демянчук, ИВиС ДВО РАН»
 *   license      — на каких условиях: «© ИВиС ДВО РАН, с разрешения», «CC BY 4.0»
 *   license_url  — где прочитать условия
 *   source_url   — откуда взят снимок
 *   replace_hero — 'true': заменить главное фото, а не добавить в галерею
 *   partner_id   — снимок партнёра (1431): ляжет в галерею и покажется только
 *                  при его согласии на карточки мест; без поля партнёр
 *                  узнаётся по автору, совпавшему с именем ровно одного
 *
 * ВТОРОЙ СНИМОК НЕ СТИРАЕТ ПЕРВЫЙ (14.09). До этой правки у места могло быть
 * ровно одно фото: `ON CONFLICT (route_id) DO UPDATE` — загрузка второго
 * МОЛЧА уничтожала первое, и узнать об этом было неоткуда, потому что ответ
 * был тот же самый «ok». Владелец 14.09 прислал по пять кадров на место, и
 * класть их было некуда.
 *
 * Теперь: у места нет фото — снимок идёт героем; фото уже есть — снимок идёт
 * в галерею (`place_gallery_photos`, миграция 968) следующей позицией. Замена
 * героя осталась, но её надо СКАЗАТЬ вслух — `replace_hero=true`. Ответ
 * называет, куда лёг снимок (`slot`), а не молчит об этом.
 *
 * ПРАВА НА ЧУЖОЕ ФОТО (14.09). До этой правки путь ручной загрузки не писал
 * НИ ОДНОГО из четырёх полей, хотя колонки в `ai_route_images` есть и вики-путь
 * их заполняет. Снимок, полученный у правообладателя, ложился в базу без следа
 * того, чей он и на каких условиях, — а лицензия почти всегда требует видимого
 * указания автора. Повод предметный: владелец 14.09 решил брать фото вулканов
 * у вулканологов (ИВиС ДВО РАН / КВЕРТ) вместо ГВП, где снимки Камчатки помечены
 * знаком охраны того же института.
 *
 * Поля НЕОБЯЗАТЕЛЬНЫЕ: у собственного снимка внешнего автора нет, и требовать
 * его значило бы заставлять выдумывать (§4.0). Но если их не передали, старые
 * значения СНИМАЮТСЯ, а не остаются — см. UPSERT ниже.
 */

import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const MAX_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 720;
const JPEG_QUALITY = 85;

interface Props { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id: placeId } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(placeId)) {
    return NextResponse.json({ error: 'Неверный ID места' }, { status: 400 });
  }

  // Resolve ark_id (which is what ai_route_images.route_id references).
  const placeRow = await pool.query<{ ark_id: string | null; name: string }>(
    `SELECT ark_id, name FROM places WHERE id = $1 LIMIT 1`,
    [placeId],
  );
  if (placeRow.rows.length === 0) {
    return NextResponse.json({ error: 'Место не найдено' }, { status: 404 });
  }
  const arkId = placeRow.rows[0]!.ark_id;
  if (!arkId) {
    return NextResponse.json(
      { error: 'У места нет ark_id — невозможно привязать фото. Обратитесь к разработчику.' },
      { status: 422 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Неверный формат запроса' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Поле file обязательно' }, { status: 400 });
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: 'Файл слишком большой (макс. 20 МБ)' }, { status: 400 });
  }

  if (file.type && !ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: 'Допустимые форматы: JPG, PNG, WebP, HEIC' },
      { status: 400 },
    );
  }

  let processed: Buffer;
  try {
    const input = Buffer.from(await file.arrayBuffer());
    processed = await sharp(input, { failOn: 'truncated' })
      .rotate() // honour EXIF orientation
      .resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка обработки изображения';
    return NextResponse.json({ error: `Не удалось обработать файл: ${msg}` }, { status: 400 });
  }

  // Права на снимок. Пустая строка приравнивается к отсутствию: форма,
  // отправленная с незаполненным полем, шлёт '' — и хранить его значило бы
  // держать в базе «автор есть, зовут его никак».
  const rights = (key: string): string | null => {
    const v = formData.get(key);
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    return trimmed === '' ? null : trimmed.slice(0, 500);
  };
  const authorRaw  = rights('author');
  const license    = rights('license');
  const licenseUrl = rights('license_url');
  const sourceUrl  = rights('source_url');

  // Снимок партнёра (1431, ревью #3291). Кадр с `partner_id` показывается
  // только при согласии партнёра на карточки мест (galleryShownSql); кадр
  // без него — всегда. Значит партнёр должен проставляться и здесь, а не
  // только разовой миграцией: иначе снимок, подписанный именем партнёра,
  // обошёл бы согласие. Партнёр — из поля `partner_id` либо по автору, если
  // он слово в слово совпал с именем ровно одного партнёра. Такой снимок
  // ложится только в галерею: главный кадр согласием не управляется.
  let partner: { id: string; name: string } | null = null;
  const partnerField = rights('partner_id');
  try {
    if (partnerField) {
      if (!/^[0-9a-f-]{36}$/i.test(partnerField)) {
        return NextResponse.json({ error: 'Неверный partner_id' }, { status: 400 });
      }
      const r = await pool.query<{ id: string; name: string }>(
        `SELECT id::text, name FROM partners WHERE id = $1::uuid`, [partnerField]);
      if (!r.rows[0]) return NextResponse.json({ error: 'Партнёр не найден' }, { status: 404 });
      partner = r.rows[0];
    } else if (authorRaw) {
      const r = await pool.query<{ id: string; name: string }>(
        `SELECT id::text, name FROM partners WHERE lower(btrim(name)) = lower(btrim($1::text)) LIMIT 2`, [authorRaw]);
      if (r.rows.length === 1) partner = r.rows[0]!;
    }
  } catch (err) {
    console.error('[place-photo] не смог проверить, чей снимок:', arkId, (err as { code?: string })?.code ?? err);
    return NextResponse.json({ error: 'Не удалось проверить, чей снимок. Попробуйте ещё раз.' }, { status: 503 });
  }
  const author = partner ? partner.name : authorRaw;

  // Куда класть: герой или галерея. Решает НАЛИЧИЕ героя, а не догадка о
  // намерении — и решение уходит в ответ, чтобы загрузивший его видел.
  const heroRow = await pool.query(
    `SELECT 1 FROM ai_route_images WHERE route_id = $1 LIMIT 1`,
    [arkId],
  );
  const hasHero = (heroRow.rowCount ?? 0) > 0;
  const replaceHero = formData.get('replace_hero') === 'true';

  if ((hasHero && !replaceHero) || partner) {
    // Галерея: следующая свободная позиция. Позиция считается отдельным
    // запросом, а не `INSERT ... SELECT MAX(...)`: у такой формы параметрам
    // негде взять якорь типа, и она отвечает 42P08 «inconsistent types
    // deduced» ВСЕГДА, не иногда (CLAUDE.md §4, случай 24.08).
    //
    // Гонка двух загрузок разрешается уникальным индексом (ark_id, position)
    // и повтором: 23505 здесь значит «позицию заняли», а не «снимок плохой».
    let position = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = await pool.query<{ next: number }>(
        `SELECT COALESCE(MAX(position), 0) + 1 AS next
           FROM place_gallery_photos WHERE ark_id = $1`,
        [arkId],
      );
      position = Number(next.rows[0]?.next ?? 1);
      try {
        await pool.query(
          `INSERT INTO place_gallery_photos
             (ark_id, position, image_data, mime_type, width, height,
              author, license, license_url, source_url, partner_id)
           VALUES ($1, $2, $3, 'image/jpeg', $4, $5, $6, $7, $8, $9, $10::uuid)`,
          [arkId, position, processed, TARGET_WIDTH, TARGET_HEIGHT,
           author, license, licenseUrl, sourceUrl, partner?.id ?? null],
        );
        break;
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === '23505' && attempt < 2) continue;
        // Отказ не глушится: иначе «не смог записать» выглядело бы как
        // «записал» — ровно то, от чего §4.0.
        console.error('[place-photo] снимок не лёг в галерею:', arkId, position, code ?? err);
        return NextResponse.json(
          { error: 'Не удалось сохранить снимок в галерею. Попробуйте ещё раз.' },
          { status: 503 },
        );
      }
    }

    return NextResponse.json({
      ok: true,
      placeId,
      arkId,
      slot: 'gallery',
      position,
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      sizeKb: Math.round(processed.length / 1024),
      rights: { author, license, licenseUrl, sourceUrl },
      // Снимок партнёра виден на карточке только при его согласии на
      // карточки мест — загрузивший должен это знать, а не гадать.
      partner: partner ? { id: partner.id, name: partner.name, shownOnlyWithConsent: true } : null,
      url: `/api/images/place-gallery/${arkId}/${position}?t=${Date.now()}`,
    });
  }

  // UPSERT — replace existing AI-generated image if any.
  //
  // Четыре поля прав ОБЯЗАТЕЛЬНО перечислены и в INSERT, и в DO UPDATE. До
  // 14.09 их не было ни там, ни там, и это давало тихую подмену: заменив
  // снимок Wikimedia ручной загрузкой, строка сохраняла author и license
  // ПРЕЖНЕГО фото — карточка подписывала новое изображение чужим именем и
  // чужой лицензией. Ложная атрибуция хуже отсутствующей: она утверждает
  // права, которых нет, от имени человека, который этого не говорил.
  await pool.query(
    `INSERT INTO ai_route_images
       (route_id, image_data, mime_type, prompt, model, width, height,
        author, license, license_url, source_url)
     VALUES ($1, $2, 'image/jpeg', $3, 'manual-upload', $4, $5, $6, $7, $8, $9)
     ON CONFLICT (route_id) DO UPDATE
       SET image_data  = EXCLUDED.image_data,
           mime_type   = EXCLUDED.mime_type,
           prompt      = EXCLUDED.prompt,
           model       = EXCLUDED.model,
           width       = EXCLUDED.width,
           height      = EXCLUDED.height,
           author      = EXCLUDED.author,
           license     = EXCLUDED.license,
           license_url = EXCLUDED.license_url,
           source_url  = EXCLUDED.source_url,
           created_at  = now()`,
    [arkId, processed, `manual upload by admin for ${placeRow.rows[0]!.name}`,
     TARGET_WIDTH, TARGET_HEIGHT, author, license, licenseUrl, sourceUrl],
  );

  return NextResponse.json({
    ok: true,
    placeId,
    arkId,
    slot: 'hero',
    width: TARGET_WIDTH,
    height: TARGET_HEIGHT,
    sizeKb: Math.round(processed.length / 1024),
    // Что записано о правах — обратно в ответе, чтобы загрузивший видел, с
    // какой подписью снимок уйдёт на карточку, а не узнавал об этом с экрана.
    rights: { author, license, licenseUrl, sourceUrl },
    url: `/api/images/route/${arkId}?t=${Date.now()}`,
  });
}
