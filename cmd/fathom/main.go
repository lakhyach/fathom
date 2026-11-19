// Command fathom runs the Fathom workflow engine.
//
// Phase 5 turns the Phase-4 lifecycle shell into the real wiring described in
// PHASE_5_SPEC_CHECKLIST gap 6: ONE binary, four modes selected by FATHOM_MODE
// (or the first CLI argument), each starting exactly the subsystems its
// configuration can honestly support:
//
//	control — REST API + recovery scheduler (the lite single-node deployment)
//	worker  — the durable participant execution loop only
//	relay   — the transactional-outbox → Kafka relay only
//	all     — everything the configuration allows (dev convenience)
//
// Honesty rules at startup, all documented rather than faked:
//   - worker mode refuses to start with an empty participant registry (a
//     worker that answers no tasks is a silo of dropped commands); "all"
//     warns and skips the loop instead;
//   - relay mode refuses to start without FATHOM_KAFKA_BROKERS — there is no
//     fake sink; "all" warns and skips the relay (Kafka stays optional at
//     runtime, checklist gap 7);
//   - the API refuses any non-loopback bind while bearer keys are the only
//     boundary (api.LoopbackOnly, checklist gap 9).
//
// Components register store → relay → worker → scheduler → API so graceful
// shutdown is the reverse (LIFO, app.Run): stop accepting requests, stop
// scheduling, finish in-flight work, stop publishing, close the pool.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/lakhyach/fathom/internal/api"
	"github.com/lakhyach/fathom/internal/app"
	"github.com/lakhyach/fathom/internal/config"
	"github.com/lakhyach/fathom/internal/logging"
	"github.com/lakhyach/fathom/internal/participant"
	"github.com/lakhyach/fathom/internal/relay"
	"github.com/lakhyach/fathom/internal/relay/kafka"
	"github.com/lakhyach/fathom/internal/scheduler"
	postgres "github.com/lakhyach/fathom/internal/store/postgres"
	"github.com/lakhyach/fathom/internal/worker"
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

	// The CLI argument overrides FATHOM_MODE when present.
	mode := cfg.Mode
	if len(os.Args) > 1 {
		mode, err = parseModeArg(os.Args[1])
		if err != nil {
			return fmt.Errorf("mode: %w", err)
		}
	}

	a, err := app.New(cfg, logger)
	if err != nil {
		return fmt.Errorf("app: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	if err := wire(a, cfg, mode, logger, ctx, cancel); err != nil {
		return err
	}
	return a.Run(ctx)
}

func parseModeArg(v string) (config.Mode, error) {
	switch m := config.Mode(strings.ToLower(strings.TrimSpace(v))); m {
	case config.ModeControl, config.ModeWorker, config.ModeRelay, config.ModeAll:
		return m, nil
	default:
		return "", fmt.Errorf("must be one of control, worker, relay, all (got %q)", v)
	}
}

