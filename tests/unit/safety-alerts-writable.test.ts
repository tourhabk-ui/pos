/**
 * Сторож: предупреждение о закрытой зоне можно ЗАВЕСТИ и оно ДОХОДИТ до туриста.
 *
 * 22.08.2026 пришло сообщение о временном ограничении посещения природного
 * парка «Ключевской» — паводок на Студёной, разрушена подъездная дорога,
 * сквозной проезд перекрыт. Донести это до туриста платформе было нечем.
 *
 * Таблица `safety_alerts` существовала с миграции 065, чья собственная шапка
 * обещает: «Admins create alerts per zone; planner surfaces them». Половина
 * обещания не выполнялась ни дня — у таблицы был РОВНО ОДИН потребитель
 * (`SELECT` в планировщике) и НИ ОДНОГО пишущего. Ни API, ни экрана.
 *
 * Второй разрыв был на выходе: даже заведённое предупреждение видел только
 * планировщик. Турист, открывший карточку маршрута или тура напрямую, о
 * закрытии парка не узнавал — `/api/safety/warnings` эту таблицу не читал.
 *
 * Тест держит обе половины. Он структурный: поднять роут с базой здесь нельзя,
 * а вопрос ровно в том, существует ли путь.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ALERT_ZONES, ALERT_SEVERITIES, alertInputSchema } from '@/lib/safety/alerts';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Комментарий — не код: пояснение про INSERT само вставкой не является. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('safety_alerts: предупреждение можно завести', () => {
  it('есть модуль записи с INSERT в таблицу', () => {
    const src = code('lib/safety/alerts.ts');
    expect(src).toMatch(/INSERT INTO safety_alerts/);
    expect(src).toMatch(/UPDATE safety_alerts SET is_active = FALSE/);
  });

  it('есть адрес, по которому администратор её заводит', () => {
    expect(existsSync(join(ROOT, 'app/api/admin/safety/alerts/route.ts'))).toBe(true);
    const src = code('app/api/admin/safety/alerts/route.ts');
    expect(src, 'создание без проверки роли — чужой может закрыть зону').toMatch(/requireAdmin/);
    expect(src, 'вход без Zod — CLAUDE.md §4').toMatch(/alertInputSchema/);
    expect(src).toMatch(/export async function POST/);
  });

  it('снятие — отдельным адресом и не удалением строки', () => {
    const src = code('app/api/admin/safety/alerts/[id]/route.ts');
    expect(src).toMatch(/requireAdmin/);
    expect(src).toMatch(/deactivateAlert/);
    expect(code('lib/safety/alerts.ts'), 'снятое ограничение — тоже факт').not.toMatch(/DELETE FROM safety_alerts/);
  });

  it('у администратора есть экран, а не только адрес', () => {
    const panel = code('components/admin/ZoneAlertsPanel.tsx');
    expect(panel).toMatch(/\/api\/admin\/safety\/alerts/);
    expect(code('app/hub/admin/safety/SafetyDashboardClient.tsx')).toMatch(/ZoneAlertsPanel/);
  });
});

describe('safety_alerts: предупреждение доходит до туриста', () => {
  it('карточка маршрута и тура читает ограничения зоны', () => {
    const src = code('app/api/safety/warnings/route.ts');
    expect(src).toMatch(/activeAlertsForZone/);
    expect(src, 'ответ обязан нести ограничения отдельным полем').toMatch(/zone_alerts/);
  });

  it('«не смогли спросить» отличается от «ограничений нет»', () => {
    // §4.0: пустой список и несостоявшийся запрос выглядят одинаково, если их
    // не различить явно. Для закрытого парка эта разница — решение о выходе.
    expect(code('app/api/safety/warnings/route.ts')).toMatch(/zone_alerts_checked/);
    expect(code('components/safety/SafetyWarnings.tsx')).toMatch(/zone_alerts_checked/);
  });

  it('блок предупреждений не прячется, когда сигналов нет, а ограничение есть', () => {
    const src = code('components/safety/SafetyWarnings.tsx');
    // Раньше условие было `data.signals.length === 0 → return null`, и
    // ограничение зоны исчезало вместе с пустыми сигналами.
    expect(src).toMatch(/signals\.length === 0 && zoneAlerts\.length === 0/);
  });
});

describe('safety_alerts: зоны и уровни не расходятся с миграцией 065', () => {
  const migration = read('migrations/065_safety_alerts.sql');

  it('каждая зона модуля разрешена CHECK-ограничением', () => {
    for (const z of ALERT_ZONES) {
      expect(migration, `зона ${z} не разрешена миграцией — INSERT упадёт`).toContain(`'${z}'`);
    }
  });

  it('каждый уровень модуля разрешён CHECK-ограничением', () => {
    for (const s of ALERT_SEVERITIES) {
      expect(migration, `уровень ${s} не разрешён миграцией`).toContain(`'${s}'`);
    }
  });

  it('форма отвергает пустое и слишком длинное', () => {
    expect(alertInputSchema.safeParse({
      zone: 'northern', severity: 'critical', title: 'кор', message: 'мало', source: 'МЧС',
    }).success).toBe(false);

    expect(alertInputSchema.safeParse({
      zone: 'northern', severity: 'critical',
      title: 'Посещение природного парка «Ключевской» временно ограничено',
      message: 'Паводок на реке Студёной, разрушена подъездная дорога, сквозной проезд перекрыт.',
      source: 'МЧС Камчатка',
    }).success).toBe(true);

    expect(alertInputSchema.safeParse({
      zone: 'нет-такой-зоны', severity: 'critical',
      title: 'Заголовок нормальной длины', message: 'Сообщение нормальной длины.',
    }).success).toBe(false);
  });
});
