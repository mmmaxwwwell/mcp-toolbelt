# Principles: Parallel Multi-Agent Execution Systems

**Purpose.** This file captures the *durable intents* and the *patterns* behind
the multi-developer parallel runner — separated from the runner's specifics — so
they can be applied to a sister system with a different shape (different task
source, different agent runtime, different domain).

Read this as: "here is the problem we were really solving, the tensions that
kept recurring, and the shape of the solution we reached — independent of how
*this* codebase happens to implement it."

The concrete design lives in the `agent-framework` repo:
`agent-framework/docs/multi-developer-runner.md` and
`agent-framework/docs/spec-kit-tasks-format.md`. This file is the transferable
layer above those.

---

## 0. The one-sentence intent

> Turn a single-stream task executor into a **team of agents that minimizes
> wall-clock by working in parallel as intelligently as a good human team
> would** — discovering the plan as they go, coordinating through durable
> shared state, and self-healing when they collide.

Everything below is in service of that sentence.

---

## Part I — Intents (the "why", which transfer everywhere)

These are goals, not mechanisms. A sister system will implement them differently
but should hold the same intents.

### I.1 Minimize wall-clock, not "run things in parallel"
Parallelism is a means. The target is elapsed time. This reframes every
decision: the bottleneck is the **longest dependency chain (critical path)**, so
the system's job is to keep that chain moving and fill idle capacity around it —
not to maximize the *count* of concurrent tasks.

### I.2 The plan is discovered, not known
Any plan written before the work is done is wrong in ways you can't predict
(this dependency is real, that "one task" is three, this tool isn't what the
docs said). A rigid plan caps quality at "as good as the planner guessed." The
intent: **let the executors reshape the plan as they learn**, the way a real
team re-scopes mid-sprint.

### I.3 Coordinate through durable, inspectable shared state
Agents are isolated and ephemeral; one shouldn't depend on another being awake
or on an in-memory handshake. The intent: **all coordination flows through state
that survives a crash, is queryable by an outside observer, and has a single
writer per fact** — so progress is never lost and is always auditable.

### I.4 Cooperate first, enforce only where correctness demands it
Prefer mechanisms that let agents *see each other and cooperate* over hard locks.
Reserve true mutual exclusion for the narrow spots where a race actually
corrupts data. Everywhere else, lean on visibility + repair. Locks are a cost
(staleness, deadlock, discipline); spend them only where earned.

### I.5 Fail soft and self-heal; expect collisions
With many agents and an imperfect plan, collisions and mistakes *will* happen.
The intent is not to prevent every one — it's to make failure **cheap to detect
and automatic to repair**, so a collision is a hiccup, not a halt. Validation is
also collision-detection.

### I.6 Reuse the proven single-stream engine; don't rewrite it
The existing single-agent executor already encodes hard-won correctness (its
fix-validate loop, its review cycle). The intent: **make N of those, don't
reinvent one.** New machinery goes *around* the proven unit, not inside it.

### I.7 Observability is a first-class product, not a log
A human (or an operator agent) must be able to watch the whole fleet — who's
working, who's blocked on whom, what's about to collide, how the plan is
reshaping — and optionally steer it. This is a designed surface, not a
side-effect of logging.

### I.8 Degrade to the old behavior at N=1
Any parallel system should collapse cleanly to the trusted sequential behavior
when there's only one worker (or the plan is linear). This is both a
backward-compatibility guarantee and a correctness sanity check: if N=1 differs
from the old system, the abstraction leaked.

---

## Part II — Patterns (the "how", which transfer with adaptation)

Each pattern names the tension it resolves, so you can recognize when a sister
system has the same tension.

### II.1 Supervisor + N instances of the unit-of-work executor
**Tension:** you want parallelism but also the proven correctness of the
existing executor.
**Pattern:** classify the old executor into a `Worker` class; a new `Supervisor`
holds a collection of N workers and coordinates *between* them. The supervisor
adds only cross-worker concerns (scheduling, conflict mediation, plan
mutation); each worker runs the unchanged inner loop. Two scheduling layers that
don't fight: supervisor decides *which work*; worker decides *how* it does its
claimed work.

