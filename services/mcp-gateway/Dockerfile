FROM golang:1.26-alpine AS build

WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /mcp-gateway .

# Alpine provides a process environment for stdio MCP programs. The image carries one MCP
# server: duckduckgo-mcp-server (web search without an account), registered as a service on
# the MCP Gateway page with the command "duckduckgo-mcp-server".
FROM alpine:3.22
RUN apk add --no-cache python3 py3-pip \
    && pip install --no-cache-dir --break-system-packages duckduckgo-mcp-server
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /mcp-gateway /mcp-gateway
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/mcp-gateway"]
