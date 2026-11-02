# The daily run

`dist/cli/daily.js` runs a campaign unattended, from launchd or cron, with no model involved. Each run:

1. discovers jobs on every configured board, as `discover_jobs` does
2. prepares an application for each queued job the active standing rules cover
3. sends the ones that are complete and covered by the rules, in `auto` mode
4. writes a digest to `<artifacts>/digests/YYYY-MM-DD.md` and shows a macOS notification

It sends nothing until the person has approved standing rules (see [SAFETY.md](SAFETY.md#standing-rules)). It calls the server's own tools in-process through a client that has no approval dialog, so it runs the same guards an agent's calls do and cannot approve anything itself. A campaign whose `submission.mode` is `assisted` gets the digest and nothing is sent.

```
node dist/cli/daily.js [--dry-run] [--no-notify] [--max-prepare <n>]
```

| Flag | Meaning |
|---|---|
| `--dry-run` | Discover and prepare, but send nothing. The digest lists what would have gone out |
| `--no-notify` | Skip the macOS notification |
| `--max-prepare` | At most this many new applications prepared per run. Default 20 |

Each run sends at most what the rules' `maxPerRun` and `maxPerDay`, the campaign's `submission.maxBatchSize` and `dailyLimit`, the per-company cap and pacing all allow.

## The digest

| Section | What it means |
|---|---|
| Sent | Submitted this run |
| Ready, not sent this run | Complete and covered, held back by a dry run, an assisted campaign or a cap |
| Waiting for the agent to draft | Required questions the agent can answer from the profile and CV, such as essays. Ask your agent to finish them |
| Waiting for you | Person-only questions, grouped by question text. One entry in `profile.answers` clears every application asking it |
| CAPTCHA and code gates | Runs that stopped at a challenge or a verification code. These are not retried automatically |
| Held back | Covered postings another guard refused, with its code |

Drafts from earlier days are checked again on every run, so an application the agent finished in the meantime goes out the next morning. They are never prepared again, since that would discard what the agent wrote.

## launchd, every day at 09:00

Save as `~/Library/LaunchAgents/com.autoapply.daily.plist`, with your own paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.autoapply.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/you/autoapply-mcp/dist/cli/daily.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AUTOAPPLY_HOME</key>
    <string>/Users/you/.autoapply</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/you/.autoapply/artifacts/daily.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/.autoapply/artifacts/daily.log</string>
</dict>
</plist>
```

Load it with `launchctl load ~/Library/LaunchAgents/com.autoapply.daily.plist`, and run it once by hand with `launchctl start com.autoapply.daily`. launchd runs a job missed while the Mac slept when it wakes.

Keep the mailbox password out of the plist. The verification inbox reads `AUTOAPPLY_OTP_IMAP_PASSWORD` from the environment, so set it from the Keychain in a small wrapper script that launchd runs instead of `node`, for example `export AUTOAPPLY_OTP_IMAP_PASSWORD="$(security find-generic-password -s autoapply-otp -w)"` followed by `exec node .../daily.js`.

With cron: `0 9 * * * AUTOAPPLY_HOME=$HOME/.autoapply /opt/homebrew/bin/node /path/to/dist/cli/daily.js --no-notify`.
