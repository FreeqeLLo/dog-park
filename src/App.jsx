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
// - Park kilidi: ilk park cookie'de saklanır, URL'i ezer → park değişmez
// - (Faz 2'de eklenecek) Firebase Realtime kalıcılık

// ---------------- Yardımcılar ----------------
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
  const [editId, setEditId] = useState(null); // null | string

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
          <> 
            <section className="grid md:grid-cols-2 gap-4 mb-6">
              <form onSubmit={handleJoin} className="bg-white rounded-2xl shadow p-4 space-y-3">
                <h2 className="font-semibold">Parkta mısın?</h2>
                <p className="text-sm opacity-70">QR seni buraya getirdiyse, köpeğinin adını yaz ve katıl.</p>
                <input
                  type="text"
                  value={dogName}
                  onChange={(e) => setDogName(e.target.value)}
                  placeholder="Örn. Zeytin"
                  className="w-full border rounded px-3 py-2"
                />
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={kvkkOk} onChange={(e) => setKvkkOk(e.target.checked)} />
                  KVKK Aydınlatma Metni'ni okudum ve verilerin işlenmesine onay veriyorum.
                </label>
                <div className="text-xs opacity-70">Park: {park}</div>
                <button type="submit" disabled={!dogName.trim() || !kvkkOk} className="w-full bg-emerald-600 text-white rounded py-2 disabled:opacity-40 disabled:cursor-not-allowed">Parka Katıl</button>
              </form>

              <div className="rounded-2xl bg-white/70 p-4 shadow">
                <h3 className="font-semibold mb-2">Hızlı Not</h3>
                <ul className="list-disc pl-5 text-sm space-y-1">
                  <li>Online listesi son 30 saniyeye göre hesaplanır.</li>
                  <li>"Ayrıl" veya sekmeyi kapatınca anında düşersin; isim son 30 dk bölümünde görünür.</li>
                  <li>İsimler benzersiz olmak zorunda değildir.</li>
                  <li>Profilini dilediğin zaman güncelleyebilirsin.</li>
                  <li>Park içi sohbet saygı amaçlıdır; küfür/argo maskelenir.</li>
                </ul>
              </div>
            </section>

            <section className="rounded-2xl bg-white/70 p-4 shadow mb-6">
              <h3 className="font-semibold mb-2">Nasıl çalışır?</h3>
              <ol className="list-decimal pl-5 text-sm space-y-1">
                <li>QR seni <code>?park=&lt;slug&gt;</code> ile bu sayfaya getirir (siracevizler, sisli, nisantasi).</li>
                <li>İlk katılımda KVKK onayı ve isim yeterlidir; sonraki girişlerde cookie ile otomatik online olursun.</li>
                <li>"Ayrıl" dersen veya sekmeyi kapatırsan anında listeden düşersin; isim 30 dk görünür.</li>
                <li>Profil kartından cins/yaş/cinsiyet/foto ekleyebilirsin; sohbette yanına yansır.</li>
              </ol>
            </section>
          </>
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
            />

            <ProfileModal
              open={!!editId}
              onClose={() => setEditId(null)}
              id={editId}
              meId={tabId}
              data={editId ? (profiles[editId] || {}) : {}}
              onSave={(patch) => { if (!editId) return; updateProfile(editId, patch); setEditId(null); }}
            />
          </>
        )}

        <KvkkCard />
      </main>

      <footer className="px-4 md:px-8 pb-10 pt-4 text-center text-xs opacity-70">
        <p>Demo: Aynı parkta farklı sekmeler açarak anlık görüntülemeyi test edebilirsin. Firebase Realtime kalıcılık faz 2'de eklenecek.</p>
      </footer>
    </div>
  );
}

// ---------------- Alt Bileşenler ----------------
function ParkBoard({ members, recent, profiles, myId, dogName, onLeave, onRename, onEdit }) {
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

function ChatPanel({ dogName, loadChat, saveChat, keyChat, myId, park }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const bcRef = useRef(null);

  useEffect(()=>{
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
  }, [keyChat]);

  const send = (e) => {
    e?.preventDefault?.();
    const raw = text.trim(); if (!raw) return;
    const msg = { id: safeUUID(), ownerId: myId, name: dogName, text: cleanText(raw), at: Date.now() };
    const next = [...loadChat(), msg];
    saveChat(next); setMsgs(next); setText("");
    try { bcRef.current?.postMessage({ type: "chat:new" }); } catch {}
  };

  const delMsg = (id) => {
    const list = loadChat();
    const target = list.find(m => m.id === id);
    if (!target || target.ownerId !== myId) return; // sadece kendi mesajı
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
      <p>Bu uygulama; köpek adı, profil bilgileri (cins, yaş, cinsiyet, foto URL), park ve sohbet içeriklerini park içi iletişim amacıyla işler. Veriler tarayıcıda saklanır; ileride isteğe bağlı olarak Firebase üzerinde de saklanabilir. Talep halinde silme/güncelleme için iletişim alanından ulaşabilirsiniz.</p>
    </section>
  );
}

// ---------------- Mini Smoke Testler (dev yardımcısı) ----------------
if (typeof window !== "undefined" && !window.__dogpark_smoke__) {
  window.__dogpark_smoke__ = true;
  try {
    console.assert(cleanText("amk test") !== "amk test", "Küfür filtresi çalışmalı");
    const cutoff = Date.now() - MIN_MS_ONLINE;
    console.assert(typeof cutoff === "number", "Zaman hesapları sayısal olmalı");
  } catch {}
}
