# GymLog

Slack DM bot for logging gym lifts and getting weight recommendations.

## Stack

- **Node.js** — plain ESM, no build step
- **Slack Bolt** — Socket Mode
- **Postgres + Drizzle ORM**
- **OpenAI** (`gpt-4o-mini`) — message parsing and exercise resolution

## Setup

### 1. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create App** → **From Manifest**
2. Paste the contents of `slack-manifest.yml`
3. Under **Basic Information → App-Level Tokens**, generate a token with the `connections:write` scope — this is your `SLACK_APP_TOKEN`
4. Install the app to your workspace

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in all values:

| Variable | Where to find it |
|---|---|
| `SLACK_BOT_TOKEN` | OAuth & Permissions → Bot User OAuth Token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | Basic Information → App-Level Tokens (`xapp-…`) |
| `SLACK_SIGNING_SECRET` | Basic Information → Signing Secret |
| `DATABASE_URL` | Your Postgres connection string |
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |

### 3. Set up the database

```bash
# Development — push schema directly (no migration files)
npm run db:push

# Production — generate SQL files, then apply
npm run db:generate
npm run db:migrate
```

### 4. Run

```bash
npm start
```

## Local development with Docker

`docker-compose.yml` runs Postgres locally so you don't need to install it yourself. The app and all commands run from your own terminal.

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose plugin)

### Setup

1. Start the database:

   ```bash
   docker compose up -d
   ```

2. Set `DATABASE_URL` in your `.env` to:

   ```
   DATABASE_URL=postgresql://gymlog:gymlog@localhost:5432/gymlog
   ```

3. Push the schema and start the app as normal:

   ```bash
   npm run db:push
   npm start
   ```

### Useful commands

```bash
# Stop the database, keep the volume
docker compose down

# Stop and wipe all data
docker compose down -v
```

## Usage

Send a DM to the app. Supported messages:

| Example | Intent |
|---|---|
| `bench press 215x3` | Log a lift |
| `bench press for 3 reps @ 215` | Log a lift |
| `Feb 19 bench press for 3 reps @ 215` | Log a lift with date |
| `what should I bench for 10 reps?` | Get a recommendation |
| `what weight should I pick for bench press for 10 reps?` | Get a recommendation |
| `show recent bench` | View history |
| `undo` / `delete last` | Remove last entry |

When an exercise is ambiguous, the bot sends buttons to pick an existing exercise or create a new one. Your choice is remembered as an alias so you won't be asked again.

## How exercise resolution works

1. Normalize the raw text and check the `exercise_aliases` table for an exact match.
2. On a miss, send the text + all your existing exercises to the LLM resolver.
3. The resolver returns one of:
   - `match_existing` — wording is the same exercise (e.g. "bench" → "Bench Press")
   - `create_new` — clearly different equipment/angle/grip (e.g. "incline bench press")
   - `ask_user` — genuinely ambiguous; bot shows buttons

## How recommendations work

Uses the **Epley formula** across your last 5 entries for that exercise:

```
estimated_1RM = weight × (1 + reps / 30)
target_weight = avg_1RM / (1 + target_reps / 30)
```

Result is rounded to the nearest 5 lb or 2.5 kg and presented as a 5 lb / 2.5 kg range.

## Project structure

```
src/
  app.js                      Entry point
  db/
    schema.js                 Drizzle table definitions
    index.js                  DB client
    migrate.js                Migration runner
  parsing/
    parseMessage.js           Intent + data extraction (OpenAI)
  exercises/
    resolveExercise.js        Alias lookup + LLM resolver
  recommendations/
    recommendWeight.js        Epley formula logic
  slack/
    listeners.js              Message + button action handlers
drizzle.config.js
slack-manifest.yml
```
