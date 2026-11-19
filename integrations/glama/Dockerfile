# Повтор образа, который Glama собирает по форме сервера tourhabk-ui/pos.
# Значения формы — glama-build.json, пояснение — README.md рядом.
#
# Сервер Ведара удалённый (https://vedarai.ru/api/mcp), кода для сборки нет.
# Образ — мост: mcp-remote превращает удалённый сервер в stdio, mcp-proxy
# Glama отдаёт его по HTTP для проверки инструментов. Данных в образе нет,
# ключей нет, каждый вызов идёт на прод Ведара.
#
# Glama сама ставит основу (debian:trixie-slim, Node 24) и mcp-proxy, затем
# исполняет шаги сборки и CMD формы. Этот файл повторяет это, чтобы проверить
# мост локально:
#   docker build -t vedar-glama-bridge integrations/glama
#   docker run --rm -p 8080:8080 vedar-glama-bridge
FROM debian:trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g mcp-proxy@6.9.0

# Шаг сборки формы Glama.
RUN npm install -g mcp-remote@0.15.2

# mcp-proxy слушает 8080; Glama префиксует CMD формы словами «mcp-proxy --».
CMD ["mcp-proxy", "--", "mcp-remote", "https://vedarai.ru/api/mcp", "--transport", "http-only"]
