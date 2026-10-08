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
[Prepare the server](#2-prepare-the-server) · [Install](#3-install) · [Admins](#4-admins) ·
[People](#5-people) · [Models](#6-models) · [Updating](#7-updating) · [Backups](#8-backups) ·
[Changing settings](#9-changing-settings) · [Claude Code](#10-connect-claude-code) ·
[Your own web server](#11-your-own-web-server-instead-of-caddy) · [Commands](#12-all-commands) ·
[Where things are](#13-where-things-are) · [Troubleshooting](#14-troubleshooting) ·
[Uninstall](#15-uninstall)

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

## 3. Install

```sh
curl -fsSL https://raw.githubusercontent.com/rbonweb/doop/main/deploy/doop.sh | sudo bash
```

It downloads the latest release into `/opt/doop` and asks:

| Question                     | Example                           | Notes                                                                 |
| ---------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| The address people will open | `https://doop.yourbrand.com`      | The full address, starting with `https://`                            |
| Your email                   | `you@gmail.com`                   | Becomes the admin account. Everyone else joins through an invite link |
| Your name and a password     |                                   | At least 8 characters, typed twice                                    |
| Anthropic API key            | `sk-ant-...`                      | Optional, for Doop's built-in agent. Press Enter to skip              |
| Anthropic base URL           | `https://llm-proxy.yourbrand.com` | Only if your key is for a proxy or compatible endpoint                |
| Model names                  | `claude-opus-5`                   | Asked with a key. Enter keeps the default; change them any time later |

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

## 4. Admins

An admin can:

- see every canvas and every account on this server,
- open anyone's canvas read-only (**View as**),
- ban and unban accounts,
- install updates.

The Admin page is in the account menu (your name, top right), under **Admin**. It appears only for
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

## 11. Your own web server instead of Caddy

If ports 80 and 443 are already used on the server (by nginx, for example), the install leaves
Caddy out and Doop listens on `127.0.0.1:4400`, reachable only from the server itself. Point your
web server at it. For nginx:

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

## 12. All commands

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

## 13. Where things are

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

## 14. Troubleshooting

| What you see                                                          | What to do                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| The address does not open, or the browser warns about the certificate | Check that the A record points at this server and ports 80 and 443 are open, then look at `cd /opt/doop/deploy && sudo docker compose logs caddy` |
| "No account found", and no way to sign up                             | Accounts come from invite links: Admin page, **Accounts**, **Invite someone**                                                                     |
| "This invite link has expired or was already used."                   | Make a new one for that address                                                                                                                   |
| The agent's runs fail after changing a model                          | Press **Test** next to the name on the Admin page (**Settings**): it shows what the endpoint answered                                             |
| No **Update now** on the Admin page                                   | The card says why: this is already the latest release, or no release exists yet (see [step 1](#1-once-on-github-publish-the-first-release))       |
| The card keeps saying "Waiting for the server to start installing"    | The updater is not running: `sudo systemctl enable --now doop-update.path`                                                                        |
| An update failed                                                      | The previous version is back. `sudo journalctl -u doop-update -n 100` says why                                                                    |
| Every update takes 5-10 minutes                                       | The server cannot download the image, so it builds it. Make the package public (see [step 1](#1-once-on-github-publish-the-first-release))        |
| Doop does not start                                                   | `sudo /opt/doop/deploy/doop.sh logs` shows the error                                                                                              |

## 15. Uninstall

```sh
cd /opt/doop/deploy && sudo docker compose down
sudo systemctl disable --now doop-update.path
sudo rm -f /etc/systemd/system/doop-update.path /etc/systemd/system/doop-update.service /etc/cron.d/doop-backup
sudo rm -rf /opt/doop
```

That keeps your data in `/srv/doop`. Remove it too (`sudo rm -rf /srv/doop`) only when you no
longer need any of it, backups included.
