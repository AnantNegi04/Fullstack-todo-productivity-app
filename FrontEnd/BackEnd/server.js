// server.js — final with push scheduler (scheduled_at DATETIME local format)
require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const bodyParser = require("body-parser");
const webPush = require("web-push");
const path = require("path");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// ---------- CONFIG ----------
const JWT_SECRET = process.env.JWT_SECRET;
const API_PORT = process.env.PORT || 3000;
// ---------- START SERVER ----------
app.listen(API_PORT, () => 
  {console.log(`🚀 Server running on http://localhost:${API_PORT}`);
});

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL;
console.log("VAPID EMAIL:", process.env.VAPID_EMAIL);
webPush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

app.get("/vapid-public-key", (req, res) => {
  res.send(process.env.VAPID_PUBLIC_KEY);
});

app.get("/service-worker.js", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "service-worker.js"));
});

// ---------- Serve frontend & SW ----------
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "..", "splash.html")));

// serve service-worker explicitly (important)
app.get("/service-worker.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "..", "service-worker.js"));
});

// static files (point to FrontEnd)
app.use(express.static(path.join(__dirname, "..")));

// ---------- DB ----------

let db;
try{
  db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    dateStrings: true
  });

  db.connect(err => {
    if (err) {
      console.log("Database connection failed. Running without DB");
      db = null;
    } else {
      console.log("Database connected");

      const createPushTable = `
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY ux_user_endpoint (user_id(10), endpoint(255))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `;

      db.query(createPushTable, (e) => {
        if (e) console.error("Error creating push_subscriptions table:", e);
      });
    }
  });

} catch (error) {
  console.log("Database skipped during deployment");
}
// ---------- Auth middleware ----------
function verifyToken(req, res, next) {
  const header = req.headers["authorization"];
  const token = header && header.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Invalid token" });
    req.user = user;
    next();
  });
}

// ---------- AUTH routes (signup/login) - same as before ----------
app.post("/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ message: "All fields required" });
    const hashed = await bcrypt.hash(password, 10);
    db.query("INSERT INTO users (username, email, password) VALUES (?, ?, ?)", [username, email, hashed], (err) => {
      if (err) return res.status(500).json({ message: "Error creating user" });
      res.status(201).json({ message: "User created" });
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: "Email + password required" });
  db.query("SELECT * FROM users WHERE email = ?", [email], async (err, rows) => {
    if (err) return res.status(500).json({ message: "DB error" });
    if (!rows.length) return res.status(400).json({ message: "Invalid credentials" });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "12h" });
    res.json({ message: "Login successful", token, user: { id: user.id, username: user.username, email: user.email } });
  });
});

// ---------- TASKS routes (scheduled_at DATETIME) ----------
app.get("/tasks", verifyToken, (req, res) => {
  db.query("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC", [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ message: "Error fetching tasks" });
    res.json(rows);
  });
});

app.post("/tasks", verifyToken, (req, res) => {
  const userId = req.user.id;
  const { text, scheduled_at, priority } = req.body;
  if (!text) return res.status(400).json({ message: "Task text required" });
  if (!scheduled_at) return res.status(400).json({ message: "scheduled_at required" });

  let sched = String(scheduled_at).replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(sched)) sched = sched + ":00";

  const insertQ = "INSERT INTO tasks (user_id, text, scheduled_at, priority, completed) VALUES (?, ?, ?, ?, 0)";
  db.query(insertQ, [userId, text, sched, priority || "low"], (err, result) => {
    if (err) return res.status(500).json({ message: "Error adding task" });
    db.query("SELECT * FROM tasks WHERE id = ?", [result.insertId], (e, rows) => {
      if (e) return res.status(201).json({ message: "Task added" });
      res.status(201).json(rows[0]);
    });
  });
});

app.put("/tasks/:id", verifyToken, (req, res) => {
  const taskId = req.params.id;
  const userId = req.user.id;
  const { text, scheduled_at, priority } = req.body;
  let sched = scheduled_at ? String(scheduled_at).replace("T", " ") : null;
  if (sched && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(sched)) sched = sched + ":00";

  const q = "UPDATE tasks SET text = ?, scheduled_at = ?, priority = ? WHERE id = ? AND user_id = ?";
  db.query(q, [text, sched, priority, taskId, userId], (err) => {
    if (err) return res.status(500).json({ message: "Update failed" });
    res.json({ message: "Task updated" });
  });
});

app.put("/tasks/:id/toggle", verifyToken, (req, res) => {
  const userId = req.user.id;
  const id = req.params.id;
  db.query("UPDATE tasks SET completed = NOT completed WHERE id = ? AND user_id = ?", [id, userId], (err) => {
    if (err) return res.status(500).json({ message: "Toggle failed" });
    res.json({ message: "Toggled" });
  });
});

app.delete("/tasks/:id", verifyToken, (req, res) => {
  const userId = req.user.id;
  const id = req.params.id;
  db.query("DELETE FROM tasks WHERE id = ? AND user_id = ?", [id, userId], (err) => {
    if (err) return res.status(500).json({ message: "Delete failed" });
    res.json({ message: "Deleted" });
  });
});

