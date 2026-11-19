// Package postgres is the durable side of the engine: it realises the
// transition contract from internal/engine as PostgreSQL transactions.
//
// The invariants this layer adds (docs/DATA_AND_API_CONTRACTS.md §A):
//   - one transaction = one state change + its audit rows + its outbox rows,
//     with no network I/O inside (transactional outbox);
//   - every engine write carries the optimistic predicate
//     WHERE id = $id AND version = $expected AND NOT (state IN terminal),
//     and RowsAffected != 1 is surfaced as a typed conflict — never a silent
//     overwrite (closes the DS-4 class);
//   - storage faults are returned as errors, never disguised as not-found
//     (DS-13 discipline).
package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"time"

	"github.com/golang-migrate/migrate/v4"
	migratepgx "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/lakhyach/fathom/db"
)

// Store owns the connection pool. It has no global state; construct one per
// process with Open.
type Store struct {
	pool *pgxpool.Pool
	dsn  string
}

// Open parses the DSN, validates connectivity and returns a ready Store. The
// pool defaults are deliberate: a UTC session timezone (every timestamp in the
// contract is timestamptz and the engine reasons in UTC) and an application_name
// for observability.
func Open(ctx context.Context, dsn string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("store: parse dsn: %w", err)
	}
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	cfg.ConnConfig.RuntimeParams["application_name"] = "fathom-engine"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("store: pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("store: ping: %w", err)
	}
	return &Store{pool: pool, dsn: dsn}, nil
}

// Close releases the pool.
func (s *Store) Close() { s.pool.Close() }

// Pool exposes the underlying pool for test setup only (integration tests
// need raw access to assert constraints); production code should not reach
// through the store.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// Migrate applies all available up-migrations from the embedded SQL in the db
// package.
func (s *Store) Migrate(ctx context.Context) error {
	m, err := s.newMigrator()
	if err != nil {
		return err
	}
	defer closeMigrator(m)
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("store: migrate up: %w", err)
	}
	return nil
}

// MigrateDown reverses the given number of migrations (rollback proofing in the
// integration suite). It is destructive in production and is only ever exercised
// against a throwaway database.
func (s *Store) MigrateDown(ctx context.Context, steps int) error {
	m, err := s.newMigrator()
	if err != nil {
		return err
	}
	defer closeMigrator(m)
	if err := m.Steps(-steps); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("store: migrate down: %w", err)
	}
	return nil
}

// SchemaVersion reports the current migration version and whether it is dirty.
// A zero version with no error means the schema has never been migrated.
func (s *Store) SchemaVersion(ctx context.Context) (uint, bool, error) {
	m, err := s.newMigrator()
	if err != nil {
		return 0, false, err
	}
	defer closeMigrator(m)
	version, dirty, err := m.Version()
	if errors.Is(err, migrate.ErrNilVersion) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("store: schema version: %w", err)
	}
	return version, dirty, nil
}

// closeMigrator releases the migrator's source and database handles, ignoring
// errors (there is nothing actionable to do with them at teardown).
func closeMigrator(m *migrate.Migrate) {
	srcErr, dbErr := m.Close()
	_ = srcErr
	_ = dbErr
}

// newMigrator wires golang-migrate over the embedded SQL. The pgx/v5 migrate
// driver wraps a database/sql connection (it registers the pgx stdlib driver),
// so migrations run over a short-lived *sql.DB built from the same DSN; the
// engine's own data path stays on the pgxpool. This keeps a single PostgreSQL
// client dependency (pgx) for both the migrator and the runtime.
func (s *Store) newMigrator() (*migrate.Migrate, error) {
	sub, err := fs.Sub(db.Migrations, "migrations")
	if err != nil {
		return nil, fmt.Errorf("store: migration source fs: %w", err)
	}
	src, err := iofs.New(sub, ".")
	if err != nil {
		return nil, fmt.Errorf("store: migration source: %w", err)
	}
	sqlDB, err := sql.Open("pgx", s.dsn)
	if err != nil {
		return nil, fmt.Errorf("store: migration sql open: %w", err)
	}
	// WithInstance reads CURRENT_DATABASE/CURRENT_SCHEMA and installs a
	// dedicated migrations table; the advisory lock is taken by the driver.
	driver, err := migratepgx.WithInstance(sqlDB, &migratepgx.Config{
		MigrationsTable:  "fathom_schema_migrations",
		StatementTimeout: 30 * time.Second,
	})
	if err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("store: migration driver: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", src, "pgx5", driver)
	if err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("store: migrator: %w", err)
	}
	return m, nil
}

// isUniqueViolation reports whether err is a Postgres 23505 and, when
// constraintName is non-empty, on that specific constraint/index.
func isUniqueViolation(err error, constraintName string) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return false
	}
	if constraintName == "" {
		return true
	}
	return pgErr.ConstraintName == constraintName
}

// mapQueryErr turns a pool-level failure into a wrapped storage error. It is
// deliberately distinct from not-found: a DB fault must never be reported as a
// missing workflow (DS-13).
func mapQueryErr(err error, op string) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return err // callers translate genuine absence themselves
	}
	return fmt.Errorf("store: %s: %w", op, err)
}
