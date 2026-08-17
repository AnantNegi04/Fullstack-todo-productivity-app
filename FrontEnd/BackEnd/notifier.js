require("dotenv").config();
const mysql = require("mysql2");
const webPush = require("web-push");
const cron = require("node-cron");

// ─── VAPID SETUP ────────────────────────────────────────
webPush.setVapidDetails(
  `mailto:${process.env.VAPID_EMAIL}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ─── DATABASE ───────────────────────────────────────────
let db = null;

async function initDatabase() {
  const required = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error("❌ Missing DB config:", missing);
    process.exit(1);
  }

  try {
    db = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      dateStrings: true,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0
    });

    await db.promise().query("SELECT 1");
    console.log("✅ Notifier connected to database");

  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
    process.exit(1);
  }
}

// ─── SCHEDULER ──────────────────────────────────────────
function startScheduler() {
  cron.schedule("* * * * *", async () => {
    console.log("Scheduler tick:", new Date().toLocaleTimeString());
    try {
      const [tasks] = await db.promise().query(`
        SELECT t.*, s.endpoint, s.p256dh, s.auth, s.id AS sub_id
        FROM tasks t
        JOIN push_subscriptions s ON t.user_id = s.user_id
        WHERE t.completed = 0
          AND t.notifications_paused = 0
          AND (
            (t.snooze_until IS NULL AND t.scheduled_at BETWEEN 
              DATE_SUB(NOW(), INTERVAL 30 SECOND) 
              AND DATE_ADD(NOW(), INTERVAL 30 SECOND))
            OR
            (t.snooze_until IS NOT NULL AND t.snooze_until BETWEEN
              DATE_SUB(NOW(), INTERVAL 30 SECOND) AND DATE_ADD(NOW(), INTERVAL 30 SECOND))
          )
          AND (t.last_notified_at IS NULL
            OR TIMESTAMPDIFF(MINUTE, t.last_notified_at, NOW()) >= 2)
      `);

      if (!tasks.length) return;

      console.log(`📋 ${tasks.length} due task(s) found`);

      for (const task of tasks) {
        try {
          await webPush.sendNotification(
            {
              endpoint: task.endpoint,
              keys: { p256dh: task.p256dh, auth: task.auth }
            },
            JSON.stringify({
              title: "⏰ Task Reminder",
              body: `${task.text} is due now!`,
              data: { taskId: task.id }
            })
          );

          await db.promise().query(
            "UPDATE tasks SET last_notified_at = NOW() WHERE id = ?",
            [task.id]
          );

          console.log(`✅ Notified task ${task.id}`);

        } catch (pushErr) {
          if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
            console.warn(`⚠️ Stale subscription, removing`);
            await db.promise().query(
              "DELETE FROM push_subscriptions WHERE id = ?",
              [task.sub_id]
            );
          } else {
            console.error(`❌ Push failed for task ${task.id}:`, pushErr.message);
          }
        }
      }

    } catch (err) {
      console.error("❌ Scheduler error:", err.message);
    }
  });

  console.log("⏰ Notification scheduler started");
}

// ─── ENTRY POINT ────────────────────────────────────────
async function start() {
  await initDatabase();
  startScheduler();
}

start();