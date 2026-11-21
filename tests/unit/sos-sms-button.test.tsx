// @vitest-environment jsdom
/**
 * SMS на 112 с экрана SOS — есть всегда, и шаг «Что делать» зовёт её её же
 * подписью (проверка /sos на проде 21.11).
 *
 * Было: шаг 4 говорил «кнопка «Без интернета»», а кнопка называлась «SMS с
 * координатами (без интернета)» и появлялась только после того, как нашлись
 * координаты. Человек без голоса и без координат кнопки SMS не видел.
 *
 * Сторож держит:
 *   - текст SMS с координатами и без них, адрес ссылки — вызовом;
 *   - экран SOS без координат: ссылка `sms:112` на месте, под ней сказано,
 *     что координаты надо дописать; кнопка, которую называет шаг «Что
 *     делать», есть на экране с той же подписью; шаг про спутниковый маяк
 *     стоит до шага SMS (перенесено из communication-page) — рендером.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { SOS_SMS_LABEL, SOS_SMS_STEP, sosSmsBody, sosSmsHint, sosSmsHref } from '@/lib/safety/sos-sms';

describe('текст SMS на 112', () => {
  it('с координатами — координаты в тексте', () => {
    const body = sosSmsBody({ lat: 53.012345, lng: 158.654321 });
    expect(body).toContain('53.01235, 158.65432');
    expect(sosSmsHint(true)).toBe('Координаты уже в сообщении');
  });

  it('без координат — просьба дописать, где человек, курсор в конце', () => {
    const body = sosSmsBody(null);
    expect(body).toContain('Координаты не определились');
    expect(body.endsWith('Где я: ')).toBe(true);
    expect(sosSmsHint(false)).toContain('допишите');
  });

  it('адрес ссылки — SMS на 112 с этим текстом', () => {
    const href = sosSmsHref(null);
    expect(href.startsWith('sms:112?body=')).toBe(true);
    expect(decodeURIComponent(href.slice('sms:112?body='.length))).toBe(sosSmsBody(null));
  });

  it('шаг «Что делать» называет кнопку её подписью', () => {
    expect(SOS_SMS_STEP).toContain(`«${SOS_SMS_LABEL}»`);
  });
});

// Тяжёлые части экрана, к SMS не причастные: анимация, камера, чат с моделью,
// предложение пушей. Сам экран — настоящий.
vi.mock('@/components/ui/LottiePlayer', () => ({ default: () => null }));
vi.mock('@/components/safety/SosQrScanner', () => ({ SosQrScanner: () => null }));
vi.mock('@/components/safety/RescueChat', () => ({ default: () => null }));
vi.mock('@/components/PWA/PushSafetyOffer', () => ({ PushSafetyOffer: () => null }));

describe('экран SOS без координат', () => {
  afterEach(() => cleanup());

  it('ссылка SMS на 112 на месте и говорит, что координаты надо дописать', async () => {
    const { default: SosPage } = await import('@/app/sos/page');
    render(<SosPage />);
    const sms = screen.getAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').startsWith('sms:112'));
    expect(sms).toHaveLength(1);
    expect(sms[0].textContent).toContain(SOS_SMS_LABEL);
    expect(sms[0].textContent).toContain(sosSmsHint(false));
    expect(sms[0].getAttribute('href')).toBe(sosSmsHref(null));
  });

  it('шаг про спутниковый маяк стоит до шага SMS (31.07: в панике про маяк забывают)', async () => {
    const { default: SosPage } = await import('@/app/sos/page');
    render(<SosPage />);
    const steps = screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
    const beacon = steps.findIndex((t) => t.includes('активируй его сейчас'));
    const sms = steps.findIndex((t) => t.includes(SOS_SMS_STEP));
    expect(beacon).toBeGreaterThanOrEqual(0);
    expect(sms).toBeGreaterThan(beacon);
  });

  it('кнопка, которую называет шаг «Что делать», есть на экране', async () => {
    const { default: SosPage } = await import('@/app/sos/page');
    render(<SosPage />);
    const step = screen.getByText(SOS_SMS_STEP);
    const named = /«([^»]+)»/.exec(step.textContent ?? '')?.[1];
    expect(named).toBeTruthy();
    const links = screen.getAllByRole('link').filter((a) => (a.textContent ?? '').includes(named as string));
    expect(links.length).toBeGreaterThan(0);
  });
});
