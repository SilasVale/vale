# Proposal: control path — let the operator hold the AI's decision tree

Status: **Proposal (unnumbered draft — not adopted)** ｜ Scope: `agent/` control plane +
panel path view ｜ Written 2026-09-10 ｜ Prototype: branch `prototype/control-path`
(commit `11d0f977`) — a throwaway single-file demo, deliberately NOT on `main`;
check it out from that branch, it is a primary source, not production code

## Goal

Today the operator can **watch** the AI work and can **read the audit trail
afterwards**. Neither is **control**: there is no way to stop the AI at a
decision point, no way to take the keyboard with the AI actually blocked, and
no way to see the paths the AI did *not* take.

This proposal makes the AI's work a **decision tree the operator holds**:
nodes are action boundaries, branches are the options available at that
moment, and the operator can approve / redirect / take over / replay at
nodes. A walked segment can be marked as a **recipe** and re-run.

The value claim is narrow and testable: **the operator should be able to
answer "where is it, why, and what else could it have done" without reading a
log**, and should be able to stop it safely when the answer is wrong.

## Problem (verified in tree 2026-09-10, not hypothetical)

### P1 — There is a mutex, not a control plane

The agent can serialise access to a session, but nothing can *stop* the AI.

| Fact | Evidence |
|---|---|
| `SessionBusy { id }` is the only concurrency signal, and its message says only "another execute in progress" — it does not say WHO holds the session | `agent/vale-command-core/src/error.rs:20-21`, code `"session_busy"` at `:43` |
| `DeviceError` has **zero** pause/cancel/abort variants (grep count 0) | `agent/vale-command-core/src/error.rs` |
| The busy flag is fragile enough that its own comment records that every rule exists "because its absence wedged the session busy flag **forever**" | `agent/src/plugins/terminal/tools/exec.rs:337-338` |
| Concurrent executes are the NORMAL case, not an edge case: "AI clients fire executes back-to-back; **21 "Session busy" failures in one week** of real usage" | `agent/src/plugins/terminal/tools/exec.rs:713-716` |
| No approval/gate concept exists anywhere in the agent (grep for `approval`/`approve` across `agent/src/`: empty) | measured 2026-09-10 |

A human *can* send Ctrl+C today — `terminal_write` passes control characters
verbatim (`agent/src/plugins/terminal/tools/sessions.rs:340`) — but nothing
tells them that is the way to interrupt the AI, the AI is never told it was
interrupted, and no ownership changes hands.

### P2 — The panel can observe activity but cannot see the AI's *choices*

| Fact | Evidence |
|---|---|
| The 5 discrete states already exist and are already the right vocabulary | `CommandCard.tsx:26` (`running/ok/fail/warn/muted`) |
| Events are already grouped into rounds (`command/start → output → command/end`) | `TrajectoryView.tsx` |
| But the "AI is operating" pulse listens to **browser events only** — a command running in a terminal does **not** trigger it | `useAiActivityPulse.ts:17-20` |
| Branches the AI did not take are **not recorded anywhere** — the audit trail records what happened, never what was possible | `agent/src/session_log.rs` (append-only, 30 d retention) |

### P3 — "Running" and "done" are indistinguishable without animation

`running` and `ok` share **the same colour** (`var(--accent)`); the only
differentiator is the `cmd-pulse` animation
(`components.css:475-476`). `prefers-reduced-motion: reduce` sets
`animation: none` on `.cmd-dot` (`components.css:1587,1595`).

So for a user with reduced motion enabled — a standard accessibility setting —
**"the AI is still working" and "the AI finished" render pixel-identically.**
This is a live defect, independent of this proposal, and the discrete-state
palette below fixes it as a side effect.

## What is already right (do NOT change)

These were audited and are load-bearing; the design below builds on them.

1. **Nodes = action boundaries.** Pausing/taking over may only ever happen
   *between* tool calls, never mid-command. Interrupting a running command is
   precisely the wedge-the-busy-flag accident class (`exec.rs:337-338`).
