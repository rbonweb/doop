# Doop on your own server

One script installs Doop on a server that has Docker, and manages it afterwards.
It runs three containers: the app, its Postgres, and Caddy, which gets the HTTPS
certificate. If the server already has a web server on ports 80 and 443, Caddy is
left out and you point that server at Doop instead.

## Before you start

- A Linux server with Docker and its Compose plugin (`docker compose version` works).
  At least 2 GB of RAM.
- A subdomain, e.g. `doop.yourbrand.com`, whose DNS **A record points at the server**.
- Ports 80 and 443 open in the server's firewall.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/rbonweb/doop/main/deploy/doop.sh | sudo bash
```

It downloads Doop's latest release into `/opt/doop` and asks for:

1. **The address**: `https://doop.yourbrand.com`.
2. **Who may sign up**: any email addresses, comma-separated. Nobody else can create an account.
3. **Your email**, then a name and password: this becomes the admin account.
4. **An Anthropic API key** for the built-in agent (optional), and a custom base URL if your key
   is for a proxy or compatible endpoint.

It generates the secrets itself (`BETTER_AUTH_SECRET`, the database password) and keeps them in
`/opt/doop/deploy/.env`, readable by root only. To run it without questions, set the answers in the
environment first; the comment at the top of `doop.sh` lists them.

## Day to day

All commands are `sudo /opt/doop/deploy/doop.sh <command>`:

| Command                  | What it does                                                              |
| ------------------------ | ------------------------------------------------------------------------- |
| `invite a@x.com b@y.com` | Lets these addresses sign up (restarts Doop for a few seconds)            |
| `admin a@x.com`          | Makes that account an admin; creates it, asking for a password, if needed |
| `update`                 | Backs up the database, then installs the latest release                   |
| `update v0.7.0-fork.2`   | Installs that release instead (to go back to an earlier one)              |
| `backup`                 | Saves the database to `/srv/doop/backups` (also runs every night)         |
| `status`, `logs`         | What runs and which release; the app's logs                               |

Nobody verifies that an invited address belongs to the person you meant (there is no mail server),
so tell people to sign up as soon as you invite them.

### Admins

An admin sees every canvas and account on the instance, can open any canvas read-only ("View as"),
can ban accounts, and can install updates. Setup makes your account the first admin. Make more with
`doop.sh admin someone@example.com`. Doop's own `ADMIN_EMAILS` setting needs a mail server to prove
who owns an address, so this server does not use it; `doop.sh admin` does the same from the command
line, which only you can reach.

## Updates

Every commit on `main` that passes CI is released by `.github/workflows/fork-release.yml`: a GitHub
release and an image `ghcr.io/rbonweb/doop:<tag>` (tags look like `v0.7.0-fork.3`: Doop's version,
then this fork's build number).

The Admin page shows the running version and, when a newer release exists, **Update now**. Pressing
it leaves a request in `/srv/doop/updates`; a systemd unit on the server (`doop-update.path`) sees it,
backs up the database, pulls the new image and restarts Doop. If the new version does not start, the
previous one is put back. The app itself never controls Docker; it can only ask for the latest
release. Follow an update with `journalctl -u doop-update -f`.

The first time, check two things on GitHub:

- **Actions are enabled** on the fork (the Actions tab asks once).
- **The package is public**, so the server can pull it without logging in: after the first release,
  open the `doop` package on your GitHub profile, then Package settings, Change visibility, Public.
  While it cannot be pulled, the server builds the release itself, which works but takes 5-10 minutes.

## Search engines

`DOOP_NOINDEX=1` (set by setup) sends `X-Robots-Tag: noindex, nofollow, noarchive` with every
response and stops publishing a sitemap, so search engines leave the instance out of their results.

## Your own web server instead of Caddy

When ports 80/443 are taken, setup leaves Caddy out and Doop listens on `127.0.0.1:4400`. For nginx:

```nginx
server {
    listen 443 ssl;
    server_name doop.yourbrand.com;
    # ssl_certificate ... (as for your other sites)

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:4400;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;     # live canvases use a WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
    }
}
```

## Where things are

| Path                    | Holds                                    |
| ----------------------- | ---------------------------------------- |
| `/opt/doop`             | The code, at the installed release       |
| `/opt/doop/deploy/.env` | Settings and secrets                     |
| `/srv/doop/data`        | Uploaded images and frame thumbnails     |
| `/srv/doop/postgres`    | The database                             |
| `/srv/doop/backups`     | Nightly database dumps, kept for 14 days |
| `/srv/doop/caddy`       | HTTPS certificates                       |

Copy `/srv/doop` somewhere else from time to time; it is everything Doop keeps.
