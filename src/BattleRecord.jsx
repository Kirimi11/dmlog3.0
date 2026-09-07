import { useState, useEffect, useMemo, useRef } from "react";
import { Plus, Trash2, Swords, TrendingUp, X, Trophy, Camera, Loader2, Pencil, Calendar as CalendarIcon, ChevronLeft, ChevronRight, Sparkles, BookOpen, Home, ExternalLink, Award, ListTree, Download, Link as LinkIcon, Upload, Database, Delete, Check, PieChart as PieChartIcon, ImagePlus } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, Legend } from "recharts";

// Outside claude.ai's artifact environment, window.storage doesn't exist.
// This shim backs the same get/set/delete/list interface with localStorage so the
// rest of the app (which only ever talks to window.storage) works unchanged when this
// is deployed as a standalone web app. Inside the artifact environment, window.storage
// already exists, so this shim never activates there.
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return null;
        return { key, value: raw, version: "1" };
      } catch {
        return null;
      }
    },
    async set(key, value) {
      // Deliberately does NOT swallow errors here: quota-exceeded and similar failures
      // must propagate so callers can detect the save failed and tell the user, instead
      // of silently losing data (e.g. a photo that "disappears" after a reload).
      window.localStorage.setItem(key, value);
      return { key, value };
    },
    async delete(key) {
      try {
        window.localStorage.removeItem(key);
        return { key, deleted: true };
      } catch {
        return null;
      }
    },
    async list(prefix) {
      try {
        const keys = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (!prefix || (k && k.startsWith(prefix))) keys.push(k);
        }
        return { keys };
      } catch {
        return null;
      }
    },
  };
}

const GEMINI_MODEL = "gemini-2.5-flash";

// Vision call: one image + a text prompt, expects the model to return JSON text.
async function callGeminiVision(apiKey, base64Image, mimeType, promptText, maxTokens = 800) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: mimeType, data: base64Image } },
              { text: promptText },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || "Gemini API error");
  }
  return (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}

const RESULTS = {
  win: { label: "勝ち", short: "○", color: "#b5432e", bg: "#f7ece7" },
  lose: { label: "負け", short: "●", color: "#33475b", bg: "#eef1f4" },
  draw: { label: "分け", short: "△", color: "#8a7a5c", bg: "#f5f1e6" },
};

const TURN_ORDERS = {
  first: { label: "先手", short: "先" },
  second: { label: "後手", short: "後" },
};

const STORAGE_KEY = "matches";
const PHOTOS_KEY = "tournament_photos";
const POINTS_KEY = "tournament_points";
const DECK_PROFILES_KEY = "opponent_deck_profiles";
const LINKS_KEY = "saved_links";
const CUSTOM_TABS_KEY = "custom_tabs";
const BOARDS_META_KEY = "boards_meta";
const EXTERNAL_META_KEY = "external_meta_shares";
const EXTERNAL_MATCHUPS_KEY = "external_matchups";
const DEFAULT_BOARD_ID = "default";
const UNASSIGNED = "大会外";

// the default board keeps using the original unsuffixed keys for backward compatibility;
// any additional board gets its own suffixed keys
function keyFor(base, boardId) {
  return boardId === DEFAULT_BOARD_ID ? base : `${base}_${boardId}`;
}

