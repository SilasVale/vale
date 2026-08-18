const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || res.statusText);
  }
  return res.json();
}

export interface Device {
  name: string;
  hostname: string;
  status: "online" | "offline";
  lastSeen: string;
  config: Record<string, unknown>;
}

export interface PluginInfo {
  name: string;
  enabled: boolean;
  state: string;
  deps: string[];
}

export interface GatewayConfig {
  plugins: Record<string, unknown>;
  auth: Record<string, unknown>;
  channels: Record<string, unknown>;
}

export const api = {
  getDevices: () => request<Device[]>("/devices"),
  getDevice: (id: string) => request<Device>(`/devices/${id}`),
  updateDevice: (id: string, config: Partial<Device>) =>
    request<Device>(`/devices/${id}`, { method: "PATCH", body: JSON.stringify(config) }),

  getPlugins: () => request<PluginInfo[]>("/plugins"),
  togglePlugin: (name: string, enabled: boolean) =>
    request<void>(`/plugins/${name}/toggle`, { method: "POST", body: JSON.stringify({ enabled }) }),

  getConfig: () => request<GatewayConfig>("/config"),
  updateConfig: (config: Partial<GatewayConfig>) =>
    request<void>("/config", { method: "PATCH", body: JSON.stringify(config) }),
};
