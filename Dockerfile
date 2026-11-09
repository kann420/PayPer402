# The hosted demo: the facilitator, the demo seller and the web app in one container.
# The SQLite database and the web session secret live in /app/data (mount a volume there).
FROM node:24-bookworm

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY . .
RUN npm ci --no-audit --no-fund

# Inlined into the landing page at build time.
ARG NEXT_PUBLIC_REPO_URL
ENV NEXT_PUBLIC_REPO_URL=$NEXT_PUBLIC_REPO_URL
RUN npm run build -w apps/web

ENV NODE_ENV=production
EXPOSE 3000 4020 4021
CMD ["node_modules/.bin/tsx", "apps/web/scripts/dev-stack.ts", "--prod"]
