# 🚀 Fullstack Todo Productivity App

A modern full-stack productivity application with real-time task tracking and push notification reminders.

---

## 🔥 Features

* 🔐 JWT Authentication (Login / Signup)
* 📝 Create, update, delete tasks
* ⏰ Schedule tasks with date & time
* 🔔 Push notifications using Service Workers
* ⚡ Background cron-based reminder system
* 📊 Task prioritization (Low / Medium / High)
* 📱 Responsive UI

---

## 🧠 Tech Stack

**Frontend**

* HTML, CSS, JavaScript
* Service Workers (Push API)

**Backend**

* Node.js, Express.js
* MySQL
* node-cron
* web-push (VAPID)

---

## ⚙️ How It Works

1. User creates a task with a scheduled time
2. Backend stores it in MySQL
3. Cron job checks every minute
4. When time matches → push notification sent
5. Service Worker displays notification

---

## 🔑 Environment Variables

Create a `.env` file:

```
DB_HOST=your_host
DB_USER=your_user
DB_PASSWORD=your_password
DB_NAME=your_db

VAPID_PUBLIC_KEY=your_public_key
VAPID_PRIVATE_KEY=your_private_key
VAPID_EMAIL=your_email
```

---

## 🚀 Run Locally

```
npm install
node server.js
node notifier.js
```

---

## ⚠️ Notes

* Notifications require HTTPS (works in production)
* App runs in limited mode if DB is not connected

---

## 📌 Future Improvements

* Deploy with cloud database
* Add recurring tasks
* Add real-time sync (WebSockets)
* Mobile app version

---

## Screenshots

### Login Page
![Login Page]
<img width="1916" height="924" alt="image" src="https://github.com/user-attachments/assets/e19b2c4b-d2cc-48f0-add9-bcac0312078d" />


### Task Dashboard
![Dashboard](screenshots/dashboard.png)
<img width="1918" height="924" alt="image" src="https://github.com/user-attachments/assets/c16363c0-d640-4f1f-9aa7-b76286ac0a65" />

### Notification Example
![Notification](screenshots/notification.png)
<img width="1919" height="909" alt="image" src="https://github.com/user-attachments/assets/78f2efe9-4dbb-4ec9-be80-c909f15a6d43" />


## 👨‍💻 Author

Anant Negi
