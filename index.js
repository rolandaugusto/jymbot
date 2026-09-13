const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TOKEN_HERE';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'gym.db');

const MUSCLE_GROUPS = [
  'Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core', 'Cardio', 'Full Body'
];

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
}

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    "Welcome to your Gym Log bot! 💪\n\n" +
    "Commands:\n" +
    "/log - log today's training\n" +
    "/history - see your last 10 entries\n" +
    "/stats - see totals per muscle group\n" +
    "/delete - delete your most recent entry"
  );
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
    `INSERT INTO trainings (user_id, muscle_group, trained_at) VALUES (?, ?, ?)`,
    [userId, group, date]
  );

  await ctx.answerCbQuery();
  await ctx.editMessageText(`✅ Logged: ${group} — ${date}`);
});

// /history -> last 10 entries
bot.command('history', async (ctx) => {
  const userId = ctx.from.id;
  const rows = await db.all(
    `SELECT muscle_group, trained_at FROM trainings
     WHERE user_id = ? ORDER BY id DESC LIMIT 10`,
    [userId]
  );

  if (rows.length === 0) {
    return ctx.reply('No trainings logged yet. Use /log to add one.');
  }

  const lines = rows.map((r) => `${r.trained_at} — ${r.muscle_group}`);
  ctx.reply(`Last ${rows.length} trainings:\n\n${lines.join('\n')}`);
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

// /delete -> remove most recent entry (undo mistakes)
bot.command('delete', async (ctx) => {
  const userId = ctx.from.id;
  const last = await db.get(
    `SELECT id, muscle_group, trained_at FROM trainings
     WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
    [userId]
  );

  if (!last) {
    return ctx.reply('Nothing to delete.');
  }

  await db.run(`DELETE FROM trainings WHERE id = ?`, [last.id]);
  ctx.reply(`🗑️ Deleted: ${last.muscle_group} — ${last.trained_at}`);
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
