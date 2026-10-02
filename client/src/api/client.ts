const rawBaseUrl = (import.meta.env.VITE_API_URL || "http://localhost:5000/api")
  .trim()
  .replace(/\/+$/, "");

export const API_BASE_URL = rawBaseUrl.endsWith("/api")
  ? rawBaseUrl
  : `${rawBaseUrl}/api`;

const BASE_URL = API_BASE_URL;

function resolveUrl(endpoint: string): string {
  if (endpoint.startsWith("http")) return endpoint;
  const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${BASE_URL}${cleanEndpoint}`;
}

export interface ApiError {
  message: string;
  status?: number;
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem("token");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const url = resolveUrl(endpoint);

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data.error || data.message || `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

export const makeOwner = async (
  _userOrId?: { id: number } | number
): Promise<{ message: string }> => {
  return request<{ message: string }>("/auth/become-owner", { method: "POST" });
};

export const makeowner = makeOwner;

export const apiClient = {
  get: <T>(endpoint: string, options?: RequestInit) => request<T>(endpoint, { method: "GET", ...options }),
  post: <T>(endpoint: string, body?: any) =>
    request<T>(endpoint, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  // postForm is used for uploading files using FormData
  // TODO: Learn more
  postForm: async <T>(endpoint: string, formData: FormData): Promise<T> => {
    const token = localStorage.getItem("token");
    const url = resolveUrl(endpoint);

    const res = await fetch(url, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: formData, // no Content-Type — browser sets it with the correct multipart boundary
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.error || data.message || `Request failed with status ${res.status}`;
      throw new Error(message);
    }
    return data as T;
  },
  patchForm: async <T>(endpoint: string, formData: FormData): Promise<T> => {
    const token = localStorage.getItem("token");
    const url = resolveUrl(endpoint);

    const res = await fetch(url, {
      method: "PATCH",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: formData, // no Content-Type — browser sets it with the correct multipart boundary
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data.error || data.message || `Request failed with status ${res.status}`;
      throw new Error(message);
    }
    return data as T;
  },
  patch: <T>(endpoint: string, body?: any) =>
    request<T>(endpoint, {
      method: "PATCH",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  put: <T>(endpoint: string, body?: any) =>
    request<T>(endpoint, {
      method: "PUT",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  delete: <T>(endpoint: string) => request<T>(endpoint, { method: "DELETE" }),
  makeOwner,
  makeowner,
};