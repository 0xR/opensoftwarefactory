// Package pipeline contains the Temporal workflow that executes configured
// workflow graphs and the helpers that services use to implement steps.
package pipeline

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// TaskQueue is the queue the orchestrator's own Temporal worker polls.
const TaskQueue = "orchestrator"

// WorkflowName is the registered Temporal workflow type.
const WorkflowName = "Pipeline"

// DefaultActivity is the activity type a step calls when none is configured.
const DefaultActivity = "Process"

// InputSource is the source of the item that refers to the run's input document.
const InputSource = "input"

// Services the orchestrator treats specially.
const (
	// AgentService is the task queue of the agent service; its steps name a pinned agent.
	AgentService = "agent"
	// GateService marks a step the orchestrator holds until a person records a decision.
	GateService = "gate"
	// RouteService marks a step that starts the workflow named in its input artifact.
	RouteService = "route"
	// InteractiveService marks a step the orchestrator holds while a person works with its
	// agents in a chat session, until a Completion names the session file that is its output.
	InteractiveService = "interactive"
)

// DecisionSignal is the Temporal signal that delivers a Decision to a gate step.
const DecisionSignal = "decision"

// CompleteSignal is the Temporal signal that delivers a Completion to an interactive step.
const CompleteSignal = "complete"

// PendingQuery is the Temporal query that returns the gate steps waiting for a decision and
// the interactive steps waiting for their session to be completed.
const PendingQuery = "pending"

// Step is one node of a configured workflow graph.
type Step struct {
	ID       string   `yaml:"id" json:"id"`
	Service  string   `yaml:"service" json:"service"`
	Activity string   `yaml:"activity,omitempty" json:"activity,omitempty"`
	Agent    string   `yaml:"agent,omitempty" json:"agent,omitempty"`
	Agents   []string `yaml:"agents,omitempty" json:"agents,omitempty"`
	Question string   `yaml:"question,omitempty" json:"question,omitempty"`
	// Workflow names the workflow version a workflow step runs as a child run, such as build@v2.
	Workflow string `yaml:"workflow,omitempty" json:"workflow,omitempty"`
	// Workflows, Channels, and MaxTurns configure a team step; Agent is its lead agent and
	// Agents are its other agent members. Workflows names pinned versions, such as docs@v1.
	Workflows []string   `yaml:"workflows,omitempty" json:"workflows,omitempty"`
	Channels  [][]string `yaml:"channels,omitempty" json:"channels,omitempty"`
	MaxTurns  int        `yaml:"max_turns,omitempty" json:"max_turns,omitempty"`
	// MemberPositions keeps where the editor shows the members of a team step, by member name:
	// x in percent of the panel width, y in pixels. It has no effect on a run.
	MemberPositions map[string]Point `yaml:"member_positions,omitempty" json:"member_positions,omitempty"`
	// OnReject names the team step a gate sends its rejections back to.
	OnReject    string   `yaml:"on_reject,omitempty" json:"on_reject,omitempty"`
	DependsOn   []string `yaml:"depends_on,omitempty" json:"depends_on,omitempty"`
	Timeout     string   `yaml:"timeout,omitempty" json:"timeout,omitempty"`
	MaxAttempts int32    `yaml:"max_attempts,omitempty" json:"max_attempts,omitempty"`
	// Capacity, Size, and InputTimeout configure merge and batch steps: the waiting entries a
	// merge may hold, the items a batch collects, and the seconds either waits for input.
	Capacity     int    `yaml:"capacity,omitempty" json:"capacity,omitempty"`
	Size         int    `yaml:"size,omitempty" json:"size,omitempty"`
	InputTimeout int    `yaml:"input_timeout,omitempty" json:"input_timeout,omitempty"`
	Position     *Point `yaml:"position,omitempty" json:"position,omitempty"`
}

// Point is a step's position in the graphical editor.
type Point struct {
	X float64 `yaml:"x" json:"x"`
	Y float64 `yaml:"y" json:"y"`
}

