// Package db carries the versioned PostgreSQL migrations for the Fathom
// control plane. The SQL files are embedded so the compiled binary (and the
// integration tests) never depend on the checkout layout at runtime.
package db

import "embed"

// Migrations holds db/migrations/*.sql (golang-migrate naming:
// <version>_<title>.up.sql / .down.sql).
//
//go:embed migrations/*.sql
var Migrations embed.FS
