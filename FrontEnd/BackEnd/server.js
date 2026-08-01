require("dotenv").config();

const express = require("express");
const mysql = require("mysql2");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const webPush = require("web-push");
const path = require("path");

//validate all environment variables are present or not
function validateEnv() {
  //Server cannot function at all without these(mandatory)
  const critical = [
    "JWT_SECRET",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    "VAPID_EMAIL"
  ];

  //server runs in limited mode without these
  const expected = [
    "DB_HOST",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME"
  ];

  //check critical first
  const missingCritical = critical.filter(key => !process.env[key]);
  if (missingCritical.length > 0) {
    console.error("Missing critical environment variables - cancel start:");
    missingCritical.forEach(key => console.error(`  -${key}`));
    process.exit(1);
  }

  //check expected -warn but don't exit
  const missingExpected = expected.filter(key => !process.env[key]);
  if (missingExpected.length > 0) {
    console.warn("Missing database variables - running with limited functionality");
    missingExpected.forEach(key => console.warn(` -${key}`));
  }

  console.log("Environment validated");
}

const app = express();
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "http://localhost:3000"
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- CONFIG ----------
const JWT_SECRET = process.env.JWT_SECRET;
const API_PORT = process.env.PORT || 3000;

// ---------- START SERVER ----------

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL;

webPush.setVapidDetails(
  `mailto:${VAPID_EMAIL}`,
  VAPID_PUBLIC, 
  VAPID_PRIVATE
);

//expose public key to browser
app.get("/vapid-public-key", (req, res) => {
  res.send(process.env.VAPID_PUBLIC_KEY);
});

// Service worker rout - explicit MIME type is required
//browsers reject service workers with wrong Content-type
app.get("/service-worker.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.sendFile(path.join(__dirname, "..", "service-worker.js"));
});

//Splash screen as entry point
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "splash.html"));
});

// Serve all other frontend files (css, js, html, assets)
app.use(express.static(path.join(__dirname, "..")));

// ---------- DB ----------

let db = null;

async function initDatabase() {
  const dbVars = ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"];
  const missing = dbVars.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.warn("Database config missing - running without database");
    return;
  }

  try {
    db = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      dateStrings: true,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });

    //Verify connection actually works 
    await db.promise().query("SELECT 1");
    console.log("Database connected");

    //Create tables if they don't exist
    await db.promise().query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY ux_user_endpoint (user_id(10), endpoint(255))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      console.log("Tables verified");
  } catch (err) {
    console.error("Database connection failed:", err.message);
    db = null;
  }
}

//-----Server start-----------------------

async function startServer() {
  validateEnv();
  await initDatabase();
  app.listen(API_PORT, () => {
    console.log(`Server running on http://localhost:${API_PORT}`);
    console.log(`Origin: ${process.env.ALLOWED_ORIGIN || "http://localhost:3000"}`);
  });
}

startServer();

// ---------- Auth middleware ----------
function verifyToken(req, res, next) {
  const header = req.headers["authorization"];
  const token = header && header.split(" ")[1];

  if (!token) {
    return res.status(401).json({message: "No token provided"});
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    return res.status(403).json({message: "Invalid or expired token"});
  }
}

// ---------- AUTH routes (signup/login) - same as before ----------
app.post("/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: "All fields required" });
    }

    const hashed = await bcrypt.hash(password, 10);
    await db.promise().query("INSERT INTO users (username, email, password) VALUES (?, ?, ?)", [username, email, hashed]);
      
      res.status(201).json({ message: "User created" });
    
  } catch (err) {

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({message: "Email already exist "})
    }
    console.error("Signup error", err.message);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({message: "Email and password are required"});
    }

    const [row] = await db.promise().query(
      "SELECT * FROM users WHERE email = ?", [email]
    );

    if (!row.length) {
      return res.status(401).json({message: "Invalid credentials"});
    }

    const user = row[0];
    const ok = await bcrypt.compare(password, user.password);
    
    if (!ok) {
      return res.status(401).json({message: "Invalid credentials"});
    }

    const token = jwt.sign(
      {id: user.id, username: user.username},
      JWT_SECRET, 
      {expiresIn: "12h"}
    );

    res.json({
      message: "Login successful",
      token,
      user: { id: user.id, username: user.username, email: user.email }
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({message: "Server error"});
  }
});

// ---------- TASKS routes (scheduled_at DATETIME) ----------
app.get("/tasks", verifyToken, (req, res) => {
  db.query("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC", [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ message: "Error fetching tasks" });
    res.json(rows);
  });
});

