import React, { useEffect, useMemo, useRef, useState } from "react";

// Tek dosyalık DEMO (React) – Köpek Parkı (QR ile giriş)
// Özellikler:
// - QR ile giriş + cookie ile hatırla → tekrar taramada otomatik online
// - Online durum: 30 sn kalp atışı; sekme kapanınca/"Ayrıl" ile anında düşme
// - "Son 30 dk içinde parkta olanlar" listesi
// - Profil: cins, yaş, cinsiyet, foto (yalnızca kendi profilini düzenleyebilir)
// - Sohbet: köpek adıyla yazılır; küfürler maske; kullanıcı yalnız kendi mesajını silebilir
// - Park izolasyonu: siracevizler / sisli / nisantasi
// - KVKK onayı + aydınlatma
// - Runtime test paneli

// ---------------- Yardımcılar ----------------
// (Faz 2 - Opsiyonel Firebase Realtime kalıcılık)
// Aç/Kapat: tarayıcı konsolunda → window.firebaseEnabled = true/false
// Config: window.firebaseConfig = { apiKey:'...', authDomain:'...', databaseURL:'...', projectId:'...', appId:'...' }
let __fb = null;
async function fbInit() {
  try {
    if (typeof window === "undefined" || !window.firebaseEnabled) return null;
    if (__fb) return __fb;
    const [{ initializeApp }, { getDatabase, ref, set, onValue, push, remove }, { getAuth, signInAnonymously }] = await Promise.all([
      import("firebase/app"),
      import("firebase/database"),
      import("firebase/auth")
    ]);
    const cfg = window.firebaseConfig || null;
    if (!cfg || !cfg.apiKey || !cfg.databaseURL) {
      console.warn("Firebase config eksik. window.firebaseConfig ayarlayın veya window.firebaseEnabled=false yapın.");
      return null;
    }
    const app = initializeApp(cfg);
    const auth = getAuth(app);
    if (!auth.currentUser) await signInAnonymously(auth);
    const db = getDatabase(app);
    __fb = { app, auth, db, ref, set, onValue, push, remove };
    return __fb;
  } catch (e) {
    console.warn("Firebase init hatası:", e);
    return null;
  }
}
const useFirebase = () => typeof window !== "undefined" && !!window.firebaseEnabled;

const safeUUID = () => {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch {}
  return "id-" + Math.random().toString(36).slice(2);
};

const hasBroadcast = () => {
  try { return typeof BroadcastChannel !== "undefined"; } catch { return false; }
};

const MIN_MS_ONLINE = 30 * 1000; // 30 sn
const RECENT_WINDOW_MS = 30 * 60 * 1000; // 30 dk

