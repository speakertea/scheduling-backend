const connections = new Map<string, Set<any>>();

export function addConnection(userId: string, ws: any): void {
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId)!.add(ws);
}

export function removeConnection(userId: string, ws: any): void {
  connections.get(userId)?.delete(ws);
  if (connections.get(userId)?.size === 0) connections.delete(userId);
}

export function disconnectUser(userId: string): void {
  const conns = connections.get(userId);
  if (!conns?.size) return;
  for (const ws of conns) {
    try {
      ws.close();
    } catch {}
  }
  connections.delete(userId);
}

export function broadcastToUser(userId: string, message: object): void {
  const conns = connections.get(userId);
  if (!conns?.size) return;
  const data = JSON.stringify(message);
  for (const ws of conns) {
    try { ws.send(data); } catch {}
  }
}

export function broadcastToUsers(userIds: string[], message: object): void {
  for (const id of userIds) broadcastToUser(id, message);
}
