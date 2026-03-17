// script.js (final) — expects backend tasks with scheduled_at: "YYYY-MM-DD HH:MM:SS"
// Uses scheduled_at as authoritative scheduled time (local DATETIME string).
let PUBLIC_VAPID_KEY = null;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js")
    .then(reg => console.log("SW registered:", reg.scope))
    .catch(err => console.error("SW registration failed:", err));
}

const API_BASE = window.location.origin;

// Auth guard
const token = localStorage.getItem("token");
if (!token) window.location.href = "login.html";
// Send JWT token to service worker
navigator.serviceWorker.ready.then(reg => {
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: "SET_TOKEN",
      token: localStorage.getItem("token")
    });
  }
});

async function loadConfig() {
  const res = await fetch(`${API_BASE}/vapid-public-key`);
  PUBLIC_VAPID_KEY = await res.text();
}

// call early (after token is available)
(async () => {
  await loadConfig();
  await initServiceWorkerAndPush();
})();

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function initServiceWorkerAndPush() {
  if (!("serviceWorker" in navigator)) {
    console.warn("Service Worker not supported.");
    return;
  }
  try {
    // Register SW
    const reg = await navigator.serviceWorker.register("/service-worker.js");
    console.log("✅ SW registered:", reg.scope);

    // Request permission
    if (Notification.permission !== "granted" && Notification.permission !== "denied") {
      const perm = await Notification.requestPermission();
      console.log("Notification permission:", perm);
    }

    if (Notification.permission === "granted") {
      const readyReg = await navigator.serviceWorker.ready;
      let subscription = await readyReg.pushManager.getSubscription();
      if (!subscription) {
        // create subscription
        subscription = await readyReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY),
        });
        console.log("Created new push subscription");
      } else {
        console.log("Existing subscription found");
      }

      // Send subscription to backend (if authenticated)
      const token = localStorage.getItem("token");
      if (subscription && token) {
        // subscription.toJSON() or stringify the object
        const subPayload = subscription.toJSON ? subscription.toJSON() : subscription;
        await fetch(`${API_BASE}/subscribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(subPayload),
        });
        console.log("✅ Subscription sent to backend");
      }
    } else {
      console.log("Notifications not permitted by user.");
    }
  } catch (err) {
    console.error("SW/Push init error:", err);
  }
}

// DOM
const taskListEl = document.getElementById("taskList");
const sortOption = document.getElementById("sortOption");
const viewMoreBtn = document.getElementById("viewMoreBtn");
const openModalBtn = document.getElementById("openModal");
const taskModal = document.getElementById("taskModal");
const closeModalBtn = document.getElementById("closeModal");
const addTaskBtn = document.getElementById("addTaskBtn");
const modalTitle = document.getElementById("modalTitle");
const taskInput = document.getElementById("taskInput");
const taskDate = document.getElementById("taskDate");
const taskTime = document.getElementById("taskTime");
const taskPriority = document.getElementById("taskPriority");
const navToggle = document.getElementById("navToggle");
const navDrawer = document.getElementById("navDrawer");
const logoutBtn = document.getElementById("logoutBtn");
const enableNotifBtn = document.getElementById("enableNotifBtn");
const taskStatsEl = document.getElementById("taskStats");


// State
let fullTaskList = [];
let pageSize = 5;
let currentPage = 1;
let editingTaskId = null;

// ------------------ Utilities ------------------

// Parse scheduled_at (DB returns "YYYY-MM-DD HH:MM:SS") into a Date object (local)
function parseScheduledAt(scheduled_at) {
  if (!scheduled_at) return null;
  // Accept formats: "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DDTHH:MM:SS"
  const s = String(scheduled_at).replace(" ", "T").split(".")[0]; // "YYYY-MM-DDTHH:MM:SS"
  // `new Date("YYYY-MM-DDTHH:MM:SS")` interprets as local time in most browsers (per spec)
  const d = new Date(s);
  if (!isNaN(d)) return d;
  // Fallback: parse manually
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):?(\d{2})?$/);
  if (!m) return null;
  const [_, y, mo, da, hh, mm, ss] = m;
  return new Date(Number(y), Number(mo) - 1, Number(da), Number(hh), Number(mm), Number(ss || 0));
}

// Format date "18 Nov 2025"
function formatDateFromScheduled(scheduled_at) {
  const d = parseScheduledAt(scheduled_at);
  if (!d) return "";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

// Format time "6:30 PM"
function formatTimeFromScheduled(scheduled_at) {
  const d = parseScheduledAt(scheduled_at);
  if (!d) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Compute remaining (returns "", "Expired", "2h 15m", etc.)
function computeTimeRemainingFromScheduled(scheduled_at) {
  const d = parseScheduledAt(scheduled_at);
  if (!d) return "";
  const diff = d - new Date();
  if (diff <= 0) return "Expired";
  const minutes = Math.floor(diff / 60000);
  const days = Math.floor(minutes / (60 * 24));
  const hours = Math.floor((minutes % (60 * 24)) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// Normalize outgoing scheduled_at from inputs (taskDate = "YYYY-MM-DD", taskTime = "HH:MM")
function buildScheduledAtPayload(dateStr, timeStr) {
  if (!dateStr) return null;
  let t = (timeStr || "").trim();
  if (t && /^\d{1,2}:\d{2}$/.test(t)) {
    if (t.split(":")[0].length === 1) t = `0${t}`;
    t = `${t}:00`;
  } else if (!t) {
    // If user didn't supply time, keep as "YYYY-MM-DD 00:00:00" (or you can decide to reject)
    t = "00:00:00";
  }
  // Return the format backend expects: "YYYY-MM-DD HH:MM:SS"
  return `${dateStr} ${t}`;
}

// Normalize fetched scheduled_at string for display: backend returns "YYYY-MM-DD HH:MM:SS"
function scheduledAtToDisplayString(s) {
  if (!s) return "";
  return s.replace(" ", "T").split(".")[0];
}

// ------------------ Rendering ------------------

function createTaskCard(task) {
  const card = document.createElement("div");
  card.className = "task-card";
  card.dataset.id = task.id;

  // Title
  const title = document.createElement("div");
  title.className = "task-title";
  title.textContent = task.text || "(No title)";
  card.appendChild(title);

  // Date
  const dateLine = document.createElement("div");
  dateLine.className = "meta-line";
  dateLine.innerHTML = `<svg viewBox="0 0 24 24" style="width:14px;height:14px;margin-right:6px;opacity:.9"><rect x="3" y="4" width="18" height="18" rx="2" stroke="currentColor" stroke-width="1.4" fill="none"></rect></svg>${formatDateFromScheduled(task.scheduled_at)}`;
  card.appendChild(dateLine);

  // Time
  const timeLine = document.createElement("div");
  timeLine.className = "meta-line";
  const timeText = formatTimeFromScheduled(task.scheduled_at);
  timeLine.innerHTML = `<svg viewBox="0 0 24 24" style="width:14px;height:14px;margin-right:6px;opacity:.9"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.4" fill="none"></circle></svg>${timeText}`;
  card.appendChild(timeLine);

  // Remaining
  const remaining = document.createElement("div");
  remaining.className = "remaining";
  const rem = computeTimeRemainingFromScheduled(task.scheduled_at);
  remaining.textContent = rem ? `Time remaining: ${rem}` : "";
  card.appendChild(remaining);

  // Priority
  const pr = document.createElement("div");
  pr.className = "priority";
  pr.innerHTML = `<svg viewBox="0 0 24 24" style="width:14px;height:14px;opacity:.9"><path d="M12 2L15 8H9L12 2Z" fill="currentColor"></path></svg>`;
  const badge = document.createElement("span");
  badge.className = `badge ${task.priority || "low"}`;
  badge.textContent = (task.priority || "low").toUpperCase();
  pr.appendChild(badge);
  card.appendChild(pr);

  // 3-dot menu
  const menuBtn = document.createElement("button");
  menuBtn.className = "task-menu-btn";
  menuBtn.innerHTML = `<i class="fa-solid fa-ellipsis-vertical"></i>`;
  card.appendChild(menuBtn);

  const menu = document.createElement("div");
  menu.className = "task-menu";
  const actions = [
    { text: "Edit", fn: () => openEditModal(task) },
    { text: "Snooze", fn: () => snoozeTask(task.id) },
    { text: task.completed ? "Mark Incomplete" : "Complete", fn: () => toggleComplete(task.id) },
    { text: "Delete", fn: () => deleteTask(task.id) }
  ];
  actions.forEach(a => {
    const el = document.createElement("div");
    el.className = "task-menu-item";
    el.textContent = a.text;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.remove("show");
      a.fn();
    });
    menu.appendChild(el);
  });
  card.appendChild(menu);

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = menu.classList.contains("show");
    document.querySelectorAll(".task-menu").forEach(m => m.classList.remove("show"));
    if (!wasOpen) menu.classList.add("show");
  });

  document.addEventListener("click", () => menu.classList.remove("show"));

  if (task.completed) {
    title.style.opacity = "0.6";
    title.style.textDecoration = "line-through";
  }

  return card;
}

