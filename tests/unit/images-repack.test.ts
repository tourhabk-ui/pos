/**
 * tests/unit/images-repack.test.ts
 *
 * Реальные пережать, сгенерированные удалить (решение владельца 09.09).
 *
 * Перепись с прода назвала состав `ai_route_images`: 657 строк, 421,3 МБ, из
 * которых 197 МБ — сгенерированные картинки (qwen-image 98 строк на 189,9 МБ,
 * pollinations-flux 75 на 7,2 МБ). Показывать их не следует с 17.07. А обе
 * самые тяжёлые строки — `real-photo`, и одна из них Халактырский пляж:
 * видимое место, снимок единственный.
 *
 * Отсюда предмет охраны. Два разбора не должны перепутать материал: пережатие
 * не трогает генерацию, удаление не трогает ничего, кроме неё. И удаляющий
 * роут не должен принимать «что удалять» снаружи — иначе опечатка в параметре
 * стирает фотографию, которую восстановить неоткуда.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_MODELS, isGenerated } from '@/lib/images/origin';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const RECOMPRESS = read('app/api/cron/images-recompress/route.ts');
const GENERATED  = read('app/api/cron/images-generated/route.ts');
const OVERSIZE   = read('app/api/cron/images-oversize/route.ts');
const WORKFLOW   = read('.github/workflows/images-repack.yml');

/** Код без комментариев: судим употребление, а не рассказ о нём. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('род снимка решает код, а не тело запроса', () => {
  it('список заморожен и содержит оба найденных генератора', () => {
    expect([...GENERATED_MODELS]).toEqual(['qwen-image', 'pollinations-flux']);
  });

  it('незнакомый род и NULL — НЕ генерация', () => {
    // Односторонняя ошибка: оставить лишнее можно, удалить снятое нельзя.
    expect(isGenerated('real-photo')).toBe(false);
    expect(isGenerated('wikimedia-commons')).toBe(false);
    expect(isGenerated('что-то новое')).toBe(false);
    expect(isGenerated(null)).toBe(false);
    expect(isGenerated(undefined)).toBe(false);
    expect(isGenerated('qwen-image')).toBe(true);
  });

  it('удаляющий роут не принимает роды из тела запроса', () => {
    const c = code(GENERATED);
    // В схеме тела только причина, размер партии и сухой прогон. Появись
    // здесь `models`, опечатка стирала бы фотографии.
    expect(c).not.toMatch(/models:\s*z\./);
    expect(c).toMatch(/GENERATED_MODELS/);
  });

  it('род повторён в самом DELETE, а не только в выборке', () => {
    // Между планом и удалением снимок мог быть заменён настоящим через
    // админку — тогда удалять его уже нельзя.
    expect(code(GENERATED)).toMatch(/DELETE FROM ai_route_images[\s\S]{0,120}model = ANY\(\$2::text\[\]\)/);
  });
});

describe('пережатие не трогает генерацию', () => {
  const c = code(RECOMPRESS);

  it('кандидаты отбираются с исключением сгенерированных родов', () => {
    expect(c).toMatch(/model IS NULL OR i?\.?model <> ALL\(\$2::text\[\]\)/);
    expect(c).toMatch(/GENERATED_MODELS/);
  });

  it('порог обязателен и без умолчания, причина тоже', () => {
    expect(c).toMatch(/min_bytes:\s*z\.number\(\)\.int\(\)\.min\(1/);
    expect(c).not.toMatch(/min_bytes:[^\n]*\.default\(/);
    expect(c).toMatch(/reason:\s*z\.string\(\)\.min\(/);
    expect(c).not.toMatch(/reason:[^\n]*\.default\(/);
  });
});

describe('пережатие не портит снимок', () => {
  const c = code(RECOMPRESS);

  it('результат читается обратно ДО записи', () => {
    // toBuffer() вернул буфер — это ещё не значит, что в нём картинка.
    const check = c.indexOf('sharp(out).metadata()');
    const write = c.indexOf('UPDATE ai_route_images');
    expect(check, 'проверки результата нет').toBeGreaterThan(0);
    expect(write).toBeGreaterThan(0);
    expect(check, 'запись идёт раньше проверки').toBeLessThan(write);
  });

  it('записывается только если стало ЛЕГЧЕ', () => {
    expect(c).toMatch(/out\.length >= r\.image_data\.length/);
    expect(c).toMatch(/не стало легче/);
  });

  it('запись под условием прежнего веса — снимок мог смениться', () => {
    expect(c).toMatch(/AND OCTET_LENGTH\(image_data\) = \$5/);
  });

  it('кадр не обрезается: fit inside, а не cover', () => {
    // Писатели кадрируют новую загрузку осознанно. Уже лежащий и уже
    // показанный снимок обрезать задним числом — потеря содержимого ради
    // байтов, которых это почти не добавит.
    expect(c).toMatch(/fit: 'inside', withoutEnlargement: true/);
    expect(c).not.toMatch(/fit: 'cover'/);
  });

  it('EXIF-поворот применяется до вписывания', () => {
    expect(c.indexOf('.rotate()')).toBeLessThan(c.indexOf('.resize('));
  });

  it('канон размеров тот же, что у писателей', () => {
    expect(c).toMatch(/TARGET_WIDTH\s*=\s*1280/);
    expect(c).toMatch(/TARGET_HEIGHT\s*=\s*720/);
    expect(c).toMatch(/JPEG_QUALITY\s*=\s*85/);
  });
});

describe('перепись перестала быть пишущей', () => {
  it('в images-oversize не осталось ни POST, ни DELETE', () => {
    // Удаление по весу било бы ровно по настоящим фотографиям — перепись это
    // и показала. Оставлять заряженный путь к тому исходу нельзя.
    expect(OVERSIZE).not.toMatch(/export async function POST/);
    expect(code(OVERSIZE)).not.toMatch(/DELETE FROM/);
  });

  it('в реестре планировщиков отмечена как НЕ пишущая', () => {
    const reg = read('lib/agents/cron-schedulers.ts');
    expect(reg).toMatch(/'images-oversize':\s*\{ kind: 'manual', writes: false/);
  });
});

describe('разборы объявлены и запускаемы', () => {
  it('запускающий назван РОВНО ОДИН раз — workflow, а не ещё и объявление', () => {
    // Роут, который зовёт workflow, не объявляется вручную: два объявления —
    // два разных ответа на вопрос «кто это запускает». Тот же довод, что у
    // 'tochka-check' и 'ai-channel-check' в самом реестре.
    const reg = read('lib/agents/cron-schedulers.ts');
    expect(reg).not.toMatch(/'images-recompress':\s*\{ kind:/);
    expect(reg).not.toMatch(/'images-generated':\s*\{ kind:/);
    expect(reg).toMatch(/images-repack\.yml/);
  });

  it('оба в замороженном реестре возможностей, без выхода в сеть', () => {
    const caps = read('lib/agents/cron-capability-registry.ts');
    expect(caps).toMatch(/'images-recompress': \['db_read', 'db_write'\]/);
    expect(caps).toMatch(/'images-generated': \['db_read', 'db_write'\]/);
  });

  it('есть актуатор: prod-check умеет только GET, а разборы — POST', () => {
    // Без workflow работа была бы написана и неисполнима.
    expect(WORKFLOW).toMatch(/api\/cron\/images-recompress/);
    expect(WORKFLOW).toMatch(/api\/cron\/images-generated/);
    expect(WORKFLOW).toMatch(/-X POST/);
  });

  it('секрет уходит заголовком, а не в строке адреса', () => {
    expect(WORKFLOW).toMatch(/Authorization: Bearer \$CRON_SECRET/);
    expect(WORKFLOW).not.toMatch(/\?secret=/);
  });

  it('умолчание маркера — сухой прогон', () => {
    // Файл, забытый в репозитории, не должен однажды уехать боевой партией.
    expect(WORKFLOW).toMatch(/marker\.get\('mode'\) or 'dry'/);
    const marker = JSON.parse(read('.github/triggers/images-repack.json'));
    expect(marker.mode).toBe('dry');
  });

  it('ждёт свою сборку: маркер уезжает вместе с роутами', () => {
    // Без ожидания первый прогон постучался бы в прод, где этих адресов ещё
    // нет, и 404 читался бы как «разбор не работает».
    expect(WORKFLOW).toMatch(/scripts\/wait-for-deploy\.sh/);
  });

  it('цикл боевого режима имеет предел и останавливается на нуле', () => {
    // Иначе отказ каждой партии крутил бы прогон до таймаута.
    expect(WORKFLOW).toMatch(/ROUND" -lt 25/);
    expect(WORKFLOW).toMatch(/\[ "\$DID" -gt 0 \] \|\| break/);
  });

  it('партия остаётся по десять', () => {
    expect(WORKFLOW).toMatch(/\\"limit\\": 10/);
    expect(code(RECOMPRESS)).toMatch(/MAX_BATCH = 10/);
    expect(code(GENERATED)).toMatch(/MAX_BATCH = 10/);
  });
});
