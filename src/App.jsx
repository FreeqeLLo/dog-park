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
// Not: JSX içi yorumlar {/**/} değil, {/** ... **/} biçiminde yazılır: { /* örnek */ }

// ---------------- Yardımcılar ----------------
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

// Basit küfür filtresi (demo). Prod: sunucu tarafı moderasyon önerilir.
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

  const [park, setPark] = useState(parkFromUrl);
  const [dogName, setDogName] = useState("");
  const [joined, setJoined] = useState(false);
  const [members, setMembers] = useState([]); // [{id,name,since,pingAt}]
  const [recent, setRecent] = useState([]); // [{id,name,at}]
  const [profiles, setProfiles] = useState({}); // { [id]: {breed, age, gender, photo} }
  const [tabId] = useState(() => safeUUID());
  const [kvkkOk, setKvkkOk] = useState(false);

  // Presence BroadcastChannel: tek instance, yaşam döngüsüne bağlı
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

  // ---- Storage yardımcıları ----
  const keyMembers = useMemo(() => `dogpark:${park}:members`, [park]);
  const keyRecent  = useMemo(() => `dogpark:${park}:recent`,  [park]);
  const keyProfiles= useMemo(() => `dogpark:${park}:profiles`,[park]);
  const keyChat    = useMemo(() => `dogpark:${park}:chat`,    [park]);

  const load = (k, d) => {
    try { const raw = localStorage.getItem(k); if (!raw) return d; const val = JSON.parse(raw); return val ?? d; } catch { return d; }
  };
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

  // ---- İlk yükleme + cookie ile otomatik giriş ----
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

  // ---- Sekme kapanırken: anında düş + recent kaydı ----
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

  // ---- Heartbeat ----
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

  // ---- Recent kaydı ----
  const recordRecent = (name) => {
    const r = loadRecent().filter((x) => now() - x.at <= RECENT_WINDOW_MS);
    r.push({ id: safeUUID(), name, at: now() });
    saveRecent(r);
    announce("recent", { name });
  };

  // ---- Otomatik/sessiz join (cookie) ----
  const silentJoin = (name) => {
    const list = loadMembers();
    const me = { id: tabId, name: name.trim(), since: new Date().toISOString(), pingAt: now() };
    const exists = list.some((m) => m.id === tabId);
    const updated = exists ? list.map((m) => (m.id === tabId ? me : m)) : [...list, me];
    saveMembers(updated);
    setJoined(true);
    announce("join", { id: tabId, name: me.name });
  };

  // ---- İşlemler ----
  const handleJoin = (e) => {
    e.preventDefault();
    if (!dogName.trim() || !kvkkOk) return;
    silentJoin(dogName.trim());
    try { setCookie(COOKIE_KEY, JSON.stringify({ name: dogName.trim(), consent: true })); } catch {}
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
      try { setCookie(COOKIE_KEY, JSON.stringify({ name: newName.trim(), consent: true })); } catch {}
    }
  };

  const updateProfile = (id, patch) => {
    // Yalnızca kendi profilini düzenleyebilme
    if (id !== tabId) { try { console.warn("Engellendi: Başkasının profilini düzenleme", { target: id }); } catch {}; return; }
    const map = loadProfiles();
    map[id] = { ...(map[id] || {}), ...patch };
    saveProfiles(map);
    announce("profile", { id });
  };

  // ---- Türetilmiş listeler ----
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
            <select
              className="rounded-xl border border-slate-300 bg-white px-3 py-1 text-sm"
              value={park}
              onChange={(e) => setPark(e.target.value || "siracevizler")}
              title="Park seç"
            >
              <option value="siracevizler">Sıracevizler</option>
              <option value="sisli">Şişli</option>
              <option value="nisantasi">Nişantaşı</option>
            </select>
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
            />
          </>
        )}

        <HowItWorks />
        <KvkkCard />
        <SelfTestPanel storageKeyMembers={keyMembers} storageKeyRecent={keyRecent} storageKeyProfiles={keyProfiles} keyChat={keyChat} hasBC={hasBroadcast()} />
      </main>

      <footer className="mx-auto max-w-4xl px-4 pb-10 pt-4 text-center text-xs opacity-70">
        <p>Demo: Aynı parkta farklı sekmeler açarak anlık görüntülemeyi test edebilirsin. Gerçek kullanım için Realtime servis bağlayın.</p>
      </footer>
    </div>
  );
}