// wire starts the subsystems the mode and configuration allow. Every started
// component is registered on the app before Run is entered; the store closes
// last on shutdown (registration order store → … → API).
func wire(a *app.App, cfg config.Config, mode config.Mode, logger *slog.Logger, ctx context.Context, cancel context.CancelFunc) error {
	// --- store (every mode): the one dependency all others are honest about.
	st, err := postgres.Open(ctx, cfg.DatabaseURL.Reveal())
	if err != nil {
		return fmt.Errorf("store: %w", err)
	}
	a.Register(&storeComponent{st: st})
	if err := st.Migrate(ctx); err != nil {
		return fmt.Errorf("store migrate: %w", err)
	}
	logger.Info("store connected and migrated", "mode", string(mode))

	// --- relay: only real Kafka, never a fake sink (checklist gap 7).
	if mode == config.ModeRelay || mode == config.ModeAll {
		if len(cfg.KafkaBrokers) == 0 {
			if mode == config.ModeRelay {
				return errors.New("relay mode requires FATHOM_KAFKA_BROKERS (the relay publishes to Kafka or does not run; no fake sink is started)")
			}
			logger.Warn("relay not started: no FATHOM_KAFKA_BROKERS (outbox rows will accumulate until a relay with brokers runs)")
		} else {
			pub, err := kafka.New(kafka.Config{Brokers: cfg.KafkaBrokers})
			if err != nil {
				return fmt.Errorf("kafka publisher: %w", err)
			}
			rl, err := relay.New(st, pub, relay.Config{ID: cfg.RelayID}, logger)
			if err != nil {
				return fmt.Errorf("relay: %w", err)
			}
			rl.Start(ctx)
			a.Register(rl)
			a.Register(&publisherComponent{pub: pub})
			logger.Info("relay started", "brokers", strings.Join(cfg.KafkaBrokers, ","), "relay_id", cfg.RelayID)
		}
	}

	// --- worker: requires a non-empty participant registry.
	if mode == config.ModeWorker || mode == config.ModeAll {
		registry := buildRegistry(cfg, logger)
		if len(registry.Tasks()) == 0 {
			if mode == config.ModeWorker {
				return errors.New("worker mode has no participants (register handlers or set FATHOM_DEV_ECHO=1 for the sample echo participant); a worker that answers no tasks is not started")
			}
			logger.Warn("worker loop not started: empty participant registry (set FATHOM_DEV_ECHO=1 for the echo sample)")
		} else {
			wk, err := worker.New(st, registry, worker.Config{ID: cfg.WorkerID}, logger)
			if err != nil {
				return fmt.Errorf("worker: %w", err)
			}
			wk.Start(ctx)
			a.Register(wk)
			logger.Info("worker started", "worker_id", cfg.WorkerID, "tasks", registry.Tasks())
		}
	}

	// --- scheduler: retry/timeout recovery scans run in the control plane.
	if mode == config.ModeControl || mode == config.ModeAll {
		sc, err := scheduler.New(st, scheduler.Config{}, logger)
		if err != nil {
			return fmt.Errorf("scheduler: %w", err)
		}
		sc.Start(ctx)
		a.Register(sc)
		logger.Info("scheduler started")
	}

	// --- API: the local-only control plane (checklist gap 9).
	if mode == config.ModeControl || mode == config.ModeAll {
		keys, err := api.ParseKeys(cfg.APIKeys.Reveal())
		if err != nil {
			return fmt.Errorf("api keys: %w", err)
		}
		srv, err := api.New(st, keys, logger, api.WithReadyMaxOutboxAge(cfg.ReadyMaxOutboxAge))
		if err != nil {
			return fmt.Errorf("api: %w", err)
		}
		if err := api.LoopbackOnly(cfg.HTTPListenAddr); err != nil {
			return err
		}
		httpSrv := &http.Server{
			Addr:              cfg.HTTPListenAddr,
			Handler:           srv.Handler(),
			ReadHeaderTimeout: 10 * time.Second,
		}
		hc := &httpComponent{srv: httpSrv, log: logger, cancel: cancel}
		hc.Start(ctx)
		a.Register(hc)
		logger.Info("api listening", "addr", cfg.HTTPListenAddr)
	}

	return nil
}

// buildRegistry assembles the participant set this binary knows. Phase 5 ships
// no domain participants inside the engine binary (they belong to services);
// the single registered task is the explicitly-labeled dev echo sample behind
// FATHOM_DEV_ECHO, which exists so the whole local stack can be exercised
// end-to-end without pretending to be business logic.
func buildRegistry(cfg config.Config, logger *slog.Logger) *participant.Registry {
	r := participant.NewRegistry()
	if cfg.DevEcho {
		r.Register("echo", participant.HandlerFunc(func(_ context.Context, t participant.Task) (json.RawMessage, error) {
			// Deterministic sample: succeeds with the task's input verbatim.
			// It is a wiring test fixture, NOT a domain participant.
			logger.Info("echo sample executed", "command_key", t.CommandKey())
			out := t.Input
			if len(out) == 0 {
				out = json.RawMessage("null")
			}
			return out, nil
		}))
		logger.Warn("FATHOM_DEV_ECHO=1: registered the deterministic echo SAMPLE (dev wiring only, never a real participant)")
	}
	return r
}

// --- component adapters giving the LIFO shutdown real bounded semantics.

type storeComponent struct{ st *postgres.Store }

func (c *storeComponent) Name() string { return "store" }

// Shutdown closes the pool after every consumer stopped (registered first ⇒
// shut down last).
func (c *storeComponent) Shutdown(context.Context) error {
	c.st.Close()
	return nil
}

type publisherComponent struct{ pub *kafka.Publisher }

func (c *publisherComponent) Name() string { return "kafka-publisher" }

func (c *publisherComponent) Shutdown(context.Context) error { return c.pub.Close() }

type httpComponent struct {
	srv    *http.Server
	log    *slog.Logger
	cancel context.CancelFunc // set by Start; a listener failure unwinds the lifecycle
}

func (c *httpComponent) Name() string { return "http" }

// Start serves in the background; a listener failure cancels the process
// context (via the cancel passed to wire) so app.Run unwinds through the
// normal LIFO shutdown instead of the process dying silently with dead ports.
func (c *httpComponent) Start(ctx context.Context) {
	go func() {
		c.log.Info("http listener bound", "addr", c.srv.Addr)
		if err := c.srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			c.log.Error("http listener failed, initiating shutdown", "error", err)
			if c.cancel != nil {
				c.cancel()
			}
		}
	}()
}

func (c *httpComponent) Shutdown(ctx context.Context) error { return c.srv.Shutdown(ctx) }
