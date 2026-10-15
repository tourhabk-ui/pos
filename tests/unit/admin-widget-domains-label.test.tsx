/**
 * Подпись списка доменов виджета в админке говорит правду (аудит 15.10,
 * WID-measure / WID-config). Прежняя «Домены не указаны — виджет не будет
 * работать» была неправдой: список доменов ничего не запирает, виджет
 * работает на любом сайте, а по списку только видно, пришёл ли посетитель с
 * сайта партнёра (listed / unlisted). Судится рендером карточки оператора.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
// Панель Tilda грузит свои ключи при монтировании — к виджету отношения не имеет.
vi.mock('@/components/admin/TildaPanel', () => ({ default: () => null }));

import { OperatorCard, WIDGET_DOMAINS_EMPTY_TEXT } from '@/app/hub/admin/operators/_OperatorsClient';

type Op = Parameters<typeof OperatorCard>[0]['op'];

const OP: Op = {
  id: '0aaa4f05-0000-4000-8000-000000000001',
  company_name: 'Местечко Камчатка',
  category: 'operator',
  description: '',
  // На проверке — карточка раскрыта сразу.
  profile_status: 'pending',
  applied_at: null,
  is_verified: true,
  is_public: true,
  profile_review_comment: null,
  email: null,
  contact_name: null,
  registered_at: null,
  has_account: false,
  external_source: null,
  application_id: null,
  contact_phone: null,
  contact_email: null,
  inn: null,
  application_status: null,
  reviewed_at: null,
  telegram_chat_id: null,
  has_telegram: false,
  has_max: false,
  slug: 'mestechko',
  widget_enabled: false,
  widget_domains: ['mestechkokam.ru'],
};

function renderCard(op: Op) {
  return render(
    <OperatorCard op={op} onApprove={() => {}} onReject={() => {}} onAccountCreated={() => {}} acting={null} />,
  );
}

afterEach(() => cleanup());

describe('список доменов виджета — сигнал, а не замок', () => {
  it('пустой список: сказано, что виджет работает на любом сайте, без «не будет работать»', () => {
    renderCard({ ...OP, widget_enabled: true, widget_domains: [] });
    expect(screen.getByText(WIDGET_DOMAINS_EMPTY_TEXT)).toBeTruthy();
    expect(WIDGET_DOMAINS_EMPTY_TEXT).toMatch(/работает на любом сайте/);
    expect(document.body.textContent).not.toMatch(/не будет работать/);
    expect(document.body.textContent).not.toMatch(/Разрешённые домены/);
  });

  it('список задан: видны домены, подписи пустого списка нет', () => {
    renderCard({ ...OP, widget_enabled: true, widget_domains: ['mestechkokam.ru'] });
    expect(screen.getByText('mestechkokam.ru')).toBeTruthy();
    expect(screen.queryByText(WIDGET_DOMAINS_EMPTY_TEXT)).toBeNull();
  });
});
