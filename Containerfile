# Fully-qualified image name: Podman rejects or prompts on short names.
# Node 22 rather than 20 - Node 20 is EOL.
FROM docker.io/library/node:22-alpine

WORKDIR /usr/src/app

# Install dependencies first so this layer is cached unless the manifests change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Now bring in the rest of the source.
COPY . .

# Must match PORT in the env file supplied at runtime (compose env_file /
# Quadlet EnvironmentFile=). No HEALTHCHECK here - Podman ignores it in OCI
# builds; healthchecks are defined in deploy/compose.yaml and deploy/quadlet/.
EXPOSE 4000

CMD ["node", "index.js"]