2. **Bounded-wait + resumable contract already exists and AI clients already
   know it.** `terminal_execute` returns
   `{kind, state, text, read_from, wait_reason, exit_code, truncated, still_running}`
   and its description explicitly teaches: a partial result is a PREFIX, the
   command is STILL RUNNING, continue with `terminal_read(offset=read_from)`
   (`exec.rs:629`). **This is the shape the gate contract reuses (§D2).**
3. **Crash recovery already synthesises an interruption.** Restart marks
   mid-execute sessions with a synthetic `command/end{interrupted}`
   (`agent/src/plugins/terminal/mod.rs:344`), and `cardState()` already maps
   `interrupted → warn`.
4. **Scoped credentials are already this repo's answer to least privilege.**
   ADR 0007 split one god admin token into a `role: "relay"` credential. §D1
   applies the same argument to AI action scope.

## Design

### D1 — Authorise **capabilities**, not individual forks

The operator does not approve *this step*; they grant a **capability scope**
for the session:

- read-only → allowed freely
- writes → require approval
- destructive (firmware write, config commit, process kill) → per-instance confirm

The AI walks freely inside its granted scope and **stops only at the scope
boundary**. This makes "a gate at every fork is annoying" impossible by
construction rather than by a threshold, and it makes "掌握" precise: the
operator controls the **permission surface**, not each step.

Default scope set (proposed, needs sign-off — see Open Questions):
**read-only allowed · writes need approval · destructive per-instance.**

### D2 — Gate contract: bounded block, then resumable pending

At a scope boundary the tool call:

1. **blocks for a bounded window** (default 30–60 s). If the operator decides
   inside it — the common case, they are watching — the call returns the
   decision and **the AI needs zero new knowledge**.
2. on window expiry returns
   `{ state: "awaiting_approval", gate, options[], resume_token }`; the AI
   re-calls the same tool with `resume_token` to continue asking.

Rejected alternatives, with reasons:

| Option | Why not |
|---|---|
| Unbounded blocking | A human who takes 5 minutes collides with client timeouts; the call must eventually return *something* |
| Pure pending + poll (no block) | Wastes a turn in the common case, and requires new AI-side knowledge for a case that is usually instant |
| Plain error code (current shape) | Conflates "rejected" with "has not happened yet" — clients retry or give up, and we need them to **wait** |

The chosen shape is not a new protocol: it is `terminal_execute`'s existing
partial / `still_running` / resume-by-read idiom applied to a new resource.

### D3 — Pause means "start no new node", with a real `stopping` state

`paused` may not be a lie. A node has its own `executing` state and duration;
`pause` sets a **request** that takes effect **at the next boundary**. The
derived rule is one line:

```
can_start_new_node = (mode == ai-driving) && !pauseRequested
```

A visible `stopping` state ("waiting for the current command to finish") is
required, because that is what the device is actually doing.

### D4 — Decisions are durable and decoupled from who is present

The operator can decide **while no AI is waiting** (the AI crashed, the
client was closed, they are looking from a phone). Decisions append to JSONL
via the existing crash-safe writer (`agent/src/jsonl.rs`), and an AI that
returns later queries path state and receives the decision.

This is the floor for "掌握": **the operator is never blocked by the AI's
absence.**

### D5 — `human_in_control` is its own error code

When the operator holds the keyboard, an AI attempt must be rejected with a
code **distinct from `session_busy`** — otherwise the AI cannot tell "another
person is driving" from "another AI is driving", and those demand different
behaviour from it.

## Milestones

Staged so each step is independently useful and the risky part is last.

| # | Stage | External dependency | Gate |
|---|---|---|---|
| **P1** | Control plane in the agent: per-session control state, `human_in_control`, boundary-only pause, `stopping`, crash → paused | **none** | agent: `cargo test` + `clippy -D warnings` + `xwin check`; one mutation-proven pin per rule |
| **P2** | **Weak tree** view: nodes from the existing audit trail, branches = currently-legal actions (enumerable from the tool surface, filtered by session kind), gates at scope boundaries | none | panel vitest + `npm run build` + agent gates |
| **P3** | **Intent layer / strong tree**: AI declares per-step `intent` + `considered` | **yes — AI clients must write them** | only if P2's real use proves the weak tree insufficient; requires refreshing `agent/spec-tools.json` AND `gateway/src/mcp-tools.ts` (a tool missing from the gateway registry is not merely unlisted, it is uncalled) |
| **P4** | Recipes: mark a walked segment, re-run it | none | reuses `jsonl.rs` |
| **P5** | Visual layer: discrete state palette (fixes P3 defect), hard edges, the tree drawn **as a tree** | none | after P1–P4 — the skin grows on the model |

