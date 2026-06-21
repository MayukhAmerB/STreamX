FROM node:20-alpine

WORKDIR /app

COPY server.js ./
COPY index.html app.js styles.css ./public/
COPY *.png ./public/
COPY materials ./public/materials

ENV NODE_ENV=production
ENV PORT=8080
ENV LABS_PUBLIC_DIR=/app/public

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
