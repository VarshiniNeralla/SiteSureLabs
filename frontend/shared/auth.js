const TOKEN_KEY = "defectra_token";
const USER_KEY = "defectra_user";

export function saveAuth(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser() {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function requireAuth() {
  const token = getToken();
  if (!token) {
    window.location.href = "/";
    return null;
  }
  return token;
}

export function requireAdmin() {
  const user = getUser();
  if (!user || user.role !== "admin") {
    window.location.href = "/";
    return null;
  }
  return requireAuth();
}

export async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    clearAuth();
    window.location.href = "/";
    return null;
  }
  return res;
}
