// notifier.js
require("dotenv").config();
const mysql = require("mysql2");
const webPush = require("web-push");
const cron = require("node-cron");

// ===============================
// DATABASE CONNECTION
// ===============================
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

db.connect((err) => {
  if (err) console.error("❌ MySQL connection error:", err);
  else console.log("✅ Connected to MySQL for notifier");
});

// ===============================
// WEB PUSH CONFIG
// ===============================
webPush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY, // your public VAPID key
  process.env.VAPID_PRIVATE_KEY // your private VAPID key
);

// ===============================
// CRON JOB: Check Every Minute
// ===============================

function formatLocalDateTime(date) {
  const pad = (n) => String(n).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
       + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

cron.schedule("* * * * *", () => {

    if (!db) {
    console.log("⚠️ No DB → skipping scheduler");
    return;
  }
  
  const now = new Date();
  
  const start = new Date(now.getTime() - 30 * 1000);
  const end = new Date(now.getTime() + 30 * 1000);

  const startStr = formatLocalDateTime(start);
  const endStr = formatLocalDateTime(end);

  console.log("Current Time:", now.toString());
  console.log(`⏰ Checking for due tasks at ${now.toLocaleString()}`);
  console.log(`🔍 Range: ${startStr} → ${endStr}`);

  const query = `
    SELECT t.*, s.endpoint, s.p256dh, s.auth
    FROM tasks t
    JOIN push_subscriptions s ON t.user_id = s.user_id
    WHERE t.completed = 0
      AND t.notifications_paused = 0
      AND (
        (t.snooze_until IS NULL AND CONCAT(t.date, ' ', t.time) BETWEEN ? AND ?)
        OR (t.snooze_until IS NOT NULL AND t.snooze_until BETWEEN ? AND ?)
      )
      AND (t.last_notified_at IS NULL OR TIMESTAMPDIFF(MINUTE, t.last_notified_at, NOW()) >= 2);
  `;

  db.query(query, [startStr, endStr, startStr, endStr], async (err, results) => {
    if (err) {
      console.error("❌ Query error:", err);
      return;
    }

    if (!results || results.length === 0) {
      console.log("No due tasks found this minute.");
      console.log("--------------------------------------------------");
      return;
    }

    // Prevent duplicates per run
    const notifiedIds = new Set();

    console.log(`📋 Found ${results.length} possible due task(s)`);

    for (const task of results) {
      if (notifiedIds.has(task.id)) continue;
      notifiedIds.add(task.id);

      const payload = JSON.stringify({
        title: "⏰ Task Reminder",
        body: `${task.text} is due now!`,
        actions: [
          { action: "snooze", title: "Snooze 10 min" },
          { action: "stop", title: "Stop Notifications" },
        ],
      });

      const pushSubscription = {
        endpoint: task.endpoint,
        keys: { p256dh: task.p256dh, auth: task.auth },
      };

      try {
        await webPush.sendNotification(pushSubscription, payload);
        console.log(`✅ Notification sent for task ID ${task.id} (${task.text})`);

        db.query(
          "UPDATE tasks SET last_notified_at = NOW() WHERE id = ?",
          [task.id],
          (err2) => {
            if (err2) console.error("⚠️ Could not update last_notified_at:", err2);
          }
        );
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          console.warn("⚠️ Invalid subscription, removing:", task.endpoint);
          db.query("DELETE FROM push_subscriptions WHERE endpoint = ?", [task.endpoint]);
        } else {
          console.error("🚨 Push send error:", err.message);
        }
      }
    }

    console.log("--------------------------------------------------");
  });
});
