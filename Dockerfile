# syntax=docker/dockerfile:1
# Uma imagem só: o servidor Go serve a API, o WebSocket, o SFU e o frontend compilado.

FROM --platform=$BUILDPLATFORM node:26-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS server
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/discordia ./cmd/server \
 && mkdir -p /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/discordia /discordia
COPY --from=server --chown=nonroot:nonroot /out/data /data
COPY --from=web /web/dist /web
ENV ADDR=:8080 DB_PATH=/data/discordia.db RTC_UDP_PORT=7882 STATIC_DIR=/web
VOLUME /data
EXPOSE 8080/tcp 7882/udp
ENTRYPOINT ["/discordia"]
