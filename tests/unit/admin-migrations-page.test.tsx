/**
 * Экран «Миграции БД» только читает — рендером (аудит 15.10, находка P4-04).
 *
 * Прежде здесь стояла кнопка «Применить миграции» с обещанием «Идемпотентно —
 * повторный запуск безопасен»: она звала HTTP-накатчик, который не отмечал
 * файлы в `_migrations`, и следующий деплой катил их второй раз. Теперь экран
 * показывает, что не применено и почему, и ничего не применяет.
 *
 * Что видит админ: имена в порядке деплоя, причину рядом с именем, честное
 * «записи нет» и отдельное «не смог прочитать» вместо «всё применено».
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import AdminMigrationsPage from '@/app/hub/admin/migrations/page';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const respond = (status: number, body: unknown) => Promise.resolve({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
});

const BASE = {
  success: true,
  files_total: 724,
  applied_total: 722,
  other_failures: [],
  reasons_known: true,
  failures_error: null,
};

function calledUrls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

function calledMethods(): string[] {
  return fetchMock.mock.calls.map((c) => String((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase());
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe('экран миграций', () => {
  it('показывает неприменённые с причиной и ничего не предлагает применить', async () => {
    fetchMock.mockImplementation(() => respond(200, {
      ...BASE,
      unapplied: [
        { name: '999_klyuchevskoy_owner_photo.sql', error: 'column "x" does not exist', attempts: 3, last_failed_at: '2026-10-14T20:00:00.000Z' },
        { name: '1264_koshelev_thermal_fields.sql', error: null, attempts: null, last_failed_at: null },
      ],
    }));
    render(<AdminMigrationsPage />);

    expect(await screen.findByText('999_klyuchevskoy_owner_photo.sql')).toBeInTheDocument();
    expect(screen.getByText('column "x" does not exist')).toBeInTheDocument();
    expect(screen.getByText(/Попыток: 3/)).toBeInTheDocument();
    expect(screen.getByText('1264_koshelev_thermal_fields.sql')).toBeInTheDocument();
    expect(screen.getByText(/Записи о падении нет/)).toBeInTheDocument();
    expect(screen.getByText(/не применено: 2/)).toBeInTheDocument();

    // Порядок в документе — порядок деплоя, как его отдал сервер.
    const first = screen.getByText('999_klyuchevskoy_owner_photo.sql');
    const second = screen.getByText('1264_koshelev_thermal_fields.sql');
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Кнопки наката нет, ложного обещания тоже.
    expect(screen.queryByRole('button', { name: /Применить|Dry run|проверить/i })).toBeNull();
    expect(screen.queryByText(/Идемпотентно/)).toBeNull();
    expect(screen.getByText(/применяет только деплой/)).toBeInTheDocument();

    // Экран только читает: один адрес состояния, без POST.
    expect(calledUrls()).toEqual(['/api/admin/migrations/status']);
    expect(calledMethods()).toEqual(['GET']);
  });

  it('отказ проверки — «не прочитано», а не «всё применено»', async () => {
    fetchMock.mockImplementation(() => respond(500, {
      success: false,
      error: 'Журнал _migrations не прочитан: 42P01: relation "_migrations" does not exist',
    }));
    render(<AdminMigrationsPage />);

    expect(await screen.findByText('Состояние миграций не прочитано')).toBeInTheDocument();
    expect(screen.getByText(/42P01/)).toBeInTheDocument();
    expect(screen.queryByText(/отмечены в _migrations/)).toBeNull();
  });

  it('всё применено — говорит это числом файлов', async () => {
    fetchMock.mockImplementation(() => respond(200, { ...BASE, applied_total: 724, unapplied: [] }));
    render(<AdminMigrationsPage />);

    expect(await screen.findByText('Все 724 файлов каталога отмечены в _migrations')).toBeInTheDocument();
  });

  it('таблица причин не прочитана — причины названы неизвестными', async () => {
    fetchMock.mockImplementation(() => respond(200, {
      ...BASE,
      reasons_known: false,
      failures_error: '42501: permission denied',
      unapplied: [{ name: '1264_koshelev_thermal_fields.sql', error: null, attempts: null, last_failed_at: null }],
    }));
    render(<AdminMigrationsPage />);

    expect(await screen.findByText('Причины падений не прочитаны')).toBeInTheDocument();
    expect(screen.getByText(/42501: permission denied/)).toBeInTheDocument();
    expect(screen.getByText(/Причина неизвестна/)).toBeInTheDocument();
    // «Записи нет» утверждать нельзя — таблицу мы не видели.
    expect(screen.queryByText(/Записи о падении нет/)).toBeNull();
  });

  it('запись о падении у применённого файла видна отдельным блоком', async () => {
    fetchMock.mockImplementation(() => respond(200, {
      ...BASE,
      unapplied: [],
      applied_total: 724,
      other_failures: [{ name: '806_old.sql', error: 'null value in column "type"', attempts: 2, last_failed_at: null }],
    }));
    render(<AdminMigrationsPage />);

    expect(await screen.findByText('806_old.sql')).toBeInTheDocument();
    expect(screen.getByText('Записи о падении у других файлов')).toBeInTheDocument();
    expect(screen.getByText('null value in column "type"')).toBeInTheDocument();
  });
});
