/**
 * Сторож пакетного сбора фото мест с Wikimedia Commons (19.09).
 *
 * Задача владельца: «фото мест нужны». Законный путь к ним был написан
 * заранее, не хватало пакетного прохода — его и добавили. Но проход ходит по
 * данным, где лежат ЧУЖИЕ снимки под CC и СВОИ снимки владельца, а таблица
 * держит один снимок на место (UNIQUE route_id, миграция 107). Значит цена
 * ошибки здесь — не пустой прогон, а затёртая фотография владельца или
 * опубликованный чужой снимок без имени автора.
 *
 * Поэтому сторож проверяет не «файл есть», а три предохранителя поимённо.
 * Проверка идёт по исходнику: поднять роут в тесте нельзя — он ходит в БД и в
 * чужой API, — а вопросы здесь структурные.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHOWN_MODELS, shownPhotoSql } from '@/lib/images/origin';
import { isFreeLicense, buildCandidate } from '@/lib/services/ingest/wikimedia-photos';
import { thumbMime } from '@/app/api/cron/place-photos-commons/route';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const SRC = read('app/api/cron/place-photos-commons/route.ts');

describe('предохранитель 1: свой снимок не затирается', () => {
  it('очередь берёт только места без ПОКАЗЫВАЕМОГО снимка', () => {
    // Единый предикат, а не свой литерал: правило показа живёт в одном месте
    // (урок 18.09 — оно было размножено по тринадцати файлам и разошлось).
    expect(SRC).toContain("shownPhotoSql('img.model')");
    expect(SRC).not.toMatch(/model\s+IN\s*\(\s*'wikimedia'/i);
  });

  it('перед записью условие проверяется ВТОРОЙ раз, внутри запроса', () => {
    // Между чтением очереди и записью проходят секунды сетевых запросов.
    // Проверка «сначала спросим, потом вставим» такую гонку не закрывает.
    const save = SRC.slice(SRC.indexOf('async function saveIfStillFree'));
    expect(save).toContain('ON CONFLICT (route_id) DO UPDATE');
    expect(save).toContain("shownPhotoSql('ai_route_images.model')");
    expect(save).toMatch(/WHERE\s+ai_route_images\.model IS NULL/);
  });

  it('пустой род назван отдельно — иначе место застряло бы навсегда', () => {
    // NULL IN (...) даёт NULL, а не «ложь»: без ветки IS NULL строка с
    // безымянным родом не обновилась бы ни разу.
    expect(SRC).toMatch(/ai_route_images\.model IS NULL\s*\n\s*OR NOT/);
  });

  it('фото владельца входит в показываемые — то есть под защиту', () => {
    expect(SHOWN_MODELS).toContain('real-photo');
    expect(shownPhotoSql('x')).toContain("'real-photo'");
  });
});

describe('предохранитель 2: без имени автора не публикуем', () => {
  it('кандидат выбирается по ПОЛНОЙ атрибуции, а не по близости', () => {
    expect(SRC).toMatch(/candidates\.find\(\(c\) =>\s*c\.author\.trim\(\) !== ''\s*&&\s*c\.license\.trim\(\) !== ''\)/);
  });

  it('кандидат без атрибуции даёт отдельный исход, а не тихий пропуск', () => {
    expect(SRC).toContain("status: 'no_attribution'");
  });

  it('несвободная лицензия отсекается до нас — проверено на форме', () => {
    expect(isFreeLicense('cc-by-sa-4.0', null)).toBe(true);
    expect(isFreeLicense('cc0', null)).toBe(true);
    expect(isFreeLicense(null, 'Public domain')).toBe(true);
    expect(isFreeLicense('fair use', 'Fair use')).toBe(false);
    expect(isFreeLicense(null, 'All rights reserved')).toBe(false);
  });

  it('снимок без свободной лицензии не становится кандидатом вовсе', () => {
    const page = {
      title: 'File:X.jpg', pageid: 1,
      imageinfo: [{
        url: 'https://upload.wikimedia.org/x.jpg', width: 2000, height: 1200,
        mime: 'image/jpeg',
        extmetadata: { License: { value: 'fair use' }, LicenseShortName: { value: 'Fair use' } },
      }],
    };
    expect(buildCandidate(page, 100)).toBeNull();
  });
});

describe('предохранитель 3: сухой прогон по умолчанию', () => {
  it('запись требует ЯВНОГО dry_run: false', () => {
    expect(SRC).toContain('parsed.data.dry_run !== false');
  });

  it('в сухом прогоне не пишется ничего, включая пометки', () => {
    // Обе записи стоят под `if (!dryRun)` либо в ветке после проверки.
    const marks = [...SRC.matchAll(/await markNoCandidate\(/g)];
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) {
      const before = SRC.slice(Math.max(0, m.index! - 60), m.index!);
      expect(before, 'markNoCandidate вне проверки dryRun').toContain('!dryRun');
    }
    // Сохранение снимка — после раннего выхода сухого прогона.
    expect(SRC.indexOf("status: 'would_save'")).toBeLessThan(SRC.indexOf('saveIfStillFree(place'));
  });
});

describe('третьи состояния названы, а не схлопнуты', () => {
  it('«не нашли», «не ответил чужой сервер» и «занято» — разные исходы', () => {
    for (const s of ['no_candidate', 'no_attribution', 'too_heavy', 'occupied', 'failed', 'saved', 'would_save']) {
      expect(SRC, s).toContain(`status: '${s}'`);
    }
  });

  it('отказ Commons НЕ помечается как «фото нет»', () => {
    // Иначе сбой сети на 30 дней вычеркнул бы место из очереди.
    const failBlock = SRC.slice(SRC.indexOf('Commons не ответил'), SRC.indexOf('if (candidates.length === 0)'));
    expect(failBlock).not.toContain('markNoCandidate');
  });

  it('пометка «не нашли» имеет СРОК — Commons пополняется', () => {
    expect(SRC).toContain('NO_CANDIDATE_TTL_DAYS');
    expect(SRC).toContain('make_interval(days => $5::int)');
  });

  it('пустая очередь называется вслух, а не выдаётся за успех', () => {
    expect(SRC).toContain('exhausted');
    expect(SRC).toContain('queue_size');
  });

  it('ни один отказ не глушится', () => {
    expect(SRC).not.toMatch(/catch\s*\{/);
    const errs = [...SRC.matchAll(/console\.error\('\[place-photos-commons\]/g)];
    expect(errs.length).toBeGreaterThanOrEqual(4);
  });
});

describe('форма запросов не воспроизводит известные дефекты', () => {
  it('не используется форма «вставь, если нет» — она отвечает 42P08', () => {
    // Случай 24.08: INSERT ... SELECT $1 ... WHERE NOT EXISTS не выполняется
    // НИКОГДА без якоря типа. Здесь взята форма VALUES + условие на DO UPDATE:
    // типы приходят из колонок, и выводить их не из чего.
    expect(SRC).not.toMatch(/INSERT\s+INTO[\s\S]{0,400}?WHERE\s+NOT\s+EXISTS/i);
  });

  it('интервал не собирается конкатенацией строк', () => {
    expect(SRC).not.toMatch(/\|\|\s*' days'/);
  });

  it('SQL параметризован, имена таблиц не склеиваются из ввода', () => {
    expect(SRC).not.toMatch(/FROM\s+\$\{/);
    expect(SRC).toContain('$1');
  });
});

describe('чужой сервис не долбится', () => {
  it('между местами есть пауза, а партия ограничена', () => {
    expect(SRC).toContain('PAUSE_MS');
    expect(SRC).toMatch(/batch:\s*z\.number\(\)\.int\(\)\.positive\(\)\.max\(25\)/);
  });

  it('роут закрыт CRON_SECRET, а не открыт миру', () => {
    expect(SRC).toContain('timingSafeCompare');
    expect(SRC).toContain("NextResponse.json({ error: 'Unauthorized' }, { status: 401 })");
  });

  it('объявлен в реестре планировщиков — молчание не ответ', () => {
    expect(read('lib/agents/cron-schedulers.ts')).toContain("'place-photos-commons'");
  });
});

describe('кладётся превью, а не оригинал', () => {
  it('ширину превью рендерит Commons, sharp не зовётся', () => {
    expect(SRC).toContain('thumbWidth: THUMB_WIDTH');
    // sharp у нас импортируется тремя роутами, но в package.json не объявлен —
    // лежит транзитивно от next. Новый крон на него не опирается.
    expect(SRC).not.toContain("from 'sharp'");
  });

  it('тяжёлое сверх порога не кладётся и называет себя', () => {
    expect(SRC).toContain('MAX_BYTES');
    expect(SRC).toContain("status: 'too_heavy'");
  });

  it('тип превью выводится из его адреса, с запасом на тип оригинала', () => {
    expect(thumbMime('https://x/y.jpg', 'image/png')).toBe('image/jpeg');
    expect(thumbMime('https://x/y.JPEG', 'image/png')).toBe('image/jpeg');
    expect(thumbMime('https://x/y.png', 'image/jpeg')).toBe('image/png');
    expect(thumbMime('https://x/y.webp', 'image/jpeg')).toBe('image/webp');
    // Расширения нет — врать не о чем, берём тип оригинала.
    expect(thumbMime('https://x/thumb', 'image/jpeg')).toBe('image/jpeg');
  });

  it('размеры превью берутся у Commons, а не вычисляются из пропорций', () => {
    const page = {
      title: 'File:X.jpg', pageid: 2,
      imageinfo: [{
        url: 'https://upload.wikimedia.org/x.jpg',
        thumburl: 'https://upload.wikimedia.org/thumb/x.jpg',
        thumbwidth: 1280, thumbheight: 853,
        width: 4000, height: 2667, mime: 'image/jpeg',
        extmetadata: {
          License: { value: 'cc-by-sa-4.0' },
          LicenseShortName: { value: 'CC BY-SA 4.0' },
          Artist: { value: '<a href="/x">Иван Петров</a>' },
        },
      }],
    };
    const c = buildCandidate(page, 420);
    expect(c).not.toBeNull();
    expect(c!.thumbWidth).toBe(1280);
    expect(c!.thumbHeight).toBe(853);
    expect(c!.width).toBe(4000);
    expect(c!.author).toBe('Иван Петров');
  });
});
