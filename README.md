# backlog_agent

Personal agent for backlog task intake, updates, and management via Telegram and Notion. Cloudflare Workers AI converts rough messages into task drafts; your approval is required before the bot writes to Notion.

Projects: BacklogBot, ResumeLens, CCI, LIFE. Every create/update requires approval.

## Credentials

Requires Node.js 22.18+; no npm dependencies are needed for tests or credential setup.

Run `npm run setup` in an interactive terminal. It asks for your Telegram and Notion tokens without echoing them, verifies your Telegram identity using a random message, and creates `.secrets.json` with mode 0600. The file is ignored by Git. Never paste it into chat or commit it.

After the Worker and its credentials have been deployed, run `npm run connect`. It verifies Notion schema/access and Telegram credentials before registering the webhook. No credentials are embedded in source code.

## Deployment

Deployment is handled through the connected Cloudflare plugin using the Workers API. The connection needs D1 Write and Workers Scripts Write (or the corresponding Workers Editor/Admin scope), as well as access to Workers AI. Account permissions must be granted on the account receiving the deployment.

1. Copy `cloudflare.metadata.example.json` to `cloudflare.metadata.json` and `deployment.example.json` to `deployment.json`. These local files are ignored by Git.
2. Create a D1 database named `backlogbot-db` and execute `migrations/0001.sql`.
3. Set its ID on the `DB` binding in the metadata and in `deployment.json`. Set your Notion database ID on the `NOTION_DATABASE_ID` binding. For a database with multiple data sources, also provide a `NOTION_DATA_SOURCE_ID` text binding.
4. Upload `src/worker.js` as a module named `worker.js` with the metadata. Preserve existing `secret_text` bindings on subsequent uploads.
5. Install the four values from `.secrets.json` as Worker secrets, rather than committing or embedding the file in code.
6. Enable the Worker's workers.dev subdomain, configure the actual HTTPS URL in `deployment.json`, and set a `* * * * *` cron trigger for recovery/cleanup.
7. Run `npm run connect`, then test a real creation, cancellation, query, and update in Telegram. Confirm that Notion is unchanged until Approve is pressed.

The repository does not enable a paid Cloudflare subscription. Workers, D1, and AI have separate free quotas; monitor each in your account. `/health` is only a configuration-presence check, not proof that external integrations work.

If using the Cloudflare CLI for later deployment, use `cf` for a new project; these API metadata files are not CLI configuration files. Follow the current `cf` configuration documentation rather than passing them directly to `cf deploy`.

## Notion schema

One database, with exactly one data source (or explicitly set `NOTION_DATA_SOURCE_ID`). Required properties:

| Name | Type | Options |
| --- | --- | --- |
| Title | title | |
| Project | select | BacklogBot, ResumeLens, CCI, LIFE |
| Status | status | Backlog, To do, In progress, Done |
| Priority | select | Low, Medium, High, Urgent |
| Due date | date | |
| Task ID | unique_id | TASK prefix recommended |

The internal integration must have read, insert, update capabilities and explicit database access. New descriptions are page content. Description updates append a labelled note, preserving existing content; the preview says so.

## Usage

- `BacklogBot: handle repeated Telegram deliveries`
- `Show open tasks for LIFE`
- `ResumeLens: move TASK-42 to In progress`
- `CCI: update TASK-12 priority to High`

Queries show the ten most recently edited matching items and indicate when more exist. Include the project in every request. Drafts expire after 24 hours. Edit asks for a complete replacement request; the replacement needs approval and supersedes the earlier draft. `/cancel` exits editing without approving anything.

## Reliability and limitations

Only the configured Telegram account in a private chat is accepted. The webhook secret is verified before parsing messages. Input is bounded, model output is allowlisted and validated, and user text/tokens are not logged. API errors are sanitized.

D1 persists deliveries, drafts, editing sessions, and atomic approval claims. A minute cron recovers interrupted inbox work; this is internal processing, not user reminders. Processed payloads are cleared. Completed delivery IDs and old drafts are retained for seven days.

Network failures after a Notion write are ambiguous. Such approvals are locked as `uncertain` and never automatically retried; inspect Notion before sending the task again. A Worker crash after claiming an approval can leave it `applying`, also requiring inspection. Failed inbox entries are not replayed automatically. Interrupted preview delivery can leave a saved draft or a repeated preview; neither creates a Notion task without approval.

Updates compare Notion's last-edited timestamp against the preview; changed tasks require a new request. This is an optimistic precheck, not a cross-service transaction: concurrent manual edits between the check and write remain possible. Clearing optional fields, deletion, subtasks, voice, and reminders are not implemented.

## Validation

`npm run check` and `npm test` use Node syntax checks and the built-in test runner. Tests exercise real SQLite through `node:sqlite` with mocked external services. They do not claim a real Notion/Telegram connection has been validated. `/health` reports whether required settings are present; authenticated `POST /admin/check` checks the database, Notion schema and Telegram token. AI inference needs a separate live check.

Workers, D1 and AI have separate free quotas. No paid subscription is enabled by this project. Model quality and live account access must be verified during activation.
