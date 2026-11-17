# Demo Git host: bare repositories over HTTP (git http-backend), seeded at start.
FROM alpine:3.22

# git-daemon holds git-http-backend; bash runs the worksheets' setup scripts.
RUN apk add --no-cache bash git git-daemon python3 \
    && install -d -o 1000 -g 1000 /data

COPY server.py seed.sh /opt/git-host/
COPY seed /opt/git-host/seed

ENV HOME=/tmp PYTHONUNBUFFERED=1 PORT=8080 GIT_HOST_DATA=/data
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["python3", "/opt/git-host/server.py"]
