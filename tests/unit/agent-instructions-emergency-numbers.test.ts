/**
 * Сторож: в инструкциях агентов нет непроверенных региональных телефонов.
 *
 * Сверка инструкций 13.11: справка скилла `trust-first` держала пример кода с
 * двумя региональными номерами «МЧС Камчатского края» и «Горноспасательная
 * служба», которых нет в проверенном списке платформы. Скилл включается при
 * работе над экранами безопасности, и агент вставил бы эти номера в код
 * буквально. Неверный экстренный номер хуже, чем его отсутствие.
 *
 * Правило платформы одно: региональный номер показывается, только если его
 * проверил владелец и он записан в `lib/safety/emergency-numbers.ts`. Этот
 * сторож распространяет правило на то, по чему агент пишет код. Это запрет
 * («этого быть не должно»), поэтому судится текст.
 *
 * ── Что обходится ────────────────────────────────────────────────────────
 * Все места, где лежат инструкции агентов, а не два каталога: первая редакция
 * смотрела только `.claude/skills` и `.claude/commands`, и ревью PR показало,
 * что рядом есть `.agents/` со своими скиллами, `.claude/agents`, хуки,
 * заметки `.claude/*.md` и корневые `AGENTS.md` и `CLAUDE.md`. Каждое место
 * проверяется на «прочитано» отдельно: выпавший каталог не должен прятаться
 * за остальными.
 *
 * ── Что узнаётся ─────────────────────────────────────────────────────────
 * Полная запись с любым кодом Камчатского края (415x) и местная шестизначная
 * «23-53-62». Именно в местной записи старые неверные номера перечислены в
 * шапке `lib/safety/emergency-numbers.ts` — агент, читающий источник, видит
 * номер в этом виде. Разделитель — дефис или тире.
 *
 * ── Чего сторож НЕ ловит (и это названо) ─────────────────────────────────
 * Мобильный номер, выданный за экстренный; шесть цифр через пробелы или
 * слитно (так же пишутся размеры и идентификаторы — ложных срабатываний было
 * бы больше, чем находок); номер в картинке.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { VERIFIED_REGIONAL, VERIFIED_REFERENCE } from '@/lib/safety/emergency-numbers';

const ROOT = process.cwd();

/** Каталоги с инструкциями агентов — обходятся целиком. */
const ROOT_DIRS = ['.claude/skills', '.claude/commands', '.claude/agents', '.claude/hooks', '.agents'];
/** Отдельные файлы-инструкции в корне. */
const ROOT_FILES = ['AGENTS.md', 'CLAUDE.md'];

const TEXT_FILE = /\.(md|mjs|js|ts|tsx|json|sh|txt)$/;

/** Все текстовые файлы под каталогом. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...filesUnder(rel));
    else if (TEXT_FILE.test(name)) out.push(rel);
  }
  return out;
}

/** Заметки верхнего уровня `.claude/*.md` (MEMORY, DESIGN_SYSTEM и другие). */
function claudeNotes(): string[] {
  return readdirSync(join(ROOT, '.claude')).filter((n) => n.endsWith('.md')).map((n) => `.claude/${n}`);
}

const SEP = String.raw`[\s ()–—-]*`;
/** Полная запись: +7 или 8, затем десять цифр, начинающихся с 415 (коды Камчатского края). */
const FULL = new RegExp(String.raw`(?:\+7|(?<!\d)8)${SEP}415\d(?:${SEP}\d){6}(?!\d)`, 'g');
/** Местная запись: три пары цифр через дефис или тире, не часть более длинного числа. */
const LOCAL = /(?<![\d–—-])\d{2}[–—-]\d{2}[–—-]\d{2}(?![\d–—-])/g;

const digits = (s: string) => s.replace(/\D/g, '');
/** К одному виду: 11 цифр с ведущей 7. Местная запись — номер Петропавловска-Камчатского (4152). */
function canon(match: string): string {
  const d = digits(match);
  if (d.length === 6) return `74152${d}`;
  return d.length === 11 ? `7${d.slice(1)}` : d;
}

/** Все региональные номера в тексте, без повторов. */
function regionalNumbers(src: string): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(FULL)) found.add(canon(m[0]));
  for (const m of src.matchAll(LOCAL)) found.add(canon(m[0]));
  return [...found];
}

const VERIFIED = new Set([...VERIFIED_REGIONAL, ...VERIFIED_REFERENCE].map((n) => canon(n.phone)));

