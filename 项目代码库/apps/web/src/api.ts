export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(value.message ?? "请求失败"), {
      details: value,
      status: response.status,
    });
  return value as T;
}
