FROM node:20-alpine
WORKDIR /srv
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js cf-ips.snapshot.json ./
COPY jobs/ ./jobs/
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
