# 🔐 Firebase Google Login Setup Guide

Complete step-by-step to enable Google login for Tax America Services.

---

## Step 1 — Create a Firebase Project

1. Go to **https://console.firebase.google.com**
2. Click **"Add project"**
3. Name it: `tax-america-services` (or anything you like)
4. Disable Google Analytics (not needed) → **Create project**
5. Wait ~30 seconds for it to initialize

---

## Step 2 — Enable Google Sign-In

1. In your Firebase project, click **Authentication** in the left menu
2. Click **Get started**
3. Click the **Sign-in method** tab
4. Click **Google** → toggle **Enable** → ON
5. Set **Project support email** → your Gmail address
6. Click **Save**

---

## Step 3 — Register your Web App

1. In Firebase Console → click the **gear icon** ⚙️ → **Project settings**
2. Scroll to **"Your apps"** section
3. Click the **`</>`** (Web) icon
4. App nickname: `Tax America Services Web`
5. ✅ Check **"Also set up Firebase Hosting"** → NO (skip this)
6. Click **Register app**
7. You'll see a config block like this — **copy all the values**:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

---

## Step 4 — Add Authorized Domains

1. Firebase Console → **Authentication** → **Settings** tab
2. Scroll to **Authorized domains**
3. Click **Add domain** and add:
   ```
   tax-america-services.onrender.com
   ```
   (Replace with your actual Render URL)
4. Click **Add**

> ⚠️ Without this step, Google login will fail with "unauthorized domain" error.

---

## Step 5 — Add Environment Variables to Render

1. Go to **render.com** → your service → **Environment** tab
2. Add each variable from your Firebase config:

| Key | Value (from your Firebase config) |
|-----|----------------------------------|
| `VITE_FIREBASE_API_KEY` | `AIzaSy...` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `your-project.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | `your-project-id` |
| `VITE_FIREBASE_STORAGE_BUCKET` | `your-project.appspot.com` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `123456789` |
| `VITE_FIREBASE_APP_ID` | `1:123456789:web:abc123` |

3. Click **Save Changes** → Render will trigger a new deploy

> ⚠️ VITE_ prefix is required — Vite only exposes env vars with this prefix to the browser.

---

## Step 6 — Local Development

Create `client/.env.local` (git-ignored):

```bash
cd client
cp .env.example .env.local
# Edit .env.local and fill in your Firebase values
```

Then run:
```bash
# Terminal 1
node server.js

# Terminal 2
cd client && npm run dev
```

---

## Step 7 — Push & Deploy

```bash
git add .
git commit -m "Add Firebase Google auth"
git push origin main
```

Render auto-deploys. After deploy, visit your URL and click **"Ingresar con Google"** — a Google popup will appear and sign you in with your real Google account.

---

## How it works

- **Login** → Google popup opens → user selects their Google account → Firebase returns a verified user object with `uid`, `email`, `displayName`, `photoURL`
- **Session** → Firebase SDK handles the session automatically (persists across page refreshes)
- **Ownership** → Each apartment is tied to the owner's Firebase `uid` — only that user can edit/delete their listings
- **Anyone** with a Google account can log in and report incidents
- **Public** — the dashboard is visible without login (read-only)

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `auth/unauthorized-domain` | Add your Render URL to Firebase → Authentication → Authorized domains |
| `auth/popup-blocked` | Browser blocked popup — user needs to allow popups for your domain |
| `VITE_FIREBASE_API_KEY is undefined` | Forgot the `VITE_` prefix in Render env vars, or forgot to redeploy after adding them |
| Login works locally but not on Render | Authorized domains missing — see Step 4 |
