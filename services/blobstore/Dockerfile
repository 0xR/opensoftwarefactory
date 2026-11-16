FROM golang:1.26-alpine AS build

WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /blobstore .

FROM scratch
COPY --from=build /blobstore /blobstore
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/blobstore"]
CMD ["-data", "/data"]
