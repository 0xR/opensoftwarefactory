package pipeline

import (
	"fmt"
	"strings"
	"time"

	"go.temporal.io/sdk/workflow"
)

// Services that only route results. They have no agent and call no activity.
const (
	// MergeService marks a step that waits until every source has delivered and forwards
	// their results together.
	MergeService = "merge"
	// BatchService marks a step that collects results from any source and forwards them
	// together once it holds size items or its input timeout has passed.
	BatchService = "batch"
)

const (
	// DefaultCapacity is the number of waiting entries of a merge step that sets none.
	DefaultCapacity = 16
	// DefaultInputTimeout is the input timeout in seconds of a merge or batch step that sets none.
	DefaultInputTimeout = 300
)

// NodesQuery is the Temporal query that returns the state of the merge and batch steps.
const NodesQuery = "nodes"

// Item is one result in a step's input or output: the step that produced the artifact, the
// artifact's object ID, and which run of that step produced it, starting at 1.
type Item struct {
	Source   string `json:"source"`
	Artifact string `json:"artifact"`
	Round    int    `json:"round"`
}

// IsNode reports whether the step is a merge or batch step.
func (s Step) IsNode() bool {
	return s.Service == MergeService || s.Service == BatchService
}

// PassName names the artifacts of the n-th pass of a step that runs after a merge or batch.
func PassName(step string, pass int) string {
	return fmt.Sprintf("%s.pass-%d", step, pass)
}

// Release is one message a merge or batch step forwarded. Timed marks a batch that the
// input timeout released before it was full.
type Release struct {
	Pass  int       `json:"pass"`
	Items []Item    `json:"items"`
	At    time.Time `json:"at"`
	Timed bool      `json:"timed,omitempty"`
}

// MergeEntry is a waiting entry of a merge step. Filled lists the sources that have
// delivered for it, in depends_on order.
type MergeEntry struct {
	Filled []string `json:"filled"`
}

// MergeState is the state of a merge step. Waiting lists the waiting entries, oldest first.
// Expires is set while the input timeout runs.
type MergeState struct {
	Kind         string       `json:"kind"`
	Sources      []string     `json:"sources"`
	Waiting      []MergeEntry `json:"waiting"`
	Forwarded    int          `json:"forwarded"`
	Expires      *time.Time   `json:"expires,omitempty"`
	Capacity     int          `json:"capacity"`
	InputTimeout int          `json:"input_timeout"`
	Releases     []Release    `json:"releases"`
}

// BatchState is the state of a batch step. Collected lists the items that wait for the next
// release. Expires is set while the input timeout runs.
type BatchState struct {
	Kind         string     `json:"kind"`
	Sources      []string   `json:"sources"`
	Collected    []Item     `json:"collected"`
	Size         int        `json:"size"`
	Released     int        `json:"released"`
	Expires      *time.Time `json:"expires,omitempty"`
	InputTimeout int        `json:"input_timeout"`
	Releases     []Release  `json:"releases"`
}

// message is one result a source delivered to a merge step.
type message struct {
	items []Item
	at    time.Time
}

// node is the state of a merge or batch step during a run. It decides from its own queue
// and its own timer only.
type node struct {
	step Step
	// segment lists the steps that run once per release: those reached from the node
	// without passing another merge or batch step.
	segment []string
	// queues holds, per source of a merge, the results that wait to be forwarded.
	queues map[string][]message
	// items holds the results a batch collected, and last is when the newest one arrived.
	items    []Item
	last     time.Time
	releases []Release
	// armed is the expiry of the running timer; seq tells a current timer from a replaced one.
	armed  time.Time
	cancel workflow.CancelFunc
	seq    int
}

// newNodes returns the merge and batch steps of a definition in definition order.
func newNodes(d Definition) []*node {
	var nodes []*node
	for _, s := range d.Steps {
		if s.IsNode() {
			nodes = append(nodes, &node{step: s, segment: segment(d, s.ID), queues: map[string][]message{}})
		}
	}
	return nodes
}

// segment returns the steps reached from a merge or batch step without passing another one,
// in definition order.
func segment(d Definition, node string) []string {
	reached := map[string]bool{node: true}
	for changed := true; changed; {
		changed = false
		for _, s := range d.Steps {
			if reached[s.ID] || s.IsNode() {
				continue
			}
			for _, dep := range s.DependsOn {
				if reached[dep] {
					reached[s.ID], changed = true, true
					break
				}
			}
		}
	}
	var steps []string
	for _, s := range d.Steps {
		if reached[s.ID] && s.ID != node {
			steps = append(steps, s.ID)
		}
	}
	return steps
}

func (n *node) capacity() int {
	if n.step.Capacity > 0 {
		return n.step.Capacity
	}
	return DefaultCapacity
}

