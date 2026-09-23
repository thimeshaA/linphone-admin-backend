FROM node:20-alpine

WORKDIR /usr/src/app

# Install dependencies first so this layer is cached unless the manifests change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Now bring in the rest of the source.
COPY . .

# Must match PORT in the .env supplied at runtime via docker-compose env_file.
EXPOSE 4000

CMD ["node", "index.js"]
