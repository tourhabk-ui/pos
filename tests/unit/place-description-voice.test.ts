/**
 * Голос описания места: путевая заметка от первого лица не отдаётся как
 * справка (26.09, Авачинский «Вчера поднялся…»). Шапка —
 * lib/places/description-voice.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { descriptionVoice } from '@/lib/places/description-voice';
import { composePlaceInfo } from '@/lib/kuzmich/place-info-tool';

const AVACHA = 'Вчера поднялся на Авачинский — домашний вулкан Петропавловска. Подъём по рыхлому шлаку и остывшей лаве даёт себя знать: ноги проваливаются с каждым шагом, зато наверху открывается небо. Из молодого кратера тянет серой, из трещин поднимаются горячие струи — фумаролы работают исправно.';
const KLYUCH = 'Над долиной стоит запах серы и остывающего камня, и кто добирается до верха, запоминает тишину.';
const PLAIN = 'Действующий вулкан высотой 2741 м в 25 км к северу от Петропавловска-Камчатского. Восхождение начинается от Авачинского перевала.';

describe('descriptionVoice', () => {
  it('дневник от первого лица — diary', () => {
    const v = descriptionVoice(AVACHA);
    expect(v.voice).toBe('diary');
    expect(v.markers).toEqual(expect.arrayContaining(['вчера', 'поднялся']));
  });

  it('личное местоимение и «мы»-глагол — diary', () => {
    expect(descriptionVoice('Мы добрались до кордона к вечеру.').voice).toBe('diary');
    expect(descriptionVoice('Здесь я впервые увидел медведя.').voice).toBe('diary');
  });

  it('ощущения без рассказчика — impression (Ключевская 19.09)', () => {
    const v = descriptionVoice(KLYUCH);
    expect(v.voice).toBe('impression');
    expect(v.markers).toEqual(expect.arrayContaining(['запах', 'тишину']));
  });

  it('справочный текст — plain', () => {
    expect(descriptionVoice(PLAIN)).toEqual({ voice: 'plain', markers: [] });
  });

  it('справочные обороты с похожими буквами не ловятся', () => {
    // «наш край», «туристы шли», «Ямская», «нассыпь» — не рассказчик.
    expect(descriptionVoice('Наш край богат источниками. Туристы шли к Ямской бухте по насыпи.').voice).toBe('plain');
    // «я» внутри слова и «мы» в «мыс» — не местоимение.
    expect(descriptionVoice('Мыс Маячный и бухта Бечевинская.').voice).toBe('plain');
  });

  it('пустое — plain без примет', () => {
    expect(descriptionVoice(null)).toEqual({ voice: 'plain', markers: [] });
  });
});

describe('get_place_info: дневник не выдаётся за справку', () => {
  const base = { name: 'Вулкан Авачинский', category: 'volcano', district: null, location_type: 'volcano', lat: 53.255, lng: 158.83 };

  it('diary — текст не отдаётся, причина названа, факты остаются', () => {
    const out = composePlaceInfo('Авачинский', [{ ...base, description: AVACHA }], []) ?? '';
    expect(out).not.toContain('Вчера поднялся');
    expect(out).toContain('путевая заметка от первого лица');
    expect(out).toContain('Координаты: 53.25500, 158.83000');
  });

  it('impression — отдаётся подписанным', () => {
    const out = composePlaceInfo('Авачинский', [{ ...base, description: KLYUCH }], []) ?? '';
    expect(out).toContain('Описание (впечатление, не наблюдение): Над долиной');
  });

  it('plain — отдаётся как описание', () => {
    const out = composePlaceInfo('Авачинский', [{ ...base, description: PLAIN }], []) ?? '';
    expect(out).toContain(`Описание: ${PLAIN}`);
  });
});

describe('промпт «будто ты только что вернулся» не возвращается', () => {
  // Он сочинил Ключевскую (19.09) и Авачинского. Требование, которое нечем
  // выполнить, выполняется выдумкой (§4.0). Ищем по коду, а не по одному файлу:
  // 26.09 он жил в скрипте, пережив правку роута на неделю.
  const ROOTS = ['app', 'lib', 'scripts'];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) files.push(p);
    }
  };
  for (const r of ROOTS) walk(join(process.cwd(), r));

  it('ни в одном файле кода', () => {
    // Комментарии пропускаются: шапки роута и миграции 987 цитируют промпт
    // как урок, а сторож ищет промпт, который уходит в модель.
    const code = (f: string) => readFileSync(f, 'utf-8').split('\n')
      .filter(line => !/^\s*(\*|\/\/|\/\*)/.test(line)).join(' ');
    const hits = files.filter(f => /будто\s+ты\s+только\s+что\s+вернул/i.test(code(f)));
    expect(hits).toEqual([]);
  });

  it('сторож видит файлы (ноль прочитанных — отказ, а не чистота)', () => {
    expect(files.length).toBeGreaterThan(500);
  });
});

describe('перепись называет голос', () => {
  const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/place-description-geo/route.ts'), 'utf-8');
  it('блок voice считает diary/impression/plain/empty', () => {
    expect(ROUTE).toContain('descriptionVoice(');
    for (const k of ['diary:', 'impression:', 'plain:', 'empty:']) expect(ROUTE).toContain(k);
  });
});
