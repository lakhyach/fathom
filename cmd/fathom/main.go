// Command fathom is the Fathom control-plane process entry point.
//
// This phase wires only configuration, logging, and the lifecycle shell: it
// loads environment configuration, builds a redacting JSON logger, and runs the
// app until the process is interrupted (SIGINT/SIGTERM), then shuts down
// gracefully. It deliberately starts no engine/API/relay and emits no workflow
// activity — those arrive in later phases.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/Lakhyajit-96/fathom/internal/app"
	"github.com/Lakhyajit-96/fathom/internal/config"
	"github.com/Lakhyajit-96/fathom/internal/logging"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fathom:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(os.LookupEnv)
	if err != nil {
		// config errors never contain secret values (see internal/config).
		return fmt.Errorf("configuration: %w", err)
	}

	logger, err := logging.New(os.Stdout, cfg.LogLevel)
	if err != nil {
		return fmt.Errorf("logging: %w", err)
	}

	a, err := app.New(cfg, logger)
	if err != nil {
		return fmt.Errorf("app: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return a.Run(ctx)
}
