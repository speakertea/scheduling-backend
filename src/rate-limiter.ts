import { Elysia } from "elysia";

interface RateLimitEntry {
  count: number;
  resetAt: number; // epoch ms
}

const store = new Map<string, RateLimitEntry>();

// Prune expired entries every 5 minutes to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now >= entry.resetAt) store.delete(key);
  }
}, 5 * 60_000);

function getIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Decode the JWT payload (without verifying the signature) to get the userId.
 * We only use this value as a rate-limit bucket key — the real auth check is
 * done by authGuard later in the pipeline.
 */
function getUserIdFromBearer(request: Request): string | null {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return null;
  try {
    const payloadB64 = token.split(".")[1];
    if (!payloadB64) return null;
    const decoded = JSON.parse(atob(payloadB64));
    return decoded.userId || decoded.sub || null;
  } catch {
    return null;
  }
}

/**
 * Fixed-window rate limiter.
 * Returns whether the request is allowed and, if not, how many seconds until
 * the window resets.
 */
function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now >= entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count++;
  return { allowed: true, retryAfter: 0 };
}

const WINDOW_MS = 60_000; // 1 minute

export const rateLimiter = new Elysia({ name: "rateLimiter" })
  .onBeforeHandle({ as: "global" }, ({ request, set }) => {
    const pathname = new URL(request.url).pathname;

    // Health check is exempt
    if (pathname === "/api/health") return;

    const ip = getIp(request);
    let key: string;
    let maxRequests: number;

    if (pathname === "/api/auth/login") {
      // Brute-force protection: 5 attempts / min / IP
      key = `login:${ip}`;
      maxRequests = 5;
    } else if (pathname === "/api/auth/register/start") {
      // Prevent email spam: 3 / min / IP
      key = `register-start:${ip}`;
      maxRequests = 3;
    } else if (pathname === "/api/auth/forgot-password/start") {
      // Prevent email spam: 3 / min / IP
      key = `forgot-start:${ip}`;
      maxRequests = 3;
    } else if (
      pathname === "/api/auth/register/resend" ||
      pathname === "/api/auth/forgot-password/resend"
    ) {
      // Strict resend cap: 2 / min / IP (per-endpoint)
      key = `resend:${pathname}:${ip}`;
      maxRequests = 2;
    } else {
      // All other routes: 60 / min per authenticated user (fallback to IP)
      const userId = getUserIdFromBearer(request);
      key = `api:${userId ?? ip}`;
      maxRequests = 60;
    }

    const { allowed, retryAfter } = checkRateLimit(key, maxRequests, WINDOW_MS);
    if (!allowed) {
      set.status = 429;
      return { error: `Too many requests. Try again in ${retryAfter} seconds.` };
    }
  });
