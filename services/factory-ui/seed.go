package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// defaultTemplate is the task template the factory always provides: it
// inserts each task unchanged.
const (
	defaultTemplateID   = "templates/tasks/default.md"
	defaultTemplateBody = "{{task}}\n"
)

// seedDefaults stores the objects the UI relies on when they do not exist,
// retrying while the blobstore starts. It runs in the background so the UI
// comes up even if the blobstore is late.
func seedDefaults(ctx context.Context, blobs string, logger *slog.Logger) {
	deadline := time.Now().Add(2 * time.Minute)
	for {
		err := ensureObject(ctx, blobs, defaultTemplateID, defaultTemplateBody)
		if err == nil {
			return
		}
		if time.Now().After(deadline) {
			logger.Error("seeding default template failed", "error", err)
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

// ensureObject PUTs an object unless it already exists.
func ensureObject(ctx context.Context, blobs, id, body string) error {
	base := strings.TrimRight(blobs, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/meta/"+id, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
		return nil
	case resp.StatusCode != http.StatusNotFound:
		return fmt.Errorf("GET meta %s: %s", id, resp.Status)
	}
	put, err := http.NewRequestWithContext(ctx, http.MethodPut, base+"/blobs/"+id, strings.NewReader(body))
	if err != nil {
		return err
	}
	put.Header.Set("X-Creator", "factory")
	resp, err = http.DefaultClient.Do(put)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("PUT %s: %s", id, resp.Status)
	}
	return nil
}
