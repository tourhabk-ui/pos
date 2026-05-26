import { pool } from '@/lib/db-pool';

export interface SlashCommandResult {
  handled: boolean;
  response: string;
}

const NOT_HANDLED: SlashCommandResult = { handled: false, response: '' };

const HELP_TEXT = `**Команды Кузьмича** — быстрые ответы без ИИ:

/маршруты [запрос] — найти маршруты по ключевому слову
/места [запрос] — найти места и локации на карте
/туры [запрос] — найти туры у операторов с ценами
/операторы — список проверенных операторов Камчатки
/sos — экстренные контакты и телефоны помощи
/помощь — эта подсказка

Или просто спроси меня о Камчатке — я отвечу!`;

const SOS_TEXT = `**Экстренные контакты Камчатки:**

**112** — единая служба спасения (работает без сети)
**8 (4152) 41-03-03** — МЧС Камчатского края
**8 (4152) 23-26-09** — поисково-спасательный отряд

Перед выходом в маршрут:
— Зарегистрируйся в МЧС: forms.mchs.gov.ru
— Сообщи кому-то свой план и дату возвращения
— Возьми спутниковый коммуникатор или заряженный телефон`;

export async function handleSlashCommand(message: string): Promise<SlashCommandResult> {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return NOT_HANDLED;

  const spaceIdx = trimmed.indexOf(' ');
  const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const query = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  switch (cmd) {
    case '/помощь':
    case '/help':
      return { handled: true, response: HELP_TEXT };
    case '/sos':
      return { handled: true, response: SOS_TEXT };
    case '/маршруты':
      return routesCommand(query);
    case '/места':
      return placesCommand(query);
    case '/туры':
      return toursCommand(query);
    case '/операторы':
      return operatorsCommand();
    default:
      return NOT_HANDLED;
  }
}

async function routesCommand(query: string): Promise<SlashCommandResult> {
  try {
    const like = `%${query || ''}%`;
    const { rows } = await pool.query<{
      title: string;
      category: string | null;
      description: string | null;
    }>(
      `SELECT title, category, LEFT(description, 100) AS description
       FROM v_kamchatka_routes_api
       WHERE title ILIKE $1 OR description ILIKE $1
       ORDER BY title ASC
       LIMIT 8`,
      [like],
    );

    if (rows.length === 0) {
      return {
        handled: true,
        response: query
          ? `По запросу «${query}» маршруты не найдены. Попробуй другое слово или спроси меня.`
          : 'Маршруты пока не загружены.',
      };
    }

    const header = query ? `**Маршруты: «${query}»**\n\n` : `**Маршруты Камчатки:**\n\n`;
    const list = rows
      .map((r, i) => {
        const cat = r.category ? ` _(${r.category})_` : '';
        const desc = r.description ? `\n   ${r.description}...` : '';
        return `${i + 1}. **${r.title}**${cat}${desc}`;
      })
      .join('\n\n');
    const footer =
      rows.length === 8 ? '\n\n_Показаны первые 8. Уточни запрос для точного поиска._' : '';

    return { handled: true, response: header + list + footer };
  } catch {
    return { handled: true, response: 'Не удалось получить маршруты. Попробуй позже.' };
  }
}

async function placesCommand(query: string): Promise<SlashCommandResult> {
  try {
    const like = `%${query || ''}%`;
    const { rows } = await pool.query<{
      id: string;
      name: string;
      location_type: string | null;
      description: string | null;
    }>(
      `SELECT id, name, location_type, LEFT(description, 110) AS description
       FROM places
       WHERE name ILIKE $1
       ORDER BY name ASC
       LIMIT 8`,
      [like],
    );

    if (rows.length === 0) {
      return {
        handled: true,
        response: query
          ? `По запросу «${query}» места не найдены.`
          : 'Места не найдены.',
      };
    }

    const header = query ? `**Места: «${query}»**\n\n` : `**Места Камчатки:**\n\n`;
    const list = rows
      .map((r, i) => {
        const type = r.location_type ? ` _(${r.location_type})_` : '';
        const desc = r.description ? `\n   ${r.description}...` : '';
        const link = ` [→ карточка](/places/${r.id})`;
        return `${i + 1}. **${r.name}**${type}${link}${desc}`;
      })
      .join('\n\n');

    return { handled: true, response: header + list };
  } catch {
    return { handled: true, response: 'Не удалось получить места. Попробуй позже.' };
  }
}

async function toursCommand(query: string): Promise<SlashCommandResult> {
  try {
    const like = `%${query || ''}%`;
    const { rows } = await pool.query<{
      id: string;
      name: string;
      price: string | null;
      duration: string | null;
      difficulty: string | null;
      op_name: string;
    }>(
      `SELECT t.id, t.name, t.price::text, t.duration, t.difficulty, p.name AS op_name
       FROM operator_tours t
       JOIN partners p ON t.operator_id = p.id
       WHERE (t.name ILIKE $1 OR t.description ILIKE $1)
         AND t.is_active = true
         AND p.is_public = true
       ORDER BY t.name ASC
       LIMIT 8`,
      [like],
    );

    if (rows.length === 0) {
      return {
        handled: true,
        response: query
          ? `По запросу «${query}» туры не найдены. Попробуй другое слово.`
          : 'Активные туры не найдены.',
      };
    }

    const header = query ? `**Туры: «${query}»**\n\n` : `**Туры операторов:**\n\n`;
    const list = rows
      .map((r, i) => {
        const parts: string[] = [];
        if (r.price) parts.push(`от ${Number(r.price).toLocaleString('ru-RU')} ₽`);
        if (r.duration) parts.push(r.duration);
        if (r.difficulty) parts.push(r.difficulty);
        const meta = parts.length ? ` — ${parts.join(', ')}` : '';
        const link = ` [→ тур](/marketplace/tours/${r.id})`;
        return `${i + 1}. **${r.name}**${meta}\n   _${r.op_name}_${link}`;
      })
      .join('\n\n');

    return { handled: true, response: header + list };
  } catch {
    return { handled: true, response: 'Не удалось получить туры. Попробуй позже.' };
  }
}

async function operatorsCommand(): Promise<SlashCommandResult> {
  try {
    const { rows } = await pool.query<{
      name: string;
      slug: string | null;
      tours_count: number;
      specialization: string | null;
    }>(
      `SELECT p.name, p.slug, p.specialization, COUNT(t.id)::int AS tours_count
       FROM partners p
       LEFT JOIN operator_tours t ON t.operator_id = p.id AND t.is_active = true
       WHERE p.is_public = true
       GROUP BY p.name, p.slug, p.specialization
       ORDER BY tours_count DESC, p.name ASC
       LIMIT 15`,
    );

    if (rows.length === 0) {
      return { handled: true, response: 'Операторы не найдены.' };
    }

    const header = `**Проверенные операторы Камчатки:**\n\n`;
    const list = rows
      .map((r, i) => {
        const tours =
          r.tours_count > 0
            ? ` — ${r.tours_count} тур${r.tours_count === 1 ? '' : r.tours_count < 5 ? 'а' : 'ов'}`
            : '';
        const spec = r.specialization ? ` _(${r.specialization})_` : '';
        const link = r.slug ? ` [→](/operators/${r.slug})` : '';
        return `${i + 1}. **${r.name}**${spec}${tours}${link}`;
      })
      .join('\n');

    return { handled: true, response: header + list };
  } catch {
    return { handled: true, response: 'Не удалось получить список операторов.' };
  }
}
