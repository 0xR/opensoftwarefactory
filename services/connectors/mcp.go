package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// registerUntilDone makes sure the MCP gateway knows the service devpod, and keeps trying
// until the gateway answers.
func (s *service) registerUntilDone(ctx context.Context) {
	for {
		created, err := s.register(ctx)
		if err == nil {
			if created {
				s.log.Info("registered the MCP service devpod", "url", s.cfg.mcpURL)
			}
			return
		}
		s.log.Warn("registering the MCP service devpod failed; trying again", "error", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(s.cfg.registerRetry):
		}
	}
}

// register creates the entry devpod in the MCP gateway when it is missing. An entry that
// exists is left alone, so a person's changes to it stay. The entry points at the tool
// gateway, which serves the dev pod tools and forwards them to this service.
func (s *service) register(ctx context.Context) (bool, error) {
	endpoint := s.mcpGateway + "/api/services/devpod"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false, err
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return false, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return false, nil
	}
	if resp.StatusCode != http.StatusNotFound {
		return false, fmt.Errorf("the MCP gateway answered %s", resp.Status)
	}
	body, err := json.Marshal(map[string]any{
		"mcpconfig": map[string]any{"transport": "streamable-http", "url": s.cfg.mcpURL},
		"allowlist": devpodTools,
		"denylist":  []string{},
	})
	if err != nil {
		return false, err
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodPut, endpoint, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err = s.http.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 2000))
		return false, fmt.Errorf("the MCP gateway refused the service devpod: %s %s", resp.Status, data)
	}
	return true, nil
}
