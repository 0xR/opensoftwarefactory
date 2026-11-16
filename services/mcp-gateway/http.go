package main

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// newUpstream creates the transport selected by a validated Connection.
func newUpstream(c Connection) (upstream, error) {
	switch c.Transport {
	case "streamable-http":
		u, err := url.Parse(c.URL)
		if err != nil {
			return nil, err
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		return &httpUpstream{
			url:       u.String(),
			client:    &http.Client{Transport: otelhttp.NewTransport(transport), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
			transport: transport,
		}, nil
	case "stdio":
		return &stdioUpstream{connection: c}, nil
	default:
		return nil, fmt.Errorf("unknown MCP transport %q", c.Transport)
	}
}

// httpUpstream intentionally leaves the response body untouched. Callers that
// filter a JSON-RPC result can consume and replace it; normal JSON and SSE
// responses retain the upstream body's incremental behavior.
type httpUpstream struct {
	url       string
	client    *http.Client
	transport *http.Transport
}

func (u *httpUpstream) RoundTrip(ctx context.Context, body []byte, headers http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header = headers.Clone()
	return u.client.Do(req)
}

func (u *httpUpstream) Delete(ctx context.Context, headers http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, u.url, nil)
	if err != nil {
		return nil, err
	}
	req.Header = headers.Clone()
	return u.client.Do(req)
}

func (u *httpUpstream) Close() error {
	u.transport.CloseIdleConnections()
	return nil
}
