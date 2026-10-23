package app

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Lakhyajit-96/fathom/internal/config"
	"github.com/Lakhyajit-96/fathom/internal/logging"
)

func testApp(t *testing.T, timeout time.Duration, comps ...Component) *App {
	t.Helper()
	var buf bytes.Buffer
	logger, err := logging.New(&buf, "error") // quiet; assertions don't read logs
	if err != nil {
		t.Fatal(err)
	}
	a, err := New(config.Config{Environment: config.EnvDev, HTTPListenAddr: "127.0.0.1:0", ShutdownTimeout: timeout}, logger)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range comps {
		a.Register(c)
	}
	return a
}

// fakeComponent records whether Shutdown ran and can block or fail.
type fakeComponent struct {
	name     string
	block    time.Duration
	failWith error
	shared   *[]string
	mu       *sync.Mutex
}

func (f *fakeComponent) Name() string { return f.name }
func (f *fakeComponent) Shutdown(ctx context.Context) error {
	if f.block > 0 {
		select {
		case <-time.After(f.block):
		case <-ctx.Done():
		}
	}
	if f.shared != nil {
		f.mu.Lock()
		*f.shared = append(*f.shared, f.name)
		f.mu.Unlock()
	}
	return f.failWith
}

func TestRunReturnsOnContextCancel(t *testing.T) {
	a := testApp(t, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("clean cancel should return nil, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancellation")
	}
}

func TestShutdownRunsComponentsInReverseOrder(t *testing.T) {
	var mu sync.Mutex
	var order []string
	first := &fakeComponent{name: "first", shared: &order, mu: &mu}
	second := &fakeComponent{name: "second", shared: &order, mu: &mu}
	a := testApp(t, time.Second, first, second)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	cancel()
	<-done

	if len(order) != 2 || order[0] != "second" || order[1] != "first" {
		t.Fatalf("expected reverse shutdown [second first], got %v", order)
	}
}

func TestShutdownErrorPropagates(t *testing.T) {
	boom := errors.New("boom")
	a := testApp(t, time.Second, &fakeComponent{name: "bad", failWith: boom})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	cancel()
	err := <-done
	if err == nil || !strings.Contains(err.Error(), "bad") {
		t.Fatalf("expected shutdown error naming component, got %v", err)
	}
}

// A component that ignores its deadline must be abandoned when the overall
// shutdown budget elapses — Run must still return (bounded shutdown).
func TestShutdownIsBounded(t *testing.T) {
	slow := &fakeComponent{name: "slow", block: 5 * time.Second}
	a := testApp(t, 100*time.Millisecond, slow)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	cancel()

	select {
	case err := <-done:
		// The slow component's Shutdown sees ctx deadline and returns; app
		// records the attempt. Bounded return is the contract.
		_ = err
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown exceeded budget and did not return")
	}
}

func TestNewRejectsNilLogger(t *testing.T) {
	if _, err := New(config.Default(), nil); err == nil {
		t.Fatal("expected error for nil logger")
	}
}

func TestShutdownTimeoutAccessor(t *testing.T) {
	a := testApp(t, 3*time.Second)
	if a.ShutdownTimeout() != 3*time.Second {
		t.Fatal("accessor mismatch")
	}
}
