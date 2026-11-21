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

- Set a PIN whenever the dashboard is on a shared network (`PIN=` in
  `app/show.conf`, or `--pin`).
- Use `--https` with a PIN. Without it the PIN travels unencrypted on the
  network.
- The HTTPS certificate is self-signed, so browsers show a warning the first
  time.
- The session log (`sessions.db`) is stored unencrypted on the computer that
  runs the app.

## Supported versions

Fixes go into the latest version on `main`.