app.post("/tasks", verifyToken, async (req, res) => {
  try{
    const {text, scheduled_at, priority} = req.body;
    if (!text) return res.status(400).json({message: "Task text required"});
    if (!scheduled_at) return res.status(400).json({message: "scheduled_at required"});

    let sched = String(scheduled_at).replace("T", " ");
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(sched)) sched = sched + ":00";

    const [result] = await db.promise().query(
      "INSERT INTO tasks (user_id, text, scheduled_at, priority, completed) VALUES (?, ?, ?, ?, 0)",
      [req.user.id, text, sched, priority || "low"]
    );

    const [rows] = await db.promise().query(
      "SELECT * FROM tasks WHERE id = ?",
      [result.insertId]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Add task error:", err.message);
    res.status(500).json({message : "Error adding task"});
  }
});

app.put("/tasks/:id", verifyToken, async (req, res) => {
  try {
    const taskId = req.params.id;
    const userId = req.user.id;
    const { text, scheduled_at, priority } = req.body;
    let sched = scheduled_at ? String(scheduled_at).replace("T", " ") : null;
    if (sched && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(sched)) sched = sched + ":00";

    const q = await db.promise().query(
      "UPDATE tasks SET text = ?, scheduled_at = ?, priority = ? WHERE id = ? AND user_id = ?", 
      [text, sched, priority, taskId, userId]
    );

    res.json({message: "Task updated"});
  } catch (err) {
    return res.status(500).json({message: "Error while updating tasks"});
  }
});

app.put("/tasks/:id/toggle", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = req.params.id;

    const q = await db.promise().query("UPDATE tasks SET completed = NOT completed WHERE id = ? AND user_id = ?",
      [id, userId]
    );

    res.json({message: "Toggled"});
  } catch (err) {
    return res.status(500).json({message : "Toggle failed"});
  }
});

app.delete("/tasks/:id", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = req.params.id;

    const q = await db.promise().query("DELETE FROM tasks WHERE id = ? AND user_id = ?", 
      [id, userId]
    );

    res.json({message: "Deleted"});

  } catch (err) {
    return res.status(500).json({ message: "Delete failed" });
  }
});

app.put("/tasks/:id/snooze", verifyToken, async (req, res) => {
  try {
    const { snooze_until } = req.body;
    const id = req.params.id;
    const userId = req.user.id;
    
    if (!snooze_until) return res.status(400).json({ message: "snooze_until required" });
    let s = String(snooze_until).replace("T", " ");
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s)) s = s + ":00";

    const q = await db.promise().query("UPDATE tasks SET snooze_until = ?, last_notified_at = NULL WHERE id = ? AND user_id = ?",
      [s, id, userId]
    );

    res.json({ message: "Snoozed" });
  } catch (err) {
    return res.status(500).json({ message: "Snooze failed" });
  }
});

// Stop notifications for a task
app.put("/tasks/:id/stop", verifyToken, async (req, res) => {
  try {
    const taskId = req.params.id;
    const userId = req.user.id;

    const q = await db.promise().query("UPDATE tasks SET notifications_paused = 1 WHERE id = ? AND user_id = ?",
      [taskId, userId]
    );

    console.log(`🔕 Notifications stopped for task ${taskId}`);
    res.json({ message: "Notifications stopped" });
  } catch (err) {
    console.error("❌ Stop Notification SQL error:", err);
    return res.status(500).json({ message: "Database error" });
  }
});

// ---------- SUBSCRIBE endpoint: save subscription to DB ----------
app.post("/subscribe", verifyToken, async (req, res) => {
  try {
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

    const q = await db.promise().query(sql, [userId, endpoint, keys.p256dh, keys.auth]);
    res.status(201).json({ message: "Subscription saved" });

  } catch (err) {
    console.error("❌ Subscription Save Error:", err);
    return res.status(500).json({ message: "Database error" });
  }
});

// ---------- PUSH SEND (test endpoint) ----------
app.post("/push/send", async (req, res) => {
  try {
    const { endpoint, keys, payload } = req.body;
    if (!endpoint || !keys) {
      return res.status(400).json({ message: "Invalid" });
    }

    const pushSubscription = { 
      endpoint, 
      keys: { p256dh: keys.p256dh, auth: keys.auth } 
    };

    await webPush.sendNotification(
      pushSubscription,
      JSON.stringify(payload || {title: "Test", body: "Hello"})
    );

    res.json({ok : true});
  } catch (err) {
    console.error("web-push error:", err);
      res.status(500).json({ message: "Push failed", err: String(err) });
  }
});