/**
 * Упоминания, которые НЕ предлагают номер к показу. Список самоустаревающий:
 * упоминание исчезло из файла — тест требует убрать запись.
 */
const KNOWN_MENTIONS: Record<string, { numbers: string[]; why: string }> = {
  '.claude/MEMORY.md': {
    numbers: ['74152235362'],
    why: 'заметка объясняет, почему с экрана убрана кнопка SMS: номер назван как городской, на который SMS не доходят, а не как номер для показа',
  },
  '.claude/skills/impeccable/reference/colorize.md': {
    numbers: ['74152603010'],
    why: 'это не телефон: «60-30-10» — правило долей цвета в палитре; местная запись номера выглядит так же',
  },
};

describe('региональные телефоны в инструкциях агентов', () => {
  const perRoot = new Map<string, string[]>();
  for (const dir of ROOT_DIRS) perRoot.set(dir, existsSync(join(ROOT, dir)) ? filesUnder(dir) : []);
  perRoot.set('.claude/*.md', claudeNotes());
  for (const f of ROOT_FILES) perRoot.set(f, existsSync(join(ROOT, f)) ? [f] : []);
  const files = [...perRoot.values()].flat();

  it('каждое место с инструкциями прочитано', () => {
    // Пустой обход — отказ, а не «номеров нет». Проверка по каждому месту:
    // выпавший каталог не должен прятаться за остальными.
    for (const [root, list] of perRoot) {
      expect(list.length, `в «${root}» не прочитано ни одного файла`).toBeGreaterThan(0);
    }
    expect(VERIFIED.size).toBeGreaterThanOrEqual(3);
  });

  it('региональный номер в инструкции — только из проверенного списка', () => {
    const found: string[] = [];
    for (const f of files) {
      const allowed = new Set(KNOWN_MENTIONS[f]?.numbers ?? []);
      for (const n of regionalNumbers(readFileSync(join(ROOT, f), 'utf8'))) {
        if (!VERIFIED.has(n) && !allowed.has(n)) found.push(`${f}: +${n}`);
      }
    }
    expect(found, 'номер не из lib/safety/emergency-numbers.ts — убери его и сошлись на этот файл').toEqual([]);
  });

  it('записанные исключения ещё стоят в своих файлах', () => {
    for (const [f, { numbers, why }] of Object.entries(KNOWN_MENTIONS)) {
      expect(why.length, `${f}: у исключения нет причины`).toBeGreaterThan(20);
      const present = new Set(regionalNumbers(readFileSync(join(ROOT, f), 'utf8')));
      for (const n of numbers) {
        expect(present.has(n), `${f}: номера +${n} в файле больше нет — убери запись из KNOWN_MENTIONS`).toBe(true);
      }
    }
  });

  it('шаблон узнаёт полную и местную запись, любой код края и тире', () => {
    expect(regionalNumbers("phone: '+74152235362'")).toEqual(['74152235362']);
    expect(regionalNumbers('тел. +7 (4152) 23-53-61,')).toEqual(['74152235361']);
    expect(regionalNumbers('8 (4152) 30-10-89')).toEqual(['74152301089']);
    // Местная запись без кода города — в ней номера стоят в шапке источника.
    expect(regionalNumbers("phone: '23-53-62'")).toEqual(['74152235362']);
    // Длинное и короткое тире вместо дефиса.
    expect(regionalNumbers('8 (4152) 23–53–62')).toEqual(['74152235362']);
    expect(regionalNumbers('29—99—99')).toEqual(['74152299999']);
    // Другие коды Камчатского края: Елизово, Вилючинск.
    expect(regionalNumbers('+7 (41531) 6-12-34')).toEqual(['74153161234']);
    expect(regionalNumbers('8 41535 3 10 20')).toEqual(['74153531020']);
  });

  it('проверенный номер проходит в любой записи, а дата и диапазон номером не считаются', () => {
    for (const n of regionalNumbers('СОД: +7 (4152) 30-10-89, резерв 20-01-12, НДС 8(4152)30-10-91')) {
      expect(VERIFIED.has(n), `+${n} должен быть в проверенном списке`).toBe(true);
    }
    expect(VERIFIED.has('74152235362')).toBe(false);
    // Дата ISO, версия, диапазон и московский номер — не региональные телефоны.
    expect(regionalNumbers('2026-11-13')).toEqual([]);
    expect(regionalNumbers('строки 10-20-300 и 1-2-3')).toEqual([]);
    expect(regionalNumbers('+7 (495) 123-45-67')).toEqual([]);
  });
});
