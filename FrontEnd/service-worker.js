// service-worker.js - Tsuruism
let JWT_TOKEN = null;

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SET_TOKEN") {
    JWT_TOKEN = event.data.token;
    console.log("SW stored JWT token.");
  }
});

self.addEventListener("install", (event) => {
  console.log("Service Worker Installed");
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("Service Worker Activated");
  event.waitUntil(clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: "Tsuruism", body: "You have a notification" };
  }

  const options = {
    body: data.body || "",
    icon: "/assets/icon.png",
    badge: "/assets/badge.png",
    vibrate: [200, 100, 200],
    data: data,   // includes taskId
    actions: [
      { action: "snooze", title: "💤 Snooze" },
      { action: "stop", title: "🔕 Stop" }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "Tsuruism", options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const taskId = data.taskId;

  // Prevent undefined taskId errors
  if (!taskId) {
    event.waitUntil(clients.openWindow("/index.html"));
    return;
  }

  const tokenPromise = self.clients.matchAll({ includeUncontrolled: true })
    .then(clientsArr => {
      const client = clientsArr[0];
      return client ? client.postMessage({ type: "GET_TOKEN" }) : null;
    });

  // snooze action
 if (event.action === "snooze") {
  const snoozeUntil = new Date(Date.now() + 10 * 60000).toISOString();

  event.waitUntil(
    fetch(`http://localhost:3000/tasks/${taskId}/snooze`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${JWT_TOKEN}`
      },
      body: JSON.stringify({ snooze_until: snoozeUntil })
    }).then(() => console.log(`Task ${taskId} snoozed`))
  );
  return;
}

  // stop notifications action
  if (event.action === "stop") {
  event.waitUntil(
    fetch(`http://localhost:3000/tasks/${taskId}/stop`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${JWT_TOKEN}`
      }
    }).then(() => console.log(`Task ${taskId} notifications stopped`))
  );
  return;
}

  // Default click → open app
  event.waitUntil(clients.openWindow("/index.html"));
});
