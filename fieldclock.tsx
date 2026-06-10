import { useState, useEffect, useCallback, useRef } from "react";

// ── Persistent storage helpers ──────────────────────────────────────────────
const DB_KEY = "fieldclock_v1";
function loadDB() {
  try { return JSON.parse(localStorage.getItem(DB_KEY) || "{}"); } catch { return {}; }
}
function saveDB(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }

// ── Geo helpers ───────────────────────────────────────────────────────────────
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const HOME_RADIUS_M = 150; // metres considered "at home"

// ── Time helpers ──────────────────────────────────────────────────────────────
function fmtDuration(ms) {
  if (ms <= 0) return "0m";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtTime(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(iso) {
  if (!iso) return "–";
  return new Date(iso).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function todayKey() { return new Date().toISOString().slice(0, 10); }

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [db, setDb] = useState(loadDB);
  const [user, setUser] = useState(null); // currently logged-in username
  const [screen, setScreen] = useState("login"); // login | home | setup | timesheet | share
  const [loginForm, setLoginForm] = useState({ username: "", password: "", isNew: false });
  const [loginError, setLoginError] = useState("");
  const [geoStatus, setGeoStatus] = useState("idle"); // idle | watching | error
  const [atHome, setAtHome] = useState(null); // true | false | null
  const [statusMsg, setStatusMsg] = useState("");
  const [shareText, setShareText] = useState("");
  const watchIdRef = useRef(null);

  // ── Persist DB ───────────────────────────────────────────────────────────────
  const commit = useCallback((next) => {
    setDb(next);
    saveDB(next);
  }, []);

  // ── User helpers ─────────────────────────────────────────────────────────────
  const userData = user ? db[user] || {} : {};
  const homeLocation = userData.home || null;
  const logs = userData.logs || {}; // { "YYYY-MM-DD": [{left, returned},...] }

  function updateUser(patch) {
    commit({ ...db, [user]: { ...(db[user] || {}), ...patch } });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────────
  function handleLogin() {
    const { username, password, isNew } = loginForm;
    if (!username.trim() || !password.trim()) { setLoginError("Enter username and password."); return; }
    const uname = username.trim().toLowerCase();
    if (isNew) {
      if (db[uname]) { setLoginError("Username taken. Pick another."); return; }
      const next = { ...db, [uname]: { password, home: null, logs: {} } };
      commit(next);
      setUser(uname);
      setScreen("setup");
    } else {
      if (!db[uname] || db[uname].password !== password) { setLoginError("Wrong username or password."); return; }
      setUser(uname);
      setScreen(db[uname].home ? "home" : "setup");
    }
    setLoginError("");
  }

  function handleLogout() {
    stopWatching();
    setUser(null);
    setScreen("login");
    setAtHome(null);
    setStatusMsg("");
  }

  // ── Geo watching ──────────────────────────────────────────────────────────────
  function startWatching(homeCoords) {
    if (!navigator.geolocation) { setGeoStatus("error"); return; }
    setGeoStatus("watching");
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const dist = haversineMeters(
          pos.coords.latitude, pos.coords.longitude,
          homeCoords.lat, homeCoords.lng
        );
        const nowHome = dist <= HOME_RADIUS_M;
        setAtHome((prev) => {
          if (prev === null) return nowHome; // first reading
          if (prev && !nowHome) { handleLeft(); return false; }
          if (!prev && nowHome) { handleArrived(); return true; }
          return prev;
        });
      },
      () => setGeoStatus("error"),
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
    );
  }

  function stopWatching() {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setGeoStatus("idle");
  }

  // ── Check-in / out logic ──────────────────────────────────────────────────────
  function handleLeft() {
    const now = new Date().toISOString();
    const key = todayKey();
    const currentDb = loadDB(); // re-read to avoid stale closure
    const uData = currentDb[user] || {};
    const todayLog = (uData.logs || {})[key] || [];
    // Only add new entry if last one is complete (has returned)
    const last = todayLog[todayLog.length - 1];
    if (last && !last.returned) return; // already out
    const updated = [...todayLog, { left: now, returned: null }];
    const next = { ...currentDb, [user]: { ...uData, logs: { ...(uData.logs || {}), [key]: updated } } };
    commit(next);
    setStatusMsg(`Left home at ${fmtTime(now)}`);
  }

  function handleArrived() {
    const now = new Date().toISOString();
    const key = todayKey();
    const currentDb = loadDB();
    const uData = currentDb[user] || {};
    const todayLog = (uData.logs || {})[key] || [];
    const updated = todayLog.map((entry, i) =>
      i === todayLog.length - 1 && !entry.returned ? { ...entry, returned: now } : entry
    );
    const next = { ...currentDb, [user]: { ...uData, logs: { ...(uData.logs || {}), [key]: updated } } };
    commit(next);
    setStatusMsg(`Returned home at ${fmtTime(now)}`);
  }

  // ── Manual override ───────────────────────────────────────────────────────────
  function manualLeft() {
    setAtHome(false);
    handleLeft();
  }
  function manualArrived() {
    setAtHome(true);
    handleArrived();
  }

  // ── Set home ──────────────────────────────────────────────────────────────────
  function captureHome() {
    if (!navigator.geolocation) { alert("Geolocation not available."); return; }
    setStatusMsg("Detecting your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const home = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        updateUser({ home });
        setStatusMsg(`Home set! (±${Math.round(home.accuracy)}m accuracy)`);
        setScreen("home");
      },
      () => setStatusMsg("Could not get location. Check browser permissions."),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  // ── Start tracking when on home screen ───────────────────────────────────────
  useEffect(() => {
    if (screen === "home" && homeLocation && geoStatus === "idle") {
      startWatching(homeLocation);
      // Detect initial position
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const dist = haversineMeters(pos.coords.latitude, pos.coords.longitude, homeLocation.lat, homeLocation.lng);
          setAtHome(dist <= HOME_RADIUS_M);
        },
        () => {}
      );
    }
    if (screen !== "home") stopWatching();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, homeLocation]);

  // ── Timesheet compute ─────────────────────────────────────────────────────────
  function computeDay(entries) {
    let total = 0;
    entries.forEach((e) => {
      if (e.left && e.returned) total += new Date(e.returned) - new Date(e.left);
      else if (e.left && !e.returned) total += Date.now() - new Date(e.left);
    });
    return total;
  }

  function buildShareText() {
    const allDays = Object.entries(logs).sort(([a], [b]) => (a < b ? 1 : -1));
    if (!allDays.length) return "No timesheet data yet.";
    let out = `⏱ FieldClock – ${user}\n${"─".repeat(32)}\n`;
    allDays.forEach(([date, entries]) => {
      out += `\n${fmtDate(date + "T00:00:00")}\n`;
      entries.forEach((e, i) => {
        out += `  Trip ${i + 1}: Left ${fmtTime(e.left)} → ${e.returned ? "Back " + fmtTime(e.returned) : "Still out"}`;
        if (e.left && e.returned) out += ` (${fmtDuration(new Date(e.returned) - new Date(e.left))})`;
        out += "\n";
      });
      out += `  Total away: ${fmtDuration(computeDay(entries))}\n`;
    });
    return out;
  }

  // ── Screens ───────────────────────────────────────────────────────────────────

  // LOGIN
  if (screen === "login") return (
    <div style={S.page}>
      <div style={S.loginCard}>
        <div style={S.logoRow}><span style={S.logoIcon}>⏱</span><span style={S.logoText}>FieldClock</span></div>
        <p style={S.tagline}>Know when you left. Know when you're back.</p>
        <div style={S.tabs}>
          {["Sign in", "Create account"].map((label, i) => (
            <button key={i} style={{ ...S.tab, ...(loginForm.isNew === !!i ? S.tabActive : {}) }}
              onClick={() => setLoginForm(f => ({ ...f, isNew: !!i, password: "" }))}>
              {label}
            </button>
          ))}
        </div>
        <input style={S.input} placeholder="Username" value={loginForm.username}
          onChange={e => setLoginForm(f => ({ ...f, username: e.target.value }))}
          onKeyDown={e => e.key === "Enter" && handleLogin()} />
        <input style={S.input} type="password" placeholder="Password" value={loginForm.password}
          onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))}
          onKeyDown={e => e.key === "Enter" && handleLogin()} />
        {loginError && <p style={S.error}>{loginError}</p>}
        <button style={S.btn} onClick={handleLogin}>{loginForm.isNew ? "Create account" : "Sign in"}</button>
      </div>
    </div>
  );

  // SETUP
  if (screen === "setup") return (
    <div style={S.page}>
      <div style={S.card}>
        <button style={S.backBtn} onClick={handleLogout}>← Sign out</button>
        <div style={S.setupIcon}>📍</div>
        <h2 style={S.heading}>Set your home location</h2>
        <p style={S.body}>Stand at or near your front door and tap the button below. FieldClock will use a {HOME_RADIUS_M}m radius to detect when you leave and return.</p>
        {statusMsg && <p style={S.statusMsg}>{statusMsg}</p>}
        <button style={S.btn} onClick={captureHome}>Use my current location as home</button>
        {homeLocation && <button style={{ ...S.btn, ...S.btnSecondary }} onClick={() => setScreen("home")}>Keep existing home</button>}
      </div>
    </div>
  );

  // SHARE
  if (screen === "share") {
    return (
      <div style={S.page}>
        <div style={S.card}>
          <button style={S.backBtn} onClick={() => setScreen("timesheet")}>← Back</button>
          <h2 style={S.heading}>Share timesheet</h2>
          <textarea style={S.shareBox} readOnly value={shareText} />
          <button style={S.btn} onClick={() => {
            if (navigator.share) navigator.share({ text: shareText, title: "FieldClock Timesheet" });
            else { navigator.clipboard.writeText(shareText); alert("Copied to clipboard!"); }
          }}>
            {navigator.share ? "Share…" : "Copy to clipboard"}
          </button>
          <button style={{ ...S.btn, ...S.btnSecondary }} onClick={() => setScreen("timesheet")}>Done</button>
        </div>
      </div>
    );
  }

  // TIMESHEET
  if (screen === "timesheet") {
    const allDays = Object.entries(logs).sort(([a], [b]) => (a < b ? 1 : -1));
    return (
      <div style={S.page}>
        <div style={{ ...S.card, maxWidth: 540 }}>
          <button style={S.backBtn} onClick={() => setScreen("home")}>← Back</button>
          <div style={S.sheetHeader}>
            <h2 style={S.heading}>Timesheet</h2>
            <button style={S.shareBtn} onClick={() => { setShareText(buildShareText()); setScreen("share"); }}>Share ↗</button>
          </div>
          {allDays.length === 0 && <p style={S.body}>No trips recorded yet. Start tracking from the home screen.</p>}
          {allDays.map(([date, entries]) => (
            <div key={date} style={S.dayBlock}>
              <div style={S.dayHeader}>
                <span style={S.dayLabel}>{fmtDate(date + "T00:00:00")}</span>
                <span style={S.dayTotal}>{fmtDuration(computeDay(entries))} away</span>
              </div>
              {entries.map((e, i) => (
                <div key={i} style={S.tripRow}>
                  <span style={S.tripNum}>Trip {i + 1}</span>
                  <span style={S.tripTimes}>
                    <span style={S.leftTime}>Left {fmtTime(e.left)}</span>
                    <span style={S.arrow}>→</span>
                    <span style={e.returned ? S.backTime : S.outNow}>{e.returned ? `Back ${fmtTime(e.returned)}` : "Still out"}</span>
                  </span>
                  <span style={S.tripDur}>
                    {e.left && e.returned ? fmtDuration(new Date(e.returned) - new Date(e.left)) : e.left ? fmtDuration(Date.now() - new Date(e.left)) + " so far" : ""}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // HOME (main tracking screen)
  const todayEntries = logs[todayKey()] || [];
  const todayTotal = computeDay(todayEntries);
  const currentlyOut = todayEntries.length > 0 && !todayEntries[todayEntries.length - 1].returned;

  return (
    <div style={S.page}>
      <div style={S.card}>
        {/* Header */}
        <div style={S.topBar}>
          <span style={S.logoText}>⏱ FieldClock</span>
          <div style={S.topActions}>
            <button style={S.iconBtn} title="Timesheet" onClick={() => setScreen("timesheet")}>📋</button>
            <button style={S.iconBtn} title="Change home" onClick={() => setScreen("setup")}>⚙️</button>
            <button style={S.iconBtn} title="Sign out" onClick={handleLogout}>↩</button>
          </div>
        </div>

        {/* Status bubble */}
        <div style={{ ...S.statusBubble, ...(atHome === false ? S.statusOut : atHome === true ? S.statusIn : S.statusUnknown) }}>
          <span style={S.statusEmoji}>{atHome === false ? "🚶" : atHome === true ? "🏡" : "📡"}</span>
          <span style={S.statusLabel}>
            {atHome === false ? "Away from home" : atHome === true ? "At home" : "Locating…"}
          </span>
        </div>

        {/* Geo indicator */}
        <div style={S.geoRow}>
          <span style={{ ...S.geoDot, background: geoStatus === "watching" ? "#22c55e" : geoStatus === "error" ? "#ef4444" : "#94a3b8" }} />
          <span style={S.geoLabel}>{geoStatus === "watching" ? "Live GPS tracking" : geoStatus === "error" ? "GPS unavailable" : "GPS off"}</span>
        </div>

        {/* Today summary */}
        <div style={S.todayBox}>
          <span style={S.todayLabel}>Today's total away</span>
          <span style={S.todayTotal}>{fmtDuration(todayTotal)}</span>
          <span style={S.todayTrips}>{todayEntries.length} trip{todayEntries.length !== 1 ? "s" : ""}</span>
        </div>

        {/* Today's trips */}
        {todayEntries.length > 0 && (
          <div style={S.todayList}>
            {todayEntries.map((e, i) => (
              <div key={i} style={S.todayTrip}>
                <span style={S.tripBadge}>#{i + 1}</span>
                <span>{fmtTime(e.left)}</span>
                <span style={S.arrow}>→</span>
                <span style={e.returned ? {} : S.outNow}>{e.returned ? fmtTime(e.returned) : "now"}</span>
                <span style={S.tripDurSmall}>
                  {e.returned ? fmtDuration(new Date(e.returned) - new Date(e.left)) : fmtDuration(Date.now() - new Date(e.left))}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Manual buttons */}
        <p style={S.manualHint}>GPS auto-detects, but you can also tap manually:</p>
        <div style={S.manualRow}>
          <button style={{ ...S.manualBtn, ...S.manualLeft }} onClick={manualLeft} disabled={currentlyOut}>
            I left home
          </button>
          <button style={{ ...S.manualBtn, ...S.manualBack }} onClick={manualArrived} disabled={!currentlyOut}>
            I'm back home
          </button>
        </div>

        {statusMsg && <p style={S.statusNote}>{statusMsg}</p>}

        <button style={{ ...S.btn, marginTop: 20 }} onClick={() => setScreen("timesheet")}>View full timesheet →</button>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  page: { minHeight: "100vh", background: "#0f172a", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "24px 16px", fontFamily: "'Inter', 'Helvetica Neue', sans-serif" },
  card: { background: "#1e293b", borderRadius: 20, padding: "28px 24px", width: "100%", maxWidth: 440, color: "#e2e8f0", boxShadow: "0 24px 48px rgba(0,0,0,0.4)" },
  loginCard: { background: "#1e293b", borderRadius: 20, padding: "40px 32px", width: "100%", maxWidth: 380, color: "#e2e8f0", boxShadow: "0 24px 48px rgba(0,0,0,0.4)", marginTop: 40 },
  logoRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 6 },
  logoIcon: { fontSize: 32 },
  logoText: { fontSize: 22, fontWeight: 700, color: "#f8fafc", letterSpacing: "-0.5px" },
  tagline: { color: "#94a3b8", fontSize: 14, margin: "0 0 28px" },
  tabs: { display: "flex", background: "#0f172a", borderRadius: 10, padding: 4, marginBottom: 20 },
  tab: { flex: 1, padding: "8px 0", border: "none", background: "transparent", color: "#64748b", fontSize: 14, cursor: "pointer", borderRadius: 8, transition: "all .15s" },
  tabActive: { background: "#3b82f6", color: "#fff", fontWeight: 600 },
  input: { width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid #334155", background: "#0f172a", color: "#f1f5f9", fontSize: 15, marginBottom: 12, boxSizing: "border-box", outline: "none" },
  btn: { width: "100%", padding: "13px 0", borderRadius: 12, border: "none", background: "#3b82f6", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer", transition: "opacity .15s" },
  btnSecondary: { background: "#334155", marginTop: 10, color: "#94a3b8" },
  error: { color: "#f87171", fontSize: 13, margin: "-4px 0 10px", textAlign: "center" },
  backBtn: { background: "none", border: "none", color: "#64748b", fontSize: 14, cursor: "pointer", padding: "0 0 16px", display: "block" },
  setupIcon: { fontSize: 48, textAlign: "center", marginBottom: 12 },
  heading: { fontSize: 22, fontWeight: 700, margin: "0 0 10px", color: "#f1f5f9" },
  body: { color: "#94a3b8", fontSize: 14, lineHeight: 1.6, margin: "0 0 20px" },
  statusMsg: { background: "#0f172a", borderRadius: 8, padding: "10px 14px", fontSize: 13, color: "#94a3b8", margin: "0 0 16px" },

  topBar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 },
  topActions: { display: "flex", gap: 6 },
  iconBtn: { background: "#0f172a", border: "none", borderRadius: 8, padding: "6px 10px", cursor: "pointer", fontSize: 16 },

  statusBubble: { borderRadius: 16, padding: "20px 24px", display: "flex", alignItems: "center", gap: 14, marginBottom: 12, transition: "background .4s" },
  statusIn: { background: "#14532d" },
  statusOut: { background: "#7c2d12" },
  statusUnknown: { background: "#1e3a5f" },
  statusEmoji: { fontSize: 36 },
  statusLabel: { fontSize: 20, fontWeight: 700, color: "#f1f5f9" },

  geoRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 20 },
  geoDot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
  geoLabel: { fontSize: 12, color: "#64748b" },

  todayBox: { background: "#0f172a", borderRadius: 14, padding: "16px 20px", marginBottom: 14, display: "flex", flexDirection: "column", alignItems: "flex-start" },
  todayLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "#64748b", marginBottom: 4 },
  todayTotal: { fontSize: 38, fontWeight: 800, color: "#f1f5f9", lineHeight: 1 },
  todayTrips: { fontSize: 12, color: "#64748b", marginTop: 4 },

  todayList: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 },
  todayTrip: { background: "#0f172a", borderRadius: 10, padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#cbd5e1" },
  tripBadge: { background: "#1e3a5f", borderRadius: 6, padding: "2px 6px", fontSize: 11, fontWeight: 700, color: "#60a5fa" },
  tripDurSmall: { marginLeft: "auto", color: "#64748b", fontSize: 12 },

  manualHint: { fontSize: 12, color: "#475569", textAlign: "center", margin: "0 0 10px" },
  manualRow: { display: "flex", gap: 10 },
  manualBtn: { flex: 1, padding: "11px 0", borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  manualLeft: { background: "#7c2d12", color: "#fca5a5" },
  manualBack: { background: "#14532d", color: "#86efac" },
  statusNote: { textAlign: "center", fontSize: 12, color: "#64748b", margin: "10px 0 0" },
  arrow: { color: "#475569" },

  sheetHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  shareBtn: { background: "#1d4ed8", border: "none", color: "#fff", borderRadius: 8, padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },

  dayBlock: { background: "#0f172a", borderRadius: 12, padding: "14px 16px", marginBottom: 12 },
  dayHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  dayLabel: { fontWeight: 700, fontSize: 14, color: "#f1f5f9" },
  dayTotal: { fontSize: 13, fontWeight: 700, color: "#60a5fa" },
  tripRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#94a3b8", padding: "5px 0", borderTop: "1px solid #1e293b" },
  tripNum: { color: "#475569", width: 42, flexShrink: 0, fontSize: 12 },
  tripTimes: { display: "flex", gap: 6, alignItems: "center", flex: 1, flexWrap: "wrap" },
  leftTime: { color: "#f87171" },
  backTime: { color: "#86efac" },
  outNow: { color: "#fbbf24", fontStyle: "italic" },
  tripDur: { color: "#64748b", fontSize: 12, marginLeft: "auto", flexShrink: 0 },

  shareBox: { width: "100%", height: 260, background: "#0f172a", color: "#94a3b8", border: "1px solid #334155", borderRadius: 10, padding: 14, fontSize: 13, fontFamily: "monospace", resize: "none", boxSizing: "border-box", marginBottom: 14 },
};
