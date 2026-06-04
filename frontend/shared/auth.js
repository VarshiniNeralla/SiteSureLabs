const TOKEN_KEY = "defectra_token";
const USER_KEY = "defectra_user";
/** Set when the session started from /admin/login/ (not standard / sign-in). */
const ADMIN_LOGIN_KEY = "defectra_admin_login";

export function saveAuth(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function markAdminLoginSession() {
  localStorage.setItem(ADMIN_LOGIN_KEY, "1");
}

export function clearAdminLoginSession() {
  localStorage.removeItem(ADMIN_LOGIN_KEY);
}

export function isAdminLoginSession() {
  return localStorage.getItem(ADMIN_LOGIN_KEY) === "1";
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
  clearAdminLoginSession();
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

let _pendingAuthRedirect = 0;

export async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const skipRedirect = options._skipAuthRedirect === true;
  const fetchOpts = { ...options, headers };
  delete fetchOpts._skipAuthRedirect;

  const res = await fetch(url, fetchOpts);
  if (res.status === 401) {
    if (skipRedirect) return null;
    clearAuth();
    if (!_pendingAuthRedirect) {
      _pendingAuthRedirect = window.setTimeout(() => {
        _pendingAuthRedirect = 0;
        if (!getToken()) window.location.href = "/";
      }, 300);
    }
    return null;
  }
  return res;
}
