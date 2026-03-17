import { query } from "./db";

/**
 * Delivers a sponsored event to all targeted users and sends push
 * notifications to those who have a push token.
 * Returns the number of successfully sent push notifications.
 */
export async function sendSponsoredEvent(event: any): Promise<number> {
  // Build targeting query — target ALL matching users, not just those with push tokens
  let where = "1=1";
  const params: any[] = [];
  let idx = 1;

  if (!event.target_all) {
    const conditions: string[] = [];
    if (event.target_cities?.length > 0) {
      conditions.push(`city = ANY($${idx})`);
      params.push(event.target_cities);
      idx++;
    }
    if (event.target_regions?.length > 0) {
      conditions.push(`region = ANY($${idx})`);
      params.push(event.target_regions);
      idx++;
    }
    if (conditions.length > 0) {
      where += ` AND (${conditions.join(" OR ")})`;
    } else {
      // No targeting criteria and not target_all — nothing to send
      await query(
        "UPDATE sponsored_events SET status = 'sent', sent_at = NOW(), total_sent = 0 WHERE id = $1",
        [event.id]
      );
      return 0;
    }
  }

  const { rows: allUsers } = await query(`SELECT id, push_token FROM users WHERE ${where}`, params);

  if (allUsers.length === 0) {
    await query(
      "UPDATE sponsored_events SET status = 'sent', sent_at = NOW(), total_sent = 0 WHERE id = $1",
      [event.id]
    );
    return 0;
  }

  // Create delivery records for ALL targeted users (regardless of push token)
  const deliveryValues: string[] = [];
  const deliveryParams: any[] = [];
  let dIdx = 1;
  for (const u of allUsers) {
    const did = crypto.randomUUID();
    deliveryValues.push(`($${dIdx}, $${dIdx + 1}, $${dIdx + 2}, TRUE, NOW())`);
    deliveryParams.push(did, event.id, u.id);
    dIdx += 3;
  }

  // Insert in chunks to avoid huge queries
  const CHUNK_SIZE = 200;
  for (let i = 0; i < deliveryValues.length; i += CHUNK_SIZE) {
    const chunk = deliveryValues.slice(i, i + CHUNK_SIZE);
    const chunkParams = deliveryParams.slice(i * 3, (i + CHUNK_SIZE) * 3);
    await query(
      `INSERT INTO sponsored_event_deliveries (id, sponsored_event_id, user_id, delivered, delivered_at) VALUES ${chunk.join(", ")}
       ON CONFLICT (sponsored_event_id, user_id) DO NOTHING`,
      chunkParams
    );
  }

  // Send push notifications only to users WITH a push token
  const pushUsers = allUsers.filter((u: any) => u.push_token);
  const title = event.sponsor_name ? `Collabo + ${event.sponsor_name}` : "Collabo";
  const messages = pushUsers.map((u: any) => ({
    to: u.push_token,
    title,
    body: event.title,
    sound: "default",
    data: { type: "sponsored_event", sponsoredEventId: event.id },
  }));

  let totalPushed = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    try {
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
        },
        body: JSON.stringify(batch),
      });
      if (res.ok) {
        totalPushed += batch.length;
      } else {
        console.error("[sponsored-push] Expo API error:", res.status, await res.text());
      }
    } catch (err: any) {
      console.error("[sponsored-push] Failed to reach Expo API:", err.message);
    }
  }

  // Update the sponsored event — total_sent = all delivered users, not just pushed
  await query(
    "UPDATE sponsored_events SET status = 'sent', sent_at = NOW(), total_sent = $1 WHERE id = $2",
    [allUsers.length, event.id]
  );

  console.log(`[sponsored-send] Event ${event.id}: delivered to ${allUsers.length} users, pushed to ${totalPushed}`);
  return allUsers.length;
}