// Cookie yardımcıları
const COOKIE_KEY = "dogpark_user";
const setCookie = (name, value, days = 180) => {
  try {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; Expires=${expires}; Path=/; SameSite=Lax`;
  } catch {}
};
const getCookie = (name) => {
  try {
    return document.cookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(name + "="))
      ?.split("=")[1] || null;
  } catch { return null; }
};

// Basit küfür filtresi
const BAD_WORDS = ["amk","aq","orospu","s.kerim","sikerim","piç","salak","aptal","fuck","shit","bitch"];
const cleanText = (t) => {
  let s = t;
  BAD_WORDS.forEach((w) => {
    const re = new RegExp(w.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "gi");
    s = s.replace(re, (m) => "*".repeat(Math.max(m.length, 3)));
  });
  return s;
};

// ---------------- Ana Uygulama ----------------
export default function DogParkApp() {
  const urlParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const parkFromUrl = urlParams.get("park") || "siracevizler";

  const [park] = useState(parkFromUrl); // park seçimi kilitli, değiştirilemez
  const [dogName, setDogName] = useState("");
  const [joined, setJoined] = useState(false);
  const [members, setMembers] = useState([]);
  const [recent, setRecent] = useState([]);
  const [profiles, setProfiles] = useState({});
  const [tabId] = useState(() => safeUUID());
  const [kvkkOk, setKvkkOk] = useState(false);

  // Presence BroadcastChannel
  const presenceRef = useRef(null);
  useEffect(() => {
    if (!hasBroadcast()) return;
    const ch = new BroadcastChannel(`dogpark:${park}`);
    presenceRef.current = ch;
    const onMsg = () => {
      setMembers(loadMembers());
      setRecent(loadRecent());
      setProfiles(loadProfiles());
    };
    ch.addEventListener("message", onMsg);
    return () => {
      try { ch.removeEventListener("message", onMsg); ch.close(); } catch {}
      presenceRef.current = null;
    };
  }, [park]);

  const now = () => Date.now();

  // Storage helpers
  const keyMembers = useMemo(() => `dogpark:${park}:members`, [park]);
  const keyRecent  = useMemo(() => `dogpark:${park}:recent`,  [park]);
  const keyProfiles= useMemo(() => `dogpark:${park}:profiles`,[park]);
  const keyChat    = useMemo(() => `dogpark:${park}:chat`,    [park]);

  const load = (k, d) => { try { const raw = localStorage.getItem(k); if (!raw) return d; return JSON.parse(raw) ?? d; } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  const loadMembers = () => load(keyMembers, []);
  const saveMembers = (list) => { save(keyMembers, list); setMembers(list); };
  const loadRecent  = () => load(keyRecent, []);
  const saveRecent  = (list) => { save(keyRecent, list); setRecent(list); };
  const loadProfiles= () => load(keyProfiles, {});
  const saveProfiles= (map) => { save(keyProfiles, map); setProfiles(map); };
  const loadChat    = () => load(keyChat, []);
  const saveChat    = (list) => { save(keyChat, list); };

  const announce = (type, payload = {}) => {
    try { presenceRef.current?.postMessage({ type, payload, park, at: now() }); } catch {}
  };

  // İlk yükleme + cookie
  useEffect(() => {
    setMembers(loadMembers());
    setRecent(loadRecent());
    setProfiles(loadProfiles());
    try {
      const got = getCookie(COOKIE_KEY);
      if (got) {
        const data = JSON.parse(decodeURIComponent(got));
        if (data?.name) { setDogName(data.name); silentJoin(data.name); }
      }
    } catch {}
  }, [keyMembers, keyRecent, keyProfiles]);

  // Sekme kapanınca düş
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!joined) return;
      const list = loadMembers();
      const me = list.find((m) => m.id === tabId);
      const filtered = list.filter((m) => m.id !== tabId);
      saveMembers(filtered);
      if (me) recordRecent(me.name);
      announce("leave", { id: tabId });
    };
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", handleBeforeUnload);
      return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }
  }, [joined, keyMembers, keyRecent, tabId]);

  // Heartbeat
  useEffect(() => {
    if (!joined) return;
    const t = setInterval(() => {
      const list = loadMembers();
      const me = list.find((m) => m.id === tabId);
      if (me) {
        me.pingAt = now();
        saveMembers([...list.filter((m) => m.id !== tabId), me]);
        announce("heartbeat", { id: tabId });
      }
    }, 15000);
    return () => clearInterval(t);
  }, [joined]);

  const recordRecent = (name) => {
    const r = loadRecent().filter((x) => now() - x.at <= RECENT_WINDOW_MS);
    r.push({ id: safeUUID(), name, at: now() });
    saveRecent(r);
    announce("recent", { name });
  };

  const silentJoin = (name) => {
    const list = loadMembers();
    const me = { id: tabId, name: name.trim(), since: new Date().toISOString(), pingAt: now() };
    const exists = list.some((m) => m.id === tabId);
    const updated = exists ? list.map((m) => (m.id === tabId ? me : m)) : [...list, me];
    saveMembers(updated);
    setJoined(true);
    announce("join", { id: tabId, name: me.name });
  };

  const handleJoin = (e) => {
    e.preventDefault();
    if (!dogName.trim() || !kvkkOk) return;
    silentJoin(dogName.trim());
    try { setCookie(COOKIE_KEY, JSON.stringify({ name: dogName.trim(), consent: true, park })); } catch {}
  };

  const handleLeave = () => {
    const list = loadMembers();
    const me = list.find((m) => m.id === tabId);
    const filtered = list.filter((m) => m.id !== tabId);
    saveMembers(filtered);
    setJoined(false);
    if (me) recordRecent(me.name);
    announce("leave", { id: tabId });
  };

  const handleRename = () => {
    const newName = prompt("Köpeğinin yeni adı?", dogName);
    if (!newName) return;
    setDogName(newName);
    const list = loadMembers();
    const me = list.find((m) => m.id === tabId);
    if (me) {
      me.name = newName.trim();
      saveMembers([...list.filter((m) => m.id !== tabId), me]);
      announce("rename", { id: tabId, name: newName });
      try { setCookie(COOKIE_KEY, JSON.stringify({ name: newName.trim(), consent: true, park })); } catch {}
    }
  };

  const updateProfile = (id, patch) => {
    if (id !== tabId) { console.warn("Başkasının profilini düzenleyemez"); return; }
    const map = loadProfiles();
    map[id] = { ...(map[id] || {}), ...patch };
    saveProfiles(map);
    announce("profile", { id });
    (async () => {
      try {
        if (!useFirebase()) return;
        const fb = await fbInit(); if (!fb) return;
        const r = fb.ref(fb.db, `profiles/${park}/${id}`);
        await fb.set(r, map[id]);
      } catch (e) { console.warn("Profil Firebase yazılamadı", e); }
    })();
  };

  const onlineNow = useMemo(() => {
    const list = loadMembers();
    const cutoff = now() - MIN_MS_ONLINE;
    return list.filter((m) => (m.pingAt ?? 0) >= cutoff);
  }, [members]);

  const recentOnly = useMemo(() => {
    const cutoff = now() - RECENT_WINDOW_MS;
    const r = loadRecent().filter((x) => x.at >= cutoff);
    const onlineNames = new Set(onlineNow.map((m) => m.name));
    return r.filter((x) => !onlineNames.has(x.name));
  }, [recent, members]);

  const joinedCount = onlineNow.length;

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-100 via-orange-100 to-pink-100 text-slate-800">
      <header className="sticky top-0 z-10 backdrop-blur supports-[backdrop-filter]:bg-white/40 bg-white/60 border-b border-white/50">
        <div className="mx-auto max-w-4xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🐾</span>
            <div>
              <h1 className="text-xl font-bold">Köpek Parkı</h1>
              <p className="text-xs opacity-70">{park} parkına hoş geldin</p>
            </div>
          </div>
          <div className="text-sm flex items-center gap-3">
            <span className="rounded-full bg-emerald-100 px-3 py-1 border border-emerald-300">Online: {joinedCount}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8">
        {!joined ? (
          <JoinCard
            dogName={dogName}
            setDogName={setDogName}
            onJoin={handleJoin}
            park={park}
            kvkkOk={kvkkOk}
            setKvkkOk={setKvkkOk}
          />
        ) : (
          <>
            <ParkBoard
              members={onlineNow}
              recent={recentOnly}
              profiles={profiles}
              myId={tabId}
              dogName={dogName}
              onLeave={handleLeave}
              onRename={handleRename}
              onEdit={(id, patch) => updateProfile(id, patch)}
              park={park}
            />

            <ChatPanel
              dogName={dogName}
              loadChat={loadChat}
              saveChat={saveChat}
              keyChat={keyChat}
              myId={tabId}
              park={park}
              useFirebase={useFirebase()}
            />
          </>
        )}

        <KvkkCard />
        <SelfTestPanel storageKeyMembers={keyMembers} storageKeyRecent={keyRecent} storageKeyProfiles={keyProfiles} keyChat={keyChat} hasBC={hasBroadcast()} />
      </main>

      <footer className="mx-auto max-w-4xl px-4 pb-10 pt-4 text-center text-xs opacity-70">
        <p>Demo: Aynı parkta farklı sekmeler açarak anlık görüntülemeyi test edebilirsin. Gerçek kullanım için Realtime servis bağlayın.</p>
      </footer>
    </div>
  );
}

// ... (JoinCard, ParkBoard, DogCard, ProfileModal, ChatPanel, KvkkCard, SelfTestPanel aynı kalıyor, sadece "Canlıya Alırken" bölümü kaldırıldı)
