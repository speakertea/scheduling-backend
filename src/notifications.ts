import { query } from "./db";

type GroupNotificationLevel = "all" | "highlights" | "mute";

type PushMessage = {
  to: string;
  title: string;
  body: string;
  sound?: string;
};

async function sendExpoPush(messages: PushMessage[]) {
  if (messages.length === 0) return;

  try {
    const res = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify(messages),
    });

    if (!res.ok) {
      console.error("[push] Expo API error:", res.status, await res.text());
    }
  } catch (err: any) {
    console.error("[push] Failed to reach Expo API:", err.message);
  }
}

async function getAllowedGroupRecipients(
  groupId: string,
  userIds: string[],
  minimumLevel: GroupNotificationLevel = "highlights"
) {
  if (userIds.length === 0) return [];

  const { rows } = await query(
    `SELECT u.id, u.push_token AS "pushToken", COALESCE(gns.level, 'all') AS level
     FROM users u
     LEFT JOIN group_notification_settings gns
       ON gns.user_id = u.id AND gns.group_id = $1
     WHERE u.id = ANY($2::text[])
       AND u.push_token IS NOT NULL`,
    [groupId, userIds]
  );

  return rows.filter((row: any) => {
    if (row.level === "mute") return false;
    if (minimumLevel === "highlights") {
      return row.level === "all" || row.level === "highlights";
    }
    return row.level === "all";
  });
}

export async function sendGroupInvitePush(
  groupId: string,
  recipientIds: string[],
  payload: { groupName: string; title: string; startAt?: string; type: "social" | "calendar" }
) {
  const rows = await getAllowedGroupRecipients(groupId, recipientIds, "highlights");
  const messages = rows.map((row: any) => ({
    to: row.pushToken,
    title: payload.type === "calendar" ? "New group event" : "New group invite",
    body:
      payload.type === "calendar"
        ? `${payload.groupName}: ${payload.title}`
        : `${payload.groupName}: ${payload.title}`,
    sound: "default" as const,
  }));
  await sendExpoPush(messages);
}

export async function sendGroupJoinRequestPush(
  groupId: string,
  requesterName: string,
  groupName: string,
  adminIds: string[]
) {
  const rows = await getAllowedGroupRecipients(groupId, adminIds, "highlights");
  const messages = rows.map((row: any) => ({
    to: row.pushToken,
    title: "Group approval needed",
    body: `${requesterName} wants to join ${groupName}`,
    sound: "default" as const,
  }));
  await sendExpoPush(messages);
}

export async function sendJoinRequestOutcomePush(
  recipientUserId: string,
  payload: { approved: boolean; groupName: string }
) {
  const { rows } = await query(
    "SELECT push_token AS \"pushToken\" FROM users WHERE id = $1 AND push_token IS NOT NULL",
    [recipientUserId]
  );
  const pushToken = rows[0]?.pushToken;
  if (!pushToken) return;

  await sendExpoPush([
    {
      to: pushToken,
      title: payload.approved ? "You are in" : "Request declined",
      body: payload.approved
        ? `You were approved to join ${payload.groupName}`
        : `Your request to join ${payload.groupName} was declined`,
      sound: "default",
    },
  ]);
}

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

  await sendExpoPush(messages);

  // Mark all notified events so we don't send duplicates
  const ids = rows.map((r: any) => r.id);
  const placeholders = ids.map((_: any, i: number) => `$${i + 1}`).join(", ");
  await query(`UPDATE events SET notified = TRUE WHERE id IN (${placeholders})`, ids);
}
