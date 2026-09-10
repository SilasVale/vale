# ADR 0010: Two products, one repository — decouple the agent from the gateway, do not split the repo

Status: **Adopted 2026-09-10** ｜ Scope: repo topology (`agent/` + `gateway/`) ｜
Extends [ADR 0003](0003-repo-topology-and-brand.md) (three repos by audience) to the
question it did not answer: should the two halves *inside* `vale` be separated?

## Background

The question was asked twice in one session, in two forms: "can the two products be
independent?" and then "does that need two repositories or one?". Those are different
questions with different answers, and conflating them is what makes the decision look
harder than it is.

ADR 0003 already settled repo topology by **audience**, and placed the gateway and the
agent on the SAME side of that line: `vale` = "Platform runtime … users and devices".
It rejected a merge in the opposite direction (deploy into vale = credential isolation
breaks; forge into vale = unrelated release cadences). So the standing rule is
audience-based, and both halves of `vale` serve one audience.

## Measurement

Commit co-touch, over the whole history (2221 commits):

| Touches | Commits | Share of the 1921 that touch either half |
|---|---|---|
| `agent/` only | 1279 | 66.6% |
| `gateway/` only | 518 | 27.0% |
| **both** | **124** | **6.5%** |
| neither (docs / index / scripts / proxies) | 300 | — |

So the two halves are worked on **independently 93.5% of the time**. The 124 co-touches
are not incidental either — they are concentrated in exactly the places a split would
make painful: `index/src/index.js` (release staging), `agent/resources/panel/panel.js`
(embedded build artifact), `agent/Cargo.toml` + `Cargo.lock` (version bumps), and the
device-registration contract (`gateway/src/plugins/devices.ts` ↔ `agent/src/web/mod.rs`).

Source-level coupling is essentially absent: neither side imports the other's files,
they build with different toolchains (cargo-xwin / wrangler), deploy separately, and
run separate test suites.

## The decisive evidence: a test crosses the boundary

```js
// gateway/test/mcp-handler.test.mjs:233
const raw = readFileSync(new URL("../../agent/spec-tools.json", import.meta.url), "utf8");
```

The gateway's contract test **reads a file out of the agent's tree**. It asserts that
every device tool is either registered on the console MCP surface or listed in
`NOT_EXPOSED` with a written reason.

That test exists because of a real incident, recorded in its own header: `tools/call`
resolves a name against the gateway registry BEFORE routing, so a device tool missing
from that registry is **not merely unlisted — it is uncalled**. 21 of 49 tools once sat
invisible with every gate green.

A repo split destroys this test. Recreating it across repositories needs either a CI
step that checks out both repos at matching revisions, or the spec published as a
versioned artifact with its own release discipline. Both are strictly more machinery
than the single relative path that works today, and both are easier to let rot — which
is the failure mode the test was written to prevent.

## Decision

**Keep one repository.** Pursue **product** independence inside it.

Product independence means, concretely:

- **The agent is a complete product with no gateway.** Install it on a Windows machine
  and AI can drive that machine over MCP. This already holds by design: with no console
  configured, `self_register_plan` returns `None` before any network call
  (`agent/src/register.rs` — `let console = console?.trim();`), and `config.yaml` states
  that `console_url` / `download_url` are optional so a purely local install leaves both
  unset.
- **The gateway is a complete product with no agent.** BYOK relay, prefix routing and
  the model registry need no device.
- **Integration is a feature of each, not the identity of either.** Turning the gateway
  off must not turn the agent into a broken product.

Repo independence is a different thing — two repos, two CIs, two release cadences — and
is **not** pursued. The benefit would be cosmetic tidiness; the cost is the contract
test above plus coordination on 6.5% of all commits.

## Real coupling, and what to do with it

Only three coupling points are load-bearing. Everything else measured is either a
default value or a test fixture (the `notagent.saisi.online` / `.evil.example` strings
are R116's suffix-trap fixtures, not production references).

| # | Coupling | Location | Action |
|---|---|---|---|
| 1 | Cloudflared download URL is hardcoded to the saisi CDN | `agent/src/tunnel.rs:73` | Make it configurable — today "purely local + tunnel" is still tethered to one operator's domain |
| 2 | Panel host allowlist hardcodes `agent.saisi.online` + the `dN.agent.saisi.online` shape | `agent/src/web/mod.rs:356` | Make it configurable. Security-relevant; small and self-contained |
| 3 | The tool-surface mirror (`agent/spec-tools.json` ↔ `gateway/src/mcp-tools.ts`) | contract test above | **Keep as is.** This is the coupling that earns its keep |

Deliberately **not** decoupled: `config.yaml`'s `console_url` / `download_url` (defaults,
overridable), the `system` tool's URL fallback, and `page_view`'s page sources (that
tool's purpose is to read those pages).

## Consequences

- Positive: the contract test keeps guarding the incident class it was written for; one
  release flow; no cross-repo revision matching.
- Cost: the repository contains two products with different toolchains, so a newcomer
  must read the README layout table to learn that. Accepted — ADR 0003 already made the
  same trade for a larger set of components.
- Neutral: nothing about this decision blocks a future split. It records the price so
  that split is chosen deliberately rather than drifted into.

## When to revisit

Split the repositories only when one of these becomes true — not before:

1. **Independent release cadences are required.** e.g. the agent ships daily while the
   gateway ships quarterly, and coupling them blocks one of the two.
2. **Different owners.** Separate teams, or separate code-review and access boundaries.
3. **Different compliance or distribution boundaries.** e.g. the gateway must be
   auditable or licensed separately from the Windows binary.

None holds today: same maintainer, same release script, same machine.
