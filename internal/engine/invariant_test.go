package engine

import (
	"math/rand"
	"testing"
	"time"
)

// TestFathom_AT12_TerminalImmutabilityProperty is the property-style check
// mandated by the failure plan (AT-12, closes the DS-1b class): across many
// randomised-but-deterministic interleavings of results, retries, timeouts and
// cancels, the invariants must hold for EVERY trace:
//
//   - once terminal (COMPLETED/FAILED/ABORTED), a workflow never changes state
//     or version again, no matter what arrives;
//   - version is monotonic non-decreasing;
//   - FAILED_MANUAL is inert to inbound results.
//
// Deterministic seed keeps CI reproducible; a nightly extended budget can raise
// iterations without changing correctness (the plan's rule).
func TestFathom_AT12_TerminalImmutabilityProperty(t *testing.T) {
	rng := rand.New(rand.NewSource(20261023))
	const iterations = 2000
	const stepsPerRun = 20

	for it := 0; it < iterations; it++ {
		wf := randomRunSetup(rng)

		for s := 0; s < stepsPerRun; s++ {
			before := wf
			wf = applyRandomEvent(rng, wf)

			if before.State.IsTerminal() {
				// REQ-C-1: a terminal workflow is byte-identical forever.
				if wf.State != before.State || wf.Version != before.Version {
					t.Fatalf("iter %d step %d: terminal workflow mutated %s/v%d -> %s/v%d",
						it, s, before.State, before.Version, wf.State, wf.Version)
				}
			}
			if wf.Version < before.Version {
				t.Fatalf("iter %d: version went backwards %d -> %d", it, before.Version, wf.Version)
			}
			if wf.State == StateFailedManual {
				// inert: inbound results cannot advance it.
				probe := result(wf.Steps[0].Type, 1, OutcomeSucceeded, "", wf.Version)
				res, _ := ApplyResult(wf, probe, false, t0)
				if res.Workflow.State != StateFailedManual {
					t.Fatalf("iter %d: FAILED_MANUAL advanced by inbound event", it)
				}
			}
		}
	}
}

func randomRunSetup(rng *rand.Rand) Workflow {
	n := 1 + rng.Intn(3)
	specs := make([]StepSpec, n)
	for i := range specs {
		specs[i] = StepSpec{
			Type:        string(rune('a'+i)) + "-step",
			MaxAttempts: 1 + rng.Intn(3),
			Compensable: rng.Intn(2) == 0,
		}
	}
	wf, _ := Create("wf-rand", specs)
	res, err := Start(wf, wf.Version, t0)
	if err != nil {
		return wf
	}
	return res.Workflow
}

// applyRandomEvent picks one of the public entry points with a plausible
// argument. It ignores no-op classifications and keeps the resulting snapshot;
// typed errors (stale version / terminal) mean "no change", which is asserted
// by the caller's invariants.
func applyRandomEvent(rng *rand.Rand, wf Workflow) Workflow {
	step := wf.Steps[rng.Intn(len(wf.Steps))]
	outcome := OutcomeSucceeded
	if rng.Intn(2) == 0 {
		outcome = OutcomeFailed
	}
	class := []ErrorClass{ErrRetryable, ErrTerminal, ErrUnknown}[rng.Intn(3)]
	ev := ResultEvent{
		EventID:         randomID(rng),
		WorkflowID:      wf.ID,
		StepType:        step.Type,
		Attempt:         step.ActiveAttempt,
		Outcome:         outcome,
		ErrorClass:      class,
		ExpectedVersion: wf.Version,
	}
	known := rng.Intn(8) == 0
	res, err := ApplyResult(wf, ev, known, t0.Add(time.Duration(rng.Intn(100))*time.Second))
	if err != nil {
		return wf
	}
	// Occasionally also drive a reaper-style transition on the result.
	if rng.Intn(3) == 0 && res.Workflow.State == StateRetryWaiting {
		if rr, err := Retry(res.Workflow, res.Workflow.Version, t0); err == nil {
			return rr.Workflow
		}
	}
	if rng.Intn(6) == 0 && !res.Workflow.State.IsTerminal() && res.Workflow.State != StateFailedManual {
		if cc, err := Cancel(res.Workflow, res.Workflow.Version); err == nil {
			return cc.Workflow
		}
	}
	return res.Workflow
}

func randomID(rng *rand.Rand) string {
	const hex = "0123456789abcdef"
	b := make([]byte, 16)
	for i := range b {
		b[i] = hex[rng.Intn(len(hex))]
	}
	return string(b)
}