### II.2 The dependency DAG is the schedule (phases are a fallback)
**Tension:** coarse phase barriers serialize work that doesn't actually depend
on each other.
**Pattern:** drive scheduling off a true dependency graph (`deps` edges), not
phase walls. A "workstream" is a *path through the DAG*, not a phase. Phase
ordering survives only as a legacy/fallback mode.

### II.3 Critical-path-biased priority on a pull queue
**Tension:** with work-stealing, an idle worker might grab a low-value leaf while
the wall-clock-determining chain waits.
**Pattern:** compute each task's *downstream weight* (longest chain through it).
Order the ready-set by weight, descending. Idle workers pull the top. Estimate
unknown durations from historical priors keyed on a task *kind*, and refine with
measured durations as tasks complete. Be honest: this is *biased*, not optimal —
optimal scheduling under unknown durations is unattainable; the bias captures
most of the win.

### II.4 Pure pull / work-stealing over assigned queues
**Tension:** pre-assigning work to workers causes idle workers beside a
backlogged peer.
**Pattern:** no per-worker queues. Every idle worker claims from the *global*
priority-ordered ready-set; an atomic claim arbitrates races. Self-balancing,
no reassignment logic. "Ownership" is just whoever won the claim.

### II.5 One atomic primitive for all mutual exclusion
**Tension:** you need exclusion in a couple of places and don't want a bespoke
lock manager.
**Pattern:** use a single atomic check-and-set as both "claim this task" and
"hold this resource lock." (In a SQL store: `INSERT … ON CONFLICT DO NOTHING`,
success iff one row changed; the PRIMARY KEY *is* the mutex.) Same idiom, two
uses. Resource locks are **short-held** (acquire → mutate → release) and
**stealable on timeout** so a crashed holder can't wedge the system.

### II.6 Intent → lock → repair for shared mutable resources
**Tension:** multiple workers must edit the same shared artifact (a config file,
a registry, a shared record); you want neither silent clobbers nor heavy
machinery.
**Pattern:** three layers, each catching what the prior misses.
1. **Advisory intent** — announce "about to touch X" and check who else is;
   gives cooperation and lets a worker reorder to avoid contention.
2. **Atomic lock** — actually editing requires holding X's lock (II.5); closes
   the time-of-check/time-of-use race that advisory intent alone leaves open.
3. **Repair** — after editing, validate; if a clobber slipped through (a
   lock-steal race, or an actor that never participated), re-acquire, re-read,
   re-apply, re-validate, bounded.
This deliberately avoids a "merge fragments via a central integrator" design:
direct edits under a short lock are simpler and the repair loop covers the
residual. Choose this when the contended section is small and edits are
naturally idempotent.

### II.7 Single-writer state via a mediated proposal queue
**Tension:** you want workers to *change shared structure* (the plan/DAG, config)
but concurrent structural writes corrupt invariants.
**Pattern:** workers never write shared structure directly — they `propose` a
change to a queue; one authority (the supervisor) validates invariants, applies
it, and recomputes derived state. Constrain proposals to a **small, composable
verb set** (e.g. split / add-node / add-edge / flag) so the structure stays
analyzable. Same pattern serves operator *control* verbs (pause/resume/abort) —
control is just proposals from a privileged client.

### II.8 The in-flight rule (safe structural mutation)
**Tension:** a proposed structural change can reference work already running or
finished, which you can't retroactively alter.
**Pattern:** structural mutations are valid **only against not-yet-started
units**. A mutation that would bind a running/done unit is rejected and demoted
to an escalation (a "flag" for the authority to reconcile, e.g. by adding a
follow-up unit). This single rule is what keeps "discover the plan as you go"
(I.2) from corrupting in-flight work.

### II.9 Two coordination surfaces: inside-peer vs. outside-observer
**Tension:** the same state serves two very different audiences with different
trust and shape.
**Pattern:** expose **two interfaces over one store**:
- *Inside* (peer↔peer): narrow, transactional, write-capable — claims, intents,
  locks, completion, proposals. Clients are trusted workers.
- *Outside-in* (observer→fleet): wide, read-mostly, aggregate — status, blocked
  graph, critical path, pending proposals, throughput. Clients are humans /
  operator agents and must be *unable* to corrupt coordination state.
