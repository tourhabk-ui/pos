export type MchsRegistrationStatus = 'submitted' | 'registered' | 'rejected' | 'failed';

export interface MchsRegistrationResult {
  status: MchsRegistrationStatus;
  requestId: string | null;
  responsePayload: unknown;
  errorMessage: string | null;
}

/**
 * Исход «сохранено в кабинете, в МЧС не отправлено» — единственный, который
 * Ведар производит.
 *
 * До 10.11 здесь жила registerGroupWithMchs: POST состава группы (ФИО,
 * телефоны, даты рождения, контакты) на адрес из env MCHS_API_URL. Программного
 * приёма заявок у МЧС нет, переменная на проде не задана, и функция всегда
 * отвечала `failed`. Но задай кто-нибудь адрес — ПД туристов ушли бы туда без
 * согласия на такую передачу (аудит 10.11). Отправка удалена, а не выключена
 * флагом: путь наружу появится только видимым коммитом вместе с основанием
 * передачи ПД. Сторож: tests/unit/mchs-no-outbound.test.ts.
 */
export const MCHS_NOT_SENT: MchsRegistrationResult = {
  status: 'failed',
  requestId: null,
  responsePayload: null,
  errorMessage: 'Ведар данные группы в МЧС не передаёт',
};

/**
 * Что сказать оператору после попытки отправки — строго по тому, что код
 * сделал на самом деле.
 *
 * Прежний ответ для всех исходов, кроме `failed`, был «Группа автоматически
 * зарегистрирована в МЧС». Это была ложь для `submitted`: прежняя отправка
 * лишь POST-ила заявку на адрес из env MCHS_API_URL (удалена 10.11), и
 * `submitted` значило «адрес ответил 2xx без подтверждения регистрации».
 * Статусы кроме `failed` остаются для старых записей. Настоящая регистрация
 * группы — forms.mchs.gov.ru или телефон. Оператор, прочитавший
 * «зарегистрирована», мог не зарегистрировать группу нигде — это цена
 * ошибки на маршруте.
 */
export function mchsOutcomeMessage(
  status: MchsRegistrationStatus,
  requestId: string | null,
  errorMessage: string | null,
): string {
  const selfRegister =
    'Зарегистрируйте группу самостоятельно на forms.mchs.gov.ru или по телефону МЧС Камчатки.';
  switch (status) {
    case 'registered':
      return (
        'Адрес приёма заявок ответил, что группа зарегистрирована' +
        (requestId ? ` (номер заявки ${requestId})` : '') +
        '. Сверьте регистрацию с МЧС до выхода группы.'
      );
    case 'submitted':
      return (
        'Заявка передана на адрес приёма заявок' +
        (requestId ? ` (номер ${requestId})` : '') +
        ', но подтверждения регистрации в МЧС нет. ' +
        selfRegister
      );
    case 'rejected':
      return 'Заявка отклонена адресом приёма заявок. ' + selfRegister;
    case 'failed':
    default:
      return (
        'Запись сохранена в кабинете, но в МЧС не отправлена' +
        (errorMessage ? ` (${errorMessage})` : '') +
        '. ' +
        selfRegister
      );
  }
}
