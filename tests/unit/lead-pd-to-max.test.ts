/**
 * ПД туриста из лида уходят в MAX, а не в Telegram (решение владельца 23.08).
 *
 * Замер, из-за которого решение принято: имя и телефон КАЖДОГО лида уходили на
 * api.telegram.org — получателю, которого политика конфиденциальности не
 * называет; юрисдикция Telegram зарубежная, юрисдикция MAX — РФ. При этом один
 * лид уходил в Telegram ЧЕТЫРЬМЯ разными кусками кода, и починка одного
 * оставляла три.
 *
 * Сторож держит СВОЙСТВО, а не расположение: в файлах, которые несут ПД лида,
 * каждая интерполяция ПД лежит внутри поля `text` вызова sendPdAlert — то есть
 * в сообщении, адресованном MAX. В `stub` (запасной путь в Telegram) и в любом
 * прямом вызове Telegram ПД появиться не может.
 *
 * Скрытая ловушка, ради которой сторож и написан: `proposal.headline` выглядит
 * как машинный заголовок, но содержит ИМЯ туриста — модель пишет плейсхолдер
 * {name}, а подставляется он локально (lead-processor.service, withName).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/**
 * Файлы, несущие ПД лида, и дополнительные выражения ПД в каждом — те, что не
 * ловятся общим правилом, потому что пришли голыми идентификаторами.
 */
const PD_FILES: ReadonlyArray<{ file: string; extra: string[] }> = [
  { file: 'lib/notifications/lead-notify.ts', extra: ['proposal.headline'] },
  { file: 'lib/notifications/telegram-channel.ts', extra: [] },
  { file: 'app/api/leads/route.ts', extra: ['leadName', 'proposal.headline'] },
  { file: 'app/api/cron/followups/route.ts', extra: ['row.message_text'] },
  { file: 'app/api/cron/leads-followup/route.ts', extra: [] },
];

/** Однозначные ПД-поля. Имя — только у персональных владельцев, не у места. */
const PD_GENERIC =
  /\$\{[^}]*(?:\.\s*(?:phone|email|phone_number|mobile)\b|\b(?:lead|params|row|l|u|user|guest|client|customer|tourist)\s*\.\s*name\b|\blead_(?:name|phone)\b)[^}]*\}/g;

/** Сбалансированная область, начинающаяся с первой скобки/бэктика после idx. */
function balancedFrom(src: string, idx: number): { start: number; end: number } | null {
  const open = /[[(`]/.exec(src.slice(idx, idx + 200));
  if (!open || open.index === undefined) return null;
  const start = idx + open.index;
  const ch = src[start];
  if (ch === '`') {
    const end = src.indexOf('`', start + 1);
    return { start, end: end === -1 ? src.length : end + 1 };
  }
  const close = ch === '[' ? ']' : ')';
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === ch) depth++;
    else if (src[i] === close) { depth--; if (depth === 0) return { start, end: i + 1 }; }
  }
  return { start, end: src.length };
}

