package api

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Role is the ADR-013 authority ladder. Higher roles subsume lower ones:
// reader ⊂ operator ⊂ admin.
type Role int

const (
	RoleNone Role = iota
	RoleReader
	RoleOperator
	RoleAdmin
)

func parseRole(s string) (Role, error) {
	switch s {
	case "reader":
		return RoleReader, nil
	case "operator":
		return RoleOperator, nil
	case "admin":
		return RoleAdmin, nil
	default:
		return RoleNone, fmt.Errorf("api: unknown role %q (want reader|operator|admin)", s)
	}
}

// String renders the role for audit records (operator_action.role) — the
// same vocabulary the key configuration uses, so an audit read needs no
// translation table.
func (r Role) String() string {
	switch r {
	case RoleReader:
		return "reader"
	case RoleOperator:
		return "operator"
	case RoleAdmin:
		return "admin"
	default:
		return "none"
	}
}

// Credential is one API key as configured. Actor identity for audit is the
// LABEL — never the key material, never an invented identity (brief §6).
type Credential struct {
	Label string
	Role  Role
}

// Keys maps bearer token -> credential. Construction is env/config only;
// the map is read-only after startup.
type Keys struct {
	byToken map[string]Credential
}

// ParseKeys reads "label:role:key" entries (one per comma-separated item).
// Malformed entries and unknown roles are errors at startup — an API that
// silently drops a key is an outage waiting to happen quietly.
func ParseKeys(spec string) (*Keys, error) {
	k := &Keys{byToken: map[string]Credential{}}
	if strings.TrimSpace(spec) == "" {
		return nil, errors.New("api: no API keys configured (local-only boundary still requires at least one key; see DEVELOPMENT §FATHOM_API_KEYS)")
	}
	for _, item := range strings.Split(spec, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		parts := strings.SplitN(item, ":", 3)
		if len(parts) != 3 || parts[0] == "" || parts[2] == "" {
			return nil, fmt.Errorf("api: malformed key entry %q (want label:role:key)", redactItem(item))
		}
		role, err := parseRole(parts[1])
		if err != nil {
			return nil, err
		}
		if _, dup := k.byToken[parts[2]]; dup {
			return nil, fmt.Errorf("api: duplicate key material for label %q", parts[0])
		}
		k.byToken[parts[2]] = Credential{Label: parts[0], Role: role}
	}
	if len(k.byToken) == 0 {
		return nil, errors.New("api: no usable key entries")
	}
	return k, nil
}

// redactItem keeps the label for operators but never echoes the key material
// into an error string (and therefore never into a log line).
func redactItem(item string) string {
	if i := strings.LastIndex(item, ":"); i > 0 {
		return item[:i] + ":***"
	}
	return "***"
}

type ctxKey int

const (
	ctxCred ctxKey = iota
	ctxRequestID
)

func credFrom(ctx context.Context) (Credential, bool) {
	c, ok := ctx.Value(ctxCred).(Credential)
	return c, ok
}

func requestID(ctx context.Context) string {
	id, _ := ctx.Value(ctxRequestID).(string)
	return id
}

