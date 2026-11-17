package main

import (
	"context"
	"reflect"
	"testing"
)

func TestDemoRepositoriesAreAddedOnceAndNeverOverwritten(t *testing.T) {
	w := newWorld(t)
	// A person changed one of them before the service started.
	w.repository("claims-review", map[string]any{"url": "http://elsewhere:9000/claims-review.git", "idle_minutes": 5, "approve_publish": true})
	if err := w.s.seedDemoRepositories(context.Background(), "http://git-host:8080/"); err != nil {
		t.Fatal(err)
	}
	repos := w.list("/api/git/repositories")
	if len(repos) != 3 {
		t.Fatalf("repositories = %v", repos)
	}
	want := map[string]any{"name": "claims-build", "kind": "plain", "url": "http://git-host:8080/claims-build.git", "default_branch": "main",
		"setup_command": "", "idle_minutes": 30.0, "approve_publish": false, "credential": "none"}
	if !reflect.DeepEqual(repos[0], want) {
		t.Fatalf("claims-build = %v", repos[0])
	}
	if repos[1]["name"] != "claims-portal" || repos[1]["url"] != "http://git-host:8080/claims-portal.git" {
		t.Fatalf("claims-portal = %v", repos[1])
	}
	if repos[2]["url"] != "http://elsewhere:9000/claims-review.git" || repos[2]["idle_minutes"] != 5.0 || repos[2]["approve_publish"] != true {
		t.Fatalf("the existing entry was overwritten: %v", repos[2])
	}
	// A second start changes nothing, even with another host.
	before := w.blobs.all()
	if err := w.s.seedDemoRepositories(context.Background(), "http://other-host"); err != nil {
		t.Fatal(err)
	}
	if w.blobs.all() != before {
		t.Fatal("a second seeding changed the stored repositories")
	}
	// The blob store being down is an error, so the caller tries again.
	w.blobs.srv.Close()
	if err := w.s.seedDemoRepositories(context.Background(), "http://git-host:8080"); err == nil {
		t.Fatal("seeding without a blob store reported success")
	}
}
