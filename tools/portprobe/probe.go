// Command portprobe is a toolchain/portability probe, not product code.
//
// It blank-imports every candidate backend dependency so `go build` proves the
// planned stack resolves, compiles, and vets WITHOUT CGO and without a native
// toolchain — the failure mode that made the audited repository unbuildable on
// Windows (Phase 1 baseline §2, finding DS-12; decided in ADR-005).
//
// Recorded gates (run from the tools/ module directory):
//
//	CGO_ENABLED=0 go build ./...
//	GOOS=linux   GOARCH=amd64 go build ./...
//	GOOS=linux   GOARCH=arm64 go build ./...
//	go vet ./...
//
// It has no runtime behaviour: main is empty on purpose.
package main

import (
	_ "log/slog"

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
)

func main() {}
