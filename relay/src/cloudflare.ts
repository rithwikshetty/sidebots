// Each machine gets its address under the zone through a Cloudflare Tunnel.
// The relay makes the tunnel and its DNS record with Cloudflare's API, and the
// machine runs `cloudflared` with the tunnel's token, which holds a connection
// open from the machine to Cloudflare and brings the phone's requests along it.

const API = "https://api.cloudflare.com/client/v4";

/** What the relay needs to make tunnels: an API token that can edit tunnels on the account and DNS records on the zone. */
export type Tunnels = { token: string; accountId: string; zoneId: string };

/** Cloudflare's answer to a call: its result, and for a list how many there are in all. */
type Answer<T> = { result: T; result_info?: { total_count: number } };

/** Calls Cloudflare's API and returns its answer. Removing something that is already gone counts as done. `send` is how the relay reaches Cloudflare. */
async function ask<T>(token: string, send: typeof fetch, method: string, path: string, body?: object): Promise<Answer<T>> {
  const response = await send(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  });
  if (method === "DELETE" && response.status === 404) return { result: null as T };
  const answer = await response.json<Answer<T> & { success: boolean; errors?: { message: string }[] }>().catch(() => null);
  if (!answer?.success) throw new Error(`Cloudflare answered ${response.status} to ${method} ${path}: ${answer?.errors?.map((error) => error.message).join(" ") ?? ""}`);
  return answer;
}

/** Calls Cloudflare's API and returns the call's result. */
export async function cloudflare<T>(token: string, send: typeof fetch, method: string, path: string, body?: object): Promise<T> {
  return (await ask<T>(token, send, method, path, body)).result;
}

/** Makes a tunnel for the machine and points `address` at it. Returns the tunnel's id. */
export async function makeTunnel(tunnels: Tunnels, address: string, send: typeof fetch): Promise<string> {
  const { token, accountId, zoneId } = tunnels;
  // `cloudflare` keeps the tunnel's settings with Cloudflare, so the relay sets where it leads.
  const { id } = await cloudflare<{ id: string }>(token, send, "POST", `/accounts/${accountId}/cfd_tunnel`, { name: address, config_src: "cloudflare" });
  try {
    await cloudflare(token, send, "POST", `/zones/${zoneId}/dns_records`, { type: "CNAME", name: address, content: `${id}.cfargotunnel.com`, proxied: true });
  } catch (failure) {
    await cloudflare(token, send, "DELETE", `/accounts/${accountId}/cfd_tunnel/${id}`);
    throw failure;
  }
  return id;
}

/** Has the tunnel bring requests for `address` to the server's port on the machine, and returns the token `cloudflared` runs it with. */
export async function routeTunnel(tunnels: Tunnels, tunnelId: string, address: string, port: number, send: typeof fetch): Promise<string> {
  const { token, accountId } = tunnels;
  await cloudflare(token, send, "PUT", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    config: { ingress: [{ hostname: address, service: `http://127.0.0.1:${port}` }, { service: "http_status:404" }] },
  });
  return cloudflare<string>(token, send, "GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
}

/** Removes the tunnel and the DNS record that points `address` at it. */
export async function removeTunnel(tunnels: Tunnels, tunnelId: string, address: string, send: typeof fetch): Promise<void> {
  const { token, accountId, zoneId } = tunnels;
  const records = await cloudflare<{ id: string }[]>(token, send, "GET", `/zones/${zoneId}/dns_records?type=CNAME&name=${address}`);
  for (const record of records) await cloudflare(token, send, "DELETE", `/zones/${zoneId}/dns_records/${record.id}`);
  // A machine whose `cloudflared` is still running holds connections, which go first.
  await cloudflare(token, send, "DELETE", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`);
  await cloudflare(token, send, "DELETE", `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
}

/** How many DNS records the zone holds and may hold, and how many tunnels the account holds. A zone whose records count against its account's quota has none of its own. */
export async function capacity(tunnels: Tunnels, send: typeof fetch): Promise<{ records: number; recordsMost: number; tunnels: number }> {
  const { token, accountId, zoneId } = tunnels;
  const [records, made] = await Promise.all([
    cloudflare<{ record_usage: number; record_quota: number | null }>(token, send, "GET", `/zones/${zoneId}/dns_records/usage`),
    ask(token, send, "GET", `/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=1`),
  ]);
  return { records: records.record_usage, recordsMost: records.record_quota ?? Infinity, tunnels: made.result_info!.total_count };
}
