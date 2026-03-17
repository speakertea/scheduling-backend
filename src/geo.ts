export async function lookupIP(ip: string): Promise<{
  city: string | null;
  region: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
} | null> {
  try {
    // Skip localhost and private IPs
    if (!ip || ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.") || ip.startsWith("172.")) {
      return null;
    }
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=city,regionName,country,lat,lon,status`);
    const data = await res.json();
    if (data.status !== "success") return null;
    return {
      city: data.city || null,
      region: data.regionName || null,
      country: data.country || null,
      latitude: data.lat || null,
      longitude: data.lon || null,
    };
  } catch {
    return null;
  }
}