func (n *node) timeoutSeconds() int {
	if n.step.InputTimeout > 0 {
		return n.step.InputTimeout
	}
	return DefaultInputTimeout
}

func (n *node) timeout() time.Duration {
	return time.Duration(n.timeoutSeconds()) * time.Second
}

// add takes a result of a source. A merge keeps it as the source's next waiting result and
// fails when that exceeds its capacity. A batch appends the items and restarts its timeout.
func (n *node) add(source string, items []Item, now time.Time) error {
	if n.step.Service == BatchService {
		n.items = append(n.items, items...)
		n.last = now
		return nil
	}
	n.queues[source] = append(n.queues[source], message{items: items, at: now})
	if len(n.queues[source]) > n.capacity() {
		return fmt.Errorf("merge %q is full: capacity %d", n.step.ID, n.capacity())
	}
	return nil
}

// missing returns the sources of a merge that have no result in the oldest waiting entry.
func (n *node) missing() []string {
	var sources []string
	for _, source := range n.step.DependsOn {
		if len(n.queues[source]) == 0 {
			sources = append(sources, source)
		}
	}
	return sources
}

// deadline returns when the input timeout expires, or the zero time when it does not run.
// For a merge it runs from the first result of the oldest waiting entry while that entry is
// incomplete. For a batch it runs from the newest item while the batch is not full.
func (n *node) deadline() time.Time {
	if n.step.Service == BatchService {
		if len(n.items) == 0 || len(n.items) >= n.step.Size {
			return time.Time{}
		}
		return n.last.Add(n.timeout())
	}
	var first time.Time
	for _, source := range n.step.DependsOn {
		if q := n.queues[source]; len(q) > 0 && (first.IsZero() || q[0].at.Before(first)) {
			first = q[0].at
		}
	}
	if first.IsZero() || len(n.missing()) == 0 {
		return time.Time{}
	}
	return first.Add(n.timeout())
}

// expired reports whether the input timeout has passed.
func (n *node) expired(now time.Time) bool {
	deadline := n.deadline()
	return !deadline.IsZero() && !now.Before(deadline)
}

// timeoutError is the failure of a merge whose oldest entry stayed incomplete.
func (n *node) timeoutError() error {
	sources := n.missing()
	for i, source := range sources {
		sources[i] = fmt.Sprintf("%q", source)
	}
	return fmt.Errorf("merge %q timed out: no result from %s", n.step.ID, strings.Join(sources, ", "))
}

// release takes the next message to forward, if there is one. A merge forwards its oldest
// entry once every source has a result in it, with the items in depends_on order. A batch
// forwards size items once it holds them, or all its items once its timeout has passed.
func (n *node) release(now time.Time) ([]Item, bool) {
	out := []Item{}
	timed := false
	if n.step.Service == BatchService {
		count := 0
		switch {
		case len(n.items) >= n.step.Size:
			count = n.step.Size
		case n.expired(now):
			count, timed = len(n.items), true
		}
		if count == 0 {
			return nil, false
		}
		out = append(out, n.items[:count]...)
		n.items = append([]Item{}, n.items[count:]...)
	} else {
		if len(n.missing()) > 0 {
			return nil, false
		}
		for _, source := range n.step.DependsOn {
			out = append(out, n.queues[source][0].items...)
			n.queues[source] = n.queues[source][1:]
		}
	}
	n.releases = append(n.releases, Release{Pass: len(n.releases) + 1, Items: out, At: now, Timed: timed})
	return out, true
}

// state describes the node for the run status.
func (n *node) state() any {
	var expires *time.Time
	if deadline := n.deadline(); !deadline.IsZero() {
		expires = &deadline
	}
	releases := append([]Release{}, n.releases...)
	if n.step.Service == BatchService {
		return BatchState{
			Kind: BatchService, Sources: n.step.DependsOn, Collected: append([]Item{}, n.items...), Size: n.step.Size,
			Released: len(releases), Expires: expires, InputTimeout: n.timeoutSeconds(), Releases: releases,
		}
	}
	waiting := 0
	for _, q := range n.queues {
		waiting = max(waiting, len(q))
	}
	entries := make([]MergeEntry, waiting)
	for i := range entries {
		entries[i].Filled = []string{}
		for _, source := range n.step.DependsOn {
			if len(n.queues[source]) > i {
				entries[i].Filled = append(entries[i].Filled, source)
			}
		}
	}
	return MergeState{
		Kind: MergeService, Sources: n.step.DependsOn, Waiting: entries, Forwarded: len(releases), Expires: expires,
		Capacity: n.capacity(), InputTimeout: n.timeoutSeconds(), Releases: releases,
	}
}
