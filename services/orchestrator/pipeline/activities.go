package pipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.temporal.io/sdk/temporal"
)

// Activity names of the orchestrator's own activities, run on TaskQueue.
const (
	RecordDecisionActivity = "RecordDecision"
	ResolveRouteActivity   = "ResolveRoute"
	// OpenSessionActivity and CompleteSessionActivity serve interactive steps.
	OpenSessionActivity     = "OpenSession"
	CompleteSessionActivity = "CompleteSession"
	// FinishRunActivity completes the metadata of a top-level run.
	FinishRunActivity = "FinishRun"
)

// Run statuses recorded in a run's metadata.
const (
	RunCompleted = "completed"
	RunFailed    = "failed"
	RunCancelled = "cancelled"
)

// MetadataFile is the name of a run's metadata object under its run prefix.
const MetadataFile = "metadata.json"

// FinishRunRequest names the metadata of a run and how the run ended.
type FinishRunRequest struct {
	TraceID  string `json:"trace_id"`
	Metadata string `json:"metadata"`
	Status   string `json:"status"`
	Error    string `json:"error,omitempty"`
}

// FinishRun adds finished, status, and, for a run that did not complete, error to the run's
// metadata. It keeps every other field. A run without metadata, or with metadata that is
// already finished, is left as it is.
func (a *Activities) FinishRun(ctx context.Context, req FinishRunRequest) error {
	data, err := a.Store.Get(ctx, req.Metadata)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reading %q: %w", req.Metadata, err)
	}
	fields := map[string]json.RawMessage{}
	if err = json.Unmarshal(data, &fields); err != nil {
		return temporal.NewNonRetryableApplicationError(fmt.Sprintf("%q is not a JSON object", req.Metadata), "InvalidMetadata", err)
	}
	if _, done := fields["finished"]; done {
		return nil
	}
	fields["finished"], _ = json.Marshal(time.Now().UTC().Format(time.RFC3339))
	fields["status"], _ = json.Marshal(req.Status)
	delete(fields, "error")
	if req.Error != "" {
		fields["error"], _ = json.Marshal(req.Error)
	}
	if data, err = json.MarshalIndent(fields, "", "  "); err != nil {
		return err
	}
	if err = a.Store.Put(ctx, req.Metadata, data, Meta{Creator: sessionCreator, TraceID: req.TraceID}); err != nil {
		return fmt.Errorf("writing %q: %w", req.Metadata, err)
	}
	return nil
}

// Activities are the orchestrator's own Temporal activities: they store gate
// decisions, resolve route steps against the current configuration, and open
// and complete the sessions of interactive steps.
type Activities struct {
	Store Store
	// LoadDefinitions returns every stored version of the configured workflows.
	LoadDefinitions func() ([]Definition, error)
	// DescribeAgent returns the description of a pinned agent for team.json, or "" when it
	// is not known. It may be nil.
	DescribeAgent func(ctx context.Context, ref string) string
}

// DecisionRecord is stored as the artifact of a gate step.
type DecisionRecord struct {
	TraceID   string    `json:"trace_id"`
	Workflow  string    `json:"workflow"`
	Step      string    `json:"step"`
	Question  string    `json:"question,omitempty"`
	Inputs    []Item    `json:"inputs"`
	Decision  string    `json:"decision"`
	Comment   string    `json:"comment,omitempty"`
	DecidedBy string    `json:"decided_by"`
	DecidedAt time.Time `json:"decided_at"`
	Artifact  string    `json:"artifact"`
	// OnReject and Round are set for a gate with on_reject: the team step a rejection goes
	// back to and the review round this decision belongs to.
	OnReject string `json:"on_reject,omitempty"`
	Round    int    `json:"round,omitempty"`
}

// RecordDecision stores a gate decision as the gate step's artifact, with
// the person who decided as its creator.
func (a *Activities) RecordDecision(ctx context.Context, rec DecisionRecord) (StepResult, error) {
	if rec.DecidedAt.IsZero() {
		rec.DecidedAt = time.Now().UTC()
	}
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return StepResult{}, err
	}
	if err = a.Store.Put(ctx, rec.Artifact, data, Meta{Creator: rec.DecidedBy, TraceID: rec.TraceID}); err != nil {
		return StepResult{}, fmt.Errorf("writing artifact %q: %w", rec.Artifact, err)
	}
	return StepResult{Artifact: rec.Artifact}, nil
}