// Authn verifies the bearer key and stamps the credential on the context.
// 401 for absent/unknown keys, constant-time over the configured set.
func (k *Keys) Authn(next http.Handler, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		token, ok := strings.CutPrefix(h, "Bearer ")
		if !ok || token == "" {
			writeProblem(w, r, log, Problem{Type: "https://fathom.dev/errors/unauthenticated",
				Title: "Unauthenticated", Status: http.StatusUnauthorized, Code: "UNAUTHENTICATED",
				Detail: "Authorization: Bearer <api-key> is required"})
			return
		}
		cred, found := k.lookup(token)
		if !found {
			writeProblem(w, r, log, Problem{Type: "https://fathom.dev/errors/unauthenticated",
				Title: "Unauthenticated", Status: http.StatusUnauthorized, Code: "UNAUTHENTICATED",
				Detail: "the presented key is not recognized"})
			return
		}
		ctx := context.WithValue(r.Context(), ctxCred, cred)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (k *Keys) lookup(token string) (Credential, bool) {
	// Constant-time-ish: compare every entry rather than short-circuiting.
	// Key counts here are tiny (a handful of operators), so a full scan is
	// cheaper than leaking "which prefix matched" through timing.
	var out Credential
	var found bool
	for tok, cred := range k.byToken {
		if constantTimeEqual(tok, token) {
			out, found = cred, true
		}
	}
	return out, found
}

func constantTimeEqual(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// Require gates a handler on a minimum role (honest 403, brief §6 A-T9).
func Require(min Role, h http.HandlerFunc, log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cred, ok := credFrom(r.Context())
		if !ok { // middleware ordering bug, not a client error — fail loud
			log.Error("role gate reached without authentication")
			writeProblem(w, r, log, problemInternal())
			return
		}
		if cred.Role < min {
			writeProblem(w, r, log, Problem{Type: "https://fathom.dev/errors/forbidden",
				Title: "Forbidden", Status: http.StatusForbidden, Code: "FORBIDDEN_ROLE",
				Detail: "this operation requires a higher role than the presented key carries"})
			return
		}
		h(w, r)
	}
}

// RateLimiter: 100 req/min per key label (DATA §B: cheap, real, honest —
// this is care at the edge, not a gateway pretence). Sliding-window counter
// per label, in-process: multi-replica deployments share nothing here, which
// is exactly what the contract's "per key" bound allows.
type RateLimiter struct {
	mu      sync.Mutex
	windows map[string]*window
	limit   int
	period  time.Duration
}

type window struct {
	hits []time.Time
}

func NewRateLimiter(limit int, period time.Duration) *RateLimiter {
	if limit <= 0 {
		limit = 100
	}
	if period <= 0 {
		period = time.Minute
	}
	return &RateLimiter{windows: map[string]*window{}, limit: limit, period: period}
}

// Allow reports whether this request fits, and if not, the retry-after.
func (rl *RateLimiter) Allow(label string) (bool, time.Duration) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	wl, ok := rl.windows[label]
	if !ok {
		wl = &window{}
		rl.windows[label] = wl
	}
	cutoff := now.Add(-rl.period)
	kept := wl.hits[:0]
	for _, t := range wl.hits {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	wl.hits = kept
	if len(wl.hits) >= rl.limit {
		// the oldest hit in the window frees its slot at that time + period
		retry := wl.hits[0].Add(rl.period).Sub(now)
		if retry < time.Second {
			retry = time.Second
		}
		return false, retry
	}
	wl.hits = append(wl.hits, now)
	return true, 0
}

func (rl *RateLimiter) Middleware(next http.Handler, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cred, ok := credFrom(r.Context())
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		if allowed, retry := rl.Allow(cred.Label); !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())))
			writeProblem(w, r, log, Problem{Type: "https://fathom.dev/errors/rate-limited",
				Title: "Too many requests", Status: http.StatusTooManyRequests, Code: "RATE_LIMITED",
				Detail: "per-key request budget exhausted; honour Retry-After"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// LoopbackOnly is the documented local boundary guard (checklist §2.9): the
// server refuses to start bound to a public address while running the
// phase-bearer-key scheme. It is a foot-gun brake, not a security control —
// the control is "do not expose this before real authN".
func LoopbackOnly(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("api: bad listen address %q", addr)
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		return fmt.Errorf("api: refusing public bind on %q while bearer-key auth is the only boundary (phase-5 local-only; see DEVELOPMENT)", addr)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil // hostname: assume operator intent, documented
	}
	if !ip.IsLoopback() {
		return fmt.Errorf("api: refusing non-loopback bind on %q while bearer-key auth is the only boundary", addr)
	}
	return nil
}
