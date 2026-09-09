'use client';

/**
 * Поле «телефон руководителя группы» — второй ключ к отметкам на регистрации.
 *
 * Существует потому, что сообщение об эскалации уходит ЭКСТРЕННОМУ КОНТАКТУ,
 * а не туристу: у контакта нашего аккаунта нет и не будет. До 09.09 сообщение
 * писало «понадобится номер руководителя», а на странице отметки поля для
 * номера не было ВООБЩЕ — контакт упирался в 403 без единого способа пройти
 * дальше. Петля «отметьте возвращение» не работала для того единственного
 * человека, которому её присылали.
 */

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Текст отказа от сервера: «номер не дали» и «номер не тот» звучат по-разному. */
  error?: string | null;
}

export default function LeaderPhoneField({ value, onChange, disabled, error }: Props) {
  return (
    <div className="mb-6">
      <label htmlFor="leader-phone" className="ds-label block mb-2">
        Телефон руководителя группы
      </label>
      <input
        id="leader-phone"
        name="leader_phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="+7 914 000-00-00"
        className="ds-input w-full"
      />
      <p className="text-xs text-[var(--text-secondary)] mt-2">
        Номер подтверждает, что отметку ставит свой человек. Если вы вошли в аккаунт,
        на который оформлена регистрация, поле можно оставить пустым.
      </p>
      {error && (
        <p className="text-sm text-[var(--danger)] mt-2">{error}</p>
      )}
    </div>
  );
}
