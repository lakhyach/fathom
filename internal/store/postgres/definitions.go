package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/lakhyach/fathom/internal/engine"
)

// Workflow definitions (DATA §A.1, SM §1). The definition table is the only
// sanctioned source of step declarations: the API creates instances from a
// registered definition (steps pinned into def_snapshot at creation), never
// from a client-supplied ad-hoc step list. A definition is immutable once
// created — instances reason against their snapshot forever, so re-defining a
// used (name, version) would split the meaning of "definition version".

// Definition is one registered workflow definition.
type Definition struct {
	Name      string
	Version   int
	Steps     []engine.StepSpec
	StepsJSON []byte // stored form, re-served verbatim by the API
	Status    string // ACTIVE | RETIRED
	CreatedAt time.Time
}

// wireDefStep is the stored JSON shape of one definition step — SM §1's
// vocabulary reduced to what the machine reasons about. `task` is the step
// type itself for forward execution (the worker's task router maps it);
// compensator_task names the reverse edge's task when the rollback lives in a
// different participant (SM §1 compensator{task}).
type wireDefStep struct {
	Type               string `json:"type"`
	MaxAttempts        *int   `json:"max_attempts,omitempty"`
	Compensable        bool   `json:"compensable,omitempty"`
	CompensatorTask    string `json:"compensator_task,omitempty"`
	ForwardTimeoutSecs *int   `json:"forward_timeout_secs,omitempty"`
}

const (
	maxDefSteps        = 64
	maxDefAttempts     = 100
	maxDefTimeoutSecs  = 86400 // 24h ceiling; SM §8 default forward timeout is 60s
	defaultForwardSecs = 60
	defaultMaxAttempts = 1
)

// DefinitionConflictError reports a (name, version) that is already defined.
// Re-definition is refused outright (immutability above); the API renders 409.
type DefinitionConflictError struct {
	Name    string
	Version int
}

func (e DefinitionConflictError) Error() string {
	return fmt.Sprintf("store: definition %s@%d already exists", e.Name, e.Version)
}

// DefinitionError reports an invalid step list; the message names the exact
// rule so an operator can fix the document (never a bare 500 — DS-13).
type DefinitionError struct{ Reason string }

func (e DefinitionError) Error() string { return "store: invalid definition: " + e.Reason }

// DefinitionNotFoundError reports an absent (name[, version]) — the API
// renders 404. Distinct from DefinitionError (client's document was invalid).
type DefinitionNotFoundError struct {
	Name    string
	Version int // 0 => "any version" was sought
}

func (e DefinitionNotFoundError) Error() string {
	if e.Version == 0 {
		return fmt.Sprintf("store: no definition for %q", e.Name)
	}
	return fmt.Sprintf("store: definition %s@%d not found", e.Name, e.Version)
}

// ParseDefinitionSteps decodes and validates the stored step JSON. Exported
// behaviour used by RegisterDefinition and (via it) the API create path, so
// one rule set governs every definition that can reach the engine.
func ParseDefinitionSteps(raw []byte) ([]engine.StepSpec, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields() // a typo'd field must fail loudly, not default silently
	var steps []wireDefStep
	if err := dec.Decode(&steps); err != nil {
		return nil, DefinitionError{Reason: "steps JSON: " + err.Error()}
	}
	if len(steps) == 0 {
		return nil, DefinitionError{Reason: "at least one step required"}
	}
	if len(steps) > maxDefSteps {
		return nil, DefinitionError{Reason: fmt.Sprintf("more than %d steps", maxDefSteps)}
	}
	seen := map[string]bool{}
	out := make([]engine.StepSpec, 0, len(steps))
	for i, w := range steps {
		if w.Type == "" {
			return nil, DefinitionError{Reason: fmt.Sprintf("step %d: empty type", i)}
		}
		if seen[w.Type] {
			return nil, DefinitionError{Reason: fmt.Sprintf("duplicate step type %q", w.Type)}
		}
		seen[w.Type] = true
		sp := engine.StepSpec{Type: w.Type, Compensable: w.Compensable, CompensatorTask: w.CompensatorTask}
		max := defaultMaxAttempts
		if w.MaxAttempts != nil {
			max = *w.MaxAttempts
		}
		if max < 1 || max > maxDefAttempts {
			return nil, DefinitionError{Reason: fmt.Sprintf("step %q: max_attempts %d outside [1,%d]", w.Type, max, maxDefAttempts)}
		}
		sp.MaxAttempts = max
		tsecs := defaultForwardSecs
		if w.ForwardTimeoutSecs != nil {
			tsecs = *w.ForwardTimeoutSecs
		}
		if tsecs < 1 || tsecs > maxDefTimeoutSecs {
			return nil, DefinitionError{Reason: fmt.Sprintf("step %q: forward_timeout_secs %d outside [1,%d]", w.Type, tsecs, maxDefTimeoutSecs)}
		}
		sp.ForwardTimeout = time.Duration(tsecs) * time.Second
		if sp.CompensatorTask != "" && !sp.Compensable {
			return nil, DefinitionError{Reason: fmt.Sprintf("step %q: compensator_task without compensable", w.Type)}
		}
		out = append(out, sp)
	}
	return out, nil
}

