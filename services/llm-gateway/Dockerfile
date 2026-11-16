FROM golang:1.26-alpine AS build

WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /llm-gateway .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /llm-gateway /llm-gateway
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/llm-gateway"]
CMD ["-config", "/config/config.yaml", "-logs", "/logs"]
