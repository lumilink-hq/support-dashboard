# seo-render-service — module 6's headless-browser fallback. Deployed as its
# own Railway service, root directory = render-service/ (this file's folder),
# separate from the Next app and the Supabase edge functions.
#
# Base image pins Chromium + all its OS deps to the exact Playwright npm
# version in package.json — they MUST match, or `playwright` refuses to
# launch a browser it doesn't recognise. Bump both together.
FROM mcr.microsoft.com/playwright:v1.63.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm install --no-save typescript@5

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && rm -rf node_modules/typescript

ENV NODE_ENV=production
EXPOSE 8080

# The base image's default user (non-root, already set up for Chromium's
# sandbox) — runs as that user rather than root, same as the base image intends.
CMD ["node", "dist/src/server.js"]
