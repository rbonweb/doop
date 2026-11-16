# Running Doop on your own server

This guide installs Doop on a Linux server that has Docker, and covers everything after: the admin
account, inviting people, choosing models, updating, backups, and changing settings.

What you get:

- Doop on your own subdomain with HTTPS, e.g. `https://doop.yourbrand.com`.
- No public sign-up: accounts come only from invite links an admin makes.
- An admin account, made during the install.
- Model names you can change any time from the Admin page.
- A database backup every night.
- **Update now** on the Admin page, which installs the latest release.
- No search engine indexing.

It runs three containers: Doop, its Postgres database, and Caddy, which handles HTTPS. Everything
is managed by one script, `/opt/doop/deploy/doop.sh`.

**Contents:** [First release](#1-once-on-github-publish-the-first-release) ·
[Prepare the server](#2-prepare-the-server) · [Install](#3-install) ·
[Install on Dokploy](#3b-install-on-dokploy) · [Admins](#4-admins) ·
[People](#5-people) · [Models](#6-models) · [Updating](#7-updating) · [Backups](#8-backups) ·
[Changing settings](#9-changing-settings) · [Claude Code](#10-connect-claude-code) ·
[Krova Cloud](#11-behind-krova-clouds-domain-mapping) ·
[Your own web server](#12-your-own-web-server-instead-of-caddy) · [Commands](#13-all-commands) ·
[Where things are](#14-where-things-are) · [Troubleshooting](#15-troubleshooting) ·
[Uninstall](#16-uninstall)

## 1. Once, on GitHub: publish the first release

Servers install ready-made images that GitHub builds, so the first release has to exist before
the server can use one.

1. Open the fork on GitHub, go to the **Actions** tab, and enable workflows.
2. In **Actions**, choose **Fork release** and click **Run workflow** (branch `main`). It takes
   about 10 minutes and publishes the release `v0.7.0-fork.1` and the image `ghcr.io/rbonweb/doop`.
3. Make the image public, so servers can download it without logging in: your GitHub profile,
   **Packages**, **doop**, **Package settings**, **Change visibility**, **Public**.

After that, every push to `main` that passes CI publishes the next release by itself
(`v0.7.0-fork.2`, `v0.7.0-fork.3`, and so on; the first part is Doop's own version).

If you skip this, the install still works: the server builds Doop itself, which takes 5-10
minutes each time.

Releases are built for ordinary (x86) servers. For an ARM server, add the repository variable
`IMAGE_PLATFORMS` with the value `linux/amd64,linux/arm64` (Settings, Secrets and variables,
Actions, Variables) before running the workflow.

## 2. Prepare the server

- **Linux with at least 2 GB of RAM.** Ubuntu or Debian is simplest.
- **Docker** with its Compose plugin, plus git and curl. If they are missing:

  ```sh
  curl -fsSL https://get.docker.com | sudo sh
  sudo apt install -y git curl
  ```

- **DNS:** add an **A record** for your subdomain (e.g. `doop.yourbrand.com`) pointing at the
  server's public IP address.
- **Firewall:** open ports **80** and **443** (with ufw: `sudo ufw allow 80/tcp` and
  `sudo ufw allow 443/tcp`).

On **Krova Cloud** (or another host whose domain mapping handles HTTPS for you), skip the DNS and
firewall steps: see [Behind Krova Cloud's domain mapping](#11-behind-krova-clouds-domain-mapping).

## 3. Install

```sh
curl -fsSL https://raw.githubusercontent.com/rbonweb/doop/main/deploy/doop.sh | sudo bash
```

It downloads the latest release into `/opt/doop` and asks:

| Question                     | Example                           | Notes                                                                                                        |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The address people will open | `https://doop.yourbrand.com`      | The full address, starting with `https://`                                                                   |
| Your email                   | `you@gmail.com`                   | Becomes the admin account. Everyone else joins through an invite link                                        |
| Your name and a password     |                                   | At least 8 characters, typed twice                                                                           |
| Anthropic API key            | `sk-ant-...`                      | Optional, for Doop's built-in agent. Press Enter to skip                                                     |
| Anthropic base URL           | `https://llm-proxy.yourbrand.com` | Only if your key is for a proxy or compatible endpoint                                                       |
| Model names                  | `claude-opus-5`                   | Asked with a key. Enter keeps the default; change them any time later                                        |
| How HTTPS reaches the server | `caddy`                           | `caddy` (Caddy here gets the certificate), `edge` (Krova Cloud's domain mapping), or `own` (your web server) |

Then it:

1. generates the secrets (the sign-in secret and the database password),
2. downloads the release image, or builds it when none can be downloaded,
3. starts Doop, Postgres and Caddy (Caddy gets the HTTPS certificate),
4. creates your admin account,
5. sets up the nightly backup and the updater behind **Update now**.

When it says **Doop is running**, open your address and sign in.

The answers and secrets are saved in `/opt/doop/deploy/.env`, which only root can read. Keep it
private, and never post it anywhere.

<details>
<summary>Installing without questions</summary>

Give every answer in the environment (an empty value skips the optional ones):

```sh
curl -fsSL https://raw.githubusercontent.com/rbonweb/doop/main/deploy/doop.sh | sudo \
  DOOP_URL=https://doop.yourbrand.com \
  DOOP_ADMIN_EMAIL=you@gmail.com DOOP_ADMIN_NAME="Your Name" DOOP_ADMIN_PASSWORD='a long password' \
  DOOP_ANTHROPIC_KEY= \
  bash
```

With a key, also set `DOOP_ANTHROPIC_BASE_URL` (empty for Anthropic itself), `DOOP_AGENT_MODEL` and
`DOOP_DISTILL_MODEL`.

</details>

## 3b. Install on Dokploy

[Dokploy](https://dokploy.com) is a panel that runs Docker services on your own server. You get what [section 3](#3-install) installs: your own address with HTTPS, no public sign-up, an admin account, model names you can change on the Admin page, and no search engine indexing. Doop runs there with three differences:

- Dokploy's Traefik answers on ports 80 and 443 and gets the HTTPS certificate, so Doop's Caddy is left out.
- **Update now** works through the service's deploy webhook instead of the `doop-update` service on the host.
- Backups are made by Doop itself, before every update and every night, because Dokploy has no host cron to run `doop.sh backup`.

Everything else is the same: no public sign-up, an admin account, no search engine indexing, model names you can change on the Admin page. You manage the server from Dokploy's dashboard instead of with `doop.sh`, so the commands in [section 13](#13-all-commands) do not apply here.

**1. Make the image public.** Follow step 3 of [section 1](#1-once-on-github-publish-the-first-release): Dokploy downloads the image from GHCR, so it must be public.

**2. Create the Compose service.** Open your project in Dokploy (create one if this is its first service), press **Create Service**, choose **Compose**, and name it `doop`. On the service's **General** tab set **Provider** to **Raw**, then paste the contents of [`deploy/dokploy/docker-compose.yml`](dokploy/docker-compose.yml) from this repository.

**3. Fill the Environment tab.** Paste this and replace the values:

```sh
BETTER_AUTH_URL=https://doop.yourbrand.com
BETTER_AUTH_SECRET=<openssl rand -base64 32>
POSTGRES_PASSWORD=<openssl rand -hex 24>

# optional: Doop's built-in agent
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=
DOOP_AGENT_MODEL=
DOOP_DISTILL_MODEL=
```

- The service follows the newest release (the image's `latest` tag). Add `DOOP_TAG=v0.7.0-fork.1` only to pin one release: a pinned service never moves until you change or clear it.
- `BETTER_AUTH_URL` is the address people will open, starting with `https://`. It must match the domain you add next.
- `BETTER_AUTH_SECRET` signs people in. Run `openssl rand -base64 32` on any machine and paste the output.
- `POSTGRES_PASSWORD` is the database password. Run `openssl rand -hex 24` and paste the output. Never change either secret after the first deploy: the first signs everyone out, the second stops Doop from opening its database.
- The Anthropic lines are optional: a key for Doop's built-in agent, a base URL for a proxy or compatible endpoint (no `/v1`), and the two model names. Leave them empty to skip; an empty value counts as unset, and the model names then keep their defaults. They can also be changed later on the Admin page.

**4. Add the domain.** On the service's **Domains** tab press **Add Domain** and fill it in: **Host** `doop.yourbrand.com`, **Path** `/`, **Internal Path** `/`, **Port** `4400`, **HTTPS** on, **Certificate Provider** `Let's Encrypt`, **Service Name** `doop`. Point an **A record** for that name at the Dokploy server's public IP address and leave ports 80 and 443 open; Traefik asks Let's Encrypt for the certificate on the first request.

**5. Deploy.** Press **Deploy** and follow the deployment log until both containers are running. Doop creates its database schema on first boot; it takes a few seconds.

**6. Make the first admin account.** Accounts come only from invite links and there is no mail server here, so the invite and the admin role come from the container's terminal. On the service's page open the **doop** container's terminal and run:

```sh
node_modules/.bin/tsx server/instanceCli.ts invite you@example.com
```

It prints a link. Open it, sign up with that address, then promote the account with:

```sh
node_modules/.bin/tsx server/instanceCli.ts admin you@example.com
```

Add `--remove` before the address to take the role away again. After this, invite people from the Admin page, **Accounts**, **Invite someone** (see [section 5](#5-people)).

**7. Turn on Update now.** With one webhook, the Admin page's version card installs the latest release through Dokploy:

1. In Dokploy, on the service's **General** tab, switch **Autodeploy** on.
2. On the **Advanced** tab, switch **Pull latest images on deploy** on, so a redeploy downloads the newest image.
3. On the **Deployments** tab, copy the **Webhook URL**. It looks like `https://dokploy.yourbrand.com/api/deploy/compose/<token>`.
4. Add it to the Environment tab and press **Redeploy** once so Doop reads it:

   ```sh
   DOOP_DOKPLOY_WEBHOOK_URL=https://dokploy.yourbrand.com/api/deploy/compose/<token>
   ```

   It must be exactly that shape: `https://`, the path `/api/deploy/compose/<token>`, no query. Plain `http://` is accepted only when the address is this machine or a private network: `localhost`, a `127.x`, `10.x`, `172.16-31.x` or `192.168.x` address, an IPv6 `::1`, `fc00::/7` or `fe80::/10` address, or a bare service name such as `dokploy` (never a dotted name such as `10.example.com`). The service must be a **Raw** compose: a service that deploys from git is refused.

The webhook can only redeploy this one service, and anyone who has it can trigger a redeploy, so keep it private. Doop never shows it in a page or writes it to its log, and it never holds a Dokploy API key. If it leaks, regenerate it in Dokploy (the refresh icon next to the webhook on the **Deployments** tab), then put the new one in the Environment tab and redeploy.

**What Update now does.** Pressing it on the Admin page:

1. backs the database up into `../files/data/backups`,
2. calls the webhook once, and nothing else in Dokploy is touched,
3. Dokploy pulls the latest release and restarts Doop,
4. the page reloads once the new version answers.

If the backup fails, nothing is sent to Dokploy. With **Pull latest images on deploy** on, any redeploy installs the latest release, whether it came from Update now, the **Deploy** button or Dokploy itself. If the new version has not come up after 20 minutes, the card says so and points at the service's deployment log in Dokploy.

**Going back to a previous release by hand.** A new release that starts and then crashes leaves nothing running to put the old one back by itself. In the Environment tab set `DOOP_TAG` to the previous release (the tag on the fork's **Releases** page, for example `v0.7.0-fork.1`) and press **Redeploy**. The backup from just before the update is in `../files/data/backups`, if the database needs it too. Clear `DOOP_TAG` later (and redeploy) to follow the latest release again.

**Backups.** Doop backs the database up before every update and every night at 03:17 server time, into `../files/data/backups` on the Dokploy host (`/app/data/backups` inside the container). A backup is named `doop-<UTC stamp>-before-<tag>.sql.gz`, and the nightly ones `doop-<UTC stamp>-nightly.sql.gz`. They are kept for 14 days; add `DOOP_BACKUP_KEEP_DAYS` to the Environment tab to change that.

A backup holds accounts and canvases. Uploaded images, pending invites and the model names chosen on the Admin page are files under `../files/data` and are not part of it, so **copy the whole `files` folder off the server regularly**:

```sh
rsync -a /etc/dokploy/compose/doop/files/ you@backup-machine:doop-backup/
```

`doop` there is the folder Dokploy made for the service; `ls /etc/dokploy/compose` shows its name.

**Restore a backup.** Stop `doop` in Dokploy first (or `docker stop` its container), copy the file into the `db` container, and restore it into an empty database:

```sh
docker cp doop-20261008-031700.sql.gz doop-db-1:/tmp/
# in the db container's terminal, this erases the current database:
dropdb -U doop doop && createdb -U doop doop
gunzip -c /tmp/doop-20261008-031700.sql.gz | psql -U doop -d doop
```

`docker ps` shows the `db` container's real name if it is not `doop-db-1`. Start `doop` again when the restore finishes. The file has to be in the container or on a volume it mounts; `docker cp` is the simplest way.

**Moving an existing doop.sh server.** The data moves over:

1. On the old server run `sudo /opt/doop/deploy/doop.sh backup`, then copy the new file from `/srv/doop/backups` and the whole `/srv/doop/data` folder to your machine.
2. In Dokploy, paste the compose with the `doop` service left out (or commented out), fill in the Environment tab, and Deploy: this starts the database only.
3. Restore the old dump into `db` with the commands above, before Doop ever starts against it.
4. Copy `/srv/doop/data` into the service's `files/data` folder on the Dokploy host, so uploaded images and invites waiting to be used come along.
5. Put the `doop` service back, keep the old server's `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` (a new secret signs everyone out; a new address breaks the links people saved), and Deploy.

**Troubleshooting.**

| What you see                                                                                  | What to do                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No **Update now**, though a newer release exists                                              | `DOOP_DOKPLOY_WEBHOOK_URL` must be set in the Environment tab, in the shape `https://<dokploy>/api/deploy/compose/<token>` (the compose already sets `DOOP_UPDATE_REPO`); a plain `http://` to a public host or a query on the URL stops Doop at boot with a message, then redeploy |
| "Turn on Autodeploy for this service in Dokploy (General tab)."                               | Dokploy refuses the webhook while Autodeploy is off: switch it on in the service's **General** tab, then press Update now again                                                                                                                                                     |
| "Dokploy does not know this webhook; copy it again from the service's Deployments tab."       | The webhook was regenerated or copied incomplete: copy it again from the **Deployments** tab into `DOOP_DOKPLOY_WEBHOOK_URL` and redeploy                                                                                                                                           |
| "Dokploy refused the webhook: this service deploys from git; Update now needs a Raw compose." | Update now only works on a service whose **Provider** is **Raw** (step 2); recreate it that way                                                                                                                                                                                     |
| "Dokploy answered the webhook with 500." (or another number)                                  | Open the service's **Deployments** tab and the Dokploy logs; the number is Dokploy's own answer                                                                                                                                                                                     |
| "Dokploy has not installed ... after 20 minutes"                                              | Check the service's deployment log in Dokploy. If `DOOP_TAG` is set in its Environment tab, clear it so the service follows the latest release; also check **Pull latest images on deploy** is on                                                                                   |

## 4. Admins

An admin can:

- see every canvas and every account on this server,
- open anyone's canvas read-only (**View as**),
- ban and unban accounts,
- install updates.

The Admin page is in the account menu, bottom left (the face at the bottom of the left rail), under **Admin**. It appears only for
admins.

**The first admin** is the account the install created for you.

**Make someone else an admin:**

```sh
sudo /opt/doop/deploy/doop.sh admin anna@gmail.com
```

If that address has no account yet, the command asks for a name and a password and creates it.
Give them the password; they sign in with it. (Or invite them first, as below, and run the command
once they have signed up.)

**Take the admin role away:**

```sh
sudo /opt/doop/deploy/doop.sh admin --remove anna@gmail.com
```

Why a command and not a setting? Doop's own `ADMIN_EMAILS` setting only promotes an address once
its owner has confirmed it by email, and this server has no mail server. Only someone with access
to the server can run `doop.sh admin`, which makes it the safe way.

## 5. People

Nobody can sign up on their own. Every account comes from an **invite link** an admin makes for
one email address. The link opens the sign-up form for that address only, works once, and expires
after 7 days. There is no mail server, so you send the link yourself (chat, email, anything).

**Invite someone from the Admin page:** open **Accounts**, type their email under **Invite
someone**, press **Make invite link**, then **Copy** and send it. Invites not used yet are listed
under **Waiting to sign up**, where you can copy a link again or **Cancel** it.

**Or from the server:**

```sh
sudo /opt/doop/deploy/doop.sh invite anna@gmail.com ben@outlook.com
```

It prints one link per address. Nothing restarts.

Without a link, the sign-in page has no way to create an account; it says to ask an admin for an
invite link.

**Share a canvas** from the canvas's **Share** button: invite people who have an account, or
turn on link sharing.

**Someone forgot their password.** They choose **Forgot password** on the sign-in page and enter
their email. Without a mail server, the reset link is written to Doop's log instead of being
emailed. Find it and send it to them (it works for one hour):

```sh
cd /opt/doop/deploy && sudo docker compose logs doop | grep -A6 "Reset your doop password"
```

**Someone should no longer have access.** On the Admin page, open **Accounts** and press **Ban**
next to them. They are signed out everywhere and cannot sign back in. An invite nobody has used yet
is cancelled with **Cancel** under **Waiting to sign up**.

## 6. Models

Doop's built-in agent runs on the server's Anthropic key with two models:

- **Doop Agent model** (default `claude-opus-5`): designs on canvases when a card or @mention runs,
  and describes uploaded backgrounds.
- **Style-rule model** (default `claude-haiku-4-5-20251001`): turns feedback into the style rules
  Memory proposes. A small, fast model is enough.

**Change them on the Admin page**, under **Settings**, in **Models**: type a name, press **Test**
(one small call through your key and base URL, so a typo shows up straight away), then **Save**.
The next run uses it; nothing restarts. **use the default** goes back to the name set at install.
The card also shows where the key's calls go (Anthropic, or your base URL).

**Or from the server:**

```sh
sudo /opt/doop/deploy/doop.sh models                        # show them
sudo /opt/doop/deploy/doop.sh models agent claude-opus-5    # change one
sudo /opt/doop/deploy/doop.sh models distill default        # back to the default
```

The defaults are `DOOP_AGENT_MODEL` and `DOOP_DISTILL_MODEL` in the settings file (asked at
install). What the Admin page saves is kept in `/srv/doop/data/instance.json` and wins over them.

These are the server key's models only. People who connect their own model account (in their own
Settings) pick their models there.

## 7. Updating

### From the Admin page

The Admin page shows a card with the version this server runs. When a newer release exists, it
shows **Update now**. Pressing it:

1. backs up the database,
2. downloads the new release,
3. restarts Doop (everyone is disconnected for about a minute),
4. reloads the page once the new version is up.

If the new version does not start, the previous one is put back by itself and the card says the
update failed. **Release notes** opens the release on GitHub.

### From the command line

```sh
sudo /opt/doop/deploy/doop.sh update                  # the latest release
sudo /opt/doop/deploy/doop.sh update v0.7.0-fork.2    # a specific one, e.g. to go back
```

Every release is listed on the fork's **Releases** page on GitHub.

### How it works

Every push to `main` that passes CI becomes a release (`.github/workflows/fork-release.yml`): a
GitHub release and an image `ghcr.io/rbonweb/doop:<tag>`.

**Update now** does not let Doop control the server. It only leaves a request in
`/srv/doop/updates`. A small service on the server (`doop-update`) picks it up, checks that it asks
for the latest release, and installs it. To watch it work:

```sh
sudo journalctl -u doop-update -f
```

## 8. Backups

The database is backed up **every night at 03:17** into `/srv/doop/backups`. Backups are kept for
14 days. Every update makes one too.

```sh
sudo /opt/doop/deploy/doop.sh backup                                          # one now
sudo /opt/doop/deploy/doop.sh restore /srv/doop/backups/doop-20261008-031700.sql.gz
```

`restore` asks before it does anything, and saves the current database first, so a restore can be
undone by restoring that newer file.

The backups hold accounts and canvases. Uploaded images, pending invites and the models chosen on
the Admin page are kept as files in `/srv/doop/data` and are not part of them. **Copy the whole `/srv/doop` folder to another machine
regularly**, for example:

```sh
rsync -a /srv/doop/ you@backup-machine:doop-backup/
```

## 9. Changing settings

Settings live in `/opt/doop/deploy/.env`. Edit the file, then restart Doop so it reads them:

```sh
sudo nano /opt/doop/deploy/.env
sudo /opt/doop/deploy/doop.sh restart
```

| Setting                                                          | What it does                                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `DOOP_INVITE_ONLY`                                               | `1`: accounts come only from invite links (set at install)                                                            |
| `BETTER_AUTH_URL` and `DOOP_DOMAIN`                              | The address, e.g. `https://doop.yourbrand.com` and `doop.yourbrand.com`. Change both together                         |
| `ANTHROPIC_API_KEY`                                              | The key for Doop's built-in agent                                                                                     |
| `ANTHROPIC_BASE_URL`                                             | Send that key's calls to a proxy or compatible endpoint (base URL, no `/v1`)                                          |
| `DOOP_AGENT_MODEL`, `DOOP_DISTILL_MODEL`                         | The default model names. The Admin page's **Settings** changes them without a restart                                 |
| `RESIDENT_TASK_LIMIT`                                            | How many tasks the built-in agent runs on your key per person (setup sets a large number)                             |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Optional mail server. Reset links are then emailed, and new accounts must confirm their email before they can sign in |
| `DOOP_NOINDEX`                                                   | `1` keeps search engines out (the default)                                                                            |

Never change `BETTER_AUTH_SECRET` or `POSTGRES_PASSWORD`: the first signs everyone out and
disconnects every connected agent, the second stops Doop from opening its database.

Doop's other settings are listed in [`.env.example`](../.env.example).

## 10. Connect Claude Code

Claude Code (or any MCP client) can design on your canvases. Connect it once:

```sh
claude mcp add --transport http doop https://doop.yourbrand.com/mcp
```

A browser window opens; sign in to your Doop and approve. Claude Code then works as you.

## 11. Behind Krova Cloud's domain mapping

Krova's domain mapping does HTTPS at its edge and forwards plain HTTP to a port inside the Cube. So
Doop runs without Caddy, and the mapping points straight at it:

1. At install, answer **`edge`** to "How does HTTPS reach this server?" (or set `DOOP_PROXY=edge`).
   Caddy is left out and Doop listens on port **4400** of the Cube.
2. In Krova, attach your domain to the Cube with **port 4400**. Leave the origin scheme on
   **HTTP** and the PROXY protocol **off** (both are the defaults).
3. Publish the DNS record Krova shows (a CNAME for a subdomain). On Cloudflare it must be **DNS
   only** (grey cloud), or the certificate is never issued.

Point the mapping at 4400, not 80: without Caddy nothing answers on 80, and with Caddy every
request would loop, because Caddy redirects plain HTTP to HTTPS and the edge sends plain HTTP. You
do not need to open 4400 to the internet; the mapping reaches it through Krova.

**Already installed with Caddy?** Switch it over: in `/opt/doop/deploy/.env` set
`COMPOSE_PROFILES=` (empty) and add `DOOP_BIND=0.0.0.0`, then:

```sh
cd /opt/doop/deploy && sudo docker compose rm -sf caddy
sudo /opt/doop/deploy/doop.sh restart
```

## 12. Your own web server instead of Caddy

If ports 80 and 443 are already used on the server (by nginx, for example), answer **`own`** at
install. Caddy is left out and Doop listens on `127.0.0.1:4400`, reachable only from the server
itself. Point your web server at it. For nginx:

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

## 13. All commands

Run each as `sudo /opt/doop/deploy/doop.sh <command>`; `help` lists them too.

| Command                        | What it does                                             |
| ------------------------------ | -------------------------------------------------------- |
| `setup`                        | The install (runs once)                                  |
| `invite EMAIL...`              | Prints an invite link for each address                   |
| `admin EMAIL`                  | Makes that account an admin, creating it if needed       |
| `admin --remove EMAIL`         | Takes the admin role away                                |
| `update [TAG]`                 | Backs up, then installs the latest release (or that one) |
| `backup`                       | Backs up the database now                                |
| `restore FILE`                 | Replaces the database with a backup, after asking        |
| `restart`                      | Restarts Doop, applying changes made to `deploy/.env`    |
| `models [agent\|distill NAME]` | Shows the models, or changes one (`default` goes back)   |
| `status`                       | What is running, and which release                       |
| `logs`                         | Follows Doop's log (Ctrl+C to stop)                      |

## 14. Where things are

| Path                           | Holds                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `/opt/doop`                    | The code, at the installed release                                            |
| `/opt/doop/deploy/.env`        | Settings and secrets                                                          |
| `/srv/doop/data`               | Uploaded images and frame thumbnails                                          |
| `/srv/doop/data/instance.json` | Invite links waiting to be used, and the model names chosen on the Admin page |
| `/srv/doop/postgres`           | The database                                                                  |
| `/srv/doop/backups`            | Database backups                                                              |
| `/srv/doop/caddy`              | HTTPS certificates                                                            |
| `/srv/doop/updates`            | Update requests from the Admin page, and their progress                       |

## 15. Troubleshooting

| What you see                                                          | What to do                                                                                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The address does not open, or the browser warns about the certificate | Check that the A record points at this server and ports 80 and 443 are open, then look at `cd /opt/doop/deploy && sudo docker compose logs caddy`                        |
| On Krova Cloud, the domain shows an error or redirects in a loop      | The mapping must point at port **4400** with origin scheme **HTTP**, and the install must be `edge` (no Caddy; see [section 11](#11-behind-krova-clouds-domain-mapping)) |
| "No account found", and no way to sign up                             | Accounts come from invite links: Admin page, **Accounts**, **Invite someone**                                                                                            |
| "This invite link has expired or was already used."                   | Make a new one for that address                                                                                                                                          |
| The agent's runs fail after changing a model                          | Press **Test** next to the name on the Admin page (**Settings**): it shows what the endpoint answered                                                                    |
| No **Update now** on the Admin page                                   | The card says why: this is already the latest release, or no release exists yet (see [step 1](#1-once-on-github-publish-the-first-release))                              |
| The card keeps saying "Waiting for the server to start installing"    | The updater is not running: `sudo systemctl enable --now doop-update.path`                                                                                               |
| An update failed                                                      | The previous version is back. `sudo journalctl -u doop-update -n 100` says why                                                                                           |
| Every update takes 5-10 minutes                                       | The server cannot download the image, so it builds it. Make the package public (see [step 1](#1-once-on-github-publish-the-first-release))                               |
| Doop does not start                                                   | `sudo /opt/doop/deploy/doop.sh logs` shows the error                                                                                                                     |

## 16. Uninstall

```sh
cd /opt/doop/deploy && sudo docker compose down
sudo systemctl disable --now doop-update.path
sudo rm -f /etc/systemd/system/doop-update.path /etc/systemd/system/doop-update.service /etc/cron.d/doop-backup
sudo rm -rf /opt/doop
```

That keeps your data in `/srv/doop`. Remove it too (`sudo rm -rf /srv/doop`) only when you no
longer need any of it, backups included.
