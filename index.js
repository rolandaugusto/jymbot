const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TOKEN_HERE';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'gym.db');

// Make sure the folder for the DB file exists (e.g. a Railway volume mount)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const MUSCLE_GROUPS = [
  'Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core', 'Cardio', 'Full Body'
];

// Cardio is assumed to happen before every training, so it's loggable but
// never something /suggest recommends.
const SUGGESTABLE_GROUPS = MUSCLE_GROUPS.filter((g) => g !== 'Cardio');

let db;

async function initDb() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS trainings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      muscle_group TEXT NOT NULL,
      note TEXT,
      trained_at TEXT NOT NULL
    )
  `);

  // One entry per user per day: dedupe any pre-existing rows before adding
  // the unique index, keeping the most recent (highest id) entry per day.
  await db.exec(`
    DELETE FROM trainings
    WHERE id NOT IN (
      SELECT MAX(id) FROM trainings GROUP BY user_id, trained_at
    )
  `);

  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trainings_user_date
    ON trainings (user_id, trained_at)
  `);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Converts a stored 'YYYY-MM-DD' date into 'DD.MM.YYYY DayName'
function formatDisplayDate(isoDate) {
  const [year, month, day] = isoDate.split('-');
  const dateObj = new Date(`${isoDate}T00:00:00`);
  const dayName = DAY_NAMES[dateObj.getDay()];
  return `${day}.${month}.${year} ${dayName}`;
}

const HELP_TEXT =
  "Commands:\n" +
  "/log - log today's training\n" +
  "/history - see your last 10 entries\n" +
  "/stats - see totals per muscle group\n" +
  "/suggest - suggest what to train next\n" +
  "/delete - delete your most recent entry\n" +
  "/delete <id> - delete a specific entry by its id (see /history)\n" +
  "/export - download your training history as a CSV file (last 365 days)\n" +
  "/help - show this list again";

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(`Welcome to your Gym Log bot! 💪\n\n${HELP_TEXT}`);
});

bot.help((ctx) => {
  ctx.reply(HELP_TEXT);
});

// /log -> shows muscle group buttons
bot.command('log', (ctx) => {
  const buttons = MUSCLE_GROUPS.map((g) => [
    { text: g, callback_data: `log:${g}` },
  ]);
  ctx.reply('What did you train today?', {
    reply_markup: { inline_keyboard: buttons },
  });
});

// handle button press
bot.action(/^log:(.+)$/, async (ctx) => {
  const group = ctx.match[1];
  const userId = ctx.from.id;
  const date = todayISO();

  await db.run(
    `INSERT INTO trainings (user_id, muscle_group, trained_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id, trained_at) DO UPDATE SET muscle_group = excluded.muscle_group`,
    [userId, group, date]
  );

  await ctx.answerCbQuery();
  await ctx.editMessageText(`✅ Logged: ${group} — ${date}`);
});

// /history -> last 10 entries
bot.command('history', async (ctx) => {
  const userId = ctx.from.id;
  const rows = await db.all(
    `SELECT id, muscle_group, trained_at FROM trainings
     WHERE user_id = ? ORDER BY id DESC LIMIT 10`,
    [userId]
  );

  if (rows.length === 0) {
    return ctx.reply('No trainings logged yet. Use /log to add one.');
  }

  const lines = rows.map((r) => `#${r.id} — ${formatDisplayDate(r.trained_at)} — ${r.muscle_group}`);
  ctx.reply(`Last ${rows.length} trainings:\n\n${lines.join('\n')}\n\nUse /delete <id> to remove a specific entry.`);
});

// /stats -> counts per muscle group
bot.command('stats', async (ctx) => {
  const userId = ctx.from.id;
  const rows = await db.all(
    `SELECT muscle_group, COUNT(*) as count FROM trainings
     WHERE user_id = ? GROUP BY muscle_group ORDER BY count DESC`,
    [userId]
  );

  if (rows.length === 0) {
    return ctx.reply('No data yet. Use /log to add your first training.');
  }

  const lines = rows.map((r) => `${r.muscle_group}: ${r.count}`);
  ctx.reply(`Training totals:\n\n${lines.join('\n')}`);
});

