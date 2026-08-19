/**
 * API client — thin wrapper around fetch with credentials: 'same-origin'
 * and automatic JSON parsing. 401 responses trigger a global auth reset
 * (via notifyUnauthorized) so the UI switches to the login page.
 */

import { notifyUnauthorized } from "../contexts/AuthContext.tsx";

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export interface ApiResponse<T> {
  ok: boolean;
  data: T | null;
  error?: { message: string };
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* noop */
  }
  if (res.status === 401) {
    notifyUnauthorized();
    throw new ApiError(401, "Unauthorized", data);
  }
  if (!res.ok) {
    const errData = data as { error?: { message: string } } | undefined;
    throw new ApiError(res.status, errData?.error?.message || res.statusText, data);
  }
  return data as T;
}

// ── Types ──────────────────────────────────────────────────────

export interface Me {
  username: string;
  role: "admin" | "user";
  token: string;
  keys: Record<string, { configured: boolean; masked: string } | undefined>;
}

export interface RouteInfo {
  prefix: string;
  backend: string;
  desc: string;
  models: string[];
}

export interface PublicRouteInfo {
  routes: RouteInfo[];
  apiHost: string;
}

export interface HealthChannel {
  id: string;
  model: string;
  ok: boolean;
  reason?: string;
}

export interface HealthResponse {
  channels: HealthChannel[];
}

export interface User {
  id: string;
  username: string;
  role: string;
  token: string;
  enabled: boolean;
}

export interface Device {
  name: string;
  hostname: string;
  token: string;
}

export interface DeviceStatus {
  agent_up?: boolean;
  online?: boolean;
}

// ── API endpoints ──────────────────────────────────────────────

export const api = {
  // Auth
  me: () => request<Me>("/api/me"),
  login: (username: string, password: string) =>
    request<unknown>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  register: (username: string, password: string, inviteCode: string) =>
    request<unknown>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password, inviteCode }),
    }),
  resetPassword: (adminKey: string, newPassword: string) =>
    request<unknown>("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ adminKey, newPassword }),
    }),
  logout: () => request<unknown>("/api/auth/logout", { method: "POST" }),

  // Route
  getRoute: () => request<{ model?: string; effective?: string }>("/api/me/route"),
  setRoute: (model: string | null) =>
    request<unknown>("/api/me/route", {
      method: "PUT",
      body: JSON.stringify({ model }),
    }),

  // US Proxy
  getUsProxy: () => request<{ enabled: boolean }>("/api/me/usproxy"),
  setUsProxy: (enabled: boolean) =>
    request<unknown>("/api/me/usproxy", {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

  // Keys
  saveKey: (name: string, value: string) =>
    request<{ masked: string }>("/api/me/keys", {
      method: "PUT",
      body: JSON.stringify({ name, value }),
    }),
  deleteKey: (name: string) =>
    request<unknown>(`/api/me/keys?name=${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  testKey: (name: string) =>
    request<{ ok: boolean; status?: number; detail?: string }>("/api/me/keys/test", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  usageKey: (name: string) =>
    request<{ ok: boolean; label?: string; usage?: number; limit?: number | null; rateLimit?: { limit?: number; interval?: string }; detail?: string }>("/api/me/keys/usage", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  // Public routes
  getPublicRoutes: () => request<PublicRouteInfo>("/api/admin/public"),

  // Health
  getHealth: () => request<HealthResponse>("/api/health"),

  // Token regen
  regenerateToken: () =>
    request<{ token: string }>("/api/me/token/regenerate", { method: "POST" }),

  // Admin: password
  getAdminPassword: () => request<{ set: boolean }>("/api/admin/password"),
  setAdminPassword: (password: string) =>
    request<unknown>("/api/admin/password", {
      method: "PUT",
      body: JSON.stringify({ password }),
    }),

  // Admin: invite
  generateInvite: () => request<{ code: string }>("/api/admin/invite", { method: "POST" }),

  // Admin: users
  getUsers: () => request<{ users: User[] }>("/api/admin/users"),
  setEnabled: (id: string, enabled: boolean) =>
    request<unknown>(`/api/admin/users/${encodeURIComponent(id)}/enabled`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

  // Admin: Cloudflare token
  getCfToken: () => request<{ configured: boolean; masked?: string }>("/api/admin/cloudflare-token"),
  setCfToken: (token: string) =>
    request<unknown>("/api/admin/cloudflare-token", {
      method: "PUT",
      body: JSON.stringify({ token }),
    }),

  // Devices
  getDevices: () => request<{ devices: Device[] }>("/api/devices"),
  saveDevice: (name: string, hostname: string, token: string) =>
    request<unknown>("/api/devices", {
      method: "POST",
      body: JSON.stringify({ name, hostname, token }),
    }),
  deleteDevice: (name: string) =>
    request<unknown>(`/api/devices/${encodeURIComponent(name)}`, { method: "DELETE" }),
  getDeviceMcp: (name: string) =>
    request<{ mcp: { json: string } }>(`/api/devices/${encodeURIComponent(name)}/mcp`),

  // Devices: registration key
  generateRegKey: () => request<{ key: string }>("/api/devices/register-key", { method: "POST" }),

  // Plugins: pair
  pairDevice: (device: string) =>
    request<{ code: string }>("/api/plugins/pair", {
      method: "POST",
      body: JSON.stringify({ device }),
    }),

  // Plugins: status
  getPluginStatus: () => request<{ devices: Record<string, DeviceStatus> }>("/api/plugins/status"),
};
