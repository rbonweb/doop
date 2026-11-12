# doop - plans Index

Complete record of `.context/plans/`. This file is NOT @-imported by CLAUDE.md; it is reached by
link from [../INDEX.md](../INDEX.md), so it costs nothing until someone opens it, which is why it
lists every file in this folder.

## Active

Plans that have been built. They stay as the record of why, with a "What changed from this plan" section where the build differs.

- [marver-inspired-upgrades.md](marver-inspired-upgrades.md) - Built in the `feat/marver-upgrades` PR: comment pins that survive edits, "new" and "needs you" marks with the `u` key, prototype links with present and slides modes, a keyboard pack (copy as image, laser, device sizes, tidy), an agent guide upgrade with resident prompt hardening, frame version history, view/comment sharing with domain grants, access requests and people @mentions, and pausing frames at rest. Ends with what changed from the plan (guest and password links, speaker notes and deck PDF, sticky notes, nested pages).
- [image-descriptions.md](image-descriptions.md) - Three phases, test-first: storage and the describer worker, the agent read paths (`get_canvas`, `get_frame`, the resident kickoff), the Settings → Agents switch.

## Pending

Plans written and waiting to be picked up. Nothing in them is built yet.

- [pending/agent-speed.md](pending/agent-speed.md) - Faster agent work in Doop, from a measured baseline: cached and croppable `/i/` renders without agent 429s, region snapshots to assets, `duplicate_frames`, section-level read and patch tools, measure and lint, better screenshots, search and bulk edits, layout helpers, claims and version checks, section composition, image provenance, lighter responses and batch calls.
- [pending/shared-style-guides.md](pending/shared-style-guides.md) - Style guides kept on a
  workspace (or a personal space) that every canvas in it reads, with per-canvas overrides: data,
  API, MCP `scope`, Memory panel and Workspace page, and a test-first task list.
