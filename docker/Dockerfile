# Multi-stage build for production optimization
FROM node:22-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --frozen-lockfile --production=false

# Copy configuration files needed for build
COPY tsconfig.json nest-cli.json ./

# Copy source code
COPY src ./src

# Build application
RUN npm run build

# Production stage
FROM node:22-alpine AS production

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install only production dependencies
RUN npm install --frozen-lockfile --production=true && \
  npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Expose application port
EXPOSE 3000

# Start application
CMD ["node", "dist/main"]