function makeRound() {
  return {
    id: `r_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    opponent: "",
    opponentDeck: "",
    turnOrder: null,
    result: "win",
  };
}

function calcRecord(list) {
  const win = list.filter((m) => m.result === "win").length;
  const lose = list.filter((m) => m.result === "lose").length;
  const draw = list.filter((m) => m.result === "draw").length;
  const decisive = win + lose;
  const rate = decisive > 0 ? (win / decisive) * 100 : 0;
  return { win, lose, draw, total: list.length, rate };
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

// builds unordered-pair win/lose/draw (+ turn-order) tallies from actual recorded matches only
function buildMatchupPairMap(matches) {
  const withBoth = (matches || []).filter(
    (m) => (m.myDeck || "").trim() && (m.opponentDeck || "").trim()
  );
  const pairMap = {};
  withBoth.forEach((m) => {
    const my = m.myDeck.trim();
    const opp = m.opponentDeck.trim();
    if (my === opp) return; // mirror matchup, not meaningful for advantage analysis
    const [a, b] = [my, opp].sort();
    const key = `${a}||${b}`;
    if (!pairMap[key]) {
      pairMap[key] = {
        a,
        b,
        aWin: 0,
        aLose: 0,
        draw: 0,
        aFirstWin: 0,
        aFirstLose: 0,
        aSecondWin: 0,
        aSecondLose: 0,
      };
    }
    const p = pairMap[key];
    const fromAPerspective = my === a;
    const isDraw = m.result === "draw";
    const aWon = !isDraw && (m.result === "win") === fromAPerspective;
    if (isDraw) p.draw++;
    else if (aWon) p.aWin++;
    else p.aLose++;

    if (!isDraw && (m.turnOrder === "first" || m.turnOrder === "second")) {
      const aTurn = fromAPerspective
        ? m.turnOrder
        : m.turnOrder === "first"
        ? "second"
        : "first";
      if (aTurn === "first") {
        if (aWon) p.aFirstWin++;
        else p.aFirstLose++;
      } else {
        if (aWon) p.aSecondWin++;
        else p.aSecondLose++;
      }
    }
  });
  return pairMap;
}

// mutates pairMap in place, blending in externally imported/entered deck-vs-deck records
// (no turn-order data assumed for these)
function addExternalMatchupsToPairMap(pairMap, externalMatchups) {
  (externalMatchups || []).forEach((e) => {
    const my = (e.myDeck || "").trim();
    const opp = (e.opponentDeck || "").trim();
    if (!my || !opp || my === opp) return;
    const win = Number(e.win) || 0;
    const lose = Number(e.lose) || 0;
    const draw = Number(e.draw) || 0;
    if (win + lose + draw <= 0) return;
    const [a, b] = [my, opp].sort();
    const key = `${a}||${b}`;
    if (!pairMap[key]) {
      pairMap[key] = {
        a,
        b,
        aWin: 0,
        aLose: 0,
        draw: 0,
        aFirstWin: 0,
        aFirstLose: 0,
        aSecondWin: 0,
        aSecondLose: 0,
      };
    }
    const p = pairMap[key];
    const fromAPerspective = my === a;
    p.draw += draw;
    p.aWin += fromAPerspective ? win : lose;
    p.aLose += fromAPerspective ? lose : win;
  });
  return pairMap;
}

// turns a pairMap into the per-my-deck breakdown shape used throughout the app
function finalizeMatchupPairMap(pairMap) {
  const rateOf = (win, lose) => {
    const decisive = win + lose;
    return decisive > 0 ? (win / decisive) * 100 : null;
  };

  const byMyDeck = {};
  Object.values(pairMap).forEach((p) => {
    const { a, b, aWin, aLose, draw, aFirstWin, aFirstLose, aSecondWin, aSecondLose } = p;
    const total = aWin + aLose + draw;
    const decisive = aWin + aLose;
    const aRate = decisive > 0 ? (aWin / decisive) * 100 : 0;
    const bRate = decisive > 0 ? (aLose / decisive) * 100 : 0;

    const aFirstRate = rateOf(aFirstWin, aFirstLose);
    const aSecondRate = rateOf(aSecondWin, aSecondLose);
    // B's "first" instances are the same games where A was "second", and vice versa
    const bFirstRate = rateOf(aSecondLose, aSecondWin);
    const bSecondRate = rateOf(aFirstLose, aFirstWin);

    if (!byMyDeck[a]) byMyDeck[a] = [];
    byMyDeck[a].push({
      opponentDeck: b,
      win: aWin,
      lose: aLose,
      draw,
      total,
      rate: aRate,
      firstRate: aFirstRate,
      secondRate: aSecondRate,
    });
    if (!byMyDeck[b]) byMyDeck[b] = [];
    byMyDeck[b].push({
      opponentDeck: a,
      win: aLose,
      lose: aWin,
      draw,
      total,
      rate: bRate,
      firstRate: bFirstRate,
      secondRate: bSecondRate,
    });
  });

  return Object.entries(byMyDeck)
    .map(([myDeckName, rows]) => {
      const sorted = [...rows].sort((x, y) => y.rate - x.rate);
      const win = rows.reduce((s, r) => s + r.win, 0);
      const lose = rows.reduce((s, r) => s + r.lose, 0);
      const draw = rows.reduce((s, r) => s + r.draw, 0);
      const total = win + lose + draw;
      const decisive = win + lose;
      return {
        myDeck: myDeckName,
        rows: sorted,
        win,
        lose,
        draw,
        total,
        rate: decisive > 0 ? (win / decisive) * 100 : 0,
      };
    })
    .sort((a, b) => b.total - a.total);
}

// draws an already-loaded image onto a canvas at maxDim (longest side) and encodes it as
// compressed image data. WebP is preferred since it's meaningfully smaller than JPEG at the
// same visual quality; canvases that can't encode WebP silently fall back to PNG (which is
// larger, not smaller), so that case is detected and JPEG is used explicitly instead.
function drawToCompressedDataUrl(img, maxDim, quality) {
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    if (width > height) {
      height = Math.round(height * (maxDim / width));
      width = maxDim;
    } else {
      width = Math.round(width * (maxDim / height));
      height = maxDim;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);

  const webp = canvas.toDataURL("image/webp", quality);
  if (webp.startsWith("data:image/webp")) return webp;
  return canvas.toDataURL("image/jpeg", quality);
}

// all distinct values ever entered for a field, most-frequently-used first
function frequencySortedNames(matches, field) {
  const counts = {};
  (matches || []).forEach((m) => {
    const v = (m[field] || "").trim();
    if (v) counts[v] = (counts[v] || 0) + 1;
  });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
}

// while typing, narrow the frequency-ranked list down to names containing the query;
// with no query, just show the top of the frequency ranking
function filterNames(allNames, query, limit = 8) {
  const q = (query || "").trim();
  const list = q ? allNames.filter((n) => n.includes(q)) : allNames;
  return list.slice(0, limit);
}

function todayInputValue() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function toDateInputValue(iso) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

// same tournament name on a different date is a different event
function tournamentSessionKey(name, dateInputValue) {
  return `${(name || "").trim() || UNASSIGNED}__${dateInputValue}`;
}

// minimal CSV helpers: no quoted-comma support, which is fine since deck names
// in this app don't contain commas in practice
function toCSV(headers, rows) {
  const escapeCell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escapeCell).join(",")];
  rows.forEach((row) => lines.push(row.map(escapeCell).join(",")));
  return lines.join("\n");
}

function parseCSV(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(",").map((cell) => cell.replace(/^"|"$/g, "").trim()));
}

function downloadTextFile(text, filename, mime = "text/csv;charset=utf-8") {
  const blob = new Blob(["\uFEFF" + text], { type: mime });
  const link = document.createElement("a");
  link.download = filename;
  link.href = URL.createObjectURL(blob);
  link.click();
}

function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function getWeekKey(dateStr) {
  return toDateInputValue(getWeekStart(new Date(dateStr)).toISOString());
}

function formatWeekLabel(weekKey) {
  const start = new Date(weekKey + "T00:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return `${start.getMonth() + 1}/${start.getDate()}〜${end.getMonth() + 1}/${end.getDate()}`;
}

// points are aggregated in two seasons per year: Apr 1 - Sep 30, and Oct 1 - Mar 31
function getPeriodKey(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear();
  const m = d.getMonth() + 1; // 1-12
  if (m >= 4 && m <= 9) return `${y}-04`;
  if (m >= 10) return `${y}-10`;
  return `${y - 1}-10`; // Jan-Mar belongs to the previous October's season
}

function formatPeriodLabel(periodKey) {
  const [yStr, mStr] = periodKey.split("-");
  const y = Number(yStr);
  return mStr === "04" ? `${y}年4月〜9月` : `${y}年10月〜${y + 1}年3月`;
}

const PIE_COLORS = ["#b5432e", "#33475b", "#8a7a5c", "#c9a35a", "#6b8f71", "#8f6b8f", "#c98a6b", "#5a8fa3"];

// password-based encryption for backup files (AES-GCM, key derived via PBKDF2)
function bufToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToBuf(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
async function deriveKey(password, saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations: 150000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function encryptJSON(obj, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(obj))
  );
  return {
    encrypted: true,
    salt: bufToBase64(salt),
    iv: bufToBase64(iv),
    data: bufToBase64(ciphertext),
  };
}
async function decryptJSON(payload, password) {
  const salt = new Uint8Array(base64ToBuf(payload.salt));
  const iv = new Uint8Array(base64ToBuf(payload.iv));
  const key = await deriveKey(password, salt);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    base64ToBuf(payload.data)
  );
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

// broad archetype rock-paper-scissors: each category tends to be favored against the next
const DECK_CATEGORIES = ["アグロ", "ソリティア", "コントロール"];
const CATEGORY_ADVANTAGE = { アグロ: "ソリティア", ソリティア: "コントロール", コントロール: "アグロ" };

export default function BattleRecord() {
  const [matches, setMatches] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [opponent, setOpponent] = useState("");
  const [opponentDeck, setOpponentDeck] = useState("");
  const [myDeck, setMyDeck] = useState("");
  const [tournament, setTournament] = useState("");
  const [turnOrder, setTurnOrder] = useState(null); // "first" | "second" | null
  const [result, setResult] = useState("win");
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState("all"); // all | opponent | opponentDeck | myDeck | tournament | turnOrder
  const [filterValue, setFilterValue] = useState(null);
  const [view, setView] = useState("log"); // log | tournaments
  const [batchMode, setBatchMode] = useState(false);
  const [batchRounds, setBatchRounds] = useState(() => [makeRound()]);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState(null);
  const [tournamentPhotos, setTournamentPhotos] = useState({}); // { [tournamentKey]: [{id, dataUrl, addedAt}] }
  const [viewingPhoto, setViewingPhoto] = useState(null);
  const [photoAddLoading, setPhotoAddLoading] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [expandedMatchupKey, setExpandedMatchupKey] = useState(null);
  const [matchupSearchQuery, setMatchupSearchQuery] = useState("");
  const [selectedMatchupDeck, setSelectedMatchupDeck] = useState(null);
  const [matchDate, setMatchDate] = useState(() => todayInputValue());
  const [points, setPoints] = useState("");
  const [rank, setRank] = useState("");
  const [alwaysReflect, setAlwaysReflect] = useState(false);
  const [tournamentPoints, setTournamentPoints] = useState([]); // [{id, tournament, date, points}]
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });
  const [selectedDate, setSelectedDate] = useState(null);
  const [pieWeekOffset, setPieWeekOffset] = useState(0);
  const [deckRateWeekOffset, setDeckRateWeekOffset] = useState(0);
  const weeklyPieRef = useRef(null);
  const [searchRank, setSearchRank] = useState("");
  const [searchDeck, setSearchDeck] = useState("");
  const [searchTournamentName, setSearchTournamentName] = useState("");
  const [opponentSearchQuery, setOpponentSearchQuery] = useState("");
  const [editingTournamentDateKey, setEditingTournamentDateKey] = useState(null);
  const [tournamentDateDraft, setTournamentDateDraft] = useState("");
  const [editingTournamentPointsKey, setEditingTournamentPointsKey] = useState(null);
  const [pointsEditDraft, setPointsEditDraft] = useState("");
  const [rankEditDraft, setRankEditDraft] = useState("");
  const [alwaysReflectEditDraft, setAlwaysReflectEditDraft] = useState(false);
  const [deckProfiles, setDeckProfiles] = useState([]);
  const [deckDbOpen, setDeckDbOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState(null);
  const [profileForm, setProfileForm] = useState(false); // whether the add/edit form is open
  const [profileDeckType, setProfileDeckType] = useState("");
  const [profileFinish, setProfileFinish] = useState("");
  const [profileLink, setProfileLink] = useState("");
  const [profileIconImage, setProfileIconImage] = useState(""); // dataUrl
  const [profileCategory, setProfileCategory] = useState("");
  const [profileSimilarDecks, setProfileSimilarDecks] = useState([]);
  const [recompressLoading, setRecompressLoading] = useState(false);
  const [recompressMessage, setRecompressMessage] = useState(null);
  const [profileIconLoading, setProfileIconLoading] = useState(false);
  const [profilePhotos, setProfilePhotos] = useState([]); // dataUrls
  const [profilePhotoLoading, setProfilePhotoLoading] = useState(false);
  const [boards, setBoards] = useState([{ id: DEFAULT_BOARD_ID, name: "メイン" }]);
  const [activeBoardId, setActiveBoardId] = useState(DEFAULT_BOARD_ID);
  const [boardsLoaded, setBoardsLoaded] = useState(false);
  const [boardManage, setBoardManage] = useState(null); // board id being renamed/deleted
  const [boardRenameValue, setBoardRenameValue] = useState("");
  const [pointsBreakdownOpen, setPointsBreakdownOpen] = useState(false);
  const [links, setLinks] = useState([]);
  const [externalMetaShares, setExternalMetaShares] = useState([]);
  const [externalMatchups, setExternalMatchups] = useState([]);
  const [metaInputOpen, setMetaInputOpen] = useState(false);
  const [metaWeekOffset, setMetaWeekOffset] = useState(0);
  const [metaRows, setMetaRows] = useState([{ deckType: "", percentage: "" }]);
  const [matchupInputRows, setMatchupInputRows] = useState([
    { myDeck: "", opponentDeck: "", win: "", lose: "", draw: "" },
  ]);
  const [matchupImportError, setMatchupImportError] = useState(null);
  const [metaOcrLoading, setMetaOcrLoading] = useState(false);
  const [metaOcrError, setMetaOcrError] = useState(null);
  const [linksOpen, setLinksOpen] = useState(false);
  const [linkTitle, setLinkTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [dataManageOpen, setDataManageOpen] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [exportPinOpen, setExportPinOpen] = useState(false);
  const [exportPinDraft, setExportPinDraft] = useState("");
  const [exportPinTextMode, setExportPinTextMode] = useState(false);
  const [importPassword, setImportPassword] = useState("");
  const [pendingEncryptedImport, setPendingEncryptedImport] = useState(null);
  const [decryptLoading, setDecryptLoading] = useState(false);
  const [importMessage, setImportMessage] = useState(null);
  const [importLoading, setImportLoading] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [geminiKeyDraft, setGeminiKeyDraft] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("gemini_api_key", false);
        if (res && res.value) {
          setGeminiApiKey(res.value);
          setGeminiKeyDraft(res.value);
        }
      } catch {
        // no key saved yet
      }
    })();
  }, []);

  const saveGeminiKey = async () => {
    const key = geminiKeyDraft.trim();
    setGeminiApiKey(key);
    try {
      await window.storage.set("gemini_api_key", key, false);
      setImportMessage(key ? "Gemini APIキーを保存しました。" : "Gemini APIキーを削除しました。");
    } catch {
      setError("APIキーの保存に失敗しました。");
    }
  };

  const loadBoardData = async (boardId) => {
    setMatches(null);
    try {
      const res = await window.storage.get(keyFor(STORAGE_KEY, boardId), false);
      setMatches(res ? JSON.parse(res.value) : []);
    } catch {
      setMatches([]);
    }
    try {
      const res = await window.storage.get(keyFor(PHOTOS_KEY, boardId), false);
      setTournamentPhotos(res ? JSON.parse(res.value) : {});
    } catch {
      setTournamentPhotos({});
    }
    try {
      const res = await window.storage.get(keyFor(POINTS_KEY, boardId), false);
      setTournamentPoints(res ? JSON.parse(res.value) : []);
    } catch {
      setTournamentPoints([]);
    }
    try {
      const res = await window.storage.get(keyFor(DECK_PROFILES_KEY, boardId), false);
      setDeckProfiles(res ? JSON.parse(res.value) : []);
    } catch {
      setDeckProfiles([]);
    }
    try {
      const res = await window.storage.get(keyFor(LINKS_KEY, boardId), false);
      setLinks(res ? JSON.parse(res.value) : []);
    } catch {
      setLinks([]);
    }
    try {
      const res = await window.storage.get(keyFor(EXTERNAL_META_KEY, boardId), false);
      setExternalMetaShares(res ? JSON.parse(res.value) : []);
    } catch {
      setExternalMetaShares([]);
    }
    try {
      const res = await window.storage.get(keyFor(EXTERNAL_MATCHUPS_KEY, boardId), false);
      setExternalMatchups(res ? JSON.parse(res.value) : []);
    } catch {
      setExternalMatchups([]);
    }
  };

  const initNormalBoards = async () => {
    let meta = { boards: [{ id: DEFAULT_BOARD_ID, name: "メイン" }], activeBoardId: DEFAULT_BOARD_ID };
    try {
      const res = await window.storage.get(BOARDS_META_KEY, false);
      if (res) {
        const parsed = JSON.parse(res.value);
        if (parsed && Array.isArray(parsed.boards) && parsed.boards.length > 0) {
          meta = parsed;
        }
      }
    } catch {
      // keep default meta
    }
    setBoards(meta.boards);
    setActiveBoardId(meta.activeBoardId || meta.boards[0].id);
    setBoardsLoaded(true);
    await loadBoardData(meta.activeBoardId || meta.boards[0].id);
  };

  useEffect(() => {
    initNormalBoards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  const persistBoardsMeta = async (nextBoards, nextActiveId) => {
    try {
      await window.storage.set(
        BOARDS_META_KEY,
        JSON.stringify({ boards: nextBoards, activeBoardId: nextActiveId }),
        false
      );
    } catch {
      setError("集計画面の保存に失敗しました。もう一度お試しください。");
    }
  };

  const switchBoard = async (boardId) => {
    if (boardId === activeBoardId) return;
    setActiveBoardId(boardId);
    setFilter("all");
    setFilterValue(null);
    setSelectedDate(null);
    setCalendarOpen(false);
    setDeckDbOpen(false);
    setChatOpen(false);
    setLinksOpen(false);
    setDataManageOpen(false);
    setPointsBreakdownOpen(false);
    setShowForm(false);
    setEditingId(null);
    setChatMessages([]);
    await loadBoardData(boardId);
    persistBoardsMeta(boards, boardId);
  };

  const createBoard = async () => {
    const name = `集計画面${boards.length + 1}`;
    const id = `b_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const nextBoards = [...boards, { id, name }];
    setBoards(nextBoards);
    await switchBoard(id);
    persistBoardsMeta(nextBoards, id);
  };

  const renameBoard = (id, name) => {
    if (!name.trim()) return;
    const nextBoards = boards.map((b) => (b.id === id ? { ...b, name: name.trim() } : b));
    setBoards(nextBoards);
    persistBoardsMeta(nextBoards, activeBoardId);
    setBoardManage(null);
  };

  const deleteBoard = async (id) => {
    if (boards.length <= 1) return;
    const nextBoards = boards.filter((b) => b.id !== id);
    setBoards(nextBoards);
    setBoardManage(null);
    const nextActive = id === activeBoardId ? nextBoards[0].id : activeBoardId;
    if (id === activeBoardId) {
      setActiveBoardId(nextActive);
      await loadBoardData(nextActive);
    }
    persistBoardsMeta(nextBoards, nextActive);
    // best-effort cleanup of that board's stored data
    if (id !== DEFAULT_BOARD_ID) {
      [STORAGE_KEY, PHOTOS_KEY, POINTS_KEY, DECK_PROFILES_KEY].forEach(async (base) => {
        try {
          const res = await window.storage.get(keyFor(base, id), false);
          if (res) await window.storage.delete(keyFor(base, id), res.version);
        } catch {
          // ignore
        }
      });
    }
  };

  const persist = async (next) => {
    const prev = matches;
    setMatches(next);
    try {
      await window.storage.set(keyFor(STORAGE_KEY, activeBoardId), JSON.stringify(next), false);
    } catch {
      setMatches(prev);
      setError(
        "保存に失敗しました。端末の保存容量が上限に達している可能性があります。不要な写真を削除するか、データを書き出してから空き容量を確保してください。"
      );
    }
  };

  const persistPhotos = async (next, prevOverride) => {
    const prev = prevOverride !== undefined ? prevOverride : tournamentPhotos;
    setTournamentPhotos(next);
    try {
      await window.storage.set(keyFor(PHOTOS_KEY, activeBoardId), JSON.stringify(next), false);
    } catch {
      setTournamentPhotos(prev);
      setError(
        "写真の保存に失敗しました。端末の保存容量が上限に達している可能性があります。不要な写真を削除するか、データを書き出してから空き容量を確保してください。"
      );
    }
  };

  const savePhoto = (tKey, dataUrl) => {
    const photo = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      dataUrl,
      addedAt: new Date().toISOString(),
    };
    // functional update so back-to-back calls (e.g. adding two photos quickly) never
    // overwrite each other with a stale snapshot of tournamentPhotos
    setTournamentPhotos((prev) => {
      const next = {
        ...prev,
        [tKey]: [...(prev[tKey] || []), photo],
      };
      persistPhotos(next, prev);
      return next;
    });
  };

  const deletePhoto = (tKey, id) => {
    setTournamentPhotos((prev) => {
      const next = {
        ...prev,
        [tKey]: (prev[tKey] || []).filter((p) => p.id !== id),
      };
      persistPhotos(next, prev);
      return next;
    });
  };

  const persistPoints = async (next) => {
    const prev = tournamentPoints;
    setTournamentPoints(next);
    try {
      await window.storage.set(keyFor(POINTS_KEY, activeBoardId), JSON.stringify(next), false);
    } catch {
      setTournamentPoints(prev);
      setError(
        "ポイントの保存に失敗しました。端末の保存容量が上限に達している可能性があります。不要な写真を削除するか、データを書き出してから空き容量を確保してください。"
      );
    }
  };

  const savePoints = (tournamentName, dateStr, pts, rank, deck, alwaysReflectFlag) => {
    const hasPoints = pts !== "" && !Number.isNaN(Number(pts));
    const hasRank = rank !== "" && rank != null && !Number.isNaN(Number(rank));
    if (!tournamentName || (!hasPoints && !hasRank)) return;
    const existingIdx = tournamentPoints.findIndex(
      (p) => p.tournament === tournamentName && p.date === dateStr
    );
    const entry = {
      id:
        existingIdx >= 0
          ? tournamentPoints[existingIdx].id
          : `pt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tournament: tournamentName,
      date: dateStr,
      points: hasPoints ? Number(pts) : existingIdx >= 0 ? tournamentPoints[existingIdx].points : 0,
      rank: hasRank ? Number(rank) : existingIdx >= 0 ? tournamentPoints[existingIdx].rank : null,
      deck: (deck || "").trim() || (existingIdx >= 0 ? tournamentPoints[existingIdx].deck : ""),
      alwaysReflect: !!alwaysReflectFlag,
    };
    const next =
      existingIdx >= 0
        ? tournamentPoints.map((p, i) => (i === existingIdx ? entry : p))
        : [...tournamentPoints, entry];
    persistPoints(next);
  };

  const deletePoints = (id) => {
    persistPoints(tournamentPoints.filter((p) => p.id !== id));
  };

  const resizeImage = (file, maxDim = 1100, quality = 0.72) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          resolve(drawToCompressedDataUrl(img, maxDim, quality));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  // re-encodes an already-stored data URL at a smaller size/quality, used to shrink
  // photos that were saved before compression was tightened, or to reclaim space on demand
  const recompressDataUrl = (dataUrl, maxDim = 1000, quality = 0.68) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(drawToCompressedDataUrl(img, maxDim, quality));
      img.onerror = reject;
      img.src = dataUrl;
    });

  const persistProfiles = async (next) => {
    const prev = deckProfiles;
    setDeckProfiles(next);
    try {
      await window.storage.set(keyFor(DECK_PROFILES_KEY, activeBoardId), JSON.stringify(next), false);
    } catch {
      setDeckProfiles(prev);
      setError(
        "デッキ図鑑の保存に失敗しました。端末の保存容量が上限に達している可能性があります。不要な写真を削除するか、データを書き出してから空き容量を確保してください。"
      );
    }
  };

  // when a match is recorded with an opponent deck type that isn't in the compendium yet,
  // add a minimal entry automatically so it shows up ready to fill in later
  const ensureDeckProfilesExist = (deckTypeNames) => {
    const existing = new Set(
      deckProfiles.map((p) => (p.deckType || "").trim()).filter(Boolean)
    );
    const newOnes = [
      ...new Set(deckTypeNames.map((n) => (n || "").trim()).filter(Boolean)),
    ].filter((n) => !existing.has(n));
    if (newOnes.length === 0) return;
    const newProfiles = newOnes.map((n) => ({
      id: `dp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      deckType: n,
      finish: "",
      icon: "",
      category: "",
      link: "",
      photos: [],
    }));
    persistProfiles([...newProfiles, ...deckProfiles]);
  };

  const openProfileForm = (profile) => {
    if (profile) {
      setEditingProfileId(profile.id);
      setProfileDeckType(profile.deckType || "");
      setProfileFinish(profile.finish || "");
      setProfileIconImage(profile.icon || "");
      setProfileCategory(profile.category || "");
      setProfileSimilarDecks(profile.similarDecks || []);
      setProfilePhotos(profile.photos || []);
    } else {
      setEditingProfileId(null);
      setProfileDeckType("");
      setProfileFinish("");
      setProfileIconImage("");
      setProfileCategory("");
      setProfileSimilarDecks([]);
      setProfilePhotos([]);
    }
    setProfileForm(true);
  };

  const closeProfileForm = () => {
    setProfileForm(false);
    setEditingProfileId(null);
  };

  const toggleProfileSimilarDeck = (deckName) => {
    setProfileSimilarDecks((prev) =>
      prev.includes(deckName) ? prev.filter((d) => d !== deckName) : [...prev, deckName]
    );
  };

  const handleProfileIconUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setProfileIconLoading(true);
    try {
      const dataUrl = await resizeImage(file, 200, 0.85);
      setProfileIconImage(dataUrl);
    } catch {
      setError("アイコン画像の読み込みに失敗しました。もう一度お試しください。");
    } finally {
      setProfileIconLoading(false);
    }
  };

  const saveProfile = () => {
    if (!profileDeckType.trim()) return;
    if (editingProfileId) {
      persistProfiles(
        deckProfiles.map((p) =>
          p.id === editingProfileId
            ? {
                ...p,
                deckType: profileDeckType.trim(),
                finish: profileFinish.trim(),
                icon: profileIconImage,
                category: profileCategory,
                similarDecks: profileSimilarDecks,
                photos: profilePhotos,
              }
            : p
        )
      );
    } else {
      persistProfiles([
        {
          id: `dp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          deckType: profileDeckType.trim(),
          finish: profileFinish.trim(),
          icon: profileIconImage,
          category: profileCategory,
          similarDecks: profileSimilarDecks,
          photos: profilePhotos,
        },
        ...deckProfiles,
      ]);
    }
    closeProfileForm();
  };

  const deleteProfile = (id) => {
    persistProfiles(deckProfiles.filter((p) => p.id !== id));
  };

  const recompressAllPhotos = async () => {
    setRecompressLoading(true);
    setRecompressMessage(null);
    try {
      const nextTournamentPhotos = {};
      for (const [key, photos] of Object.entries(tournamentPhotos)) {
        nextTournamentPhotos[key] = await Promise.all(
          photos.map(async (p) => {
            try {
              return { ...p, dataUrl: await recompressDataUrl(p.dataUrl) };
            } catch {
              return p; // keep the original if this particular photo fails to re-encode
            }
          })
        );
      }
      await persistPhotos(nextTournamentPhotos, tournamentPhotos);

      const nextProfiles = await Promise.all(
        deckProfiles.map(async (p) => {
          if (!p.photos || p.photos.length === 0) return p;
          const photos = await Promise.all(
            p.photos.map(async (ph) => {
              try {
                return { ...ph, dataUrl: await recompressDataUrl(ph.dataUrl) };
              } catch {
                return ph;
              }
            })
          );
          return { ...p, photos };
        })
      );
      await persistProfiles(nextProfiles);

      setRecompressMessage("写真を圧縮しました。");
    } catch {
      setError("圧縮中にエラーが発生しました。もう一度お試しください。");
    } finally {
      setRecompressLoading(false);
    }
  };

  const persistLinks = async (next) => {
    const prev = links;
    setLinks(next);
    try {
      await window.storage.set(keyFor(LINKS_KEY, activeBoardId), JSON.stringify(next), false);
    } catch {
      setLinks(prev);
      setError(
        "リンクの保存に失敗しました。端末の保存容量が上限に達している可能性があります。不要な写真を削除するか、データを書き出してから空き容量を確保してください。"
      );
    }
  };

  const addLink = () => {
    if (!linkUrl.trim()) return;
    let url = linkUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const entry = {
      id: `lk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: linkTitle.trim() || url,
      url,
    };
    persistLinks([entry, ...links]);
    setLinkTitle("");
    setLinkUrl("");
  };

  const deleteLink = (id) => {
    persistLinks(links.filter((l) => l.id !== id));
  };

  const persistExternalMeta = async (next) => {
    const prev = externalMetaShares;
    setExternalMetaShares(next);
    try {
      await window.storage.set(
        keyFor(EXTERNAL_META_KEY, activeBoardId),
        JSON.stringify(next),
        false
      );
    } catch {
      setExternalMetaShares(prev);
      setError(
        "メタデータの保存に失敗しました。端末の保存容量が上限に達している可能性があります。不要な写真を削除するか、データを書き出してから空き容量を確保してください。"
      );
    }
  };

  const persistExternalMatchups = async (next) => {
    const prev = externalMatchups;
    setExternalMatchups(next);
    try {
      await window.storage.set(
        keyFor(EXTERNAL_MATCHUPS_KEY, activeBoardId),
        JSON.stringify(next),
        false
      );
    } catch {
      setExternalMatchups(prev);
      setError(
        "デッキ相性データの保存に失敗しました。端末の保存容量が上限に達している可能性があります。不要な写真を削除するか、データを書き出してから空き容量を確保してください。"
      );
    }
  };

  const metaWeekKey = useMemo(() => {
    const base = new Date();
    base.setDate(base.getDate() + metaWeekOffset * 7);
    return toDateInputValue(getWeekStart(base).toISOString());
  }, [metaWeekOffset]);

  useEffect(() => {
    if (!metaInputOpen) return;
    const existing = externalMetaShares.filter((e) => e.weekKey === metaWeekKey);
    setMetaRows(
      existing.length > 0
        ? existing.map((e) => ({ deckType: e.deckType, percentage: String(e.percentage) }))
        : [{ deckType: "", percentage: "" }]
    );
    setMetaOcrError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaWeekKey, metaInputOpen]);

  const updateMetaRow = (idx, patch) => {
    setMetaRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addMetaRow = () => setMetaRows((rows) => [...rows, { deckType: "", percentage: "" }]);

  const removeMetaRow = (idx) => {
    setMetaRows((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== idx) : rows));
  };

  const saveMetaRows = () => {
    const cleanRows = metaRows
      .map((r) => ({ deckType: r.deckType.trim(), percentage: Number(r.percentage) }))
      .filter((r) => r.deckType && !Number.isNaN(r.percentage) && r.percentage > 0);
    const others = externalMetaShares.filter((e) => e.weekKey !== metaWeekKey);
    const entries = cleanRows.map((r) => ({
      id: `em_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      weekKey: metaWeekKey,
      deckType: r.deckType,
      percentage: r.percentage,
    }));
    persistExternalMeta([...others, ...entries]);
    ensureDeckProfilesExist(cleanRows.map((r) => r.deckType));
  };

  const handleMetaImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (!geminiApiKey) {
      setMetaOcrError("Gemini APIキーが未設定です。データ管理画面で登録してください。");
      return;
    }
    setMetaOcrLoading(true);
    setMetaOcrError(null);
    try {
      const dataUrl = await resizeImage(file);
      const base64 = dataUrl.split(",")[1];
      const textBlock = await callGeminiVision(
        geminiApiKey,
        base64,
        "image/jpeg",
        "この画像はカードゲーム大会のデッキ使用率を示す円グラフ、または割合の一覧表です。読み取れるデッキタイプ名とその使用割合(%)を抽出してください。\n" +
          "出力は必ず次の形式のJSON配列のみとし、説明文やコードブロック記号（```）は一切付けないでください。\n" +
          '[{"deckType": "デッキタイプ名", "percentage": 数値（%は付けない）}]\n' +
          "読み取れない場合は空配列 [] を返してください。",
        800
      );
      const clean = textBlock.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        setMetaOcrError("使用率を読み取れませんでした。手動で入力してください。");
        return;
      }
      const newRows = parsed
        .filter((p) => p && typeof p.deckType === "string" && !Number.isNaN(Number(p.percentage)))
        .map((p) => ({ deckType: p.deckType.trim(), percentage: String(Number(p.percentage)) }));
      if (newRows.length === 0) {
        setMetaOcrError("使用率を読み取れませんでした。手動で入力してください。");
        return;
      }
      setMetaRows(newRows);
    } catch (err) {
      setMetaOcrError(
        `画像の読み取りに失敗しました：${err?.message || "原因不明のエラー"}`
      );
    } finally {
      setMetaOcrLoading(false);
    }
  };

  const handleMetaCSVUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setMetaOcrError(null);
    try {
      const text = await file.text();
      const rows = parseCSV(text).filter((r) => r.length >= 2);
      const startIdx = rows.length > 0 && Number.isNaN(Number(rows[0][1])) ? 1 : 0;
      const newRows = rows
        .slice(startIdx)
        .map((r) => {
          const deckType = (r[0] || "").trim();
          const percentage = r.length >= 3 ? Number(r[2]) : Number(r[1]);
          return { deckType, percentage: String(percentage) };
        })
        .filter((r) => r.deckType && !Number.isNaN(Number(r.percentage)));
      if (newRows.length === 0) {
        setMetaOcrError("CSVから有効なデータを読み取れませんでした。");
        return;
      }
      setMetaRows(newRows);
    } catch {
      setMetaOcrError("CSVの読み込みに失敗しました。");
    }
  };

  const downloadOpponentPieCSV = () => {
    const rows = weeklyOpponentDeckPie.map((d) => [d.name, d.value, d.percentage.toFixed(1)]);
    const csv = toCSV(["デッキタイプ", "対戦数", "割合(%)"], rows);
    downloadTextFile(
      csv,
      `週間対戦相手デッキ内訳_${toDateInputValue(pieWeekRange.start.toISOString())}.csv`
    );
  };

  const updateMatchupInputRow = (idx, patch) => {
    setMatchupInputRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addMatchupInputRow = () =>
    setMatchupInputRows((rows) => [
      ...rows,
      { myDeck: "", opponentDeck: "", win: "", lose: "", draw: "" },
    ]);

  const removeMatchupInputRow = (idx) => {
    setMatchupInputRows((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== idx) : rows));
  };

  const saveMatchupInputRows = () => {
    const clean = matchupInputRows
      .map((r) => ({
        myDeck: r.myDeck.trim(),
        opponentDeck: r.opponentDeck.trim(),
        win: Number(r.win) || 0,
        lose: Number(r.lose) || 0,
        draw: Number(r.draw) || 0,
      }))
      .filter((r) => r.myDeck && r.opponentDeck && r.win + r.lose + r.draw > 0);
    if (clean.length === 0) return;
    const entries = clean.map((r) => ({
      id: `xm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      ...r,
    }));
    persistExternalMatchups([...externalMatchups, ...entries]);
    ensureDeckProfilesExist(clean.flatMap((r) => [r.myDeck, r.opponentDeck]));
    setMatchupInputRows([{ myDeck: "", opponentDeck: "", win: "", lose: "", draw: "" }]);
  };

  const handleMatchupCSVUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setMatchupImportError(null);
    try {
      const text = await file.text();
      const rows = parseCSV(text).filter((r) => r.length >= 4);
      const startIdx = rows.length > 0 && Number.isNaN(Number(rows[0][2])) ? 1 : 0;
      const entries = rows
        .slice(startIdx)
        .map((r) => ({
          id: `xm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          myDeck: (r[0] || "").trim(),
          opponentDeck: (r[1] || "").trim(),
          win: Number(r[2]) || 0,
          lose: Number(r[3]) || 0,
          draw: Number(r[4]) || 0,
        }))
        .filter((r) => r.myDeck && r.opponentDeck && r.win + r.lose + r.draw > 0);
      if (entries.length === 0) {
        setMatchupImportError("CSVから有効なデータを読み取れませんでした。");
        return;
      }
      persistExternalMatchups([...externalMatchups, ...entries]);
      ensureDeckProfilesExist(entries.flatMap((r) => [r.myDeck, r.opponentDeck]));
    } catch {
      setMatchupImportError("CSVの読み込みに失敗しました。");
    }
  };

  const downloadMatchupCSV = () => {
    const rows = [];
    matchupAnalysis.forEach((deck) => {
      deck.rows.forEach((row) => {
        rows.push([deck.myDeck, row.opponentDeck, row.win, row.lose, row.draw, row.rate.toFixed(1)]);
      });
    });
    const csv = toCSV(
      ["自分のデッキ", "相手のデッキ", "勝ち", "負け", "分け", "勝率(%)"],
      rows
    );
    downloadTextFile(csv, `デッキ相性_${todayInputValue()}.csv`);
  };

  const openExportPin = () => {
    setExportPinDraft(exportPassword);
    setExportPinTextMode(false);
    setExportPinOpen(true);
  };

  const confirmExportPin = (value) => {
    setExportPassword(value !== undefined ? value : exportPinDraft);
    setExportPinOpen(false);
  };

  const clearExportPassword = () => {
    setExportPassword("");
    setExportPinDraft("");
  };

  const exportBoardData = async () => {
    try {
      const boardName = boards.find((b) => b.id === activeBoardId)?.name || "board";
      const payload = {
        exportedAt: new Date().toISOString(),
        boardName,
        matches,
        tournamentPhotos,
        tournamentPoints,
        deckProfiles,
        links,
        externalMetaShares,
        externalMatchups,
      };
      const finalPayload = exportPassword.trim()
        ? await encryptJSON(payload, exportPassword.trim())
        : payload;
      const blob = new Blob([JSON.stringify(finalPayload, null, 2)], {
        type: "application/json",
      });
      const link = document.createElement("a");
      link.download = `戦績帳_${boardName}_${todayInputValue()}${
        exportPassword.trim() ? "_暗号化" : ""
      }.json`;
      link.href = URL.createObjectURL(blob);
      link.click();
    } catch {
      setError("データの書き出しに失敗しました。");
    }
  };

  const applyImportedData = async (data) => {
    if (Array.isArray(data.matches)) await persist(data.matches);
    if (data.tournamentPhotos && typeof data.tournamentPhotos === "object") {
      await persistPhotos(data.tournamentPhotos);
    }
    if (Array.isArray(data.tournamentPoints)) await persistPoints(data.tournamentPoints);
    if (Array.isArray(data.deckProfiles)) await persistProfiles(data.deckProfiles);
    if (Array.isArray(data.links)) await persistLinks(data.links);
    if (Array.isArray(data.externalMetaShares)) {
      await persistExternalMeta(data.externalMetaShares);
    }
    if (Array.isArray(data.externalMatchups)) {
      await persistExternalMatchups(data.externalMatchups);
    }
    setImportMessage("読み込みが完了しました。");
  };

  const importBoardData = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportMessage(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data && data.encrypted) {
        setPendingEncryptedImport(data);
        return;
      }
      await applyImportedData(data);
    } catch {
      setError("ファイルの読み込みに失敗しました。書き出したJSONファイルを選択してください。");
    }
  };

  const decryptAndImport = async () => {
    if (!pendingEncryptedImport || !importPassword.trim()) return;
    setDecryptLoading(true);
    try {
      const data = await decryptJSON(pendingEncryptedImport, importPassword.trim());
      await applyImportedData(data);
      setPendingEncryptedImport(null);
      setImportPassword("");
    } catch {
      setError("パスワードが違うか、ファイルを復号できませんでした。");
    } finally {
      setDecryptLoading(false);
    }
  };

  const handleProfilePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setProfilePhotoLoading(true);
    try {
      const dataUrl = await resizeImage(file);
      setProfilePhotos((prev) => [
        ...prev,
        { id: `pp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, dataUrl },
      ]);
    } catch {
      setError("写真の読み込みに失敗しました。もう一度お試しください。");
    } finally {
      setProfilePhotoLoading(false);
    }
  };

  const removeProfilePhoto = (id) => {
    setProfilePhotos((prev) => prev.filter((p) => p.id !== id));
  };

  const downloadChartAsImage = (containerEl, filename) => {
    try {
      const svg = containerEl?.querySelector("svg");
      if (!svg) {
        setError("グラフの画像化に失敗しました。");
        return;
      }
      const bbox = svg.getBoundingClientRect();
      const svgClone = svg.cloneNode(true);
      svgClone.setAttribute("width", bbox.width);
      svgClone.setAttribute("height", bbox.height);
      const svgData = new XMLSerializer().serializeToString(svgClone);
      const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        // higher scale keeps small pie-slice labels legible even when zoomed in or
        // re-read by this tool's image-upload OCR features later
        const scale = 4;
        const canvas = document.createElement("canvas");
        canvas.width = bbox.width * scale;
        canvas.height = bbox.height * scale;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fdfaf4";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, bbox.width, bbox.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => {
          if (!blob) return;
          const link = document.createElement("a");
          link.download = filename;
          link.href = URL.createObjectURL(blob);
          link.click();
        }, "image/png");
      };
      img.onerror = () => setError("グラフの画像化に失敗しました。");
      img.src = url;
    } catch {
      setError("グラフの画像化に失敗しました。");
    }
  };

  const addMatch = () => {
    const dateBase = new Date(matchDate + "T12:00:00").getTime() || Date.now();
    if (editingId) {
      const updated = matches.map((m) =>
        m.id === editingId
          ? {
              ...m,
              opponent: opponent.trim(),
              opponentDeck: opponentDeck.trim(),
              myDeck: myDeck.trim(),
              tournament: tournament.trim(),
              turnOrder,
              result,
              note: note.trim(),
              date: new Date(dateBase).toISOString(),
            }
          : m
      );
      persist(updated);
      if (tournament.trim())
        savePoints(tournament.trim(), matchDate, points, rank, myDeck, alwaysReflect);
      if (opponentDeck.trim()) ensureDeckProfilesExist([opponentDeck]);
      setEditingId(null);
      setOpponent("");
      setOpponentDeck("");
      setMyDeck("");
      setNote("");
      setResult("win");
      setTurnOrder(null);
      setPoints("");
      setRank("");
      setAlwaysReflect(false);
      setShowForm(false);
      return;
    }
    const entry = {
      id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      opponent: opponent.trim(),
      opponentDeck: opponentDeck.trim(),
      myDeck: myDeck.trim(),
      tournament: tournament.trim(),
      turnOrder,
      result,
      note: note.trim(),
      date: new Date(dateBase).toISOString(),
    };
    persist([entry, ...matches]);
    if (tournament.trim())
      savePoints(tournament.trim(), matchDate, points, rank, myDeck, alwaysReflect);
    if (opponentDeck.trim()) ensureDeckProfilesExist([opponentDeck]);
    setOpponent("");
    setOpponentDeck("");
    setMyDeck("");
    setNote("");
    setResult("win");
    setTurnOrder(null);
    setPoints("");
    setRank("");
    setAlwaysReflect(false);
    setShowForm(false);
  };

  const openEdit = (m) => {
    setEditingId(m.id);
    setOpponent(m.opponent || "");
    setOpponentDeck(m.opponentDeck || "");
    setMyDeck(m.myDeck || "");
    setTournament(m.tournament || "");
    setTurnOrder(m.turnOrder || null);
    setResult(m.result || "win");
    setNote(m.note || "");
    setMatchDate(toDateInputValue(m.date));
    const existingPts = tournamentPoints.find(
      (p) => p.tournament === (m.tournament || "") && p.date === toDateInputValue(m.date)
    );
    setPoints(existingPts ? String(existingPts.points) : "");
    setRank(existingPts && existingPts.rank != null ? String(existingPts.rank) : "");
    setAlwaysReflect(existingPts ? !!existingPts.alwaysReflect : false);
    setBatchMode(false);
    setShowForm(true);
  };

  const openAddToTournament = (row) => {
    setEditingId(null);
    setOpponent("");
    setOpponentDeck("");
    setMyDeck("");
    setNote("");
    setResult("win");
    setTurnOrder(null);
    setTournament(row.name);
    setMatchDate(row.date);
    const existingPts = tournamentPoints.find(
      (p) => p.tournament === row.name && p.date === row.date
    );
    setPoints(existingPts ? String(existingPts.points) : "");
    setRank(existingPts && existingPts.rank != null ? String(existingPts.rank) : "");
    setAlwaysReflect(existingPts ? !!existingPts.alwaysReflect : false);
    setBatchMode(false);
    setShowForm(true);
  };

  // moves every match, the points/rank entry, and the saved photos of one tournament
  // session (same name + same original date) to a new date, all at once
  const changeTournamentDate = (row, newDateStr) => {
    if (!newDateStr || newDateStr === row.date) return;
    const oldKey = row.key;
    const newKey = tournamentSessionKey(row.name, newDateStr);
    const baseTime = new Date(newDateStr + "T12:00:00").getTime();

    const sessionMatches = matches.filter(
      (m) => tournamentSessionKey(m.tournament, toDateInputValue(m.date)) === oldKey
    );
    const sorted = [...sessionMatches].sort((a, b) => new Date(a.date) - new Date(b.date));
    const idToNewDate = {};
    sorted.forEach((m, i) => {
      idToNewDate[m.id] = new Date(baseTime + i * 1000).toISOString();
    });
    const nextMatches = matches.map((m) =>
      idToNewDate[m.id] ? { ...m, date: idToNewDate[m.id] } : m
    );
    persist(nextMatches);

    const nextPoints = tournamentPoints.map((p) =>
      p.tournament === row.name && p.date === row.date ? { ...p, date: newDateStr } : p
    );
    persistPoints(nextPoints);

    if (tournamentPhotos[oldKey]) {
      const nextPhotos = { ...tournamentPhotos };
      nextPhotos[newKey] = [...(nextPhotos[newKey] || []), ...nextPhotos[oldKey]];
      delete nextPhotos[oldKey];
      persistPhotos(nextPhotos);
    }

    setFilterValue(newKey);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
  };

  const deleteMatch = (id) => {
    persist(matches.filter((m) => m.id !== id));
    setConfirmDeleteId(null);
  };

  const updateRound = (id, patch) => {
    setBatchRounds((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const addRound = () => setBatchRounds((rs) => [...rs, makeRound()]);

  const removeRound = (id) => {
    setBatchRounds((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== id) : rs));
  };

  const submitBatch = () => {
    const dateBase = new Date(matchDate + "T12:00:00").getTime() || Date.now();
    const entries = batchRounds.map((r, i) => ({
      id: `m_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`,
      opponent: r.opponent.trim(),
      opponentDeck: r.opponentDeck.trim(),
      myDeck: myDeck.trim(),
      tournament: tournament.trim(),
      turnOrder: r.turnOrder,
      result: r.result,
      note: "",
      date: new Date(dateBase + i * 1000).toISOString(),
    }));
    // newest round first, matching how single entries are prepended
    persist([...entries.slice().reverse(), ...matches]);
    if (tournament.trim())
      savePoints(tournament.trim(), matchDate, points, rank, myDeck, alwaysReflect);
    ensureDeckProfilesExist(batchRounds.map((r) => r.opponentDeck));
    setBatchRounds([makeRound()]);
    setMyDeck("");
    setPoints("");
    setRank("");
    setAlwaysReflect(false);
    setShowForm(false);
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setOcrLoading(true);
    setOcrError(null);
    try {
      const dataUrl = await resizeImage(file);
      const base64 = dataUrl.split(",")[1];

      // 振り返り用に、この大会の記録として写真を保存
      const tKey = tournament.trim() || UNASSIGNED;
      savePhoto(tKey, dataUrl);

      if (!geminiApiKey) {
        setOcrError(
          "Gemini APIキーが未設定のため、デッキタイプの自動判定はスキップしました（写真は保存済みです）。データ管理画面でキーを登録してください。"
        );
        return;
      }

      const textBlock = await callGeminiVision(
        geminiApiKey,
        base64,
        "image/jpeg",
        "この画像はカードゲームのデッキ（カード一覧、デッキリスト、デッキの写真など）です。写っているカードの傾向から、このデッキのタイプ・アーキタイプ名を判定してください。\n" +
          "出力は必ず次の形式のJSONのみとし、説明文やコードブロック記号（```）は一切付けないでください。\n" +
          '{"deckName": "デッキタイプ名（判定できない場合は空文字）"}',
        300
      );
      const clean = textBlock.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      const deckName = typeof parsed.deckName === "string" ? parsed.deckName.trim() : "";

      if (!deckName) {
        setOcrError("デッキタイプは読み取れませんでしたが、写真はこの大会の記録として保存しました。");
        return;
      }

      setMyDeck(deckName);
    } catch (err) {
      setOcrError(`画像の読み取りに失敗しました：${err?.message || "原因不明のエラー"}`);
    } finally {
      setOcrLoading(false);
    }
  };

  const handleAddPhotoToTournament = async (e, tKey) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setPhotoAddLoading(true);
    try {
      const dataUrl = await resizeImage(file);
      savePhoto(tKey, dataUrl);
    } catch {
      setError("写真の読み込みに失敗しました。もう一度お試しください。");
    } finally {
      setPhotoAddLoading(false);
    }
  };

  const filtered = useMemo(() => {
    if (!matches) return [];
    if (filter === "opponent" && filterValue)
      return matches.filter((m) => m.opponent === filterValue);
    if (filter === "opponentDeck" && filterValue)
      return matches.filter((m) => m.opponentDeck === filterValue);
    if (filter === "myDeck" && filterValue)
      return matches.filter((m) => m.myDeck === filterValue);
    if (filter === "tournament" && filterValue)
      return matches.filter(
        (m) => tournamentSessionKey(m.tournament, toDateInputValue(m.date)) === filterValue
      );
    if (filter === "turnOrder" && filterValue)
      return matches.filter((m) => m.turnOrder === filterValue);
    return matches;
  }, [matches, filter, filterValue]);

  const searchedMatches = useMemo(() => {
    const q = opponentSearchQuery.trim();
    if (!q) return filtered;
    return filtered.filter((m) => (m.opponent || "").includes(q));
  }, [filtered, opponentSearchQuery]);

  // matches grouped by local calendar date (YYYY-MM-DD)
  const matchesByDate = useMemo(() => {
    const map = {};
    (matches || []).forEach((m) => {
      const k = toDateInputValue(m.date);
      if (!map[k]) map[k] = [];
      map[k].push(m);
    });
    return map;
  }, [matches]);

  const pointsByDate = useMemo(() => {
    const map = {};
    tournamentPoints.forEach((p) => {
      map[p.date] = (map[p.date] || 0) + (p.points || 0);
    });
    return map;
  }, [tournamentPoints]);

  const calendarDays = useMemo(() => {
    const first = new Date(calendarMonth);
    first.setDate(1);
    const startOffset = first.getDay(); // 0=Sun
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - startOffset);

    const days = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      const key = toDateInputValue(d.toISOString());
      const dayMatches = matchesByDate[key] || [];
      days.push({
        date: d,
        key,
        inMonth: d.getMonth() === calendarMonth.getMonth(),
        isToday: key === todayInputValue(),
        stats: calcRecord(dayMatches),
        points: pointsByDate[key] || 0,
      });
    }
    return days;
  }, [calendarMonth, matchesByDate, pointsByDate]);

  const selectedDateMatches = useMemo(() => {
    if (!selectedDate) return [];
    return matchesByDate[selectedDate] || [];
  }, [selectedDate, matchesByDate]);

  const selectedDatePoints = useMemo(() => {
    if (!selectedDate) return [];
    return tournamentPoints.filter((p) => p.date === selectedDate);
  }, [selectedDate, tournamentPoints]);

  const stats = useMemo(() => {
    const calc = calcRecord;
    const overall = calc(matches || []);

    const groupBy = (key) => {
      const map = {};
      (matches || []).forEach((m) => {
        const k = m[key]?.trim();
        if (!k) return;
        if (!map[k]) map[k] = [];
        map[k].push(m);
      });
      return Object.entries(map)
        .map(([name, list]) => ({ name, ...calc(list) }))
        .sort((a, b) => b.total - a.total);
    };

    const byTournament = (() => {
      const map = {};
      (matches || []).forEach((m) => {
        const name = (m.tournament || "").trim() || UNASSIGNED;
        const date = toDateInputValue(m.date);
        const key = tournamentSessionKey(name, date);
        if (!map[key]) map[key] = { name, date, list: [] };
        map[key].list.push(m);
      });
      return Object.entries(map)
        .map(([key, { name, date, list }]) => ({
          key,
          name,
          date,
          ...calc(list),
        }))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    })();

    const byTurnOrder = ["first", "second"]
      .map((key) => {
        const list = (matches || []).filter((m) => m.turnOrder === key);
        return { name: TURN_ORDERS[key].label, key, ...calc(list) };
      })
      .filter((row) => row.total > 0);

    return {
      overall,
      byOpponent: groupBy("opponent"),
      byOpponentDeck: groupBy("opponentDeck"),
      byMyDeck: groupBy("myDeck"),
      byTournament,
      byTurnOrder,
      filteredCalc: calc(filtered),
    };
  }, [matches, filtered]);

  // deck-type win rate regardless of who piloted it: combines matches where I
  // played the deck with matches where the opponent played it (inverted)
  const deckRateWeekRange = useMemo(() => {
    const base = new Date();
    base.setDate(base.getDate() + deckRateWeekOffset * 7);
    const start = getWeekStart(base);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }, [deckRateWeekOffset]);

  const unifiedDeckWinRates = useMemo(() => {
    const { start, end } = deckRateWeekRange;
    const weekMatches = (matches || []).filter((m) => {
      const t = new Date(m.date).getTime();
      return t >= start.getTime() && t <= end.getTime();
    });
    const byDeck = {};
    weekMatches.forEach((m) => {
      const my = (m.myDeck || "").trim();
      const opp = (m.opponentDeck || "").trim();
      if (my) {
        if (!byDeck[my]) byDeck[my] = { win: 0, lose: 0, draw: 0 };
        if (m.result === "win") byDeck[my].win++;
        else if (m.result === "lose") byDeck[my].lose++;
        else if (m.result === "draw") byDeck[my].draw++;
      }
      if (opp) {
        if (!byDeck[opp]) byDeck[opp] = { win: 0, lose: 0, draw: 0 };
        // from the opponent deck's own perspective: my loss is its win
        if (m.result === "lose") byDeck[opp].win++;
        else if (m.result === "win") byDeck[opp].lose++;
        else if (m.result === "draw") byDeck[opp].draw++;
      }
    });
    return Object.entries(byDeck)
      .map(([name, { win, lose, draw }]) => {
        const decisive = win + lose;
        return {
          name,
          win,
          lose,
          draw,
          total: win + lose + draw,
          rate: decisive > 0 ? (win / decisive) * 100 : 0,
        };
      })
      .filter((d) => d.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [matches, deckRateWeekRange]);

  // deck-vs-deck matchup analysis: for each of my decks, win rate against each opponent deck
  // deck-vs-deck matchup analysis: A-vs-B and B-vs-A results are merged into a single
  // matchup record (an opponent's win with deck B against my deck A is the same data point
  // as A losing to B), so the archetype matchup is learned regardless of which side recorded it
  // shown in the デッキ相性 tab, CSV export, and row-edit expansion: only actual recorded
  // matches count here, per the user's request that this display reflect their own results
  const matchupAnalysis = useMemo(() => {
    return finalizeMatchupPairMap(buildMatchupPairMap(matches));
  }, [matches]);

  // used only for the recommendation engine, where externally imported matchup data is
  // still allowed to inform predictions even though it's excluded from the display above
  const matchupAnalysisForPrediction = useMemo(() => {
    const pairMap = buildMatchupPairMap(matches);
    addExternalMatchupsToPairMap(pairMap, externalMatchups);
    return finalizeMatchupPairMap(pairMap);
  }, [matches, externalMatchups]);

  // matchupAnalysis narrowed by the deck-name search box: a deck card is kept if its own
  // name matches (showing all its rows), or if only some of its opponent rows match
  // (showing just those rows)
  const filteredMatchupAnalysis = useMemo(() => {
    const q = matchupSearchQuery.trim();
    if (!q) return matchupAnalysis;
    return matchupAnalysis
      .map((deck) => {
        if (deck.myDeck.includes(q)) return deck;
        const rows = deck.rows.filter((r) => r.opponentDeck.includes(q));
        return rows.length > 0 ? { ...deck, rows } : null;
      })
      .filter(Boolean);
  }, [matchupAnalysis, matchupSearchQuery]);

  // period points: top 2 tournament results per period count toward the total; the rest are shown separately.
  // also tracks weekly breakdown within the period, and promo counts (winner promo for 1st place,
  // best-8 promo for 121pt+ finishes placing 8th or better)
  const periodPoints = useMemo(() => {
    const byPeriod = {};
    tournamentPoints.forEach((p) => {
      const pk = getPeriodKey(p.date);
      if (!byPeriod[pk]) byPeriod[pk] = [];
      byPeriod[pk].push(p);
    });
    return Object.entries(byPeriod)
      .map(([periodKey, entries]) => {
        const byWeek = {};
        entries.forEach((e) => {
          const wk = getWeekKey(e.date);
          if (!byWeek[wk]) byWeek[wk] = [];
          byWeek[wk].push(e);
        });

        let periodReflected = 0;
        let periodExcluded = 0;

        const weeks = Object.entries(byWeek)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([weekKey, weekEntries], idx) => {
            // entries checked "always reflect" count toward the total unconditionally and
            // don't take up one of the 2 weekly slots; the remaining entries in that week
            // still compete for the top-2-by-points slots as before
            const forced = weekEntries.filter((e) => e.alwaysReflect);
            const normal = weekEntries.filter((e) => !e.alwaysReflect);
            const sortedNormal = [...normal].sort((a, b) => b.points - a.points);
            const top2Normal = sortedNormal.slice(0, 2);
            const reflectedIds = new Set([...forced, ...top2Normal].map((e) => e.id));

            weekEntries.forEach((e) => {
              if (reflectedIds.has(e.id)) periodReflected += e.points;
              else periodExcluded += e.points;
            });

            const sortedByDate = [...weekEntries].sort(
              (a, b) => new Date(a.date) - new Date(b.date)
            );
            return {
              weekIndex: idx + 1,
              weekKey,
              reflectedPoints: sortedByDate
                .filter((e) => reflectedIds.has(e.id))
                .map((e) => e.points),
              excludedPoints: sortedByDate
                .filter((e) => !reflectedIds.has(e.id))
                .map((e) => e.points),
            };
          });

        let winnerPromo = 0;
        let best8Promo = 0;
        entries.forEach((e) => {
          if (e.rank === 1) winnerPromo += 1;
          else if (e.points >= 121 && e.rank != null && e.rank <= 8) best8Promo += 1;
        });

        return {
          periodKey,
          entries: [...entries].sort((a, b) => b.points - a.points),
          reflected: periodReflected,
          excluded: periodExcluded,
          weeks,
          winnerPromo,
          best8Promo,
        };
      })
      .sort((a, b) => b.periodKey.localeCompare(a.periodKey));
  }, [tournamentPoints]);

  // the win rate and points (reflected vs excluded) for the month currently shown in the calendar
  const weekTop2Ids = useMemo(() => {
    const byWeek = {};
    tournamentPoints.forEach((p) => {
      const wk = getWeekKey(p.date);
      if (!byWeek[wk]) byWeek[wk] = [];
      byWeek[wk].push(p);
    });
    const map = {};
    Object.entries(byWeek).forEach(([wk, entries]) => {
      const sorted = [...entries].sort((a, b) => b.points - a.points);
      map[wk] = new Set(sorted.slice(0, 2).map((e) => e.id));
    });
    return map;
  }, [tournamentPoints]);

  const calendarMonthSummary = useMemo(() => {
    const y = calendarMonth.getFullYear();
    const mo = calendarMonth.getMonth();
    const monthMatches = (matches || []).filter((m) => {
      const d = new Date(m.date);
      return d.getFullYear() === y && d.getMonth() === mo;
    });
    const rate = calcRecord(monthMatches);

    let reflected = 0;
    let excluded = 0;
    tournamentPoints.forEach((p) => {
      const d = new Date(p.date + "T00:00:00");
      if (d.getFullYear() !== y || d.getMonth() !== mo) return;
      const wk = getWeekKey(p.date);
      const top2 = weekTop2Ids[wk];
      if (top2 && top2.has(p.id)) reflected += p.points;
      else excluded += p.points;
    });

    return { rate, reflected, excluded };
  }, [calendarMonth, matches, tournamentPoints, weekTop2Ids]);

  // rank/deck search options and filtered tournament breakdown rows
  const rankOptions = useMemo(() => {
    const set = new Set();
    tournamentPoints.forEach((p) => {
      if (p.rank != null) set.add(p.rank);
    });
    return Array.from(set).sort((a, b) => a - b);
  }, [tournamentPoints]);

  const deckOptionsForSearch = useMemo(() => {
    const set = new Set();
    tournamentPoints.forEach((p) => {
      if ((p.deck || "").trim()) set.add(p.deck.trim());
    });
    return Array.from(set);
  }, [tournamentPoints]);

  const filteredTournamentRows = useMemo(() => {
    return stats.byTournament.filter((row) => {
      if (searchTournamentName.trim() && !row.name.includes(searchTournamentName.trim())) {
        return false;
      }
      if (!searchRank && !searchDeck) return true;
      const entries = tournamentPoints.filter(
        (p) => p.tournament === row.name && p.date === row.date
      );
      return entries.some(
        (e) =>
          (!searchRank || String(e.rank) === searchRank) &&
          (!searchDeck || e.deck === searchDeck)
      );
    });
  }, [stats.byTournament, tournamentPoints, searchRank, searchDeck, searchTournamentName]);

  // this-week / navigable week window for the opponent-deck pie chart
  const pieWeekRange = useMemo(() => {
    const base = new Date();
    base.setDate(base.getDate() + pieWeekOffset * 7);
    const start = getWeekStart(base);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }, [pieWeekOffset]);

  const weeklyOpponentDeckPie = useMemo(() => {
    const { start, end } = pieWeekRange;
    const inWeek = (matches || []).filter((m) => {
      const t = new Date(m.date).getTime();
      return t >= start.getTime() && t <= end.getTime() && (m.opponentDeck || "").trim();
    });
    const counts = {};
    inWeek.forEach((m) => {
      const d = m.opponentDeck.trim();
      counts[d] = (counts[d] || 0) + 1;
    });
    const total = inWeek.length;
    return Object.entries(counts)
      .map(([name, value]) => ({ name, value, percentage: total > 0 ? (value / total) * 100 : 0 }))
      .sort((a, b) => b.value - a.value);
  }, [matches, pieWeekRange]);

  // recommended decks for next time: weight each of my decks' matchup win rate
  // by how often each opponent deck has recently been seen
  const recentOpponentFreq = useMemo(() => {
    const now = new Date();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;

    let recentOpp;
    if (isWeekend) {
      // weekends: reference the past week's worth of usage
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      recentOpp = (matches || []).filter(
        (m) => new Date(m.date).getTime() >= cutoff && (m.opponentDeck || "").trim()
      );
    } else {
      // weekdays: reference the previous day's usage
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const key = toDateInputValue(yesterday.toISOString());
      recentOpp = (matches || []).filter(
        (m) => toDateInputValue(m.date) === key && (m.opponentDeck || "").trim()
      );
    }
    if (recentOpp.length === 0) {
      // fallback: last 4 weeks, then all-time
      const cutoff = Date.now() - 28 * 24 * 60 * 60 * 1000;
      recentOpp = (matches || []).filter(
        (m) => new Date(m.date).getTime() >= cutoff && (m.opponentDeck || "").trim()
      );
    }
    if (recentOpp.length === 0) {
      recentOpp = (matches || []).filter((m) => (m.opponentDeck || "").trim());
    }
    const oppFreq = {};
    recentOpp.forEach((m) => {
      const d = m.opponentDeck.trim();
      oppFreq[d] = (oppFreq[d] || 0) + 1;
    });

    // blend in manually/OCR-entered external meta share data for the current week,
    // converted to pseudo match-counts so it can weigh in alongside real recorded matches
    const currentWeekKey = toDateInputValue(getWeekStart(new Date()).toISOString());
    const externalThisWeek = externalMetaShares.filter((e) => e.weekKey === currentWeekKey);
    if (externalThisWeek.length > 0) {
      const totalPct = externalThisWeek.reduce((s, e) => s + e.percentage, 0) || 100;
      const pseudoTotal = 20;
      externalThisWeek.forEach((e) => {
        const pseudoCount = (e.percentage / totalPct) * pseudoTotal;
        oppFreq[e.deckType] = (oppFreq[e.deckType] || 0) + pseudoCount;
      });
    }

    return oppFreq;
  }, [matches, externalMetaShares]);

  // known deck names, most-frequently-used first, for quick-select chips and as fallback
  // candidates for the recommendation engine when no matchup data exists yet
  const allMyDeckNames = useMemo(() => frequencySortedNames(matches, "myDeck"), [matches]);
  const recentMyDecks = useMemo(
    () => filterNames(allMyDeckNames, myDeck),
    [allMyDeckNames, myDeck]
  );

  // deck type -> broad archetype category (アグロ/ソリティア/コントロール), used to estimate
  // matchups the recorded data doesn't cover yet
  const storageUsage = useMemo(() => {
    const matchesSize = JSON.stringify(matches || []).length;
    const photosSize = JSON.stringify(tournamentPhotos || {}).length;
    const profilesSize = JSON.stringify(deckProfiles || []).length;
    const pointsSize = JSON.stringify(tournamentPoints || []).length;
    const linksSize = JSON.stringify(links || []).length;
    const metaSize = JSON.stringify(externalMetaShares || []).length;
    const matchupsSize = JSON.stringify(externalMatchups || []).length;
    const profileImagesSize = (deckProfiles || []).reduce(
      (sum, p) => sum + JSON.stringify(p.photos || []).length + (p.icon || "").length,
      0
    );
    const total =
      matchesSize + photosSize + profilesSize + pointsSize + linksSize + metaSize + matchupsSize;
    const photosTotal = photosSize + profileImagesSize;
    return { total, photosSize: photosTotal, otherSize: total - photosTotal };
  }, [
    matches,
    tournamentPhotos,
    deckProfiles,
    tournamentPoints,
    links,
    externalMetaShares,
    externalMatchups,
  ]);

  const deckCategoryMap = useMemo(() => {
    const map = {};
    deckProfiles.forEach((p) => {
      if (p.deckType && p.category) map[p.deckType.trim()] = p.category;
    });
    return map;
  }, [deckProfiles]);

  const similarDeckMap = useMemo(() => {
    const map = {};
    deckProfiles.forEach((p) => {
      if (p.deckType && Array.isArray(p.similarDecks) && p.similarDecks.length > 0) {
        map[p.deckType.trim()] = p.similarDecks;
      }
    });
    return map;
  }, [deckProfiles]);

  // shared win-rate lookup + estimation used both by the automatic recommendation and by
  // the manual "find a counter deck" tool below
  const rateLookupForPrediction = useMemo(() => {
    const lookup = {};
    matchupAnalysisForPrediction.forEach((deck) => {
      lookup[deck.myDeck] = {};
      deck.rows.forEach((row) => {
        lookup[deck.myDeck][row.opponentDeck] = row.rate;
      });
    });
    return lookup;
  }, [matchupAnalysisForPrediction]);

  // when there's no recorded matchup for a my-deck/opponent-deck pair, first try the
  // opponent deck's declared "similar decks" (from the deck compendium) as a stand-in,
  // then fall back to the アグロ→ソリティア→コントロール→アグロ advantage relationship
  const estimateMatchupRate = (myDeckName, oppDeckName) => {
    const known = rateLookupForPrediction[myDeckName]?.[oppDeckName];
    if (known != null) return known;
    const similars = similarDeckMap[oppDeckName];
    if (similars && similars.length > 0) {
      const knownSimilar = similars
        .map((s) => rateLookupForPrediction[myDeckName]?.[s])
        .filter((r) => r != null);
      if (knownSimilar.length > 0) {
        return knownSimilar.reduce((sum, r) => sum + r, 0) / knownSimilar.length;
      }
    }
    const myCat = deckCategoryMap[myDeckName];
    const oppCat = deckCategoryMap[oppDeckName];
    if (myCat && oppCat) {
      if (CATEGORY_ADVANTAGE[myCat] === oppCat) return 60;
      if (CATEGORY_ADVANTAGE[oppCat] === myCat) return 40;
    }
    return 50;
  };

  const recommendation = useMemo(() => {
    const totalOpp = Object.values(recentOpponentFreq).reduce((a, b) => a + b, 0);
    if (totalOpp === 0) return [];

    const myDeckNames =
      matchupAnalysisForPrediction.length > 0
        ? matchupAnalysisForPrediction.map((d) => d.myDeck)
        : allMyDeckNames.slice(0, 8);
    if (myDeckNames.length === 0) return [];

    const scored = myDeckNames.map((myDeckName) => {
      let weightedSum = 0;
      Object.entries(recentOpponentFreq).forEach(([oppDeck, freq]) => {
        weightedSum += freq * estimateMatchupRate(myDeckName, oppDeck);
      });
      const expectedRate = totalOpp > 0 ? weightedSum / totalOpp : 50;
      const sampleSize = matchupAnalysisForPrediction.find((d) => d.myDeck === myDeckName)?.total || 0;
      return { myDeck: myDeckName, expectedRate, sampleSize };
    });

    return scored.sort((a, b) => b.expectedRate - a.expectedRate).slice(0, 3);
  }, [matchupAnalysisForPrediction, recentOpponentFreq, rateLookupForPrediction, deckCategoryMap, similarDeckMap, allMyDeckNames]);

  // manual counter-deck finder: pick one or more opponent decks, get the top 3 of my decks
  // with the best (estimated) win rate against that combination
  const [counterSearchOpponents, setCounterSearchOpponents] = useState([]);

  const toggleCounterSearchOpponent = (deckName) => {
    setCounterSearchOpponents((prev) =>
      prev.includes(deckName) ? prev.filter((d) => d !== deckName) : [...prev, deckName]
    );
  };

  const counterDeckSuggestions = useMemo(() => {
    if (counterSearchOpponents.length === 0) return [];
    const myDeckNames =
      matchupAnalysisForPrediction.length > 0
        ? matchupAnalysisForPrediction.map((d) => d.myDeck)
        : allMyDeckNames.slice(0, 8);
    if (myDeckNames.length === 0) return [];

    const scored = myDeckNames.map((myDeckName) => {
      const perOpponent = counterSearchOpponents.map((oppDeck) => ({
        opponentDeck: oppDeck,
        rate: estimateMatchupRate(myDeckName, oppDeck),
      }));
      const avgRate = perOpponent.reduce((sum, r) => sum + r.rate, 0) / perOpponent.length;
      return { myDeck: myDeckName, avgRate, perOpponent };
    });

    return scored.sort((a, b) => b.avgRate - a.avgRate).slice(0, 3);
  }, [counterSearchOpponents, matchupAnalysisForPrediction, rateLookupForPrediction, deckCategoryMap, similarDeckMap, allMyDeckNames]);

  // for each frequently-seen opponent deck, the best-performing deck of mine against it
  // combo suggestions: (my deck × likely opponent deck) pairs, ranked by win rate,
  // weighted toward opponent decks seen recently
  const comboSuggestions = useMemo(() => {
    if (matchupAnalysisForPrediction.length === 0) return [];
    const combos = [];
    matchupAnalysisForPrediction.forEach((deck) => {
      deck.rows.forEach((row) => {
        const freq = recentOpponentFreq[row.opponentDeck] || 0;
        if (freq > 0) {
          combos.push({
            myDeck: deck.myDeck,
            opponentDeck: row.opponentDeck,
            rate: row.rate,
            total: row.total,
            freq,
          });
        }
      });
    });
    return combos.sort((a, b) => b.rate - a.rate || b.freq - a.freq).slice(0, 3);
  }, [matchupAnalysisForPrediction, recentOpponentFreq]);

  // overall learned advantage/disadvantage across all matchup history (not limited to recent opponents)
  const learnedMatchupSummary = useMemo(() => {
    const combos = [];
    matchupAnalysisForPrediction.forEach((deck) => {
      deck.rows.forEach((row) => {
        if (row.total >= 2) {
          combos.push({
            myDeck: deck.myDeck,
            opponentDeck: row.opponentDeck,
            rate: row.rate,
            total: row.total,
          });
        }
      });
    });
    const favorable = [...combos].sort((a, b) => b.rate - a.rate).slice(0, 2);
    const unfavorable = [...combos].sort((a, b) => a.rate - b.rate).slice(0, 2);
    return { favorable, unfavorable };
  }, [matchupAnalysisForPrediction]);

  const tournamentTrend = useMemo(() => {
    return [...stats.byTournament]
      .filter((t) => t.name !== UNASSIGNED)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((t) => {
        const shortName = t.name.length > 6 ? t.name.slice(0, 6) + "…" : t.name;
        const shortDate = `${Number(t.date.slice(5, 7))}/${Number(t.date.slice(8, 10))}`;
        return {
          key: t.key,
          name: `${shortName} ${shortDate}`,
          fullName: `${t.name}（${shortDate}）`,
          rate: Math.round(t.rate),
          win: t.win,
          lose: t.lose,
          draw: t.draw,
        };
      });
  }, [stats.byTournament]);

  // most-frequently-used tournament names, narrowed by what's currently typed
  const allTournamentNames = useMemo(() => frequencySortedNames(matches, "tournament"), [matches]);
  const recentTournaments = useMemo(
    () => filterNames(allTournamentNames, tournament, 6),
    [allTournamentNames, tournament]
  );

  const allOpponentDeckNames = useMemo(
    () => frequencySortedNames(matches, "opponentDeck"),
    [matches]
  );
  const recentOpponentDecks = useMemo(
    () => filterNames(allOpponentDeckNames, opponentDeck),
    [allOpponentDeckNames, opponentDeck]
  );

  // most-frequently-faced opponent names, narrowed by what's currently typed
  const allOpponentNames = useMemo(() => frequencySortedNames(matches, "opponent"), [matches]);
  const recentOpponents = useMemo(
    () => filterNames(allOpponentNames, opponent),
    [allOpponentNames, opponent]
  );

  // deck type -> icon image (dataURL) lookup, set via the opponent deck profile page
  const deckIconMap = useMemo(() => {
    const map = {};
    deckProfiles.forEach((p) => {
      if (p.deckType && p.icon) map[p.deckType.trim()] = p.icon;
    });
    return map;
  }, [deckProfiles]);

  // custom pie labels that show the deck's icon image (when set) above its name
  const RADIAN = Math.PI / 180;
  const renderOpponentPieLabel = (props) => {
    const { cx, cy, midAngle, outerRadius, name, payload } = props;
    const r = outerRadius + 24;
    const x = cx + r * Math.cos(-midAngle * RADIAN);
    const y = cy + r * Math.sin(-midAngle * RADIAN);
    const icon = deckIconMap[name];
    const pct = payload && typeof payload.percentage === "number" ? payload.percentage : null;
    return (
      <g>
        {icon && <image href={icon} x={x - 9} y={y - 24} width={18} height={18} />}
        <text x={x} y={y} textAnchor="middle" fontSize={10} fill="#5c5240">
          {name}
          {pct != null ? ` ${pct.toFixed(0)}%` : ""}
        </text>
      </g>
    );
  };
  const renderUnifiedPieLabel = (props) => {
    const { cx, cy, midAngle, outerRadius, name, payload } = props;
    const r = outerRadius + 26;
    const x = cx + r * Math.cos(-midAngle * RADIAN);
    const y = cy + r * Math.sin(-midAngle * RADIAN);
    const icon = deckIconMap[name];
    return (
      <g>
        {icon && <image href={icon} x={x - 9} y={y - 24} width={18} height={18} />}
        <text x={x} y={y} textAnchor="middle" fontSize={10} fill="#5c5240">
          {name} {payload.rate.toFixed(0)}%
        </text>
      </g>
    );
  };

  // recent streak (last 10, chronological)
  const streak = useMemo(() => {
    return (matches || []).slice(0, 10);
  }, [matches]);

  if (matches === null) {
    return (
      <div style={styles.page}>
        <div style={styles.loading}>読み込み中…</div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <style>{fontImport}</style>

      <header style={styles.header}>
        <div style={styles.headerRow}>
          <Swords size={22} color="#b5432e" strokeWidth={2.2} />
          <h1 style={styles.title}>戦績帳</h1>
          <div style={styles.headerIconGroup}>
          <button
            onClick={() => {
              setCalendarOpen((v) => !v);
              if (!calendarOpen) setSelectedDate(null);
            }}
            style={styles.calendarToggleBtn}
            aria-label="カレンダー表示"
          >
            <CalendarIcon size={16} color={calendarOpen ? "#fdfaf4" : "#8a7a5c"} />
          </button>
          <button
            onClick={() => setDeckDbOpen((v) => !v)}
            style={styles.calendarToggleBtn}
            aria-label="相手デッキ図鑑"
          >
            <BookOpen size={16} color={deckDbOpen ? "#fdfaf4" : "#8a7a5c"} />
          </button>
          <a
            href="https://www.dmp-ranking.com/schedule.asp"
            target="_blank"
            rel="noopener noreferrer"
            style={styles.calendarToggleBtn}
            aria-label="大会日程を見る"
          >
            <ExternalLink size={16} color="#8a7a5c" />
          </a>
          <button
            onClick={() => setLinksOpen((v) => !v)}
            style={styles.calendarToggleBtn}
            aria-label="リンク集"
          >
            <LinkIcon size={16} color={linksOpen ? "#fdfaf4" : "#8a7a5c"} />
          </button>
          <button
            onClick={() => setDataManageOpen((v) => !v)}
            style={styles.calendarToggleBtn}
            aria-label="データの保存・読み込み"
          >
            <Database size={16} color={dataManageOpen ? "#fdfaf4" : "#8a7a5c"} />
          </button>
          <button
            onClick={() => setMetaInputOpen((v) => !v)}
            style={styles.calendarToggleBtn}
            aria-label="外部の使用率データ"
          >
            <PieChartIcon size={16} color={metaInputOpen ? "#fdfaf4" : "#8a7a5c"} />
          </button>
          </div>
        </div>
        <div style={styles.headerSub}>対戦の記録と勝率</div>
      </header>

      <div style={styles.boardTabRow}>
        {boards.map((b) => (
          <button
            key={b.id}
            onClick={() => switchBoard(b.id)}
            style={b.id === activeBoardId ? styles.boardTabActive : styles.boardTab}
          >
            {b.name}
          </button>
        ))}
        <button onClick={createBoard} style={styles.boardIconBtn} aria-label="集計画面を追加">
          <Plus size={13} />
        </button>
        <button
          onClick={() => {
            setBoardManage(activeBoardId);
            setBoardRenameValue(boards.find((b) => b.id === activeBoardId)?.name || "");
          }}
          style={styles.boardIconBtn}
          aria-label="集計画面を管理"
        >
          <Pencil size={12} />
        </button>
      </div>

      {boardManage && (
        <div style={styles.boardManageRow}>
          <input
            value={boardRenameValue}
            onChange={(e) => setBoardRenameValue(e.target.value)}
            style={styles.searchSelect}
          />
          <button
            onClick={() => renameBoard(boardManage, boardRenameValue)}
            style={styles.deckDbAddBtn}
          >
            保存
          </button>
          {boards.length > 1 && (
            <button
              onClick={() => deleteBoard(boardManage)}
              style={styles.boardDeleteBtn}
            >
              削除
            </button>
          )}
          <button onClick={() => setBoardManage(null)} style={styles.closeBtn}>
            <X size={14} />
          </button>
        </div>
      )}

      {calendarOpen && (
        <section style={styles.calendarCard}>
          <div style={styles.calendarNav}>
            <button
              onClick={() =>
                setCalendarMonth((m) => {
                  const d = new Date(m);
                  d.setMonth(d.getMonth() - 1);
                  return d;
                })
              }
              style={styles.calendarNavBtn}
            >
              <ChevronLeft size={16} />
            </button>
            <span style={styles.calendarMonthLabel}>
              {calendarMonth.getFullYear()}年{calendarMonth.getMonth() + 1}月
            </span>
            <button
              onClick={() =>
                setCalendarMonth((m) => {
                  const d = new Date(m);
                  d.setMonth(d.getMonth() + 1);
                  return d;
                })
              }
              style={styles.calendarNavBtn}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {(calendarMonthSummary.rate.total > 0 ||
            calendarMonthSummary.reflected > 0 ||
            calendarMonthSummary.excluded > 0) && (
            <div style={styles.calendarMonthSummary}>
              {calendarMonthSummary.rate.total > 0 && (
                <span>
                  勝率{calendarMonthSummary.rate.rate.toFixed(0)}%（{calendarMonthSummary.rate.win}勝
                  {calendarMonthSummary.rate.lose}敗
                  {calendarMonthSummary.rate.draw ? `${calendarMonthSummary.rate.draw}分` : ""}）
                </span>
              )}
              {(calendarMonthSummary.reflected > 0 || calendarMonthSummary.excluded > 0) && (
                <span>
                  獲得pt: {calendarMonthSummary.reflected}pt(集計内)
                  {calendarMonthSummary.excluded > 0 &&
                    ` ${calendarMonthSummary.excluded}pt(集計外)`}
                </span>
              )}
            </div>
          )}

          <div style={styles.calendarGrid}>
            {["日", "月", "火", "水", "木", "金", "土"].map((w) => (
              <div key={w} style={styles.calendarWeekday}>
                {w}
              </div>
            ))}
            {calendarDays.map((d) => {
              const hasMatches = d.stats.total > 0;
              const isSelected = selectedDate === d.key;
              return (
                <button
                  key={d.key}
                  onClick={() => setSelectedDate(isSelected ? null : d.key)}
                  style={{
                    ...styles.calendarDay,
                    opacity: d.inMonth ? 1 : 0.3,
                    ...(d.isToday ? styles.calendarDayToday : {}),
                    ...(isSelected ? styles.calendarDaySelected : {}),
                  }}
                >
                  <span style={styles.calendarDayNum}>{d.date.getDate()}</span>
                  {hasMatches && (
                    <span
                      style={{
                        ...styles.calendarDayDot,
                        background:
                          d.stats.rate >= 50 ? "#b5432e" : d.stats.rate > 0 ? "#33475b" : "#c9bda0",
                      }}
                    >
                      {d.stats.total}
                    </span>
                  )}
                  {d.points > 0 && <span style={styles.calendarDayPoints}>{d.points}pt</span>}
                </button>
              );
            })}
          </div>

          {selectedDate && (
            <div style={styles.calendarDetail}>
              <div style={styles.calendarDetailHeader}>
                <span style={styles.calendarDetailTitle}>{selectedDate}の記録</span>
                <span style={styles.calendarDetailMeta}>
                  {calcRecord(selectedDateMatches).win}勝
                  {calcRecord(selectedDateMatches).lose}敗
                  {calcRecord(selectedDateMatches).draw
                    ? `${calcRecord(selectedDateMatches).draw}分`
                    : ""}
                </span>
              </div>
              {selectedDatePoints.length > 0 && (
                <div style={styles.calendarPointsList}>
                  {selectedDatePoints.map((p) => (
                    <span key={p.id} style={styles.calendarPointsChip}>
                      {p.tournament}：{p.points}pt
                      {p.rank != null ? `（${p.rank}位）` : ""}
                    </span>
                  ))}
                </div>
              )}
              {selectedDateMatches.length === 0 ? (
                <div style={styles.empty}>この日の記録はありません。</div>
              ) : (
                <ul style={styles.list}>
                  {selectedDateMatches.map((m) => (
                    <li key={m.id} style={styles.row}>
                      <span
                        style={{
                          ...styles.resultBadge,
                          color: RESULTS[m.result].color,
                          background: RESULTS[m.result].bg,
                        }}
                      >
                        {RESULTS[m.result].short}
                      </span>
                      <div style={styles.rowBody}>
                        <div style={styles.rowTop}>
                          <span style={styles.rowOpponent}>
                            {m.opponent || (
                              <span style={styles.rowOpponentBlank}>対戦相手未記入</span>
                            )}
                          </span>
                          {m.opponentDeck && (
                            <span style={styles.rowDeck}>
                              {deckIconMap[m.opponentDeck] && (
                                <img src={deckIconMap[m.opponentDeck]} alt="" style={styles.rowDeckIcon} />
                              )}
                              相手: {m.opponentDeck}
                            </span>
                          )}
                          {m.myDeck && (
                            <span style={styles.rowDeckMine}>
                              {deckIconMap[m.myDeck] && (
                                <img src={deckIconMap[m.myDeck]} alt="" style={styles.rowDeckIcon} />
                              )}
                              自分: {m.myDeck}
                            </span>
                          )}
                        </div>
                        {m.tournament && (
                          <div style={styles.rowBottom}>
                            <span>{m.tournament}</span>
                          </div>
                        )}
                      </div>
                      <div style={styles.rowActions}>
                        <button onClick={() => openEdit(m)} aria-label="編集" style={styles.editBtn}>
                          <Pencil size={14} strokeWidth={2} />
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(m.id)}
                          aria-label="削除"
                          style={styles.deleteBtn}
                        >
                          <Trash2 size={15} strokeWidth={2} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {deckDbOpen && (
        <section style={styles.calendarCard}>
          <div style={styles.deckDbHeader}>
            <span style={styles.deckDbTitle}>相手デッキ図鑑</span>
            <button onClick={() => openProfileForm(null)} style={styles.deckDbAddBtn}>
              <Plus size={13} />
              追加
            </button>
          </div>

          {deckProfiles.length === 0 ? (
            <div style={styles.empty}>
              まだ登録がありません。相手デッキのタイプ・サンプルリスト・フィニッシュなどを記録しておくと、対戦準備に役立ちます。
            </div>
          ) : (
            <div style={styles.profileList}>
              {deckProfiles.map((p) => (
                <div key={p.id} style={styles.profileCard}>
                  <div style={styles.profileCardTop}>
                    <div style={styles.profileNameBlock}>
                      {p.icon && (
                        <img src={p.icon} alt="" style={styles.profileIconThumb} />
                      )}
                      <span style={styles.profileDeckName}>
                        {p.deckType || p.name || "（未設定）"}
                      </span>
                      {p.category && (
                        <span style={styles.profileDeckTypeTag}>{p.category}</span>
                      )}
                    </div>
                    <div style={styles.profileCardActions}>
                      <button onClick={() => openProfileForm(p)} style={styles.editBtn}>
                        <Pencil size={13} strokeWidth={2} />
                      </button>
                      <button onClick={() => deleteProfile(p.id)} style={styles.deleteBtn}>
                        <Trash2 size={14} strokeWidth={2} />
                      </button>
                    </div>
                  </div>
                  {p.finish && <div style={styles.profileFinish}>フィニッシュ：{p.finish}</div>}
                  {Array.isArray(p.similarDecks) && p.similarDecks.length > 0 && (
                    <div style={styles.profileFinish}>類似デッキ：{p.similarDecks.join("、")}</div>
                  )}
                  {p.photos && p.photos.length > 0 && (
                    <div style={styles.gallery}>
                      {p.photos.map((ph) => (
                        <div key={ph.id} style={styles.galleryItem}>
                          <img
                            src={ph.dataUrl}
                            alt="サンプルリスト"
                            style={styles.galleryImg}
                            onClick={() => setViewingPhoto({ kind: "profile", profileId: p.id, ...ph })}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}


      {linksOpen && (
        <section style={styles.calendarCard}>
          <div style={styles.deckDbHeader}>
            <span style={styles.deckDbTitle}>リンク集</span>
          </div>
          <input
            value={linkTitle}
            onChange={(e) => setLinkTitle(e.target.value)}
            placeholder="タイトル（任意）"
            style={styles.input}
          />
          <div style={{ height: 8 }} />
          <div style={styles.pointsRankRow}>
            <input
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addLink();
              }}
              placeholder="https://..."
              style={styles.input}
            />
            <button onClick={addLink} style={styles.addRoundBtn}>
              追加
            </button>
          </div>

          {links.length === 0 ? (
            <div style={styles.empty}>保存されたリンクはありません。</div>
          ) : (
            <div style={styles.profileList}>
              {links.map((l) => (
                <div key={l.id} style={styles.linkRow}>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.linkAnchor}
                  >
                    {l.title}
                  </a>
                  <button onClick={() => deleteLink(l.id)} style={styles.deleteBtn}>
                    <Trash2 size={14} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {metaInputOpen && (
        <section style={styles.calendarCard}>
          <div style={styles.deckDbHeader}>
            <span style={styles.deckDbTitle}>外部の使用率データ</span>
          </div>
          <div style={styles.empty}>
            大会レポートなどにある「デッキ使用率」を手入力、または円グラフの画像を読み込んで登録できます。「次回の使用候補」の計算にのみ参考情報として反映され、自分の対戦記録から作る「週間 対戦相手デッキ内訳」のグラフには表示・加算されません。
          </div>

          <div style={styles.weekNav}>
            <button
              onClick={() => setMetaWeekOffset((v) => v - 1)}
              style={styles.weekNavBtn}
            >
              <ChevronLeft size={13} />
            </button>
            <span style={styles.weekNavLabel}>
              {metaWeekOffset === 0 ? "今週" : formatWeekLabel(metaWeekKey)}
            </span>
            <button
              onClick={() => setMetaWeekOffset((v) => Math.min(0, v + 1))}
              style={styles.weekNavBtn}
              disabled={metaWeekOffset >= 0}
            >
              <ChevronRight size={13} />
            </button>
          </div>

          <label style={styles.photoUploadBtn}>
            <input
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              disabled={metaOcrLoading}
              onChange={handleMetaImageUpload}
            />
            {metaOcrLoading ? (
              <>
                <Loader2 size={14} className="spin" />
                読み取り中…
              </>
            ) : (
              <>
                <ImagePlus size={14} />
                円グラフの画像から読み込む
              </>
            )}
          </label>
          <label style={styles.photoUploadBtn}>
            <input
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={handleMetaCSVUpload}
            />
            <ListTree size={14} />
            表（CSV）から読み込む
          </label>
          {metaOcrError && <div style={styles.ocrErrorText}>{metaOcrError}</div>}

          <div style={styles.batchList}>
            {metaRows.map((row, idx) => (
              <div key={idx} style={styles.metaRow}>
                <input
                  value={row.deckType}
                  onChange={(e) => updateMetaRow(idx, { deckType: e.target.value })}
                  placeholder="デッキタイプ"
                  style={{ ...styles.inputSmall, marginTop: 0, flex: 1 }}
                />
                <input
                  type="number"
                  inputMode="decimal"
                  value={row.percentage}
                  onChange={(e) => updateMetaRow(idx, { percentage: e.target.value })}
                  placeholder="%"
                  style={styles.metaPercentInput}
                />
                {metaRows.length > 1 && (
                  <button
                    onClick={() => removeMetaRow(idx)}
                    style={styles.batchRemoveBtn}
                    aria-label="この行を削除"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <button onClick={addMetaRow} style={styles.addRoundBtn}>
            ＋ デッキを追加
          </button>
          <button onClick={saveMetaRows} style={styles.submitBtn}>
            この週のデータとして保存
          </button>

          <div style={styles.deckDbHeader}>
            <span style={styles.deckDbTitle}>外部のデッキ相性データ</span>
          </div>
          <div style={styles.empty}>
            他で集計されたデッキ同士の対戦成績（勝ち・負け・分け）を登録できます。自分の対戦記録から作る「デッキ相性」の学習データに統合されます。
          </div>

          <label style={styles.photoUploadBtn}>
            <input
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={handleMatchupCSVUpload}
            />
            <ListTree size={14} />
            表（CSV）から読み込む
          </label>
          {matchupImportError && <div style={styles.ocrErrorText}>{matchupImportError}</div>}

          <div style={styles.batchList}>
            {matchupInputRows.map((row, idx) => (
              <div key={idx} style={styles.matchupInputRow}>
                <input
                  value={row.myDeck}
                  onChange={(e) => updateMatchupInputRow(idx, { myDeck: e.target.value })}
                  placeholder="自分のデッキ"
                  style={{ ...styles.inputSmall, marginTop: 0 }}
                />
                <input
                  value={row.opponentDeck}
                  onChange={(e) => updateMatchupInputRow(idx, { opponentDeck: e.target.value })}
                  placeholder="相手のデッキ"
                  style={{ ...styles.inputSmall, marginTop: 0 }}
                />
                <div style={styles.matchupInputCounts}>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={row.win}
                    onChange={(e) => updateMatchupInputRow(idx, { win: e.target.value })}
                    placeholder="勝ち"
                    style={styles.metaPercentInput}
                  />
                  <input
                    type="number"
                    inputMode="numeric"
                    value={row.lose}
                    onChange={(e) => updateMatchupInputRow(idx, { lose: e.target.value })}
                    placeholder="負け"
                    style={styles.metaPercentInput}
                  />
                  <input
                    type="number"
                    inputMode="numeric"
                    value={row.draw}
                    onChange={(e) => updateMatchupInputRow(idx, { draw: e.target.value })}
                    placeholder="分け"
                    style={styles.metaPercentInput}
                  />
                  {matchupInputRows.length > 1 && (
                    <button
                      onClick={() => removeMatchupInputRow(idx)}
                      style={styles.batchRemoveBtn}
                      aria-label="この行を削除"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <button onClick={addMatchupInputRow} style={styles.addRoundBtn}>
            ＋ 組み合わせを追加
          </button>
          <button onClick={saveMatchupInputRows} style={styles.submitBtn}>
            デッキ相性データとして保存
          </button>
        </section>
      )}

      {dataManageOpen && (
        <section style={styles.calendarCard}>
          <div style={styles.deckDbHeader}>
            <span style={styles.deckDbTitle}>保存容量</span>
          </div>
          <div style={styles.empty}>
            この集計画面が使っているデータ量の目安です。写真が容量の大半を占めることが多いので、増えてきたら圧縮や整理を検討してください。
          </div>
          <div style={styles.storageUsageRow}>
            <span style={styles.storageUsageTotal}>{formatBytes(storageUsage.total)}</span>
            <span style={styles.storageUsageDetail}>
              うち写真 {formatBytes(storageUsage.photosSize)}／その他{" "}
              {formatBytes(storageUsage.otherSize)}
            </span>
          </div>
          <button
            onClick={recompressAllPhotos}
            disabled={recompressLoading || storageUsage.photosSize === 0}
            style={styles.addMatchToTournamentBtn}
          >
            {recompressLoading ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <ImagePlus size={13} />
            )}
            保存済みの写真を圧縮して容量を減らす
          </button>
          {recompressMessage && (
            <div style={styles.photoSavedNote}>{recompressMessage}</div>
          )}

          <div style={styles.deckDbHeader}>
            <span style={styles.deckDbTitle}>Gemini APIキー</span>
          </div>
          <div style={styles.empty}>
            デッキタイプの画像判定・チャット相談・使用率グラフの読み取りに使うAPIキーです。
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              style={styles.linkAnchor}
            >
              {" "}
              Google AI Studio
            </a>
            で無料で取得できます。この端末にのみ保存され、外部には送信されません。
          </div>
          <div style={styles.exportPasswordRow}>
            <input
              type="password"
              value={geminiKeyDraft}
              onChange={(e) => setGeminiKeyDraft(e.target.value)}
              placeholder="APIキーを貼り付け"
              style={styles.input}
            />
          </div>
          <button onClick={saveGeminiKey} style={styles.addMatchToTournamentBtn}>
            {geminiApiKey ? "キーを更新する" : "キーを保存する"}
          </button>
          {geminiApiKey && (
            <div style={styles.photoSavedNote}>APIキーが設定されています（AI機能が利用できます）。</div>
          )}

          <div style={styles.deckDbHeader}>
            <span style={styles.deckDbTitle}>データの書き出し・読み込み</span>
          </div>
          <div style={styles.empty}>
            この集計画面（{boards.find((b) => b.id === activeBoardId)?.name}）の記録・写真・ポイント・デッキ図鑑・リンクをまとめてJSONファイルとして保存、または以前保存したファイルから復元できます。
          </div>

          <label style={styles.fieldLabel}>
            書き出し用パスワード（任意・設定するとファイルが暗号化されます）
          </label>
          <div style={styles.exportPasswordRow}>
            <button onClick={openExportPin} style={styles.exportPasswordBtn}>
              {exportPassword.trim() ? "🔒 設定済み（変更する）" : "パスワードを設定する"}
            </button>
            {exportPassword.trim() && (
              <button onClick={clearExportPassword} style={styles.boardDeleteBtn}>
                解除
              </button>
            )}
          </div>
          <button onClick={exportBoardData} style={styles.addMatchToTournamentBtn}>
            <Download size={13} />
            {exportPassword.trim() ? "パスワード付きで書き出す" : "データを書き出す"}
          </button>

          <label style={styles.addMatchToTournamentBtn}>
            <input
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={importBoardData}
            />
            <Upload size={13} />
            ファイルから読み込む
          </label>

          {pendingEncryptedImport && (
            <div style={styles.encryptedImportBox}>
              <div style={styles.hintText}>
                このファイルはパスワードで保護されています。パスワードを入力してください。
              </div>
              <input
                type="password"
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
                placeholder="パスワード"
                style={styles.input}
              />
              <div style={styles.encryptedImportActions}>
                <button
                  onClick={decryptAndImport}
                  disabled={!importPassword.trim() || decryptLoading}
                  style={{ ...styles.addMatchToTournamentBtn, width: "auto", flex: 1, marginBottom: 0 }}
                >
                  {decryptLoading ? (
                    <Loader2 size={13} className="spin" />
                  ) : (
                    <Upload size={13} />
                  )}
                  復号して読み込む
                </button>
                <button
                  onClick={() => {
                    setPendingEncryptedImport(null);
                    setImportPassword("");
                  }}
                  style={styles.boardDeleteBtn}
                >
                  キャンセル
                </button>
              </div>
            </div>
          )}

          {importMessage && <div style={styles.photoSavedNote}>{importMessage}</div>}
        </section>
      )}

      {pointsBreakdownOpen && (
        <div style={styles.modalOverlay} onClick={() => setPointsBreakdownOpen(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>週別ポイント内訳</span>
              <button
                onClick={() => setPointsBreakdownOpen(false)}
                style={styles.closeBtn}
              >
                <X size={18} />
              </button>
            </div>

            {periodPoints.length === 0 ? (
              <div style={styles.empty}>まだポイントの記録がありません。</div>
            ) : (
              periodPoints.map((w) => (
                <div key={w.periodKey} style={styles.periodDetailBlock}>
                  <div style={styles.periodDetailHeader}>
                    <span style={styles.periodDetailTitle}>{formatPeriodLabel(w.periodKey)}</span>
                    <span style={styles.pointsValue}>
                      {w.reflected}pt
                      {w.excluded > 0 && (
                        <span style={styles.pointsExcluded}> ({w.excluded}pt)</span>
                      )}
                    </span>
                  </div>
                  <div style={styles.weeklyBreakdown}>
                    {w.weeks.map((wk) => (
                      <div key={wk.weekKey} style={styles.weeklyRow}>
                        <span style={styles.weeklyLabel}>{wk.weekIndex}週目</span>
                        <span style={styles.weeklyPoints}>
                          {wk.reflectedPoints.length > 0
                            ? `(${wk.reflectedPoints.join("pt, ")}pt)`
                            : "―"}
                          {wk.excludedPoints.length > 0 && (
                            <span style={styles.pointsExcluded}>
                              {" "}
                              反映外: {wk.excludedPoints.join("pt, ")}pt
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <section style={styles.statCard}>
        <div style={styles.rateBlock}>
          <span style={styles.rateNumber}>{stats.overall.rate.toFixed(1)}</span>
          <span style={styles.ratePercent}>%</span>
        </div>
        <div style={styles.rateLabel}>総合勝率（{stats.overall.win}勝{stats.overall.lose}敗{stats.overall.draw ? `${stats.overall.draw}分` : ""}・全{stats.overall.total}戦）</div>

        {streak.length > 0 && (
          <div style={styles.streakRow}>
            {streak.map((m) => (
              <span
                key={m.id}
                title={`${RESULTS[m.result].label} vs ${m.opponent}`}
                style={{
                  ...styles.streakDot,
                  color: RESULTS[m.result].color,
                  borderColor: RESULTS[m.result].color,
                }}
              >
                {RESULTS[m.result].short}
              </span>
            ))}
            <span style={styles.streakCaption}>新しい順</span>
          </div>
        )}
      </section>

      {/* Tournament win-rate trend chart */}
      {tournamentTrend.length > 0 && (
        <section style={styles.chartCard}>
          <div style={styles.chartHeader}>
            <Trophy size={14} color="#8a7a5c" strokeWidth={2.2} />
            <span style={styles.chartTitle}>大会別 勝率の推移</span>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={tournamentTrend} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="#e6ddc6" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 10, fill: "#8a7a5c" }}
                axisLine={{ stroke: "#d9cfb8" }}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10, fill: "#8a7a5c" }}
                axisLine={false}
                tickLine={false}
                width={30}
              />
              <Tooltip
                cursor={{ fill: "rgba(181,67,46,0.08)" }}
                contentStyle={{
                  fontSize: 12,
                  fontFamily: "'Zen Kaku Gothic New', sans-serif",
                  border: "1px solid #d9cfb8",
                  borderRadius: 4,
                  background: "#fdfaf4",
                }}
                formatter={(value) => [`${value}%`, "勝率"]}
                labelFormatter={(_, payload) =>
                  payload && payload[0] ? payload[0].payload.fullName : ""
                }
              />
              <Bar dataKey="rate" radius={[3, 3, 0, 0]} maxBarSize={34}>
                {tournamentTrend.map((entry, i) => (
                  <Cell key={i} fill={entry.rate >= 50 ? "#b5432e" : "#c9bda0"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}

      {/* Unified deck win-rate chart (mine + opponents', combined) */}
      {(matches || []).some((m) => (m.myDeck || "").trim() || (m.opponentDeck || "").trim()) && (
        <section style={styles.chartCard}>
          <div style={styles.chartHeader}>
            <Swords size={14} color="#8a7a5c" strokeWidth={2.2} />
            <span style={styles.chartTitle}>デッキ別 勝率（自分・相手 合算）</span>
            <div style={styles.weekNav}>
              <button
                onClick={() => setDeckRateWeekOffset((v) => v - 1)}
                style={styles.weekNavBtn}
              >
                <ChevronLeft size={13} />
              </button>
              <span style={styles.weekNavLabel}>
                {deckRateWeekOffset === 0
                  ? "今週"
                  : formatWeekLabel(toDateInputValue(deckRateWeekRange.start.toISOString()))}
              </span>
              <button
                onClick={() => setDeckRateWeekOffset((v) => Math.min(0, v + 1))}
                style={styles.weekNavBtn}
                disabled={deckRateWeekOffset >= 0}
              >
                <ChevronRight size={13} />
              </button>
            </div>
          </div>
          {unifiedDeckWinRates.length === 0 ? (
            <div style={styles.empty}>この週の記録はありません。</div>
          ) : (
            <>
          <ResponsiveContainer width="100%" height={210}>
            <PieChart>
              <Pie
                data={unifiedDeckWinRates}
                dataKey="total"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={72}
                label={renderUnifiedPieLabel}
                labelLine={false}
              >
                {unifiedDeckWinRates.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={
                      entry.rate >= 55
                        ? "#b5432e"
                        : entry.rate >= 45
                        ? "#c9a35a"
                        : "#33475b"
                    }
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  fontFamily: "'Zen Kaku Gothic New', sans-serif",
                  border: "1px solid #d9cfb8",
                  borderRadius: 4,
                  background: "#fdfaf4",
                }}
                formatter={(value, name, props) => [
                  `${props.payload.win}勝${props.payload.lose}敗${
                    props.payload.draw ? `${props.payload.draw}分` : ""
                  }（勝率${props.payload.rate.toFixed(0)}%）`,
                  name,
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div style={styles.recoNote}>
            自分が使った時と相手が使った時の結果を合算した、デッキタイプごとの総合的な勝率です。円の大きさは対戦数を表します。
          </div>
            </>
          )}
        </section>
      )}

      {/* Recommended decks based on matchup data */}
      {recommendation.length > 0 && (
        <section style={styles.chartCard}>
          <div style={styles.chartHeader}>
            <Sparkles size={14} color="#8a7a5c" strokeWidth={2.2} />
            <span style={styles.chartTitle}>次回の使用候補（データからの提案）</span>
          </div>
          <div style={styles.recoList}>
            {recommendation.map((r, i) => (
              <div key={r.myDeck} style={styles.recoRow}>
                <span style={styles.recoRank}>{i + 1}</span>
                <span style={styles.recoDeckName}>{r.myDeck}</span>
                <span style={styles.recoRate}>{r.expectedRate.toFixed(0)}%</span>
              </div>
            ))}
          </div>
          <div style={styles.recoNote}>
            対戦相手のデッキ傾向（土日は直近1週間・平日は前日を参照）と、デッキ相性の記録をもとに算出した期待勝率です。
          </div>

          {comboSuggestions.length > 0 && (
            <>
              <div style={styles.recoSubHeader}>自分のデッキ×相手のデッキ 組み合わせ提案</div>
              <div style={styles.recoList}>
                {comboSuggestions.map((s) => (
                  <div key={`${s.myDeck}-${s.opponentDeck}`} style={styles.recoRowAlt}>
                    <span style={styles.recoComboLabel}>
                      {s.myDeck} <span style={styles.recoVs}>vs</span> {s.opponentDeck}
                    </span>
                    <span style={styles.recoRate}>{s.rate.toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {(learnedMatchupSummary.favorable.length > 0 ||
            learnedMatchupSummary.unfavorable.length > 0) && (
            <>
              <div style={styles.recoSubHeader}>学習した有利・不利</div>
              <div style={styles.matchupSummaryGrid}>
                <div>
                  <div style={styles.matchupSummaryLabel}>有利</div>
                  {learnedMatchupSummary.favorable.map((c) => (
                    <div key={`f-${c.myDeck}-${c.opponentDeck}`} style={styles.matchupSummaryRow}>
                      <span style={styles.matchupSummaryText}>
                        {c.myDeck} vs {c.opponentDeck}
                      </span>
                      <span style={styles.matchupSummaryRateGood}>{c.rate.toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={styles.matchupSummaryLabel}>不利</div>
                  {learnedMatchupSummary.unfavorable.map((c) => (
                    <div key={`u-${c.myDeck}-${c.opponentDeck}`} style={styles.matchupSummaryRow}>
                      <span style={styles.matchupSummaryText}>
                        {c.myDeck} vs {c.opponentDeck}
                      </span>
                      <span style={styles.matchupSummaryRateBad}>{c.rate.toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {/* Manual counter-deck finder */}
      {allOpponentDeckNames.length > 0 && (
        <section style={styles.chartCard}>
          <div style={styles.chartHeader}>
            <Sparkles size={14} color="#8a7a5c" strokeWidth={2.2} />
            <span style={styles.chartTitle}>対策デッキを探す</span>
          </div>
          <div style={styles.recoNote}>
            対戦相手のデッキを選ぶと（複数選択可）、その組み合わせに対して勝ちやすい自分のデッキを3つ提案します。
          </div>
          <div style={styles.chipRow}>
            {allOpponentDeckNames.map((d) => (
              <button
                key={d}
                onClick={() => toggleCounterSearchOpponent(d)}
                style={{
                  ...styles.chip,
                  ...(counterSearchOpponents.includes(d) ? styles.chipActive : {}),
                }}
              >
                {deckIconMap[d] && (
                  <img src={deckIconMap[d]} alt="" style={styles.rowDeckIcon} />
                )}
                {d}
              </button>
            ))}
          </div>

          {counterDeckSuggestions.length > 0 && (
            <div style={styles.recoList}>
              {counterDeckSuggestions.map((s, i) => (
                <div key={s.myDeck} style={styles.counterDeckCard}>
                  <div style={styles.recoRow}>
                    <span style={styles.recoRank}>{i + 1}</span>
                    <span style={styles.recoDeckName}>
                      {deckIconMap[s.myDeck] && (
                        <img src={deckIconMap[s.myDeck]} alt="" style={styles.rowDeckIcon} />
                      )}
                      {s.myDeck}
                    </span>
                    <span style={styles.recoRate}>{s.avgRate.toFixed(0)}%</span>
                  </div>
                  <div style={styles.counterDeckDetail}>
                    {s.perOpponent.map((p) => (
                      <span key={p.opponentDeck} style={styles.counterDeckDetailChip}>
                        vs {p.opponentDeck} {p.rate.toFixed(0)}%
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Weekly opponent deck breakdown (pie chart) */}
      {weeklyOpponentDeckPie.length > 0 && (
        <section style={styles.chartCard}>
          <div style={styles.chartHeader}>
            <Swords size={14} color="#8a7a5c" strokeWidth={2.2} />
            <span style={styles.chartTitle}>週間 対戦相手デッキ内訳</span>
            <div style={styles.weekNav}>
              <button onClick={() => setPieWeekOffset((v) => v - 1)} style={styles.weekNavBtn}>
                <ChevronLeft size={13} />
              </button>
              <span style={styles.weekNavLabel}>
                {pieWeekOffset === 0 ? "今週" : formatWeekLabel(toDateInputValue(pieWeekRange.start.toISOString()))}
              </span>
              <button
                onClick={() => setPieWeekOffset((v) => Math.min(0, v + 1))}
                style={styles.weekNavBtn}
                disabled={pieWeekOffset >= 0}
              >
                <ChevronRight size={13} />
              </button>
            </div>
          </div>
          <div ref={weeklyPieRef}>
            <ResponsiveContainer width="100%" height={190}>
              <PieChart>
                <Pie
                  data={weeklyOpponentDeckPie}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={65}
                  label={renderOpponentPieLabel}
                  labelLine={false}
                >
                  {weeklyOpponentDeckPie.map((entry, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    fontSize: 12,
                    fontFamily: "'Zen Kaku Gothic New', sans-serif",
                    border: "1px solid #d9cfb8",
                    borderRadius: 4,
                    background: "#fdfaf4",
                  }}
                  formatter={(value, name, entry) => [
                    `${value}戦（${entry?.payload?.percentage?.toFixed(0) ?? 0}%）`,
                    name,
                  ]}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <button
            onClick={() =>
              downloadChartAsImage(
                weeklyPieRef.current,
                `週間対戦相手デッキ内訳_${toDateInputValue(pieWeekRange.start.toISOString())}.png`
              )
            }
            style={styles.viewWeeklyBtn}
          >
            <Download size={13} />
            画像として保存
          </button>
          <button onClick={downloadOpponentPieCSV} style={styles.viewWeeklyBtn}>
            <Download size={13} />
            表として保存（CSV）
          </button>
        </section>
      )}

      {/* Period points (Apr-Sep / Oct-Mar) */}
      {periodPoints.length > 0 && (
        <section style={styles.chartCard}>
          <div style={styles.chartHeader}>
            <Trophy size={14} color="#8a7a5c" strokeWidth={2.2} />
            <span style={styles.chartTitle}>期間獲得ポイント（週2つまで・チェックした大会は別枠で反映）</span>
          </div>
          <div style={styles.pointsList}>
            {periodPoints.map((w) => (
              <div key={w.periodKey} style={styles.pointsCard}>
                <div style={styles.pointsRow}>
                  <span style={styles.pointsWeekLabel}>{formatPeriodLabel(w.periodKey)}</span>
                  <span style={styles.pointsValue}>
                    {w.reflected}pt
                    {w.excluded > 0 && <span style={styles.pointsExcluded}> ({w.excluded}pt)</span>}
                  </span>
                </div>

                {(w.winnerPromo > 0 || w.best8Promo > 0) && (
                  <div style={styles.promoRow}>
                    <Award size={12} color="#c9a35a" />
                    {w.winnerPromo > 0 && (
                      <span style={styles.promoChip}>優勝プロモ ×{w.winnerPromo}</span>
                    )}
                    {w.best8Promo > 0 && (
                      <span style={styles.promoChip}>ベスト8プロモ ×{w.best8Promo}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button
            onClick={() => setPointsBreakdownOpen(true)}
            style={styles.viewWeeklyBtn}
          >
            <ListTree size={13} />
            週別の内訳を見る
          </button>
        </section>
      )}


      {(stats.byOpponent.length > 0 || stats.byOpponentDeck.length > 0 || stats.byMyDeck.length > 0 || stats.byTournament.length > 0 || stats.byTurnOrder.length > 0 || matchupAnalysis.length > 0) && (
        <section style={styles.breakdownSection}>
          <div style={styles.tabRow}>
            <button
              onClick={() => { setFilter("all"); setFilterValue(null); }}
              style={filter === "all" ? styles.tabActive : styles.tab}
            >
              すべて
            </button>
            {stats.byOpponent.length > 0 && (
              <button
                onClick={() => { setFilter("opponent"); setFilterValue(null); }}
                style={filter === "opponent" ? styles.tabActive : styles.tab}
              >
                相手別
              </button>
            )}
            {stats.byOpponentDeck.length > 0 && (
              <button
                onClick={() => { setFilter("opponentDeck"); setFilterValue(null); }}
                style={filter === "opponentDeck" ? styles.tabActive : styles.tab}
              >
                相手デッキ別
              </button>
            )}
            {stats.byMyDeck.length > 0 && (
              <button
                onClick={() => { setFilter("myDeck"); setFilterValue(null); }}
                style={filter === "myDeck" ? styles.tabActive : styles.tab}
              >
                自分デッキ別
              </button>
            )}
            {stats.byTournament.length > 0 && (
              <button
                onClick={() => { setFilter("tournament"); setFilterValue(null); }}
                style={filter === "tournament" ? styles.tabActive : styles.tab}
              >
                大会別
              </button>
            )}
            {stats.byTurnOrder.length > 0 && (
              <button
                onClick={() => { setFilter("turnOrder"); setFilterValue(null); }}
                style={filter === "turnOrder" ? styles.tabActive : styles.tab}
              >
                先手/後手別
              </button>
            )}
            {matchupAnalysis.length > 0 && (
              <button
                onClick={() => { setFilter("matchup"); setFilterValue(null); }}
                style={filter === "matchup" ? styles.tabActive : styles.tab}
              >
                デッキ相性
              </button>
            )}
          </div>

          {filter === "opponent" && (
            <>
              <input
                value={opponentSearchQuery}
                onChange={(e) => setOpponentSearchQuery(e.target.value)}
                placeholder="対戦相手の名前で検索"
                style={styles.searchInput}
              />
              <div style={styles.breakdownList}>
                {stats.byOpponent
                  .filter((row) =>
                    opponentSearchQuery.trim()
                      ? row.name.includes(opponentSearchQuery.trim())
                      : true
                  )
                  .map((row) => (
                    <button
                      key={row.name}
                      onClick={() => setFilterValue(filterValue === row.name ? null : row.name)}
                      style={{
                        ...styles.breakdownRow,
                        ...(filterValue === row.name ? styles.breakdownRowActive : {}),
                      }}
                    >
                      <span style={styles.breakdownName}>{row.name}</span>
                      <span style={styles.breakdownMeta}>
                        {row.win}勝{row.lose}敗{row.draw ? `${row.draw}分` : ""}
                      </span>
                      <span style={styles.breakdownRate}>{row.rate.toFixed(0)}%</span>
                    </button>
                  ))}
                {stats.byOpponent.filter((row) =>
                  opponentSearchQuery.trim() ? row.name.includes(opponentSearchQuery.trim()) : true
                ).length === 0 && <div style={styles.empty}>該当する対戦相手がいません。</div>}
              </div>
            </>
          )}

          {filter === "opponentDeck" && (
            <div style={styles.breakdownList}>
              {stats.byOpponentDeck.map((row) => (
                <button
                  key={row.name}
                  onClick={() => setFilterValue(filterValue === row.name ? null : row.name)}
                  style={{
                    ...styles.breakdownRow,
                    ...(filterValue === row.name ? styles.breakdownRowActive : {}),
                  }}
                >
                  <span style={styles.breakdownName}>{row.name}</span>
                  <span style={styles.breakdownMeta}>
                    {row.win}勝{row.lose}敗{row.draw ? `${row.draw}分` : ""}
                  </span>
                  <span style={styles.breakdownRate}>{row.rate.toFixed(0)}%</span>
                </button>
              ))}
            </div>
          )}

          {filter === "myDeck" && (
            <div style={styles.breakdownList}>
              {stats.byMyDeck.map((row) => (
                <button
                  key={row.name}
                  onClick={() => setFilterValue(filterValue === row.name ? null : row.name)}
                  style={{
                    ...styles.breakdownRow,
                    ...(filterValue === row.name ? styles.breakdownRowActive : {}),
                  }}
                >
                  <span style={styles.breakdownName}>{row.name}</span>
                  <span style={styles.breakdownMeta}>
                    {row.win}勝{row.lose}敗{row.draw ? `${row.draw}分` : ""}
                  </span>
                  <span style={styles.breakdownRate}>{row.rate.toFixed(0)}%</span>
                </button>
              ))}
            </div>
          )}

          {filter === "tournament" && (
            <>
              <input
                value={searchTournamentName}
                onChange={(e) => setSearchTournamentName(e.target.value)}
                placeholder="大会名で検索"
                style={styles.searchInput}
              />
              {(rankOptions.length > 0 || deckOptionsForSearch.length > 0) && (
                <div style={styles.searchRow}>
                  {rankOptions.length > 0 && (
                    <select
                      value={searchRank}
                      onChange={(e) => setSearchRank(e.target.value)}
                      style={styles.searchSelect}
                    >
                      <option value="">順位で絞り込み</option>
                      {rankOptions.map((r) => (
                        <option key={r} value={r}>
                          {r}位
                        </option>
                      ))}
                    </select>
                  )}
                  {deckOptionsForSearch.length > 0 && (
                    <select
                      value={searchDeck}
                      onChange={(e) => setSearchDeck(e.target.value)}
                      style={styles.searchSelect}
                    >
                      <option value="">デッキで絞り込み</option>
                      {deckOptionsForSearch.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
              <div style={styles.breakdownList}>
                {filteredTournamentRows.map((row) => {
                  const entries = tournamentPoints.filter(
                    (p) => p.tournament === row.name && p.date === row.date
                  );
                  const bestRank = entries
                    .filter((e) => e.rank != null)
                    .sort((a, b) => a.rank - b.rank)[0];
                  const isOpen = filterValue === row.key;
                  const rowMatches = isOpen
                    ? matches.filter(
                        (m) => tournamentSessionKey(m.tournament, toDateInputValue(m.date)) === row.key
                      )
                    : [];
                  return (
                    <div key={row.key}>
                      <button
                        onClick={() => setFilterValue(isOpen ? null : row.key)}
                        style={{
                          ...styles.breakdownRow,
                          ...(isOpen ? styles.breakdownRowActive : {}),
                        }}
                      >
                        <span style={styles.breakdownName}>
                          {row.name}
                          <span style={styles.breakdownDateTag}>
                            {row.date.slice(5).replace("-", "/")}
                          </span>
                        </span>
                        {bestRank && (
                          <span style={styles.rankBadge}>{bestRank.rank}位</span>
                        )}
                        {(tournamentPhotos[row.key] || []).length > 0 && (
                          <span style={styles.photoBadge}>
                            <Camera size={10} />
                            {tournamentPhotos[row.key].length}
                          </span>
                        )}
                        <span style={styles.breakdownMeta}>
                          {row.win}勝{row.lose}敗{row.draw ? `${row.draw}分` : ""}
                        </span>
                        <span style={styles.breakdownRate}>{row.rate.toFixed(0)}%</span>
                      </button>

                      {isOpen && (
                        <div style={styles.tournamentDetailBox}>
                          <button
                            onClick={() => openAddToTournament(row)}
                            style={styles.addMatchToTournamentBtn}
                          >
                            <Plus size={13} />
                            この大会に対戦を追加
                          </button>

                          {editingTournamentDateKey === row.key ? (
                            <div style={styles.tournamentDateEditRow}>
                              <input
                                type="date"
                                value={tournamentDateDraft}
                                onChange={(e) => setTournamentDateDraft(e.target.value)}
                                style={styles.inputSmall}
                              />
                              <button
                                onClick={() => {
                                  changeTournamentDate(row, tournamentDateDraft);
                                  setEditingTournamentDateKey(null);
                                }}
                                style={styles.dateConfirmBtn}
                              >
                                変更する
                              </button>
                              <button
                                onClick={() => setEditingTournamentDateKey(null)}
                                style={styles.boardDeleteBtn}
                              >
                                キャンセル
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => {
                                setEditingTournamentDateKey(row.key);
                                setTournamentDateDraft(row.date);
                              }}
                              style={styles.addMatchToTournamentBtn}
                            >
                              <CalendarIcon size={13} />
                              この大会の日付をまとめて変更
                            </button>
                          )}

                          {(() => {
                            const pointsEntry = tournamentPoints.find(
                              (p) => p.tournament === row.name && p.date === row.date
                            );
                            const isEditingPoints = editingTournamentPointsKey === row.key;
                            if (isEditingPoints) {
                              return (
                                <div style={styles.tournamentPointsEditBox}>
                                  <div style={styles.pointsRankRow}>
                                    <div style={{ flex: 1 }}>
                                      <label style={styles.fieldLabel}>獲得ポイント</label>
                                      <input
                                        type="number"
                                        inputMode="numeric"
                                        value={pointsEditDraft}
                                        onChange={(e) => setPointsEditDraft(e.target.value)}
                                        placeholder="例：12"
                                        style={styles.input}
                                      />
                                    </div>
                                    <div style={{ flex: 1 }}>
                                      <label style={styles.fieldLabel}>順位</label>
                                      <input
                                        type="number"
                                        inputMode="numeric"
                                        value={rankEditDraft}
                                        onChange={(e) => setRankEditDraft(e.target.value)}
                                        placeholder="例：1"
                                        style={styles.input}
                                      />
                                    </div>
                                  </div>
                                  <label style={styles.checkboxRow}>
                                    <input
                                      type="checkbox"
                                      checked={alwaysReflectEditDraft}
                                      onChange={(e) => setAlwaysReflectEditDraft(e.target.checked)}
                                    />
                                    週2枠に含めず、必ず合計ポイントに反映する
                                  </label>
                                  <div style={styles.tournamentDateEditRow}>
                                    <button
                                      onClick={() => {
                                        savePoints(
                                          row.name,
                                          row.date,
                                          pointsEditDraft,
                                          rankEditDraft,
                                          pointsEntry?.deck,
                                          alwaysReflectEditDraft
                                        );
                                        setEditingTournamentPointsKey(null);
                                      }}
                                      style={styles.dateConfirmBtn}
                                    >
                                      保存する
                                    </button>
                                    <button
                                      onClick={() => setEditingTournamentPointsKey(null)}
                                      style={styles.boardDeleteBtn}
                                    >
                                      キャンセル
                                    </button>
                                  </div>
                                </div>
                              );
                            }
                            return (
                              <button
                                onClick={() => {
                                  setEditingTournamentPointsKey(row.key);
                                  setPointsEditDraft(
                                    pointsEntry ? String(pointsEntry.points) : ""
                                  );
                                  setRankEditDraft(
                                    pointsEntry && pointsEntry.rank != null
                                      ? String(pointsEntry.rank)
                                      : ""
                                  );
                                  setAlwaysReflectEditDraft(!!pointsEntry?.alwaysReflect);
                                }}
                                style={styles.addMatchToTournamentBtn}
                              >
                                <Pencil size={13} />
                                {pointsEntry
                                  ? `ポイント・順位を編集（${pointsEntry.points}pt${
                                      pointsEntry.rank != null ? `・${pointsEntry.rank}位` : ""
                                    }${pointsEntry.alwaysReflect ? "・週2枠外" : ""}）`
                                  : "ポイント・順位を記録する"}
                              </button>
                            );
                          })()}

                          {rowMatches.length > 0 && (
                            <ul style={styles.list}>
                              {rowMatches.map((m) => (
                                <li key={m.id} style={styles.row}>
                                  <span
                                    style={{
                                      ...styles.resultBadge,
                                      color: RESULTS[m.result].color,
                                      background: RESULTS[m.result].bg,
                                    }}
                                  >
                                    {RESULTS[m.result].short}
                                  </span>
                                  <div style={styles.rowBody}>
                                    <div style={styles.rowTop}>
                                      <span style={styles.rowOpponent}>
                                        {m.opponent || (
                                          <span style={styles.rowOpponentBlank}>
                                            対戦相手未記入
                                          </span>
                                        )}
                                      </span>
                                      {m.opponentDeck && (
                                        <span style={styles.rowDeck}>
                                          {deckIconMap[m.opponentDeck] && (
                                            <img
                                              src={deckIconMap[m.opponentDeck]}
                                              alt=""
                                              style={styles.rowDeckIcon}
                                            />
                                          )}
                                          相手: {m.opponentDeck}
                                        </span>
                                      )}
                                      {m.myDeck && (
                                        <span style={styles.rowDeckMine}>
                                          {deckIconMap[m.myDeck] && (
                                            <img
                                              src={deckIconMap[m.myDeck]}
                                              alt=""
                                              style={styles.rowDeckIcon}
                                            />
                                          )}
                                          自分: {m.myDeck}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <div style={styles.rowActions}>
                                    <button
                                      onClick={() => openEdit(m)}
                                      aria-label="編集"
                                      style={styles.editBtn}
                                    >
                                      <Pencil size={14} strokeWidth={2} />
                                    </button>
                                    <button
                                      onClick={() => setConfirmDeleteId(m.id)}
                                      aria-label="削除"
                                      style={styles.deleteBtn}
                                    >
                                      <Trash2 size={15} strokeWidth={2} />
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}

                          <div style={styles.galleryLabel}>使用デッキリスト</div>
                          <div style={styles.gallery}>
                            {(tournamentPhotos[row.key] || []).map((p) => (
                              <div key={p.id} style={styles.galleryItem}>
                                <img
                                  src={p.dataUrl}
                                  alt="使用デッキリスト"
                                  style={styles.galleryImg}
                                  onClick={() =>
                                    setViewingPhoto({ kind: "tournament", tKey: row.key, ...p })
                                  }
                                />
                              </div>
                            ))}
                            <label style={styles.galleryAddTile}>
                              <input
                                type="file"
                                accept="image/*"
                                style={{ display: "none" }}
                                disabled={photoAddLoading}
                                onChange={(e) => handleAddPhotoToTournament(e, row.key)}
                              />
                              {photoAddLoading ? (
                                <Loader2 size={18} className="spin" color="#8a7a5c" />
                              ) : (
                                <>
                                  <Camera size={16} color="#8a7a5c" />
                                  <span style={styles.galleryAddText}>追加</span>
                                </>
                              )}
                            </label>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {filteredTournamentRows.length === 0 && (
                  <div style={styles.empty}>条件に合う大会がありません。</div>
                )}
              </div>
            </>
          )}

          {filter === "turnOrder" && (
            <div style={styles.breakdownList}>
              {stats.byTurnOrder.map((row) => (
                <button
                  key={row.key}
                  onClick={() => setFilterValue(filterValue === row.key ? null : row.key)}
                  style={{
                    ...styles.breakdownRow,
                    ...(filterValue === row.key ? styles.breakdownRowActive : {}),
                  }}
                >
                  <span style={styles.breakdownName}>{row.name}</span>
                  <span style={styles.breakdownMeta}>
                    {row.win}勝{row.lose}敗{row.draw ? `${row.draw}分` : ""}
                  </span>
                  <span style={styles.breakdownRate}>{row.rate.toFixed(0)}%</span>
                </button>
              ))}
            </div>
          )}

          {filter === "matchup" && (() => {
            const activeMatchupDeck =
              filteredMatchupAnalysis.find((d) => d.myDeck === selectedMatchupDeck) ||
              filteredMatchupAnalysis[0] ||
              null;
            return (
              <div style={styles.matchupList}>
                <input
                  value={matchupSearchQuery}
                  onChange={(e) => setMatchupSearchQuery(e.target.value)}
                  placeholder="デッキ名で検索（自分・相手どちらも）"
                  style={styles.searchInput}
                />
                {filteredMatchupAnalysis.length === 0 && (
                  <div style={styles.empty}>該当するデッキがありません。</div>
                )}
                {filteredMatchupAnalysis.length > 0 && (
                  <div style={styles.matchupDeckTabRow}>
                    {filteredMatchupAnalysis.map((deck) => (
                      <button
                        key={deck.myDeck}
                        onClick={() => setSelectedMatchupDeck(deck.myDeck)}
                        style={
                          activeMatchupDeck?.myDeck === deck.myDeck
                            ? styles.matchupDeckTabActive
                            : styles.matchupDeckTab
                        }
                      >
                        {deckIconMap[deck.myDeck] && (
                          <img
                            src={deckIconMap[deck.myDeck]}
                            alt=""
                            style={styles.rowDeckIcon}
                          />
                        )}
                        {deck.myDeck}
                      </button>
                    ))}
                  </div>
                )}

                {activeMatchupDeck && (
                  <div style={styles.matchupCard}>
                    <div style={styles.matchupCardHeader}>
                      <span style={styles.matchupDeckName}>
                        {deckIconMap[activeMatchupDeck.myDeck] && (
                          <img
                            src={deckIconMap[activeMatchupDeck.myDeck]}
                            alt=""
                            style={styles.rowDeckIcon}
                          />
                        )}
                        {activeMatchupDeck.myDeck}
                      </span>
                      <span style={styles.matchupCardRate}>
                        総合 {activeMatchupDeck.rate.toFixed(0)}%
                      </span>
                    </div>
                    {activeMatchupDeck.rows.map((row) => {
                      const pairKey = `${activeMatchupDeck.myDeck}__${row.opponentDeck}`;
                      const isOpen = expandedMatchupKey === pairKey;
                      const pairMatches = isOpen
                        ? (matches || [])
                            .filter((m) => {
                              const my = (m.myDeck || "").trim();
                              const opp = (m.opponentDeck || "").trim();
                              return (
                                (my === activeMatchupDeck.myDeck && opp === row.opponentDeck) ||
                                (my === row.opponentDeck && opp === activeMatchupDeck.myDeck)
                              );
                            })
                            .sort((a, b) => new Date(b.date) - new Date(a.date))
                        : [];
                      return (
                        <div key={row.opponentDeck}>
                          <button
                            onClick={() => setExpandedMatchupKey(isOpen ? null : pairKey)}
                            style={styles.matchupRowBtn}
                          >
                            <span style={styles.matchupOpponent}>
                              {deckIconMap[row.opponentDeck] && (
                                <img
                                  src={deckIconMap[row.opponentDeck]}
                                  alt=""
                                  style={styles.rowDeckIcon}
                                />
                              )}
                              vs {row.opponentDeck}
                            </span>
                            <span style={styles.matchupMeta}>
                              {row.win}勝{row.lose}敗{row.draw ? `${row.draw}分` : ""}
                            </span>
                            <span
                              style={{
                                ...styles.matchupRate,
                                color: row.rate >= 50 ? "#b5432e" : "#33475b",
                              }}
                            >
                              {row.rate.toFixed(0)}%
                            </span>
                          </button>

                          {isOpen && (
                            <ul style={styles.list}>
                              {pairMatches.map((m) => (
                                <li key={m.id} style={styles.row}>
                                  <span
                                    style={{
                                      ...styles.resultBadge,
                                      color: RESULTS[m.result].color,
                                      background: RESULTS[m.result].bg,
                                    }}
                                  >
                                    {RESULTS[m.result].short}
                                  </span>
                                  <div style={styles.rowBody}>
                                    <div style={styles.rowTop}>
                                      <span style={styles.rowOpponent}>
                                        {m.opponent || (
                                          <span style={styles.rowOpponentBlank}>
                                            対戦相手未記入
                                          </span>
                                        )}
                                      </span>
                                      <span style={styles.rowDeck}>
                                        自分:{m.myDeck} 相手:{m.opponentDeck}
                                      </span>
                                    </div>
                                    <div style={styles.rowBottom}>
                                      <span>{formatDate(m.date)}</span>
                                      {m.tournament && (
                                        <span style={styles.rowTournament}>・{m.tournament}</span>
                                      )}
                                    </div>
                                  </div>
                                  <div style={styles.rowActions}>
                                    <button
                                      onClick={() => openEdit(m)}
                                      aria-label="編集"
                                      style={styles.editBtn}
                                    >
                                      <Pencil size={14} strokeWidth={2} />
                                    </button>
                                    <button
                                      onClick={() => setConfirmDeleteId(m.id)}
                                      aria-label="削除"
                                      style={styles.deleteBtn}
                                    >
                                      <Trash2 size={15} strokeWidth={2} />
                                    </button>
                                  </div>
                                </li>
                              ))}
                              {pairMatches.length === 0 && (
                                <div style={styles.empty}>該当する記録がありません。</div>
                              )}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                    {activeMatchupDeck.rows.some(
                      (r) => r.firstRate != null || r.secondRate != null
                    ) && (
                      <div style={styles.matchupTurnList}>
                        {activeMatchupDeck.rows
                          .filter((r) => r.firstRate != null || r.secondRate != null)
                          .map((row) => (
                            <div key={`turn-${row.opponentDeck}`} style={styles.matchupTurnRow}>
                              <span style={styles.matchupTurnLabel}>vs {row.opponentDeck}</span>
                              <span style={styles.matchupTurnValue}>
                                先手{row.firstRate != null ? `${row.firstRate.toFixed(0)}%` : "―"}
                                　後手
                                {row.secondRate != null ? `${row.secondRate.toFixed(0)}%` : "―"}
                              </span>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                )}
                {matchupAnalysis.length > 0 && (
                  <button onClick={downloadMatchupCSV} style={styles.viewWeeklyBtn}>
                    <Download size={13} />
                    相性データを表として保存（CSV）
                  </button>
                )}
              </div>
            );
          })()}
        </section>
      )}

      {/* Match log */}
      <section style={styles.logSection}>
        <div style={styles.logHeader}>
          <span style={styles.logTitle}>
            記録
            {filterValue ? `（${filterValue}）` : ""}
          </span>
          <span style={styles.logCount}>{searchedMatches.length}件</span>
        </div>

        <input
          value={opponentSearchQuery}
          onChange={(e) => setOpponentSearchQuery(e.target.value)}
          placeholder="対戦相手の名前で検索"
          style={styles.opponentSearchInput}
        />

        {searchedMatches.length === 0 ? (
          <div style={styles.empty}>
            {opponentSearchQuery.trim()
              ? "該当する記録がありません。"
              : "まだ記録がありません。右下の＋から対戦結果を追加してください。"}
          </div>
        ) : (
          <ul style={styles.list}>
            {searchedMatches.map((m) => (
              <li key={m.id} style={styles.row}>
                <span
                  style={{
                    ...styles.resultBadge,
                    color: RESULTS[m.result].color,
                    background: RESULTS[m.result].bg,
                  }}
                >
                  {RESULTS[m.result].short}
                </span>
                <div style={styles.rowBody}>
                  <div style={styles.rowTop}>
                    <span style={styles.rowOpponent}>
                      {m.opponent || (
                        <span style={styles.rowOpponentBlank}>対戦相手未記入</span>
                      )}
                    </span>
                    {m.turnOrder && (
                      <span style={styles.rowTurn}>{TURN_ORDERS[m.turnOrder].label}</span>
                    )}
                    {m.opponentDeck && (
                      <span style={styles.rowDeck}>
                        {deckIconMap[m.opponentDeck] && (
                          <img src={deckIconMap[m.opponentDeck]} alt="" style={styles.rowDeckIcon} />
                        )}
                        相手: {m.opponentDeck}
                      </span>
                    )}
                    {m.myDeck && (
                      <span style={styles.rowDeckMine}>
                        {deckIconMap[m.myDeck] && (
                          <img src={deckIconMap[m.myDeck]} alt="" style={styles.rowDeckIcon} />
                        )}
                        自分: {m.myDeck}
                      </span>
                    )}
                  </div>
                  <div style={styles.rowBottom}>
                    <span>{formatDate(m.date)}</span>
                    {m.tournament && <span style={styles.rowTournament}>・{m.tournament}</span>}
                    {m.note && <span style={styles.rowNote}>・{m.note}</span>}
                  </div>
                </div>
                <div style={styles.rowActions}>
                  <button
                    onClick={() => openEdit(m)}
                    aria-label="編集"
                    style={styles.editBtn}
                  >
                    <Pencil size={14} strokeWidth={2} />
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(m.id)}
                    aria-label="削除"
                    style={styles.deleteBtn}
                  >
                    <Trash2 size={15} strokeWidth={2} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <div style={styles.errorBanner}>{error}</div>}

      {/* Home button */}
      <button
        onClick={() => {
          setFilter("all");
          setFilterValue(null);
          setCalendarOpen(false);
          setDeckDbOpen(false);
          setChatOpen(false);
          setLinksOpen(false);
          setDataManageOpen(false);
          setPointsBreakdownOpen(false);
          setSelectedDate(null);
          setShowForm(false);
          setEditingId(null);
          setProfileForm(false);
          setBoardManage(null);
          setViewingPhoto(null);
          setBatchMode(false);
          setOcrError(null);
        }}
        style={styles.homeBtn}
        aria-label="ホームに戻る"
      >
        <Home size={20} color="#5c5240" strokeWidth={2} />
      </button>

      {/* FAB */}
      <button
        onClick={() => {
          setEditingId(null);
          setOpponent("");
          setOpponentDeck("");
          setMyDeck("");
          setNote("");
          setResult("win");
          setTurnOrder(null);
          setBatchMode(false);
          setMatchDate(selectedDate || todayInputValue());
          setPoints("");
          setRank("");
          setAlwaysReflect(false);
          setShowForm(true);
        }}
        style={styles.fab}
        aria-label="対戦結果を追加"
      >
        <Plus size={24} color="#fdfaf4" strokeWidth={2.4} />
      </button>

      {/* Add form modal */}
      {showForm && (
        <div style={styles.modalOverlay} onClick={closeForm}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>
                {editingId ? "対戦を編集" : batchMode ? "大会の結果をまとめて記録" : "対戦を記録"}
              </span>
              <button onClick={closeForm} style={styles.closeBtn}>
                <X size={18} />
              </button>
            </div>

            {!editingId && (
              <div style={styles.modeToggleRow}>
                <button
                  onClick={() => setBatchMode(false)}
                  style={!batchMode ? styles.modeTabActive : styles.modeTab}
                >
                  1件ずつ
                </button>
                <button
                  onClick={() => setBatchMode(true)}
                  style={batchMode ? styles.modeTabActive : styles.modeTab}
                >
                  大会をまとめて
                </button>
              </div>
            )}

            <label style={styles.fieldLabel}>日付</label>
            <input
              type="date"
              value={matchDate}
              onChange={(e) => setMatchDate(e.target.value)}
              style={styles.input}
            />

            <label style={styles.fieldLabel}>大会名（任意）</label>
            <input
              value={tournament}
              onChange={(e) => setTournament(e.target.value)}
              placeholder="例：8月度チャンピオンシップ"
              style={styles.input}
            />
            {recentTournaments.length > 0 && (
              <div style={styles.chipRow}>
                {recentTournaments.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTournament(t)}
                    style={{
                      ...styles.chip,
                      ...(tournament === t ? styles.chipActive : {}),
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}

            <div style={styles.pointsRankRow}>
              <div style={{ flex: 1 }}>
                <label style={styles.fieldLabel}>獲得ポイント（任意）</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={points}
                  onChange={(e) => setPoints(e.target.value)}
                  placeholder="例：12"
                  style={styles.input}
                  disabled={!tournament.trim()}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={styles.fieldLabel}>順位（任意）</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={rank}
                  onChange={(e) => setRank(e.target.value)}
                  placeholder="例：1"
                  style={styles.input}
                  disabled={!tournament.trim()}
                />
              </div>
            </div>
            {!tournament.trim() && (
              <div style={styles.hintText}>大会名を入力するとポイント・順位を記録できます</div>
            )}
            {tournament.trim() && (
              <label style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={alwaysReflect}
                  onChange={(e) => setAlwaysReflect(e.target.checked)}
                />
                週2枠に含めず、必ず合計ポイントに反映する
              </label>
            )}

            {!batchMode ? (
              <>
                <div style={styles.resultPicker}>
                  {Object.entries(RESULTS).map(([key, val]) => (
                    <button
                      key={key}
                      onClick={() => setResult(key)}
                      style={{
                        ...styles.resultOption,
                        borderColor: val.color,
                        background: result === key ? val.color : "transparent",
                        color: result === key ? "#fdfaf4" : val.color,
                      }}
                    >
                      {val.short} {val.label}
                    </button>
                  ))}
                </div>

                <div style={styles.turnPicker}>
                  {Object.entries(TURN_ORDERS).map(([key, val]) => (
                    <button
                      key={key}
                      onClick={() => setTurnOrder(turnOrder === key ? null : key)}
                      style={{
                        ...styles.turnOption,
                        ...(turnOrder === key ? styles.turnOptionActive : {}),
                      }}
                    >
                      {val.short} {val.label}
                    </button>
                  ))}
                </div>

                <label style={styles.fieldLabel}>対戦相手（任意）</label>
                <input
                  value={opponent}
                  onChange={(e) => setOpponent(e.target.value)}
                  placeholder="例：たなかさん／未記入でも可"
                  style={styles.input}
                />

                <label style={styles.fieldLabel}>相手のデッキタイプ（任意）</label>
                <input
                  value={opponentDeck}
                  onChange={(e) => setOpponentDeck(e.target.value)}
                  placeholder="例：赤単アグロ"
                  style={styles.input}
                />
                {recentOpponentDecks.length > 0 && (
                  <div style={styles.chipRow}>
                    {recentOpponentDecks.map((d) => (
                      <button
                        key={d}
                        onClick={() => setOpponentDeck(d)}
                        style={{
                          ...styles.chip,
                          ...(opponentDeck === d ? styles.chipActive : {}),
                        }}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                )}

                <label style={styles.fieldLabel}>自分の使用デッキ（任意）</label>
                <input
                  value={myDeck}
                  onChange={(e) => setMyDeck(e.target.value)}
                  placeholder="例：青白コントロール"
                  style={styles.input}
                />
                {recentMyDecks.length > 0 && (
                  <div style={styles.chipRow}>
                    {recentMyDecks.map((d) => (
                      <button
                        key={d}
                        onClick={() => setMyDeck(d)}
                        style={{
                          ...styles.chip,
                          ...(myDeck === d ? styles.chipActive : {}),
                        }}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                )}

                <label style={styles.fieldLabel}>メモ（任意）</label>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="一言メモ"
                  style={styles.input}
                />

                <button onClick={addMatch} style={styles.submitBtn}>
                  {editingId ? "更新する" : "記録する"}
                </button>
              </>
            ) : (
              <>
                <label style={styles.fieldLabel}>自分の使用デッキ（任意・全戦共通）</label>
                <input
                  value={myDeck}
                  onChange={(e) => setMyDeck(e.target.value)}
                  placeholder="例：青白コントロール"
                  style={styles.input}
                />
                {recentMyDecks.length > 0 && (
                  <div style={styles.chipRow}>
                    {recentMyDecks.map((d) => (
                      <button
                        key={d}
                        onClick={() => setMyDeck(d)}
                        style={{
                          ...styles.chip,
                          ...(myDeck === d ? styles.chipActive : {}),
                        }}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                )}

                <label style={styles.photoUploadBtn}>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    style={{ display: "none" }}
                    disabled={ocrLoading}
                  />
                  {ocrLoading ? (
                    <>
                      <Loader2 size={14} className="spin" />
                      読み取り中…
                    </>
                  ) : (
                    <>
                      <Camera size={14} />
                      デッキの写真から読み込む
                    </>
                  )}
                </label>
                {ocrError && <div style={styles.ocrErrorText}>{ocrError}</div>}
                {(tournamentPhotos[tournament.trim() || UNASSIGNED] || []).length > 0 && (
                  <div style={styles.photoSavedNote}>
                    この大会に写真を{tournamentPhotos[tournament.trim() || UNASSIGNED].length}枚保存済み（あとで振り返りタブから確認できます）
                  </div>
                )}

                <div style={styles.batchList}>
                  {batchRounds.map((r, idx) => (
                    <div key={r.id} style={styles.batchRound}>
                      <div style={styles.batchRoundHeader}>
                        <span style={styles.batchRoundLabel}>第{idx + 1}戦</span>
                        {batchRounds.length > 1 && (
                          <button
                            onClick={() => removeRound(r.id)}
                            style={styles.batchRemoveBtn}
                            aria-label="この対戦を削除"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>

                      <div style={styles.batchOptionRow}>
                        {Object.entries(RESULTS).map(([key, val]) => (
                          <button
                            key={key}
                            onClick={() => updateRound(r.id, { result: key })}
                            style={{
                              ...styles.batchResultOption,
                              borderColor: val.color,
                              background: r.result === key ? val.color : "transparent",
                              color: r.result === key ? "#fdfaf4" : val.color,
                            }}
                          >
                            {val.short}
                          </button>
                        ))}
                        <span style={styles.batchDivider} />
                        {Object.entries(TURN_ORDERS).map(([key, val]) => (
                          <button
                            key={key}
                            onClick={() =>
                              updateRound(r.id, {
                                turnOrder: r.turnOrder === key ? null : key,
                              })
                            }
                            style={{
                              ...styles.batchTurnOption,
                              ...(r.turnOrder === key ? styles.turnOptionActive : {}),
                            }}
                          >
                            {val.short}
                          </button>
                        ))}
                      </div>

                      <input
                        value={r.opponent}
                        onChange={(e) => updateRound(r.id, { opponent: e.target.value })}
                        placeholder="対戦相手（任意）"
                        style={styles.inputSmall}
                      />
                      {filterNames(allOpponentNames, r.opponent, 5).length > 0 && (
                        <div style={styles.chipRowTight}>
                          {filterNames(allOpponentNames, r.opponent, 5).map((n) => (
                            <button
                              key={n}
                              onClick={() => updateRound(r.id, { opponent: n })}
                              style={{
                                ...styles.chipSmall,
                                ...(r.opponent === n ? styles.chipActive : {}),
                              }}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      )}
                      <input
                        value={r.opponentDeck}
                        onChange={(e) => updateRound(r.id, { opponentDeck: e.target.value })}
                        placeholder="相手のデッキタイプ（任意）"
                        style={styles.inputSmall}
                      />
                      {filterNames(allOpponentDeckNames, r.opponentDeck, 5).length > 0 && (
                        <div style={styles.chipRowTight}>
                          {filterNames(allOpponentDeckNames, r.opponentDeck, 5).map((d) => (
                            <button
                              key={d}
                              onClick={() => updateRound(r.id, { opponentDeck: d })}
                              style={{
                                ...styles.chipSmall,
                                ...(r.opponentDeck === d ? styles.chipActive : {}),
                              }}
                            >
                              {d}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <button onClick={addRound} style={styles.addRoundBtn}>
                  ＋ 対戦を追加
                </button>

                <button onClick={submitBatch} style={styles.submitBtn}>
                  {batchRounds.length}件まとめて記録する
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Opponent deck profile form modal */}
      {profileForm && (
        <div style={styles.modalOverlay} onClick={closeProfileForm}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>
                {editingProfileId ? "相手デッキを編集" : "相手デッキを登録"}
              </span>
              <button onClick={closeProfileForm} style={styles.closeBtn}>
                <X size={18} />
              </button>
            </div>

            <label style={styles.fieldLabel}>大まかなデッキタイプ</label>
            <input
              value={profileDeckType}
              onChange={(e) => setProfileDeckType(e.target.value)}
              placeholder="例：赤単アグロ"
              style={styles.input}
              autoFocus
            />
            {filterNames(allOpponentDeckNames, profileDeckType).length > 0 && (
              <div style={styles.chipRow}>
                {filterNames(allOpponentDeckNames, profileDeckType).map((d) => (
                  <button
                    key={d}
                    onClick={() => setProfileDeckType(d)}
                    style={{
                      ...styles.chip,
                      ...(profileDeckType === d ? styles.chipActive : {}),
                    }}
                  >
                    {d}
                  </button>
                ))}
              </div>
            )}

            <label style={styles.fieldLabel}>
              系統（任意・デッキ提案の相性推定に使われます）
            </label>
            <div style={styles.turnPicker}>
              {DECK_CATEGORIES.map((c) => (
                <button
                  key={c}
                  onClick={() => setProfileCategory(profileCategory === c ? "" : c)}
                  style={{
                    ...styles.turnOption,
                    ...(profileCategory === c ? styles.turnOptionActive : {}),
                  }}
                >
                  {c}
                </button>
              ))}
            </div>

            <label style={styles.fieldLabel}>
              類似デッキ（任意・複数選択可、相性データが無い相手デッキの勝率推定に使われます）
            </label>
            {allOpponentDeckNames.filter((d) => d !== profileDeckType.trim()).length > 0 ? (
              <div style={styles.chipRow}>
                {allOpponentDeckNames
                  .filter((d) => d !== profileDeckType.trim())
                  .map((d) => (
                    <button
                      key={d}
                      onClick={() => toggleProfileSimilarDeck(d)}
                      style={{
                        ...styles.chip,
                        ...(profileSimilarDecks.includes(d) ? styles.chipActive : {}),
                      }}
                    >
                      {d}
                    </button>
                  ))}
              </div>
            ) : (
              <div style={styles.hintText}>
                他のデッキタイプが記録されると、ここから選べるようになります
              </div>
            )}

            <label style={styles.fieldLabel}>
              アイコン画像（任意、円グラフに反映されます）
            </label>
            <div style={styles.iconUploadRow}>
              {profileIconImage ? (
                <div style={styles.iconPreviewWrap}>
                  <img src={profileIconImage} alt="アイコン" style={styles.iconPreviewImg} />
                  <button
                    onClick={() => setProfileIconImage("")}
                    style={styles.galleryRemoveBtn}
                    aria-label="アイコンを削除"
                  >
                    <X size={11} color="#fdfaf4" />
                  </button>
                </div>
              ) : (
                <label style={styles.iconUploadTile}>
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    disabled={profileIconLoading}
                    onChange={handleProfileIconUpload}
                  />
                  {profileIconLoading ? (
                    <Loader2 size={16} className="spin" color="#8a7a5c" />
                  ) : (
                    <Camera size={16} color="#8a7a5c" />
                  )}
                </label>
              )}
            </div>

            <label style={styles.fieldLabel}>フィニッシュ・勝ち筋（任意）</label>
            <input
              value={profileFinish}
              onChange={(e) => setProfileFinish(e.target.value)}
              placeholder="例：〇〇+△△の無限コンボ"
              style={styles.input}
            />

            <label style={styles.fieldLabel}>サンプルリストの写真（任意）</label>
            <div style={styles.gallery}>
              {profilePhotos.map((ph) => (
                <div key={ph.id} style={styles.galleryItem}>
                  <img src={ph.dataUrl} alt="サンプルリスト" style={styles.galleryImg} />
                  <button
                    onClick={() => removeProfilePhoto(ph.id)}
                    style={styles.galleryRemoveBtn}
                    aria-label="写真を削除"
                  >
                    <X size={11} color="#fdfaf4" />
                  </button>
                </div>
              ))}
              <label style={styles.galleryAddTile}>
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  disabled={profilePhotoLoading}
                  onChange={handleProfilePhotoUpload}
                />
                {profilePhotoLoading ? (
                  <Loader2 size={18} className="spin" color="#8a7a5c" />
                ) : (
                  <>
                    <Camera size={16} color="#8a7a5c" />
                    <span style={styles.galleryAddText}>追加</span>
                  </>
                )}
              </label>
            </div>

            <button
              onClick={saveProfile}
              style={styles.submitBtn}
              disabled={!profileDeckType.trim()}
            >
              {editingProfileId ? "更新する" : "登録する"}
            </button>
          </div>
        </div>
      )}

      {/* Export password PIN modal */}
      {exportPinOpen && (
        <div style={styles.gatePinOverlay}>
          <button
            onClick={() => setExportPinOpen(false)}
            style={styles.gatePinCloseBtn}
            aria-label="閉じる"
          >
            <X size={20} color="#f2efe8" />
          </button>

          <div style={styles.gatePinTop}>
            <span style={styles.gatePinTitle}>書き出し用パスワード</span>
            <p style={styles.gatePinDesc}>
              {exportPinTextMode
                ? "ファイルを暗号化するパスワードを入力してください。空のままでも確定できます。"
                : "数字で設定できます。空のまま右下のボタンで暗号化なしにできます。"}
            </p>
          </div>

          {exportPinTextMode ? (
            <div style={styles.gateTextBox}>
              <input
                type="password"
                value={exportPinDraft}
                onChange={(e) => setExportPinDraft(e.target.value)}
                placeholder="パスワード（任意）"
                style={styles.gateTextInput}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmExportPin();
                }}
              />
              <button onClick={() => confirmExportPin()} style={styles.submitBtn}>
                決定
              </button>
              <button
                onClick={() => {
                  setExportPinTextMode(false);
                  setExportPinDraft("");
                }}
                style={styles.gatePinSwitchBtn}
              >
                数字パッドに戻る
              </button>
            </div>
          ) : (
            (() => {
              const maxLen = 6;
              const digits = exportPinDraft.replace(/\D/g, "").slice(0, maxLen);
              const tapDigit = (d) => {
                if (digits.length >= maxLen) return;
                const next = digits + d;
                setExportPinDraft(next);
                if (next.length === maxLen) {
                  setTimeout(() => confirmExportPin(next), 80);
                }
              };
              const tapBackspace = () => setExportPinDraft(digits.slice(0, -1));
              return (
                <>
                  <div style={styles.gatePinDots}>
                    {Array.from({ length: maxLen }).map((_, i) => (
                      <span
                        key={i}
                        style={{
                          ...styles.gatePinDot,
                          ...(i < digits.length ? styles.gatePinDotFilled : {}),
                        }}
                      />
                    ))}
                  </div>

                  <div style={styles.gatePinGrid}>
                    {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                      <button key={d} onClick={() => tapDigit(d)} style={styles.gatePinKey}>
                        {d}
                      </button>
                    ))}
                    <button
                      onClick={() => confirmExportPin(digits)}
                      style={styles.gatePinKeyIcon}
                      aria-label="この内容で確定"
                    >
                      <Check size={22} />
                    </button>
                    <button onClick={() => tapDigit("0")} style={styles.gatePinKey}>
                      0
                    </button>
                    <button
                      onClick={tapBackspace}
                      style={styles.gatePinKeyIcon}
                      aria-label="1文字削除"
                    >
                      <Delete size={20} />
                    </button>
                  </div>

                  <button
                    onClick={() => {
                      setExportPinTextMode(true);
                      setExportPinDraft("");
                    }}
                    style={styles.gatePinTextLink}
                  >
                    パスワードを文字で入力する
                  </button>
                </>
              );
            })()
          )}
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDeleteId && (() => {
        const target = (matches || []).find((m) => m.id === confirmDeleteId);
        if (!target) return null;
        return (
          <div style={styles.modalOverlay} onClick={() => setConfirmDeleteId(null)}>
            <div style={styles.confirmDialog} onClick={(e) => e.stopPropagation()}>
              <div style={styles.confirmTitle}>この記録を削除しますか？</div>
              <div style={styles.confirmDetail}>
                {formatDate(target.date)}
                {target.opponent ? `　vs ${target.opponent}` : ""}
                {target.tournament ? `　${target.tournament}` : ""}
                　{RESULTS[target.result]?.label}
              </div>
              <div style={styles.confirmActions}>
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  style={styles.confirmCancelBtn}
                >
                  キャンセル
                </button>
                <button
                  onClick={() => deleteMatch(confirmDeleteId)}
                  style={styles.confirmDeleteBtn}
                >
                  削除する
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Photo lightbox */}
      {viewingPhoto && (
        <div style={styles.lightboxOverlay} onClick={() => setViewingPhoto(null)}>
          <div style={styles.lightboxTop}>
            <button
              onClick={() => {
                if (viewingPhoto.kind === "profile") {
                  persistProfiles(
                    deckProfiles.map((d) =>
                      d.id === viewingPhoto.profileId
                        ? { ...d, photos: (d.photos || []).filter((ph) => ph.id !== viewingPhoto.id) }
                        : d
                    )
                  );
                } else {
                  deletePhoto(viewingPhoto.tKey, viewingPhoto.id);
                }
                setViewingPhoto(null);
              }}
              style={styles.lightboxDeleteBtn}
            >
              <Trash2 size={15} />
              削除
            </button>
            <button onClick={() => setViewingPhoto(null)} style={styles.lightboxCloseBtn}>
              <X size={20} color="#fdfaf4" />
            </button>
          </div>
          <img
            src={viewingPhoto.dataUrl}
            alt="大会の写真"
            style={styles.lightboxImg}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `今日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const fontImport = `
  @import url('https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap');
  .spin { animation: br-spin 0.9s linear infinite; }
  @keyframes br-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f4efe3",
    backgroundImage:
      "radial-gradient(circle at 1px 1px, rgba(120,100,70,0.07) 1px, transparent 0)",
    backgroundSize: "16px 16px",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
    color: "#2b2620",
    paddingBottom: 96,
    position: "relative",
  },
  gatePage: {
    minHeight: "100vh",
    background: "#f4efe3",
    backgroundImage:
      "radial-gradient(circle at 1px 1px, rgba(120,100,70,0.07) 1px, transparent 0)",
    backgroundSize: "16px 16px",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
    color: "#2b2620",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  gateCard: {
    width: "100%",
    maxWidth: 380,
    background: "#fdfaf4",
    border: "1px solid #d9cfb8",
    borderRadius: 8,
    padding: "26px 22px",
    boxShadow: "2px 2px 0 rgba(90,70,40,0.08)",
  },
  gateHeaderRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  gateDesc: {
    fontSize: 12,
    color: "#8a7a5c",
    lineHeight: 1.7,
    marginBottom: 16,
  },
  gatePinPage: {
    minHeight: "100vh",
    background: "#242926",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
    boxSizing: "border-box",
  },
  gatePinOverlay: {
    position: "fixed",
    inset: 0,
    background: "#242926",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "40px 24px",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
    boxSizing: "border-box",
    zIndex: 90,
  },
  gatePinCloseBtn: {
    position: "absolute",
    top: 20,
    right: 20,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    padding: 6,
  },
  gatePinTop: {
    textAlign: "center",
    marginBottom: 28,
  },
  gatePinTitle: {
    display: "block",
    fontFamily: "'Shippori Mincho', serif",
    fontSize: 22,
    fontWeight: 700,
    color: "#f2efe8",
    letterSpacing: "0.06em",
    marginBottom: 10,
  },
  gatePinDesc: {
    fontSize: 12,
    color: "rgba(242,239,232,0.55)",
    lineHeight: 1.7,
    maxWidth: 280,
    margin: "0 auto",
  },
  gatePinDots: {
    display: "flex",
    justifyContent: "center",
    gap: 14,
    marginBottom: 14,
  },
  gatePinDot: {
    width: 12,
    height: 12,
    borderRadius: "50%",
    border: "1.5px solid rgba(242,239,232,0.5)",
    background: "transparent",
    boxSizing: "border-box",
  },
  gatePinDotFilled: {
    background: "#f2efe8",
    borderColor: "#f2efe8",
  },
  gatePinError: {
    fontSize: 11.5,
    color: "#e0897a",
    textAlign: "center",
    marginBottom: 10,
  },
  gatePinGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    columnGap: 34,
    rowGap: 6,
    marginTop: 12,
  },
  gatePinKey: {
    width: 78,
    height: 78,
    borderRadius: "50%",
    border: "none",
    background: "transparent",
    color: "rgba(242,239,232,0.92)",
    fontSize: 32,
    fontWeight: 400,
    cursor: "pointer",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
  },
  gatePinKeyIcon: {
    width: 78,
    height: 78,
    borderRadius: "50%",
    border: "none",
    background: "transparent",
    color: "rgba(242,239,232,0.75)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  gatePinTextLink: {
    marginTop: 28,
    border: "none",
    background: "transparent",
    color: "rgba(242,239,232,0.55)",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
    textDecoration: "underline",
  },
  gatePinSwitchBtn: {
    marginTop: 14,
    width: "100%",
    border: "none",
    background: "transparent",
    color: "rgba(242,239,232,0.55)",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
    textDecoration: "underline",
  },
  gateTextBox: {
    width: "100%",
    maxWidth: 300,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  gateTextInput: {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 14px",
    borderRadius: 8,
    border: "1px solid rgba(242,239,232,0.25)",
    background: "rgba(242,239,232,0.06)",
    color: "#f2efe8",
    fontSize: 15,
    fontFamily: "inherit",
  },
  loading: {
    padding: 40,
    textAlign: "center",
    color: "#7a6f5d",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
  },
  header: {
    padding: "28px 20px 14px",
    borderBottom: "1px solid #d9cfb8",
  },
  headerRow: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", rowGap: 6 },
  title: {
    fontFamily: "'Shippori Mincho', serif",
    fontSize: 26,
    fontWeight: 700,
    margin: 0,
    letterSpacing: "0.04em",
  },
  headerSub: {
    fontSize: 12,
    color: "#8a7a5c",
    marginTop: 4,
    letterSpacing: "0.05em",
  },
  calendarToggleBtn: {
    width: 30,
    height: 30,
    borderRadius: "50%",
    border: "1px solid #d9cfb8",
    background: "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  headerIconGroup: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    rowGap: 6,
  },
  calendarCard: {
    margin: "0 20px",
    padding: "14px 14px 10px",
    background: "#fdfaf4",
    border: "1px solid #d9cfb8",
    borderTop: "none",
    borderRadius: "0 0 4px 4px",
  },
  calendarNav: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  calendarNavBtn: {
    border: "1px solid #d9cfb8",
    background: "transparent",
    borderRadius: 6,
    padding: 4,
    cursor: "pointer",
    color: "#5c5240",
  },
  calendarMonthLabel: {
    fontSize: 13.5,
    fontWeight: 700,
    color: "#2b2620",
    fontFamily: "'Shippori Mincho', serif",
  },
  calendarMonthSummary: {
    display: "flex",
    justifyContent: "center",
    gap: 12,
    fontSize: 11,
    color: "#5c5240",
    marginBottom: 10,
    flexWrap: "wrap",
  },
  calendarGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(7, 1fr)",
    gap: 3,
  },
  calendarWeekday: {
    textAlign: "center",
    fontSize: 10.5,
    color: "#a89a7e",
    paddingBottom: 4,
  },
  calendarDay: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    padding: "5px 0",
    border: "1px solid transparent",
    borderRadius: 6,
    background: "transparent",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  calendarDayToday: {
    border: "1px solid #b5432e",
  },
  calendarDaySelected: {
    background: "#f7ece7",
  },
  calendarDayNum: { fontSize: 11.5, color: "#2b2620" },
  calendarDayDot: {
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    color: "#fdfaf4",
    fontSize: 9,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0 2px",
  },
  calendarDayPoints: {
    fontSize: 8,
    color: "#8a7a3a",
    fontWeight: 700,
  },
  calendarDetail: {
    marginTop: 12,
    paddingTop: 10,
    borderTop: "1px dashed #d9cfb8",
  },
  calendarDetailHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 8,
  },
  calendarDetailTitle: { fontSize: 12.5, fontWeight: 700, color: "#5c5240" },
  calendarDetailMeta: { fontSize: 11.5, color: "#8a7a5c" },
  calendarPointsList: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 8,
  },
  calendarPointsChip: {
    fontSize: 10.5,
    color: "#7a6a2a",
    background: "#f5ecd0",
    border: "1px solid #e0d3a0",
    borderRadius: 10,
    padding: "2px 8px",
  },
  deckDbHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  deckDbTitle: {
    fontSize: 13.5,
    fontWeight: 700,
    color: "#2b2620",
    fontFamily: "'Shippori Mincho', serif",
  },
  deckDbAddBtn: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    border: "1px solid #b5432e",
    background: "#f7ece7",
    color: "#b5432e",
    borderRadius: 20,
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  profileList: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  profileCard: {
    border: "1px solid #d9cfb8",
    borderRadius: 6,
    padding: "10px 12px",
    background: "#fbf7ee",
  },
  profileCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  profileNameBlock: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  profileIconDisplay: { fontSize: 16 },
  profileIconThumb: {
    width: 20,
    height: 20,
    borderRadius: 5,
    objectFit: "cover",
    border: "1px solid #d9cfb8",
  },
  profileDeckName: { fontSize: 13.5, fontWeight: 700, color: "#2b2620" },
  profileDeckTypeTag: {
    fontSize: 10.5,
    color: "#8a7a5c",
    background: "#efe8d6",
    padding: "1px 7px",
    borderRadius: 10,
  },
  profileCardActions: { display: "flex", gap: 2 },
  profileFinish: {
    fontSize: 12,
    color: "#5c5240",
    marginBottom: 6,
    lineHeight: 1.5,
  },
  linkRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "9px 12px",
    background: "#fbf7ee",
    border: "1px solid #ece5d2",
    borderRadius: 6,
  },
  linkAnchor: {
    fontSize: 13,
    color: "#b5432e",
    textDecoration: "none",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  statCard: {
    margin: "18px 20px 0",
    padding: "20px 20px 16px",
    background: "#fdfaf4",
    border: "1px solid #d9cfb8",
    borderRadius: 4,
    boxShadow: "2px 2px 0 rgba(90,70,40,0.08)",
  },
  rateBlock: { display: "flex", alignItems: "baseline" },
  rateNumber: {
    fontFamily: "'Shippori Mincho', serif",
    fontSize: 52,
    fontWeight: 700,
    color: "#b5432e",
    lineHeight: 1,
  },
  ratePercent: {
    fontSize: 20,
    color: "#b5432e",
    marginLeft: 3,
    fontWeight: 700,
  },
  rateLabel: { fontSize: 12.5, color: "#5c5240", marginTop: 6 },
  chartCard: {
    margin: "14px 20px 0",
    padding: "14px 14px 6px",
    background: "#fdfaf4",
    border: "1px solid #d9cfb8",
    borderRadius: 4,
  },
  chartHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  chartTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#5c5240",
    letterSpacing: "0.04em",
  },
  recoList: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    marginTop: 4,
  },
  recoRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    background: "#fbf7ee",
    border: "1px solid #ece5d2",
    borderRadius: 6,
  },
  counterDeckCard: {
    display: "flex",
    flexDirection: "column",
  },
  counterDeckDetail: {
    display: "flex",
    flexWrap: "wrap",
    gap: 5,
    marginTop: 6,
    paddingLeft: 28,
  },
  counterDeckDetailChip: {
    fontSize: 10,
    color: "#8a7a5c",
    border: "1px solid #d9cfb8",
    borderRadius: 10,
    padding: "1px 7px",
  },
  recoRank: {
    width: 18,
    height: 18,
    borderRadius: "50%",
    background: "#b5432e",
    color: "#fdfaf4",
    fontSize: 10.5,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  recoDeckName: { fontSize: 13.5, fontWeight: 500, flex: 1, color: "#2b2620" },
  recoRate: { fontSize: 14, fontWeight: 700, color: "#b5432e" },
  recoNote: {
    fontSize: 10.5,
    color: "#a89a7e",
    marginTop: 8,
    lineHeight: 1.6,
  },
  recoSubHeader: {
    fontSize: 11,
    fontWeight: 700,
    color: "#8a7a5c",
    marginTop: 12,
    marginBottom: 6,
    paddingTop: 10,
    borderTop: "1px dashed #d9cfb8",
  },
  recoRowAlt: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    background: "#eef1f4",
    border: "1px solid #dde3e8",
    borderRadius: 6,
  },
  recoOppLabel: { fontSize: 11.5, color: "#5c5240", minWidth: 76 },
  recoComboLabel: { fontSize: 12.5, color: "#2b2620", flex: 1, fontWeight: 500 },
  recoVs: { color: "#a89a7e", fontWeight: 400, fontSize: 11 },
  matchupSummaryGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  matchupSummaryLabel: {
    fontSize: 10.5,
    fontWeight: 700,
    color: "#8a7a5c",
    marginBottom: 4,
  },
  matchupSummaryRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 4,
    padding: "4px 0",
  },
  matchupSummaryText: {
    fontSize: 10.5,
    color: "#5c5240",
    flex: 1,
    lineHeight: 1.4,
  },
  matchupSummaryRateGood: { fontSize: 11.5, fontWeight: 700, color: "#b5432e" },
  matchupSummaryRateBad: { fontSize: 11.5, fontWeight: 700, color: "#33475b" },
  weekNav: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  weekNavBtn: {
    border: "1px solid #d9cfb8",
    background: "transparent",
    borderRadius: 4,
    padding: 2,
    cursor: "pointer",
    color: "#5c5240",
  },
  weekNavLabel: { fontSize: 10.5, color: "#8a7a5c", minWidth: 60, textAlign: "center" },
  pointsModeRow: {
    display: "flex",
    gap: 6,
    marginTop: 6,
    marginBottom: 8,
    padding: 3,
    background: "#efe8d6",
    borderRadius: 8,
  },
  pointsModeTab: {
    flex: 1,
    padding: "6px 0",
    borderRadius: 6,
    border: "none",
    background: "transparent",
    color: "#8a7a5c",
    fontSize: 11.5,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  pointsModeTabActive: {
    flex: 1,
    padding: "6px 0",
    borderRadius: 6,
    border: "none",
    background: "#fdfaf4",
    color: "#b5432e",
    fontSize: 11.5,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    boxShadow: "0 1px 2px rgba(90,70,40,0.12)",
  },
  pointsList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginTop: 4,
  },
  pointsCard: {
    background: "#fbf7ee",
    border: "1px solid #ece5d2",
    borderRadius: 6,
    overflow: "hidden",
  },
  pointsRow: {
    width: "100%",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "7px 10px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    fontFamily: "inherit",
    textAlign: "left",
  },
  pointsWeekLabel: { fontSize: 12, color: "#5c5240" },
  pointsValue: { fontSize: 13.5, fontWeight: 700, color: "#b5432e" },
  pointsExcluded: { fontSize: 11, fontWeight: 400, color: "#a89a7e" },
  promoRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "0 10px 8px",
    flexWrap: "wrap",
  },
  promoChip: {
    fontSize: 10.5,
    color: "#8a7228",
    background: "#f5ecd0",
    border: "1px solid #e0d3a0",
    borderRadius: 10,
    padding: "2px 8px",
  },
  weeklyBreakdown: {
    borderTop: "1px dashed #d9cfb8",
    padding: "6px 10px 8px",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  weeklyRow: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    fontSize: 11.5,
  },
  weeklyLabel: { color: "#8a7a5c", minWidth: 44 },
  weeklyPoints: { color: "#5c5240" },
  viewWeeklyBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    width: "100%",
    boxSizing: "border-box",
    marginTop: 8,
    padding: "8px 0",
    borderRadius: 6,
    border: "1px solid #d9cfb8",
    background: "transparent",
    color: "#5c5240",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  periodDetailBlock: {
    marginBottom: 14,
    paddingBottom: 12,
    borderBottom: "1px dashed #d9cfb8",
  },
  periodDetailHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 8,
  },
  periodDetailTitle: {
    fontSize: 13.5,
    fontWeight: 700,
    color: "#2b2620",
    fontFamily: "'Shippori Mincho', serif",
  },
  streakRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    marginTop: 14,
    paddingTop: 12,
    borderTop: "1px dashed #d9cfb8",
    flexWrap: "wrap",
  },
  streakDot: {
    width: 20,
    height: 20,
    borderRadius: "50%",
    border: "1.5px solid",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 11,
    fontWeight: 700,
  },
  streakCaption: {
    fontSize: 10.5,
    color: "#a89a7e",
    marginLeft: "auto",
  },
  breakdownSection: { margin: "18px 20px 0" },
  tabRow: { display: "flex", gap: 6 },
  tab: {
    padding: "6px 14px",
    fontSize: 12.5,
    borderRadius: 20,
    border: "1px solid #d9cfb8",
    background: "transparent",
    color: "#7a6f5d",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  tabActive: {
    padding: "6px 14px",
    fontSize: 12.5,
    borderRadius: 20,
    border: "1px solid #b5432e",
    background: "#b5432e",
    color: "#fdfaf4",
    cursor: "pointer",
    fontFamily: "inherit",
    fontWeight: 500,
  },
  breakdownList: {
    marginTop: 10,
    background: "#fdfaf4",
    border: "1px solid #d9cfb8",
    borderRadius: 4,
    overflow: "hidden",
  },
  breakdownRow: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    border: "none",
    borderBottom: "1px solid #ece5d2",
    background: "transparent",
    cursor: "pointer",
    fontFamily: "inherit",
    textAlign: "left",
  },
  breakdownRowActive: { background: "#f7ece7" },
  breakdownName: {
    fontSize: 13.5,
    fontWeight: 500,
    flex: 1,
    color: "#2b2620",
  },
  breakdownDateTag: {
    fontSize: 10.5,
    fontWeight: 400,
    color: "#a89a7e",
    marginLeft: 6,
  },
  breakdownMeta: { fontSize: 11.5, color: "#8a7a5c" },
  matchupList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginTop: 10,
  },
  matchupDeckTabRow: {
    display: "flex",
    gap: 6,
    overflowX: "auto",
    paddingBottom: 2,
  },
  matchupDeckTab: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "6px 12px",
    borderRadius: 20,
    border: "1px solid #d9cfb8",
    background: "transparent",
    color: "#7a6f5d",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
    whiteSpace: "nowrap",
  },
  matchupDeckTabActive: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "6px 12px",
    borderRadius: 20,
    border: "1px solid #b5432e",
    background: "#b5432e",
    color: "#fdfaf4",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
    whiteSpace: "nowrap",
  },
  matchupCard: {
    background: "#fdfaf4",
    border: "1px solid #d9cfb8",
    borderRadius: 6,
    padding: "10px 12px 8px",
  },
  matchupCardHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 6,
    paddingBottom: 6,
    borderBottom: "1px dashed #d9cfb8",
  },
  matchupDeckName: {
    fontSize: 13.5,
    fontWeight: 700,
    color: "#2b2620",
    display: "flex",
    alignItems: "center",
    gap: 5,
  },
  matchupCardRate: { fontSize: 11.5, color: "#8a7a5c" },
  matchupRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 0",
  },
  matchupRowBtn: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "4px 0",
    width: "100%",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    fontFamily: "inherit",
    textAlign: "left",
  },
  matchupOpponent: {
    fontSize: 12.5,
    color: "#5c5240",
    flex: 1,
    display: "flex",
    alignItems: "center",
    gap: 5,
  },
  matchupMeta: { fontSize: 11, color: "#a89a7e" },
  matchupRate: { fontSize: 13, fontWeight: 700, minWidth: 34, textAlign: "right" },
  matchupTurnList: {
    marginTop: 6,
    paddingTop: 6,
    borderTop: "1px dashed #ece5d2",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  matchupTurnRow: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 10.5,
    color: "#a89a7e",
  },
  matchupTurnLabel: { color: "#a89a7e" },
  matchupTurnValue: { color: "#8a7a5c" },
  breakdownRate: {
    fontSize: 13.5,
    fontWeight: 700,
    color: "#b5432e",
    minWidth: 36,
    textAlign: "right",
  },
  photoBadge: {
    display: "flex",
    alignItems: "center",
    gap: 3,
    fontSize: 10.5,
    color: "#8a7a5c",
    border: "1px solid #d9cfb8",
    borderRadius: 10,
    padding: "1px 6px",
  },
  rankBadge: {
    fontSize: 10.5,
    color: "#fdfaf4",
    background: "#b5432e",
    borderRadius: 10,
    padding: "1px 7px",
    fontWeight: 700,
  },
  searchRow: {
    display: "flex",
    gap: 8,
    marginTop: 10,
    marginBottom: 4,
  },
  searchSelect: {
    flex: 1,
    padding: "7px 8px",
    borderRadius: 6,
    border: "1px solid #d9cfb8",
    background: "#fff",
    color: "#5c5240",
    fontSize: 12,
    fontFamily: "inherit",
  },
  searchInput: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid #d9cfb8",
    background: "#fff",
    color: "#5c5240",
    fontSize: 12.5,
    fontFamily: "inherit",
    marginTop: 8,
    marginBottom: 8,
  },
  addMatchToTournamentBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    width: "100%",
    boxSizing: "border-box",
    padding: "9px 0",
    borderRadius: 6,
    border: "1.5px dashed #c9bda0",
    background: "transparent",
    color: "#5c5240",
    fontSize: 12.5,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
    marginBottom: 10,
  },
  gallery: {
    display: "flex",
    gap: 8,
    overflowX: "auto",
    marginTop: 8,
    paddingBottom: 2,
  },
  gallerySection: { marginTop: 10 },
  tournamentDetailBox: {
    padding: "10px 4px 6px",
    marginBottom: 6,
    borderLeft: "2px solid #e0c9be",
    paddingLeft: 12,
  },
  tournamentDateEditRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
  },
  tournamentPointsEditBox: {
    background: "#fbf7ee",
    border: "1px solid #ece5d2",
    borderRadius: 6,
    padding: "10px 10px 4px",
    marginBottom: 10,
  },
  dateConfirmBtn: {
    flex: "0 0 auto",
    padding: "9px 14px",
    borderRadius: 6,
    border: "none",
    background: "#b5432e",
    color: "#fdfaf4",
    fontSize: 12.5,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  galleryLabel: {
    fontSize: 11,
    color: "#8a7a5c",
    letterSpacing: "0.03em",
  },
  galleryItem: {
    position: "relative",
    flex: "0 0 auto",
    width: 76,
    height: 76,
    borderRadius: 6,
    overflow: "hidden",
    border: "1px solid #d9cfb8",
  },
  galleryImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    cursor: "pointer",
    display: "block",
  },
  galleryRemoveBtn: {
    position: "absolute",
    top: 2,
    right: 2,
    width: 16,
    height: 16,
    borderRadius: "50%",
    background: "rgba(20,17,12,0.6)",
    border: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    padding: 0,
  },
  galleryAddTile: {
    flex: "0 0 auto",
    width: 76,
    height: 76,
    borderRadius: 6,
    border: "1.5px dashed #c9bda0",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    cursor: "pointer",
    background: "#fbf7ee",
  },
  galleryAddText: { fontSize: 10, color: "#8a7a5c" },
  lightboxOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(20,17,12,0.92)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 60,
    padding: 16,
  },
  lightboxTop: {
    position: "absolute",
    top: 16,
    left: 16,
    right: 16,
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  lightboxDeleteBtn: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    border: "1px solid rgba(253,250,244,0.4)",
    background: "transparent",
    color: "#fdfaf4",
    fontSize: 12.5,
    padding: "6px 12px",
    borderRadius: 20,
    cursor: "pointer",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
  },
  lightboxCloseBtn: {
    border: "none",
    background: "transparent",
    cursor: "pointer",
    padding: 4,
  },
  lightboxImg: {
    maxWidth: "100%",
    maxHeight: "80vh",
    borderRadius: 6,
    objectFit: "contain",
  },
  logSection: { margin: "22px 20px 0" },
  logHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 8,
  },
  logTitle: {
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: "0.05em",
    color: "#5c5240",
  },
  logCount: { fontSize: 11.5, color: "#a89a7e" },
  opponentSearchInput: {
    width: "100%",
    boxSizing: "border-box",
    padding: "9px 12px",
    borderRadius: 8,
    border: "1px solid #d9cfb8",
    background: "#fdfaf4",
    fontSize: 13,
    fontFamily: "inherit",
    color: "#2b2620",
    marginBottom: 10,
  },
  empty: {
    padding: "28px 16px",
    textAlign: "center",
    fontSize: 12.5,
    color: "#a89a7e",
    background: "#fdfaf4",
    border: "1px dashed #d9cfb8",
    borderRadius: 4,
    lineHeight: 1.7,
  },
  list: { listStyle: "none", margin: 0, padding: 0 },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
    padding: "12px 14px",
    background: "#fdfaf4",
    border: "1px solid #ece5d2",
    borderRadius: 4,
    marginBottom: 7,
  },
  resultBadge: {
    width: 26,
    height: 26,
    minWidth: 26,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 13,
    fontWeight: 700,
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowTop: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
  rowOpponent: { fontSize: 14, fontWeight: 500 },
  rowOpponentBlank: { fontSize: 13, fontWeight: 400, color: "#c9bda0", fontStyle: "italic" },
  rowDeck: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontSize: 10.5,
    color: "#8a7a5c",
    background: "#efe8d6",
    padding: "1px 7px",
    borderRadius: 10,
  },
  rowDeckIcon: {
    width: 12,
    height: 12,
    borderRadius: "50%",
    objectFit: "cover",
  },
  rowTurn: {
    fontSize: 10.5,
    color: "#5c5240",
    border: "1px solid #d9cfb8",
    padding: "1px 7px",
    borderRadius: 10,
  },
  rowDeckMine: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontSize: 10.5,
    color: "#33475b",
    background: "#e6ebf0",
    padding: "1px 7px",
    borderRadius: 10,
  },
  rowBottom: {
    fontSize: 11,
    color: "#a89a7e",
    marginTop: 3,
  },
  rowNote: { color: "#a89a7e" },
  rowTournament: { color: "#8a7a5c" },
  chipRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 6,
  },
  chip: {
    padding: "4px 11px",
    fontSize: 11.5,
    borderRadius: 20,
    border: "1px solid #d9cfb8",
    background: "transparent",
    color: "#7a6f5d",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  chipActive: {
    border: "1px solid #b5432e",
    background: "#b5432e",
    color: "#fdfaf4",
  },
  chipRowTight: {
    display: "flex",
    flexWrap: "wrap",
    gap: 5,
    marginTop: 6,
  },
  chipSmall: {
    padding: "3px 9px",
    fontSize: 10.5,
    borderRadius: 20,
    border: "1px solid #d9cfb8",
    background: "transparent",
    color: "#7a6f5d",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  rowActions: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  editBtn: {
    border: "none",
    background: "transparent",
    color: "#c9bda0",
    cursor: "pointer",
    padding: 4,
  },
  deleteBtn: {
    border: "none",
    background: "transparent",
    color: "#c9bda0",
    cursor: "pointer",
    padding: 4,
  },
  errorBanner: {
    margin: "12px 20px 0",
    padding: "10px 14px",
    background: "#f7ece7",
    color: "#b5432e",
    fontSize: 12,
    borderRadius: 4,
  },
  boardTabRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 20px",
    overflowX: "auto",
    borderBottom: "1px solid #d9cfb8",
  },
  boardTab: {
    flex: "0 0 auto",
    padding: "5px 12px",
    borderRadius: 20,
    border: "1px solid #d9cfb8",
    background: "transparent",
    color: "#7a6f5d",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
    whiteSpace: "nowrap",
  },
  boardTabActive: {
    flex: "0 0 auto",
    padding: "5px 12px",
    borderRadius: 20,
    border: "1px solid #b5432e",
    background: "#b5432e",
    color: "#fdfaf4",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
    whiteSpace: "nowrap",
  },
  boardIconBtn: {
    flex: "0 0 auto",
    width: 26,
    height: 26,
    borderRadius: "50%",
    border: "1px solid #d9cfb8",
    background: "transparent",
    color: "#8a7a5c",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  boardManageRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 20px",
    borderBottom: "1px solid #d9cfb8",
    background: "#fbf7ee",
  },
  boardDeleteBtn: {
    border: "1px solid #b5432e",
    background: "transparent",
    color: "#b5432e",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  fab: {
    position: "fixed",
    right: 20,
    bottom: 24,
    width: 54,
    height: 54,
    borderRadius: "50%",
    background: "#b5432e",
    border: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 14px rgba(90,50,30,0.35)",
    cursor: "pointer",
  },
  homeBtn: {
    position: "fixed",
    left: 20,
    bottom: 24,
    width: 48,
    height: 48,
    borderRadius: "50%",
    background: "#fdfaf4",
    border: "1px solid #d9cfb8",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 14px rgba(90,50,30,0.18)",
    cursor: "pointer",
    zIndex: 100,
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(43,38,32,0.45)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    zIndex: 50,
  },
  confirmDialog: {
    width: "100%",
    maxWidth: 480,
    background: "#fdfaf4",
    borderRadius: "12px 12px 0 0",
    padding: "22px 20px 24px",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
  },
  confirmTitle: {
    fontFamily: "'Shippori Mincho', serif",
    fontSize: 16,
    fontWeight: 700,
    color: "#2b2620",
    marginBottom: 8,
  },
  confirmDetail: {
    fontSize: 12.5,
    color: "#5c5240",
    background: "#fbf7ee",
    border: "1px solid #ece5d2",
    borderRadius: 6,
    padding: "8px 10px",
    marginBottom: 18,
    lineHeight: 1.6,
  },
  confirmActions: {
    display: "flex",
    gap: 10,
  },
  confirmCancelBtn: {
    flex: 1,
    padding: "12px 0",
    borderRadius: 6,
    border: "1px solid #d9cfb8",
    background: "transparent",
    color: "#5c5240",
    fontSize: 13.5,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  confirmDeleteBtn: {
    flex: 1,
    padding: "12px 0",
    borderRadius: 6,
    border: "none",
    background: "#b5432e",
    color: "#fdfaf4",
    fontSize: 13.5,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  modal: {
    width: "100%",
    maxWidth: 480,
    maxHeight: "88vh",
    overflowY: "auto",
    background: "#fdfaf4",
    borderRadius: "12px 12px 0 0",
    padding: "26px 20px 24px",
    fontFamily: "'Zen Kaku Gothic New', sans-serif",
  },
  modalHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  modalTitle: {
    fontFamily: "'Shippori Mincho', serif",
    fontSize: 17,
    fontWeight: 700,
  },
  closeBtn: {
    border: "none",
    background: "transparent",
    color: "#8a7a5c",
    cursor: "pointer",
    padding: 4,
  },
  resultPicker: { display: "flex", gap: 8, marginBottom: 16 },
  modeToggleRow: {
    display: "flex",
    gap: 6,
    marginBottom: 16,
    padding: 3,
    background: "#efe8d6",
    borderRadius: 8,
  },
  modeTab: {
    flex: 1,
    padding: "7px 0",
    borderRadius: 6,
    border: "none",
    background: "transparent",
    color: "#8a7a5c",
    fontSize: 12.5,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  modeTabActive: {
    flex: 1,
    padding: "7px 0",
    borderRadius: 6,
    border: "none",
    background: "#fdfaf4",
    color: "#b5432e",
    fontSize: 12.5,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    boxShadow: "0 1px 2px rgba(90,70,40,0.12)",
  },
  batchList: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    marginTop: 10,
    maxHeight: "38vh",
    overflowY: "auto",
    paddingRight: 2,
  },
  batchRound: {
    border: "1px solid #d9cfb8",
    borderRadius: 6,
    padding: "10px 10px 11px",
    background: "#fbf7ee",
  },
  batchRoundHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  batchRoundLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: "#5c5240",
    letterSpacing: "0.03em",
  },
  batchRemoveBtn: {
    border: "none",
    background: "transparent",
    color: "#c9bda0",
    cursor: "pointer",
    padding: 2,
  },
  batchOptionRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    marginBottom: 8,
  },
  batchResultOption: {
    width: 32,
    height: 30,
    borderRadius: 6,
    border: "1.5px solid",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    background: "transparent",
  },
  batchTurnOption: {
    width: 32,
    height: 30,
    borderRadius: 6,
    border: "1.5px solid #d9cfb8",
    background: "transparent",
    color: "#7a6f5d",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  batchDivider: {
    width: 1,
    height: 22,
    background: "#d9cfb8",
    margin: "0 3px",
  },
  inputSmall: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid #d9cfb8",
    background: "#fff",
    fontSize: 13,
    fontFamily: "inherit",
    color: "#2b2620",
    marginTop: 6,
  },
  metaRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 0",
  },
  matchupInputRow: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 0",
    borderBottom: "1px dashed #d9cfb8",
  },
  matchupInputCounts: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  metaPercentInput: {
    width: 64,
    boxSizing: "border-box",
    padding: "8px 8px",
    borderRadius: 6,
    border: "1px solid #d9cfb8",
    background: "#fff",
    fontSize: 13,
    fontFamily: "inherit",
    color: "#2b2620",
    textAlign: "right",
  },
  addRoundBtn: {
    width: "100%",
    marginTop: 10,
    padding: "10px 0",
    borderRadius: 6,
    border: "1.5px dashed #c9bda0",
    background: "transparent",
    color: "#8a7a5c",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  photoUploadBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    width: "100%",
    boxSizing: "border-box",
    marginTop: 8,
    padding: "10px 0",
    borderRadius: 6,
    border: "1px solid #b5432e",
    background: "#f7ece7",
    color: "#b5432e",
    fontSize: 12.5,
    fontWeight: 500,
    cursor: "pointer",
  },
  ocrErrorText: {
    fontSize: 11.5,
    color: "#b5432e",
    marginTop: 6,
    lineHeight: 1.5,
  },
  photoSavedNote: {
    fontSize: 11,
    color: "#5c7a5c",
    marginTop: 6,
    lineHeight: 1.5,
  },
  hintText: {
    fontSize: 11,
    color: "#a89a7e",
    marginTop: 4,
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontSize: 11.5,
    color: "#5c5240",
    marginTop: 8,
    cursor: "pointer",
  },
  storageUsageRow: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    marginBottom: 10,
    flexWrap: "wrap",
  },
  storageUsageTotal: {
    fontFamily: "'Shippori Mincho', serif",
    fontSize: 20,
    fontWeight: 700,
    color: "#b5432e",
  },
  storageUsageDetail: {
    fontSize: 11,
    color: "#8a7a5c",
  },
  exportPasswordRow: {
    display: "flex",
    gap: 8,
    marginBottom: 10,
  },
  exportPasswordBtn: {
    flex: 1,
    padding: "9px 12px",
    borderRadius: 6,
    border: "1px solid #d9cfb8",
    background: "#fff",
    color: "#5c5240",
    fontSize: 12.5,
    cursor: "pointer",
    fontFamily: "inherit",
    textAlign: "left",
  },
  encryptedImportBox: {
    marginTop: 10,
    padding: "10px 12px",
    background: "#f7ece7",
    border: "1px solid #e0c9be",
    borderRadius: 6,
  },
  encryptedImportActions: {
    display: "flex",
    gap: 8,
    marginTop: 8,
  },
  pointsRankRow: {
    display: "flex",
    gap: 10,
  },
  turnPicker: { display: "flex", gap: 8, marginBottom: 4 },
  turnOption: {
    flex: 1,
    padding: "7px 0",
    borderRadius: 6,
    border: "1.5px solid #d9cfb8",
    background: "transparent",
    color: "#7a6f5d",
    fontSize: 12.5,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  turnOptionActive: {
    border: "1.5px solid #33475b",
    background: "#33475b",
    color: "#fdfaf4",
  },
  resultOption: {
    flex: 1,
    padding: "9px 0",
    borderRadius: 6,
    border: "1.5px solid",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "background 0.15s",
  },
  fieldLabel: {
    display: "block",
    fontSize: 11.5,
    color: "#8a7a5c",
    marginTop: 12,
    marginBottom: 5,
    letterSpacing: "0.03em",
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: 6,
    border: "1px solid #d9cfb8",
    background: "#fff",
    fontSize: 14,
    fontFamily: "inherit",
    color: "#2b2620",
  },
  iconUploadRow: { display: "flex" },
  iconUploadTile: {
    width: 56,
    height: 56,
    borderRadius: 10,
    border: "1.5px dashed #c9bda0",
    background: "#fbf7ee",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  },
  iconPreviewWrap: {
    position: "relative",
    width: 56,
    height: 56,
    borderRadius: 10,
    overflow: "hidden",
    border: "1px solid #d9cfb8",
  },
  iconPreviewImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  submitBtn: {
    width: "100%",
    marginTop: 20,
    padding: "13px 0",
    borderRadius: 6,
    border: "none",
    background: "#b5432e",
    color: "#fdfaf4",
    fontSize: 14.5,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: "inherit",
    letterSpacing: "0.05em",
  },
};
