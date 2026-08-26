# Proposal: Interactive remote browser embedded in the panel (round-134)

## Goal
An operable remote browser embedded in the panel: multiple tabs, real click/keyboard input, persistent login state — replacing read-only screenshot polling.

## Architecture draft
- Screen stream: the agent pushes frames via CDP Page.startScreencast, the panel renders them on a canvas, WebSocket /api/browser/ws
- Input injection: panel coordinates/key events → WS → CDP Input.dispatchMouseEvent/KeyEvent
- Multiple tabs: CDP Target API + a panel tab bar
- Login state: persistent user-data-dir (shared with or migrated from playwright-mcp)
- Security: reuse TokenGate; first-frame WS authentication

## Milestones
1. M1 single tab: screencast stream + mouse/keyboard injection (usability loop closed)
2. M2 multiple tabs + navigation/back/download indicators
3. M3 page-lock coordination between AI operations and human input
