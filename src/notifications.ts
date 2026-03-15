import { query } from "./db";

/**
 * Finds events starting within the next 30 minutes that haven't been notified,
 * sends Expo push notifications, then marks them as notified.
 * Called on a 5-minute interval from index.ts.
 */
export async function checkAndSendNotifications() {
  const { rows } = await query(`
    SELECT e.id, e.title, e.location, u.push_token
    FROM events e
    JOIN users u ON u.id = e.user_id
    WHERE e.notified = FALSE
      AND u.push_token IS NOT NULL
      AND e.start_at::TIMESTAMPTZ > NOW()
      AND e.start_at::TIMESTAMPTZ <= NOW() + INTERVAL '30 minutes'
  `);

  if (rows.length === 0) return;

  const messages = rows.map((row: any) => ({
    to: row.push_token,
    title: "Upcoming event",
    body: `${row.title} starts in 30 minutes${row.location ? ` at ${row.location}` : ""}`,
    sound: "default",
  }));

  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify(messages),
    });

    if (!res.ok) {
      console.error("[push] Expo API error:", res.status, await res.text());
      return;
    }
  } catch (err: any) {
    console.error("[push] Failed to reach Expo API:", err.message);
    return;
  }

  // Mark all notified events so we don't send duplicates
  const ids = rows.map((r: any) => r.id);
  const placeholders = ids.map((_: any, i: number) => `$${i + 1}`).join(", ");
  await query(`UPDATE events SET notified = TRUE WHERE id IN (${placeholders})`, ids);
}