// RegisterDefinition stores one immutable versioned definition. Re-registering
// the same (name, version) is a typed conflict regardless of content.
func (s *Store) RegisterDefinition(ctx context.Context, name string, version int, stepsJSON []byte) (Definition, error) {
	if name == "" || version < 1 {
		return Definition{}, DefinitionError{Reason: "name and version >= 1 required"}
	}
	specs, err := ParseDefinitionSteps(stepsJSON)
	if err != nil {
		return Definition{}, err
	}
	tag, err := s.pool.Exec(ctx,
		`INSERT INTO workflow_definition (name, version, steps, status, created_at)
		 VALUES ($1,$2,$3::jsonb,'ACTIVE', now())
		 ON CONFLICT (name, version) DO NOTHING`,
		name, version, string(stepsJSON))
	if err != nil {
		return Definition{}, mapQueryErr(err, "register definition")
	}
	if tag.RowsAffected() == 0 {
		return Definition{}, DefinitionConflictError{Name: name, Version: version}
	}
	return Definition{Name: name, Version: version, Steps: specs, StepsJSON: stepsJSON, Status: "ACTIVE"}, nil
}

// RetireDefinition marks a definition version RETIRED: it stays queryable for
// running instances' provenance but GetActiveDefinition skips it, so new
// creates resolve to a later version. (Definitions never delete — instances
// pin them forever.)
func (s *Store) RetireDefinition(ctx context.Context, name string, version int) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE workflow_definition SET status = 'RETIRED' WHERE name = $1 AND version = $2`,
		name, version)
	if err != nil {
		return mapQueryErr(err, "retire definition")
	}
	if tag.RowsAffected() != 1 {
		return DefinitionError{Reason: fmt.Sprintf("definition %s@%d does not exist", name, version)}
	}
	return nil
}

// GetActiveDefinition returns the highest-version ACTIVE definition for a
// name — what POST /workflows resolves. NotFoundError when none exists.
func (s *Store) GetActiveDefinition(ctx context.Context, name string) (Definition, error) {
	return s.scanDefinition(ctx,
		`SELECT name, version, steps, status, created_at FROM workflow_definition
		  WHERE name = $1 AND status = 'ACTIVE' ORDER BY version DESC LIMIT 1`, name)
}

// GetDefinition returns one exact (name, version), ACTIVE or RETIRED.
func (s *Store) GetDefinition(ctx context.Context, name string, version int) (Definition, error) {
	return s.scanDefinition(ctx,
		`SELECT name, version, steps, status, created_at FROM workflow_definition
		  WHERE name = $1 AND version = $2`, name, version)
}

func (s *Store) scanDefinition(ctx context.Context, q string, args ...any) (Definition, error) {
	var d Definition
	err := s.pool.QueryRow(ctx, q, args...).
		Scan(&d.Name, &d.Version, &d.StepsJSON, &d.Status, &d.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		var wantName string
		if len(args) > 0 {
			if n, ok := args[0].(string); ok {
				wantName = n
			}
		}
		version := 0
		if len(args) > 1 {
			if v, ok := args[1].(int); ok {
				version = v
			}
		}
		return Definition{}, DefinitionNotFoundError{Name: wantName, Version: version}
	}
	if err != nil {
		return Definition{}, mapQueryErr(err, "load definition")
	}
	specs, err := ParseDefinitionSteps(d.StepsJSON)
	if err != nil {
		// A stored definition that no longer parses is a integrity fault, not
		// a client error: surface it honestly (DS-13).
		return Definition{}, fmt.Errorf("store: stored definition %s@%d is corrupt: %w", d.Name, d.Version, err)
	}
	d.Steps = specs
	return d, nil
}

// ListDefinitions returns every version of a name (or all definitions when
// name is ""), newest version first — the operator inventory view.
func (s *Store) ListDefinitions(ctx context.Context, name string) ([]Definition, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT name, version, steps, status, created_at FROM workflow_definition
		  WHERE ($1::text IS NULL OR name = $1)
		  ORDER BY name, version DESC`, nullStr(name))
	if err != nil {
		return nil, mapQueryErr(err, "list definitions")
	}
	defer rows.Close()
	var out []Definition
	for rows.Next() {
		var d Definition
		if err := rows.Scan(&d.Name, &d.Version, &d.StepsJSON, &d.Status, &d.CreatedAt); err != nil {
			return nil, mapQueryErr(err, "scan definition")
		}
		specs, err := ParseDefinitionSteps(d.StepsJSON)
		if err != nil {
			return nil, fmt.Errorf("store: stored definition %s@%d is corrupt: %w", d.Name, d.Version, err)
		}
		d.Steps = specs
		out = append(out, d)
	}
	return out, rows.Err()
}
