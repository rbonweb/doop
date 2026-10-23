# Sharing roles, access requests and guest links

Why: a canvas used to be all-or-nothing (edit, or no access), which made it unsafe to send a design to a stakeholder who should only look or leave feedback.
Roles bound what a person, and the agents acting as them, can do.

## Roles

`CanvasRole` is `owner | edit | comment | view`, ranked in `ROLE_RANK` (`shared/types.ts`).
`canvasRole(user, canvas, ctx)` in `server/access.ts` returns the highest role from these sources, or null:

- The owner is `owner`. A banned account gets null whatever else is true.
- Workspace members of the canvas workspace get `edit`.
- Members get their stored role (`memberRoles`); an invite with no stored role keeps `edit`, as invites always did.
- Domain grants (`@acme.com` at a role) apply to a verified email on exactly that domain. With no SMTP configured nobody is verified, so grants are inert.
- The share link floor (`linkAccess`) applies to any signed-in visitor, unless `linkAudience` is `password` and the visitor holds a valid unlock cookie.
- A signed-out visitor goes through `guestRole`: only when `linkAudience` is `anyone` (or `password` with a valid cookie), capped at `comment`. Ownerless legacy canvases are never public.

`canView`, `canComment` and `canEdit` read the resolved role. `canAccessCanvas` is an alias of `canView`. `canManageCanvas` stays owner or admin. `hasDurableCanvasAccess` ignores the link floor (used for background work such as automations and sync keys).

## Enforcement

- REST: every route in `server/index.ts` resolves a minimum role through `requireCanvas(req, res, id, min)` and `requireFrame`. Reads need view, comments, replies, resolve and chat need comment, everything that changes the design or its settings needs edit. Renaming needs edit; sharing settings need the owner.
- WebSocket: the join resolves the role and the `init` payload carries it. View-only sockets get a reduced payload (no chat or task log) and only whitelisted broadcasts. `frame:drag` re-resolves edit on every message and answers a refused one with `{type:'error'}` to that socket only, never a broadcast. When sharing changes `refreshRoomAccess` re-resolves every socket: it sends `{type:'role'}` on change or closes with 4403 when access is lost.
- MCP: every tool resolves the role of the account behind the key through `canvasFor` and `frameFor`. Reads need view, comment tools need comment, writes need edit. A stranger gets the same answer as a missing canvas. Password links never admit agents.
- Resident agents: an `@agent` mention from a person below edit stores a plain comment and returns "Only editors can ask agents to make changes."; the agent is never queued. Local-agent and Gemini cloud runs need edit.

## Access requests

A person without access sees a no-access page with a request form. One pending request per user and canvas (idempotent). The owner gets an email through `server/mailer.ts` and a live toast, and sees the list in the Share modal with Approve (choose a role) and Decline. Declining is silent. Requests expire after 30 days (`expireAccessRequests` runs at boot and every six hours).

## People @mentions

The composer offers people who can view the canvas (`GET /api/canvases/:id/people`, no addresses) and the agent roles. The client sends ids; the server keeps only ids that can view the canvas and whose `@name` appears in the text, and drops the rest. Mentioned people join the recipients in `server/commentNotifications.ts` (respecting the opt-out), and a connected one gets a `mention` message: a toast and a pulse on the pin.

## Guest links (`linkAudience = 'anyone'`)

A signed-out visitor opens the canvas at the link role, capped at comment. The page asks for a name once and keeps it in localStorage. Guest comments are posted through `/api/public/...`, stored with `fromName` ending in " (guest)" and no `fromUserId`, and limited to 6 per minute and 40 per hour per IP (and 150 per hour per canvas). Guests can reply but not resolve. They join the WebSocket for presence and cursors only (120 messages per second). MCP stays authenticated-only.

## Password links (`linkAudience = 'password'`)

The owner sets a password of 8 to 200 characters. It is stored as `scrypt$N$salt$hash` (random 16-byte salt) and compared with `timingSafeEqual`. A correct password at `POST /api/public/canvas/:id/unlock` sets an HttpOnly, SameSite=Lax cookie (Secure over https) scoped to that canvas, signed with HMAC over the canvas id and a fingerprint of the password hash, valid for 30 days. Changing or removing the password invalidates every cookie and closes connected guests. Attempts are limited to 8 per 10 minutes per IP and canvas, and an unknown canvas answers like a wrong password.

## Tradeoffs

- `get_feedback`, `set_status` and `save_decision` need edit because they change state.
- Member addresses are hidden from non-owners.
- Sync keys minted before a role downgrade stay valid until revoked.
- Rate limits are per process and reset on restart.
