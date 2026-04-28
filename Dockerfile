# ============================================================
# LeadBridge — Multi-stage Dockerfile
# ============================================================
# Stage 1: Build backend (NestJS + Prisma) and frontend (React/Vite)
# Stage 2: Production image with compiled output
# ============================================================

# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma
RUN apk add --no-cache openssl

# Install backend dependencies
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# Copy Prisma schema and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy backend source and build
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Install frontend dependencies and build
COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm ci --include=dev

COPY frontend ./frontend
RUN cd frontend && npm run build

# Stage 2: Production
FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache openssl curl

# Install production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy Prisma schema and generate client for production
COPY prisma ./prisma
RUN npx prisma generate

# Copy compiled backend
COPY --from=builder /app/dist ./dist

# Copy compiled frontend
COPY --from=builder /app/frontend/dist ./frontend/dist

# Copy boot scripts. railway.json's startCommand is
# `sh scripts/start-with-migrations.sh`; the script must exist in the
# production image for that startCommand to resolve it.
COPY scripts ./scripts

EXPOSE 3000

# Run Prisma migrations then start the server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
