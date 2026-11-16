package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestEnsureObjectStoresOnlyMissingObjects(t *testing.T) {
	var mu sync.Mutex
	stored := map[string]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/meta/"+defaultTemplateID:
			if _, ok := stored[defaultTemplateID]; ok {
				w.WriteHeader(http.StatusOK)
			} else {
				w.WriteHeader(http.StatusNotFound)
			}
		case r.Method == http.MethodPut && r.URL.Path == "/blobs/"+defaultTemplateID:
			if r.Header.Get("X-Creator") != "factory" {
				t.Errorf("creator %q", r.Header.Get("X-Creator"))
			}
			stored[defaultTemplateID] = "put"
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer srv.Close()
	for i := 0; i < 2; i++ {
		if err := ensureObject(context.Background(), srv.URL, defaultTemplateID, defaultTemplateBody); err != nil {
			t.Fatal(err)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if stored[defaultTemplateID] != "put" {
		t.Fatal("default template not stored")
	}
}
