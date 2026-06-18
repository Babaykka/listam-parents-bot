FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/var/data
ENV PORT=10000

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 10000
CMD ["npm", "start"]
