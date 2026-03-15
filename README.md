# Scheduling App Backend

**Elysia + Bun + PostgreSQL**

---

## Local Development

### 1. Install Bun

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

### 2. Set up PostgreSQL locally

```bash
createdb scheduling_app
```

### 3. Start the backend

```bash
cd backend
cp .env.example .env    # edit DATABASE_URL if your Postgres credentials differ
bun install
bun run dev             # auto-restarts on file changes
```

Server starts at `http://localhost:3000`.

### 4. Integrate with your Expo app

```bash
cp frontend-updates/package.json    your-app/package.json
cp frontend-updates/lib/api.ts      your-app/lib/api.ts
cp frontend-updates/lib/store.ts    your-app/lib/store.ts
cp frontend-updates/app/auth.tsx    your-app/app/auth.tsx
cp frontend-updates/app/index.tsx   your-app/app/index.tsx
cp frontend-updates/app/profile.tsx your-app/app/profile.tsx

cd your-app
npm install
npx expo install expo-secure-store
```

### 5. Run both

```bash
# Terminal 1 — backend
cd backend && bun run dev

# Terminal 2 — Expo
cd your-app && npx expo start
```

---

## Deploy to Render (Production)

### 1. Push to GitHub

```bash
cd backend
git init && git add . && git commit -m "Elysia backend"
git remote add origin https://github.com/YOUR_USER/scheduling-backend.git
git push -u origin main
```

### 2. Create a PostgreSQL database on Render

1. Go to render.com → Dashboard → **New** → **PostgreSQL**
2. Pick the **Free** tier
3. Name it `scheduling-db`
4. Click **Create Database**
5. Copy the **Internal Database URL** (starts with `postgresql://...`)

### 3. Deploy the backend on Render

1. Dashboard → **New** → **Web Service**
2. Connect your GitHub repo
3. Configure:
   - **Runtime:** Node (Render runs Bun via the build command below)
   - **Build Command:** `curl -fsSL https://bun.sh/install | bash && ~/.bun/bin/bun install`
   - **Start Command:** `~/.bun/bin/bun run src/index.ts`
4. Add environment variables:
   - `DATABASE_URL` = the Internal Database URL you copied
   - `JWT_SECRET` = any long random string
   - `PORT` = `10000` (Render's default)
5. Click **Deploy**

Render gives you a URL like `https://scheduling-backend.onrender.com`.

### 4. Point your app at the live backend

Edit `lib/api.ts` in your Expo project:

```typescript
const BASE_URLS: Record<string, string> = {
  android: "https://scheduling-backend.onrender.com/api",
  ios: "https://scheduling-backend.onrender.com/api",
  web: "https://scheduling-backend.onrender.com/api",
};
```

### 5. Build and publish your mobile app

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --platform all
eas submit --platform ios      # Apple Developer ($99/year)
eas submit --platform android  # Google Play Console ($25 one-time)
```

---

## What Changed (Frontend)

| File | Change |
|------|--------|
| `package.json` | `zustand` moved to dependencies, `expo-secure-store` added |
| `lib/api.ts` | **New** — fetch wrapper with JWT + token persistence |
| `lib/store.ts` | Same interface, now syncs to API in background |
| `app/auth.tsx` | Real login/register with error handling |
| `app/index.tsx` | Restores saved session on app launch |
| `app/profile.tsx` | Added logout button |

**Zero changes needed:** all tab screens, modals, components, types, social.ts, datetime.ts.

---

## API Endpoints

All require `Authorization: Bearer <token>` except auth routes.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login → token |
| GET | `/api/auth/me` | Current user info |
| GET/PATCH | `/api/profile` | Get/update profile |
| GET/POST/DELETE | `/api/events` | Personal events CRUD |
| GET | `/api/invites?type=group\|friend` | Social invites |
| PATCH | `/api/invites/:id/rsvp` | RSVP (yes/maybe/no) |
| GET | `/api/calendar-events?type=group\|friend` | Shared calendar events |
| PATCH | `/api/calendar-events/:id` | Accept/decline |
| POST | `/api/social/create` | Create invite or calendar event |
| GET | `/api/groups` | List groups |
| GET | `/api/friends` | List friends |
| GET/POST | `/api/notifications/*` | Dismiss/clear notifications |

---

## Why Elysia + Bun?

- **Faster:** Bun's HTTP server + Elysia's optimizations make this significantly faster than Express + Node
- **Type-safe:** Request bodies are validated at runtime automatically from the schema definitions
- **Less code:** Same API in ~40% fewer lines than the Express version
- **Same frontend:** Your Expo app doesn't know or care what framework the backend uses — it just hits the same endpoints
