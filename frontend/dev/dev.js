// Developer Portal SPA controller.
// Manages: login flow, RBAC gate, section navigation, and all /api/dev/* integrations.

const TOKEN_KEY = "defectra_dev_token";
const USER_KEY = "defectra_dev_user";
const THEME_KEY = "defectra_dev_theme";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  user: null,
  token: null,
  section: "overview",
  pages: {
    admins: { page: 1, limit: 50, search: "" },
    users: { page: 1, limit: 50, search: "", role: "", status: "" },
    uploads: { page: 1, limit: 10 },
    audit: { page: 1, limit: 50, action: "" },
  },
  analyticsRange: 30,
  inbox: {
    items: [],
    unread: 0,
    filter: "all",         // "all" | "unread"
    open: false,
    pollTimer: null,
    lastLatestId: null,    // used to detect new notifications since last poll
  },
};

const INBOX_POLL_MS = 25_000;

// ───────── Auth helpers ─────────
function saveAuth(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  state.token = token;
  state.user = user;
}

function loadAuth() {
  const token = localStorage.getItem(TOKEN_KEY);
  const userRaw = localStorage.getItem(USER_KEY);
  if (!token || !userRaw) return false;
  try {
    const user = JSON.parse(userRaw);
    if (user.role !== "developer") return false;
    state.token = token;
    state.user = user;
    return true;
  } catch {
    return false;
  }
}

function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  state.token = null;
  state.user = null;
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
  if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    clearAuth();
    showLoginView();
    throw new Error("Unauthorized");
  }
  return res;
}

async function apiJson(url, options) {
  const res = await api(url, options);
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).detail || ""; } catch { /* noop */ }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return res.json();
}

