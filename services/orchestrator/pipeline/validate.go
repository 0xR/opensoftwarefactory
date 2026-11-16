package pipeline

import (
	"fmt"
	"regexp"
	"strings"
)

// namePattern matches workflow names and step IDs: letters, digits, and dashes. A word may be in
// capitals ("API-review" is shown as "API Review"); names differing only in case are duplicates.
var namePattern = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)

// agentRefPattern matches a pinned agent reference such as intake@v3 or, for an
// agent in a folder, translation/en-2-de@v1.
var agentRefPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?){0,3}@v[1-9][0-9]*$`)

// Validate checks a definition: valid unique names, known dependencies,
// an acyclic graph, and the fields each kind of step requires. Any step may
// depend on an interactive step, as on a gate: its output artifact is the
// session file the person chose.
func Validate(d Definition) error {
	if !namePattern.MatchString(d.Name) {
		return fmt.Errorf("workflow name %q must be letters, digits, and dashes", d.Name)
	}
	if len(d.Steps) == 0 {
		return fmt.Errorf("workflow %q needs at least one step", d.Name)
	}
	steps := map[string]Step{}
	seen := map[string]bool{}
	for _, s := range d.Steps {
		if !namePattern.MatchString(s.ID) || strings.EqualFold(s.ID, InputSource) {
			return fmt.Errorf("workflow %q: step id %q must be letters, digits, and dashes and not %q", d.Name, s.ID, InputSource)
		}
		if seen[strings.ToLower(s.ID)] {
			return fmt.Errorf("workflow %q: duplicate step id %q", d.Name, s.ID)
		}
		if s.Service == "" {
			return fmt.Errorf("workflow %q: step %q needs a service", d.Name, s.ID)
		}
		if s.MaxAttempts < 0 {
			return fmt.Errorf("workflow %q: step %q max_attempts must not be negative", d.Name, s.ID)
		}
		if _, err := s.StartToClose(); err != nil {
			return fmt.Errorf("workflow %q: %w", d.Name, err)
		}
		switch s.Service {
		case AgentService:
			if !agentRefPattern.MatchString(s.Agent) {
				return fmt.Errorf("workflow %q: step %q needs an agent such as intake@v1", d.Name, s.ID)
			}
		case InteractiveService:
			// "files" and "chats" are the folders of a session, so a session of that name
			// would overlap another session's folders.
			if strings.EqualFold(s.ID, "files") || strings.EqualFold(s.ID, "chats") {
				return fmt.Errorf("workflow %q: interactive step id %q is reserved; choose another id", d.Name, s.ID)
			}
			if !agentRefPattern.MatchString(s.Agent) {
				return fmt.Errorf("workflow %q: interactive step %q needs a main agent such as intake@v1", d.Name, s.ID)
			}
			for _, agent := range s.Agents {
				if !agentRefPattern.MatchString(agent) {
					return fmt.Errorf("workflow %q: interactive step %q lists %q, which is not an agent such as intake@v1", d.Name, s.ID, agent)
				}
			}
		case RouteService:
			if len(s.DependsOn) != 1 {
				return fmt.Errorf("workflow %q: route step %q needs exactly one dependency that holds the route", d.Name, s.ID)
			}
		case WorkflowService:
			if !workflowRefPattern.MatchString(s.Workflow) {
				return fmt.Errorf("workflow %q: workflow step %q needs the workflow it runs, such as build@v1", d.Name, s.ID)
			}
		case TeamService:
			if err := validateTeam(d.Name, s); err != nil {
				return err
			}
		case MergeService, BatchService:
			if err := validateNode(d.Name, s); err != nil {
				return err
			}
		}
		if !s.IsNode() && (s.Capacity != 0 || s.Size != 0 || s.InputTimeout != 0) {
			return fmt.Errorf("workflow %q: step %q sets capacity, size, or input_timeout, which only a merge or batch step can have", d.Name, s.ID)
		}
		if s.OnReject != "" && s.Service != GateService {
			return fmt.Errorf("workflow %q: step %q sets on_reject, which only a gate step can have", d.Name, s.ID)
		}
		steps[s.ID] = s
		seen[strings.ToLower(s.ID)] = true
	}
	for _, s := range d.Steps {
		for _, dep := range s.DependsOn {
			target, ok := steps[dep]
			if !ok {
				return fmt.Errorf("workflow %q: step %q depends on unknown step %q", d.Name, s.ID, dep)
			}
			if target.Service == RouteService {
				return fmt.Errorf("workflow %q: step %q cannot depend on route step %q", d.Name, s.ID, dep)
			}
			if s.Service == RouteService && target.IsNode() {
				return fmt.Errorf("workflow %q: route step %q cannot depend on %s step %q", d.Name, s.ID, target.Service, dep)
			}
		}
	}
	const (
		visiting = 1
		visited  = 2
	)
	state := map[string]int{}
	var visit func(id string) error
	visit = func(id string) error {
		switch state[id] {
		case visiting:
			return fmt.Errorf("workflow %q: dependency cycle through step %q", d.Name, id)
		case visited:
			return nil
		}
		state[id] = visiting
		for _, dep := range steps[id].DependsOn {
			if err := visit(dep); err != nil {
				return err
			}
		}
		state[id] = visited
		return nil
	}
	for _, s := range d.Steps {
		if err := visit(s.ID); err != nil {
			return err
		}
	}
	for _, s := range d.Steps {
		if s.OnReject == "" {
			continue
		}
		if target, ok := steps[s.OnReject]; !ok || target.Service != TeamService || s.OnReject == s.ID || !dependents(d, s.OnReject)[s.ID] {
			return fmt.Errorf("workflow %q: gate %q on_reject must name a team step the gate depends on, not %q", d.Name, s.ID, s.OnReject)
		}
		// A rejection runs the steps after the team again. A merge or batch among them would
		// receive their results a second time.
		after := dependents(d, s.OnReject)
		for _, other := range d.Steps {
			if after[other.ID] && other.IsNode() {
				return fmt.Errorf("workflow %q: gate %q on_reject names team %q, which has the %s step %q after it; the gate and its team must both come after it or before it",
					d.Name, s.ID, s.OnReject, other.Service, other.ID)
			}
		}
	}
	return nil
}

// validateNode checks a merge or batch step: at least one source, positive numbers, size on
// a batch only, capacity on a merge only, and none of the fields of other kinds of step.
func validateNode(workflow string, s Step) error {
	if len(s.DependsOn) == 0 {
		return fmt.Errorf("workflow %q: %s step %q needs at least one source in depends_on", workflow, s.Service, s.ID)
	}
	if s.Agent != "" || len(s.Agents) > 0 || s.Question != "" || s.Timeout != "" || s.Activity != "" || s.Workflow != "" ||
		len(s.Workflows) > 0 || len(s.Channels) > 0 || s.MaxTurns != 0 || len(s.MemberPositions) > 0 || s.OnReject != "" || s.MaxAttempts != 0 {
		return fmt.Errorf("workflow %q: %s step %q takes only depends_on, capacity or size, and input_timeout", workflow, s.Service, s.ID)
	}
	if s.InputTimeout < 0 {
		return fmt.Errorf("workflow %q: %s step %q input_timeout must be a positive whole number of seconds", workflow, s.Service, s.ID)
	}
	if s.Service == BatchService {
		if s.Capacity != 0 {
			return fmt.Errorf("workflow %q: batch step %q sets capacity, which only a merge step can have", workflow, s.ID)
		}
		if s.Size < 1 {
			return fmt.Errorf("workflow %q: batch step %q needs a size of 1 or more", workflow, s.ID)
		}
		return nil
	}
	if s.Size != 0 {
		return fmt.Errorf("workflow %q: merge step %q sets size, which only a batch step can have", workflow, s.ID)
	}
	if s.Capacity < 0 {
		return fmt.Errorf("workflow %q: merge step %q capacity must be a positive whole number", workflow, s.ID)
	}
	return nil
}

// validateTeam checks a team step: a lead agent, members with unique names that are not the
// reserved "workflow", and channels between two different members.
func validateTeam(workflow string, s Step) error {
	if !agentRefPattern.MatchString(s.Agent) {
		return fmt.Errorf("workflow %q: team step %q needs a lead agent such as lead@v1", workflow, s.ID)
	}
	for _, agent := range s.Agents {
		if !agentRefPattern.MatchString(agent) {
			return fmt.Errorf("workflow %q: team step %q lists %q, which is not an agent such as coder@v1", workflow, s.ID, agent)
		}
	}
	for _, name := range s.Workflows {
		if !workflowRefPattern.MatchString(name) {
			return fmt.Errorf("workflow %q: team step %q lists %q, which is not a workflow such as docs@v1", workflow, s.ID, name)
		}
	}
	if s.MaxTurns < 0 {
		return fmt.Errorf("workflow %q: team step %q max_turns must not be negative", workflow, s.ID)
	}
	names := map[string]bool{}
	exact := map[string]string{}
	for _, m := range s.TeamMembers() {
		key := strings.ToLower(m.Name)
		if key == WorkflowSender {
			return fmt.Errorf("workflow %q: team step %q has a member named %q, which is reserved", workflow, s.ID, m.Name)
		}
		if names[key] {
			return fmt.Errorf("workflow %q: team step %q has two members named %q", workflow, s.ID, m.Name)
		}
		names[key] = true
		exact[key] = m.Name
	}
	channels := map[string]bool{}
	for _, pair := range s.Channels {
		if len(pair) < 2 || len(pair) > 3 || pair[0] == pair[1] {
			return fmt.Errorf("workflow %q: team step %q: a channel connects exactly two different members", workflow, s.ID)
		}
		if len(pair) == 3 && pair[2] != OneWay {
			return fmt.Errorf("workflow %q: team step %q: the third entry of a channel is %q (only the first member sends) or left out, not %q", workflow, s.ID, OneWay, pair[2])
		}
		for _, name := range pair[:2] {
			member, known := exact[strings.ToLower(name)]
			if !known {
				return fmt.Errorf("workflow %q: team step %q has a channel to %q, which is not a member", workflow, s.ID, name)
			}
			if member != name {
				return fmt.Errorf("workflow %q: team step %q has a channel to %q, but the member is named %q", workflow, s.ID, name, member)
			}
		}
		id := ChannelID(pair[0], pair[1])
		if channels[id] {
			return fmt.Errorf("workflow %q: team step %q lists the channel between %q and %q twice", workflow, s.ID, pair[0], pair[1])
		}
		channels[id] = true
	}
	return nil
}

// nestedWorkflows returns the workflow references a definition runs through workflow steps
// and team workflow members, each with the step that names it.
func nestedWorkflows(d Definition) [][2]string {
	var refs [][2]string
	for _, s := range d.Steps {
		switch s.Service {
		case WorkflowService:
			refs = append(refs, [2]string{s.ID, s.Workflow})
		case TeamService:
			for _, name := range s.Workflows {
				refs = append(refs, [2]string{s.ID, name})
			}
		}
	}
	return refs
}

// ValidateSet checks the stored workflow versions together. It follows the workflow
// references of the newest version of every workflow: every referenced version exists and
// has exactly one final step, whose artifact is its output, and no version reaches itself
// through workflow steps or team workflow members. A bare reference names the newest version.
func ValidateSet(definitions []Definition) error {
	const (
		visiting = 1
		visited  = 2
	)
	state := map[string]int{}
	var path []string
	var visit func(d Definition) error
	visit = func(d Definition) error {
		key := WorkflowRef(d.Name, DefinitionVersion(d))
		switch state[key] {
		case visiting:
			start := 0
			for i, n := range path {
				if n == key {
					start = i
				}
			}
			cycle := append(append([]string{}, path[start:]...), key)
			return fmt.Errorf("workflow %q reaches itself through nested workflows: %s", d.Name, strings.Join(cycle, " -> "))
		case visited:
			return nil
		}
		state[key] = visiting
		path = append(path, key)
		for _, ref := range nestedWorkflows(d) {
			nested, ok := FindDefinition(definitions, ref[1])
			if !ok {
				return fmt.Errorf("workflow %q: step %q names unknown workflow %q", d.Name, ref[0], ref[1])
			}
			if final := FinalSteps(nested); len(final) != 1 {
				return fmt.Errorf("workflow %q runs inside workflow %q (step %q) and needs exactly one final step, but has %d (%s)",
					nested.Name, d.Name, ref[0], len(final), strings.Join(final, ", "))
			}
			if err := visit(nested); err != nil {
				return err
			}
		}
		path = path[:len(path)-1]
		state[key] = visited
		return nil
	}
	for _, d := range Newest(definitions) {
		if err := visit(d); err != nil {
			return err
		}
	}
	return nil
}