## Prototype findings (why the model changed before this doc)

The logic prototype was built first and **its own model failed two ways** —
both invisible on paper:

1. **`paused` while a node is `running` was reachable and meaningless.** The
   prototype's `AI_STEP` was instantaneous, so no "executing" interval existed
   and `pause` appeared to take effect immediately. Its scenario claiming to
   test "pause during a long command" **did not test it**, because the long
   command completed instantly in the model. This is the origin of §D3.
2. **A gate was hardcoded to "branch count > 1".** One of the branches was
   literally "look first (read-only, safe)" — which should never need
   approval. Gating by fork count contradicts this proposal's own rule that
   approval must not be annoying. This is the origin of §D1.

Recorded because "the prototype disproved its author's model" is the useful
part, and because both defects would have shipped as plausible-looking code.

## Residual costs (accepted, not hidden)

1. **Capability granularity needs a good default.** Too fine ⇒ annoying; too
   coarse ⇒ no control. The proposed default set is a starting point.
2. **The block window is a tuning parameter.** Too short ⇒ the common case
   still goes pending; too long ⇒ the AI waits on a human who walked away.
3. **Pending requires the AI to come back.** If it does not, the path stays
   suspended — a property of the client's behaviour, not of this model.
4. **Capabilities are session-scoped.** Cross-session / cross-device durable
   grants are **explicitly out of scope** and would need their own design.
5. **A gate at a scope boundary still costs a round trip.** Capability scoping
   reduces how often, not to zero.

## Open questions (need product sign-off)

1. **Default capability set** — is "read-only allowed · writes need approval ·
   destructive per-instance" the right starting point?
2. **Block window default** — 30 s? 60 s? Configurable per device?
3. **Does the AI get a `pending` path at all in P1**, or does P1 ship only the
   single-operator local case (block + decide) and defer the resumable half to
   P2? (P1 alone is still a real improvement and has no protocol surface.)
4. **P3 go/no-go** waits on P2 evidence. The explicit success criterion for P2
   is: *the operator actually intervenes at boundaries in real use.* If they
   never do, the weak tree is sufficient and P3 is cancelled — a good outcome,
   not a failure.

## Acceptance criteria

- **P1**: pause during a running command is rejected at the boundary and
  reported as `stopping`, never as `paused`; an AI attempt while the operator
  holds the keyboard returns `human_in_control`, not `session_busy`; a crash
  mid-path resumes in `paused`. Each rule carries a mutation-proven pin.
- **P2**: the operator can see, for any node, what else was legal at that
  moment; and can stop the AI at a boundary.
- **P3 (visual)**: with `prefers-reduced-motion: reduce` active, `running` and
  `ok` are distinguishable **without animation**.

## Vocabulary note

Per `docs/agents/domain.md`, this document introduces terms the repo has no
glossary for yet (`control path`, `node`, `branch`, `capability scope`,
`gate`, `recipe`, `stopping`). There is no root `CONTEXT.md` (absent is
expected — created lazily). This is flagged as a gap for `/domain-modeling`
rather than silently inventing vocabulary: **`node` and `branch` are the two
that will leak into test names and API fields, so they should be settled
before P2.**

## Relationship to existing decisions

- **Builds on ADR 0007** — same least-privilege argument, applied to AI action
  scope instead of transport credentials.
- **Does not touch the gateway.** The multi-tenant console is out of scope
  here; this is the device-side control plane.
- **Does not supersede `docs/adr/proposal-interactive-browser.md`** — that
  proposal concerns the embedded browser stream and is independent.