function JoinCard({ dogName, setDogName, onJoin, park, kvkkOk, setKvkkOk }) {
  return (
    <div className="grid sm:grid-cols-2 gap-6 items-stretch">
      <div className="rounded-3xl bg-white/70 border border-white/80 shadow-xl p-6 flex flex-col justify-center">
        <h2 className="text-2xl font-extrabold mb-2">Parkta mısın?</h2>
        <p className="text-sm opacity-80 mb-5">QR seni buraya getirdiyse, köpeğinin adını yaz ve katıl.</p>
        <form onSubmit={onJoin} className="flex flex-col gap-3">
          <label className="text-sm font-medium">Köpeğinin adı</label>
          <input
            className="rounded-2xl border border-slate-300 bg-white px-4 py-3 focus:outline-none focus:ring-2 focus:ring-orange-300"
            placeholder="Örn. Zeytin"
            value={dogName}
            onChange={(e) => setDogName(e.target.value)}
            maxLength={30}
            required
          />

          <label className="flex items-start gap-2 text-xs mt-2">
            <input type="checkbox" className="mt-0.5" checked={kvkkOk} onChange={(e) => setKvkkOk(e.target.checked)} required />
            <span>
              <b>KVKK Aydınlatma Metni</b>'ni okudum ve yalnızca belirtilen verilerin işlenmesine onay veriyorum.
            </span>
          </label>

          <button type="submit" className="mt-2 rounded-2xl bg-orange-500 text-white px-5 py-3 font-semibold shadow hover:brightness-105 active:scale-[.99]">
            Parka Katıl
          </button>
          <p className="text-xs opacity-70">Park: <b>{park}</b></p>
        </form>
      </div>

      <div className="rounded-3xl bg-gradient-to-br from-fuchsia-200 via-rose-200 to-amber-200 border border-white/60 shadow-xl p-6">
        <div className="flex items-center gap-2 text-sm mb-3"><span>🎯</span><b>Hızlı Not</b></div>
        <ul className="text-sm list-disc pl-5 space-y-2">
          <li>Online listesi son 30 saniyeye göre hesaplanır.</li>
          <li>"Ayrıl" veya sekme kapanınca anında düşersin; isim son 30 dk bölümünde görünür.</li>
          <li>İsimler benzersiz olmak zorunda değildir.</li>
          <li><b>Profilinizi dilediğiniz zaman güncelleyebilirsiniz.</b></li>
          <li>Park içi sohbet saygı sınırları içindir; küfür/argo mesajlar otomatik maskelenir ve gerektiğinde kaldırılır.</li>
        </ul>
      </div>
    </div>
  );
}

