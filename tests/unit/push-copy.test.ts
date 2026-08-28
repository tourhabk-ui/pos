/**
 * Пуш не даёт чужую команду.
 *
 * В кроне стояла лестница из трёх `?:`: цунами, пожар, дорога — и всё
 * остальное уезжало заголовком «Землетрясение M? — Камчатка» с телом «Если у
 * берега — немедленно вверх ≥30 м». Вулканическая тревога (severity 2,
 * активная на проде в день находки), паводок и добавленная сегодня погода
 * приходили человеку как землетрясение с командой бежать от воды.
 *
 * Инструкция в пуше — это действие, которое человек совершит, не открывая
 * приложение. В метель «уходите вверх от воды» уводит с маршрута в склон.
 *
 * Отсюда главная проверка файла: у НЕИЗВЕСТНОГО типа инструкции нет вовсе.
 * Список типов растёт, и каждый новый обязан попасть в безопасную ветку по
 * умолчанию, а не унаследовать чужую команду молчанием.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pushCopy, PUSH_TYPES_WITH_INSTRUCTION, standDownCopy } from '@/lib/services/safety/push-copy';

/** Команды, ошибиться в которых опаснее всего: они уводят в конкретную сторону. */
const DIRECTIONAL = /вверх|от воды|берег|склон|вброд/i;

describe('у каждой опасности своя команда', () => {
  it('цунами уводит от воды', () => {
    const c = pushCopy({ alertType: 'tsunami_warning', title: 'Волна', description: 'Прибрежные районы' });
    expect(c.title).toContain('ЦУНАМИ');
    expect(c.body).toMatch(/от воды/);
  });

  it('землетрясение несёт магнитуду, а без неё — не врёт числом', () => {
    expect(pushCopy({ alertType: 'earthquake', title: 'Толчки', magnitude: 6.25 }).title).toContain('M6.3');
    expect(pushCopy({ alertType: 'earthquake', title: 'Толчки', magnitude: null }).title).toContain('M?');
  });

  it('погода велит переждать, а не бежать от воды', () => {
    const c = pushCopy({ alertType: 'weather', title: 'Охотоморский циклон, очень сильный дождь' });
    expect(c.title).not.toMatch(/Землетрясение/);
    expect(c.body).not.toMatch(/от воды|вверх/);
    expect(c.body).toMatch(/не выходите/i);
  });

  it('вулкан не называется землетрясением', () => {
    // Живой случай 10.08: «Сохраняется риск схода оползней и обвалов с вулкана
    // Мутновского», severity 2 — под старой лестницей это был пуш о землетрясении.
    const c = pushCopy({ alertType: 'volcanic_eruption', title: 'Риск обвалов с вулкана Мутновского' });
    expect(c.title).not.toMatch(/Землетрясение/);
    expect(c.body).not.toMatch(/от воды/);
  });

  it('паводок велит не лезть в реку', () => {
    expect(pushCopy({ alertType: 'flood', title: 'Подтопления дорог' }).body).toMatch(/вброд/);
  });
});

describe('неизвестный тип не получает выдуманного действия', () => {
  const unknown = pushCopy({ alertType: 'medusa_bloom', title: 'Нечто новое' });

  it('заголовок нейтральный, без чужой категории', () => {
    expect(unknown.title).not.toMatch(/Землетрясение|ЦУНАМИ|пожар|Паводок/i);
  });

  it('в теле нет команды, уводящей в конкретную сторону', () => {
    // Ровно тот дефект, из-за которого метель говорила «уходите от воды».
    expect(unknown.body).not.toMatch(DIRECTIONAL);
  });

  it('тело всё-таки несёт суть тревоги, а не пустоту', () => {
    expect(unknown.body).toContain('Нечто новое');
  });

  it('пустой и отсутствующий тип ведут себя так же', () => {
    for (const t of [null, '', 'info']) {
      expect(pushCopy({ alertType: t, title: 'Сводка' }).body).not.toMatch(DIRECTIONAL);
    }
  });
});

describe('типы классификатора не теряются по дороге к пушу', () => {
  // Самая тихая половина: классификатор научился новому типу, а пуш о нём не
  // знает — и человек получает чужую инструкцию. Список типов читается из
  // исходника классификатора, чтобы проверка не отстала от него молча.
  const parserSource = readFileSync(
    join(process.cwd(), 'lib/services/safety/seismic-parser.ts'), 'utf-8',
  );
  // Берём САМОЕ ДЛИННОЕ объединение: тот же список стоит укороченным в шапке
  // файла как пояснение, и первый матч дал бы четыре типа вместо десяти —
  // проверка молча ослабла бы ровно там, где должна быть строгой.
  const unions = [...parserSource.matchAll(/alert_type:\s*((?:'[a-z_]+'\s*\|\s*)+'[a-z_]+')/g)]
    .map((m) => m[1])
    .sort((a, b) => b.length - a.length);
  const types = [...(unions[0] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  it('объединение типов вообще найдено в исходнике', () => {
    expect(types.length).toBeGreaterThan(5);
  });

  for (const t of ['volcanic_eruption', 'weather', 'flood', 'tsunami_warning', 'fire_danger', 'road_closure']) {
    it(`${t} имеет собственную инструкцию`, () => {
      expect(types).toContain(t);
      expect(PUSH_TYPES_WITH_INSTRUCTION as readonly string[]).toContain(t);
    });
  }

  it('типы без своей инструкции уходят в нейтральную ветку, а не в чужую', () => {
    const neutral = types.filter((t) => !(PUSH_TYPES_WITH_INSTRUCTION as readonly string[]).includes(t));
    for (const t of neutral) {
      expect(pushCopy({ alertType: t, title: 'Т' }).body).not.toMatch(DIRECTIONAL);
    }
  });
});

describe('standDownCopy — слой ПОСЛЕ тревоги (issue #1420)', () => {
  it('называет зону по имени', () => {
    const c = standDownCopy('Авачинско-Петропавловский район');
    expect(c.title).toContain('Авачинско-Петропавловский район');
  });

  it('не даёт направленной команды — риск снизился, а не «идите туда-то»', () => {
    const c = standDownCopy('Северная Камчатка');
    expect(c.body).not.toMatch(DIRECTIONAL);
  });

  it('не выглядит как вход в тревогу — разные заголовки от pushCopy', () => {
    const standDown = standDownCopy('Восточное побережье');
    const alert = pushCopy({ alertType: 'earthquake', title: 'Толчки', magnitude: 6 });
    expect(standDown.title).not.toBe(alert.title);
  });
});
