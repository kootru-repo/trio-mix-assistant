# Contributing

Trio Mix-Assistant is a community project for musicians who play without a sound
engineer. Players, sound people and programmers are all welcome.

## Ways to help

- **Tell us how you work.** Your preferences on stage shape what the tool does.
  Open a *Preference* issue.
- **Tell us where you got stuck.** Open a *Flow* issue and describe the steps.
- **Suggest a change to the screen.** Open a *UI suggestion* issue; a photo or a
  sketch helps.
- **Report a bug** or **send a pull request.**

You do not need a console to take part. `npm run run` (in `app/ts`) runs a full simulation,
and `npm run run -- --emulate --lan` runs the real stack against a built-in desk
emulator (see the [README](README.md)).

## Seeing the feedback

Open `docs/feedback-board.html` in a browser and enter this repository as
`owner/name`. It reads the public issues and shows three columns (Preferences,
Flow, UI suggestions), with filters for who said it, where, and on what device.
A thumbs-up on an issue moves it up its column.

If you are logging feedback for a musician who does not use GitHub, open the
issue yourself and put their name in *Whose feedback is this?*.

## Pull requests

1. Work from `main` on a branch of your own.
2. From `app/ts/`, run `npm run check` and `npm test`.
3. If you change `app/web/src`, rebuild with `npm run build` in `app/web` and
   commit the generated JavaScript with it.
4. Describe what you changed and how you checked it.

Anything that moves the console must stay inside the guardrails, be logged, and
yield to a human move. Changes that touch the OSC wire format need a note on how
they were checked (see [HARDWARE_BRINGUP.md](app/HARDWARE_BRINGUP.md)).

## Licence of contributions

The project is released under the
[GNU Affero General Public License v3.0](LICENSE). By sending a contribution you
agree that it is licensed under the same terms, and that the project authors may
also offer it under other terms, for example to grant a commercial licence.

## Credits

The concept and requirements come from Chris Beulow and Eric Craton; the
programming is by Andrew Craton. See [AUTHORS.md](AUTHORS.md).
