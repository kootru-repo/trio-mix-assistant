# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately on this repository's **Security** tab, under **Report a
vulnerability**. Say what you found, how to reproduce it, and which version or
commit you tested. You can expect a reply within a week.

## What counts

Trio Mix-Assistant runs on your own computer and is reached over your local
network. Reports are especially welcome for anything that lets someone:

- control the console or the dashboard without the PIN,
- reach the dashboard from another website or another network,
- read or change files outside the app's folder,
- crash the engine during a show.

## What to know when you run it

- A PIN of at least 6 characters is required whenever the dashboard is served to the network (the app refuses to start without one unless `--insecure-open` or `ALLOW_OPEN=yes` is given, which is only for a network you fully trust) (`PIN=` in
  `app/show.conf`, or `--pin`).
- Use `--https` with a PIN. Without it the PIN travels unencrypted on the
  network.
- The HTTPS certificate is self-signed, so browsers show a warning the first
  time.
- The session log (`sessions.db`) is stored unencrypted on the computer that
  runs the app.

## Supported versions

Fixes go into the latest version on `main`.

## Data that leaves the computer

Nothing is sent anywhere unless you turn on `--advisor` (or `ADVISOR=yes` in `show.conf`). With
the advisor on, every 30 seconds (the interval is configurable) the app sends a short summary
to `api.anthropic.com`: recent event text, each channel's role and level, the current song and
scene names, and any alerts. It does not send the venue name, the PIN, or audio. The API key is read
from the `ANTHROPIC_API_KEY` environment variable and is only sent to that address.
