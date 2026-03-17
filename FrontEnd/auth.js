// auth.js
const loginBtn = document.getElementById("loginBtn");
const existingToken = localStorage.getItem("token");

// only redirect if user is actually on login page AND not submitting the form
if (existingToken && window.location.pathname.includes("login.html")) {
  // use replace so history doesn't keep login
  window.location.replace("index.html");
}

if (loginBtn) {
  loginBtn.addEventListener("click", async () => {
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value.trim();
    const msg = document.getElementById("loginMsg");

    if (!email || !password) {
      msg.textContent = "⚠️ Please fill in both fields!";
      msg.style.color = "red";
      return;
    }

    try {
      const res = await fetch("http://localhost:3000/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (res.ok && data.token) {
        localStorage.setItem("token", data.token);
        localStorage.setItem("username", data.user.username);
        msg.textContent = "✅ Login successful! Redirecting...";
        msg.style.color = "green";

        setTimeout(() => {
          window.location.href = "index.html";
        }, 800);
      } else {
        msg.textContent = data.message || "❌ Login failed!";
        msg.style.color = "red";
      }
    } catch (error) {
      console.error("Login error:", error);
      msg.textContent = "⚠️ Server error. Please try again";
      msg.style.color = "red";
    }
  });
}

// Signup
const signupBtn = document.getElementById("signupBtn");

if (signupBtn) {
  signupBtn.addEventListener("click", async () => {
    const username = document.getElementById("signupUsername").value.trim();
    const email = document.getElementById("signupEmail").value.trim();
    const password = document.getElementById("signupPassword").value.trim();
    const msg = document.getElementById("signupMsg");

    if (!username || !email || !password) {
      msg.textContent = "⚠️ Please fill in all fields!";
      msg.style.color = "red";
      return;
    }

    try {
      const res = await fetch("http://localhost:3000/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email, password }),
      });

      const data = await res.json();

      if (res.ok) {
        msg.textContent = "✅ Account created successfully! Redirecting to login...";
        msg.style.color = "green";

        setTimeout(() => {
          window.location.href = "login.html";
        }, 1200);
      } else {
        msg.textContent = data.message || "❌ Signup failed!";
        msg.style.color = "red";
      }
    } catch (error) {
      console.error("Signup error:", error);
      msg.textContent = "⚠️ Server error. Please try again";
      msg.style.color = "red";
    }
  });
}
