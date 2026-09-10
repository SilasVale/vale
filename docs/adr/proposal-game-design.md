# Proposal: game design for Vale Agent — readability and agency, not decoration

Status: **Proposal (unnumbered draft — not adopted)** ｜ Scope: `agent/` panel
(visual language, entry funnel) + the control plane it builds on ｜ Written 2026-09-10

## The question this answers

"Design Vale Agent with a game mindset." This document says what that means
concretely, what it forbids, and how to tell whether a given idea qualifies.

**Thesis: game design is not a skin.** What transfers from games is three
properties, in descending order of value:

| Property | In a game | In a tool | Vale today |
|---|---|---|---|
| **Legibility** | a health bar needs no reading | state is unmistakable at a glance | **broken** — see Law 1 |
| **Agency** | your choice changes the outcome | you can stop / redirect | **absent** — there is a mutex, not a control plane |
| **Loop** | a named core loop | a named work rhythm | **never named** — see §2 |

Everything else — cartoon rendering, card skins, 3D — is *expression* of those
three. Build the structure first; the skin grows on it.

## 1. Evidence base (all measured in this tree, 2026-09-10)

| # | Finding | Where |
|---|---|---|
| E1 | All 49 device tools are PRIMITIVES. Not one is goal-level. | `agent/src/plugins/*/tools*.rs` |
| E2 | `terminal_jobs` is the only job-shaped thing that exists: has an id, a `done` flag, an `exit_code`, and a `wait_secs` blocking query. | `agent/src/plugins/terminal/tools/exec.rs:208` |
| E3 | The panel has **zero** AI-client onboarding. The whole front end mentions Claude Code / DSH once, in passing. | `agent/resources/panel-react/src/` |
| E4 | There is no DEVICE-level activity signal. `useAiActivityPulse` exists but is scoped to one pane (see the correction under Law 3) — it is not a global indicator that was mis-wired. | `useAiActivityPulse.ts` + its only consumer, `EmbeddedBrowserPane.tsx:68` |
| E5 | "running" and "ok" shared one colour, distinguished only by an animation that `prefers-reduced-motion` removes — in **three** components. | fixed, P1 |
| E6 | The device side has exactly ONE identity: `possession of the token IS the device identity`. No role, no operator, no approver. | `agent/src/web/panel.rs:139` |
| E7 | The console gamification was already tried and **reverted by product**. | `agent/AGENTS.md:2559` |
| E8 | GPU compositing was already tried and removed: "context creates fine but paints nothing (a silent blank terminal, not catchable)". | `TerminalPane.tsx:27` |

E1 and E2 together are the pivot of this design; E6 is the constraint that
kills the most attractive wrong idea; E7 and E8 are prior art that must not be
re-litigated.

## 2. The core loop: six beats

```
(1) DISPATCH -> (2) ADVANCE -> (3) GATE -> (4) EVIDENCE -> (5) TAKE OVER -> (6) HARVEST
      ^                                                                          |
      +--------------- the path becomes a recipe; next run reuses it -------------+
```

| Beat | In a game | In Vale | Measured status |
|---|---|---|---|
| 1 **Dispatch** | accept a quest | the operator states a goal; the agent records it and the AI READS it off `terminal_list` | **DONE** (`8c42906e`, `5c89e688`) |
| 2 **Advance** | the character walks | `terminal_execute` bounded wait + `run_in_background` | **DONE** |
| 3 **Gate** | choose at a fork | an ARMED session blocks each execute until a person decides; unanswered = NOT run (fail-closed) | **DONE** — whole-step approval (`3b7bbe9c`, `cff3196f`) PLUS the capability scopes that stop it being noisy: approving a command may also allow its first word for the session (`41dbf7d9`, `27aecdfd`, `73f12d7d`). Built differently from §D1 — see the divergence note in `proposal-control-path.md` |
| 4 **Evidence** | hit feedback | `evidence.rs`, actions.jsonl, screenshots; the audit trail also records **who was driving** (`control` events), so a reader can tell an AI-driven window from a human-driven one | **DONE** (`4fabdacd`, surfaced in the path view by `807567cc`) |
| 5 **Take over** | grab the controller | an explicit hold: the AI is refused with `human_in_control` while a person owns the session, and hands back on request | **DONE** — the hold is real, visible in `terminal_list`, and one click in both densities (`fd1013c0`, `f0f06fa8`) |
| 6 **Harvest** | clear / save | durable audit JSONL + accumulating memory | **DONE** — a walked path saves as a recipe into the SHARED memory store, so AI clients can find and re-walk it (`ee563fcc`) |

