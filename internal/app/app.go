// Package app wires the Fathom process: it holds validated configuration and a
// logger, manages a set of components, and runs a context-driven lifecycle with
// graceful shutdown.
//
// This phase ships only the lifecycle skeleton. No subsystem (engine, store,
// relay, API) is registered yet, so a bare run observes configuration/logging
// startup and then waits for cancellation — no fabricated workflow behaviour is
// introduced. Later phases add components without changing the shutdown rules
// established here.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/Lakhyajit-96/fathom/internal/config"
)

// Component is a subsystem with a bounded, context-aware shutdown. Each
// component is identified by Name for logging. Shutdown must respect ctx and
// return promptly; it must not panic.
type Component interface {
	Name() string
	Shutdown(ctx context.Context) error
}

// App is the process runtime.
type App struct {
	cfg        config.Config
	logger     *slog.Logger
	components []Component
}

// New constructs an App. cfg and logger must be non-nil (the zero Logger would
// silently use the global default; requiring one keeps output predictable).
func New(cfg config.Config, logger *slog.Logger) (*App, error) {
	if logger == nil {
		return nil, errors.New("app: nil logger")
	}
	return &App{cfg: cfg, logger: logger}, nil
}

// Register adds a component to be shut down on exit. Registration order does
// not imply shutdown order guarantee beyond reverse registration (LIFO), which
// is applied on shutdown.
func (a *App) Register(c Component) {
	a.components = append(a.components, c)
}

// Run logs startup and blocks until ctx is cancelled, then shuts down all
// components in reverse registration order within cfg.ShutdownTimeout. It
// returns the joined shutdown errors (context.Canceled is treated as a clean
// stop and not reported as an error).
func (a *App) Run(ctx context.Context) error {
	a.logger.Info("fathom starting",
		"env", string(a.cfg.Environment),
		"listen", a.cfg.HTTPListenAddr,
		"components", len(a.components),
	)

	<-ctx.Done()
	a.logger.Info("shutdown signal received", "reason", ctx.Err())
	return a.shutdown()
}

func (a *App) shutdown() error {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), a.cfg.ShutdownTimeout)
	defer cancel()

	var errs []error
	// Reverse order: the most recently started component stops first.
	for i := len(a.components) - 1; i >= 0; i-- {
		c := a.components[i]
		a.logger.Info("shutting down component", "component", c.Name())
		if err := c.Shutdown(shutdownCtx); err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				errs = append(errs, fmt.Errorf("component %q: shutdown timed out", c.Name()))
			} else {
				errs = append(errs, fmt.Errorf("component %q: %w", c.Name(), err))
			}
		}
	}
	a.logger.Info("fathom stopped")
	return errors.Join(errs...)
}

// ShutdownTimeout exposes the configured budget, mainly for callers/tests.
func (a *App) ShutdownTimeout() time.Duration { return a.cfg.ShutdownTimeout }