Splitting them (not one interface with extra verbs) makes "an observer can't
accidentally mutate scheduling" a structural guarantee. Control verbs, if
offered, sit behind an explicit opt-in flag and are mediated (II.7), never raw
writes.

### II.10 Transient signals vs. durable record — split by lifetime
**Tension:** "everything in files" loses consistency; "everything in a live
service" loses durability and post-mortem inspectability.
**Pattern:** route by lifetime. **Live coordination signals** (claims, intents,
locks) go in the transactional store. **Permanent record and build artifacts**
(completion records, learnings, event log, the produced files themselves) stay
as durable, diffable files. Rule of thumb: anything a human/agent reads *after*
the run is a file; anything only live workers consult *mid-run* is a service
call. Mirror the few things both need.

### II.11 Knowledge sharing distinct from coordination
**Tension:** workers re-learn and re-decide the same things in parallel.
**Pattern:** give discoveries their own channel separate from intent/claim
signals. A discovery that merely informs a peer → a *finding* others read before
related work. A discovery that changes the plan → a *proposal* (II.7). Same
origin, two outlets. (This is the structured upgrade of an append-only
"learnings" file.)

### II.12 Push-wake over poll where the substrate allows
**Tension:** a blocked worker polling wastes cycles (and, for LLM agents, breaks
prompt-cache locality and burns tokens).
**Pattern:** if workers share a process/runtime, a blocked worker *awaits* an
event the supervisor sets the instant a dependency completes (≈0 latency). Fall
back to bounded polling only when workers are isolated processes; keep the poll
interval inside the runtime's cache-warm window. Either way the *coordination
contract is identical* — push vs. poll is an optimization, not a redesign.

---

## Part III — Anti-patterns we explicitly rejected

Recording these so a sister system doesn't re-derive them.

- **Hard, long-held distributed locks on shared artifacts.** Agents keep mutex
  discipline poorly; leases go stale on crash; the contended window is usually
  tiny. Use II.6 (short lock + repair) instead.
- **Central "merge fragments" integrator** as the *only* way to touch a shared
  file. It adds a schema, a merge algorithm, and an extra DAG node to avoid a
  race that a short lock already prevents. Considered and dropped in favor of
  II.6. (It remains a *fine* pattern when edits are genuinely non-idempotent or
  the merge is semantically rich — judge per case.)
- **Direct peer-to-peer agent messaging.** Couples liveness (A waits on B being
  awake). Use durable shared state (I.3) so progress never depends on who's
  running.
- **One coordination interface for both peers and observers.** Lets an observer
  corrupt scheduling. Split them (II.9).
- **Static plan executed verbatim.** Caps outcomes at the planner's foresight.
  Allow mediated reshaping (I.2 / II.7 / II.8).
- **Maximizing concurrent task count.** Optimizes the wrong metric; can starve
  the critical path. Optimize wall-clock via II.3.

---

## Part IV — Applying this to a sister system: a checklist

When porting these ideas to a different system, ask:

1. **What is the unit-of-work executor I should instance N times?** (II.1) Don't
   rewrite it — wrap it.
2. **What is the dependency structure, and where does it currently hide?** (II.2)
   Is it implicit in ordering/phases? Make it explicit as a graph.
3. **What's the critical path, and how do I estimate durations before I have
   data?** (II.3) Is there historical signal to prime the estimate?
4. **Where are the genuine shared-mutable resources?** (II.6) For each: is the
   edit window small and idempotent (→ short lock + repair) or large/semantic
   (→ consider an integrator)?
5. **What structural changes will executors want to make mid-run, and what's the
   minimal verb set?** (II.7, II.8) Define the in-flight rule for your domain.
6. **Who needs to observe/steer, and how do I keep them from corrupting state?**
   (II.9) Two surfaces, one store.
7. **Which signals are transient vs. durable?** (II.10) Route by lifetime.
8. **Can workers push-wake, or must they poll?** (II.12) Match the substrate.
9. **Does it cleanly degrade to the old single-stream behavior at N=1?** (I.8)
   If not, the seam is wrong.

---

*Sister-system note:* the value here is the **mapping from tension → pattern**.
If your system has the tension (named in each II.x), reach for the pattern; if it
doesn't, skip it. The intents in Part I are non-negotiable goals; the patterns in
Part II are the best implementations we found for *this* substrate and should be
re-judged against yours.
