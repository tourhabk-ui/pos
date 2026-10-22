/**
 * Экран помощника кабинета: кнопка-пример ПИШУЩЕЙ команды ничего не пишет
 * (ревью 22.10).
 *
 * Кнопка «Добавить слоты» слала «Добавь слоты туру 1 с 2027-07-01 по
 * 2027-07-31, 8 мест» сразу по нажатию: одно нажатие на «пример» открывало в
 * продажу 31 дату туру 1 (у его владельца — по-настоящему, остальным — ответ,
 * выдающий, что тур 1 существует и чей он). Теперь пример пишущей команды
 * подставляется в поле, отправляет человек; пример чтения — как раньше, сразу
 * ответ. Сторож рендерит экран и смотрит, что ушло на сервер.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/components/operator/use-operator-seat', () => ({
  useOperatorSeat: () => ({ state: 'ok', kind: 'owner', perms: { can_edit_prices: true, can_cancel_bookings: true } }),
  isManagerSeat: () => false,
}));

import { AIAssistClient } from '@/app/hub/operator/ai-assist/AIAssistClient';
import { OPERATOR_COMMAND_EXAMPLES } from '@/lib/agents/operator-commands';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ success: true, intent: 'op_tours_summary', response: 'Ваши туры', duration_ms: 1 }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const agentCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/agents/operator');

describe('кнопки-примеры помощника', () => {
  it.each(OPERATOR_COMMAND_EXAMPLES.filter((e) => e.group === 'write'))(
    '«$label» (запись) — образец в поле, на сервер не уходит ничего', async ({ label, message }) => {
      render(<AIAssistClient />);
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect((screen.getByLabelText('Команда помощнику') as HTMLTextAreaElement).value).toBe(message);
      // Дать эффектам и обещаниям шанс: отправки не было и не будет.
      await new Promise((r) => setTimeout(r, 20));
      expect(agentCalls()).toHaveLength(0);
    });

  it('образец «Добавить слоты» без настоящего номера тура: отправленный как есть, он не номер тура', () => {
    const chip = OPERATOR_COMMAND_EXAMPLES.find((e) => e.intent === 'op_add_slots')!;
    expect(chip.message).not.toMatch(/тур(?:у|а)?\s+\d/);
  });

  it('пример чтения — сразу запрос и ответ, как раньше', async () => {
    render(<AIAssistClient />);
    const read = OPERATOR_COMMAND_EXAMPLES.find((e) => e.group === 'read')!;
    fireEvent.click(screen.getByRole('button', { name: read.label }));
    await waitFor(() => expect(agentCalls()).toHaveLength(1));
    expect(JSON.parse(String((agentCalls()[0]![1] as RequestInit).body))).toEqual({ message: read.message });
    expect(await screen.findByText('Ваши туры')).toBeTruthy();
  });

  it('образец в поле отправляет человек — кнопкой «отправить»', async () => {
    render(<AIAssistClient />);
    const write = OPERATOR_COMMAND_EXAMPLES.find((e) => e.intent === 'op_add_slots')!;
    fireEvent.click(screen.getByRole('button', { name: write.label }));
    const box = screen.getByLabelText('Команда помощнику') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Добавь слоты туру 42 с 2027-07-01 по 2027-07-31, 8 мест' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(agentCalls()).toHaveLength(1));
    expect(JSON.parse(String((agentCalls()[0]![1] as RequestInit).body)).message).toMatch(/туру 42/);
  });
});
