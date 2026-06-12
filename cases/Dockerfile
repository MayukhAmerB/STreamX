FROM node:20-alpine AS runtime
WORKDIR /app

COPY . .
RUN mkdir -p /app/content-seed/cases /app/uploads-seed \
    && cp -R /app/content/cases/. /app/content-seed/cases/ \
    && if [ -d /app/public/uploads ]; then cp -R /app/public/uploads/. /app/uploads-seed/; fi

ENV NODE_ENV=production
ENV CASES_CONTENT_DIR=/app/content/cases
ENV CASES_PUBLIC_DIR=/app/public

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
