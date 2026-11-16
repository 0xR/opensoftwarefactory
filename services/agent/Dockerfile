FROM golang:1.26-alpine AS build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /agent .

FROM scratch
COPY --from=build /agent /agent
USER 1000:1000
ENTRYPOINT ["/agent"]