function renderPage() {
  taskListEl.innerHTML = "";
  const start = (currentPage - 1) * pageSize;
  const pageTasks = fullTaskList.slice(start, start + pageSize);
  pageTasks.forEach(t => taskListEl.appendChild(createTaskCard(t)));
  viewMoreBtn.style.display = (start + pageTasks.length < fullTaskList.length) ? "block" : "none";
  updateStats();
}

function updateStats() {
  const done = fullTaskList.filter(t => t.completed === 1 || t.completed === true).length;
  const remaining = fullTaskList.length - done;
  if (taskStatsEl) taskStatsEl.textContent = `${done} completed • ${remaining} remaining`;
}

// ------------------ Load tasks ------------------
async function loadTasks(sortBy = "default") {
  try {
    const res = await fetch(`${API_BASE}/tasks`, { headers: { Authorization: `Bearer ${token}` }});
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem("token");
      return (window.location.href = "login.html");
    }
    const data = await res.json();
    fullTaskList = Array.isArray(data) ? data : [];

    // Sorting
    if (sortBy === "priority") {
      const order = { high: 1, medium: 2, low: 3 };
      fullTaskList.sort((a,b) => (order[a.priority]||3) - (order[b.priority]||3));
    } else if (sortBy === "date") {
      fullTaskList.sort((a,b) => {
        const da = parseScheduledAt(a.scheduled_at) || new Date(8640000000000000);
        const db = parseScheduledAt(b.scheduled_at) || new Date(8640000000000000);
        return da - db;
      });
    } else if (sortBy === "name") {
      fullTaskList.sort((a,b) => (a.text||"").localeCompare(b.text||""));
    }

    currentPage = 1;
    renderPage();
  } catch (err) {
    console.error("Load tasks error:", err);
  }
}