Originally two beats done, two half-done, two missing; **all six are now done.**

Two of them were closed by first re-reading WHY they looked unreachable, and in
both cases the reason was a conflation rather than a missing capability:

* **Gate** needed no AI-client cooperation — the whole-step form (approve each
  command) is entirely agent-side, and only §D1's *capability scopes* were thought
  to need more. Those shipped too, as grants derived from approved commands rather
  than from a risk classifier (see `proposal-control-path.md` for the divergence
  and its reason).
* **Dispatch** was recorded here as needing AI clients. That was half wrong, and
  the wrong half was the one that mattered: a goal only needs client cooperation
  if the AI must DECLARE it. The OPERATOR declares it, and the AI reads it off
  `terminal_list` — a call every client already makes, carrying fields it already
  parses. No new tool, no protocol change, nothing asked of any client.

The genuinely separate, still-unbuilt piece is the **intent layer**: an AI
declaring its own plan, per-step intent, and the alternatives it rejected. That is
what would turn the path view's steps into a real decision tree — and unlike the
two beats above, it cannot be faked or approximated agent-side, because the data
does not exist until a client writes it.

### 2.1 The structural gap the loop exposes

```
what the operator means      GOAL      "get this ONU provisioned"   <- now STORED
what the AI decides          PLAN      <- still exists NOWHERE
what Vale records            TOOL CALL 49 primitives, all of them
```

TWO of the three layers now exist. The goal is stored on the session and read by
the AI for free; the path derives steps, states, durations, ownership and a
summary from the audit trail; and a recipe saves a walked path for reuse. What is
still missing is the middle row — the AI's own PLAN — which is the intent layer
and cannot be approximated agent-side.

**That middle row is what "the path" was always pointing at**, and the honest
statement of where it stands is: the path view shows what HAPPENED and what it was
FOR, and cannot yet show what was CONSIDERED. E2's observation still holds —
`terminal_jobs` proves the job shape is buildable — but the plan is not a shape
problem; it is data only a client can supply.

## 3. Four laws (each with its evidence)

### Law 1 — State must be discrete enough to need no reading

**The counter-example (E5, real defect, now fixed).** `running` and `ok` were
the same `var(--accent)`, separated only by the `cmd-pulse` animation, and
`prefers-reduced-motion: reduce` sets `animation: none` on `.cmd-dot`,
`.traj-ev-dot` and `.plug-dot`. For anyone with that standard accessibility
setting, "the AI is still working" and "the AI has finished" were **pixel
identical** — in three components at once.

Fixed in P1: five states, each with its own colour **and** its own fill
(solid / hollow). Colour alone could not carry five states — three of the five
hues share one red-orange band — so shape carries the rest. `ok` is
deliberately *quiet*: successes are the common case, and painting every
completed command accent-coloured is what turns a command stream into noise.

A game never uses animation as the sole channel for a state. Neither may this.

### Law 2 — Rhythm comes from structure, not from real-time

Turns land on **action boundaries** only. Not a preference — an incident
history: `exec.rs:337` records that every rule around the busy flag exists
because its absence "wedged the session busy flag **forever**", and
`exec.rs:715` records **21 "Session busy" failures in one week** of real usage.

**So Vale is turn-based, not real-time.** That is the right shape for this
product: turn-based is exactly the feel of a strategy game, and `stopping`
("you pressed stop, the character is still sliding") is what the honesty
requirement looks like.

### Law 3 — Every action leaves a visible consequence

**The counter-example, CORRECTED.** This section originally claimed a defect: the
"AI is operating" pulse listens to `vale-browser-actions-changed` /
`vale-playwright-changed` only, so terminal work fires nothing. Reading the
consumer showed that framing is WRONG, and the correction matters more than the
original claim.

