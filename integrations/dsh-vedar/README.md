# dsh-vedar — Vedar (Kamchatka travel) MCP server for DeepSeek Harness

[中文](README.zh.md)

**Vedar** (vedarai.ru, Russian name Ведар) is the travel platform of the Kamchatka peninsula, Russia. Its public MCP server gives AI agents live tours and availability from local operators, the safety status of places and routes (volcanoes, earthquakes, weather warnings), weather, stays, gear rental, transfers and trip plans. No auth, rate-limited by IP.

This plugin does one thing: it registers one instance of the official bridge `@deepseek-ai/dsh-mcp-client` in your DeepSeek Harness profile, pointed at `https://vedarai.ru/api/mcp`. After install the model calls the tools as `mcp__vedar__<tool>`.

## Install

```bash
dsh plugin --profile web add github:tourhabk-ui/dsh-vedar
```

`dsh plugin` forwards to pnpm, so pnpm must be on PATH (`npm i -g pnpm`); without it the command stops with "pnpm was not found".

Restart `dsh web`. The tools appear before the first turn.

No plugin? Put the same row into `~/.dsh/profiles/web/cordis.patch.yml` (identical to `cordis.patch.yml` in this repository):

```yaml
- insert:
    - id: mcp-vedar
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: vedar
        transport: streamable-http
        url: https://vedarai.ru/api/mcp
```

Or add it by URL in a settings panel (`dsh-mcp-center`, `dsh-mcp-panel`, `dsh-mcp-connector`): type Streamable HTTP, URL `https://vedarai.ru/api/mcp`, auth none.

## Tools (20)

Read: `get_tours`, `get_tour_details`, `get_tour_availability`, `get_place_info`, `get_volcano_status`, `safety_status`, `get_guardian_context`, `get_weather`, `search_accommodations`, `search_gear`, `search_transfers`, `make_trip_plan`, `edit_trip_plan`, `get_request_status`, `search`, `fetch`.

Write, four requests confirmed by a human, no online payment: `create_lead`, `create_booking_request`, `create_stay_request`, `request_charter`.

Platform data is in Russian; tool arguments work best in Russian or English. Emergency number in Kamchatka: 112.

## Status

DeepSeek Harness is in developer preview and config fields may change. The row in this plugin follows the README of `@deepseek-ai/dsh-mcp-client` 0.2.0-rc.2 (checked 2026-10-13). Verified end to end on 2026-10-14 with dsh 0.2.0-rc.2 and pnpm 10.28.0 (headless profile, GitHub Actions runner): the plugin installed with the command above, and DeepSeek answered a Chinese question about brown bears in August by calling 17 Vedar tools, all completed. Please report problems at [tourhabk-ui/pos](https://github.com/tourhabk-ui/pos/issues).

Русский: плагин DeepSeek Harness, который одной командой подключает MCP-сервер Ведара. Исходник живёт в `integrations/dsh-vedar/` репозитория платформы.

More: [vedarai.ru/mcp](https://vedarai.ru/mcp) · [vedarai.ru/zh](https://vedarai.ru/zh) · [llms.txt](https://vedarai.ru/llms.txt) · manifest [/.well-known/mcp.json](https://vedarai.ru/.well-known/mcp.json)

MIT