// RouteRequest holds the inputs of a route step. One of their artifacts has the "route"
// field that selects a workflow.
type RouteRequest struct {
	Inputs []Item `json:"inputs"`
}

// RouteResult is the configured workflow a route step starts and the item
// that named it, which becomes the input of the routed workflow.
type RouteResult struct {
	Definition Definition `json:"definition"`
	Inputs     []Item     `json:"inputs"`
}

// ResolveRoute reads the route field of a JSON artifact and returns the
// configured workflow of that name: its newest version, or the version the
// route pins, such as feature@v2. A gate's decision record has no route of
// its own; the route is then taken from the step outputs the gate confirmed.
func (a *Activities) ResolveRoute(ctx context.Context, req RouteRequest) (RouteResult, error) {
	invalid := func(cause error) error {
		artifact := ""
		if len(req.Inputs) > 0 {
			artifact = req.Inputs[0].Artifact
		}
		return temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("artifact %q must be a JSON object with a non-empty route field", artifact), "InvalidRoute", cause)
	}
	route := ""
	var source Item
	for _, item := range req.Inputs {
		data, err := a.Store.Get(ctx, item.Artifact)
		if err != nil {
			return RouteResult{}, fmt.Errorf("reading artifact %q: %w", item.Artifact, err)
		}
		var record struct {
			Route  string `json:"route"`
			Inputs []Item `json:"inputs"`
		}
		if err = json.Unmarshal(unfence(data), &record); err != nil {
			return RouteResult{}, invalid(err)
		}
		if record.Route != "" {
			route, source = record.Route, item
			break
		}
		for _, confirmed := range record.Inputs {
			if confirmed.Source == InputSource {
				continue
			}
			inner, err := a.Store.Get(ctx, confirmed.Artifact)
			if err != nil {
				return RouteResult{}, fmt.Errorf("reading artifact %q: %w", confirmed.Artifact, err)
			}
			var candidate struct {
				Route string `json:"route"`
			}
			if json.Unmarshal(unfence(inner), &candidate) == nil && candidate.Route != "" {
				route, source = candidate.Route, confirmed
				break
			}
		}
		if route != "" {
			break
		}
	}
	if route == "" {
		return RouteResult{}, invalid(nil)
	}
	definitions, err := a.LoadDefinitions()
	if err != nil {
		return RouteResult{}, err
	}
	// The route names a workflow, or a pinned version such as feature@v2.
	if d, ok := FindDefinition(definitions, route); ok {
		return RouteResult{Definition: d, Inputs: []Item{source}}, nil
	}
	return RouteResult{}, temporal.NewNonRetryableApplicationError(
		fmt.Sprintf("route %q is not a configured workflow", route), "UnknownRoute", nil)
}

// sessionCreator is recorded as the creator of the input files an opened session receives.
const sessionCreator = "orchestrator"

// OpenSessionRequest names the session of an interactive step and the artifacts it starts with.
type OpenSessionRequest struct {
	TraceID string `json:"trace_id"`
	Session string `json:"session"`
	Inputs  []Item `json:"inputs"`
}

// inputFile names the file the i-th input is copied to: input-<source>, with the round
// when the source appears more than once in the list, and .json when the content is valid
// JSON, else .md.
func inputFile(items []Item, i int, data []byte) string {
	name := "input-" + strings.ReplaceAll(items[i].Source, "/", "-")
	for j, other := range items {
		if j != i && other.Source == items[i].Source {
			name += fmt.Sprintf("-%d", items[i].Round)
			break
		}
	}
	if json.Valid(bytes.TrimSpace(data)) {
		return name + ".json"
	}
	return name + ".md"
}

// OpenSessionResult lists the session files the inputs were copied to.
type OpenSessionResult struct {
	Files []string `json:"files"`
}

