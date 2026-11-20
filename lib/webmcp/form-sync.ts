/**
 * Поля формы, которые заполнил агент, — в состояние React.
 *
 * Формы Ведара управляемые: значение живёт в состоянии, а при отправке
 * читается оттуда. Как Chrome вписывает ответ агента в поле, объяснение
 * WebMCP не говорит (событий input/change оно не обещает). Если значение
 * легло в DOM мимо React, человек видел бы заполненную форму, а отправка
 * ответила бы «укажите имя». Поэтому по событию `toolactivated` (форма
 * заполнена, ещё не отправлена) значения перечитываются из DOM.
 *
 * Читаются только поля из списка, по `name`. Пустое значение не стирает
 * уже введённое человеком.
 */
export function readFormValues<K extends string>(form: HTMLFormElement, names: readonly K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const name of names) {
    const el = form.elements.namedItem(name);
    if (!el || typeof (el as { value?: unknown }).value !== 'string') continue;
    const value = (el as HTMLInputElement).value;
    if (value.length > 0) out[name] = value;
  }
  return out;
}