// Definition is one version of a named workflow graph. The orchestrator sets Version,
// Created, and CreatedBy when it stores the version; a stored version never changes.
type Definition struct {
	Name        string `yaml:"name" json:"name"`
	Version     int    `yaml:"version,omitempty" json:"version"`
	Description string `yaml:"description,omitempty" json:"description,omitempty"`
	// Created is the RFC 3339 time the version was stored.
	Created   string `yaml:"created,omitempty" json:"created,omitempty"`
	CreatedBy string `yaml:"created_by,omitempty" json:"created_by,omitempty"`
	Steps     []Step `yaml:"steps" json:"steps"`
}

// Input starts a pipeline run. The definition is a snapshot so later
// configuration edits never affect a running workflow. Inputs is what the
// steps without dependencies receive: for a top-level run the item of the
// run input, with InputSource as its source. Prefix is the artifact prefix
// of this run's steps; it defaults to RunPrefix(TraceID).
type Input struct {
	TraceID    string     `json:"trace_id"`
	Definition Definition `json:"definition"`
	Inputs     []Item     `json:"inputs"`
	Prefix     string     `json:"prefix,omitempty"`
	// Depth counts the workflow steps and team members above this run; a top-level run has 0.
	Depth int `json:"depth,omitempty"`
	// Run changes whenever the step that started this run runs again after a rejection, so
	// the teams inside can tell that from a retry.
	Run string `json:"run,omitempty"`
}

// Result maps every step ID to the artifact it produced. Steps of a routed
// workflow appear as "<route step>/<step>". For a step after a merge or batch
// it holds the artifact of the newest pass. Final holds every item the single
// final step of the definition produced, in order.
type Result struct {
	TraceID   string            `json:"trace_id"`
	Artifacts map[string]string `json:"artifacts"`
	Final     []Item            `json:"final,omitempty"`
}

// StepRequest is the activity input every service receives.
type StepRequest struct {
	TraceID        string `json:"trace_id"`
	Workflow       string `json:"workflow"`
	StepID         string `json:"step_id"`
	Agent          string `json:"agent,omitempty"`
	Inputs         []Item `json:"inputs"`
	OutputArtifact string `json:"output_artifact"`
}

// StepResult is the activity output every service returns: the artifact the step wrote. The
// pipeline turns it into the step's item.
type StepResult struct {
	Artifact string `json:"artifact"`
}

// items returns the result as a list: one item, or none when the step named no artifact.
func (r StepResult) items() []Item {
	if r.Artifact == "" {
		return nil
	}
	return []Item{{Artifact: r.Artifact}}
}

// Decision is what a person sends to a waiting gate step.
type Decision struct {
	Step      string `json:"step"`
	Decision  string `json:"decision"`
	Comment   string `json:"comment,omitempty"`
	DecidedBy string `json:"decided_by"`
}

// Decision values.
const (
	Approved = "approved"
	Rejected = "rejected"
)

// PendingGate describes a gate step that waits for a decision.
type PendingGate struct {
	Step     string `json:"step"`
	Question string `json:"question,omitempty"`
	Inputs   []Item `json:"inputs"`
	Artifact string `json:"artifact"`
	// OnReject is the team step a rejection goes back to, empty for a plain gate. Round is 1
	// for the first review and grows with every rejection sent back.
	OnReject string `json:"on_reject"`
	Round    int    `json:"round"`
	// Pass is the pass of a gate that runs after a merge or batch.
	Pass int `json:"pass,omitempty"`
}

// PendingSession describes an interactive step whose chat session waits to be completed.
// Agents lists the main agent first, then the step's other agents. Session is the blob
// prefix of the session's files and chats.
type PendingSession struct {
	Step     string   `json:"step"`
	Agent    string   `json:"agent"`
	Agents   []string `json:"agents"`
	Inputs   []Item   `json:"inputs"`
	Artifact string   `json:"artifact"`
	Session  string   `json:"session"`
	// Pass is the pass of a session that runs after a merge or batch.
	Pass int `json:"pass,omitempty"`
}

// Completion is what a person sends to a waiting interactive step: the session file that
// becomes the step's output.
type Completion struct {
	Step        string `json:"step"`
	File        string `json:"file"`
	CompletedBy string `json:"completed_by"`
}