// OpenSession copies every input artifact of an interactive step into the session as
// files/input-<source>.md, or .json when the content is valid JSON, in the order of the inputs.
func (a *Activities) OpenSession(ctx context.Context, req OpenSessionRequest) (OpenSessionResult, error) {
	// A session that is opened again, because its step runs again after a rejection, is no
	// longer completed. On a first opening there is no completion record to remove.
	if remover, ok := a.Store.(interface {
		Delete(ctx context.Context, id string) error
	}); ok {
		if err := remover.Delete(ctx, req.Session+"/completed.json"); err != nil && !errors.Is(err, ErrNotFound) {
			return OpenSessionResult{Files: []string{}}, fmt.Errorf("removing %s/completed.json: %w", req.Session, err)
		}
	}
	res := OpenSessionResult{Files: []string{}}
	for i, item := range req.Inputs {
		data, err := a.Store.Get(ctx, item.Artifact)
		if err != nil {
			return res, fmt.Errorf("reading artifact %q: %w", item.Artifact, err)
		}
		name := inputFile(req.Inputs, i, data)
		id := req.Session + "/files/" + name
		if err = a.Store.Put(ctx, id, data, Meta{Creator: sessionCreator, TraceID: req.TraceID}); err != nil {
			return res, fmt.Errorf("writing session file %q: %w", id, err)
		}
		res.Files = append(res.Files, name)
	}
	return res, nil
}

// CompleteSessionRequest names the session file that becomes the output of an interactive step.
type CompleteSessionRequest struct {
	TraceID     string `json:"trace_id"`
	Workflow    string `json:"workflow"`
	Step        string `json:"step"`
	Session     string `json:"session"`
	File        string `json:"file"`
	CompletedBy string `json:"completed_by"`
	Artifact    string `json:"artifact"`
}

// CompletionRecord is stored as <session>/completed.json; its presence closes the session.
type CompletionRecord struct {
	File        string    `json:"file"`
	CompletedBy string    `json:"completed_by"`
	CompletedAt time.Time `json:"completed_at"`
	Artifact    string    `json:"artifact"`
}

// CompleteSession copies the chosen session file to the step's output artifact, with the
// person who completed the session as its creator, and then writes the completion record.
func (a *Activities) CompleteSession(ctx context.Context, req CompleteSessionRequest) (StepResult, error) {
	if !SessionFilePattern.MatchString(req.File) {
		return StepResult{}, temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("%q is not a session file name", req.File), "InvalidSessionFile", nil)
	}
	source := req.Session + "/files/" + req.File
	data, err := a.Store.Get(ctx, source)
	if errors.Is(err, ErrNotFound) {
		return StepResult{}, temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("session file %q does not exist", source), "MissingSessionFile", err)
	}
	if err != nil {
		return StepResult{}, fmt.Errorf("reading session file %q: %w", source, err)
	}
	meta := Meta{Creator: req.CompletedBy, TraceID: req.TraceID}
	if err = a.Store.Put(ctx, req.Artifact, data, meta); err != nil {
		return StepResult{}, fmt.Errorf("writing artifact %q: %w", req.Artifact, err)
	}
	record, err := json.MarshalIndent(CompletionRecord{
		File: req.File, CompletedBy: req.CompletedBy, CompletedAt: time.Now().UTC(), Artifact: req.Artifact,
	}, "", "  ")
	if err != nil {
		return StepResult{}, err
	}
	if err = a.Store.Put(ctx, req.Session+"/completed.json", record, meta); err != nil {
		return StepResult{}, fmt.Errorf("writing completion record of %q: %w", req.Session, err)
	}
	return StepResult{Artifact: req.Artifact}, nil
}

// unfence strips a surrounding Markdown code fence, which models often add
// around JSON, so the content inside can be parsed.
func unfence(data []byte) []byte {
	s := strings.TrimSpace(string(data))
	if !strings.HasPrefix(s, "```") {
		return data
	}
	s = strings.TrimPrefix(s, "```")
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[i+1:] // drop the language tag line
	}
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(s, "```")
	return []byte(strings.TrimSpace(s))
}
