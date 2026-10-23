// Package config establishes the configuration-loading boundary for Fathom.
//
// Configuration is sourced exclusively from the environment so that no real
// secret is ever committed to the repository or embedded in source. Values
// that are sensitive are wrapped in Secret so that accidental formatting or
// JSON marshalling cannot disclose them. Validation errors report which keys
// are missing or malformed and never echo the offending values.
package config

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Secret wraps a sensitive string. Its String, GoString, and MarshalJSON forms
// are redacted, so a Secret printed with %v/%s/%+v/%#v or serialised to JSON
// never reveals the underlying value.
type Secret struct {
	value string
}

// NewSecret wraps v.
func NewSecret(v string) Secret { return Secret{value: v} }

// Reveal returns the underlying value. Callers must use it only where the raw
// secret is genuinely required (for example when opening a DB connection) and
// must never pass the result into a logger or error.
func (s Secret) Reveal() string { return s.value }

// Empty reports whether the secret holds no value.
func (s Secret) Empty() bool { return s.value == "" }

// String implements fmt.Stringer with a redacted form.
func (s Secret) String() string {
	if s.value == "" {
		return ""
	}
	return "[REDACTED]"
}

// GoString implements fmt.GoStringer so %#v stays redacted.
func (s Secret) GoString() string { return "config.Secret(" + s.String() + ")" }

// MarshalJSON serialises to the redacted form.
func (s Secret) MarshalJSON() ([]byte, error) {
	return []byte(strconv.Quote(s.String())), nil
}

// Environment selects the operating profile.
type Environment string

const (
	// EnvDev is the local-development profile (the default).
	EnvDev Environment = "dev"
	// EnvProd disables development conveniences.
	EnvProd Environment = "prod"
)

// Config is the validated application configuration.
type Config struct {
	Environment     Environment
	LogLevel        string
	HTTPListenAddr  string
	ShutdownTimeout time.Duration
	DatabaseURL     Secret
}

// Problems is a set of human-readable configuration errors. It never contains
// secret values, only key names and the nature of the fault.
type Problems []string

func (p Problems) Error() string {
	sorted := append([]string(nil), p...)
	sort.Strings(sorted)
	return "invalid configuration: " + strings.Join(sorted, "; ")
}

// Env keys.
const (
	keyEnv         = "FATHOM_ENV"
	keyLogLevel    = "FATHOM_LOG_LEVEL"
	keyHTTPAddr    = "FATHOM_HTTP_ADDR"
	keyShutdown    = "FATHOM_SHUTDOWN_TIMEOUT"
	keyDatabaseURL = "FATHOM_DATABASE_URL"
)

var validLogLevels = map[string]bool{
	"debug": true, "info": true, "warn": true, "error": true,
}

// Default returns a Config with safe development defaults and no database URL.
// The default HTTP address binds to loopback only, per the security baseline.
func Default() Config {
	return Config{
		Environment:     EnvDev,
		LogLevel:        "info",
		HTTPListenAddr:  "127.0.0.1:8080",
		ShutdownTimeout: 10 * time.Second,
	}
}

// Load reads configuration from the environment via getenv (injectable for
// tests; pass os.LookupEnv-style or a map-backed function). It applies
// defaults, parses and validates, and returns a typed Problems error listing
// every fault without ever including a sensitive value.
func Load(getenv func(string) (string, bool)) (Config, error) {
	cfg := Default()
	var problems Problems

	if v, ok := lookup(getenv, keyEnv); ok && v != "" {
		switch Environment(v) {
		case EnvDev, EnvProd:
			cfg.Environment = Environment(v)
		default:
			problems = append(problems, fmt.Sprintf("%s must be %q or %q", keyEnv, EnvDev, EnvProd))
		}
	}

	if v, ok := lookup(getenv, keyLogLevel); ok && v != "" {
		if !validLogLevels[v] {
			problems = append(problems, fmt.Sprintf("%s must be one of debug, info, warn, error", keyLogLevel))
		} else {
			cfg.LogLevel = v
		}
	}

	if v, ok := lookup(getenv, keyHTTPAddr); ok && v != "" {
		if !strings.Contains(v, ":") {
			problems = append(problems, fmt.Sprintf("%s must be of the form host:port", keyHTTPAddr))
		} else {
			cfg.HTTPListenAddr = v
		}
	}

	if v, ok := lookup(getenv, keyShutdown); ok && v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			problems = append(problems, fmt.Sprintf("%s must be a positive duration (e.g. 10s)", keyShutdown))
		} else {
			cfg.ShutdownTimeout = d
		}
	}

	if v, ok := lookup(getenv, keyDatabaseURL); ok && v != "" {
		if err := validateDSN(v); err != nil {
			// Report the shape problem only; never echo the DSN (it may embed credentials).
			problems = append(problems, fmt.Sprintf("%s: %s", keyDatabaseURL, err))
		} else {
			cfg.DatabaseURL = NewSecret(v)
		}
	} else {
		problems = append(problems, fmt.Sprintf("%s is required", keyDatabaseURL))
	}

	if len(problems) > 0 {
		return Config{}, problems
	}
	return cfg, nil
}

// validateDSN checks the shape of a Postgres DSN without inspecting (or
// reporting) any credential it may contain.
func validateDSN(dsn string) error {
	lower := strings.ToLower(dsn)
	if !strings.HasPrefix(lower, "postgres://") && !strings.HasPrefix(lower, "postgresql://") {
		return errors.New("must be a postgres:// URL")
	}
	return nil
}

func lookup(getenv func(string) (string, bool), key string) (string, bool) {
	if getenv == nil {
		return "", false
	}
	return getenv(key)
}
