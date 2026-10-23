//go:build integration

package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Lakhyajit-96/fathom/internal/id"
	postgres "github.com/Lakhyajit-96/fathom/internal/store/postgres"
)

// API-tier T-INT tests (brief §6 + §9.11–14): real HTTP through the real
// middleware stack against real PostgreSQL. The engine itself is exercised
// only through what a correct request legitimately reaches — every validation
// test must leave the workflow table untouched (§9.13).

var store *postgres.Store

func TestMain(m *testing.M) {
	dsn := os.Getenv("FATHOM_TEST_DATABASE_URL")
	if dsn == "" {
		fmt.Println("integration: FATHOM_TEST_DATABASE_URL unset — skipping api tests")
		os.Exit(0)
	}
	ctx := context.Background()
	st, err := postgres.Open(ctx, dsn)
	if err != nil {
		fmt.Println("integration: open:", err)
		os.Exit(1)
	}
	if err := st.Migrate(ctx); err != nil {
		fmt.Println("integration: migrate:", err)
		os.Exit(1)
	}
	store = st
	code := m.Run()
	store.Close()
	os.Exit(code)
}

func resetDB(t *testing.T) {
	t.Helper()
	_, err := store.Pool().Exec(context.Background(),
		`TRUNCATE attempt, step, processed_events, inbound_event, outbox, api_idempotency, dead_letter, audit_event, workflow,
		         operator_action, relay_checkpoint, workflow_definition CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// keys under test: one credential per role, plus documented labels.
const (
	opKey  = "k-test-operator-0001"
	rdKey  = "k-test-reader-000002"
	admKey = "k-test-admin-000003"
)

func testKeys(t *testing.T) *Keys {
	t.Helper()
	k, err := ParseKeys("op:operator:" + opKey + ",rd:reader:" + rdKey + ",adm:admin:" + admKey)
	if err != nil {
		t.Fatalf("ParseKeys: %v", err)
	}
	return k
}

// newTestServer registers the "api-test" definition at the store level so
// creation tests start from a resolvable ACTIVE definition. Mutators run
// BEFORE Handler() assembles the middleware chain — the rate-limit test
// replaces the limiter, and a stale pointer behind the chain would silently
// disable it.
func newTestServer(t *testing.T, mutate ...func(*Server)) (*Server, *httptest.Server) {
	t.Helper()
	if _, err := store.RegisterDefinition(context.Background(), "api-test", 1,
		json.RawMessage(`[{"type":"charge","max_attempts":2}]`)); err != nil {
		t.Fatalf("seed definition: %v", err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if os.Getenv("FATHOM_API_TEST_VERBOSE") != "" {
		log = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	s, err := New(store, testKeys(t), log)
	if err != nil {
		t.Fatalf("api.New: %v", err)
	}
	for _, m := range mutate {
		m(s)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, ts
}

type call struct {
	method, path string
	body         any // nil => no body; string => sent raw
	key          string
	idem         string
	hdr          map[string]string
}

func do(t *testing.T, ts *httptest.Server, c call) (*http.Response, []byte) {
	t.Helper()
	var rd io.Reader
	if c.body != nil {
		if s, ok := c.body.(string); ok {
			rd = strings.NewReader(s)
		} else {
			b, err := json.Marshal(c.body)
			if err != nil {
				t.Fatalf("marshal body: %v", err)
			}
			rd = bytes.NewReader(b)
		}
	}
	req, err := http.NewRequest(c.method, ts.URL+c.path, rd)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if c.key != "" {
		req.Header.Set("Authorization", "Bearer "+c.key)
	}
	if c.idem != "" {
		req.Header.Set("Idempotency-Key", c.idem)
	}
	for k, v := range c.hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, body
}

// problem decodes the RFC 9457 envelope; every non-2xx answer must carry it.
func problemOf(t *testing.T, resp *http.Response, body []byte) map[string]any {
	t.Helper()
	if ct := resp.Header.Get("Content-Type"); ct != "application/problem+json" {
		t.Fatalf("error content-type = %q, want application/problem+json (body %q)", ct, body)
	}
	var p map[string]any
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatalf("problem body not JSON: %v (%q)", err, body)
	}
	if p["code"] == nil || p["code"] == "" {
		t.Fatalf("problem without stable code: %v", p)
	}
	if p["trace_id"] == nil || p["trace_id"] == "" {
		t.Fatalf("problem without trace_id: %v", p)
	}
	return p
}

func codeOf(t *testing.T, resp *http.Response, body []byte) string {
	p := problemOf(t, resp, body)
	return p["code"].(string)
}

// assertRequestID checks the trace contract on any response: the echoed
// X-Request-Id must equal the problem's trace_id.
func assertRequestID(t *testing.T, resp *http.Response, body []byte) {
	t.Helper()
	rid := resp.Header.Get("X-Request-Id")
	if rid == "" {
		t.Fatalf("no X-Request-Id echoed")
	}
	if resp.Header.Get("Content-Type") == "application/problem+json" {
		p := problemOf(t, resp, body)
		if p["trace_id"] != rid {
			t.Fatalf("trace_id %v != X-Request-Id %q", p["trace_id"], rid)
		}
	}
}

func countRows(t *testing.T, table string) int {
	t.Helper()
	var n int
	err := store.Pool().QueryRow(context.Background(), `SELECT count(*) FROM `+table).Scan(&n)
	if err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return n
}

// futureDeadline returns a fixed RFC3339 instant one hour ahead; callers reuse
// the exact string so replayed creates are byte-identical.
func futureDeadline() string {
	return time.Now().UTC().Add(time.Hour).Format(time.RFC3339)
}

func createBody(bk, deadline string) string {
	return `{"def_name":"api-test","business_key":"` + bk + `","input":{"n":1},"deadline":"` + deadline + `"}`
}

// ---- §9.13 validation: the engine must never see these requests -----------

func TestAPI_ValidationNeverReachesEngine(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)
	dl := futureDeadline()

	cases := []struct {
		name    string
		c       call
		want    int
		wantKey string // code or header-level rule
	}{
		{"missing idempotency key", call{method: "POST", path: "/v1/workflows", key: opKey, body: createBody("bk-v1", dl)}, 400, "IDEMPOTENCY_KEY_REQUIRED"},
		{"too long idempotency key", call{method: "POST", path: "/v1/workflows", key: opKey, idem: strings.Repeat("k", 256), body: createBody("bk-v2", dl)}, 400, "IDEMPOTENCY_KEY_TOO_LONG"},
		{"missing def_name", call{method: "POST", path: "/v1/workflows", key: opKey, idem: id.New(), body: `{"business_key":"bk-v3","deadline":"` + dl + `"}`}, 422, "VALIDATION_FAILED"},
		{"missing business key", call{method: "POST", path: "/v1/workflows", key: opKey, idem: id.New(), body: `{"def_name":"api-test","deadline":"` + dl + `"}`}, 422, "VALIDATION_FAILED"},
		{"missing deadline", call{method: "POST", path: "/v1/workflows", key: opKey, idem: id.New(), body: `{"def_name":"api-test","business_key":"bk-v5"}`}, 422, "VALIDATION_FAILED"},
		{"past deadline", call{method: "POST", path: "/v1/workflows", key: opKey, idem: id.New(), body: createBody("bk-v6", time.Now().UTC().Add(-time.Hour).Format(time.RFC3339))}, 422, "VALIDATION_FAILED"},
		{"malformed json", call{method: "POST", path: "/v1/workflows", key: opKey, idem: id.New(), body: `{"def_name":`}, 400, "MALFORMED_JSON"},
		{"unknown field", call{method: "POST", path: "/v1/workflows", key: opKey, idem: id.New(), body: `{"def_name":"api-test","business_key":"bk-v8","deadline":"` + dl + `","bogus":1}`}, 400, "MALFORMED_JSON"},
		{"trailing garbage", call{method: "POST", path: "/v1/workflows", key: opKey, idem: id.New(), body: createBody("bk-v9", dl) + " {}"}, 400, "TRAILING_BODY"},
		{"body too large", call{method: "POST", path: "/v1/workflows", key: opKey, idem: id.New(), body: `{"def_name":"api-test","business_key":"bk-v10","deadline":"` + dl + `","input":{"blob":"` + strings.Repeat("a", 2<<20) + `"}}`}, 400, "REQUEST_TOO_LARGE"},
		{"unknown definition", call{method: "POST", path: "/v1/workflows", key: opKey, idem: id.New(), body: `{"def_name":"nope","business_key":"bk-v11","deadline":"` + dl + `"}`}, 404, "DEFINITION_NOT_FOUND"},
	}
	for _, tc := range cases {
		resp, body := do(t, ts, tc.c)
		if resp.StatusCode != tc.want {
			t.Fatalf("%s: status %d want %d (body %q)", tc.name, resp.StatusCode, tc.want, body)
		}
		if got := codeOf(t, resp, body); got != tc.wantKey {
			t.Fatalf("%s: code %q want %q", tc.name, got, tc.wantKey)
		}
		assertRequestID(t, resp, body)
	}
	// The point of the whole table: nothing reached the machine.
	if n := countRows(t, "workflow"); n != 0 {
		t.Fatalf("rejected creates left %d workflow rows", n)
	}
	// The field-error list rode along on the 422s.
	resp, body := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: id.New(), body: `{}`})
	_ = resp
	var p map[string]any
	json.Unmarshal(body, &p)
	if errs, ok := p["errors"].([]any); !ok || len(errs) == 0 {
		t.Fatalf("422 without field errors: %v", p)
	}
}

// ---- idempotency: replay, conflict, concurrency ----------------------------

func TestAPI_CreateReplayAndConflict(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)
	dl := futureDeadline()
	key := "idem-" + id.New()

	resp1, body1 := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: key, body: createBody("bk-r1", dl)})
	if resp1.StatusCode != 201 {
		t.Fatalf("create status %d body %q", resp1.StatusCode, body1)
	}
	if resp1.Header.Get("Idempotency-Replayed") != "" {
		t.Fatalf("first create must not be marked replayed")
	}
	if loc := resp1.Header.Get("Location"); !strings.HasPrefix(loc, "/v1/workflows/") {
		t.Fatalf("Location = %q", loc)
	}
	var created workflowDTO
	if err := json.Unmarshal(body1, &created); err != nil {
		t.Fatalf("201 body: %v", err)
	}
	if created.State != "QUEUED" || created.Version != 1 {
		t.Fatalf("fresh workflow = %s v%d", created.State, created.Version)
	}

	// Same key, same content: replay of the FIRST durable response.
	resp2, body2 := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: key, body: createBody("bk-r1", dl)})
	if resp2.StatusCode != 201 {
		t.Fatalf("replay status %d body %q", resp2.StatusCode, body2)
	}
	if resp2.Header.Get("Idempotency-Replayed") != "true" {
		t.Fatalf("replay header missing")
	}
	if !bytes.Equal(body1, body2) {
		t.Fatalf("replay body differs:\n %s\n %s", body1, body2)
	}

	// Same key, different content: the specified 422 conflict.
	resp3, body3 := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: key, body: createBody("bk-DIFFERENT", dl)})
	if resp3.StatusCode != 422 || codeOf(t, resp3, body3) != "IDEMPOTENCY_CONFLICT" {
		t.Fatalf("reuse-with-different-content = %d %q", resp3.StatusCode, body3)
	}
	if n := countRows(t, "workflow"); n != 1 {
		t.Fatalf("idempotency suite produced %d workflows, want 1", n)
	}
}

func TestAPI_ActiveBusinessKeyConflict(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)
	dl := futureDeadline()

	resp, body := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: "k1-" + id.New(), body: createBody("bk-active", dl)})
	if resp.StatusCode != 201 {
		t.Fatalf("first create %d %q", resp.StatusCode, body)
	}
	var first workflowDTO
	json.Unmarshal(body, &first)

	resp2, body2 := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: "k2-" + id.New(), body: createBody("bk-active", dl)})
	if resp2.StatusCode != 409 || codeOf(t, resp2, body2) != "ACTIVE_WORKFLOW_FOR_KEY" {
		t.Fatalf("active-key guard = %d %q", resp2.StatusCode, body2)
	}
	var p map[string]any
	json.Unmarshal(body2, &p)
	if p["conflicting_workflow_id"] != first.ID {
		t.Fatalf("conflict must name the active workflow: %v", p)
	}
}

func TestAPI_ConcurrentSameKey(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)
	dl := futureDeadline()
	key := "race-" + id.New()
	body := createBody("bk-race", dl)

	type res struct {
		status int
		id     string
	}
	var wg sync.WaitGroup
	out := make(chan res, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, b := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: key, body: body})
			var w workflowDTO
			_ = json.Unmarshal(b, &w)
			out <- res{resp.StatusCode, w.ID}
		}()
	}
	wg.Wait()
	close(out)
	ids := map[string]bool{}
	for r := range out {
		if r.status != 201 {
			t.Fatalf("concurrent create returned status %d", r.status)
		}
		ids[r.id] = true
	}
	if len(ids) != 1 {
		t.Fatalf("same key raced into %d distinct workflows: %v", len(ids), ids)
	}
	if n := countRows(t, "workflow"); n != 1 {
		t.Fatalf("concurrent same-key created %d rows, want 1", n)
	}
}

// ---- auth boundary and RBAC -------------------------------------------------

func TestAPI_AuthBoundary(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)

	resp, body := do(t, ts, call{method: "GET", path: "/v1/workflows"})
	if resp.StatusCode != 401 || codeOf(t, resp, body) != "UNAUTHENTICATED" {
		t.Fatalf("anonymous request = %d %q", resp.StatusCode, body)
	}
	resp2, body2 := do(t, ts, call{method: "GET", path: "/v1/workflows", key: "wrong-key-material"})
	if resp2.StatusCode != 401 || codeOf(t, resp2, body2) != "UNAUTHENTICATED" {
		t.Fatalf("unknown key = %d %q", resp2.StatusCode, body2)
	}
	// Infra lanes stay reachable without keys (documented loopback boundary).
	resp3, _ := do(t, ts, call{method: "GET", path: "/healthz"})
	if resp3.StatusCode != 200 {
		t.Fatalf("healthz behind the boundary? %d", resp3.StatusCode)
	}
}

func TestAPI_RBACLadder(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)
	dl := futureDeadline()

	// reader cannot create (403, honest — not a fake 404)
	resp, body := do(t, ts, call{method: "POST", path: "/v1/workflows", key: rdKey, idem: id.New(), body: createBody("bk-rbac", dl)})
	if resp.StatusCode != 403 || codeOf(t, resp, body) != "FORBIDDEN_ROLE" {
		t.Fatalf("reader create = %d %q", resp.StatusCode, body)
	}
	// reader can read
	resp2, _ := do(t, ts, call{method: "GET", path: "/v1/workflows", key: rdKey})
	if resp2.StatusCode != 200 {
		t.Fatalf("reader list = %d", resp2.StatusCode)
	}
	// operator cannot register definitions (admin-only)
	resp3, body3 := do(t, ts, call{method: "POST", path: "/v1/definitions", key: opKey,
		body: `{"name":"def-op","version":1,"steps":[{"type":"x"}]}`})
	if resp3.StatusCode != 403 || codeOf(t, resp3, body3) != "FORBIDDEN_ROLE" {
		t.Fatalf("operator definition register = %d %q", resp3.StatusCode, body3)
	}
	// admin can
	resp4, _ := do(t, ts, call{method: "POST", path: "/v1/definitions", key: admKey,
		body: `{"name":"def-adm","version":1,"steps":[{"type":"x"}]}`})
	if resp4.StatusCode != 201 {
		t.Fatalf("admin register = %d", resp4.StatusCode)
	}
}

func TestAPI_RateLimit(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t, func(s *Server) { s.limiter = NewRateLimiter(2, time.Minute) }) // tiny budget on purpose

	for i := 0; i < 2; i++ {
		resp, _ := do(t, ts, call{method: "GET", path: "/v1/workflows", key: rdKey})
		if resp.StatusCode != 200 {
			t.Fatalf("request %d should fit the budget: %d", i+1, resp.StatusCode)
		}
	}
	resp, body := do(t, ts, call{method: "GET", path: "/v1/workflows", key: rdKey})
	if resp.StatusCode != 429 || codeOf(t, resp, body) != "RATE_LIMITED" {
		t.Fatalf("over-budget = %d %q", resp.StatusCode, body)
	}
	ra := resp.Header.Get("Retry-After")
	n, err := strconv.Atoi(ra)
	if err != nil || n < 1 {
		t.Fatalf("Retry-After = %q (want integer >= 1)", ra)
	}
	// A different key has its own budget (per-key, not global).
	resp2, _ := do(t, ts, call{method: "GET", path: "/v1/workflows", key: opKey})
	if resp2.StatusCode != 200 {
		t.Fatalf("other key should be unaffected: %d", resp2.StatusCode)
	}
}

// ---- cursor pagination --------------------------------------------------------

func TestAPI_PaginationStability(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)
	dl := futureDeadline()
	for i := 0; i < 5; i++ {
		resp, body := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey,
			idem: fmt.Sprintf("page-%d", i), body: createBody(fmt.Sprintf("bk-page-%d", i), dl)})
		if resp.StatusCode != 201 {
			t.Fatalf("seed create %d: %d %q", i, resp.StatusCode, body)
		}
	}

	seen := map[string]bool{}
	pages := 0
	var cursor string
	for {
		p := "/v1/workflows?limit=2"
		if cursor != "" {
			p += "&cursor=" + cursor
		}
		resp, body := do(t, ts, call{method: "GET", path: p, key: rdKey})
		if resp.StatusCode != 200 {
			t.Fatalf("page fetch: %d %q", resp.StatusCode, body)
		}
		var lr struct {
			Items      []workflowDTO `json:"items"`
			NextCursor *string       `json:"next_cursor"`
		}
		if err := json.Unmarshal(body, &lr); err != nil {
			t.Fatalf("page body: %v (%q)", err, body)
		}
		if len(lr.Items) > 2 {
			t.Fatalf("page over limit: %d", len(lr.Items))
		}
		for _, it := range lr.Items {
			if seen[it.ID] {
				t.Fatalf("duplicate id across pages: %s", it.ID)
			}
			seen[it.ID] = true
		}
		pages++
		if lr.NextCursor == nil {
			break
		}
		cursor = *lr.NextCursor
		if pages > 10 {
			t.Fatalf("cursor chain never ended")
		}
	}
	if len(seen) != 5 || pages != 3 {
		t.Fatalf("walked %d ids over %d pages, want 5 over 3", len(seen), pages)
	}

	// Keyset stability under a concurrent insert: remember page 1, add a
	// newer row, resume from page 1's cursor — page 2 must not repeat a
	// page-1 id and the late arrival must not shift anything (DATA §B: the
	// cursor is the reason this list has no OFFSET).
	respI, bodyI := do(t, ts, call{method: "GET", path: "/v1/workflows?limit=2", key: rdKey})
	if respI.StatusCode != 200 {
		t.Fatalf("page-1 refetch: %d %q", respI.StatusCode, bodyI)
	}
	var p1 struct {
		Items      []workflowDTO `json:"items"`
		NextCursor *string       `json:"next_cursor"`
	}
	json.Unmarshal(bodyI, &p1)
	page1 := map[string]bool{}
	for _, it := range p1.Items {
		page1[it.ID] = true
	}
	respN, bodyN := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: "page-late", body: createBody("bk-page-late", dl)})
	if respN.StatusCode != 201 {
		t.Fatalf("late insert: %d %q", respN.StatusCode, bodyN)
	}
	if p1.NextCursor == nil {
		t.Fatalf("page 1 of 6 rows must carry a cursor")
	}
	_, body2 := do(t, ts, call{method: "GET", path: "/v1/workflows?limit=2&cursor=" + *p1.NextCursor, key: rdKey})
	var p2 struct {
		Items []workflowDTO `json:"items"`
	}
	json.Unmarshal(body2, &p2)
	for _, it := range p2.Items {
		if page1[it.ID] {
			t.Fatalf("keyset page 2 repeated a page-1 id after a concurrent insert: %s", it.ID)
		}
	}

	// Corrupt cursors are loud 400s.
	bad := encodeCursor("not-a-uuid")
	resp3, body3 := do(t, ts, call{method: "GET", path: "/v1/workflows?cursor=" + bad, key: rdKey})
	if resp3.StatusCode != 400 || codeOf(t, resp3, body3) != "INVALID_CURSOR" {
		t.Fatalf("corrupt cursor = %d %q", resp3.StatusCode, body3)
	}
	resp4, body4 := do(t, ts, call{method: "GET", path: "/v1/workflows?cursor=!!!notbase64", key: rdKey})
	if resp4.StatusCode != 400 || codeOf(t, resp4, body4) != "INVALID_CURSOR" {
		t.Fatalf("undecodable cursor = %d %q", resp4.StatusCode, body4)
	}
	// Bad limits are bounded.
	for _, badLimit := range []string{"0", "101", "abc"} {
		resp5, body5 := do(t, ts, call{method: "GET", path: "/v1/workflows?limit=" + badLimit, key: rdKey})
		if resp5.StatusCode != 400 || codeOf(t, resp5, body5) != "INVALID_LIMIT" {
			t.Fatalf("limit %q = %d %q", badLimit, resp5.StatusCode, body5)
		}
	}
}

// ---- cancel / retry-now: the machine's honest answers -------------------------

func TestAPI_CancelFlow(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)
	dl := futureDeadline()

	resp, body := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: "cx-1", body: createBody("bk-cancel", dl)})
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %q", resp.StatusCode, body)
	}
	var w workflowDTO
	json.Unmarshal(body, &w)

	// Wrong version -> 409 CONFLICT_RETRY carrying the CURRENT version.
	resp2, body2 := do(t, ts, call{method: "POST", path: "/v1/workflows/" + w.ID + "/actions:cancel", key: opKey,
		body: `{"reason":"operator test","version":99}`})
	if resp2.StatusCode != 409 || codeOf(t, resp2, body2) != "CONFLICT_RETRY" {
		t.Fatalf("stale cancel = %d %q", resp2.StatusCode, body2)
	}
	var p map[string]any
	json.Unmarshal(body2, &p)
	if v, ok := p["version"].(float64); !ok || int64(v) != 1 {
		t.Fatalf("CONFLICT_RETRY must carry current version, got %v", p["version"])
	}

	// Right version: QUEUED W14 goes straight to FAILED (nothing ran).
	resp3, body3 := do(t, ts, call{method: "POST", path: "/v1/workflows/" + w.ID + "/actions:cancel", key: opKey,
		body: `{"reason":"operator test","version":1}`})
	if resp3.StatusCode != http.StatusAccepted {
		t.Fatalf("cancel = %d %q", resp3.StatusCode, body3)
	}
	var ar actionResult
	json.Unmarshal(body3, &ar)
	if ar.State != "FAILED" || ar.Version != 2 {
		t.Fatalf("W14 verdict = %+v", ar)
	}

	// Terminal is immutable: the second cancel is a loud 409 NOT_CANCELLABLE.
	resp4, body4 := do(t, ts, call{method: "POST", path: "/v1/workflows/" + w.ID + "/actions:cancel", key: opKey,
		body: `{"reason":"again","version":2}`})
	if resp4.StatusCode != 409 || codeOf(t, resp4, body4) != "NOT_CANCELLABLE" {
		t.Fatalf("terminal cancel = %d %q", resp4.StatusCode, body4)
	}

	// Cancel validation never reaches the machine either.
	resp5, body5 := do(t, ts, call{method: "POST", path: "/v1/workflows/" + w.ID + "/actions:cancel", key: opKey,
		body: `{"version":2}`})
	if resp5.StatusCode != 422 || codeOf(t, resp5, body5) != "VALIDATION_FAILED" {
		t.Fatalf("reasonless cancel = %d %q", resp5.StatusCode, body5)
	}

	// The audit trail grew through the API-visible read: pages of events.
	resp6, body6 := do(t, ts, call{method: "GET", path: "/v1/workflows/" + w.ID + "/events", key: rdKey})
	if resp6.StatusCode != 200 {
		t.Fatalf("events read: %d %q", resp6.StatusCode, body6)
	}
	if !strings.Contains(string(body6), "WORKFLOW_CANCELLED") {
		t.Fatalf("cancel audit absent from events: %q", body6)
	}
}

func TestAPI_RetryNowRequiresRetryWaiting(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)
	dl := futureDeadline()

	resp, body := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: "rn-1", body: createBody("bk-retry", dl)})
	var w workflowDTO
	json.Unmarshal(body, &w)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %q", resp.StatusCode, body)
	}
	// QUEUED is not RETRY_WAITING — W18 refuses, and the API says so plainly.
	resp2, body2 := do(t, ts, call{method: "POST", path: "/v1/workflows/" + w.ID + "/actions:retry-now", key: opKey,
		body: `{"reason":"jump the queue","version":1}`})
	if resp2.StatusCode != 409 || codeOf(t, resp2, body2) != "NOT_RETRYABLE" {
		t.Fatalf("retry-now on QUEUED = %d %q", resp2.StatusCode, body2)
	}
	if !strings.Contains(string(body2), "RETRY_WAITING") {
		t.Fatalf("refusal should teach the precondition: %q", body2)
	}
}

// ---- reads: 404 shape, id hygiene, DTO fidelity --------------------------------

func TestAPI_ReadNotFoundAndBadID(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)
	ghost := id.New()

	resp, body := do(t, ts, call{method: "GET", path: "/v1/workflows/" + ghost, key: rdKey})
	if resp.StatusCode != 404 || codeOf(t, resp, body) != "WORKFLOW_NOT_FOUND" {
		t.Fatalf("ghost workflow = %d %q", resp.StatusCode, body)
	}
	for _, path := range []string{"/v1/workflows/123", "/v1/workflows/not-a-uuid/events"} {
		resp2, body2 := do(t, ts, call{method: "GET", path: path, key: rdKey})
		if resp2.StatusCode != 400 || codeOf(t, resp2, body2) != "INVALID_ID" {
			t.Fatalf("%s = %d %q", path, resp2.StatusCode, body2)
		}
	}
	// Sub-lists of a ghost are 404 via the existence gate.
	resp3, body3 := do(t, ts, call{method: "GET", path: "/v1/workflows/" + ghost + "/attempts", key: rdKey})
	if resp3.StatusCode != 404 || codeOf(t, resp3, body3) != "WORKFLOW_NOT_FOUND" {
		t.Fatalf("ghost attempts = %d %q", resp3.StatusCode, body3)
	}
}

// TestAPI_StorageFaultIsNot404 pins DS-13: a dead dependency is a 500, and
// /healthz keeps answering because it never touches the database.
func TestAPI_StorageFaultIsNot404(t *testing.T) {
	dsn := os.Getenv("FATHOM_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("no dsn")
	}
	st, err := postgres.Open(context.Background(), dsn)
	if err != nil {
		t.Fatalf("second store: %v", err)
	}
	st.Close() // hard fault: every query from here on fails
	s, err := New(st, testKeys(t), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	resp, body := do(t, ts, call{method: "GET", path: "/v1/workflows/" + id.New(), key: rdKey})
	if resp.StatusCode != 500 || codeOf(t, resp, body) != "INTERNAL" {
		t.Fatalf("storage fault = %d %q (must be 500 INTERNAL, never a 404 disguise)", resp.StatusCode, body)
	}
	resp2, _ := do(t, ts, call{method: "GET", path: "/healthz"})
	if resp2.StatusCode != 200 {
		t.Fatalf("healthz must not depend on the database: %d", resp2.StatusCode)
	}
}

func TestAPI_CreateBodyIsDurableRow(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)
	dl := futureDeadline()

	resp, body := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: "dt-1",
		body: `{"def_name":"api-test","business_key":"bk-dto","input":{"gift":"value"},"deadline":"` + dl + `"}`})
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %q", resp.StatusCode, body)
	}
	// input rides the wire as JSON, not base64 — the DTO's whole purpose.
	if !strings.Contains(string(body), `"input":{"gift":"value"}`) {
		t.Fatalf("input not raw JSON on the wire: %q", body)
	}
	var w workflowDTO
	json.Unmarshal(body, &w)
	// GET must agree with the 201 body field-for-field.
	_, body2 := do(t, ts, call{method: "GET", path: "/v1/workflows/" + w.ID, key: rdKey})
	var w2 workflowDTO
	json.Unmarshal(body2, &w2)
	if w2.CreatedAt.Equal(w.CreatedAt) == false || w2.State != w.State || w2.Version != w.Version {
		t.Fatalf("detail disagrees with create: %+v vs %+v", w, w2)
	}
}

// ---- definitions through the API ----------------------------------------------

func TestAPI_DefinitionsLifecycle(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)

	resp, body := do(t, ts, call{method: "POST", path: "/v1/definitions", key: admKey,
		body: `{"name":"def-flow","version":1,"steps":[{"type":"a"},{"type":"b","compensable":true}]}`})
	if resp.StatusCode != 201 {
		t.Fatalf("register: %d %q", resp.StatusCode, body)
	}
	// Immutability: re-registering the same version is a typed 409.
	resp2, body2 := do(t, ts, call{method: "POST", path: "/v1/definitions", key: admKey,
		body: `{"name":"def-flow","version":1,"steps":[{"type":"c"}]}`})
	if resp2.StatusCode != 409 || codeOf(t, resp2, body2) != "DEFINITION_EXISTS" {
		t.Fatalf("re-register = %d %q", resp2.StatusCode, body2)
	}
	// Store-side validation surfaces as 422 with the rule named.
	resp3, body3 := do(t, ts, call{method: "POST", path: "/v1/definitions", key: admKey,
		body: `{"name":"def-dup","version":1,"steps":[{"type":"a"},{"type":"a"}]}`})
	if resp3.StatusCode != 422 {
		t.Fatalf("duplicate step types = %d %q", resp3.StatusCode, body3)
	}
	// The new definition is creatable, and steps ride as JSON.
	dl := futureDeadline()
	resp4, body4 := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: "df-1",
		body: `{"def_name":"def-flow","business_key":"bk-def","deadline":"` + dl + `"}`})
	if resp4.StatusCode != 201 {
		t.Fatalf("create from registered def: %d %q", resp4.StatusCode, body4)
	}
	var w workflowDTO
	json.Unmarshal(body4, &w)
	if len(w.Steps) != 2 {
		t.Fatalf("workflow steps = %d, want 2", len(w.Steps))
	}
	// List carries ACTIVE status and raw step JSON.
	resp5, body5 := do(t, ts, call{method: "GET", path: "/v1/definitions?name=def-flow", key: rdKey})
	if resp5.StatusCode != 200 || !strings.Contains(string(body5), `"status":"ACTIVE"`) {
		t.Fatalf("definition list = %d %q", resp5.StatusCode, body5)
	}
}

// ---- DLQ console ---------------------------------------------------------------

func seedDeadLetter(t *testing.T, wfID, class string) string {
	t.Helper()
	dlID := id.New()
	_, err := store.Pool().Exec(context.Background(),
		`INSERT INTO dead_letter (id, workflow_id, class, reason_code, detail)
		 VALUES ($1, $2, $3, 'SPEC_MALFORMED', '{"why":"test seed"}')`,
		dlID, wfID, class)
	if err != nil {
		t.Fatalf("seed dead_letter: %v", err)
	}
	return dlID
}

func TestAPI_DeadLetterConsole(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)
	dl := futureDeadline()

	resp, body := do(t, ts, call{method: "POST", path: "/v1/workflows", key: opKey, idem: "dq-1", body: createBody("bk-dlq", dl)})
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %q", resp.StatusCode, body)
	}
	var w workflowDTO
	json.Unmarshal(body, &w)
	seed1 := seedDeadLetter(t, w.ID, "UNPARSEABLE_EVENT")
	seed2 := seedDeadLetter(t, w.ID, "DEADLINE")

	// Unfiltered open list.
	resp2, body2 := do(t, ts, call{method: "GET", path: "/v1/dlq", key: rdKey})
	if resp2.StatusCode != 200 {
		t.Fatalf("dlq list = %d %q", resp2.StatusCode, body2)
	}
	var lr struct {
		Items []deadLetterDTO `json:"items"`
	}
	if err := json.Unmarshal(body2, &lr); err != nil {
		t.Fatalf("dlq items: %v", err)
	}
	if len(lr.Items) != 2 {
		t.Fatalf("open dlq depth = %d, want 2", len(lr.Items))
	}
	// detail rode as JSON, not base64.
	if !strings.Contains(string(body2), `"why":"test seed"`) {
		t.Fatalf("dead-letter detail not raw JSON on the wire: %q", body2)
	}

	// class filter and workflow_id filter (DATA §B).
	_, body3 := do(t, ts, call{method: "GET", path: "/v1/dlq?class=DEADLINE", key: rdKey})
	var lr3 struct {
		Items []deadLetterDTO `json:"items"`
	}
	json.Unmarshal(body3, &lr3)
	if len(lr3.Items) != 1 || lr3.Items[0].ID != seed2 {
		t.Fatalf("class filter = %s", body3)
	}
	_, body4 := do(t, ts, call{method: "GET", path: "/v1/dlq?workflow_id=" + w.ID, key: rdKey})
	var lr4 struct {
		Items []deadLetterDTO `json:"items"`
	}
	json.Unmarshal(body4, &lr4)
	if len(lr4.Items) != 2 {
		t.Fatalf("workflow filter = %s", body4)
	}
	resp5, body5 := do(t, ts, call{method: "GET", path: "/v1/dlq?workflow_id=not-a-uuid", key: rdKey})
	if resp5.StatusCode != 400 || codeOf(t, resp5, body5) != "INVALID_PARAM" {
		t.Fatalf("bad workflow_id filter = %d %q", resp5.StatusCode, body5)
	}

	// Resolve validation gates (full W17 resolution is covered store-side).
	resp6, body6 := do(t, ts, call{method: "POST", path: "/v1/dlq/" + seed1 + "/actions:resolve", key: opKey,
		body: `{"action":"explode","reason":"x"}`})
	if resp6.StatusCode != 422 || codeOf(t, resp6, body6) != "VALIDATION_FAILED" {
		t.Fatalf("unknown action = %d %q", resp6.StatusCode, body6)
	}
	resp7, body7 := do(t, ts, call{method: "POST", path: "/v1/dlq/" + seed1 + "/actions:resolve", key: opKey,
		body: `{"action":"retry-now","reason":"x"}`})
	if resp7.StatusCode != 422 || !strings.Contains(string(body7), "/actions:retry-now") {
		t.Fatalf("retry-now redirect guidance = %d %q", resp7.StatusCode, body7)
	}
	resp8, body8 := do(t, ts, call{method: "POST", path: "/v1/dlq/" + seed1 + "/actions:resolve", key: opKey,
		body: `{"action":"force-terminate"}`})
	if resp8.StatusCode != 422 || codeOf(t, resp8, body8) != "REASON_REQUIRED" {
		t.Fatalf("reasonless resolve = %d %q", resp8.StatusCode, body8)
	}
	resp9, body9 := do(t, ts, call{method: "POST", path: "/v1/dlq/" + id.New() + "/actions:resolve", key: opKey,
		body: `{"action":"force-terminate","reason":"ghost item"}`})
	if resp9.StatusCode != 404 || codeOf(t, resp9, body9) != "DEAD_LETTER_NOT_FOUND" {
		t.Fatalf("ghost resolve = %d %q", resp9.StatusCode, body9)
	}
	// reader cannot resolve.
	resp10, body10 := do(t, ts, call{method: "POST", path: "/v1/dlq/" + seed1 + "/actions:resolve", key: rdKey,
		body: `{"action":"force-terminate","reason":"over reach"}`})
	if resp10.StatusCode != 403 || codeOf(t, resp10, body10) != "FORBIDDEN_ROLE" {
		t.Fatalf("reader resolve = %d %q", resp10.StatusCode, body10)
	}
}

// ---- request identity ------------------------------------------------------------

func TestAPI_RequestIDEcho(t *testing.T) {
	resetDB(t)
	_, ts := newTestServer(t)

	// Client-provided id is echoed and used as the problem trace_id.
	resp, body := do(t, ts, call{method: "GET", path: "/v1/workflows/nope", key: rdKey,
		hdr: map[string]string{"X-Request-Id": "client-supplied-id-123"}})
	if rid := resp.Header.Get("X-Request-Id"); rid != "client-supplied-id-123" {
		t.Fatalf("echo = %q", rid)
	}
	p := problemOf(t, resp, body)
	if p["trace_id"] != "client-supplied-id-123" {
		t.Fatalf("trace_id = %v, want echoed request id", p["trace_id"])
	}
	// Absent id: server mints a uuidv7.
	resp2, _ := do(t, ts, call{method: "GET", path: "/v1/workflows", key: rdKey})
	rid := resp2.Header.Get("X-Request-Id")
	if len(rid) != 36 || rid[14] != '7' {
		t.Fatalf("minted request id %q is not uuidv7", rid)
	}
}