// ------------------ Modal & Add/Edit ------------------
openModalBtn.addEventListener("click", () => {
  editingTaskId = null;
  modalTitle.textContent = "Add Task";
  addTaskBtn.textContent = "Add Task";
  taskInput.value = "";
  taskDate.value = "";
  taskTime.value = "";
  taskPriority.value = "low";
  taskModal.classList.add("show");
});
closeModalBtn.addEventListener("click", () => taskModal.classList.remove("show"));
window.addEventListener("click", (e) => { if (e.target === taskModal) taskModal.classList.remove("show"); });

function openEditModal(task) {
  editingTaskId = task.id;
  modalTitle.textContent = "Edit Task";
  addTaskBtn.textContent = "Save Changes";
  taskInput.value = task.text || "";
  // scheduled_at -> set date and time fields
  if (task.scheduled_at) {
    const ds = task.scheduled_at.split(" ")[0]; // YYYY-MM-DD
    const ts = (task.scheduled_at.split(" ")[1] || "00:00:00").slice(0,5); // HH:MM
    taskDate.value = ds;
    taskTime.value = ts;
  } else {
    taskDate.value = "";
    taskTime.value = "";
  }
  taskPriority.value = task.priority || "low";
  taskModal.classList.add("show");
}

addTaskBtn.addEventListener("click", async () => {
  const text = taskInput.value.trim();
  const date = taskDate.value || null; // YYYY-MM-DD
  const timeRaw = taskTime.value || null; // HH:MM
  const priority = taskPriority.value || "low";
  if (!text) return alert("Enter a task");
  const scheduled_at = buildScheduledAtPayload(date, timeRaw);
  try {
    const method = editingTaskId ? "PUT" : "POST";
    const url = editingTaskId ? `${API_BASE}/tasks/${editingTaskId}` : `${API_BASE}/tasks`;
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`},
      body: JSON.stringify({ text, scheduled_at, priority })
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.message || "Save failed");
    taskModal.classList.remove("show");
    await loadTasks(sortOption ? sortOption.value : "default");
  } catch (err) {
    console.error("Save error:", err);
    alert("Could not save task. See console.");
  }
});

// ------------------ Actions ------------------
async function deleteTask(id) {
  if (!confirm("Delete this task?")) return;
  try {
    await fetch(`${API_BASE}/tasks/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` }});
    await loadTasks(sortOption ? sortOption.value : "default");
  } catch (err) { console.error("Delete error:", err); }
}

async function toggleComplete(id) {
  try {
    await fetch(`${API_BASE}/tasks/${id}/toggle`, { method: "PUT", headers: { Authorization: `Bearer ${token}` }});
    await loadTasks(sortOption ? sortOption.value : "default");
  } catch (err) { console.error("Toggle error:", err); }
}

async function snoozeTask(id) {
  const minutes = prompt("Snooze for how many minutes?", "10");
  if (!minutes || isNaN(minutes)) return alert("Invalid minutes");
  const snoozeUntil = new Date(Date.now() + Number(minutes) * 60000).toISOString();
  try {
    await fetch(`${API_BASE}/tasks/${id}/snooze`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`},
      body: JSON.stringify({ snooze_until: snoozeUntil })
    });
    await loadTasks(sortOption ? sortOption.value : "default");
  } catch (err) { console.error("Snooze error:", err); }
}

