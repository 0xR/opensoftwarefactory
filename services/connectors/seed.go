package main

import (
	"context"
	"errors"
	"strings"
	"time"
)

// demoRepositories are the repositories of the demo Git host.
var demoRepositories = []string{"claims-build", "claims-review", "claims-portal"}

// seedUntilDone adds the demo repositories, and keeps trying until the blob store answers.
func (s *service) seedUntilDone(ctx context.Context, host string) {
	for {
		err := s.seedDemoRepositories(ctx, host)
		if err == nil {
			return
		}
		s.log.Warn("adding the demo repositories failed; trying again", "error", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

// seedDemoRepositories stores an entry for every repository of the demo Git host that has
// none yet. An entry that exists is never changed, so a person's edits stay.
func (s *service) seedDemoRepositories(ctx context.Context, host string) error {
	host = strings.TrimRight(host, "/")
	for _, name := range demoRepositories {
		_, err := s.loadRepository(ctx, name)
		if err == nil {
			continue
		}
		if !errors.Is(err, errNotFound) {
			return err
		}
		repo := repository{Name: name, Kind: "plain", URL: host + "/" + name + ".git", DefaultBranch: "main",
			IdleMinutes: 30, ApprovePublish: false, Credential: "none"}
		if err = s.blobs.putJSON(ctx, repositoryObject(name), repo, "connectors", ""); err != nil {
			return err
		}
		s.log.Info("added a demo repository", "repository", name, "url", repo.URL)
	}
	return nil
}
