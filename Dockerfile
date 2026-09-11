# Base fixada por digest (node:20-alpine, capturado em 2026-09-11) para build
# reproduzivel. Ao subir a versao do Node, buscar o novo digest e trocar aqui
# DE PROPOSITO (nao deixar a tag flutuar sozinha):
#   docker buildx imagetools inspect node:20-alpine
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

ENV NODE_ENV=production
WORKDIR /app

# tini como init (equivale ao `--init`): PID 1 correto, encaminha sinais e
# reaproveita zumbis. Vale em qualquer runtime, inclusive no EasyPanel.
RUN apk add --no-cache tini

# Camada de dependencias separada: o cache so invalida quando o manifesto/lock
# muda. `npm ci` instala EXATAMENTE o package-lock.json -> build deterministico
# (falha se o lock divergir do package.json).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Usuario nao-root. `--chown` na copia evita um `chown -R` numa camada extra.
RUN addgroup -S app && adduser -S app -G app
COPY --chown=app:app src ./src
COPY --chown=app:app public ./public
USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
