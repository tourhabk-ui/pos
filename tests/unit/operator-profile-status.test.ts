/**
 * Статус партнёрской заявки — один словарь, четыре значения (#1798).
 *
 * Онбординг писал «Заявка одобрена» всем, кроме `pending`, а профиль печатал
 * сырое «none»: у поля четыре значения по CHECK базы, у экранов было два и
 * пять соответственно, и совпадали они в двух. Завершение онбординга при этом
 * не читало ответ — при отказе дашборд возвращал в визард без объяснения.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILE_STATUSES, profileStatusView, isProfileStatus } from '@/lib/operator/profile-status';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('словарь статусов заявки', () => {
  it('совпадает с CHECK миграции партнёров', () => {
    expect([...PROFILE_STATUSES]).toEqual(['none', 'pending', 'approved', 'rejected']);
    const migrations = read('migrations/052_operator_onboarding.sql');
    for (const s of PROFILE_STATUSES) expect(migrations).toContain(`'${s}'`);
  });

  it('у каждого значения своя подпись — «одобрена» не достаётся остальным', () => {
    const labels = PROFILE_STATUSES.map((s) => profileStatusView(s).onboarding);
    expect(new Set(labels).size).toBe(PROFILE_STATUSES.length);
    expect(profileStatusView('none').onboarding).not.toContain('одобрена');
    expect(profileStatusView('rejected').onboarding).not.toContain('одобрена');
    expect(profileStatusView('approved').onboarding).toContain('одобрена');
  });

  it('неизвестное значение не показывается сырым', () => {
    expect(isProfileStatus('active')).toBe(false);
    expect(profileStatusView('active').label).toBe('Статус неизвестен');
    expect(profileStatusView(null).label).toBe('Статус неизвестен');
  });
});

describe('экраны читают общий словарь', () => {
  it('онбординг и профиль не держат своих наборов подписей', () => {
    const onboarding = read('app/hub/operator/onboarding/_OnboardingClient.tsx');
    const profile = read('app/hub/operator/profile/_ProfileClient.tsx');
    expect(onboarding).toMatch(/profileStatusView\(profile\.profile_status\)\.onboarding/);
    expect(onboarding).not.toMatch(/=== 'pending' \? 'на рассмотрении' : 'одобрена'/);
    expect(profile).toMatch(/profileStatusView\(profileStatus\)/);
    expect(profile).not.toMatch(/statusLabel: Record/);
  });

  it('завершение онбординга читает ответ и показывает отказ', () => {
    const src = read('app/hub/operator/onboarding/_OnboardingClient.tsx');
    expect(src).toMatch(/async function completeOnboarding\(\): Promise<string \| null>/);
    // Обе кнопки шага 2 идут через него и не редиректят вслепую.
    expect(src.match(/const failure = await completeOnboarding\(\);/g) ?? []).toHaveLength(2);
    expect(src).toMatch(/if \(failure\) \{ setError\(failure\); return; \}/);
    expect(src).not.toMatch(/body: JSON\.stringify\(\{ complete_onboarding: true \}\),\s*\}\)\.catch/);
  });

  it('503 шифрования объясняет выход, а не бросает оператора', () => {
    const src = read('app/hub/operator/onboarding/_OnboardingClient.tsx');
    expect(src).toMatch(/payRes\.status === 503/);
    expect(src).toMatch(/Можно пропустить шаг/);
  });
});
