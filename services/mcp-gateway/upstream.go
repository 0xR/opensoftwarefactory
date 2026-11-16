package main

import (
	"context"
	"net/http"
)

// upstream owns transport resources, not tool policy. The gateway applies policy
// to both transports before dispatch and to discovery responses afterwards.
type upstream interface {
	RoundTrip(context.Context, []byte, http.Header) (*http.Response, error)
	Delete(context.Context, http.Header) (*http.Response, error)
	Close() error
}
