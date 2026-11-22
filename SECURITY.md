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

- A PIN of at least 6 characters (`PIN=` in `show.conf`, or `--pin`) is required
  whenever the dashboard is served to the network. Without one the app refuses to
  start, unless `--insecure-open` or `ALLOW_OPEN=yes` is given, which is only for a
  network you fully trust.
- Use `--https` with a PIN. Without it the PIN travels unencrypted on the
  network.
- The HTTPS certificate is self-signed, so browsers show a warning.
- The session log (`sessions.db`) is stored unencrypted on the computer that
  runs the app.
- Five wrong PIN guesses lock an address out for 30 seconds, and each further
  lockout of that address lasts twice as long, up to 15 minutes.
- Each network address is limited to 24 connections, 8 live streams and about
  200 commands a second. Takeover (panic) is never rate limited.
- Console messages (fader moves, meters) are accepted only from the console's
  address (give the console as an IP address; with a host name this filter is off). AbleSet messages are accepted only from `--ableset-from`
  (`ABLESET_FROM=` in `show.conf`), or from the first computer that sends them
  when that is not set. UDP sender addresses can be forged by a device on the
  same network, so run the console and the app on a network that holds only
  your own equipment.

## Supported versions

Fixes go into the latest version on `main`.

## Data that leaves the computer

Nothing is sent anywhere unless you turn on `--advisor` (or `ADVISOR=yes` in `show.conf`). With
the advisor on, every 30 seconds (the `--advisor-interval` command-line flag changes it) the app sends a short summary
to `api.anthropic.com`: recent event text, each channel's role, level and whether it is notched, the current and
next song names with section, tempo and scene number, whether the show is playing, the lead-vocal status, the run mode,
and any alerts. Event and alert text can name the audio device and the console's IP address. It does not send the PIN or audio, and the venue name is not part of the summary. The API key is read
from the `ANTHROPIC_API_KEY` environment variable and is only sent to that address.
