# Sharing and roles

A canvas is private by default: only its owner, the people they invite and, on a team plan, the members of its workspace can open it.
Everyone who can open a canvas holds one of three roles, and agents connected over MCP act with exactly the role of the account behind their key.

## Roles

| Role      | Can do                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `view`    | Open the canvas, see frames, comments and presence, follow people, present, export images, copy a frame as an image.    |
| `comment` | Everything in view, plus create, reply to and resolve comments, and `@mention` people.                                  |
| `edit`    | Everything else: change frames, pages, notes and style guides, restore version history, and ask agents to make changes. |

The owner holds all of this and manages sharing.
People below edit see a read-only canvas: no inspector, drag, resize, prompt bar or delete, and a "View only" or "Can comment" badge in the header.
Version history needs edit, because an old version can hold content the editors have since removed.

## Share modal

Open **Share** on a canvas.

- **Invite by email** with a role per person.
  An invite with no role keeps `edit`, as invites always did.
- **Link access** sets the floor everyone with the link gets: No access, Can view, Can comment or Can edit.
- **Email domains** grant a role to everyone with a verified address on a domain, for example `@acme.com` at Can view.
  Without SMTP nobody is verified, so domain grants do nothing on an instance with no mailer.
- **Access requests** list the people who asked to get in.
  Approve one and pick the role, or decline it; a decline is silent.

## Who can use the link

Link access has three audiences.

- **Anyone signed in to doop** is the default.
  The visitor needs an account.
- **Anyone with the link, no sign-in** lets a signed-out guest open the canvas.
  Guests are capped at comment, whatever the link role says: they can look and comment under a name they pick once, reply to threads and see presence, but never edit or resolve.
  Guest comments carry a "(guest)" suffix and are rate limited per IP and per canvas.
- **Anyone with the password** puts the link behind a password of 8 to 200 characters.
  A correct password sets a cookie for that canvas that lasts 30 days.
  Changing or removing the password signs everyone out of the canvas, including connected guests.
  Wrong guesses are limited per IP and canvas.

MCP stays authenticated-only: a guest link or a password never admits an agent.

## Requesting access

A person without access sees a no-access page with a request form.
The owner gets an email and, if online, a live toast, and sees the request in the Share modal.
There is one pending request per person and canvas, and pending requests expire after 30 days.

## People @mentions

Type `@` in the comment composer to pick from the people who can view the canvas, next to the agent roles.
A mentioned person joins the thread's email recipients, respecting their notification opt-out, and sees a toast and a pulsing pin if they are online.
The server drops any mention of someone who cannot view the canvas.
An `@agent` mention from a person below edit is kept as a plain comment, because the agent would otherwise edit frames for someone who cannot: the composer answers "Only editors can ask agents to make changes."

## For agents

Every MCP tool checks the role of the account behind the key.
Reads need view, `add_comment`, `reply_to_comment` and `resolve_comment` need comment, and everything that writes needs edit; so do `list_frame_versions` and `restore_frame_version`.
A canvas the account cannot see answers like a missing one.
