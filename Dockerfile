FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma.config.ts tsconfig.json eslint.config.js .prettierrc.json ./
COPY prisma ./prisma
COPY src ./src

RUN pnpm install --frozen-lockfile
RUN pnpm build

CMD ["sh", "-c", "pnpm prisma:deploy && node dist/index.js"]
