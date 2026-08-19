/**
 * Field Cockpit (план FCN, этап 3): иерархия полевого экрана и один
 * полевой экран на всю платформу.
 *
 * 1. Прогресс — полноширинный модуль с инвариантами честности §3.3:
 *    процент и километраж только у снятого трека; мёртвый фикс не
 *    анимирует бар; у наброска — счёт точек и «ориентир, не тропа».
 * 2. Карточка доверия говорит, почему данным можно/нельзя верить:
 *    «линия проверена» пишется только про снятый трек.
 * 3. «Условия» — внутренний снимок из пакета, не внешняя погода:
 *    внешняя ссылка в поле без сети — мёртвая кнопка.
 * 4. /on-route упразднён: второй полевой экран без тестов и с подставными
 *    координатами — та же болезнь, что две карточки тура (#887).
 * 5. Deep-link двусторонний: переключение таба обновляет URL.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const CLIENT = read('app/planning/_PlanningClient.tsx');
const PROGRESS = read('components/field/RouteProgressBar.tsx');
const TRUST = read('components/field/TrustCard.tsx');

describe('прогресс — честный полноширинный модуль', () => {
  it('экран отдаёт прогрессу род линии и живость фикса', () => {
    expect(CLIENT).toMatch(/<RouteProgressBar/);
    expect(CLIENT).toMatch(/fidelity=\{lineFidelity\}/);
    expect(CLIENT).toMatch(/live=\{figuresLive\}/);
  });

  it('процент и километраж — только у снятого трека', () => {
    expect(PROGRESS).toMatch(/fidelity !== 'surveyed'/);
    expect(PROGRESS).toMatch(/ориентир, не тропа/);
    expect(PROGRESS).toMatch(/по ломаной между точками/);
  });

  it('мёртвый фикс не анимирует бар и подписан возрастом', () => {
    expect(PROGRESS).toMatch(/p\.live \? 'transition-all duration-500' : ''/);
    expect(PROGRESS).toMatch(/staleLabel/);
  });

  it('при конфликте данных прогресса нет вовсе', () => {
    expect(CLIENT).toMatch(/!approach\?\.dataConflict && \(\s*<RouteProgressBar/);
  });

  it('одна точка — цель, а не ход: блока нет', () => {
    expect(PROGRESS).toMatch(/if \(p\.totalKm <= 0\) return null/);
  });
});

describe('карточка доверия', () => {
  it('«линия проверена» — только про снятый трек', () => {
    // Комментарии вырезаются: правило упоминается в пояснениях рядом.
    const code = TRUST.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    const surveyedBranch = code.slice(code.indexOf("case 'surveyed'"), code.indexOf("case 'sketch'"));
    expect(surveyedBranch).toContain('линия проверена');
    // Ни одна другая ветка не произносит «проверена».
    const rest = code.replace(surveyedBranch, '');
    expect(rest).not.toContain('линия проверена');
  });

  it('набросок называется наброском, конфликт — расхождением', () => {
    expect(TRUST).toMatch(/Набросок · линия построена прямыми между точками/);
    expect(TRUST).toMatch(/Линия и точки маршрута расходятся/);
  });

  it('экран передаёт карточке конфликт, пакет и качество фикса', () => {
    expect(CLIENT).toMatch(/<TrustCard/);
    expect(CLIENT).toMatch(/conflict=\{approach\?\.dataConflict === true\}/);
    expect(CLIENT).toMatch(/fixLabel=\{fixLabel\(fix\)\}/);
  });
});

describe('«Условия» — внутренний слой, не внешняя погода', () => {
  it('внешней погоды в полевом режиме больше нет', () => {
    expect(CLIENT).not.toMatch(/openweathermap/);
    expect(CLIENT).toContain('УСЛОВИЯ');
  });

  it('снимок из пакета работает без сети, недоступность не «спокойно»', () => {
    expect(CLIENT).toMatch(/pack\?\.safety && !pack\.safety\.unavailable/);
    expect(CLIENT).toMatch(/Данных об обстановке сейчас нет/);
    expect(CLIENT).toMatch(/Это не означает, что опасности нет/);
  });

  it('живой статус не строится из недоступного источника', () => {
    expect(CLIENT).toMatch(/if \(d\.unavailable === true\) return;/);
  });
});

describe('один полевой экран на платформу', () => {
  it('/on-route — redirect, клиент-копия удалена', () => {
    expect(read('app/on-route/page.tsx')).toMatch(/redirect\('\/planning\?mode=trail'\)/);
    expect(() => read('app/on-route/_OnRouteClient.tsx')).toThrow();
  });

  it('SW больше не прекэширует и не считает /on-route офлайн-способным', () => {
    const sw = read('public/sw.js');
    expect(sw).not.toMatch(/'\/on-route'/);
  });

  it('входные ссылки ведут в единый полевой режим', () => {
    expect(read('app/dashboard/_DashboardClient.tsx')).toMatch(/href="\/planning\?mode=trail"/);
  });
});

describe('deep-link двусторонний', () => {
  it('переключение таба обновляет URL (replaceState, не push)', () => {
    expect(CLIENT).toMatch(/function switchTab/);
    expect(CLIENT).toMatch(/history\.replaceState/);
    expect(CLIENT).toMatch(/searchParams\.set\('mode', 'trail'\)/);
  });
});
