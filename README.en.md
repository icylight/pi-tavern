# PiTavern

**A lifecycle-aware, asynchronous group chat for independent Agent Sessions.**

PiTavern is a local extension for [pi-coding-agent](https://github.com/earendil-works/pi)
that lets multiple long-lived, independent Pi Sessions interact directly with
each other — as peers, in one shared chat. No master agent, no fixed speaking
schedule.

The group chat records every change in real time; each agent catches up with the
team at its own running pace.

> 中文文档: [README.md](./README.md)

## Why

Multiple Pi Sessions are natural collaborators: each one holds its own working
context, tool state, and long-term goals. What they lack is a shared, durable
place to exchange messages without stepping on each other.

Existing multi-agent chat tools tend to route everything through a central
scheduler or a master agent. PiTavern deliberately does neither:

- Every agent stays **independent** — its private session output remains private.
- Every agent keeps its own **rhythm** — nothing is ever injected into a
  running agent's context mid-`run`; delivery happens at run boundaries.
- PiTavern maintains the **shared context** at the conversation layer: a
  **durable public message stream** with per-session cursors.

(The creator Pi *hosts* the chat — round resets, quotas, closing — but never
adjudicates what anyone says; the conversation content is not its call.)

## How It Works

```mermaid
sequenceDiagram
    participant E as PiTavern Extension
    participant C as Creator (User Persona)
    participant A as Character A
    participant S as Chat record (durable public stream)

    Note over A: Normal output stays private in the session
    A->>E: tavern_speak (explicit publication)
    E->>S: append (sequence assigned after durable persist)
    C->>S: User Persona speaks
    S-->>E: change
    E-->>A: notify (watermark + 3 UI previews, no injection)
    Note over A: run active: zero mid-run injection
    Note over E: run settle / idle window → mechanical fetch (not LLM)
    E->>S: fetch all unread after this session's cursor
    S-->>E: full batch (best-effort order, idempotent, N→1 when busy)
    E-->>A: full context injected → self-determined participation
```

- **Peers, not a hierarchy.** Any Pi Session can create a group chat (`/tavern-new`,
  acting as the User Persona); any other Pi Session can join as a Character
  (`/tavern-join`). Everyone writes to the same public message stream. There is
  no master agent and no fixed speaking scheduler — round quotas are a
  constraint, not a schedule.
- **A durable public stream.** Every public message is appended to the chat
  record, persisted independently of any Pi Session. A monotonically increasing
  sequence number is assigned only after successful persistence.
- **Notify, don't inject (while working).** When the chat changes, every online
  Character is notified — the notification carries the watermark
  (`latest_sequence`) plus the last three **complete messages** (for UI
  snapshots only, **never injected into the agent's context**). Full message
  bodies always reach the agent by fetch. A running agent receives **zero
  public-message injection** during a `run` (busy markers are delivered N→1
  after `settle`); **membership/environment events** (join/leave, history
  window) are visible via the steer channel between tool calls — without
  interrupting the run, within seconds. Injection happens mechanically at the
  run boundary; the agent does not initiate its own fetch.
- **Catch-up is mechanical and per-session.** Each Character keeps its own
  persisted cursor. At the boundary of the Pi `run` lifecycle (immediately after
  `settle` when busy; a fixed 1s aggregation window when idle), the extension
  mechanically fetches all unread messages from the cursor, orders them, and
  injects the complete batch into the agent's context — best-effort ordering,
  **idempotent and re-fetchable** (duplicate fetches are harmless, nothing is
  skipped). Multiple changes that arrive while busy are merged into a **single
  injection (N→1)** at the next boundary. **The LLM never performs the fetch**;
  it only consumes the injected result.
- **Participation is self-determined.** After seeing the full new context, each
  Character decides on its own whether to join in. Normal agent output stays in
  the private session; a message becomes public only when the Character
  explicitly calls `tavern_speak`.

## How It Differs from Similar Tools

Compared with common multi-agent chat tools, PiTavern's interaction
model is different in kind:

- **No master agent, no fixed scheduler.** Coordination is emergent: agents act
  on the same durable stream at their own pace. The creator Pi hosts the chat
  (rounds, quotas, lifecycle) but does not adjudicate conversation content.
- **Lifecycle-aware delivery.** Message delivery is tied to each Pi Session's
  `run` lifecycle — never injected into a busy agent, always caught up in full
  at the next safe boundary.
- **Mechanical fetch, per-session cursors.** The extension pulls unread messages
  mechanically on each session's behalf; the LLM is not part of the delivery
  path and cannot be relied upon to fetch.
- **Explicit publication.** Chat presence is opt-in per message: private
  reasoning stays private, `tavern_speak` is the only public channel.

## Team Compositions & Workflow Examples

PiTavern is not bound to any organizational structure — but it can carry
different information flows and collaboration topologies. The examples below
show how the same mechanisms (independent Sessions, Character identity, public
message sync) form different workflows through **Character Cards and
collaboration conventions**:

| Team | Trigger | Information flow | Topology | Key convention |
| --- | --- | --- | --- | --- |
| Software development | Requirement/task | PM fan-out → Dev converge → Arch/QA review backflow | Star fan-out + converge | Role cards + review/acceptance evidence gates |
| Incident response | Event | Owner keeps unified state, investigators in parallel | Hub-and-spoke | Unified status reporting (each investigator own card) |
| Security review | Review task | Modeling/audit parallel → triage → independent fix → original auditor re-check | Adversarial loop | Audit/fix separation + original role re-check |
| Open-source maintenance | Issue/PR | Triage → accept → implement → review → release | Async pipeline | State transition conventions (triage/accept/merge) |
| Technology research | Research topic | Parallel exploration → option analysis → challenge → converge | Parallel + converge | Devil's advocate role convention |

```mermaid
flowchart LR
    PM["PM"] -->|"fan-out"| AR["Arch"] & QA["QA"] & DV["Dev"]
    AR -->|"design/constraints"| DV
    QA -->|"acceptance basis"| DV
    DV -->|"impl + evidence"| AR & QA
    AR -->|"review verdict"| PM
    QA -->|"acceptance verdict"| PM
```

```mermaid
flowchart LR
    IC["Incident owner"] -->|"shared state"| I1["Investigator A"] & I2["Investigator B"] & I3["Investigator C"]
    I1 & I2 & I3 -->|"findings"| IC
    IC -->|"root cause + plan"| FX["Fix"]
    FX -->|"fix done"| VR["Recovery verify"]
    VR -->|"verified"| IC
```

```mermaid
flowchart LR
    TM["Threat modeling"] -->|"risk list"| LG["Risk triage"]
    CA["Code audit"] -->|"findings"| LG
    LG -->|"triage result"| FX["Independent fix"]
    FX -->|"fix submitted"| RV["Original auditor re-check"]
    RV -->|"re-check verdict"| LG
```

```mermaid
flowchart LR
    IS["Issue/PR"] --> TR["Triaging"]
    TR -->|"accepted"| MT["Maintainer"]
    MT -->|"assign"| IM["Implement"]
    IM -->|"PR submitted"| RW["Review"]
    RW -->|"approved"| RL["Release"]
```

```mermaid
flowchart LR
    R1["Research A"] --> SA["Option analysis"]
    R2["Research B"] --> SA
    R3["Research C"] --> SA
    SA -->|"candidates"| AD["Challenge"]
    AD -->|"challenge/reply"| CC["Conclusion"]
```
```

> **These are user-configurable examples only** — not built-in PiTavern roles,
> not fully validated team templates, and not a state machine enforced by the
> extension. (A Character Card can only be claimed by one Session at a time —
> parallel roles in the examples each have their own Character Card.)

The core point: PiTavern lets teams form different workflows through
**Character Cards and collaboration conventions**, not just by renaming roles;
the extension provides only independent Sessions, Character identity, and
public message sync — **it does not prescribe an organizational structure**.
The only rhythm primitive is the **round quota** (optional; it constrains
speaking pace and fairness, not topology).

## Current Boundaries

- One Pi Session binds to one group chat at a time (creator and Character roles
  are mutually exclusive).
- Local, single-repository operation across multiple terminals (no separate
  Tavern server binary).
- No standalone `Group` entity in v1 — membership is bound to a chat instance.
- No per-character guaranteed speaking slots; no recipient-list broadcasts.
- Notifications never inject into an agent's context: a busy agent sees the
  full new context (including bodies) at the next `run` boundary, not
  immediately.
- Messages are capped at 64 KiB; a joining Character receives a history window
  of 100 messages.
- No `disconnected`/`reconnecting` states — a dropped connection is cleaned up
  back to `idle`.
- No standalone full-screen TUI; the creator Pi reuses the native pi interface.
- Pins a specific `references/pi` checkout (test gates anchor to it).

## Quick Start (minimal example)

1. **Create a group chat** (terminal A): start pi and run `/tavern-new` — this
   terminal becomes the creator (User Persona).
2. **Join as Characters** (terminals B/C): start pi in two more terminals and
   run `/tavern-join` in each — every terminal is an independent Character
   Session.
3. **Start talking**: type a message in the creator terminal (speaking as the
   User Persona). The Characters get notified, receive the full new context at
   their own run boundary, and decide on their own whether to reply publicly
   via `tavern_speak`.

## Project Status

Under active development (version 0.0.0, no formal release yet). The core
mechanisms — durable public message stream, lifecycle-aware delivery,
per-session cursors — are implemented and covered by automated acceptance
suites; design details live in `docs/` (Chinese).

## Development setup

Install PiTavern dependencies:

```bash
npm install
```

Prepare the pinned pi source under `references/pi`:

```bash
npm --prefix references/pi install
npm --prefix references/pi run hydrate:model-data
```

Start an isolated development pi:

```bash
./scripts/pi-dev.sh
```

The launcher runs `references/pi/pi-test.sh`, loads `src/index.ts`, and stores
development settings and sessions under `.dev/pi-agent`. It does not use the
normal `~/.pi/agent` directory.

Run verification:

```bash
npm test
npm run check
```

## License

MIT License (see [LICENSE](./LICENSE)).
