/**
 * lib/mcp/china-clients.ts — клиенты и продукты КНР по самоназванию.
 *
 * Повод (владелец 13.10): «в MCP и A2A ни одна китайская модель не зашла ни
 * разу — мы для них не существуем». Проверить это по журналу было нельзя:
 * модель нигде не пишется, а словарь родов клиента (`uaFamily`) не знал ни
 * одного китайского имени — Qwen Code, Cherry Studio, Dify, Trae, Kimi, Doubao
 * уходили в «неизвестен» (173 из 1085 внешних вызовов за 30 дней к 12.10).
 * «Ни разу» было отчасти «не видим» (§4.0: третий исход за первый).
 *
 * Здесь — один реестр на три читателя: род клиента MCP по заголовку
 * (`uaFamily`), метка «КНР» у имени клиента и агента в админ-срезах
 * (`/hub/admin/mcp`, `/hub/admin/a2a`) и отдельная группа в переписи
 * `mcp-census`. Подстроки — самоназвания продуктов, которыми они подписывают
 * clientInfo.name и User-Agent; совпадение только по границе слова, иначе
 * «dify» нашлось бы в «modify», а «trae» — в «traefik».
 *
 * Это имена ПРОГРАММ, не людей и не стран: метка говорит «клиент из
 * экосистемы КНР», а не «запрос из Китая» — страна по IP не хранится и не
 * читается (152-ФЗ, суточный hash). Агент на китайской модели за западным
 * клиентом (Cline на DeepSeek) здесь по-прежнему невидим, и это сказано вслух.
 *
 * Сторож: tests/unit/mcp-china-clients.test.ts.
 */

export interface ChinaClientFamily {
  /** Род для `ua_family` и для группировки. */
  family: string;
  /** Кому принадлежит, для человека. */
  vendor: string;
  /** Самоназвания (нижний регистр), по границе слова. */
  markers: readonly string[];
}

export const CHINA_CLIENT_FAMILIES: readonly ChinaClientFamily[] = [
  { family: 'qwen-code',     vendor: 'Alibaba (Qwen, Tongyi, Lingma), КНР',   markers: ['qwen', 'qwencode', 'qwen-code', 'tongyi', 'lingma'] },
  { family: 'modelscope',    vendor: 'ModelScope (魔搭), КНР',                 markers: ['modelscope'] },
  { family: 'deepseek',      vendor: 'DeepSeek, КНР',                         markers: ['deepseek', 'dsh-mcp-client'] },
  { family: 'kimi',          vendor: 'Moonshot (Kimi), КНР',                  markers: ['kimi', 'moonshot'] },
  { family: 'doubao',        vendor: 'ByteDance (Doubao, Coze, Volcengine), КНР', markers: ['doubao', 'coze', 'volcengine', 'bytedance'] },
  { family: 'trae',          vendor: 'ByteDance (Trae), КНР',                 markers: ['trae'] },
  { family: 'glm',           vendor: 'Zhipu (GLM), КНР',                      markers: ['zhipu', 'bigmodel', 'chatglm', 'glm-4', 'glm-5'] },
  { family: 'hunyuan',       vendor: 'Tencent (Hunyuan, Yuanbao), КНР',       markers: ['hunyuan', 'yuanbao'] },
  { family: 'ernie',         vendor: 'Baidu (ERNIE, Qianfan), КНР',           markers: ['ernie', 'wenxin', 'qianfan'] },
  { family: 'minimax',       vendor: 'MiniMax, КНР',                          markers: ['minimax'] },
  { family: 'cherry-studio', vendor: 'Cherry Studio, КНР',                    markers: ['cherry studio', 'cherry-studio', 'cherrystudio'] },
  { family: 'dify',          vendor: 'Dify, КНР',                             markers: ['dify'] },
];

/** Метка региона в срезах — одно слово, одинаковое везде. */
export const CHINA_REGION_LABEL = 'КНР';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Совпадение по границе слова: буквы и цифры по краям маркера — не совпадение. */
const MARKER_RES: ReadonlyArray<{ family: string; re: RegExp }> = CHINA_CLIENT_FAMILIES.flatMap((f) =>
  f.markers.map((m) => ({ family: f.family, re: new RegExp(`(^|[^a-z0-9])${escapeRe(m)}([^a-z0-9]|$)`) })),
);

const CHINA_FAMILY_SET = new Set(CHINA_CLIENT_FAMILIES.map((f) => f.family));

/** Род клиента КНР по самоназванию или заголовку; null — не из реестра. */
export function chinaClientFamily(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  for (const { family, re } of MARKER_RES) {
    if (re.test(s)) return family;
  }
  return null;
}

/**
 * «КНР», если хоть одна из строк — имя клиента, род заголовка, самоназвание
 * агента — указывает на продукт из реестра; иначе null, а не пустая строка:
 * «не из КНР» и «не знаем» здесь одно и то же, и это честно сказано в шапке.
 */
export function clientRegion(...parts: Array<string | null | undefined>): typeof CHINA_REGION_LABEL | null {
  for (const p of parts) {
    if (!p) continue;
    if (CHINA_FAMILY_SET.has(p.toLowerCase())) return CHINA_REGION_LABEL;
    if (chinaClientFamily(p)) return CHINA_REGION_LABEL;
  }
  return null;
}
