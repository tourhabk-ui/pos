# dsh-vedar — 在 DeepSeek Harness 中接入 Vedar（堪察加旅游）MCP 服务器

[English](README.md)

**Vedar（维达尔，vedarai.ru，俄文名 Ведар）** 是俄罗斯堪察加半岛的旅游平台，向 AI 代理开放公共 MCP 服务器：本地旅行社的团队游及其真实余位、地点与路线的安全状况（火山、地震、天气预警）、天气、住宿、装备租赁、接送、行程规划。无需认证，按 IP 限流。

本插件只做一件事：在你的 DeepSeek Harness 配置中注册一个官方 MCP 桥接实例（`@deepseek-ai/dsh-mcp-client`），指向 `https://vedarai.ru/api/mcp`。安装后模型可直接调用 `mcp__vedar__<tool>` 工具。

## 安装

```bash
dsh plugin --profile web add github:tourhabk-ui/dsh-vedar
```

重启 `dsh web`。工具会在第一轮对话前出现。

不想装插件？在 `~/.dsh/profiles/web/cordis.patch.yml` 中手写同一行即可（与本仓库的 `cordis.patch.yml` 相同）：

```yaml
- insert:
    - id: mcp-vedar
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: vedar
        transport: streamable-http
        url: https://vedarai.ru/api/mcp
```

也可以用图形面板（`dsh-mcp-center`、`dsh-mcp-panel`、`dsh-mcp-connector`）按 URL 添加：类型 Streamable HTTP，地址 `https://vedarai.ru/api/mcp`，认证 none。

## 工具（20 个）

读取：`get_tours`、`get_tour_details`、`get_tour_availability`、`get_place_info`、`get_volcano_status`、`safety_status`、`get_guardian_context`、`get_weather`、`search_accommodations`、`search_gear`、`search_transfers`、`make_trip_plan`、`edit_trip_plan`、`get_request_status`、`search`、`fetch`。

写入（四种申请，均由人工确认，无在线支付）：`create_lead`（选团）、`create_booking_request`（指定团和日期的预订申请）、`create_stay_request`（住宿申请）、`request_charter`（包车申请）。

平台数据为俄文，工具参数以俄文或英文为佳。堪察加紧急电话：112。

## 试一试

- 八月去堪察加，哪里能看到棕熊？现在那里安全吗？
- 用 Vedar 查一下堪察加各火山的当前状况和安全提示。
- 列出有余位的堪察加团队游，并说明价格和时长；不要提交任何申请。

## 状态

DeepSeek Harness 处于 developer preview，配置字段可能变化。本插件的配置行按 `@deepseek-ai/dsh-mcp-client` 0.2.0-rc.2 的 README 编写（2026-10-13 核对）；尚未在实时 dsh 中端到端验证——如遇问题请在 [tourhabk-ui/pos](https://github.com/tourhabk-ui/pos/issues) 提交 issue。

更多：[vedarai.ru/mcp](https://vedarai.ru/mcp) · 中文页面 [vedarai.ru/zh](https://vedarai.ru/zh) · [llms.txt](https://vedarai.ru/llms.txt) · 清单 [/.well-known/mcp.json](https://vedarai.ru/.well-known/mcp.json)

MIT
