FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# Build-time frontend environment overrides
ARG VITE_API_BASE_URL=/api
ARG VITE_BACKEND_ORIGIN=
ARG VITE_ENABLE_PAYMENTS=0
ARG VITE_RAZORPAY_KEY_ID=
ARG VITE_GOOGLE_CLIENT_ID=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_BACKEND_ORIGIN=${VITE_BACKEND_ORIGIN}
ENV VITE_ENABLE_PAYMENTS=${VITE_ENABLE_PAYMENTS}
ENV VITE_RAZORPAY_KEY_ID=${VITE_RAZORPAY_KEY_ID}
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}

RUN npm run build
RUN find dist -type f \( -name "*.js" -o -name "*.css" -o -name "*.html" -o -name "*.svg" -o -name "*.json" \) -exec gzip -kf9 {} \;

FROM nginx:1.27-alpine AS runtime

RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
