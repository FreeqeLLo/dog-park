import React, { useEffect, useMemo, useRef, useState } from "react";

// Tek dosyalık DEMO (React) – Köpek Parkı (QR ile giriş)
// Özellikler (MVP):
// - QR ile giriş + cookie ile hatırla → tekrar taramada otomatik online
// - Online durum: 30 sn kalp atışı; sekme kapanınca/"Ayrıl" ile anında düşme
// - "Son 30 dk içinde parkta olanlar" listesi
// - Profil: cins, yaş, cinsiyet, foto (yalnızca kendi profilini düzenleyebilir)
// - Sohbet: köpek adıyla yazılır; küfürler maske; kullanıcı yalnız kendi mesajını silebilir
// - Park izolasyonu: siracevizler / sisli / nisantasi
// - KVKK onayı + aydınlatma
// - Park kilidi: ilk giriş yapılan park cookie'de saklanır, URL'i ezer → park değişmez
// - İsteğe bağlı (flag): Firebase Realtime'a profil/sohbet kalıcı yazımı (window.firebaseEnabled)

// ---------------- Yardımcılar ----------------
let __fb = null; // opsiyonel Firebase handle
async function fbInit() {
  try {
    if (typeof window === "undefined" || !window.firebaseEnabled) return null;
    if (__fb) return __fb;
    const [{ initializeApp }, { getDatabase, ref, set, onValue, push, remove }, { getAuth, signInAnonymously }] = await Promise.all([
      import("firebase/app"),
      import("firebase/database"),
      import("firebase/auth"),
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
const hasBroadcast = () => { try { return typeof BroadcastChannel !== "undefined"; } catch { return false; } };

const MIN_MS_ONLINE = 30 * 1000;        // çevrim içi eşiği
const RECENT_WINDOW_MS = 30 * 60 * 1000; // son 30 dk

const COOKIE_KEY = "dogpark_user";
const setCookie = (name, value, days = 180) => {
  try {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; Expires=${expires}; Path=/; SameSite=Lax`;
  } catch {}
};
const getCookie = (name) => {
  try {
    return document.cookie.split(";").map(c=>c.trim()).find(c=>c.startsWith(name+"="))?.split("=")[1] || null;
  } catch { return null; }
};

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

  // Cookie'de park varsa URL'i ezer → park kilidi
  let cookiePark = null;
  try {
    const got = getCookie(COOKIE_KEY);
    if (got) {
      const data = JSON.parse(decodeURIComponent(got));
      if (data?.park) cookiePark = data.park;
    }
  } catch {}
  const initialPark = cookiePark || parkFromUrl;

  const [park] = useState(initialPark); // kilitli
  const [dogName, setDogName] = useState("");
  const [joined, setJoined] = useState(false);
  const [members, setMembers] = useState([]);
  const [recent, setRecent] = useState([]);
  const [profiles, setProfiles] = useState({}); // { [id]: {breed, age, gender, photo} }
  const [tabId] = useState(() => safeUUID());
  const [kvkkOk, setKvkkOk] = useState(false);

  // Profil modal
  const [editId, setEditId] = useState(null);

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
    return () => { try { ch.removeEventListener("message", onMsg); ch.close(); } catch {}; presenceRef.current = null; };
  }, [park]);

  const now = () => Date.now();

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

  // İlk yükleme + cookie ile otomatik giriş
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

  // Kalp atışı
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
        <div className="px-4 py-3 flex items-center justify-between">
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

      <main className="px-4 md:px-8 py-8">
        {!joined ? (
          <form onSubmit={handleJoin} className="max-w-md mx-auto bg-white rounded-xl shadow p-4 space-y-3">
            <input
              type="text"
              value={dogName}
              onChange={(e) => setDogName(e.target.value)}
              placeholder="Köpeğinin adı"
              className="w-full border rounded px-3 py-2"
            />
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={kvkkOk} onChange={(e) => setKvkkOk(e.target.checked)} />
              KVKK metnini okudum ve kabul ediyorum
            </label>
            <button type="submit" className="w-full bg-emerald-500 text-white rounded py-2">Parka Katıl</button>
            <p className="text-[11px] opacity-70">Hızlı not: Profilinizi katıldıktan sonra "Profili düzenle" ile güncelleyebilirsiniz. Küfür ve saygısız mesajlar maskelenir.</p>
          </form>
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
              onEdit={(id) => setEditId(id)}
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

            <ProfileModal
              open={!!editId}
              onClose={()=>setEditId(null)}
              id={editId}
              meId={tabId}
              data={profiles[editId || ""] || {}}
              onSave={(patch)=>{ if(!editId) return; updateProfile(editId, patch); setEditId(null); }}
            />
          </>
        )}

        <KvkkCard />
        <SelfTestPanel storageKeyMembers={keyMembers} storageKeyRecent={keyRecent} storageKeyProfiles={keyProfiles} keyChat={keyChat} hasBC={hasBroadcast()} />
      </main>

      <footer className="px-4 md:px-8 pb-10 pt-4 text-center text-xs opacity-70">
        <p>Demo: Aynı parkta farklı sekmeler açarak anlık görüntülemeyi test edebilirsin. İsteğe bağlı olarak Firebase Realtime ile kalıcı kayıt yapılabilir.</p>
      </footer>
    </div>
  );
}

// ---------------- Alt Bileşenler ----------------
function ParkBoard({ members, recent, profiles, myId, dogName, onLeave, onRename, onEdit, park }) {
  return (
    <section className="grid md:grid-cols-2 gap-4 mb-6">
      <div className="rounded-2xl bg-white/80 p-4 shadow">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Çevrim içi</h2>
          <div className="flex gap-2 text-sm">
            <button onClick={onRename} className="rounded-md border px-3 py-1">Adı Değiştir</button>
            <button onClick={onLeave} className="rounded-md border px-3 py-1">Ayrıl</button>
          </div>
        </div>
        <ul className="space-y-2">
          {members.map((m)=> (
            <li key={m.id} className="flex items-center justify-between rounded-lg border px-3 py-2">
              <div>
                <div className="font-medium">{m.name}{m.id===myId?" (sen)":""}</div>
                <div className="text-xs opacity-60">{profiles[m.id]?.breed ? `${profiles[m.id].breed} • ${profiles[m.id].gender||"?"}` : "profil yok"}</div>
              </div>
              <button onClick={()=>onEdit(m.id)} disabled={m.id!==myId} className="text-xs underline disabled:opacity-40">Profili düzenle</button>
            </li>
          ))}
          {members.length===0 && <li className="text-sm opacity-70">Şu an çevrim içi kimse yok.</li>}
        </ul>
      </div>
      <div className="rounded-2xl bg-white/80 p-4 shadow">
        <h2 className="font-semibold mb-3">Son 30 dk</h2>
        <ul className="space-y-2">
          {recent.map((r)=> (
            <li key={r.id} className="rounded-lg border px-3 py-2">{r.name}</li>
          ))}
          {recent.length===0 && <li className="text-sm opacity-70">Kayıt yok.</li>}
        </ul>
      </div>
    </section>
  );
}

function ProfileModal({ open, onClose, id, meId, data, onSave }) {
  const [form, setForm] = useState(() => ({
    breed: data?.breed || "",
    age: data?.age || "",
    gender: data?.gender || "",
    photo: data?.photo || "",
  }));
  useEffect(()=>{
    setForm({ breed: data?.breed||"", age: data?.age||"", gender: data?.gender||"", photo: data?.photo||"" });
  }, [data]);

  if (!open) return null;
  const isMine = id === meId;

  return (
    <div className="fixed inset-0 bg-black/30 grid place-items-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold">Profil</h3>
          <button onClick={onClose} className="text-sm">Kapat</button>
        </div>
        {!isMine && <p className="text-xs mb-2 opacity-70">Yalnızca kendi profilinizi düzenleyebilirsiniz.</p>}
        <div className="grid gap-2">
          <input disabled={!isMine} value={form.breed} onChange={(e)=>setForm(f=>({...f, breed:e.target.value}))} className="rounded border px-3 py-2" placeholder="Cins (örn. Golden)" />
          <input disabled={!isMine} value={form.age} onChange={(e)=>setForm(f=>({...f, age:e.target.value}))} className="rounded border px-3 py-2" placeholder="Yaş" />
          <select disabled={!isMine} value={form.gender} onChange={(e)=>setForm(f=>({...f, gender:e.target.value}))} className="rounded border px-3 py-2">
            <option value="">Cinsiyet</option>
            <option value="Erkek">Erkek</option>
            <option value="Dişi">Dişi</option>
            <option value="Belirtmek istemiyorum">Belirtmek istemiyorum</option>
          </select>
          <input disabled={!isMine} value={form.photo} onChange={(e)=>setForm(f=>({...f, photo:e.target.value}))} className="rounded border px-3 py-2" placeholder="Fotoğraf URL" />
          {form.photo && <img alt="foto" src={form.photo} className="mt-1 h-24 w-24 object-cover rounded" />}
        </div>
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onClose} className="rounded border px-3 py-1">İptal</button>
          <button disabled={!isMine} onClick={()=>onSave({ ...form, updatedAt: Date.now() })} className="rounded bg-emerald-600 text-white px-3 py-1 disabled:opacity-40">Kaydet</button>
        </div>
      </div>
    </div>
  );
}

function ChatPanel({ dogName, loadChat, saveChat, keyChat, myId, park, useFirebase }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const bcRef = useRef(null);

  useEffect(()=>{
    if (useFirebase) {
      (async () => {
        const fb = await fbInit(); if (!fb) return;
        const r = fb.ref(fb.db, `chat/${park}`);
        fb.onValue(r, (snap) => {
          const obj = snap.val() || {};
          const arr = Object.values(obj).sort((a,b)=> (a.at||0)-(b.at||0));
          setMsgs(arr);
        });
      })();
      return;
    }
    // local
    setMsgs(loadChat());
    const onStorage = (e) => { if (e.key === keyChat) setMsgs(loadChat()); };
    window.addEventListener("storage", onStorage);
    if (hasBroadcast()) {
      const bc = new BroadcastChannel(`chat:${keyChat}`);
      bcRef.current = bc;
      const onMsg = () => setMsgs(loadChat());
      bc.addEventListener("message", onMsg);
      return () => { try { bc.removeEventListener("message", onMsg); bc.close(); } catch {}; window.removeEventListener("storage", onStorage); };
    }
    return () => window.removeEventListener("storage", onStorage);
  }, [keyChat, park, useFirebase]);

  const send = (e) => {
    e?.preventDefault?.();
    const raw = text.trim(); if (!raw) return;
    const cleaned = cleanText(raw);
    if (useFirebase) {
      (async () => {
        const fb = await fbInit(); if (!fb) return;
        const r = fb.ref(fb.db, `chat/${park}`);
        const keyRef = fb.push(r);
        await fb.set(keyRef, { id: keyRef.key, ownerId: myId, name: dogName, text: cleaned, at: Date.now() });
        setText("");
      })();
      return;
    }
    const msg = { id: safeUUID(), ownerId: myId, name: dogName, text: cleaned, at: Date.now() };
    const next = [...loadChat(), msg];
    saveChat(next); setMsgs(next); setText("");
    try { bcRef.current?.postMessage({ type: "chat:new" }); } catch {}
  };

  const delMsg = (id) => {
    const target = msgs.find(m => m.id === id);
    if (!target || target.ownerId !== myId) return; // sadece kendi mesajı
    if (useFirebase) {
      (async () => {
        const fb = await fbInit(); if (!fb) return;
        await fb.remove(fb.ref(fb.db, `chat/${park}/${id}`));
      })();
      return;
    }
    const list = loadChat();
    const next = list.filter(m => m.id !== id);
    saveChat(next); setMsgs(next);
    try { bcRef.current?.postMessage({ type: "chat:delete", id }); } catch {}
  };

  return (
    <section className="rounded-2xl bg-white/80 p-4 shadow">
      <h2 className="font-semibold mb-3">Sohbet</h2>
      <ul className="space-y-2 mb-3 max-h-[40vh] overflow-auto">
        {msgs.map((m)=> (
          <li key={m.id} className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2">
            <div>
              <div className="text-sm"><b>{m.name}</b> <span className="opacity-60 text-xs">{new Date(m.at||Date.now()).toLocaleTimeString()}</span></div>
              <div className="text-sm break-words">{m.text}</div>
            </div>
            {m.ownerId===myId && (
              <button onClick={()=>delMsg(m.id)} className="text-xs underline">Sil</button>
            )}
          </li>
        ))}
        {msgs.length===0 && <li className="text-sm opacity-70">Mesaj yok.</li>}
      </ul>
      <form onSubmit={send} className="flex gap-2">
        <input value={text} onChange={(e)=>setText(e.target.value)} className="flex-1 rounded-lg border px-3 py-2" placeholder="Mesaj yaz..." />
        <button className="rounded-lg bg-indigo-600 text-white px-4 py-2 hover:bg-indigo-700">Gönder</button>
      </form>
      <p className="mt-2 text-[11px] opacity-60">Not: Küfür/saygısız mesajlar maskeleme filtresine takılır. Yalnız kendi mesajını silebilirsin.</p>
    </section>
  );
}

function KvkkCard() {
  return (
    <section className="rounded-2xl bg-white/60 p-4 mt-6 text-xs">
      <h3 className="font-semibold mb-1">KVKK Aydınlatma Özeti</h3>
      <p>Bu uygulama; köpek adı, profil bilgileri (cins, yaş, cinsiyet, foto URL), park ve sohbet içeriklerini park içi iletişim amacıyla işler. Profil ve sohbet verileri isteğe bağlı olarak Firebase üzerinde saklanabilir. Talep halinde silme için iletişim alanından ulaşabilirsiniz.</p>
    </section>
  );
}

function SelfTestPanel({ storageKeyMembers, storageKeyRecent, storageKeyProfiles, keyChat, hasBC }) {
  return (
    <details className="mt-6 text-xs">
      <summary className="cursor-pointer select-none">Runtime Test Paneli</summary>
      <div className="grid md:grid-cols-2 gap-3 mt-3">
        <div className="rounded border p-2"><b>members</b><pre className="whitespace-pre-wrap text-[11px]">{localStorage.getItem(storageKeyMembers)}</pre></div>
        <div className="rounded border p-2"><b>recent</b><pre className="whitespace-pre-wrap text-[11px]">{localStorage.getItem(storageKeyRecent)}</pre></div>
        <div className="rounded border p-2"><b>profiles</b><pre className="whitespace-pre-wrap text-[11px]">{localStorage.getItem(storageKeyProfiles)}</pre></div>
        <div className="rounded border p-2"><b>chat</b><pre className="whitespace-pre-wrap text-[11px]">{localStorage.getItem(keyChat)}</pre></div>
      </div>
      <div className="mt-2">BroadcastChannel: {String(hasBC)}</div>
    </details>
  );
}
