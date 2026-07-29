/**
 * SOS достижим с каждого экрана мобильной навигации — и реализован один раз.
 *
 * Повод: кнопка жила тремя разными кусками разметки — в `BottomNav` (для /map
 * и /ai-assistant), во вкладке инлайнового таб-бара главной и отдельной
 * плавающей кнопкой там же. Копии УЖЕ разошлись поведением: одна уводила на
 * `/emergency`, другая открывала инлайн-панель. Это не гипотеза, это было в
 * коде до 2026-07-29.
 *
 * Пока копий много, очередной экран однажды получит кнопку без офлайн-ветки —
 * и узнаем мы об этом от человека, который не смог позвать помощь. Поэтому
 * сторож следит за двумя вещами сразу:
 *   1. у SOS ровно одна реализация;
 *   2. каждый экран с нижней навигацией её показывает.
 *
 * Список экранов извлекается из исходников, а не задан списком здесь: добавят
 * четвёртый экран с таб-баром — тест сам его потребует.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['app', 'components'];
const SKIP = new Set(['node_modules', '.next', 'dist', 'coverage', '_archive']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(full)) out.push(full);
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));

/** Исходник без строк-комментариев: пояснения не должны считаться кодом. */
function code(file: string): string {
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const SOURCES = new Map(FILES.map((f) => [relative(ROOT, f), code(f)]));

const ACTION = 'components/shared/EmergencyAction.tsx';

describe('у SOS одна реализация', () => {
  it('офлайн-поведение SOS нигде не переписано заново', () => {
    // Обычная ссылка на /sos внутри контента — это нормально: так делают
    // футер, карточка в хабе безопасности, блок 112 в чате Кузьмича. Опасен
    // не переход на страницу, а ВТОРАЯ реализация действия. Её структурная
    // подпись — собственный `onClick` на ссылке SOS: именно там жила проверка
    // сети у прежних копий, и именно так они разъехались (одна уходила на
    // /emergency, другая открывала инлайн-панель).
    //
    // Совпадения в одном файле недостаточно: и чат Кузьмича, и хаб
    // безопасности читают `navigator.onLine` совсем для другого — баннера
    // офлайна и проверки перед запросом. Поэтому связываем href и обработчик
    // в пределах ОДНОГО тега.
    const offenders = [...SOURCES.entries()]
      .filter(([path]) => path !== ACTION)
      .filter(([, src]) =>
        [...src.matchAll(/<(?:Link|a)\b[^>]*>/gs)]
          .some((m) => /href=["']\/sos["']/.test(m[0]) && /onClick/.test(m[0])))
      .map(([path]) => path);
    expect(offenders, 'кто-то снова повесил своё поведение на ссылку SOS')
      .toEqual([]);
  });

  it('офлайн-ветка не потеряна: без сети навигации на /sos не происходит', () => {
    const src = SOURCES.get(ACTION);
    expect(src, 'компонент SOS исчез').toBeTruthy();
    expect(src!).toMatch(/navigator\.onLine === false/);
    expect(src!).toMatch(/preventDefault\(\)/);
    // Два честных запасных пути: инлайн-панель экрана либо /emergency.
    expect(src!).toMatch(/onOfflineFallback/);
    expect(src!).toMatch(/["']\/emergency["']/);
  });

  it('кнопка красная и достаточно крупная для пальца в перчатке', () => {
    const src = SOURCES.get(ACTION)!;
    expect(src).toMatch(/var\(--danger\)/);
    expect(src).toMatch(/minWidth:\s*['"]44px['"]/);
    expect(src).toMatch(/minHeight:\s*['"]44px['"]/);
    expect(src).toMatch(/aria-label/);
  });
});

describe('каждый экран с нижней навигацией показывает SOS', () => {
  /** Экраны, которые рисуют мобильную навигацию: общий BottomNav или свой таб-бар. */
  const screens = [...SOURCES.entries()]
    .filter(([path, src]) => path !== 'components/shared/BottomNav.tsx'
      && (/<BottomNav\b/.test(src) || /<nav className="tabs"/.test(src)))
    .map(([path]) => path);

  it('такие экраны вообще нашлись — иначе тест сторожит пустоту', () => {
    expect(screens.length).toBeGreaterThanOrEqual(3);
  });

  it.each(screens)('%s рендерит EmergencyAction', (path) => {
    expect(SOURCES.get(path)!, `на ${path} нижняя навигация есть, а SOS нет`)
      .toMatch(/<EmergencyAction\b/);
  });
});

describe('СОС не вернулся во вкладку', () => {
  it('BottomNav не содержит собственной кнопки', () => {
    const src = SOURCES.get('components/shared/BottomNav.tsx')!;
    // Решение владельца 2026-07-29: SOS — фиксированная кнопка шапки.
    // Вкладка рядом с ней означала бы две кнопки одного действия.
    expect(src).not.toMatch(/href=["']\/sos["']/);
    expect(src).not.toMatch(/Siren/);
  });
});