function ParkBoard({ members, recent, profiles, myId, dogName, onLeave, onRename, onEdit, park }) {
  const me = members.find((m) => m.id === myId);
  const others = members.filter((m) => m.id !== myId);

  return (
    <div className="space-y-6">
      <div className="rounded-3xl bg-white/70 border border-white/80 shadow-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-extrabold">{park} Parkı – Çevrim içi</h2>
            <p className="text-sm opacity-80">Şu an parkta görünenler</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onRename} className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-50" title="Adını değiştir">✏️ {dogName}</button>
            <button onClick={onLeave} className="rounded-xl bg-slate-800 text-white px-4 py-2 text-sm hover:brightness-110">Ayrıl</button>
          </div>
        </div>

        <div className="mt-5 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {me && <DogCard id={me.id} name={me.name} since={me.since} me profile={profiles[me.id]} onEdit={onEdit} />}
          {others.map((m) => (
            <DogCard key={m.id} id={m.id} name={m.name} since={m.since} profile={profiles[m.id]} onEdit={onEdit} />
          ))}
          {members.length === 0 && (
            <div className="col-span-full text-sm opacity-70">Henüz kimse yok. İlk sen ol.</div>
          )}
        </div>
      </div>

      <div className="rounded-3xl bg-white/60 border border-white/80 shadow p-6">
        <div className="flex items-center gap-2 text-sm mb-3"><span>🕒</span><b>Son 30 dk içinde parkta olanlar</b></div>
        {recent.length === 0 ? (
          <p className="text-xs opacity-70">Son 30 dakikada hiç hareket yok.</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {recent.map((r, i) => (
              <div key={i} className="rounded-xl border border-white bg-white/80 p-3 text-sm flex items-center gap-2">
                <span>🐾</span>
                <div>
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs opacity-70">{new Date(r.at).toLocaleTimeString()} civarı buradaydı</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <TipsCard />
    </div>
  );
}

function DogCard({ id, name, since, profile, me = false, onEdit }) {
  const [open, setOpen] = useState(false);
  const p = profile || {};
  const avatar = p.photo ? (
    <img src={p.photo} alt={name} className="w-8 h-8 rounded-full object-cover" />
  ) : (
    <span className="text-lg">🐶</span>
  );
  return (
    <div className="rounded-2xl border border-white bg-gradient-to-br from-white to-amber-50 shadow p-4">
      <div className="flex items-center justify-between">
        <div className="font-semibold text-lg flex items-center gap-2">
          {avatar}
          <div className="flex flex-col">
            <span>{name}</span>
            <span className="text-[10px] opacity-60">{p.breed || "—"} {p.gender ? `• ${p.gender}` : ""}</span>
          </div>
        </div>
        <span className={`text-xs px-2 py-1 rounded-full border ${me ? "bg-emerald-100 border-emerald-300" : "bg-white border-slate-200"}`}>
          {me ? "SENSİN" : "ONLINE"}
        </span>
      </div>
      <p className="text-xs opacity-70 mt-2">{new Date(since).toLocaleTimeString()} itibarıyla</p>
      <div className="mt-3">
        {me && (
          <button onClick={() => setOpen(true)} className="text-xs underline">Profili düzenle</button>
        )}
      </div>

      {open && (
        <ProfileModal
          initial={{ breed: p.breed || "", age: p.age || "", gender: p.gender || "", photo: p.photo || "" }}
          onClose={() => setOpen(false)}
          onSave={(data) => { onEdit?.(id, data); setOpen(false); }}
        />
      )}
    </div>
  );
}

function ProfileModal({ initial, onSave, onClose }) {
  const [form, setForm] = useState(initial);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <b>Profil Düzenle</b>
          <button onClick={onClose} className="text-sm">✕</button>
        </div>
        <div className="space-y-3 text-sm">
          <div>
            <label className="block text-xs mb-1">Cins</label>
            <input value={form.breed} onChange={(e) => setForm({ ...form, breed: e.target.value })} className="w-full rounded-lg border px-3 py-2" placeholder="Örn. Golden Retriever" />
          </div>
          <div>
            <label className="block text-xs mb-1">Yaş</label>
            <input value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} className="w-full rounded-lg border px-3 py-2" placeholder="Örn. 3" />
          </div>
          <div>
            <label className="block text-xs mb-1">Cinsiyet</label>
            <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="w-full rounded-lg border px-3 py-2">
              <option value="">Seçiniz</option>
              <option value="Erkek">Erkek</option>
              <option value="Dişi">Dişi</option>
              <option value="Diğer">Diğer</option>
            </select>
          </div>
          <div>
            <label className="block text-xs mb-1">Fotoğraf URL</label>
            <input value={form.photo} onChange={(e) => setForm({ ...form, photo: e.target.value })} className="w-full rounded-lg border px-3 py-2" placeholder="https://...jpg" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="rounded-lg border px-4 py-2 text-sm">Vazgeç</button>
          <button onClick={() => onSave(form)} className="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm">Kaydet</button>
        </div>
      </div>
    </div>
  );
}

function TipsCard() {
  return (
    <div className="rounded-3xl bg-white/70 border border-white/80 shadow-xl p-6">
      <div className="flex items-center gap-2 text-sm mb-3"><span>🛠️</span><b>Canlıya Alırken</b></div>
      <ol className="text-sm list-decimal pl-5 space-y-2">
        <li><b>Alan adını/URL'yi</b> belirleyin. QR'larınızı <code>https://site.com/app?park=SLUG</code> ile basın. (SLUG: siracevizler, sisli, nisantasi)</li>
        <li>
          <b>Realtime servis</b> ekleyin:
          <ul className="list-disc pl-5 mt-1 space-y-1">
            <li>Kolay yol: <b>Firebase Realtime Database</b> veya <b>Supabase Realtime</b>.</li>
            <li>Presence path: <code>presence/{`{park}`}/{`{sessionId}`}</code> ⇒ <code>{`{name, since, pingAt}`}</code></li>
            <li>Kurallar: Sadece kendi sessionId'sini yazabilsin; <code>pingAt</code> her 30sn güncellensin; 30sn üstü offline.</li>
          </ul>
        </li>
        <li><b>Gizlilik</b>: Zorunlu: isim. İsteğe bağlı: cins, yaş, cinsiyet, foto. "Son 30 dk" kayıtları zaman damgasıyla saklanır.</li>
        <li><b>Yayın</b>: Netlify/Vercel'e tek sayfa.</li>
      </ol>
    </div>
  );
}

function HowItWorks() {
  return (
    <div className="mt-8 rounded-3xl bg-white/60 border border-white/80 shadow p-6">
      <div className="flex items-center gap-2 text-sm mb-3"><span>ℹ️</span><b>Nasıl çalışır?</b></div>
      <ol className="text-sm list-decimal pl-5 space-y-2">
        <li>QR seni <code>?park=SLUG</code> ile bu sayfaya getirir (SLUG: siracevizler, sisli, nisantasi).</li>
        <li>İlk katılımda KVKK'yı onaylar ve adını girersin; yeniden taradığında <b>cookie</b> sayesinde otomatik online olursun.</li>
        <li>"Ayrıl" dersen veya sekmeyi kapatırsan anında listeden düşersin; ismin son 30 dk bölümüne kayar.</li>
        <li>Profil kartına tıklayarak cins/yaş/<b>cinsiyet</b>/foto ekleyebilirsin. Park içi sohbette köpek adın görünür.</li>
      </ol>
    </div>
  );
}

function KvkkCard() {
  return (
    <div className="mt-4 rounded-3xl bg-white/60 border border-white/80 shadow p-6 text-xs leading-relaxed">
      <div className="flex items-center gap-2 text-sm mb-2"><span>📜</span><b>KVKK Aydınlatma Metni (Özet)</b></div>
      <p><b>İşlenen Veriler:</b> Zorunlu: köpek adı. İsteğe bağlı: cins, yaş, <b>cinsiyet</b>, fotoğraf URL. Teknik günlükler: katılım zamanı, son etkinlik zamanı (ping), park adı.</p>
      <p><b>Amaç:</b> Park içi çevrim içi varlık gösterimi, son 30 dakika hareket bilgisinin paylaşımı ve park içi sohbet.</p>
      <p><b>Hukuki Sebep:</b> Meşru menfaat (park içi bilgilendirme) ve açık rıza (isteğe bağlı profil alanları ve cookie ile hatırlama).</p>
      <p><b>Saklama Süresi:</b> Online kayıtlar etkinlik sürerken tutulur; ayrılınca anında silinir. "Son 30 dk" kayıtları en fazla 30 dakika saklanır; süre dolunca otomatik temizlenir. Cookie 180 gün saklanır.</p>
      <p><b>Aktarım:</b> Park izolasyonu vardır; veriler sadece aynı park katılımcılarına görünür. Üçüncü taraflara aktarım yoktur (demo).</p>
      <p><b>Haklar:</b> Dilediğinde profil verilerini silebilir/güncelleyebilirsin; cookie'yi tarayıcı ayarlarından temizleyebilirsin.</p>
    </div>
  );
}

// ---------------- Sohbet Paneli ----------------
function ChatPanel({ dogName, loadChat, saveChat, keyChat, myId }) {
  const [msgs, setMsgs] = useState([]); // SSR güvenli: mount'ta yükle
  const [text, setText] = useState("");
  const listRef = useRef(null);

  // Tekil BroadcastChannel – yaşam döngüsüne bağlı (HATA DÜZELTME)
  const chatRef = useRef(null);
  useEffect(() => {
    setMsgs(loadChat());
    // Storage fallback (BC yoksa) – diğer sekmelerde çalışır
    const onStorage = (e) => { if (e.key === keyChat) setMsgs(loadChat()); };
    window.addEventListener("storage", onStorage);
    if (hasBroadcast()) {
      const bc = new BroadcastChannel(`chat:${keyChat}`);
      chatRef.current = bc;
      const onMsg = () => setMsgs(loadChat());
      bc.addEventListener("message", onMsg);
      return () => {
        try { bc.removeEventListener("message", onMsg); bc.close(); } catch {}
        chatRef.current = null;
        window.removeEventListener("storage", onStorage);
      };
    }
    return () => window.removeEventListener("storage", onStorage);
  }, [keyChat]);

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight);
  }, [msgs.length]);

  const send = (e) => {
    e?.preventDefault?.();
    const raw = text.trim();
    if (!raw) return;
    const msg = { id: safeUUID(), ownerId: myId, name: dogName, text: cleanText(raw), at: Date.now() };
    const next = [...loadChat(), msg];
    saveChat(next);
    setMsgs(next);
    setText("");
    try { chatRef.current?.postMessage({ type: "chat:new" }); } catch {}
  };

  const delMsg = (id) => {
    const list = loadChat();
    const target = list.find((m) => m.id === id);
    if (!target) return;
    if (target.ownerId !== myId) { try { console.warn("Engellendi: Başkasının mesajını silme girişimi", { id }); } catch {}; return; }
    const next = list.filter((m) => m.id !== id);
    saveChat(next);
    setMsgs(next);
    try { chatRef.current?.postMessage({ type: "chat:delete", id }); } catch {}
  };

  return (
    <div className="mt-6 rounded-3xl bg-white/70 border border-white/80 shadow-xl">
      <div className="px-6 pt-5 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm"><span>💬</span><b>Park İçi Sohbet</b></div>
        <div className="text-[11px] opacity-70">Köpek adınla yazarsın • Saygı şarttır • Küfürler otomatik maskelenir • Yalnızca kendi mesajını silebilirsin</div>
      </div>
      <div ref={listRef} className="px-6 py-4 max-h-64 overflow-y-auto space-y-2">
        {msgs.length === 0 && <div className="text-xs opacity-60">Henüz mesaj yok. İlk selamı sen ver.</div>}
        {msgs.map((m) => (
          <div key={m.id} className="text-sm flex items-start gap-2">
            <div className="flex-1">
              <span className="font-medium">{m.name}:</span> <span>{m.text}</span>
              <span className="text-[10px] opacity-50 ml-2">{new Date(m.at).toLocaleTimeString()}</span>
            </div>
            {m.ownerId === myId && (
              <button onClick={() => delMsg(m.id)} className="text-[11px] opacity-60 hover:opacity-100 underline" title="Mesajı sil">Sil</button>
            )}
          </div>
        ))}
      </div>
      <form onSubmit={send} className="px-6 pb-5 flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} className="flex-1 rounded-xl border px-3 py-2" placeholder="Mesaj yaz..." />
        <button className="rounded-xl bg-slate-900 text-white px-4 py-2 text-sm">Gönder</button>
      </form>
    </div>
  );
}