// ───────── Format helpers ─────────
function escapeHtml(value) {
  if (value == null) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function timeAgo(iso) {
  if (!iso) return "—";
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "—";
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function roleBadge(role) {
  const cls =
    role === "developer" ? "is-developer"
      : role === "admin" ? "is-admin"
        : "is-user";
  return `<span class="dev-badge ${cls}">${escapeHtml(role || "user")}</span>`;
}

function statusBadge(isDisabled) {
  return isDisabled
    ? `<span class="dev-badge is-disabled">Disabled</span>`
    : `<span class="dev-badge is-active">Active</span>`;
}

// ───────── Toast / dialog ─────────
function toast(message, kind = "info") {
  const el = $("#dev-toast");
  el.textContent = message;
  el.className = `dev-toast${kind === "error" ? " is-error" : kind === "success" ? " is-success" : ""}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function openDialog({ title, body, formHTML, confirmText, confirmKind, onConfirm }) {
  return new Promise((resolve) => {
    const root = $("#dev-dialog");
    $("#dev-dialog-title").textContent = title;
    $("#dev-dialog-body").textContent = body || "";
    $("#dev-dialog-form").innerHTML = formHTML || "";
    const confirmBtn = $("#dev-dialog-confirm");
    confirmBtn.textContent = confirmText || "Confirm";
    confirmBtn.className = `dev-btn ${confirmKind === "danger" ? "dev-btn-danger" : "dev-btn-primary"}`;

    const close = (value) => {
      root.hidden = true;
      confirmBtn.removeEventListener("click", handleConfirm);
      $$('[data-dialog-close]', root).forEach((b) => b.removeEventListener("click", handleClose));
      resolve(value);
    };
    const handleClose = () => close(null);
    const handleConfirm = async () => {
      try {
        confirmBtn.disabled = true;
        const formValue = collectDialogForm();
        const ok = onConfirm ? await onConfirm(formValue) : true;
        close(ok ? formValue || true : null);
      } catch (err) {
        toast(err?.message || "Action failed", "error");
        confirmBtn.disabled = false;
      }
    };
    confirmBtn.addEventListener("click", handleConfirm);
    $$('[data-dialog-close]', root).forEach((b) => b.addEventListener("click", handleClose));
    root.hidden = false;
  });
}

function collectDialogForm() {
  const inputs = $$('#dev-dialog-form [name]');
  if (!inputs.length) return null;
  const out = {};
  inputs.forEach((el) => { out[el.name] = el.value; });
  return out;
}

// ───────── Login view ─────────
function showLoginView() {
  $("#dev-login-view").hidden = false;
  $("#dev-app").hidden = true;
  stopInboxPolling();
  setTimeout(() => $("#dev-email")?.focus(), 30);
}

function showAppView() {
  $("#dev-login-view").hidden = true;
  $("#dev-app").hidden = false;

  const u = state.user || {};
  const displayName = u.name || (u.email ? u.email.split("@")[0] : "Developer");
  $("#dev-user-name").textContent = displayName;
  $("#dev-user-email").textContent = u.email || "";
  $("#dev-user-avatar").textContent = (displayName[0] || "D").toUpperCase();

  selectSection(state.section);
  startInboxPolling();
}

async function handleLogin(e) {
  e.preventDefault();
  const alertEl = $("#dev-login-alert");
  const submit = $("#dev-login-submit");
  const email = $("#dev-email").value.trim();
  const password = $("#dev-password").value;

  alertEl.classList.remove("is-visible");
  if (!email || !password) {
    alertEl.textContent = "Email and password are required.";
    alertEl.classList.add("is-visible");
    return;
  }

  submit.disabled = true;
  const original = submit.innerHTML;
  submit.innerHTML = '<span class="dev-btn-label">Signing in…</span>';

  try {
    const res = await fetch("/api/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alertEl.textContent = data.detail || "Sign in failed.";
      alertEl.classList.add("is-visible");
      return;
    }
    if (data.role !== "developer") {
      alertEl.textContent = "This account is not a developer account.";
      alertEl.classList.add("is-visible");
      return;
    }
    saveAuth(data.access_token, {
      user_id: data.user_id,
      email: data.email,
      role: data.role,
      name: data.name || null,
      profile_photo: data.profile_photo || null,
    });
    showAppView();
  } catch {
    alertEl.textContent = "Network error — is the server running?";
    alertEl.classList.add("is-visible");
  } finally {
    submit.disabled = false;
    submit.innerHTML = original;
  }
}

function handleLogout() {
  clearAuth();
  showLoginView();
}

// ───────── Section nav ─────────
const SECTION_META = {
  overview: { title: "Overview", sub: "Platform-wide system status and key metrics." },
  admins: { title: "Admin Management", sub: "Create, edit, and manage administrator accounts." },
  users: { title: "User Management", sub: "All registered users, their activity, and account status." },
  uploads: { title: "Upload Monitoring", sub: "Recent uploads across every project." },
  analytics: { title: "Analytics", sub: "Trends across uploads, signups, and activity." },
  audit: { title: "Audit Logs", sub: "Complete record of developer and admin actions." },
  health: { title: "System Health", sub: "Live status of core services." },
  settings: { title: "Settings", sub: "Effective platform configuration." },
};

function selectSection(name) {
  state.section = name;
  $$('.dev-nav-item').forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.section === name);
  });
  $$('.dev-section').forEach((sec) => {
    sec.hidden = sec.dataset.section !== name;
  });
  const meta = SECTION_META[name] || { title: name, sub: "" };
  $("#dev-section-title").textContent = meta.title;
  $("#dev-section-sub").textContent = meta.sub;

  switch (name) {
    case "overview": loadOverview(); break;
    case "admins": loadAdmins(); break;
    case "users": loadUsers(); break;
    case "uploads": loadUploads(); break;
    case "analytics": loadAnalytics(); break;
    case "audit": loadAudit(); break;
    case "health": loadHealth(); break;
    case "settings": loadSettings(); break;
  }
}

// ───────── Overview ─────────
async function loadOverview() {
  try {
    const data = await apiJson("/api/dev/overview");
    $("#ov-total-users").textContent = data.total_users.toLocaleString();
    $("#ov-disabled-users").textContent = `${data.disabled_accounts || 0} disabled account(s)`;
    $("#ov-total-admins").textContent = data.total_admins.toLocaleString();
    $("#ov-total-devs").textContent = `${data.total_developers} developer(s)`;
    $("#ov-total-uploads").textContent = data.total_uploads.toLocaleString();
    $("#ov-active-users").textContent = data.active_users.toLocaleString();
    $("#ov-storage").textContent = data.storage_human || "—";
    $("#ov-status").textContent = data.system_status === "ok" ? "Operational" : data.system_status;
    $("#ov-status-foot").textContent = `Refreshed ${timeAgo(data.generated_at)}`;
    updateStatusPill(data.system_status);
  } catch (err) {
    if (err.message !== "Unauthorized") toast(err.message, "error");
  }

  try {
    const activity = await apiJson("/api/dev/recent-activity?limit=10");
    const tbody = $("#ov-recent-tbody");
    if (!activity.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="dev-empty">No activity yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = activity.map((row) => `
      <tr>
        <td title="${escapeHtml(fmtDate(row.timestamp))}">${escapeHtml(timeAgo(row.timestamp))}</td>
        <td>${escapeHtml(row.actor_email)}</td>
        <td><code class="dev-mono">${escapeHtml(row.action)}</code></td>
        <td>${escapeHtml(row.target_email || "—")}</td>
      </tr>
    `).join("");
  } catch (err) {
    if (err.message !== "Unauthorized") {
      $("#ov-recent-tbody").innerHTML = `<tr><td colspan="4" class="dev-empty">${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

function updateStatusPill(statusValue) {
  const pill = $("#dev-status-pill");
  pill.classList.remove("is-warn", "is-danger");
  if (statusValue === "down") {
    pill.classList.add("is-danger");
    pill.textContent = "System: degraded";
  } else if (statusValue === "degraded") {
    pill.classList.add("is-warn");
    pill.textContent = "System: degraded";
  } else {
    pill.textContent = "System: operational";
  }
}

// ───────── Admin Management ─────────
async function loadAdmins() {
  const tbody = $("#admins-tbody");
  tbody.innerHTML = `<tr><td colspan="7" class="dev-empty">Loading…</td></tr>`;
  const p = state.pages.admins;
  const params = new URLSearchParams({ page: String(p.page), limit: String(p.limit) });
  if (p.search) params.set("search", p.search);
  try {
    const res = await api(`/api/dev/admins?${params.toString()}`);
    const total = Number(res.headers.get("X-Total-Count") || 0);
    const rows = await res.json();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="dev-empty">No admins found.</td></tr>`;
    } else {
      tbody.innerHTML = rows.map((row) => `
        <tr data-id="${escapeHtml(row.id)}">
          <td>${escapeHtml(row.name || "—")}</td>
          <td>${escapeHtml(row.email)}</td>
          <td>${roleBadge(row.role)}</td>
          <td>${statusBadge(row.is_disabled)}</td>
          <td>${escapeHtml(fmtDate(row.created_at))}</td>
          <td title="${escapeHtml(fmtDate(row.last_active))}">${escapeHtml(timeAgo(row.last_active))}</td>
          <td class="dev-actions">
            <button class="dev-btn dev-btn-sm" data-action="edit">Edit</button>
            <button class="dev-btn dev-btn-sm" data-action="reset">Reset PW</button>
            ${row.is_disabled
              ? `<button class="dev-btn dev-btn-sm" data-action="enable">Enable</button>`
              : `<button class="dev-btn dev-btn-sm dev-btn-danger" data-action="disable">Disable</button>`}
            <button class="dev-btn dev-btn-sm dev-btn-danger" data-action="delete">Delete</button>
          </td>
        </tr>
      `).join("");
    }
    renderPager("admins-pager", state.pages.admins, total, () => loadAdmins());
  } catch (err) {
    if (err.message !== "Unauthorized") {
      tbody.innerHTML = `<tr><td colspan="7" class="dev-empty">${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

async function onAdminsAction(target) {
  const row = target.closest("tr[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  const action = target.dataset.action;
  const emailText = row.children[1]?.textContent || "";

  if (action === "edit") {
    const formHTML = `
      <label class="dev-field"><span>Name</span><input name="name" /></label>
      <label class="dev-field"><span>Email</span><input name="email" type="email" /></label>
      <label class="dev-field"><span>Mobile</span><input name="mobile" /></label>
      <label class="dev-field"><span>Role</span>
        <select name="role" class="dev-select">
          <option value="">— keep current —</option>
          <option value="user">Standard User</option>
          <option value="admin">Admin</option>
          <option value="developer">Developer</option>
        </select>
      </label>`;
    const result = await openDialog({
      title: `Edit ${emailText}`,
      body: "Leave a field blank to keep its current value.",
      formHTML,
      confirmText: "Save changes",
    });
    if (!result) return;
    const payload = {};
    for (const [k, v] of Object.entries(result)) {
      if (v && String(v).trim() !== "") payload[k] = v.trim();
    }
    if (!Object.keys(payload).length) return;
    try {
      await apiJson(`/api/dev/admins/${id}`, { method: "PATCH", body: payload });
      toast("Account updated.", "success");
      loadAdmins();
    } catch (err) { toast(err.message, "error"); }
  } else if (action === "reset") {
    const result = await openDialog({
      title: `Reset password for ${emailText}`,
      formHTML: `<label class="dev-field"><span>New password (min 8 chars)</span><input name="new_password" type="password" required minlength="8" /></label>`,
      confirmText: "Reset password",
    });
    if (!result) return;
    try {
      await apiJson(`/api/dev/admins/${id}/reset-password`, {
        method: "POST",
        body: { new_password: result.new_password },
      });
      toast("Password reset.", "success");
    } catch (err) { toast(err.message, "error"); }
  } else if (action === "disable" || action === "enable") {
    const verb = action === "disable" ? "disable" : "enable";
    const confirmed = await openDialog({
      title: `${verb[0].toUpperCase() + verb.slice(1)} ${emailText}?`,
      body: `This will ${verb} the account immediately.`,
      confirmText: verb[0].toUpperCase() + verb.slice(1),
      confirmKind: action === "disable" ? "danger" : undefined,
    });
    if (!confirmed) return;
    try {
      await apiJson(`/api/dev/admins/${id}/${action}`, { method: "POST" });
      toast(`Account ${verb}d.`, "success");
      loadAdmins();
    } catch (err) { toast(err.message, "error"); }
  } else if (action === "delete") {
    const confirmed = await openDialog({
      title: `Delete ${emailText}?`,
      body: "This will permanently remove the account and all of its uploads. This cannot be undone.",
      confirmText: "Delete permanently",
      confirmKind: "danger",
    });
    if (!confirmed) return;
    try {
      await apiJson(`/api/dev/admins/${id}`, { method: "DELETE" });
      toast("Account deleted.", "success");
      loadAdmins();
    } catch (err) { toast(err.message, "error"); }
  }
}

async function onCreateAdmin() {
  const formHTML = `
    <label class="dev-field"><span>Email</span><input name="email" type="email" required /></label>
    <label class="dev-field"><span>Password (min 8 chars)</span><input name="password" type="password" required minlength="8" /></label>
    <label class="dev-field"><span>Name (optional)</span><input name="name" /></label>
    <label class="dev-field"><span>Mobile (optional)</span><input name="mobile" /></label>
    <label class="dev-field"><span>Role</span>
      <select name="role" class="dev-select">
        <option value="admin" selected>Admin</option>
        <option value="developer">Developer</option>
      </select>
    </label>`;
  const result = await openDialog({
    title: "Create administrator account",
    formHTML,
    confirmText: "Create account",
  });
  if (!result) return;
  try {
    await apiJson("/api/dev/admins", { method: "POST", body: result });
    toast("Account created.", "success");
    loadAdmins();
  } catch (err) { toast(err.message, "error"); }
}

// ───────── User Management ─────────
async function loadUsers() {
  const tbody = $("#users-tbody");
  tbody.innerHTML = `<tr><td colspan="7" class="dev-empty">Loading…</td></tr>`;
  const p = state.pages.users;
  const params = new URLSearchParams({ page: String(p.page), limit: String(p.limit) });
  if (p.search) params.set("search", p.search);
  if (p.role) params.set("role", p.role);
  if (p.status) params.set("status", p.status);
  try {
    const res = await api(`/api/dev/users?${params.toString()}`);
    const total = Number(res.headers.get("X-Total-Count") || 0);
    const rows = await res.json();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="dev-empty">No users found.</td></tr>`;
    } else {
      tbody.innerHTML = rows.map((row) => `
        <tr data-id="${escapeHtml(row.id)}">
          <td>${escapeHtml(row.name || "—")}</td>
          <td>${escapeHtml(row.email)}</td>
          <td>${roleBadge(row.role)}</td>
          <td>${statusBadge(row.is_disabled)}</td>
          <td>${row.upload_count.toLocaleString()}</td>
          <td title="${escapeHtml(fmtDate(row.last_active))}">${escapeHtml(timeAgo(row.last_active))}</td>
          <td class="dev-actions">
            <button class="dev-btn dev-btn-sm" data-action="activity">Activity</button>
            ${row.is_disabled
              ? `<button class="dev-btn dev-btn-sm" data-action="activate">Activate</button>`
              : `<button class="dev-btn dev-btn-sm dev-btn-danger" data-action="suspend">Suspend</button>`}
          </td>
        </tr>
      `).join("");
    }
    renderPager("users-pager", state.pages.users, total, () => loadUsers());
  } catch (err) {
    if (err.message !== "Unauthorized") {
      tbody.innerHTML = `<tr><td colspan="7" class="dev-empty">${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

async function onUsersAction(target) {
  const row = target.closest("tr[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  const emailText = row.children[1]?.textContent || "";
  const action = target.dataset.action;

  if (action === "activity") {
    let logs = [];
    try {
      logs = await apiJson(`/api/dev/users/${id}/activity?limit=50`);
    } catch (err) {
      toast(err.message, "error");
      return;
    }
    const formHTML = logs.length
      ? `<div class="dev-table-wrap" style="max-height: 320px; overflow:auto;">
          <table class="dev-table">
            <thead><tr><th>When</th><th>Action</th><th>Target</th></tr></thead>
            <tbody>${logs.map((l) => `
              <tr>
                <td>${escapeHtml(timeAgo(l.timestamp))}</td>
                <td><code class="dev-mono">${escapeHtml(l.action)}</code></td>
                <td>${escapeHtml(l.target_email || "—")}</td>
              </tr>`).join("")}</tbody>
          </table>
        </div>`
      : `<p class="dev-empty">No recorded activity.</p>`;
    await openDialog({
      title: `Activity for ${emailText}`,
      formHTML,
      confirmText: "Close",
      onConfirm: () => true,
    });
  } else if (action === "suspend" || action === "activate") {
    const confirmed = await openDialog({
      title: `${action[0].toUpperCase() + action.slice(1)} ${emailText}?`,
      confirmText: action[0].toUpperCase() + action.slice(1),
      confirmKind: action === "suspend" ? "danger" : undefined,
    });
    if (!confirmed) return;
    try {
      await apiJson(`/api/dev/users/${id}/${action}`, { method: "POST" });
      toast(`User ${action}d.`, "success");
      loadUsers();
    } catch (err) { toast(err.message, "error"); }
  }
}

// ───────── Uploads ─────────
async function loadUploads() {
  const tbody = $("#uploads-tbody");
  tbody.innerHTML = `<tr><td colspan="5" class="dev-empty">Loading…</td></tr>`;
  const p = state.pages.uploads;
  const params = new URLSearchParams({ page: String(p.page), limit: String(p.limit) });
  try {
    const res = await api(`/api/dev/uploads?${params.toString()}`);
    const total = Number(res.headers.get("X-Total-Count") || 0);
    const rows = await res.json();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="dev-empty">No uploads yet.</td></tr>`;
    } else {
      tbody.innerHTML = rows.map((row) => `
        <tr>
          <td>${row.image_path ? `<img class="dev-thumb" src="/${escapeHtml(row.image_path)}" alt="" loading="lazy" />` : "—"}</td>
          <td>${escapeHtml(row.email)}<div style="color:var(--dev-text-mute);font-size:11px;">${escapeHtml(row.name || "")}</div></td>
          <td>
            <div>${escapeHtml(row.project || "—")}</div>
            <div style="color:var(--dev-text-mute);font-size:11px;">T-${escapeHtml(row.tower)} · Floor ${escapeHtml(row.floor)} · Flat ${escapeHtml(row.flat)} · ${escapeHtml(row.room)}</div>
          </td>
          <td>${escapeHtml(row.category || "—")}</td>
          <td title="${escapeHtml(fmtDate(row.created_at))}">${escapeHtml(timeAgo(row.created_at))}</td>
        </tr>
      `).join("");
    }
    renderPager("uploads-pager", state.pages.uploads, total, () => loadUploads());
  } catch (err) {
    if (err.message !== "Unauthorized") {
      tbody.innerHTML = `<tr><td colspan="5" class="dev-empty">${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

// ───────── Analytics ─────────
async function loadAnalytics() {
  try {
    const data = await apiJson(`/api/dev/analytics?days=${state.analyticsRange}`);
    renderBarChart($("#chart-uploads"), data.series, "uploads");
    renderBarChart($("#chart-users"), data.series, "new_users");
    renderBarChart($("#chart-logins"), data.series, "logins");
    renderCategoryList($("#chart-categories"), data.category_breakdown);
  } catch (err) {
    if (err.message !== "Unauthorized") toast(err.message, "error");
  }
}

function renderBarChart(host, series, key) {
  if (!series || !series.length) {
    host.innerHTML = `<div class="dev-chart-empty">No data in range</div>`;
    return;
  }
  const max = Math.max(...series.map((row) => row[key] || 0), 1);
  host.innerHTML = series.map((row) => {
    const value = row[key] || 0;
    const h = Math.max(2, Math.round((value / max) * 100));
    const cls = value === 0 ? "dev-chart-bar is-zero" : "dev-chart-bar";
    return `<div class="${cls}" style="height:${h}%" data-tip="${escapeHtml(row.date)} • ${value}"></div>`;
  }).join("");
}

function renderCategoryList(host, breakdown) {
  if (!breakdown || !breakdown.length) {
    host.innerHTML = `<div class="dev-chart-empty">No category data</div>`;
    return;
  }
  const max = Math.max(...breakdown.map((row) => row.count), 1);
  host.innerHTML = `
    <div class="dev-cat-list">
      ${breakdown.map((row) => `
        <div class="dev-cat-row">
          <div class="dev-cat-label" title="${escapeHtml(row.category)}">${escapeHtml(row.category || "Other")}</div>
          <div class="dev-cat-bar"><span style="width:${Math.round((row.count / max) * 100)}%"></span></div>
          <div class="dev-cat-count">${row.count.toLocaleString()}</div>
        </div>`).join("")}
    </div>`;
}

// ───────── Audit ─────────
async function loadAudit() {
  const tbody = $("#audit-tbody");
  tbody.innerHTML = `<tr><td colspan="4" class="dev-empty">Loading…</td></tr>`;
  const p = state.pages.audit;
  const params = new URLSearchParams({ page: String(p.page), limit: String(p.limit) });
  if (p.action) params.set("action", p.action);
  try {
    const res = await api(`/api/dev/audit-logs?${params.toString()}`);
    const total = Number(res.headers.get("X-Total-Count") || 0);
    const rows = await res.json();
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="dev-empty">No matching events.</td></tr>`;
    } else {
      tbody.innerHTML = rows.map((row) => `
        <tr>
          <td title="${escapeHtml(fmtDate(row.timestamp))}">${escapeHtml(timeAgo(row.timestamp))}</td>
          <td>${escapeHtml(row.actor_email)}</td>
          <td><code class="dev-mono">${escapeHtml(row.action)}</code></td>
          <td>${escapeHtml(row.target_email || "—")}</td>
        </tr>
      `).join("");
    }
    renderPager("audit-pager", state.pages.audit, total, () => loadAudit());
  } catch (err) {
    if (err.message !== "Unauthorized") {
      tbody.innerHTML = `<tr><td colspan="4" class="dev-empty">${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

// ───────── System Health ─────────
async function loadHealth() {
  const grid = $("#health-grid");
  grid.innerHTML = `<div class="dev-empty">Loading…</div>`;
  try {
    const data = await apiJson("/api/dev/system-health");
    const cards = [
      { name: "Database", check: data.checks.database, meta: (c) => c.latency_ms != null ? `${c.latency_ms} ms ping` : "" },
      { name: "AI Service", check: data.checks.ai_service, meta: (c) => c.note || "" },
      { name: "API", check: data.checks.api, meta: () => `Uptime ${formatUptime(data.uptime_seconds)}` },
      { name: "Storage", check: data.checks.storage, meta: (c) => c.free_human ? `${c.free_human} free` : "" },
      { name: "Background Jobs", check: data.checks.queue, meta: (c) => c.note || "" },
    ];
    grid.innerHTML = cards.map((card) => {
      const c = card.check || { status: "n/a" };
      const dotCls = c.status === "ok" ? "is-ok" : c.status === "degraded" ? "is-degraded" : c.status === "down" ? "is-down" : "";
      return `
        <div class="dev-health-card">
          <div class="dev-health-card-name">${escapeHtml(card.name)}</div>
          <div class="dev-health-card-value"><span class="dev-health-dot ${dotCls}"></span>${escapeHtml((c.status || "n/a").toUpperCase())}</div>
          <div class="dev-health-meta">${escapeHtml(card.meta(c) || "")}</div>
        </div>`;
    }).join("");
    updateStatusPill(data.status);
  } catch (err) {
    if (err.message !== "Unauthorized") {
      grid.innerHTML = `<div class="dev-empty">${escapeHtml(err.message)}</div>`;
    }
  }

  try {
    const errors = await apiJson("/api/dev/error-logs?limit=20");
    const tbody = $("#errors-tbody");
    if (!errors.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="dev-empty">No recorded error events.</td></tr>`;
    } else {
      tbody.innerHTML = errors.map((row) => `
        <tr>
          <td title="${escapeHtml(fmtDate(row.timestamp))}">${escapeHtml(timeAgo(row.timestamp))}</td>
          <td><code class="dev-mono">${escapeHtml(row.action)}</code></td>
          <td>${escapeHtml(row.target_email || "—")}</td>
        </tr>`).join("");
    }
  } catch (err) {
    if (err.message !== "Unauthorized") {
      $("#errors-tbody").innerHTML = `<tr><td colspan="3" class="dev-empty">${escapeHtml(err.message)}</td></tr>`;
    }
  }
}

// ───────── Settings ─────────
async function loadSettings() {
  try {
    const me = await apiJson("/api/dev/me");
    $("#settings-me").innerHTML = `<strong>${escapeHtml(me.email)}</strong> · ${roleBadge(me.role)}`;
  } catch (err) {
    if (err.message !== "Unauthorized") $("#settings-me").textContent = err.message;
  }
  try {
    const data = await apiJson("/api/dev/system-health");
    $("#settings-uptime").textContent = formatUptime(data.uptime_seconds);
  } catch { /* noop */ }
}

// ───────── Theme ─────────
function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function resolveInitialTheme() {
  const saved = getStoredTheme();
  if (saved === "light" || saved === "dark") return saved;
  // No explicit choice — follow OS preference, defaulting to dark.
  if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

function applyTheme(theme) {
  const t = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
  const btn = $("#dev-theme-toggle");
  if (btn) {
    btn.setAttribute("aria-pressed", t === "light" ? "true" : "false");
    btn.title = t === "light" ? "Switch to dark theme" : "Switch to light theme";
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  const next = current === "light" ? "dark" : "light";
  try { localStorage.setItem(THEME_KEY, next); } catch { /* noop */ }
  applyTheme(next);
}

// ───────── Inbox / Notifications ─────────
const NOTIF_ICON = {
  user_registered: "👤",
  admin_created: "🛡",
  system_alert: "⚠",
};

function notifIconChar(type) {
  return NOTIF_ICON[type] || "•";
}

function notifSeverityClass(severity) {
  switch (severity) {
    case "success": return "is-success";
    case "warning": return "is-warning";
    case "error": return "is-error";
    default: return "is-info";
  }
}

function updateBellBadge(count) {
  const badge = $("#dev-bell-badge");
  const bell = $("#dev-bell");
  state.inbox.unread = count;
  if (count > 0) {
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.hidden = false;
    bell.classList.add("has-unread");
  } else {
    badge.hidden = true;
    bell.classList.remove("has-unread");
  }
  const sub = $("#dev-inbox-sub");
  if (sub) sub.textContent = count === 0 ? "No unread notifications" : `${count} unread`;
}

async function pollUnread() {
  try {
    const data = await apiJson("/api/dev/notifications/unread-count");
    const prevUnread = state.inbox.unread;
    updateBellBadge(data.unread || 0);
    // If something new appeared AND the panel is open, refresh the list.
    if (data.latest_id && data.latest_id !== state.inbox.lastLatestId) {
      state.inbox.lastLatestId = data.latest_id;
      if (state.inbox.open) loadInbox();
      // Subtle toast when fresh items arrive while the bell is closed.
      if (!state.inbox.open && data.unread > prevUnread && prevUnread !== 0) {
        toast(`${data.unread - prevUnread} new notification${data.unread - prevUnread === 1 ? "" : "s"}`, "info");
      }
    }
  } catch (err) {
    if (err.message === "Unauthorized") stopInboxPolling();
    // Quiet on transient network errors — bell stays in its last known state.
  }
}

function startInboxPolling() {
  stopInboxPolling();
  pollUnread();
  state.inbox.pollTimer = setInterval(pollUnread, INBOX_POLL_MS);
}

function stopInboxPolling() {
  if (state.inbox.pollTimer) {
    clearInterval(state.inbox.pollTimer);
    state.inbox.pollTimer = null;
  }
}

async function loadInbox() {
  const list = $("#dev-inbox-list");
  list.innerHTML = `<div class="dev-empty">Loading…</div>`;
  const params = new URLSearchParams({ page: "1", limit: "30" });
  if (state.inbox.filter === "unread") params.set("unread_only", "true");
  try {
    const data = await apiJson(`/api/dev/notifications?${params.toString()}`);
    state.inbox.items = data.items || [];
    updateBellBadge(data.unread || 0);
    renderInboxList();
  } catch (err) {
    if (err.message !== "Unauthorized") {
      list.innerHTML = `<div class="dev-empty">${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderInboxList() {
  const list = $("#dev-inbox-list");
  const items = state.inbox.items;
  if (!items.length) {
    list.innerHTML = `<div class="dev-empty">${state.inbox.filter === "unread" ? "Nothing unread." : "No notifications yet."}</div>`;
    return;
  }
  list.innerHTML = items.map((n) => `
    <div class="dev-notif ${n.is_read ? "" : "is-unread"}" data-id="${escapeHtml(n.id)}">
      <div class="dev-notif-icon ${notifSeverityClass(n.severity)}">${escapeHtml(notifIconChar(n.type))}</div>
      <div class="dev-notif-body">
        <div class="dev-notif-title">${escapeHtml(n.title)}</div>
        <div class="dev-notif-text">${escapeHtml(n.body || "")}</div>
        <div class="dev-notif-time" title="${escapeHtml(fmtDate(n.created_at))}">${escapeHtml(timeAgo(n.created_at))}</div>
      </div>
      <div class="dev-notif-actions">
        ${n.is_read ? "" : `<button class="dev-notif-action" data-act="read">Mark read</button>`}
        ${n.entity_type === "user" && n.entity_id ? `<button class="dev-notif-action" data-act="view-user">View user</button>` : ""}
        <button class="dev-notif-action is-danger" data-act="delete">Dismiss</button>
      </div>
    </div>
  `).join("");
}

async function onInboxAction(target) {
  const row = target.closest(".dev-notif");
  if (!row) return;
  const id = row.dataset.id;
  const act = target.dataset.act;
  const item = state.inbox.items.find((n) => n.id === id);
  if (!item) return;

  if (act === "read") {
    try {
      await apiJson(`/api/dev/notifications/${id}/read`, { method: "POST" });
      item.is_read = true;
      state.inbox.unread = Math.max(0, state.inbox.unread - 1);
      updateBellBadge(state.inbox.unread);
      renderInboxList();
    } catch (err) { toast(err.message, "error"); }
  } else if (act === "delete") {
    try {
      await apiJson(`/api/dev/notifications/${id}`, { method: "DELETE" });
      state.inbox.items = state.inbox.items.filter((n) => n.id !== id);
      if (!item.is_read) state.inbox.unread = Math.max(0, state.inbox.unread - 1);
      updateBellBadge(state.inbox.unread);
      renderInboxList();
    } catch (err) { toast(err.message, "error"); }
  } else if (act === "view-user") {
    // Mark read on navigation, jump to User Management with a search filter on the user's email.
    if (!item.is_read) {
      apiJson(`/api/dev/notifications/${id}/read`, { method: "POST" }).catch(() => { /* noop */ });
      item.is_read = true;
      state.inbox.unread = Math.max(0, state.inbox.unread - 1);
      updateBellBadge(state.inbox.unread);
    }
    closeInbox();
    const email = item.meta?.email || "";
    if (email) {
      state.pages.users.search = email;
      state.pages.users.page = 1;
      $("#users-search").value = email;
    }
    selectSection("users");
  }
}

function openInbox() {
  state.inbox.open = true;
  $("#dev-inbox-panel").hidden = false;
  $("#dev-bell").setAttribute("aria-expanded", "true");
  loadInbox();
}

function closeInbox() {
  state.inbox.open = false;
  $("#dev-inbox-panel").hidden = true;
  $("#dev-bell").setAttribute("aria-expanded", "false");
}

function toggleInbox() {
  if (state.inbox.open) closeInbox();
  else openInbox();
}

async function markAllInboxRead() {
  try {
    await apiJson("/api/dev/notifications/read-all", { method: "POST" });
    state.inbox.items = state.inbox.items.map((n) => ({ ...n, is_read: true }));
    updateBellBadge(0);
    renderInboxList();
    toast("All notifications marked read.", "success");
  } catch (err) { toast(err.message, "error"); }
}

async function clearReadNotifications() {
  try {
    const res = await apiJson("/api/dev/notifications?only_read=true", { method: "DELETE" });
    if (res.deleted > 0) toast(`Cleared ${res.deleted} read notification${res.deleted === 1 ? "" : "s"}.`, "success");
    loadInbox();
  } catch (err) { toast(err.message, "error"); }
}

// ───────── Pager ─────────
function renderPager(elId, page, total, reload) {
  const el = $(`#${elId}`);
  if (!el) return;
  const totalPages = Math.max(1, Math.ceil(total / page.limit));
  const start = total === 0 ? 0 : (page.page - 1) * page.limit + 1;
  const end = Math.min(total, page.page * page.limit);
  el.innerHTML = `
    <span>Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}</span>
    <span class="dev-pager-controls">
      <button class="dev-btn dev-btn-sm" data-pager="prev" ${page.page <= 1 ? "disabled" : ""}>← Prev</button>
      <span class="dev-pager-page">Page ${page.page} / ${totalPages}</span>
      <button class="dev-btn dev-btn-sm" data-pager="next" ${page.page >= totalPages ? "disabled" : ""}>Next →</button>
      <form class="dev-pager-jump" data-pager-jump>
        <span>Go to</span>
        <input class="dev-pager-jump-input" type="number" min="1" max="${totalPages}" value="${page.page}" aria-label="Go to page" />
        <button class="dev-btn dev-btn-sm" type="submit">Go</button>
      </form>
    </span>`;
  el.querySelector('[data-pager="prev"]').addEventListener("click", () => {
    if (page.page > 1) { page.page -= 1; reload(); }
  });
  el.querySelector('[data-pager="next"]').addEventListener("click", () => {
    if (page.page < totalPages) { page.page += 1; reload(); }
  });
  el.querySelector("[data-pager-jump]").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = event.currentTarget.querySelector(".dev-pager-jump-input");
    const requested = Number.parseInt(input.value, 10);
    if (!Number.isFinite(requested)) return;
    const nextPage = Math.min(Math.max(requested, 1), totalPages);
    if (nextPage === page.page) {
      input.value = String(nextPage);
      return;
    }
    page.page = nextPage;
    reload();
  });
}

// ───────── Debounce helper ─────────
function debounce(fn, ms = 250) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ───────── Wiring ─────────
function wireEvents() {
  $("#dev-login-form").addEventListener("submit", handleLogin);
  $("#dev-logout").addEventListener("click", handleLogout);
  $("#dev-refresh").addEventListener("click", () => selectSection(state.section));
  $("#dev-theme-toggle").addEventListener("click", toggleTheme);

  // Inbox
  $("#dev-bell").addEventListener("click", (e) => { e.stopPropagation(); toggleInbox(); });
  $("#dev-inbox-mark-all").addEventListener("click", markAllInboxRead);
  $("#dev-inbox-clear").addEventListener("click", clearReadNotifications);
  $("#dev-inbox-list").addEventListener("click", (e) => {
    if (e.target.matches("[data-act]")) onInboxAction(e.target);
  });
  $$(".dev-inbox-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.inbox.filter = tab.dataset.filter;
      $$(".dev-inbox-tab").forEach((t) => {
        const active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
      loadInbox();
    });
  });
  // Click-outside to close
  document.addEventListener("click", (e) => {
    if (!state.inbox.open) return;
    const wrap = $("#dev-inbox-wrap");
    if (wrap && !wrap.contains(e.target)) closeInbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.inbox.open) closeInbox();
  });
  // Refresh on tab focus so an idle browser tab still catches up quickly when revisited.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.token) pollUnread();
  });

  $$('.dev-nav-item').forEach((btn) => {
    btn.addEventListener("click", () => selectSection(btn.dataset.section));
  });

  $("#admins-tbody").addEventListener("click", (e) => {
    if (e.target.matches("[data-action]")) onAdminsAction(e.target);
  });
  $("#users-tbody").addEventListener("click", (e) => {
    if (e.target.matches("[data-action]")) onUsersAction(e.target);
  });
  $("#admins-create").addEventListener("click", onCreateAdmin);

  $("#admins-search").addEventListener("input", debounce((e) => {
    state.pages.admins.search = e.target.value.trim();
    state.pages.admins.page = 1;
    loadAdmins();
  }, 250));

  $("#users-search").addEventListener("input", debounce((e) => {
    state.pages.users.search = e.target.value.trim();
    state.pages.users.page = 1;
    loadUsers();
  }, 250));
  $("#users-status").addEventListener("change", (e) => {
    state.pages.users.status = e.target.value;
    state.pages.users.page = 1;
    loadUsers();
  });
  $("#users-role").addEventListener("change", (e) => {
    state.pages.users.role = e.target.value;
    state.pages.users.page = 1;
    loadUsers();
  });

  $("#audit-action").addEventListener("input", debounce((e) => {
    state.pages.audit.action = e.target.value.trim();
    state.pages.audit.page = 1;
    loadAudit();
  }, 300));

  $("#analytics-range").addEventListener("change", (e) => {
    state.analyticsRange = Number(e.target.value) || 30;
    loadAnalytics();
  });
}

// ───────── Bootstrap ─────────
applyTheme(resolveInitialTheme());
wireEvents();
if (loadAuth()) {
  showAppView();
} else {
  showLoginView();
}