// ------------------ Drawer / Nav / Logout ------------------
if (navToggle && navDrawer) {
  navToggle.addEventListener("click", () => navDrawer.classList.toggle("open"));
  window.addEventListener("click", (e) => {
    if (!navDrawer.contains(e.target) && !navToggle.contains(e.target)) navDrawer.classList.remove("open");
  });
}
if (logoutBtn) logoutBtn.addEventListener("click", () => { localStorage.removeItem("token"); localStorage.removeItem("username"); window.location.href = "login.html"; });
if (enableNotifBtn) enableNotifBtn.addEventListener("click", async () => {
  const p = await Notification.requestPermission();
  alert(p === "granted" ? "Notifications enabled" : "Notifications blocked/dismissed");
});

// ------------------ Sorting / Pagination / Initial load ------------------
if (sortOption) sortOption.addEventListener("change", () => loadTasks(sortOption.value));
if (viewMoreBtn) viewMoreBtn.addEventListener("click", () => { currentPage++; renderPage(); });

window.addEventListener("load", async () => {
   await loadTasks();

  // Update only the remaining text for visible cards every minute
  setInterval(() => {
    document.querySelectorAll(".task-card").forEach(node => {
      const id = node.dataset.id;
      const task = fullTaskList.find(t => String(t.id) === String(id));
      if (!task) return;
      const remEl = node.querySelector(".remaining");
      if (!remEl) return;
      const rem = computeTimeRemainingFromScheduled(task.scheduled_at);
      remEl.textContent = rem ? `Time remaining: ${rem}` : "";
    });
  }, 60_000);
});
