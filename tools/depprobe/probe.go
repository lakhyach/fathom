// Command depprobe is a Phase-2 toolchain/portability probe, not product code.
//
// It blank-imports every candidate backend dependency to prove the planned
// stack resolves, compiles, and vets on this host WITHOUT CGO and without a
// native toolchain (the failure mode that made the audited repository
// unbuildable on Windows: Phase 1 baseline results §2, finding DS-12).
//
// Build gates recorded in docs/ARCHITECTURE_DECISIONS.md (ADR-004):
//
//	CGO_ENABLED=0 go build ./...
//	GOOS=linux GOARCH=amd64 go build ./...
//	go vet ./...
package main

import (
	_ "github.com/go-chi/chi/v5"
	_ "github.com/google/uuid"
	_ "github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/prometheus/client_golang/prometheus"
	_ "github.com/prometheus/client_golang/prometheus/promhttp"
	_ "github.com/testcontainers/testcontainers-go/modules/postgres"
	_ "github.com/twmb/franz-go/pkg/kadm"
	_ "github.com/twmb/franz-go/pkg/kgo"
	_ "github.com/twmb/franz-go/pkg/sasl/scram"
	_ "go.opentelemetry.io/otel"
	_ "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	_ "go.opentelemetry.io/otel/trace"
	_ "log/slog"
)

func main() {}
