package config

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// envMap returns a getenv function backed by m.
func envMap(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) {
		v, ok := m[k]
		return v, ok
	}
}

const fakeDSN = "postgres://fathom:hunter2supersecret@127.0.0.1:5432/fathom?sslmode=disable"

func TestLoadDefaultsWhenOnlyDSNGiven(t *testing.T) {
	cfg, err := Load(envMap(map[string]string{"FATHOM_DATABASE_URL": fakeDSN}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Environment != EnvDev {
		t.Errorf("Environment = %q, want dev", cfg.Environment)
	}
	if cfg.LogLevel != "info" {
		t.Errorf("LogLevel = %q, want info", cfg.LogLevel)
	}
	if cfg.HTTPListenAddr != "127.0.0.1:8080" {
		t.Errorf("HTTPListenAddr = %q, want loopback default", cfg.HTTPListenAddr)
	}
	if cfg.ShutdownTimeout != 10*time.Second {
		t.Errorf("ShutdownTimeout = %v, want 10s", cfg.ShutdownTimeout)
	}
	if cfg.DatabaseURL.Reveal() != fakeDSN {
		t.Errorf("DatabaseURL not carried through")
	}
}

func TestLoadValidOverrides(t *testing.T) {
	cfg, err := Load(envMap(map[string]string{
		"FATHOM_ENV":              "prod",
		"FATHOM_LOG_LEVEL":        "debug",
		"FATHOM_HTTP_ADDR":        "0.0.0.0:9090",
		"FATHOM_SHUTDOWN_TIMEOUT": "30s",
		"FATHOM_DATABASE_URL":     fakeDSN,
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Environment != EnvProd || cfg.LogLevel != "debug" ||
		cfg.HTTPListenAddr != "0.0.0.0:9090" || cfg.ShutdownTimeout != 30*time.Second {
		t.Fatalf("overrides not applied: %+v", cfg)
	}
}

func TestLoadMissingRequiredKeyNamedButNotValued(t *testing.T) {
	_, err := Load(envMap(map[string]string{}))
	if err == nil {
		t.Fatal("expected error when FATHOM_DATABASE_URL missing")
	}
	if !strings.Contains(err.Error(), "FATHOM_DATABASE_URL is required") {
		t.Errorf("error should name the missing key, got: %v", err)
	}
}

func TestLoadInvalidValuesReported(t *testing.T) {
	cases := map[string]struct {
		env  map[string]string
		want string
	}{
		"bad env":       {map[string]string{"FATHOM_ENV": "staging", "FATHOM_DATABASE_URL": fakeDSN}, "FATHOM_ENV must be"},
		"bad log level": {map[string]string{"FATHOM_LOG_LEVEL": "verbose", "FATHOM_DATABASE_URL": fakeDSN}, "FATHOM_LOG_LEVEL must be one of"},
		"bad addr":      {map[string]string{"FATHOM_HTTP_ADDR": "nohostport", "FATHOM_DATABASE_URL": fakeDSN}, "FATHOM_HTTP_ADDR must be of the form"},
		"neg timeout":   {map[string]string{"FATHOM_SHUTDOWN_TIMEOUT": "-5s", "FATHOM_DATABASE_URL": fakeDSN}, "FATHOM_SHUTDOWN_TIMEOUT must be a positive"},
		"non postgres":  {map[string]string{"FATHOM_DATABASE_URL": "mysql://localhost/x"}, "FATHOM_DATABASE_URL: must be a postgres"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := Load(envMap(tc.env))
			if err == nil {
				t.Fatalf("expected error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q missing %q", err.Error(), tc.want)
			}
		})
	}
}

// The security-critical test: a malformed DSN (or any fault) must never echo
// the credential embedded in the DSN value.
func TestErrorsNeverLeakSecretValue(t *testing.T) {
	secretNeedle := "hunter2supersecret"
	// Valid DSN path — ensure a different failure does not include the DSN.
	_, err := Load(envMap(map[string]string{
		"FATHOM_ENV":          "bogus",
		"FATHOM_DATABASE_URL": secretNeedleDSN(),
	}))
	if err != nil {
		if strings.Contains(err.Error(), secretNeedle) {
			t.Fatalf("error leaked DSN credential: %v", err)
		}
	}
	// Invalid DSN path — error mentions shape, not value.
	_, err = Load(envMap(map[string]string{"FATHOM_DATABASE_URL": "postgres://" + secretNeedle + "@x"}))
	if err != nil {
		if strings.Contains(err.Error(), secretNeedle) {
			t.Fatalf("invalid-DSN error leaked credential: %v", err)
		}
	}
}

func secretNeedleDSN() string { return "postgres://u:p@127.0.0.1:5432/db" }

func TestSecretRedactionAcrossVerbs(t *testing.T) {
	s := NewSecret(fakeDSN)
	forms := []string{
		fmt.Sprintf("%v", s),
		fmt.Sprintf("[%s]", s),
		fmt.Sprintf("%+v", Config{DatabaseURL: s}),
		fmt.Sprintf("%#v", s),
	}
	for _, f := range forms {
		if strings.Contains(f, "hunter2supersecret") {
			t.Errorf("form leaked secret: %s", f)
		}
	}
	if s.Reveal() != fakeDSN {
		t.Errorf("Reveal must return the raw value for legitimate use")
	}
}

func TestSecretJSONMarshalRedacted(t *testing.T) {
	b, err := json.Marshal(Config{DatabaseURL: NewSecret(fakeDSN)})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "hunter2supersecret") {
		t.Errorf("JSON leaked secret: %s", b)
	}
	if !strings.Contains(string(b), "REDACTED") {
		t.Errorf("JSON should contain REDACTED, got %s", b)
	}
}

func TestEmptySecretStringIsEmpty(t *testing.T) {
	if got := (Secret{}).String(); got != "" {
		t.Errorf("empty Secret String() = %q, want empty", got)
	}
	if !(Secret{}).Empty() {
		t.Error("empty Secret should report Empty()")
	}
}

func TestNilGetenvYieldsRequiredError(t *testing.T) {
	_, err := Load(nil)
	if err == nil || !strings.Contains(err.Error(), "FATHOM_DATABASE_URL is required") {
		t.Errorf("nil getenv should produce required-key error, got %v", err)
	}
}
