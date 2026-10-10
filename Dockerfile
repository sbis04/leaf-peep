FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY db/schema.sql db/tiger-ca.pem ./db/
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