`useAiActivityPulse` has exactly ONE consumer: `EmbeddedBrowserPane`. It lights
a "the AI is driving the browser" indicator and flashes that pane's Evidence
toggle on the idle→active edge. Browser events are the CORRECT input for it —
wiring terminal output in would make the browser pane light up whenever someone
ran a shell command, which is a false signal about the browser, not extra
sensitivity.

So the real gap is different and smaller: **there is no DEVICE-level activity
signal at all.** The panel can say "the AI is driving the browser" but never "this
machine is working". That is a missing indicator, not a mis-wired one, and it is
what §4.3 (the device state on the rail) exists to provide. In game terms the
distinction is between a pane-specific effect and the world's own state.

The mistake is recorded rather than silently edited because it is the same
failure mode this document keeps warning about: a claim about behaviour that was
never checked against the code that implements it. The reading took one grep —
`grep -rn useAiActivityPulse` — and the original text was written without it.

### Law 4 — Progress is never lost; death returns to a checkpoint

**Vale already does this well and has never called it that.** `session_log.rs`
writes crash-safe JSONL with torn-tail repair; `jsonl.rs` owns `prepare_append`
/ `has_torn_tail`; a crash mid-execute is repaired at boot with a synthetic
`command/end{interrupted}`; 30-day retention. This is a real save system — it
just is not organised as part of a loop.

Corollary for the control plane: **after a crash, the path resumes `paused`,
never auto-driving.** Returning to a checkpoint, not to autonomous motion.

## 4. The largest hole is not visual — it is the entry funnel

E3: a new user installs Vale, opens the panel, and sees **a terminal**. The
product's promise ("AI can drive this machine") is invisible until an external
client is configured, and nothing in the UI helps configure one.

In game terms: **there is no tutorial, and the game does not start until you
edit a config file by hand.**

Consequences, in priority order:

1. **Onboarding** — generate the MCP client config (DSH / Claude Code) in one
   click, prove connectivity on the spot (`/api/status`), and show what this
   machine can now be asked to do (the 49 tools grouped by domain, not listed).
2. **Device-level activity signal** — one indication that this machine is working,
   merged from the terminal and browser sources. This REPLACES the earlier wording
   ("merge the terminal and browser activity sources [into the existing pulse]"),
   which was based on the misreading corrected under Law 3: the pane-scoped pulse
   must keep its browser-only input, and the merged signal is a NEW, device-scoped
   one. Merging into the wrong place would have produced a browser indicator that
   lights up for shell commands.
3. **Device state on the rail** — the machine itself: idle, working, failed,
   serial attached. Each mapped to a real state, so it doubles as a status panel
   a non-specialist can read. This is where §4.2's merge actually belongs.

Onboarding outranks the path view: the path view serves people who are already
running; onboarding decides whether anyone runs at all.

## 5. What game design here explicitly FORBIDS

| Rejected | Why |
|---|---|
| Levels / XP / achievements | meaningless for a tool; external motivation degrades into noise |
| Draw / randomness | randomness is the thing the operator is trying to eliminate |
| Real-time micro-control | violates Law 2 and re-enters the busy-flag accident class |
| Terminal body re-skinned | the 13px monospace surface is the working surface; its value IS legibility |
| Console gamification | **already tried and reverted by product** (E7) |
| Second identity system (approver ≠ operator) | E6: the device has one identity, so "someone watching" does not exist |
| WebGL / 3D / GPU compositing in the shell | E8: already produced an uncatchable silent blank |
| Card-game skin as the primary metaphor | the *table* vocabulary (hand / stack / settle) is useful; the *game* (deckbuilding, luck, win-lose) is not. Adopted only as far as "legal options + visible state + settle one at a time" |

## 6. The one test every proposal must pass

> **Does it make state more legible, or control more real?**
> An element that satisfies neither is decoration. Cut it.

Applied retroactively:

| Element | Legible | Agency | Verdict |
|---|---|---|---|
| Discrete state palette (P1) | yes | — | **KEEP** (and it fixed a defect) |
| Decision tree / path map | yes | yes | **KEEP** — as a post-hoc record view, not a live console (§7) |
| Device mascot | yes | — | KEEP |
| Onboarding | yes | yes | **KEEP — highest priority** |
| Card skin | — | — | expression only; optional, last |
| 3D stage | — | — | expression only; optional, last, non-text surfaces only |

