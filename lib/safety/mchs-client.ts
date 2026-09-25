export type MchsRegistrationStatus = 'submitted' | 'registered' | 'rejected' | 'failed';

export interface MchsGroupMember {
  fullName: string;
  phone?: string;
  birthDate?: string;
}

export interface MchsGuideContact {
  fullName: string;
  phone: string;
  email?: string;
}

export interface MchsEmergencyContact {
  name: string;
  phone: string;
  relation?: string;
}

export interface MchsRegistrationPayload {
  groupName: string;
  groupMembers: MchsGroupMember[];
  routeDescription: string;
  routeRegion?: string;
  startDate: string;
  endDate: string;
  guideContact: MchsGuideContact;
  emergencyContacts: MchsEmergencyContact[];
  participantCount: number;
}

export interface MchsRegistrationResult {
  status: MchsRegistrationStatus;
  requestId: string | null;
  responsePayload: unknown;
  errorMessage: string | null;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MCHS_ENDPOINT = 'https://mchs.example.invalid/register-group';

function buildMchsEndpoint(): string {
  return process.env.MCHS_API_URL || DEFAULT_MCHS_ENDPOINT;
}

export async function registerGroupWithMchs(
  payload: MchsRegistrationPayload
): Promise<MchsRegistrationResult> {
  const endpoint = buildMchsEndpoint();
  const token = process.env.MCHS_API_TOKEN;

  if (!process.env.MCHS_API_URL) {
    return {
      status: 'failed',
      requestId: null,
      responsePayload: null,
      errorMessage: 'MCHS_API_URL не настроен',
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    const responsePayload: unknown = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      return {
        status: 'failed',
        requestId: null,
        responsePayload,
        errorMessage: `МЧС API вернул HTTP ${response.status}`,
      };
    }

    const requestId =
      typeof responsePayload === 'object' &&
      responsePayload !== null &&
      (typeof (responsePayload as Record<string, unknown>).requestId === 'string' ||
        typeof (responsePayload as Record<string, unknown>).id === 'string')
        ? (typeof (responsePayload as Record<string, unknown>).requestId === 'string'
            ? ((responsePayload as Record<string, unknown>).requestId as string)
            : ((responsePayload as Record<string, unknown>).id as string))
        : null;

    const statusValue =
      typeof responsePayload === 'object' &&
      responsePayload !== null &&
      typeof (responsePayload as Record<string, unknown>).status === 'string'
        ? (responsePayload as Record<string, unknown>).status
        : null;

    const status: MchsRegistrationStatus =
      statusValue === 'registered' ? 'registered' : 'submitted';

    return {
      status,
      requestId,
      responsePayload,
      errorMessage: null,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Неизвестная ошибка запроса в МЧС API';

    return {
      status: 'failed',
      requestId: null,
      responsePayload: null,
      errorMessage,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Что сказать оператору после попытки отправки — строго по тому, что код
 * сделал на самом деле.
 *
 * Прежний ответ для всех исходов, кроме `failed`, был «Группа автоматически
 * зарегистрирована в МЧС». Это ложь для `submitted`: registerGroupWithMchs
 * лишь POST-ит заявку на адрес из env MCHS_API_URL, и `submitted` значит
 * «адрес ответил 2xx без подтверждения регистрации». Настоящая регистрация
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
