# Gym Log Telegram Bot

Logs your gym trainings (muscle group + date) to a local SQLite database.

## Setup

1. Get a bot token from [@BotFather](https://t.me/BotFather) on Telegram (`/newbot`).

2. Install dependencies:
   ```
   npm install
   ```

3. Set your token as an environment variable and run:
   ```
   BOT_TOKEN=your_token_here node index.js
   ```

   Or create a `.env` file and use `dotenv` if you prefer — not wired up by default to keep this minimal.

## Commands

- `/start` — welcome message + command list
- `/log` — shows muscle group buttons, tap one to log it with today's date
- `/history` — last 10 logged trainings, with each entry's id
- `/stats` — total count per muscle group
- `/suggest` — suggests what to train next based on your last 7 logs (or whatever you haven't trained yet, if you don't have 7 logs); never suggests Cardio, since that's assumed to happen before every training
- `/delete` — deletes your most recent entry (undo)
- `/delete <id>` — deletes a specific entry by its id (see `/history` for ids)
- `/export` — downloads your training history as a CSV file, capped at the last 365 days (about a year) to keep the file bounded in size

## Data

Stored in `gym.db` (SQLite file, created automatically in the project folder).
Table: `trainings (id, user_id, muscle_group, note, trained_at)`.

`user_id` means multiple people can use the same bot and each gets their own log.

Only one entry per user per day: logging again on a day that already has an entry overwrites it (unique index on `user_id, trained_at`).

## Customizing muscle groups

Edit the `MUSCLE_GROUPS` array at the top of `index.js`.

## Deploying to Railway

1. Push this folder to a GitHub repo (Railway deploys from GitHub).

2. On [railway.app](https://railway.app), create a **New Project** → **Deploy from GitHub repo** → select this repo.

3. Add environment variables in the Railway dashboard (Variables tab):
   - `BOT_TOKEN` = your token from BotFather
   - `DB_PATH` = `/data/gym.db` (see volume step below)

4. **Add a persistent volume** (important — without this, `gym.db` gets wiped on every redeploy):
   - In the service settings, go to **Volumes** → **Add Volume**
   - Mount path: `/data`
   - This gives you a persistent disk that survives deploys/restarts.

5. Railway auto-detects Node.js and uses `npm start` (the `Procfile` is also there as a fallback for some builders). No web server/port needed — this is a worker process using long polling, not a web service, so you can ignore any "no PORT detected" warnings.

6. Deploy. Check the **Deployments → Logs** tab for `Gym bot is running...` to confirm it started.

### Notes
- Since it uses long polling (`bot.launch()`), there's nothing to expose publicly — no domain/port config needed.
- If you ever want zero-downtime redeploys, Railway restarts the process automatically on crash; Telegraf's polling will just reconnect.
- To update the bot, just push to your GitHub branch — Railway redeploys automatically (the volume persists your data across this).

## Deploying elsewhere

For a VPS instead, run with a process manager like `pm2` (`pm2 start index.js --name gym-bot`) instead of `node index.js`.
