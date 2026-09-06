# ADR 0006: Retire Vale Studio — code-server becomes the code-viewing surface

Status: Adopted ｜ Date: 2026-09-06 ｜ Scope: `studio/` (removed), `extension/`, operator tooling

## Background

Vale Studio was a self-built, minimal browser workspace (~1000-line Node server +
lib/{fsapi,pty,auth,watch,terminals}.mjs + a zero-build Monaco/xterm frontend) serving
code editing, terminals (tmux-persisted), git, and search on `code.saisi.online`. It was
built for auditability: a surface small enough to read line by line on a machine that
also runs the credentialed AI agent.

Usage evidence gathered across the 2026-09 review rounds shifted the calculus:

- The editor (Monaco) had a structural ceiling: no LSP, no command palette, no split
  view, no diff editor — every gap was a step toward reimplementing VS Code.
- The operator wanted the WHOLE `/home/zhengsaisi` workspace; studio's design centred
  on server-enforced path confinement to declared roots.
- Terminal telemetry showed the 32 tmux sessions idle for ~28 h (created in one burst,
  plain bash, no running jobs) — terminal persistence was less load-bearing than assumed.
- The maintenance cost was real and permanent: four review rounds produced fixes (WS
  broadcast backpressure, viewer cap, tmux adoption cwd slip, auth module extraction,
  readOnly coverage) that a mature project ships out of the box.

## Decision

1. **Adopt code-server** as the code-viewing/editing surface: installed standalone in
   `~/.local/`, running under pm2, workspace = the whole home directory, reachable at
   `vscode.saisi.online` through the existing cloudflared tunnel.
2. **Auth = double gate**: a Cloudflare Access application (email-allowlisted) in front,
   plus code-server's own password. The extension holds no token any more — its API
   probe layer (roots/stat) died with studio.
3. **Retire studio**: pm2 process deleted, the 32 idle tmux sessions killed, the
   `studio/` directory removed from the repository, build/CI/docs references cleaned.
   The 41-test suite and all lib/ modules are preserved in git history.
4. **Extension** keeps the DSH path-rewriting feature in a simplified form: paths link
   to the file's FOLDER in code-server (`/?folder=<abs>`). Line-level jumps are not
   addressable via VS Code web URLs — the line number rides in the link tooltip.

## Alternatives Considered

- **Improve studio incrementally** (diff editor, better tabs, LSP bridge): rejected —
  it is a step-by-step rebuild of VS Code with a permanent maintenance tax.
- **Keep both** (code-server for editing, studio for deep links): rejected — two
  surfaces for one job, and studio's deep-link value (file+line) is worth less than
  the surface it keeps alive.
- **code-server over a unix socket**: the tunnel is DASHBOARD-managed and its public
  hostname configuration does not accept unix sockets; code-server binds TCP
  127.0.0.1:7739 instead (operator-configured). Access remains the outer boundary.

## Consequences

- One less pm2 process, one less test gate, one less surface in every security
  regression round; ARCHITECTURE.md drops the studio rows.
- `code.saisi.online` (tunnel ingress → studio's 7780) is now dangling — verified
  post-retirement: it answers with its OWN Cloudflare Access login (302, separate
  aud), so there is no unauthenticated exposure; an authenticated user sees an
  origin error. Remove the public hostname + Access app in the dashboard at leisure.
- The extension needs no tokens; the code-server password + Access SSO are entered in
  the browser once per session as usual.
- Rollback: `git revert` this decision's commits and restore the studio tree from
  history — the retirement is a pure deletion with no schema or data migration.
