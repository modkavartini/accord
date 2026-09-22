# Accord reader (Raspberry Pi)

The reader is a persistent, logged-in Chromium that reads sign-in-walled
Google Forms for `parse-form`. Copying a Google session's cookies to the cloud
dies within hours (only the browser that created a session can rotate its
gating token); a real browser that stays running rotates its own session, so
it just keeps working. This directory is the exact setup running on the Pi —
kept here so it's reproducible if the SD card dies.

## What runs

- `server.js` — Node + `playwright-core` driving the system Chromium
  (`/usr/bin/chromium`) with a persistent profile. `POST /read {url}` and
  `GET /health`, both requiring `Authorization: Bearer $READER_TOKEN`, bound to
  `127.0.0.1:8787`. Only `docs.google.com` / `forms.gle` URLs are accepted.
- `systemd/accord-reader.service` — runs it headed under Xvfb, `Restart=always`,
  memory-capped, enabled on boot.
- `systemd/accord-reader-watchdog.{service,timer}` + `accord-reader-watchdog` —
  every 3 min, restarts the service only if `/health` stops responding (a
  wedged process); won't restart-loop on a Google logout.
- `login.js`, `accord-login-remote`, `accord-login-done` — one-time / occasional
  sign-in of the reader account over a temporary noVNC view (the Pi is headless).

## First-time setup

```sh
sudo apt-get update
sudo apt-get install -y nodejs npm xvfb chromium x11vnc websockify novnc matchbox-window-manager
mkdir -p ~/accord-reader/profile && cd ~/accord-reader
npm init -y && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright-core
# copy this directory's files into ~/accord-reader/ (scripts chmod +x)
cp reader.env.example reader.env && chmod 600 reader.env   # then edit READER_TOKEN
sudo cp systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now accord-reader accord-reader-watchdog.timer
sudo tailscale funnel --bg 8787        # exposes https://<host>.ts.net -> 127.0.0.1:8787
```

Then set `READER_ENDPOINT` (the funnel URL) and `READER_TOKEN` in Netlify env.

## Sign in the reader account (headless Pi)

```sh
ssh pi@<host> "~/accord-reader/accord-login-remote"   # prints a noVNC URL (Tailscale-only)
# open the URL on a device on your tailnet, sign in as the reader account
ssh pi@<host> "~/accord-reader/accord-login-done"     # tears the view down, restarts the service
```

Check `https://<site>/.netlify/functions/reader-status` → `{"configured":true,"signedIn":true}`.
Re-run the login only if it ever shows `signedIn:false` (Google revoked the session).

## Resilience

Reboot / power loss, network drops, browser or process crashes, and memory
creep all recover automatically (systemd + the watchdog + Funnel state
persistence). While the Pi is down, public forms are unaffected and cached
walled forms keep serving; uncached walled forms show the extension fallback
until it returns.
