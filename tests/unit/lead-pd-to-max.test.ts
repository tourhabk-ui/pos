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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

/**
 * Файлы, несущие ПД лида, и дополнительные выражения ПД в каждом — те, что не
 * ловятся общим правилом, потому что пришли голыми идентификаторами.
 */
const PD_FILES: ReadonlyArray<{ file: string; extra: string[] }> = [
  // Лиды
  { file: 'lib/notifications/lead-notify.ts', extra: ['proposal.headline'] },
  { file: 'lib/notifications/telegram-channel.ts', extra: ['booking.touristName', 'booking.touristEmail'] },
  { file: 'app/api/leads/route.ts', extra: ['leadName', 'proposal.headline'] },
  { file: 'app/api/cron/followups/route.ts', extra: ['row.message_text'] },
  { file: 'app/api/cron/leads-followup/route.ts', extra: [] },
  // Бронирования, жильё, прокат, поддержка
  { file: 'lib/notifications/operator-booking.ts', extra: ['touristName', 'touristPhone'] },
  { file: 'lib/notifications/stay-booking.ts', extra: ['p.guestName', 'p.guestPhone'] },
  { file: 'lib/notifications/gear-rental.ts', extra: ['p.customerName', 'p.customerPhone'] },
  { file: 'app/api/cron/abandoned-bookings/route.ts', extra: ['row.tourist_name'] },
  { file: 'lib/kuzmich/core.ts', extra: ['b.name', 'b.phone'] },
  { file: 'lib/telegram/admin-notify.ts', extra: ['user'] },
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

/**
 * ЗАМОРОЖЕННАЯ ПЕРЕПИСЬ: файлы, где ПД человека всё ещё попадают в Telegram.
 *
 * Написана потому, что 23.08 лид-домен объявили закрытым, а пятая копия
 * (`app/api/telegram/admin/route.ts`, команда /leads с «имя | телефон»)
 * нашлась только повторным замером. Память — не метод: перечень считает
 * машина, и он может только СОКРАЩАТЬСЯ.
 *
 * Сеть здесь грубее, чем у правила выше: она смотрит на файл целиком и не
 * знает, куда именно ушла интерполяция. Лид-домен из неё поэтому исключён
 * камелкейсом `leadName` — там действует точное правило по зонам, а файл
 * app/api/leads/route.ts законно содержит и вызов Telegram (заглушка), и ПД
 * (в тексте для MAX).
 *
 * Файлы, уже переведённые на sendPdAlert, из этой сети исключены: у них
 * действует точное правило по зонам выше, оно строже.
 *
 * Список — не индульгенция, но и не список грехов: у каждой строки записана
 * ПРИЧИНА, и большинство законны — сообщение самому субъекту, исполнение
 * договора, §7 CLAUDE.md. Единственный настоящий остаток — телефон пассажира
 * водителю: перенести его некуда, пока у водителей нет адреса в MAX.
 */
const TELEGRAM_PD_CENSUS: ReadonlyArray<{ file: string; why: string }> = [
  { file: 'app/api/cron/route-escalation/route.ts',
    why: 'ПД лидера группы уходят экстренному контакту почтой; это и есть назначение' },
  { file: 'app/api/cron/smart-notify/route.ts',
    why: 'имя пользователя в его же чате' },
  { file: 'app/api/hub/admin/support/tickets/[id]/route.ts',
    why: 'имя обратившегося в его же чате' },
  { file: 'app/api/payments/tochka/webhook/route.ts',
    why: 'приём оплаты — §7 CLAUDE.md, только по слову владельца' },
  { file: 'app/api/safety/sos/route.ts',
    why: 'SOS — §7 CLAUDE.md, только через staging' },
  { file: 'lib/agents/execution/handlers/operator-outreach-executor.ts',
    why: 'почта оператора, который сам подал заявку, в отчёте о рассылке' },
  { file: 'lib/leads/proposal-delivery.ts',
    why: 'имя туриста в предложении, адресованном самому туристу' },
  { file: 'lib/notifications/telegram.ts',
    why: 'телефон пассажира водителю: адреса водителей в MAX нет, схемы transfer_drivers нет ни в migrations/, ни в baseline — завести колонку не по чему, а выкинуть телефон значит лишить водителя способа найти пассажира' },
];

const TELEGRAM_SEND =
  /api\.telegram\.org|telegramService\s*\.|tgFetchWithRetry\s*\(|tgSend\s*\(|sendHTML\s*\(/;
const PD_ANY =
  /\$\{[^}]*(?:\.\s*(?:phone|email|phone_number|mobile)\b|\b(?:tourist|guest|customer|passenger|client|leader|driver|user|lead)_(?:name|phone|email)\b|\b(?:tourist|guest|customer|passenger|client|driver|user)(?:Name|Phone|Email)\b|\b(?:lead|l|b|booking|user|u|guest)\s*\.\s*name\b)[^}]*\}/;

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'tests']);

function sourceFiles(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if ((name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts')) acc.push(full);
  }
}

describe('перепись ПД в Telegram только сокращается', () => {
  const root = process.cwd();
  const files: string[] = [];
  sourceFiles(join(root, 'app'), files);
  sourceFiles(join(root, 'lib'), files);

  const actual = files
    .filter((f) => {
      const src = readFileSync(f, 'utf8');
      // Файлы под точным правилом (импортируют sendPdAlert) сюда не попадают:
      // у них гарантия строже, чем «в файле нет ПД рядом с Telegram».
      return TELEGRAM_SEND.test(src) && PD_ANY.test(src) && !/sendPdAlert/.test(src);
    })
    .map((f) => relative(root, f).split('\\').join('/'))
    .sort();

  it('новых файлов с ПД в Telegram не появилось', () => {
    const known = TELEGRAM_PD_CENSUS.map((c) => c.file);
    const added = actual.filter((f) => !known.includes(f));
    expect(added, `ПД человека уходят в Telegram из файлов вне переписи: ${added.join(', ')}`)
      .toEqual([]);
  });

  it('у каждой строки переписи есть причина', () => {
    const empty = TELEGRAM_PD_CENSUS.filter((c) => c.why.trim().length < 20).map((c) => c.file);
    expect(empty, `в переписи строки без внятной причины: ${empty.join(', ')}`).toEqual([]);
  });

  it('вычищенные файлы вычеркнуты из переписи, а не оставлены про запас', () => {
    // Перепись, отставшая от кода, врёт в обратную сторону: работа выглядит
    // несделанной там, где она сделана.
    const stale = TELEGRAM_PD_CENSUS.filter((c) => !actual.includes(c.file)).map((c) => c.file);
    expect(stale, `в переписи лишние файлы — ПД там уже нет: ${stale.join(', ')}`).toEqual([]);
  });
});