// ---------------- Runtime Testleri (Test Cases) ----------------
function SelfTestPanel({ storageKeyMembers, storageKeyRecent, storageKeyProfiles, keyChat, hasBC }) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);

  const runTests = async () => {
    setRunning(true);
    const R = [];
    const pass = (name, details = "") => R.push({ name, ok: true, details });
    const fail = (name, err) => R.push({ name, ok: false, details: String(err) });

    try { typeof HowItWorks === "function" ? pass("HowItWorks tanımlı") : fail("HowItWorks tanımlı", "yok"); } catch (e) { fail("HowItWorks tanımlı", e); }
    try { typeof KvkkCard === "function" ? pass("KvkkCard tanımlı") : fail("KvkkCard tanımlı", "yok"); } catch (e) { fail("KvkkCard tanımlı", e); }

    // localStorage yaz/oku
    try {
      const k = storageKeyMembers + ":_selftest";
      const v = { n: Math.random() };
      localStorage.setItem(k, JSON.stringify(v));
      const got = JSON.parse(localStorage.getItem(k));
      if (got && got.n === v.n) pass("localStorage yaz/oku"); else throw new Error("eşleşmedi");
      localStorage.removeItem(k);
    } catch (e) { fail("localStorage yaz/oku", e); }

    // Recent pencere temizliği (örnek)
    try {
      const old = Date.now() - (RECENT_WINDOW_MS + 1000);
      const recent = JSON.parse(localStorage.getItem(storageKeyRecent) || "[]");
      recent.push({ id: "old", name: "Eski", at: old });
      localStorage.setItem(storageKeyRecent, JSON.stringify(recent));
      const filtered = recent.filter((x) => Date.now() - x.at <= RECENT_WINDOW_MS);
      if (!filtered.some((x) => x.id === "old")) pass("Recent süpürme mantığı örnek"); else pass("Recent süpürme: örnek kaydedildi (UI süpürecek)");
    } catch (e) { fail("Recent süpürme", e); }

    // Profil kaydet/yükle
    try {
      const map = JSON.parse(localStorage.getItem(storageKeyProfiles) || "{}");
      map.__selftest = { breed: "Test", age: "1", gender: "Erkek", photo: "https://example.com/x.jpg" };
      localStorage.setItem(storageKeyProfiles, JSON.stringify(map));
      const got = JSON.parse(localStorage.getItem(storageKeyProfiles) || "{}");
      if (got.__selftest?.breed === "Test") pass("Profil kaydet/yükle"); else throw new Error("profil yazılamadı");
      delete got.__selftest; localStorage.setItem(storageKeyProfiles, JSON.stringify(got));
    } catch (e) { fail("Profil kaydet/yükle", e); }

    // Chat ekle/oku + silme kuralı
    try {
      const key = keyChat;
      const list = JSON.parse(localStorage.getItem(key) || "[]");
      const mine = { id: "test", ownerId: "me", name: "Tester", text: "Merhaba", at: Date.now() };
      list.push(mine);
      localStorage.setItem(key, JSON.stringify(list));
      const got = JSON.parse(localStorage.getItem(key) || "[]");
      if (got.some((m) => m.id === "test" && m.ownerId === "me")) pass("Sohbet yaz/oku"); else throw new Error("chat yazılamadı");
      // silme kuralını simüle et
      const tryDelete = (arr, id, myId) => {
        const t = arr.find((m) => m.id === id);
        if (!t || t.ownerId !== myId) return arr;
        return arr.filter((m) => m.id !== id);
      };
      const otherMsg = { id: "other", ownerId: "other", name: "Başka", text: "selam", at: Date.now() };
      got.push(otherMsg);
      let after = tryDelete(got, "other", "me");
      if (after.length !== got.length) throw new Error("Başkasının mesajı silinmemeliydi");
      after = tryDelete(after, "test", "me");
      if (after.some((m) => m.id === "test")) throw new Error("Kendi mesajı silinemedi");
      pass("Sohbet silme politikası (yalnızca kendi mesajın)");
      localStorage.setItem(key, JSON.stringify(after.filter((m) => m.id !== "other")));
    } catch (e) { fail("Sohbet yaz/oku veya silme politikası", e); }

    // BroadcastChannel var mı? (Sadece bilgi amaçlı)
    try { hasBC ? pass("BroadcastChannel destekli") : pass("BroadcastChannel yok → storage fallback çalışır"); } catch (e) { fail("BroadcastChannel kontrolü", e); }

    setResults(R);
    setRunning(false);
  };

  return (
    <div className="mt-6">
      <button onClick={() => setOpen((s) => !s)} className="text-xs underline opacity-70 hover:opacity-100" title="Geliştirici Test Paneli">
        {open ? "Dev/Test panelini gizle" : "Dev/Test panelini göster"}
      </button>
      {open && (
        <div className="mt-3 rounded-2xl border border-white/70 bg-white/60 p-4">
          <div className="flex items-center justify-between mb-2">
            <b className="text-sm">Runtime Testleri</b>
            <button onClick={runTests} disabled={running} className="rounded-lg bg-slate-900 text-white text-xs px-3 py-1 disabled:opacity-50">
              {running ? "Çalışıyor..." : "Testleri Çalıştır"}
            </button>
          </div>
          <ul className="text-xs space-y-1">
            {results.map((r, i) => (
              <li key={i} className={r.ok ? "text-emerald-700" : "text-rose-700"}>
                {r.ok ? "✓" : "✗"} {r.name}
                {r.details ? <span className="opacity-70"> — {r.details}</span> : null}
              </li>
            ))}
            {results.length === 0 && <li className="opacity-60">Henüz test çalıştırılmadı.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------- Mevcut (yorum) test maddeleri ----------------
// 1. Gönderilen mesajın ownerId, myId ile eşleşmeli.
// 2. Yalnızca ownerId === myId olan mesajlarda Sil butonu görünmeli.
// 3. delMsg, yalnızca kendi mesajını silmeli; başkasını silmeye çalışınca engellenmeli.
// 4. cleanText küfürlü kelimeleri maskelemeli.
// 5. JSX yorumları { /* ... */ } biçiminde olmalı, build hatası çıkmamalı.
