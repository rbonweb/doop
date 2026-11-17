# doop-import

Imports a React team's Storybook into a Doop canvas as components. It renders your stories in a browser on your own machine and uploads the result to a one-time Doop ticket, so your Storybook never has to be reachable from the internet.

It uploads only the rendered HTML and CSS of each component, its props and its variants. Nothing of your source code, your repository or your `node_modules` leaves the machine.

doop-import is not on npm. Your Doop instance serves it: the import picker (the command-line card) and an agent's `create_import_ticket` give you the whole command, which downloads the CLI from `<your Doop>/cli/doop-import-<version>.tgz` and runs it with Node 20.3 or newer. The command carries `--allow-remote=all` because npm 12 refuses to install from a URL without it (older npm just warns that it does not know the flag). The tarball is built with the app (`bun run build`, or `bun run dev`, which packs it once at start; restart `bun run dev` after changing the CLI), and `<your Doop>/cli/doop-import.tgz` redirects to the current one.

## Get a ticket

Open the import picker on a canvas in Doop and choose the CLI, or ask your agent to call `create_import_ticket`. Either gives you a command to run, with the upload URL that works once, for 15 minutes, already in it. The examples below show the same command with `<your Doop>` and `<version>` for what your instance filled in.

Use only a ticket URL you copied from Doop: whoever answers at that address receives your components. A ticket must be `https` (plain `http` is accepted only for this machine, such as a local Doop). It is single use, and because it sits on the command line it shows in the process list of a shared machine, so treat it like a short-lived password.

## Commands

A `storybook build` directory (it is served on `127.0.0.1` at a random port while the import runs):

```bash
npx --yes --allow-remote=all <your Doop>/cli/doop-import-<version>.tgz --storybook ./storybook-static --ticket <upload url>
```

A Storybook dev server running on this machine (`localhost`, `127.0.0.1` or `[::1]`):

```bash
npx --yes --allow-remote=all <your Doop>/cli/doop-import-<version>.tgz --storybook http://localhost:6006 --ticket <upload url> --package @acme/ui
```

A dry run: renders, checks the bundle with Doop and says what would be created or updated. Nothing is written and the ticket stays usable:

```bash
npx --yes --allow-remote=all <your Doop>/cli/doop-import-<version>.tgz --storybook ./storybook-static --ticket <upload url> --dry-run
```

## Flags

- `--storybook <dir|url>` a `storybook build` directory or the URL of a Storybook dev server on this machine. Required. Any other address is refused before a browser starts: a published Storybook goes through the Storybook URL import in Doop's import picker (or an agent's `import_storybook`) instead, where Doop renders it in its own hardened renderer.
- `--ticket <url>` the upload URL. Required unless you only want a file with `--out`.
- `--package <name>` the npm package the components are imported from in code, for example `@acme/ui`. It lets Doop's React export import the real component instead of regenerating it.
- `--include <title>` only the component with this Storybook title, or every component in this folder of titles (`Components/Button` matches `Components/Button` and `Components/Button/…`, not `Components/ButtonGroup`). Repeat it for several.
- `--browser <path>` the browser to render with.
- `--dry-run` check without writing.
- `--out <file>` also write the bundle JSON to a file. With no `--ticket` it only writes the file.

## Which browser

The first of these that is set:

1. `--browser <path>`
2. the `DOOP_IMPORT_BROWSER` environment variable
3. the `CHROME_PATH` environment variable
4. a browser found at one of these usual install paths:
   - macOS: Chromium, Microsoft Edge, Brave
   - Linux: `chromium`, `chromium-browser` (also the snap), `microsoft-edge`, `brave-browser` in `/usr/bin` and `/snap/bin`
   - Windows: Microsoft Edge and Chromium under `Program Files`, `Program Files (x86)` and `%LOCALAPPDATA%`

Google Chrome users pass `--browser` or set `CHROME_PATH` to Chrome's executable; it is not looked for automatically. A path you name is made absolute and must be an executable file; if it is not, that is an error and it never falls back to a different browser. If none is found, the error says how to point at one. Any Chromium-based executable works, headless shell builds included.

With no browser to point at, install a standalone one: `npx @puppeteer/browsers install chrome-headless-shell@stable`, then pass the path it prints to `--browser`.

## What it does and does not do

- It renders each component's default story, then one render per enum option and boolean to capture variants, inside Doop's limits: 60 components, 400 renders, 20 seconds a render, 10 minutes in all.
- A Storybook that asks for a sign-in is refused: no cookies or credentials are sent.
- Each story renders in a fresh browser context with no cookies. For a `storybook-static` directory, story pages may load the build's own files and public hosts but are stopped from requesting any other loopback, private or link-local address; for a dev server that guard is off, since dev servers call other local ports. The guard is best-effort, not a sandbox: the Storybook is your own code running on your machine with your network access, so only point doop-import at one you trust.
- It sends the bundle gzipped to the ticket and prints what was created, updated or skipped, and anything that could not be captured.
- Run as root (in a container) it starts the browser without its sandbox, as Chromium requires there.
