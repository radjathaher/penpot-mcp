FROM oven/bun:1.2.0 AS build
WORKDIR /app
COPY . .
RUN rm -f package-lock.json common/package-lock.json mcp-server/package-lock.json penpot-plugin/package-lock.json

RUN cd common && bun install && bun run build
RUN cd mcp-server && bun install && bun run build

ARG PENPOT_MCP_WEBSOCKET_URL
ENV PENPOT_MCP_WEBSOCKET_URL=${PENPOT_MCP_WEBSOCKET_URL}
RUN cd penpot-plugin && bun install && bun run build

FROM node:22-slim
WORKDIR /app

COPY --from=build /app/common /app/common
COPY --from=build /app/mcp-server /app/mcp-server
COPY --from=build /app/penpot-plugin/dist /app/penpot-plugin/dist

ENV NODE_ENV=production
ENV PENPOT_MCP_PLUGIN_DIR=/app/penpot-plugin/dist

EXPOSE 4400 4401 4402 4403

WORKDIR /app/mcp-server
CMD ["node", "dist/index.js"]
