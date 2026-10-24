'use client';

import { useEffect, useState } from 'react';

/** ISO `ГГГГ-ММ-ДД` → «дд.мм.гггг». Пустая и битая строка — пусто, не подстановка. */
export function isoToRuDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

/** «дд.мм.гггг» → ISO. Несуществующий день (31.02) — null, а не сдвиг на март. */
export function ruDateToIso(text: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** Цифры по мере набора → «дд.мм.гггг». Точки ставятся сами. */
export function maskRuDate(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}.${d.slice(2)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4)}`;
}

/**
 * Дата заезда по-русски: «дд.мм.гггг».
 *
 * Нативный `input type="date"` рисует месяц первым и подписями локали
 * браузера (на телефоне без русской локали это mm/dd/yyyy). Значение для
 * заявки остаётся ISO: в форму уходит только разобранная дата внутри min/max.
 */
export function RuDateInput({
  value,
  onChange,
  id,
  name,
  invalid,
  min,
  max,
  required,
  ariaLabel,
}: {
  value: string;
  onChange: (iso: string) => void;
  id?: string;
  name?: string;
  invalid?: boolean;
  /** Нижняя граница, ISO. Раньше неё дата в форму не пишется. */
  min?: string;
  /** Верхняя граница, ISO. */
  max?: string;
  required?: boolean;
  /**
   * Имя для диктора, когда рядом нет `<label htmlFor={id}>`.
   * С `id` имя берёт видимая подпись: свой aria-label её заглушил бы.
   */
  ariaLabel?: string;
}) {
  const accessibleName = ariaLabel ?? (id ? undefined : 'Дата заезда, дд.мм.гггг');
  const [text, setText] = useState(() => isoToRuDate(value));
  const [outOfRange, setOutOfRange] = useState(false);

  useEffect(() => {
    setText(isoToRuDate(value));
    if (value) setOutOfRange(false);
  }, [value]);

  const bad = Boolean(invalid || outOfRange);

  return (
    <input
      type="text"
      inputMode="numeric"
      lang="ru"
      autoComplete="off"
      placeholder="дд.мм.гггг"
      aria-label={accessibleName}
      id={id}
      name={name}
      value={text}
      required={required}
      aria-invalid={bad || undefined}
      className="ds-input w-full"
      style={bad ? { borderColor: 'var(--danger)' } : undefined}
      onChange={(e) => {
        const masked = maskRuDate(e.target.value);
        setText(masked);
        if (!masked) {
          setOutOfRange(false);
          if (value) onChange('');
          return;
        }
        const iso = ruDateToIso(masked);
        if (!iso) {
          setOutOfRange(masked.length === 10);
          if (value) onChange('');
          return;
        }
        if ((min && iso < min) || (max && iso > max)) {
          setOutOfRange(true);
          if (value) onChange('');
          return;
        }
        setOutOfRange(false);
        onChange(iso);
      }}
    />
  );
}