/** Все вхождения подстроки. */
function occurrences(src: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

/**
 * Запретные зоны — всё, что уходит в Telegram:
 *  - построение заглушки (`const stub = …` / `stub: …`);
 *  - прямые вызовы Telegram.
 * ПД внутри любой из них — нарушение.
 */
const TELEGRAM_CALLS = [
  'telegramService.sendMessage(',
  'tgFetchWithRetry(',
  'tgSend(',
  'sendHTML(',
];

function forbiddenZones(src: string): Array<{ start: number; end: number; why: string }> {
  const zones: Array<{ start: number; end: number; why: string }> = [];
  for (const marker of ['const stub =', 'stub:']) {
    for (const at of occurrences(src, marker)) {
      const z = balancedFrom(src, at + marker.length);
      if (z) zones.push({ ...z, why: 'заглушка для Telegram' });
    }
  }
  for (const call of TELEGRAM_CALLS) {
    for (const at of occurrences(src, call)) {
      const z = balancedFrom(src, at + call.length - 1);
      if (z) zones.push({ ...z, why: `прямой вызов ${call.replace('(', '')}` });
    }
  }
  return zones;
}

/** Позиции всех интерполяций ПД в файле. */
function pdPositions(src: string, extra: string[]): Array<{ at: number; expr: string }> {
  const found: Array<{ at: number; expr: string }> = [];
  for (const m of src.matchAll(PD_GENERIC)) {
    if (m.index === undefined) continue;
    found.push({ at: m.index, expr: m[0] });
  }
  for (const name of extra) {
    const re = new RegExp('\\$\\{[^}]*\\b' + name.replace('.', '\\.') + '\\b[^}]*\\}', 'g');
    for (const m of src.matchAll(re)) {
      if (m.index === undefined) continue;
      found.push({ at: m.index, expr: m[0] });
    }
  }
  return found;
}

describe('дверь для ПД одна', () => {
  const door = read('lib/notifications/pd-alert.ts');

  it('ПД уходят через maxSendDm, второй реализации отправки нет', () => {
    expect(door).toMatch(/import \{ maxSendDm \}/);
    expect(door, 'в двери появился прямой вызов MAX мимо общего клиента')
      .not.toMatch(/sendMessageToChat/);
  });

  it('исходов три, а не два: «не смог» не выдаётся за «отправлено»', () => {
    expect(door).toMatch(/'max' \| 'telegram-stub' \| 'none'/);
    expect(door).toMatch(/delivered: boolean/);
    // Заглушка — это НЕ доставка ПД.
    expect(door).toMatch(/channel: 'telegram-stub', delivered: false/);
  });

  it('публичный канал MAX адресом для ПД быть не может', () => {
    // MAX_CHANNEL_ID — новостной канал платформы: телефон туриста там стал бы
    // публикацией. Проверка стоит ДО отправки.
    expect(door).toMatch(/MAX_CHANNEL_ID/);
    expect(door.indexOf('MAX_CHANNEL_ID')).toBeLessThan(door.indexOf('maxSendDm('));
  });

  it('отказ не глушится: причина в логе, а не пустой catch', () => {
    expect(door).toMatch(/console\.error/);
    expect(door, 'вернулся глухой catch').not.toMatch(/catch \{\s*\}/);
  });
});

describe('ПД лида не попадают в Telegram', () => {
  for (const { file, extra } of PD_FILES) {
    it(`${file}: ПД не попадают ни в заглушку, ни в прямой вызов Telegram`, () => {
      const src = read(file);
      expect(src, `${file} не ходит через общую дверь sendPdAlert`).toMatch(/sendPdAlert/);

      const zones = forbiddenZones(src);
      const hits = pdPositions(src, extra);
      expect(hits.length, `в ${file} не найдено ни одной интерполяции ПД — правило проверять нечем`)
        .toBeGreaterThan(0);

      const escaped: string[] = [];
      for (const h of hits) {
        const zone = zones.find((z) => h.at > z.start && h.at < z.end);
        if (zone) escaped.push(`${h.expr} — ${zone.why}`);
      }
      expect(escaped, `ПД уходят в Telegram: ${escaped.join('; ')}`).toEqual([]);
    });
  }
});

describe('дайджест не отдаёт ПД зарубежной модели', () => {
  const digest = read('app/api/cron/digest/route.ts');

  it('имя и телефон лида не читаются из БД вовсе', () => {
    // Сканер D1 этот случай не видел: ПД шли в промпт через локальные
    // переменные (`const name = l.name`), а он ловит прямые `l.name`.
    // Структурная гарантия надёжнее дисциплины: нечего показывать — нечего и брать.
    expect(digest).not.toMatch(/SELECT id::text, name, phone/);
    expect(digest).not.toMatch(/\$\{name\}\s*\|\s*\$\{phone\}/);
  });
});