// SessionFilePattern matches the name of a file in a session's files folder.
var SessionFilePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.(md|txt|json)$`)

// PendingState answers PendingQuery.
type PendingState struct {
	TraceID  string           `json:"trace_id"`
	Workflow string           `json:"workflow"`
	Gates    []PendingGate    `json:"gates"`
	Sessions []PendingSession `json:"sessions"`
	Teams    []PendingTeam    `json:"teams"`
}

// RunPrefix is the artifact prefix of a top-level run.
func RunPrefix(traceID string) string {
	return "runs/" + traceID
}

// ArtifactID names the blob for a step output under a run prefix, or the
// run input when step is InputSource.
func ArtifactID(prefix, step string) string {
	return prefix + "/" + step
}

// SessionPath names the blob prefix of an interactive step's session: "user-sessions/", the
// run prefix without its leading "runs/", and the step ID.
func SessionPath(prefix, step string) string {
	return "user-sessions/" + strings.TrimPrefix(prefix, "runs/") + "/" + step
}

// SessionAgents returns the agents of an interactive step: the main agent first, then the
// others, without duplicates.
func (s Step) SessionAgents() []string {
	agents := []string{s.Agent}
	for _, a := range s.Agents {
		known := false
		for _, have := range agents {
			known = known || have == a
		}
		if !known {
			agents = append(agents, a)
		}
	}
	return agents
}

// StartToClose returns the step's activity timeout: two minutes for an agent step and ten
// minutes for other services unless the step sets one.
func (s Step) StartToClose() (time.Duration, error) {
	if s.Timeout == "" {
		if s.Service == "agent" {
			return 2 * time.Minute, nil
		}
		return 10 * time.Minute, nil
	}
	d, err := time.ParseDuration(s.Timeout)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("step %q: timeout must be a positive duration such as 30s or 10m", s.ID)
	}
	return d, nil
}

// Pipeline runs every step once all of its dependencies have finished,
// handing each step the items of its dependencies' outputs. Gate
// steps wait for a Decision signal, interactive steps wait for a Completion
// signal, and route steps start the workflow named in their input artifact as
// a child workflow. Merge and batch steps collect the results of their sources
// and forward them as one message; the steps after them run once per message.
// A top-level run records how it ended in its metadata.
func Pipeline(ctx workflow.Context, in Input) (Result, error) {
	res, err := runPipeline(ctx, in)
	if in.Depth == 0 {
		finishRun(ctx, in, err)
	}
	return res, err
}

// finishRun records the end of a top-level run in its metadata. It uses a disconnected
// context, so it also runs when the run was cancelled. A failure to record does not change
// the result of the run.
func finishRun(ctx workflow.Context, in Input, runErr error) {
	prefix := in.Prefix
	if prefix == "" {
		prefix = RunPrefix(in.TraceID)
	}
	req := FinishRunRequest{TraceID: in.TraceID, Metadata: ArtifactID(prefix, MetadataFile), Status: RunCompleted}
	if runErr != nil {
		req.Status, req.Error = RunFailed, runErr.Error()
		if temporal.IsCanceledError(runErr) || ctx.Err() != nil {
			req.Status = RunCancelled
		}
	}
	dctx, cancel := workflow.NewDisconnectedContext(ctx)
	defer cancel()
	dctx = workflow.WithActivityOptions(dctx, workflow.ActivityOptions{
		TaskQueue:           TaskQueue,
		StartToCloseTimeout: time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})
	if err := workflow.ExecuteActivity(dctx, FinishRunActivity, req).Get(dctx, nil); err != nil {
		workflow.GetLogger(ctx).Warn("recording the end of the run failed", "trace_id", in.TraceID, "error", err)
	}
}

// runPipeline executes the steps of the definition.
func runPipeline(ctx workflow.Context, in Input) (Result, error) {
	if err := Validate(in.Definition); err != nil {
		return Result{}, temporal.NewNonRetryableApplicationError(err.Error(), "InvalidDefinition", nil)
	}
	if in.Depth > MaxDepth {
		return Result{}, temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("workflow %q is nested deeper than %d levels", in.Definition.Name, MaxDepth), "NestingTooDeep", nil)
	}
	if in.Prefix == "" {
		in.Prefix = RunPrefix(in.TraceID)
	}
	ctx, cancel := workflow.WithCancel(ctx)
	defer cancel()
	res := Result{TraceID: in.TraceID, Artifacts: map[string]string{}}
	// outputs holds the items of every step that has finished its current run.
	outputs := map[string][]Item{}
	// final is the single final step of the definition; its items are the output of a nested run.
	final := ""
	if last := FinalSteps(in.Definition); len(last) == 1 {
		final = last[0]
	}
	// nodes are the merge and batch steps. A step after one of them runs once per message the
	// node forwards: passes counts those runs, and inPass tells a run of the current pass
	// from the first run of a new one.
	nodes := newNodes(in.Definition)
	passStep := map[string]bool{}
	for _, n := range nodes {
		for _, id := range n.segment {
			passStep[id] = true
		}
	}
	passes := map[string]int{}
	inPass := map[string]bool{}
	started := map[string]bool{}
	gates := map[string]PendingGate{}
	sessions := map[string]PendingSession{}
	completing := map[string]bool{}
	teams := map[string]PendingTeam{}
	// rounds counts the rejections a gate with on_reject has sent back; rejections holds the
	// rejection a team step receives when it runs again.
	rounds := map[string]int{}
	rejections := map[string]*TeamRejection{}
	// gen counts how often a step was reset by a rejection that went back to a team it depends
	// on. A step in flight at that time ends with a result of an old generation, which is
	// dropped, and the step then runs again. cancels stops the child workflows in flight.
	gen := map[string]int{}
	cancels := map[string]workflow.CancelFunc{}
	selector := workflow.NewSelector(ctx)
	var failure error
	pending := 0
	logger := workflow.GetLogger(ctx)

	// nameOf is the name under which the current run of a step stores its artifacts.
	nameOf := func(id string) string {
		if passStep[id] {
			return PassName(id, passes[id])
		}
		return id
	}
	// finish records the items a step produced and hands them to the merge and batch steps
	// that depend on it.
	finish := func(id string, items []Item) {
		outputs[id] = items
		if id == final {
			res.Final = append(res.Final, items...)
		}
		for _, n := range nodes {
			if !contains(n.step.DependsOn, id) {
				continue
			}
			if err := n.add(id, items, workflow.Now(ctx)); err != nil && failure == nil {
				failure = err
			}
		}
	}
	// deliver records the artifacts a step wrote as its output. The step is the source of its
	// items. Their round is the pass of a step after a merge or batch; otherwise it is the
	// round the step reported, or 1.
	deliver := func(id string, produced []Item) {
		if len(produced) == 0 {
			if failure == nil {
				failure = fmt.Errorf("step %q returned no output", id)
			}
			return
		}
		// The result names a step by its ID; for a step with passes it holds the newest pass.
		items := make([]Item, 0, len(produced))
		for i, item := range produced {
			key := id
			if i > 0 {
				key = fmt.Sprintf("%s.%d", id, i+1)
			}
			res.Artifacts[key] = item.Artifact
			round := max(item.Round, 1)
			if passStep[id] {
				round = passes[id]
			}
			items = append(items, Item{Source: id, Artifact: item.Artifact, Round: round})
		}
		finish(id, items)
	}
	// busy reports whether a step of the list is running or waits for a person.
	busy := func(steps []string) bool {
		for _, id := range steps {
			if _, finished := outputs[id]; started[id] && !finished {
				return true
			}
		}
		return false
	}

	if err := workflow.SetQueryHandler(ctx, NodesQuery, func() (map[string]any, error) {
		states := map[string]any{}
		for _, n := range nodes {
			states[n.step.ID] = n.state()
		}
		return states, nil
	}); err != nil {
		return res, err
	}
	if err := workflow.SetQueryHandler(ctx, PendingQuery, func() (PendingState, error) {
		state := PendingState{TraceID: in.TraceID, Workflow: in.Definition.Name, Gates: []PendingGate{}, Sessions: []PendingSession{}, Teams: []PendingTeam{}}
		for _, g := range gates {
			state.Gates = append(state.Gates, g)
		}
		sort.Slice(state.Gates, func(i, j int) bool { return state.Gates[i].Step < state.Gates[j].Step })
		for _, session := range sessions {
			state.Sessions = append(state.Sessions, session)
		}
		sort.Slice(state.Sessions, func(i, j int) bool { return state.Sessions[i].Step < state.Sessions[j].Step })
		for _, team := range teams {
			state.Teams = append(state.Teams, team)
		}
		sort.Slice(state.Teams, func(i, j int) bool { return state.Teams[i].Step < state.Teams[j].Step })
		return state, nil
	}); err != nil {
		return res, err
	}

	ownCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           TaskQueue,
		StartToCloseTimeout: time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})

	// A cancelled run ends even while it only waits for a person.
	selector.AddReceive(ctx.Done(), func(c workflow.ReceiveChannel, _ bool) {
		c.Receive(ctx, nil)
		if failure == nil {
			failure = ctx.Err()
		}
	})

	decisions := workflow.GetSignalChannel(ctx, DecisionSignal)
	selector.AddReceive(decisions, func(c workflow.ReceiveChannel, _ bool) {
		var d Decision
		c.Receive(ctx, &d)
		gate, ok := gates[d.Step]
		if !ok || (d.Decision != Approved && d.Decision != Rejected) || d.DecidedBy == "" {
			logger.Warn("ignoring decision without a waiting gate", "step", d.Step, "decision", d.Decision)
			return
		}
		if gate.OnReject != "" && d.Decision == Rejected && strings.TrimSpace(d.Comment) == "" {
			logger.Warn("ignoring rejection without a reason on a gate with on_reject", "step", d.Step)
			return
		}
		delete(gates, d.Step)
		record := DecisionRecord{
			TraceID: in.TraceID, Workflow: in.Definition.Name, Step: gate.Step, Question: gate.Question,
			Inputs: gate.Inputs, Decision: d.Decision, Comment: d.Comment, DecidedBy: d.DecidedBy, Artifact: gate.Artifact,
		}
		// A gate with on_reject sends a rejection back to its team and reopens; the record of
		// that round is kept beside the gate's artifact as <artifact>.<round>.
		sendBack := gate.OnReject != "" && d.Decision == Rejected && gate.Round < MaxRejections
		if gate.OnReject != "" {
			record.OnReject, record.Round = gate.OnReject, gate.Round
		}
		if sendBack {
			record.Artifact = fmt.Sprintf("%s.%d", gate.Artifact, gate.Round)
		}
		g := gen[gate.Step]
		selector.AddFuture(workflow.ExecuteActivity(ownCtx, RecordDecisionActivity, record), func(f workflow.Future) {
			pending--
			if gen[gate.Step] != g {
				started[gate.Step] = false
				return
			}
			var out StepResult
			if err := f.Get(ctx, &out); err != nil {
				if failure == nil {
					failure = fmt.Errorf("step %q failed: %w", gate.Step, err)
				}
				return
			}
			if d.Decision == Rejected {
				if sendBack {
					rounds[gate.Step] = gate.Round
					rejections[gate.OnReject] = &TeamRejection{Gate: gate.Step, Round: gate.Round, DecidedBy: d.DecidedBy, Reason: d.Comment}
					for id := range dependents(in.Definition, gate.OnReject) {
						gen[id]++
						if _, waiting := gates[id]; waiting {
							delete(gates, id)
							pending--
							started[id] = false
						}
						if _, open := sessions[id]; open && !completing[id] {
							delete(sessions, id)
							pending--
							started[id] = false
						}
						if cancelStep := cancels[id]; cancelStep != nil {
							cancelStep()
						}
						for key := range res.Artifacts {
							if key == id || strings.HasPrefix(key, id+"/") || strings.HasPrefix(key, id+".") {
								delete(res.Artifacts, key)
							}
						}
						if items, finished := outputs[id]; finished {
							if id == final {
								res.Final = res.Final[:len(res.Final)-len(items)]
							}
							delete(outputs, id)
							started[id] = false
						}
					}
					started[gate.Step] = false
					return
				}
				if failure == nil && gate.OnReject != "" {
					failure = fmt.Errorf("step %q rejected %d times, last by %s: %s", gate.Step, gate.Round, d.DecidedBy, d.Comment)
				}
				if failure == nil {
					failure = fmt.Errorf("step %q rejected by %s: %s", gate.Step, d.DecidedBy, d.Comment)
				}
				return
			}
			deliver(gate.Step, out.items())
		})
	})

	// A completion ends a waiting interactive step with the chosen session file as its
	// artifact. When storing it fails the step keeps waiting, so the person can try again.
	completions := workflow.GetSignalChannel(ctx, CompleteSignal)
	selector.AddReceive(completions, func(c workflow.ReceiveChannel, _ bool) {
		var done Completion
		c.Receive(ctx, &done)
		session, ok := sessions[done.Step]
		if !ok || completing[done.Step] || !SessionFilePattern.MatchString(done.File) || done.CompletedBy == "" {
			logger.Warn("ignoring completion without a waiting session", "step", done.Step, "file", done.File)
			return
		}
		completing[session.Step] = true
		g := gen[session.Step]
		request := CompleteSessionRequest{
			TraceID: in.TraceID, Workflow: in.Definition.Name, Step: session.Step, Session: session.Session,
			File: done.File, CompletedBy: done.CompletedBy, Artifact: session.Artifact,
		}
		selector.AddFuture(workflow.ExecuteActivity(ownCtx, CompleteSessionActivity, request), func(f workflow.Future) {
			delete(completing, session.Step)
			if gen[session.Step] != g {
				if _, open := sessions[session.Step]; open {
					delete(sessions, session.Step)
					pending--
					started[session.Step] = false
				}
				return
			}
			var out StepResult
			if err := f.Get(ctx, &out); err != nil {
				logger.Warn("completing the session failed; the step keeps waiting", "step", session.Step, "file", done.File, "error", err)
				return
			}
			pending--
			delete(sessions, session.Step)
			deliver(session.Step, out.items())
		})
	})

	for {
		if failure != nil {
			return res, failure
		}
		for _, s := range in.Definition.Steps {
			if s.IsNode() || started[s.ID] || !ready(s, outputs) {
				continue
			}
			started[s.ID] = true
			pending++
			if passStep[s.ID] && !inPass[s.ID] {
				passes[s.ID]++
				inPass[s.ID] = true
			}
			stepInputs := inputs(s, in.Inputs, outputs)
			g := gen[s.ID]
			run := fmt.Sprintf("%s/%d", in.Run, g)
			// name is the step ID, or <step>.pass-<n> for a step after a merge or batch.
			name := nameOf(s.ID)
			output := ArtifactID(in.Prefix, name)
			switch s.Service {
			case GateService:
				gates[s.ID] = PendingGate{
					Step: s.ID, Question: s.Question, Inputs: stepInputs, Artifact: output,
					OnReject: s.OnReject, Round: rounds[s.ID] + 1, Pass: passes[s.ID],
				}
				continue
			case InteractiveService:
				session := PendingSession{
					Step: s.ID, Agent: s.Agent, Agents: s.SessionAgents(), Inputs: stepInputs,
					Artifact: output, Session: SessionPath(in.Prefix, name), Pass: passes[s.ID],
				}
				open := OpenSessionRequest{TraceID: in.TraceID, Session: session.Session, Inputs: stepInputs}
				selector.AddFuture(workflow.ExecuteActivity(ownCtx, OpenSessionActivity, open), func(f workflow.Future) {
					if gen[session.Step] != g {
						pending--
						started[session.Step] = false
						return
					}
					if err := f.Get(ctx, nil); err != nil {
						pending--
						if failure == nil {
							failure = fmt.Errorf("step %q failed: %w", session.Step, err)
						}
						return
					}
					sessions[session.Step] = session
				})
				continue
			case RouteService:
				stepCtx, cancelStep := workflow.WithCancel(ctx)
				cancels[s.ID] = cancelStep
				selector.AddFuture(startRoute(stepCtx, ownCtx, in, name, stepInputs, run), func(f workflow.Future) {
					pending--
					delete(cancels, s.ID)
					cancelStep()
					if gen[s.ID] != g {
						started[s.ID] = false
						return
					}
					var child Result
					if err := f.Get(ctx, &child); err != nil {
						if failure == nil {
							failure = fmt.Errorf("step %q failed: %w", s.ID, err)
						}
						return
					}
					for id, artifact := range child.Artifacts {
						res.Artifacts[s.ID+"/"+id] = artifact
					}
					// Nothing depends on a route step; the empty output marks it as finished.
					outputs[s.ID] = []Item{}
				})
				continue
			case WorkflowService:
				stepCtx, cancelStep := workflow.WithCancel(ctx)
				cancels[s.ID] = cancelStep
				nested := startNested(stepCtx, ownCtx, nestedRun{
					TraceID: in.TraceID, Name: s.Workflow, Inputs: stepInputs,
					Prefix: output, Depth: in.Depth + 1, Run: run,
					WorkflowID: workflow.GetInfo(ctx).WorkflowExecution.ID + "/" + name,
				})
				selector.AddFuture(nested, func(f workflow.Future) {
					pending--
					delete(cancels, s.ID)
					cancelStep()
					if gen[s.ID] != g {
						started[s.ID] = false
						return
					}
					var child NestedResult
					if err := f.Get(ctx, &child); err != nil {
						if failure == nil {
							failure = fmt.Errorf("step %q failed: %w", s.ID, err)
						}
						return
					}
					for id, artifact := range child.Artifacts {
						res.Artifacts[s.ID+"/"+id] = artifact
					}
					// The output is every item of the nested run's final step.
					deliver(s.ID, child.Output)
				})
				continue
			case TeamService:
				team := PendingTeam{Step: s.ID, Team: TeamPath(in.Prefix, name), Pass: passes[s.ID]}
				teams[s.ID] = team
				teamIn := TeamInput{
					TraceID: in.TraceID, Workflow: in.Definition.Name, Step: s, Inputs: stepInputs, Prefix: in.Prefix,
					Artifact: output, Team: team.Team, Depth: in.Depth, Run: run, Rejection: rejections[s.ID],
				}
				delete(rejections, s.ID)
				stepCtx, cancelStep := workflow.WithCancel(ctx)
				cancels[s.ID] = cancelStep
				childCtx := workflow.WithChildOptions(stepCtx, workflow.ChildWorkflowOptions{
					WorkflowID: workflow.GetInfo(ctx).WorkflowExecution.ID + "/" + name,
					TaskQueue:  TaskQueue,
					Memo:       map[string]any{"workflow": in.Definition.Name, "trace_id": in.TraceID, "team": team.Team},
					// A team that runs again waits until its cancelled earlier run has closed.
					WaitForCancellation: true,
				})
				selector.AddFuture(workflow.ExecuteChildWorkflow(childCtx, TeamWorkflowName, teamIn), func(f workflow.Future) {
					pending--
					delete(teams, team.Step)
					delete(cancels, team.Step)
					cancelStep()
					if gen[team.Step] != g {
						started[team.Step] = false
						return
					}
					var out StepResult
					if err := f.Get(ctx, &out); err != nil {
						if failure == nil {
							failure = fmt.Errorf("step %q failed: %w", team.Step, err)
						}
						return
					}
					deliver(team.Step, out.items())
				})
				continue
			}
			req := StepRequest{
				TraceID:        in.TraceID,
				Workflow:       in.Definition.Name,
				StepID:         s.ID,
				Agent:          s.Agent,
				Inputs:         stepInputs,
				OutputArtifact: output,
			}
			timeout, _ := s.StartToClose()
			attempts := s.MaxAttempts
			if attempts == 0 {
				attempts = 1 // no retries unless the step sets max_attempts
			}
			actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
				TaskQueue:           s.Service,
				StartToCloseTimeout: timeout,
				RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: attempts},
			})
			activity := s.Activity
			if activity == "" {
				activity = DefaultActivity
			}
			id := s.ID
			selector.AddFuture(workflow.ExecuteActivity(actx, activity, req), func(f workflow.Future) {
				pending--
				if gen[id] != g {
					started[id] = false
					return
				}
				var out StepResult
				if err := f.Get(ctx, &out); err != nil {
					if failure == nil {
						failure = fmt.Errorf("step %q failed: %w", id, err)
					}
					return
				}
				deliver(id, out.items())
			})
		}
		// A merge or batch forwards its next message once the steps after it are idle. Those
		// steps then run again as a new pass.
		released := false
		for _, n := range nodes {
			now := workflow.Now(ctx)
			if n.step.Service == MergeService && n.expired(now) {
				failure = n.timeoutError()
				break
			}
			if busy(n.segment) {
				continue
			}
			items, ok := n.release(now)
			if !ok {
				continue
			}
			released = true
			for _, id := range n.segment {
				started[id], inPass[id] = false, false
				delete(outputs, id)
				delete(rounds, id)
				delete(rejections, id)
			}
			if finish(n.step.ID, items); failure != nil {
				break
			}
		}
		if failure != nil {
			continue
		}
		// Each node has one timer for its input timeout. It is replaced when the expiry changes.
		timers := 0
		for _, n := range nodes {
			want := n.deadline()
			if !want.After(workflow.Now(ctx)) {
				// No timeout runs, or it is due and the node waits for the steps after it.
				want = time.Time{}
			}
			if !want.Equal(n.armed) {
				if n.cancel != nil {
					n.cancel()
					n.cancel = nil
				}
				n.armed = want
				n.seq++
				if !want.IsZero() {
					timerCtx, cancelTimer := workflow.WithCancel(ctx)
					n.cancel = cancelTimer
					seq := n.seq
					selector.AddFuture(workflow.NewTimer(timerCtx, want.Sub(workflow.Now(ctx))), func(workflow.Future) {
						if n.seq == seq {
							n.armed, n.cancel = time.Time{}, nil
						}
					})
				}
			}
			if !n.armed.IsZero() {
				timers++
			}
		}
		if released {
			continue
		}
		// The run is complete when no step is running, no release is waiting, and no timer is pending.
		if pending == 0 && timers == 0 {
			return res, nil
		}
		selector.Select(ctx)
	}
}

// startRoute resolves the workflow named in the route step's input artifact
// and runs it as a child workflow under the same trace. The child's steps
// store their artifacts under "<prefix>/<name>", where name is the route step
// or its pass. The routed workflow receives the item that named the route.
func startRoute(ctx, ownCtx workflow.Context, in Input, name string, stepInputs []Item, run string) workflow.Future {
	future, setter := workflow.NewFuture(ctx)
	workflow.Go(ctx, func(ctx workflow.Context) {
		var routed RouteResult
		if err := workflow.ExecuteActivity(ownCtx, ResolveRouteActivity, RouteRequest{Inputs: stepInputs}).Get(ctx, &routed); err != nil {
			setter.Set(nil, err)
			return
		}
		childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
			WorkflowID: workflow.GetInfo(ctx).WorkflowExecution.ID + "/" + name,
			TaskQueue:  TaskQueue,
			Memo:       map[string]any{"workflow": routed.Definition.Name, "trace_id": in.TraceID},
			// A route that runs again waits until its cancelled earlier run has closed.
			WaitForCancellation: true,
		})
		var child Result
		err := workflow.ExecuteChildWorkflow(childCtx, WorkflowName, Input{
			TraceID:    in.TraceID,
			Definition: routed.Definition,
			Inputs:     routed.Inputs,
			Prefix:     ArtifactID(in.Prefix, name),
			Depth:      in.Depth + 1,
			Run:        run,
		}).Get(ctx, &child)
		setter.Set(child, err)
	})
	return future
}

// ready reports whether every dependency of the step has finished its current run.
func ready(s Step, outputs map[string][]Item) bool {
	for _, d := range s.DependsOn {
		if _, ok := outputs[d]; !ok {
			return false
		}
	}
	return true
}

// inputs returns the items a step receives: the items of its dependencies in depends_on
// order, those of a merge or batch added flat, or the run's inputs for a step without
// dependencies.
func inputs(s Step, runInputs []Item, outputs map[string][]Item) []Item {
	list := []Item{}
	if len(s.DependsOn) == 0 {
		return append(list, runInputs...)
	}
	for _, d := range s.DependsOn {
		list = append(list, outputs[d]...)
	}
	return list
}