## 7. Constraint discovered late: who is the path map FOR?

The decision tree (see `proposal-control-path.md`) was designed for an operator
who **watches the AI work and decides at forks**. E6 says that role does not
exist on the device: operator = approver = the same single identity, and the
person driving the AI is in a *different application* (DSH / Claude Code).

Therefore the path map's honest form is a **post-hoc record view** — the third
`SessionView` beside `terminal` and `trajectory` — answering "what did it do
while I was away, and why". It is NOT a live console, and it must not pretend
to be one. Live control reduces to one affordance: a **stop**.

This is recorded as a constraint on the design, not a failure of it. It also
means the audience question ("who uses this, in what scenario") remains open,
and it is the user's to answer, not the author's to assume.

## 8. Status of this design

| Item | State |
|---|---|
| Six-beat loop, named and measured | **done** (this doc) |
| Four laws, each with evidence | **done** (this doc) |
| Law 1 enforced and pinned | **done** — `src/lib/statePalette.test.ts`, mutation-proven (3 mutants, each caught) |
| Onboarding (§4.1, the biggest hole) | **done** — `ConnectCard.tsx`, 8 tests, 3 mutants caught (`91359f85`) |
| A defect Law 1's fix exposed | **done** — recessed panes were near-white-on-near-white in dark mode, contrast measured **1.12** at 7 pre-existing sites; now 15.71 (`40d06025`, pinned by `themeContrast.test.ts`) |
| Device-level activity signal + device state (§4.2–4.3) | **done** — `useDeviceActivity.ts` merges terminal + browser activity into one device signal, rendered as off/idle/working on the rail foot in BOTH densities; 2 mutants caught. §4.2 was re-scoped first (see the Law 3 correction): the merged signal is new and device-scoped, NOT a re-wiring of the browser pulse |
| Path view (post-hoc record) | **done** — `PathView.tsx` + `lib/path.ts`, the third `SessionView`, both densities (`db940aef`); 15 tests. NO branches and it says so: the alternatives are not in the audit trail, so the view refuses to imply they are. Also forced `ViewSwitch.tsx` (one label list for two densities) and exposed + fixed 7 more dark-mode contrast failures (`e5696809`) |
| Control plane (Law 2's mechanism) | **PARTLY BUILT** — §D5 (the hold + `human_in_control`, distinct from `session_busy`) shipped; §D1 capability scopes, §D3 boundary pause + `stopping`, and §D4 durable decisions remain proposals. What shipped is COORDINATION, not enforcement: `terminal_write` is ungated by design, so an AI that ignores the handover can still type raw bytes — documented on `term_set_control` rather than oversold |

Two notes on the completed items, both about VERIFICATION rather than code:

1. The dark-mode defect passed a hand-built visual gallery, because that gallery
   redefined the CSS variables itself instead of using the app's real
   `body[data-theme="dark"]`. A verification method that supplies its own inputs
   verifies nothing. It was found only by rendering the real markup under the
   real selector.
2. The first fix for it also failed — `--surface-recessed: var(--bg)` declared
   only in `:root` freezes against the light theme, because custom properties
   inherit as computed values. Re-measurement caught it (still 1.12); the test
   now pins the restatement, and removing it fails 2 of 3 assertions.

Both are instances of the same discipline this document argues for: state what
was MEASURED, and make the pin fail before trusting it.

## 9. Relationship to other documents

- `docs/adr/proposal-control-path.md` — the mechanism for beat 3 and Law 2.
  This document is the parent: it says WHY those states and that loop exist.
- `docs/adr/0010-two-products-one-repository.md` — the agent must be a complete
  product without the gateway, which is what makes panel onboarding matter.
- `docs/ARCHITECTURE.md` — module boundaries. This document changes no
  boundary; Law 1's fix stayed inside `styles/`.

## Vocabulary note

Per `docs/agents/domain.md` there is no root `CONTEXT.md` (absent is expected).
This document uses `beat`, `law`, `path`, `gate`, `recipe` — none of which the
repo has a glossary for. Flagged as a domain-modeling gap rather than invented
silently; `path` and `gate` are the two that will reach test names and API
fields, so they should be settled before any of §4 is built.