app.put("/tasks/:id/snooze", verifyToken, (req, res) => {
  const { snooze_until } = req.body;
  const id = req.params.id;
  const userId = req.user.id;
  if (!snooze_until) return res.status(400).json({ message: "snooze_until required" });
  let s = String(snooze_until).replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) s = s + ":00";
  db.query("UPDATE tasks SET snooze_until = ?, last_notified_at = NULL WHERE id = ? AND user_id = ?", [s, id, userId], (err) => {
    if (err) return res.status(500).json({ message: "Snooze failed" });
    res.json({ message: "Snoozed" });
  });
});

// Stop notifications for a task
app.put("/tasks/:id/stop", verifyToken, (req, res) => {
  const taskId = req.params.id;
  const userId = req.user.id;

  db.query(
    "UPDATE tasks SET notifications_paused = 1 WHERE id = ? AND user_id = ?",
    [taskId, userId],
    (err) => {
      if (err) {
        console.error("❌ Stop Notification SQL error:", err);
        return res.status(500).json({ message: "Database error" });
      }
      console.log(`🔕 Notifications stopped for task ${taskId}`);
      res.json({ message: "Notifications stopped" });
    }
  );
});

// ---------- SUBSCRIBE endpoint: save subscription to DB ----------
app.post("/subscribe", verifyToken, (req, res) => {
  const userId = req.user.id;

  const { endpoint, keys } = req.body;

  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ message: "Invalid subscription format" });
  }

  const sql = `
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      p256dh = VALUES(p256dh),
      auth = VALUES(auth)
  `;

  db.query(sql, [userId, endpoint, keys.p256dh, keys.auth], (err) => {
    if (err) {
      console.error("❌ Subscription Save Error:", err);
      return res.status(500).json({ message: "Database error" });
    }
    res.status(201).json({ message: "Subscription saved" });
  });
});

// ---------- PUSH SEND (test endpoint) ----------
app.post("/push/send", (req, res) => {
  const { endpoint, keys, payload } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ message: "Invalid" });
  const pushSubscription = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };

  webPush.sendNotification(pushSubscription, JSON.stringify(payload || { title: "Test", body: "Hello" }))
    .then(() => res.json({ ok: true }))
    .catch((err) => {
      console.error("web-push error:", err);
      res.status(500).json({ message: "Push failed", err: String(err) });
    });
});

// ---------- SCHEDULER: run every 30s and send due notifications ----------
const SCHEDULER_INTERVAL_MS = 30 * 1000;

async function sendWebPush(subscription, payload) {
  const pushSubscription = {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth }
  };
  try {
    await webPush.sendNotification(pushSubscription, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    // web-push error - return error object for handling (e.g. remove subscription if gone)
    return { ok: false, error: err };
  }
}

function runNotificationScheduler() {
  if (!db) {
    console.log("⚠️ No DB → skipping runNotificationScheduler");
    return;
  }
  // Query tasks that are due for notification
  // Criteria:
  // - not completed
  // - notifications_paused = 0
  // - scheduled_at <= NOW()
  // - snooze_until IS NULL OR snooze_until <= NOW()
  // - last_notified_at IS NULL OR last_notified_at < scheduled_at (so we notify once)
  const sql = `
    SELECT t.*, ps.id AS sub_id, ps.endpoint, ps.p256dh, ps.auth, ps.user_id AS sub_user
    FROM tasks t
    JOIN push_subscriptions ps ON ps.user_id = t.user_id
    WHERE t.completed = 0
      AND (t.notifications_paused IS NULL OR t.notifications_paused = 0)
      AND (t.snooze_until IS NULL OR t.snooze_until <= NOW())
      AND (t.scheduled_at IS NOT NULL AND t.scheduled_at <= NOW())
      AND (t.last_notified_at IS NULL OR t.last_notified_at < t.scheduled_at)
    LIMIT 200;
  `;

  db.query(sql, async (err, rows) => {
    if (err) {
      console.error("Scheduler DB error:", err);
      return;
    }
    if (!rows.length) return;

    // group by subscription to avoid duplicate sends per subscription per task
    for (const row of rows) {
      const payload = {
        title: row.text || "Task Reminder",
        body: row.text ? `Due at ${row.scheduled_at}` : "You have a task due",
        tag: `task-${row.id}`,
        data: {
          taskId: row.id
        }
      };

      const subscription = {
        id: row.sub_id,
        endpoint: row.endpoint,
        p256dh: row.p256dh,
        auth: row.auth,
        user_id: row.sub_user
      };

      const result = await sendWebPush(subscription, payload);

      if (result.ok) {
        // mark last_notified_at = NOW() for the task (avoid duplicate)
        db.query("UPDATE tasks SET last_notified_at = NOW() WHERE id = ?", [row.id], (uErr) => {
          if (uErr) console.error("Failed to update last_notified_at:", uErr);
        });
      } else {
        // If subscription invalid, remove it
        const errStr = String(result.error || "");
        console.warn("Push send error for endpoint:", subscription.endpoint, errStr);
        // Typical errors: 410 Gone -> unsubscribe
        // Try to detect '410' or 'gone' in the error and delete
        if (errStr.includes("410") || errStr.includes("Gone") || errStr.includes("404")) {
          db.query("DELETE FROM push_subscriptions WHERE id = ?", [subscription.id], (dErr) => {
            if (dErr) console.error("Failed to delete invalid subscription:", dErr);
            else console.log("Deleted invalid push subscription", subscription.id);
          });
        }
      }
    }
  });
}

// start scheduler interval
setInterval(runNotificationScheduler, SCHEDULER_INTERVAL_MS);