// /suggest -> recommend a muscle group based on the last 7 logs, falling
// back to "whatever hasn't been trained yet" if there isn't enough history
bot.command('suggest', async (ctx) => {
  const userId = ctx.from.id;

  const { count: totalCount } = await db.get(
    `SELECT COUNT(*) as count FROM trainings WHERE user_id = ?`,
    [userId]
  );

  if (totalCount < 7) {
    const trainedRows = await db.all(
      `SELECT DISTINCT muscle_group FROM trainings WHERE user_id = ?`,
      [userId]
    );
    const trainedSet = new Set(trainedRows.map((r) => r.muscle_group));
    const untrained = SUGGESTABLE_GROUPS.filter((g) => !trainedSet.has(g));

    if (untrained.length === 0) {
      return ctx.reply(
        "Not enough history yet for a smart suggestion, but you've tried every muscle group at least once. Keep logging with /log!"
      );
    }

    const [suggestion, ...rest] = untrained;
    return ctx.reply(
      `Not enough history yet for a smart suggestion.\n\n` +
      `💡 Try: ${suggestion} (not logged yet)` +
      (rest.length ? `\nAlso untrained: ${rest.join(', ')}` : '')
    );
  }

  const recentRows = await db.all(
    `SELECT muscle_group FROM trainings WHERE user_id = ? ORDER BY id DESC LIMIT 7`,
    [userId]
  );

  const counts = {};
  SUGGESTABLE_GROUPS.forEach((g) => { counts[g] = 0; });
  recentRows.forEach((r) => {
    if (counts[r.muscle_group] !== undefined) counts[r.muscle_group] += 1;
  });

  const minCount = Math.min(...SUGGESTABLE_GROUPS.map((g) => counts[g]));
  const neglected = SUGGESTABLE_GROUPS.filter((g) => counts[g] === minCount);
  const breakdown = SUGGESTABLE_GROUPS
    .slice()
    .sort((a, b) => counts[a] - counts[b])
    .map((g) => `${g}: ${counts[g]}`)
    .join('\n');

  ctx.reply(
    `💡 Suggested: ${neglected.join(', ')}\n\n` +
    `Based on your last ${recentRows.length} logs:\n${breakdown}`
  );
});

// /delete -> remove most recent entry (undo mistakes)
// /delete <id> -> remove a specific entry by id (see /history for ids)
bot.command('delete', async (ctx) => {
  const userId = ctx.from.id;
  const [, idArg] = ctx.message.text.trim().split(/\s+/);

  let target;
  if (idArg !== undefined) {
    const id = Number(idArg);
    if (!Number.isInteger(id)) {
      return ctx.reply('That id looks invalid. Usage: /delete <id> (see /history for ids).');
    }
    target = await db.get(
      `SELECT id, muscle_group, trained_at FROM trainings WHERE id = ? AND user_id = ?`,
      [id, userId]
    );
    if (!target) {
      return ctx.reply(`No entry with id ${id} found in your history.`);
    }
  } else {
    target = await db.get(
      `SELECT id, muscle_group, trained_at FROM trainings
       WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    if (!target) {
      return ctx.reply('Nothing to delete.');
    }
  }

  await db.run(`DELETE FROM trainings WHERE id = ?`, [target.id]);
  ctx.reply(`🗑️ Deleted #${target.id}: ${target.muscle_group} — ${target.trained_at}`);
});

// Escapes a value for CSV: wraps in quotes and doubles any embedded quotes
// whenever it contains a comma, quote, or newline.
function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// /export -> download training history as CSV, capped at the last 365 days
// (roughly a year) to keep exports bounded in size
bot.command('export', async (ctx) => {
  const userId = ctx.from.id;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 365);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const rows = await db.all(
    `SELECT id, muscle_group, note, trained_at FROM trainings
     WHERE user_id = ? AND trained_at >= ? ORDER BY trained_at ASC, id ASC`,
    [userId, cutoffISO]
  );

  if (rows.length === 0) {
    return ctx.reply('No trainings in the last 365 days to export.');
  }

  const header = ['id', 'date', 'muscle_group', 'note'].join(',');
  const lines = rows.map((r) =>
    [r.id, r.trained_at, csvEscape(r.muscle_group), csvEscape(r.note)].join(',')
  );
  const csv = [header, ...lines].join('\n');

  await ctx.replyWithDocument({
    source: Buffer.from(csv, 'utf-8'),
    filename: `gym-history-${todayISO()}.csv`,
  });
});

// Fallback: any text that isn't a recognized command
bot.on('text', (ctx) => {
  ctx.reply(`I didn't understand that.\n\n${HELP_TEXT}`);
});

async function main() {
  await initDb();
  await bot.launch();
  console.log('Gym bot is running...');
}

main().catch((err) => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
