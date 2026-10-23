/**
 * English layer for agents — canonical identity in English.
 * Facts mirror llms.txt / server.json: no instant booking, no payment
 * through the platform, human-confirmed requests only.
 */
export const MCP_TITLE_EN_FILE = 'Vedar — Kamchatka travel platform';

export function llmsEnFile(base: string): string {
  return [
    `# ${MCP_TITLE_EN_FILE}`,
    '',
    `> Vedar (vedarai.ru, Russian name: Ведар, Chinese name: 维达尔) is a travel platform for the Kamchatka Peninsula, Russia: tours by local operators, accommodation, transfers and vehicle charters, self-drive car rental, gear rental, volcano and safety status, weather and trip planning. It is free for tourists. Booking requests are confirmed by a human partner; there is no instant booking and no payment through the platform.`,
    '',
    `MCP server for AI assistants: ${base}/api/mcp (Streamable HTTP, JSON-RPC 2.0, no auth required). Docs: ${base}/mcp. Manifest: ${base}/.well-known/mcp.json. A2A agent card: ${base}/.well-known/agent-card.json.`,
    '',
    'Keywords: Kamchatka tours, Kamchatka volcanoes, Kamchatka bear watching, Kamchatka hotels, Petropavlovsk-Kamchatsky, Valley of Geysers, Kuril Lake, Klyuchevskaya Sopka.',
    '',
    '## What Vedar is — and is not',
    '',
    '- Vedar is NOT Booking.com, Ostrovok, Viator or a tour operator: it does not sell or fulfil tours itself. Local operators fulfil services under their own names.',
    '- MCP here means Model Context Protocol (the AI-agent protocol), not a partner, channel or marketing programme.',
    '- The only write operations are four human-confirmed requests: create_lead (tour selection), create_booking_request (specific tour and date), create_stay_request (accommodation), request_charter (whole-vehicle charter). No online payment.',
    '- Platform content is primarily in Russian; tour names and data are in Russian. Tool arguments work best in Russian or English.',
    '',
    '## Key facts',
    '',
    '- Kamchatka: Russian Far East peninsula, UNESCO World Heritage "Volcanoes of Kamchatka", 300+ volcanoes (29 active), main tourist season June-September, timezone UTC+12, main city Petropavlovsk-Kamchatsky.',
    '- Emergency number in Kamchatka: 112.',
    '- Prices and availability are live data: use MCP tools get_tours / get_tour_availability, or the full Russian file ' + `${base}/llms.txt.`,
    '',
    '## Pages',
    '',
    `- English summary on the MCP page: ${base}/mcp`,
    `- Chinese version: ${base}/llms-zh.txt and ${base}/zh`,
    `- Full Russian version: ${base}/llms.txt`,
    `- About the platform (Russian): ${base}/about`,
    `- Tours catalogue: ${base}/catalog`,
    `- Accommodation: ${base}/accommodations`,
    `- Transfers: ${base}/transfers`,
    `- Car rental (self-drive): ${base}/car-rental`,
    '',
  ].join('\n');
}
