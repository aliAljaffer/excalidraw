package main

import (
	"testing"
	"time"
)

func TestLimiterWindow(t *testing.T) {
	l := newLimiter(2)
	now := time.Unix(0, 0)

	if !l.allow("1.2.3.4", now) || !l.allow("1.2.3.4", now) {
		t.Fatal("first two uploads must pass")
	}
	if l.allow("1.2.3.4", now) {
		t.Fatal("third upload in the same window must be rejected")
	}
	if !l.allow("5.6.7.8", now) {
		t.Fatal("a different client gets its own budget")
	}
	if !l.allow("1.2.3.4", now.Add(time.Hour+time.Second)) {
		t.Fatal("budget must reset after an hour")
	}
}

func TestLimiterSweep(t *testing.T) {
	l := newLimiter(5)
	now := time.Unix(0, 0)
	l.allow("1.2.3.4", now)
	l.sweep(now.Add(2 * time.Hour))
	if len(l.hits) != 0 {
		t.Fatalf("expired clients should be dropped, got %d", len(l.hits))
	}
}

func TestNewID(t *testing.T) {
	id, err := newID()
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 32 {
		t.Fatalf("id must be 32 hex characters, got %q", id)
	}
	other, _ := newID()
	if id == other {
		t.Fatal("ids must be unique")
	}
}
