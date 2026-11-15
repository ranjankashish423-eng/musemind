/* =====================================================================
   MUSEMIND — AI-AWARE EMOTION JOURNALING SYSTEM
   script.js

   CURRENT VERSION:  frontend + localStorage + GoEmotions browser inference
   FUTURE VERSION:   swap the "DATA LAYER" block below for calls to a
                      real backend (Firebase / Supabase / MySQL API).
                      Nothing outside that block talks to localStorage
                      directly, so the swap should not touch the UI code.
   ===================================================================== */

(function () {
  "use strict";

  /* ===================================================================
     0. STORAGE KEYS
     =================================================================== */

  const KEYS = {
    USERS: "musemind_users",
    CURRENT_USER: "musemind_current_user",
    ENTRIES: "musemind_entries",
    SETTINGS: "musemind_settings",
  };

  let charts = { distribution: null, timeline: null, emotionRadar: null };
  let activeSection = "overview";
  let activeAnalysisEntryId = null;
  let historyFilters = { query: "", emotion: "all", sort: "newest" };
  let pendingDeleteId = null;
  let calendarCursor = new Date(); // month currently shown in Mood Calendar

  /* ===================================================================
     1. DATA LAYER
     This is the only part of the app that touches localStorage.
     Every function here has a shape that a real backend API could
     also implement (e.g. getUserEntries -> GET /api/entries?userId=).
     =================================================================== */

  const DataLayer = {
    // ---- low level read/write -----------------------------------
    _read(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        console.error("MuseMind storage read failed:", key, e);
        return fallback;
      }
    },
    _write(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        console.error("MuseMind storage write failed:", key, e);
        return false;
      }
    },

    // ---- users -----------------------------------------------------
    getUsers() {
      return this._read(KEYS.USERS, []);
    },
    saveUser(user) {
      const users = this.getUsers();
      const idx = users.findIndex((u) => u.id === user.id);
      if (idx === -1) users.push(user);
      else users[idx] = user;
      this._write(KEYS.USERS, users);
      return user;
    },
    getUserById(id) {
      return this.getUsers().find((u) => u.id === id) || null;
    },

    // ---- session -----------------------------------------------------
    getCurrentUser() {
      const id = localStorage.getItem(KEYS.CURRENT_USER);
      if (!id) return null;
      return this.getUserById(id);
    },
    setCurrentUser(id) {
      localStorage.setItem(KEYS.CURRENT_USER, id);
    },
    clearSession() {
      localStorage.removeItem(KEYS.CURRENT_USER);
    },

    // ---- entries -----------------------------------------------------
    getAllEntries() {
      return this._read(KEYS.ENTRIES, []);
    },
    saveEntry(entry) {
      const entries = this.getAllEntries();
      entries.push(entry);
      this._write(KEYS.ENTRIES, entries);
      return entry;
    },
    updateEntry(entryId, updates) {
      const entries = this.getAllEntries();
      const idx = entries.findIndex((e) => e.id === entryId);
      if (idx === -1) return null;
      entries[idx] = Object.assign({}, entries[idx], updates);
      this._write(KEYS.ENTRIES, entries);
      return entries[idx];
    },
    deleteEntry(entryId) {
      const entries = this.getAllEntries().filter((e) => e.id !== entryId);
      this._write(KEYS.ENTRIES, entries);
    },
    getUserEntries(userId) {
      return this.getAllEntries()
        .filter((e) => e.userId === userId)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    },
    clearUserEntries(userId) {
      const entries = this.getAllEntries().filter((e) => e.userId !== userId);
      this._write(KEYS.ENTRIES, entries);
    },

    // ---- settings (per-user, small key/value bag) ---------------------
    getSettings() {
      return this._read(KEYS.SETTINGS, {});
    },
    setSetting(userId, key, value) {
      const settings = this.getSettings();
      settings[userId] = settings[userId] || {};
      settings[userId][key] = value;
      this._write(KEYS.SETTINGS, settings);
    },
    getSetting(userId, key, fallback) {
      const settings = this.getSettings();
      return settings[userId] && key in settings[userId]
        ? settings[userId][key]
        : fallback;
    },
    clearUserSettings(userId) {
      const settings = this.getSettings();
      delete settings[userId];
      this._write(KEYS.SETTINGS, settings);
    },
  };

  function uid(prefix) {
    return (
      prefix +
      "_" +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8)
    );
  }

  /* ===================================================================
     2. EMOTION ENGINE
     GoEmotions is the primary English NLP engine.
     The existing keyword engine remains a transparent fallback.
     The public model is a pretrained/fine-tuned RoBERTa model; MuseMind
     does not claim to train it from scratch.
     =================================================================== */

  const EMOTIONS = {
    Happy: { emoji: "😊", tone: "positive", words: ["happy","joy","excited","great","good","amazing","wonderful","love","proud","success","khush","khushi","mast","accha","acchi","acha","celebrate","fun","smile","😊","😄","😁","🥰","❤️","❤"] },
    Sad: { emoji: "😢", tone: "negative", words: ["sad","unhappy","cry","crying","lonely","hurt","upset","depressed","dukhi","udaas","udas","akela","akeli","rona","miss","missing","alone","😢","😭","💔"] },
    Stressed: { emoji: "😰", tone: "negative", words: ["stress","stressed","anxiety","pressure","exam","exams","deadline","worried","worry","nervous","tension","tensed","overwhelmed","workload","assignment","assignments","presentation","pareshan","dar","fikar","😰","😨","😤"] },
    Calm: { emoji: "😌", tone: "positive", words: ["calm","peace","peaceful","relaxed","relax","comfortable","safe","quiet","shaant","shant","sukoon","relaxing","meditation","rest","😌","🙂","🌿"] },
    Excited: { emoji: "🤩", tone: "positive", words: ["excited","thrilled","eager","looking forward","can't wait","cant wait","super excited","yay","wohoo","🤩","🎉","🥳"] },
    Angry: { emoji: "😡", tone: "negative", words: ["angry","anger","mad","furious","annoyed","irritated","frustrated","frustration","gussa","😡","😠","🤬"] },
    Anxious: { emoji: "😟", tone: "negative", words: ["anxious","fear","scared","afraid","uncertain","insecure","ghabrahat","darr","😟"] },
    Confident: { emoji: "💪", tone: "positive", words: ["confident","confidence","prepared","believe","believe in myself","strong","ready","capable","sure","hopeful","motivated","motivation","💪","🔥"] },
  };

  function normalizeEmotionName(value) {
    const raw = String(value || "").trim();
    if (EMOTIONS[raw]) return raw;
    const key = raw.toLowerCase();
    const map = {
      grateful: "Happy", loved: "Happy", amused: "Happy", content: "Calm", relieved: "Calm",
      proud: "Confident", hopeful: "Confident", determined: "Confident", curious: "Confident", reflective: "Calm",
      frustrated: "Angry", disappointed: "Sad", overwhelmed: "Stressed", tired: "Calm",
      nostalgic: "Sad", confused: "Stressed", focused: "Confident", "mixed emotions": "Anxious"
    };
    return map[key] || "Calm";
  }

  function emotionMeta(value) {
    return EMOTIONS[normalizeEmotionName(value)] || EMOTIONS.Calm;
  }

  function migrateLegacySampleEntries(user) {
    if (!user) return;
    const entries = DataLayer.getAllEntries();
    let changed = false;
    entries.forEach(entry => {
      if (entry.userId !== user.id) return;
      const primary = normalizeEmotionName(entry.primaryEmotion);
      const secondary = normalizeEmotionName(entry.secondaryEmotion);
      if (primary !== entry.primaryEmotion || secondary !== entry.secondaryEmotion) {
        entry.primaryEmotion = primary;
        entry.secondaryEmotion = secondary;
        entry.primaryPercentage = Number(entry.primaryPercentage) || 65;
        entry.secondaryPercentage = Number(entry.secondaryPercentage) || 20;
        entry.moodScore = Number(entry.moodScore) || MOOD_SCORE_MAP[primary] || 65;
        changed = true;
      }
      if (!entry.timestamp || Number.isNaN(new Date(entry.timestamp).getTime())) {
        const d = new Date();
        entry.timestamp = d.toISOString();
        entry.date = localDateKey(d);
        entry.time = fmtTime(d);
        changed = true;
      }
      entry.triggers = Array.isArray(entry.triggers) ? entry.triggers : [];
    });
    if (changed) DataLayer._write(KEYS.ENTRIES, entries);
  }

  const TRIGGERS = {
    Academic: ["exam","exams","assignment","assignments","study","college","class","marks","result","presentation","project","pbl","viva"],
    Work: ["work","office","meeting","boss","deadline","task","workload","job"],
    Relationships: ["friend","friends","boyfriend","girlfriend","partner","argument","fight"],
    Family: ["family","parents","mom","dad","mother","father","sibling"],
    Social: ["party","people","social","instagram","group","outing"],
    Health: ["health","sleep","tired","headache","sick","exercise","fitness","ill"],
    Finance: ["money","finance","budget","expenses","fees","loan","salary"],
    Personal: ["myself","identity","goals","future","growth"],
  };

  const MOOD_SCORE_MAP = { Happy: 90, Excited: 95, Confident: 88, Calm: 80, Anxious: 50, Stressed: 45, Sad: 35, Angry: 30 };
  const TREND_SCORE_MAP = { Happy: 4, Excited: 4, Confident: 4, Calm: 3, Anxious: 2, Stressed: 2, Sad: 1, Angry: 1 };

  const HINDI_WORDS = ["khush","khushi","mast","accha","acchi","acha","dukhi","udaas","udas","akela","akeli","rona","pareshan","dar","fikar","shaant","shant","sukoon","gussa","ghabrahat","darr","hai","nahi","kyun","mujhe","tum"];
  const DEVANAGARI_RANGE = /[\u0900-\u097F]/;
  const EMOJI_RANGE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;


  const GO_EMOTIONS = [
    "admiration","amusement","anger","annoyance","approval","caring",
    "confusion","curiosity","desire","disappointment","disapproval","disgust",
    "embarrassment","excitement","fear","gratitude","grief","joy","love",
    "nervousness","optimism","pride","realization","relief","remorse",
    "sadness","surprise","neutral"
  ];

  const GO_TO_MUSE = {
    admiration:"Happy", amusement:"Happy", joy:"Happy", love:"Happy",
    gratitude:"Happy", approval:"Happy", caring:"Happy",
    excitement:"Excited", surprise:"Excited", desire:"Excited",
    sadness:"Sad", grief:"Sad", disappointment:"Sad", remorse:"Sad",
    anger:"Angry", annoyance:"Angry", disgust:"Angry", disapproval:"Angry",
    fear:"Anxious", nervousness:"Anxious", embarrassment:"Anxious", confusion:"Anxious",
    relief:"Calm", neutral:"Calm",
    pride:"Confident", optimism:"Confident", realization:"Confident",
    curiosity:"Confident"
  };

  const MODEL_ID = "MicahB/roberta-base-go_emotions";
  let goEmotionClassifier = null;
  let modelPromise = null;

  const EmotionEngine = {
    modelId: MODEL_ID,
    async loadModel() {
      if (goEmotionClassifier) return goEmotionClassifier;
      if (modelPromise) return modelPromise;
      const status = document.getElementById("engineStatus");
      if (status) status.textContent = "Loading GoEmotions model…";
      modelPromise = import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1")
        .then(({ pipeline, env }) => {
          env.allowLocalModels = false;
          env.useBrowserCache = true;
          return pipeline("text-classification", MODEL_ID, { dtype: "q8" });
        })
        .then((classifier) => {
        goEmotionClassifier = classifier;
        if (status) status.textContent = "GoEmotions model ready.";
        return classifier;
      }).catch((error) => {
        modelPromise = null;
        if (status) status.textContent = "Model unavailable — fallback ready.";
        throw error;
      });
      return modelPromise;
    },

    mapScores(goResults) {
      const categoryScores = {};
      Object.keys(EMOTIONS).forEach((e) => categoryScores[e] = 0);
      goResults.forEach((item) => {
        const category = GO_TO_MUSE[item.label];
        if (category) categoryScores[category] = Math.max(categoryScores[category], item.score);
      });
      if (Object.values(categoryScores).every((v) => v === 0)) categoryScores.Calm = 1;
      return categoryScores;
    },

    async analyze(text, language) {
      const englishEligible = language === "English";
      if (!englishEligible) {
        const fallback = analyzeRuleBased(text);
        return Object.assign(fallback, {
          modelUsed: "MuseMind Rule-Based Emotion Engine",
          modelVersion: "Fallback for non-English text",
          analysisSource: "Rule-Based Fallback",
          goEmotions: [],
          goEmotionScores: []
        });
      }

      try {
        const classifier = await this.loadModel();
        const output = await classifier(text, { top_k: null });
        const raw = Array.isArray(output) && Array.isArray(output[0]) ? output[0] : output;
        const goResults = raw
          .filter((x) => x && x.label)
          .map((x) => ({ label: String(x.label).toLowerCase(), confidence: Math.max(0, Math.min(1, Number(x.score) || 0)) }))
          .filter((x) => GO_EMOTIONS.includes(x.label))
          .sort((a, b) => b.confidence - a.confidence);

        // Keep every model label. The UI can show the top signals without throwing
        // away information needed for mapping and the radar chart.
        const meaningful = goResults.filter((x) => x.label !== "neutral" && x.confidence >= 0.15);
        const selected = meaningful.length ? meaningful : goResults.slice(0, 3);

        // Aggregate all 28 labels into MuseMind's eight user-facing categories.
        const categoryScores = {};
        Object.keys(EMOTIONS).forEach((e) => { categoryScores[e] = 0; });
        goResults.forEach((item) => {
          const category = GO_TO_MUSE[item.label];
          if (category) categoryScores[category] += item.confidence;
        });
        const totalCategory = Object.values(categoryScores).reduce((a, b) => a + b, 0) || 1;
        Object.keys(categoryScores).forEach((e) => {
          categoryScores[e] = categoryScores[e] / totalCategory;
        });

        const sortedCategories = Object.entries(categoryScores).sort((a, b) => b[1] - a[1]);
        const primary = sortedCategories[0]?.[0] || "Calm";
        const secondary = sortedCategories.find(([name, score]) => name !== primary && score >= 0.12)?.[0] || primary;
        const primaryPercent = Math.round((categoryScores[primary] || 0) * 100);
        const secondaryPercent = secondary === primary ? 0 : Math.round((categoryScores[secondary] || 0) * 100);
        const mixed = selected.filter((x) => x.label !== "neutral" && x.confidence >= 0.20).length >= 2 && secondary !== primary;
        const lowerText = text.toLowerCase();
        const triggers = detectTriggers(lowerText);
        const emojiDetected = EMOJI_RANGE.test(text);
        const moodScore = Math.round(
          (MOOD_SCORE_MAP[primary] * Math.max(primaryPercent, 1) +
           MOOD_SCORE_MAP[secondary] * Math.max(secondaryPercent, 0)) /
          Math.max(primaryPercent + secondaryPercent, 1)
        );

        // Sentence-level analysis uses the same model, not the old keyword engine.
        const sentenceTexts = splitSentences(text);
        const sentenceResults = await Promise.all(sentenceTexts.map(async (sentence) => {
          try {
            const sentenceOutput = await classifier(sentence, { top_k: null });
            const sentenceRaw = Array.isArray(sentenceOutput) && Array.isArray(sentenceOutput[0]) ? sentenceOutput[0] : sentenceOutput;
            const ranked = sentenceRaw
              .filter((x) => x && x.label)
              .map((x) => ({ label: String(x.label).toLowerCase(), confidence: Math.max(0, Math.min(1, Number(x.score) || 0)) }))
              .filter((x) => GO_EMOTIONS.includes(x.label))
              .sort((a, b) => b.confidence - a.confidence);
            const top = ranked[0] || { label: "neutral", confidence: 0 };
            return {
              text: sentence,
              emotion: GO_TO_MUSE[top.label] || "Calm",
              goLabel: top.label,
              confidence: Math.round(top.confidence * 100) / 100,
              source: "GoEmotions Model"
            };
          } catch (_) {
            const fb = analyzeRuleBased(sentence);
            return { text: sentence, emotion: fb.primary, goLabel: null, confidence: null, source: "Rule-Based Fallback" };
          }
        }));

        return {
          scores: categoryScores,
          primary, secondary,
          primaryPercent, secondaryPercent,
          primaryGoLabel: selected[0]?.label || "neutral",
          secondaryGoLabel: selected[1]?.label || selected[0]?.label || "neutral",
          primaryGoConfidence: selected[0]?.confidence || 0,
          secondaryGoConfidence: selected[1]?.confidence || 0,
          mixed, triggers, language, emojiDetected, moodScore,
          sentences: sentenceResults,
          goEmotions: selected,
          goEmotionScores: goResults,
          modelUsed: MODEL_ID,
          modelVersion: "RoBERTa-base GoEmotions",
          analysisSource: "GoEmotions Model"
        };
      } catch (error) {
        console.warn("GoEmotions inference failed; using fallback.", error);
        const fallback = analyzeRuleBased(text);
        return Object.assign(fallback, {
          modelUsed: "MuseMind Rule-Based Emotion Engine",
          modelVersion: "Fallback",
          analysisSource: "Rule-Based Fallback",
          goEmotions: [],
          goEmotionScores: []
        });
      }
    }
  };

  function analyzeRuleBased(originalText) {
    const lowerText = originalText.toLowerCase();
    const scores = scoreEmotions(lowerText);
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const primary = sorted[0][0];
    const secondary = sorted[1][0];
    const total = Object.values(scores).reduce((s, v) => s + v, 0) || 1;
    let primaryPercent = Math.round((scores[primary] / total) * 100);
    let secondaryPercent = scores[secondary] > 0 ? Math.round((scores[secondary] / total) * 100) : 0;
    if (secondaryPercent === 0 && primaryPercent < 100) secondaryPercent = 100 - primaryPercent;
    const mixed = scores[secondary] > 0 && scores[secondary] >= scores[primary] * 0.4;
    const triggers = detectTriggers(lowerText);
    const language = detectLanguage(originalText, lowerText);
    const emojiDetected = EMOJI_RANGE.test(originalText);
    const moodScore = Math.round(
      (MOOD_SCORE_MAP[primary] * primaryPercent + MOOD_SCORE_MAP[secondary] * secondaryPercent) / 100
    );
    const sentences = splitSentences(originalText).map((s) => {
      const sScores = scoreEmotions(s.toLowerCase());
      const sSorted = Object.entries(sScores).sort((a, b) => b[1] - a[1]);
      return { text: s, emotion: sSorted[0][0] };
    });
    return {
      scores, primary, secondary, primaryPercent, secondaryPercent, mixed,
      triggers, language, emojiDetected, moodScore, sentences
    };
  }

  function scoreEmotions(lowerText) {
    const scores = {};
    Object.keys(EMOTIONS).forEach((e) => (scores[e] = 0));
    Object.keys(EMOTIONS).forEach((emotion) => {
      EMOTIONS[emotion].words.forEach((word) => {
        if (lowerText.includes(word.toLowerCase())) scores[emotion]++;
      });
    });
    if (Object.values(scores).every((v) => v === 0)) scores.Calm = 1;
    return scores;
  }

  function detectTriggers(lowerText) {
    return Object.keys(TRIGGERS).filter((t) =>
      TRIGGERS[t].some((w) => lowerText.includes(w.toLowerCase()))
    );
  }

  function detectLanguage(originalText, lowerText) {
    const hasDevanagari = DEVANAGARI_RANGE.test(originalText);
    const hasHindiWord = HINDI_WORDS.some((w) => lowerText.includes(w));
    const hasEnglishWord = /[a-z]{3,}/.test(lowerText);
    if (hasDevanagari && hasEnglishWord) return "Mixed";
    if (hasDevanagari) return "Hindi";
    if (hasHindiWord && hasEnglishWord) return "Hinglish";
    if (hasHindiWord) return "Hinglish";
    return "English";
  }

  // Very light sentence splitter for the optional sentence-level view.
  function splitSentences(text) {
    return text
      .split(/(?<=[.!?।])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function analyzeText(originalText) {
    const lowerText = originalText.toLowerCase();
    const language = detectLanguage(originalText, lowerText);
    if (language !== "English") {
      throw new Error("MuseMind currently supports English journal text only. Please edit the entry in English before analyzing.");
    }
    return EmotionEngine.analyze(originalText, "English");
  }

  function generateReflection(entry, recentEntries) {
    const p = entry.primaryEmotion, s = entry.secondaryEmotion;
    const combos = [
      { when: p === "Stressed" && ["Happy", "Confident", "Excited"].includes(s),
        text: "You seem to be under pressure, but there are also real positive signals here — your motivation doesn't look like it's been knocked out by the stress. Taking one task at a time while leaning on that positive energy can help." },
      { when: p === "Sad" && s === "Calm",
        text: "There's some sadness in this entry, alongside a sense of calm. Giving yourself quiet space to sit with these feelings, and writing more about them, may help you understand what's underneath." },
      { when: p === "Anxious" && s === "Confident",
        text: "You sound nervous about the situation, but your confidence suggests you believe you can handle it. Focusing on what's actually in your control can help take the edge off." },
    ];
    const matched = combos.find((c) => c.when);

    const base = matched
      ? matched.text
      : {
          Happy: "This entry carries strong positive signals. It can help to notice what led to this feeling, so you can look out for more of it.",
          Sad: "This entry shows signs of sadness. Writing about what's behind it is often a useful first step to understanding your mood.",
          Stressed: "There are clear signs of stress here. Breaking the task down into smaller steps, with short breaks between them, tends to help.",
          Calm: "Your emotional signals look fairly settled right now. Worth noticing what helped you get here.",
          Excited: "There's real excitement in this entry — energy like this is useful when it's pointed at something meaningful.",
          Angry: "This entry shows some frustration or anger. Giving yourself a beat before reacting can make the situation easier to think through.",
          Anxious: "There's some anxiety or uncertainty here. Focusing on what you can actually control tends to make things feel more manageable.",
          Confident: "This entry carries confidence and motivation. Worth using that energy while it's here.",
        }[p];

    let trendNote = "";
    if (entry.triggers.length && recentEntries.length >= 3) {
      const sameTrigger = recentEntries.filter((e) => e.triggers.includes(entry.triggers[0]));
      if (sameTrigger.length >= 2) {
        trendNote = ` ${entry.triggers[0]} situations have come up a few times recently in your entries.`;
      }
    }

    return base + trendNote;
  }

  /* ===================================================================
     3. UTIL
     =================================================================== */

  function escapeHTML(text) {
    return String(text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function fmtDate(d) {
    return d.toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
  }
  function fmtTime(d) {
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  }
  function fmtClock(d) {
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function localDateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function toast(message, kind) {
    const host = document.getElementById("toastHost");
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " toast-" + kind : "");
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 250);
    }, 2600);
  }

  function animateCount(el, to) {
    const from = 0;
    const dur = 600;
    const start = performance.now();
    function step(now) {
      const p = Math.min(1, (now - start) / dur);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ===================================================================
     4. AUTH / SESSION
     =================================================================== */

  let loginMode = "create";

  function setLoginMode(mode) {
    loginMode = mode === "return" ? "return" : "create";
    const create = loginMode === "create";
    document.getElementById("createModeBtn")?.classList.toggle("active", create);
    document.getElementById("returnModeBtn")?.classList.toggle("active", !create);
    document.getElementById("optionalProfileFields").style.display = create ? "block" : "none";
    document.getElementById("loginEyebrow").textContent = create ? "YOUR SPACE STARTS HERE" : "WELCOME BACK";
    document.getElementById("loginTitle").textContent = create ? "Make room for your thoughts." : "Pick up where you left off.";
    document.getElementById("loginDescription").textContent = create ? "Create a local profile and begin with one thought. No streaks, no pressure — just a space that is yours." : "Enter the name you used before to reopen your journal on this browser.";
    document.getElementById("loginSubmit").innerHTML = create ? 'Create my space <span>→</span>' : 'Open my journal <span>→</span>';
    document.getElementById("loginFootnote").textContent = "This is a local prototype, not secure password-based authentication. Your entries stay in this browser.";
  }

  function handleLogin() {
    const name = document.getElementById("name").value.trim();
    const age = document.getElementById("age").value.trim();
    const gender = document.getElementById("gender").value;
    if (!name) { toast("Enter your name to continue.", "warn"); return; }

    // Reuse an existing profile with the same name (simple local "login"),
    // otherwise create a new user id. This is what keeps User A and
    // User B's journal entries from mixing on a shared browser.
    const existing = DataLayer.getUsers().find(
      (u) => u.name.toLowerCase() === name.toLowerCase()
    );
    if (loginMode === "create" && existing) {
      toast("A local profile with that name already exists. Choose ‘I have a profile’ to continue.", "warn");
      return;
    }
    if (loginMode === "return" && !existing) {
      toast("No local profile with that name was found in this browser.", "warn");
      return;
    }
    const user = existing || { id: uid("user"), name, age: "", gender: "", createdAt: new Date().toISOString() };
    if (loginMode === "create" && !existing) { user.age = age; user.gender = gender; }
    else if (existing && loginMode === "create") { user.age = age || user.age || ""; user.gender = gender || user.gender || ""; }
    DataLayer.saveUser(user);
    DataLayer.setCurrentUser(user.id);

    enterApp(user);
  }

  function handleLogout() {
    // Logout only clears the session pointer — journal entries and the
    // user profile stay in localStorage under their own keys.
    DataLayer.clearSession();
    location.reload();
  }


  /* ===================================================================
     SAMPLE JOURNAL SET — 18 clearly labelled test entries
     Added once per local profile so the app can be explored with data.
     These are fictional examples, not the user's personal journal.
     =================================================================== */

  const SAMPLE_JOURNALS = [
    { daysAgo: 28, clock: "07:40", period: "Morning", context: "Personal", emotion: "Calm", secondary: "Grateful", text: "Woke up a little earlier than usual. The room was quiet and I finally had time to make tea without rushing. I want to keep a little space for myself before the day gets busy." },
    { daysAgo: 26, clock: "21:15", period: "Night", context: "Academics", emotion: "Anxious", secondary: "Determined", text: "I keep thinking about the upcoming assessment. There is still a lot to revise and I am worried I will forget something, but making a small topic list has made it feel more manageable." },
    { daysAgo: 24, clock: "14:20", period: "Afternoon", context: "Relationships", emotion: "Grateful", secondary: "Happy", text: "Had a long conversation with a friend today. Nothing extraordinary happened, but being able to talk honestly and laugh for a while made the afternoon feel lighter." },
    { daysAgo: 22, clock: "18:35", period: "Evening", context: "Academics", emotion: "Proud", secondary: "Relieved", text: "Finished a difficult part of the assignment that I had been avoiding. It took longer than expected, but I am glad I sat down and worked through it instead of postponing it again." },
    { daysAgo: 20, clock: "23:05", period: "Night", context: "Personal", emotion: "Sad", secondary: "Nostalgic", text: "Missing home a little tonight. Small familiar things came to mind and I realised how much I take those ordinary moments for granted when I am busy." },
    { daysAgo: 19, clock: "08:10", period: "Morning", context: "Personal", emotion: "Hopeful", secondary: "Calm", text: "Today feels like a fresh start. I do not have a perfect plan, but I want to focus on what I can finish instead of worrying about the entire week." },
    { daysAgo: 17, clock: "16:50", period: "Afternoon", context: "Academics", emotion: "Frustrated", secondary: "Confused", text: "Spent quite some time debugging and the same error kept appearing. I felt irritated for a while, so I stepped away, came back, and noticed a small mistake I had missed." },
    { daysAgo: 15, clock: "20:25", period: "Evening", context: "Family", emotion: "Loved", secondary: "Happy", text: "A call with family made my day. I had been caught up in deadlines and did not realise how much I needed that familiar conversation." },
    { daysAgo: 13, clock: "12:45", period: "Afternoon", context: "Personal", emotion: "Overwhelmed", secondary: "Anxious", text: "There are too many little things competing for my attention today. I wrote them down and picked just one to begin with. That helped me stop switching between everything." },
    { daysAgo: 12, clock: "22:10", period: "Night", context: "Relationships", emotion: "Disappointed", secondary: "Reflective", text: "I expected the conversation to go differently and felt disappointed afterwards. I am not completely sure what bothered me most, so I want to give myself time before reacting." },
    { daysAgo: 10, clock: "07:55", period: "Morning", context: "Health", emotion: "Tired", secondary: "Calm", text: "Did not sleep as well as I wanted, so I am taking the morning slowly. I will try not to judge the whole day by how I feel in the first hour." },
    { daysAgo: 9, clock: "19:05", period: "Evening", context: "Academics", emotion: "Confident", secondary: "Excited", text: "Our project is starting to come together. There are still things to improve, but seeing the pieces connect makes me excited to show the progress." },
    { daysAgo: 7, clock: "15:30", period: "Afternoon", context: "Personal", emotion: "Content", secondary: "Grateful", text: "A simple day with no major plans. I got a few things done, listened to music, and enjoyed not having to rush from one thing to another." },
    { daysAgo: 6, clock: "22:35", period: "Night", context: "Academics", emotion: "Anxious", secondary: "Focused", text: "The deadline is getting closer and I can feel myself overthinking the final details. I have a workable draft now, so tomorrow I want to review it calmly rather than keep rewriting everything tonight." },
    { daysAgo: 4, clock: "13:15", period: "Afternoon", context: "Relationships", emotion: "Amused", secondary: "Happy", text: "Had a funny exchange with my friends that kept making me smile even after it ended. It reminded me that a small moment can change the mood of an otherwise ordinary day." },
    { daysAgo: 3, clock: "18:50", period: "Evening", context: "Personal", emotion: "Reflective", secondary: "Hopeful", text: "Looking back at the last few weeks, I can see that I handled some things better than I expected. I still have work to do, but I do not want to overlook the progress." },
    { daysAgo: 1, clock: "09:20", period: "Morning", context: "Academics", emotion: "Determined", secondary: "Calm", text: "Made a realistic plan for the day with breaks included. I usually make a long list and then feel behind, so today I am trying to keep the priorities small and clear." },
    { daysAgo: 0, clock: "20:40", period: "Evening", context: "Personal", emotion: "Curious", secondary: "Hopeful", text: "I want to understand my own patterns a little better. I have noticed that writing things down helps me organise thoughts, especially when the day has felt full." }
  ];

  function seedSampleJournals(user) {
    if (!user) return;
    const alreadySeeded = DataLayer.getSetting(user.id, "sampleJournalsSeeded", false);
    if (alreadySeeded) return;

    const now = new Date();
    const emotionScores = {
      Calm: { Calm: 0.78, Happy: 0.12, Anxious: 0.10 },
      Anxious: { Anxious: 0.72, Calm: 0.10, Sad: 0.18 },
      Grateful: { Happy: 0.62, Calm: 0.28, Confident: 0.10 },
      Happy: { Happy: 0.78, Calm: 0.12, Excited: 0.10 },
      Proud: { Confident: 0.72, Happy: 0.20, Calm: 0.08 },
      Sad: { Sad: 0.72, Calm: 0.12, Anxious: 0.16 },
      Hopeful: { Confident: 0.55, Calm: 0.25, Happy: 0.20 },
      Frustrated: { Angry: 0.58, Anxious: 0.22, Confident: 0.20 },
      Loved: { Happy: 0.62, Calm: 0.28, Excited: 0.10 },
      Overwhelmed: { Anxious: 0.62, Sad: 0.18, Calm: 0.20 },
      Disappointed: { Sad: 0.58, Angry: 0.22, Calm: 0.20 },
      Tired: { Calm: 0.45, Sad: 0.30, Anxious: 0.25 },
      Confident: { Confident: 0.72, Happy: 0.18, Excited: 0.10 },
      Content: { Calm: 0.60, Happy: 0.30, Grateful: 0.10 },
      Amused: { Happy: 0.55, Excited: 0.35, Calm: 0.10 },
      Reflective: { Calm: 0.45, Confident: 0.30, Sad: 0.25 },
      Determined: { Confident: 0.62, Calm: 0.23, Anxious: 0.15 },
      Curious: { Confident: 0.45, Excited: 0.35, Calm: 0.20 }
    };
    SAMPLE_JOURNALS.forEach((sample, index) => {
      const date = new Date(now);
      date.setDate(date.getDate() - sample.daysAgo);
      const [hours, minutes] = sample.clock.split(":").map(Number);
      date.setHours(hours, minutes, 0, 0);
      const scores = emotionScores[sample.emotion] || { Calm: 1 };
      const entry = {
        id: uid("sample"), userId: user.id, text: sample.text,
        date: localDateKey(date), time: fmtTime(date), timestamp: date.toISOString(),
        timePeriod: sample.period, entryContext: sample.context,
        primaryEmotion: normalizeEmotionName(sample.emotion), secondaryEmotion: normalizeEmotionName(sample.secondary),
        primaryPercentage: Math.round((Math.max(...Object.values(scores))) * 100),
        secondaryPercentage: 20, scores, mixed: false,
        triggers: [], language: "English", emojiDetected: false,
        moodScore: Math.round((Object.values(scores)[0] || 0.5) * 100),
        characterCount: sample.text.length,
        wordCount: sample.text.split(/\s+/).filter(Boolean).length,
        sentences: [], modelUsed: "MuseMind reflection",
        modelVersion: "demo-seed-v1", analysisSource: "MuseMind reflection",
        analysisSchemaVersion: 3, createdAt: date.toISOString(), updatedAt: date.toISOString(),
        reflection: "Sample reflection entry for testing MuseMind's journal, timeline and insight features.",
        demo: true, demoLabel: ""
      };
      DataLayer.saveEntry(entry);
    });
    DataLayer.setSetting(user.id, "sampleJournalsSeeded", true);
  }


  /* ===================================================================
     MONTH-LONG DEMONSTRATION WORKSPACE
     Synthetic records are clearly identified as DEMO data. They are
     seeded once per profile to make every workflow testable offline.
     =================================================================== */
  function seedMonthDemoWorkspace(user) {
    if (!user) return;

    const now = new Date();
    const records = [
      ["Personal", "Calm", "Morning", "07:35", "Started the day slowly and made a short plan before checking messages. Having three clear priorities made the morning feel less rushed."],
      ["Academics", "Stressed", "Night", "21:20", "I have a Software Engineering submission coming up. The requirements looked confusing at first, so I broke the work into smaller sections and listed what still needs attention."],
      ["Relationships", "Happy", "Evening", "19:10", "Caught up with a close friend after classes. It was a simple conversation, but it helped me switch off from the pressure of the day."],
      ["Project", "Confident", "Afternoon", "15:45", "Made progress on the MuseMind interface today. The document upload flow is beginning to make sense, although I still need to test what happens when a PDF has no selectable text."],
      ["Family", "Sad", "Night", "22:40", "Missing home tonight. A call helped, but I still felt a little disconnected after hanging up. I want to make more time for these conversations."],
      ["Academics", "Anxious", "Morning", "08:15", "Thinking about the upcoming Computer Networks test. I know the topics, but I am not confident about solving the numericals quickly. I should practise a few examples instead of rereading everything."],
      ["Personal", "Happy", "Afternoon", "13:05", "Had a productive afternoon without trying to finish everything at once. Taking a proper break between tasks helped me focus again."],
      ["Project", "Frustrated", "Evening", "18:25", "The timeline chart was blank again. I found that some sample emotion names were not part of the app's supported categories. I need consistent data labels and a fallback rendering path."],
      ["Academics", "Confident", "Night", "20:50", "Finished revising the first two Computer Networks units. I am more comfortable with the protocol differences now. I should test myself without looking at the notes tomorrow."],
      ["Relationships", "Disappointed", "Afternoon", "16:10", "A plan changed at the last moment and I felt disappointed. I do not know whether it was the change itself or the lack of notice that bothered me more."],
      ["Personal", "Calm", "Morning", "07:55", "A quiet morning helped me organise my thoughts. I have noticed that writing before the day gets busy feels easier than trying to remember everything at night."],
      ["Project", "Excited", "Evening", "19:35", "The idea of connecting journal entries with uploaded documents feels much more useful than keeping separate pages. I want the search results to show exactly where each answer came from."],
      ["Academics", "Stressed", "Night", "22:05", "I have several small deadlines close together. I wrote them down in one place and picked the earliest one to work on first. The list made the workload feel more visible."],
      ["Health", "Tired", "Afternoon", "14:30", "Low energy today, probably because I slept late. I am going to keep the evening lighter and avoid making an unrealistic study plan."],
      ["Project", "Proud", "Evening", "18:55", "Completed the first pass of the knowledge search layout. It still needs better empty states and source links, but the flow is clearer than the earlier version."],
      ["Academics", "Anxious", "Night", "21:45", "I am worried I will leave revision too late. I can make a small checklist for the next three days and keep the plan realistic."],
      ["Family", "Grateful", "Evening", "20:15", "Had dinner while talking to family on a call. It felt good to share ordinary updates instead of only discussing college work."],
      ["Project", "Curious", "Afternoon", "12:40", "I want to understand how semantic search differs from keyword search. A query should find a related document even when it does not repeat the exact words."],
      ["Academics", "Confident", "Morning", "09:05", "Solved a few practice questions without checking the answer immediately. I made mistakes, but I could identify which concepts need another round."],
      ["Personal", "Reflective", "Night", "23:00", "Looking back at the month, I have been switching between academic work and project development. I want to protect some time for rest so the schedule remains sustainable."],
      ["Project", "Frustrated", "Afternoon", "16:35", "The extracted date from a document needs a confirmation step. A date can be mentioned as an example or a past event, so automatic scheduling without review would be risky."],
      ["Relationships", "Happy", "Evening", "18:45", "Spent time with friends and laughed about something completely unrelated to college. I needed a break from thinking about tasks and deadlines."],
      ["Academics", "Stressed", "Morning", "08:35", "There is a quiz this week and I have not revised all the slides. I will start with the topics that usually take me longer rather than spending too much time on familiar ones."],
      ["Project", "Determined", "Night", "21:10", "I want the demo to show one connected workflow: upload a document, review extracted dates, save a task, and then retrieve that information through search."],
      ["Personal", "Content", "Afternoon", "13:50", "Today felt balanced. I completed the main task, took a break, and did not keep checking the list after finishing what mattered."],
      ["Academics", "Proud", "Evening", "19:25", "Submitted a piece of work before the deadline. I felt relieved that I did not leave the final check until the last minute."],
      ["Project", "Hopeful", "Morning", "08:00", "The product direction is becoming clearer. I want MuseMind to be judged on whether the information retrieval and document workflow actually work, not just how many cards are on the dashboard."],
      ["Health", "Calm", "Night", "22:15", "Took a little time away from the screen before sleeping. It helped me slow down after a day with too many tabs and unfinished thoughts."],
      ["Academics", "Focused", "Afternoon", "15:20", "Worked through a networking numerical step by step. Writing down the known values first made the problem easier to approach."],
      ["Personal", "Hopeful", "Evening", "20:05", "I want to keep using a simple reflection habit when it helps, but I do not want it to become another task I feel guilty about missing."]
    ];

    const existing = DataLayer.getUserEntries(user.id);
    const existingDemo = existing.filter(e => e.demoMonth === true).length;
    if (!existingDemo) {
      records.forEach((r, index) => {
        const [context, emotion, period, clock, text] = r;
        const date = new Date(now);
        date.setDate(date.getDate() - (29 - index));
        const [hh, mm] = clock.split(":").map(Number);
        date.setHours(hh, mm, 0, 0);
        const mapped = normalizeEmotionName(emotion);
        const scoreMap = {
          Happy: { Happy: .76, Calm: .16, Confident: .08 },
          Calm: { Calm: .76, Happy: .14, Anxious: .10 },
          Stressed: { Stressed: .68, Anxious: .22, Calm: .10 },
          Anxious: { Anxious: .70, Stressed: .20, Calm: .10 },
          Confident: { Confident: .72, Happy: .18, Calm: .10 },
          Frustrated: { Angry: .62, Stressed: .23, Calm: .15 },
          Sad: { Sad: .68, Anxious: .20, Calm: .12 },
          Disappointed: { Sad: .62, Stressed: .23, Calm: .15 },
          Tired: { Calm: .48, Stressed: .28, Sad: .24 },
          Grateful: { Happy: .62, Calm: .28, Confident: .10 },
          Curious: { Confident: .48, Excited: .32, Calm: .20 },
          Proud: { Confident: .68, Happy: .22, Calm: .10 },
          Reflective: { Calm: .48, Confident: .30, Sad: .22 },
          Excited: { Excited: .62, Happy: .28, Confident: .10 },
          Determined: { Confident: .64, Stressed: .20, Calm: .16 },
          Content: { Calm: .62, Happy: .28, Confident: .10 },
          Hopeful: { Confident: .52, Calm: .28, Happy: .20 },
          Focused: { Confident: .60, Calm: .25, Stressed: .15 }
        };
        const scores = scoreMap[emotion] || { [mapped]: .7, Calm: .3 };
        const top = Object.entries(scores).sort((a,b)=>b[1]-a[1])[0];
        const secondary = Object.entries(scores).sort((a,b)=>b[1]-a[1])[1];
        DataLayer.saveEntry({
          id: uid("demoentry"), userId: user.id, text,
          date: localDateKey(date), time: fmtTime(date), timestamp: date.toISOString(),
          timePeriod: period, entryContext: context,
          primaryEmotion: top[0], secondaryEmotion: secondary[0],
          primaryPercentage: Math.round(top[1]*100), secondaryPercentage: Math.round(secondary[1]*100),
          scores, mixed: false, triggers: [context.toLowerCase()],
          language: "English", emojiDetected: false, moodScore: Math.round(top[1]*100),
          characterCount: text.length, wordCount: text.split(/\s+/).length,
          sentences: [], modelUsed: "Demo dataset — illustrative labels",
          modelVersion: "month-demo-v1", analysisSource: "DEMO DATA",
          analysisSchemaVersion: 3, createdAt: date.toISOString(), updatedAt: date.toISOString(),
          reflection: "Illustrative demonstration entry. Emotion labels are example annotations, not model ground truth.",
          demo: true, demoMonth: true, demoLabel: "DEMO DATA"
        });
      });
    }

    const docs = [
      { id:"demodoc_cn", name:"Computer_Networks_Revision_Plan.pdf", type:"PDF", category:"Academics", addedDaysAgo:25, pages:4,
        text:"Computer Networks revision plan. Unit 1: Network models and topologies. Unit 2: Data link layer and error control. Unit 3: Sliding Window Protocol and Selective Repeat ARQ. Practice numericals on propagation delay and throughput. Internal assessment review: 18 November 2026. Final revision checkpoint: 24 November 2026.",
        tags:["computer networks","revision","academics"], summary:"Revision plan covering network models, data link protocols, sliding window and numerical practice." },
      { id:"demodoc_se", name:"Software_Engineering_Assignment_Brief.pdf", type:"PDF", category:"Academics", addedDaysAgo:20, pages:3,
        text:"Software Engineering Assignment 2. Prepare a short report on test coverage and DevOps migration. Include statement coverage, branch coverage and one example test case. Submission date: 20 November 2026. Review the rubric before final submission.",
        tags:["software engineering","assignment","testing"], summary:"Assignment brief with coverage testing and DevOps migration requirements." },
      { id:"demodoc_pbl", name:"MuseMind_Project_Requirements.pdf", type:"PDF", category:"Project", addedDaysAgo:16, pages:5,
        text:"MuseMind project requirements. Preserve personal journaling and emotional reflection. Add a knowledge vault, document extraction, memory retrieval with source references, emotion analysis and user-controlled schedule creation. Demo milestone: 26 November 2026. Test PDF extraction, OCR fallback, search relevance and source traceability.",
        tags:["musemind","project","requirements"], summary:"Project requirements and demo validation checklist for the personal knowledge assistant." },
      { id:"demodoc_timetable", name:"November_Academic_Timetable.png", type:"Image", category:"Academics", addedDaysAgo:12, pages:1,
        text:"November academic timetable. Computer Networks practice session: 17 November 2026. Software Engineering assignment review: 19 November 2026. Project demonstration rehearsal: 25 November 2026.",
        tags:["timetable","deadlines","november"], summary:"A sample timetable with three extracted academic and project dates." }
    ];
    if (!DataLayer.getSetting(user.id, "knowledgeDocuments", null)) {
      DataLayer.setSetting(user.id, "knowledgeDocuments", docs.map(d => ({...d, addedAt: new Date(now.getTime()-d.addedDaysAgo*86400000).toISOString(), demo:true})));
    }

    const tasks = [
      ["Revise sliding window protocols","2026-11-17","Computer_Networks_Revision_Plan.pdf",true],
      ["Review Software Engineering rubric","2026-11-18","Software_Engineering_Assignment_Brief.pdf",true],
      ["Complete coverage testing section","2026-11-20","Software_Engineering_Assignment_Brief.pdf",false],
      ["Practise propagation delay numericals","2026-11-21","Computer_Networks_Revision_Plan.pdf",false],
      ["Finish DevOps migration report","2026-11-22","Software_Engineering_Assignment_Brief.pdf",false],
      ["Review MuseMind source citations","2026-11-23","MuseMind_Project_Requirements.pdf",false],
      ["Finalise project demo checklist","2026-11-24","MuseMind_Project_Requirements.pdf",false],
      ["Rehearse MuseMind demonstration","2026-11-25","MuseMind_Project_Requirements.pdf",false],
      ["Project demonstration milestone","2026-11-26","MuseMind_Project_Requirements.pdf",false],
      ["Organise revision notes","2026-11-15","Computer_Networks_Revision_Plan.pdf",true]
    ].map((t,i)=>({id:"demotask_"+i,title:t[0],date:t[1],source:t[2],done:t[3],demo:true,context:"Illustrative task extracted from sample demonstration document."}));
    if (!DataLayer.getSetting(user.id, "documentPlannerItems", []).some(x=>x.demo)) {
      DataLayer.setSetting(user.id, "documentPlannerItems", [...DataLayer.getSetting(user.id, "documentPlannerItems", []), ...tasks]);
    }

    // Five editable voice-note examples make the voice workflow easy to explore.
    if (!DataLayer.getSetting(user.id, "voiceNotesSeedV1", false)) {
      const voiceSamples = [
        ["I felt more organised today after breaking my work into smaller steps. I want to remember that a simple plan can make a busy day feel manageable.", "Personal", "Calm"],
        ["I need to revise the networking protocols again, but I understand the concepts better than I did last week. I should practise a few numericals tomorrow.", "Academic", "Confident"],
        ["The project is coming together. There are still details to fix, but seeing the different parts connect makes me feel motivated.", "Project", "Hopeful"],
        ["I missed home today. A call with my family helped, and I feel a little lighter now. I should make time for that more often.", "Family", "Reflective"],
        ["I am trying not to measure every day by how much I finish. Rest is useful too, and I want to be more patient with myself.", "Personal", "Content"]
      ];
      voiceSamples.forEach((v, i) => {
        const d = new Date(); d.setDate(d.getDate() - (i + 1)); d.setHours(10 + i * 2, 15, 0, 0);
        const text = v[0];
        DataLayer.saveEntry({
          id: uid("voice"), userId: user.id, text, voiceTranscript: text,
          inputMode: "voice-transcript", voiceLanguage: "en-IN", date: localDateKey(d),
          time: fmtTime(d), timestamp: d.toISOString(), createdAt: d.toISOString(), updatedAt: d.toISOString(),
          timePeriod: "Daytime", entryContext: v[1], primaryEmotion: normalizeEmotionName(v[2]),
          secondaryEmotion: "Calm", primaryPercentage: 0, secondaryPercentage: 0,
          scores: {}, mixed: false, triggers: [v[1].toLowerCase()], language: "English",
          moodScore: 0, characterCount: text.length, wordCount: text.split(/\s+/).length,
          sentences: [], modelUsed: "Voice transcript", modelVersion: "voice-seed-v1",
          analysisSource: "Voice transcript", analysisSchemaVersion: 3, reflection: ""
        });
      });
      DataLayer.setSetting(user.id, "voiceNotesSeedV1", true);
    }

    DataLayer.setSetting(user.id, "monthDemoWorkspaceV1", true);
  }

  function enterApp(user) {
    migrateLegacySampleEntries(user);
    seedSampleJournals(user);
    seedMonthDemoWorkspace(user);
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("app").style.display = "flex";
    document.getElementById("navUserName").textContent = user.name;
    document.getElementById("navUserMeta").textContent = [user.age ? `${user.age} yrs` : "", user.gender || ""].filter(Boolean).join(" • ") || "Your reflection space";
    document.getElementById("navAvatar").textContent = user.name.charAt(0).toUpperCase();
    goToSection("overview");
    renderAll();
  }

  /* ===================================================================
     5. NAVIGATION
     =================================================================== */

  function goToSection(section, options = {}) {
    const allowedSections = ["overview", "journal", "history", "insights", "calendar", "knowledge"];
    if (!allowedSections.includes(section) && !document.getElementById("view-" + section)) return;
    const previousSection = activeSection;
    activeSection = section;
    if (section === "journal") initializeEntryContext();
    document.querySelectorAll(".nav-link").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.section === section);
      btn.setAttribute("aria-current", btn.dataset.section === section ? "page" : "false");
    });
    document.querySelectorAll(".view").forEach((view) => {
      view.classList.toggle("active", view.id === "view-" + section);
      view.setAttribute("aria-hidden", view.id === "view-" + section ? "false" : "true");
    });
    const mobileNav = document.getElementById("mobileNav");
    if (mobileNav) mobileNav.classList.remove("open");
    if (section === "timeline") renderTimelineChart();
    if (section === "calendar") {
      try { renderCalendar(); }
      catch (error) {
        console.error("Calendar rendering failed", error);
        const detail = document.getElementById("calendarDayDetail");
        if (detail) detail.innerHTML = `<div class="calendar-empty-day"><strong>Your calendar could not load</strong><p>Please refresh the page. Your saved dates have not been deleted.</p></div>`;
      }
    }
    if (section === "insights") renderInsights();
    if (section === "history") renderHistory();
    if (section === "profile") renderProfile();
    if (section === "overview") renderOverview();
    if (section === "dataset") renderDatasetPage();
    if (section === "knowledge") renderKnowledgeVault();
    if (section === "memory") renderMemoryMirror();
    if (section === "growth") renderGrowthStudio();

    // Keep browser Back/Forward in sync with in-app page navigation.
    if (!options.fromHistory && previousSection !== section) {
      try { history.pushState({ musemindSection: section }, "", "#" + section); } catch (_) {}
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    const activeView = document.getElementById("view-" + section);
    if (activeView) activeView.setAttribute("tabindex", "-1");
  }


  function renderDatasetPage() {
    const box = document.getElementById("goEmotionLabels");
    if (box) box.innerHTML = GO_EMOTIONS.map(label => `<span>${escapeHTML(label)}</span>`).join("");
  }

  /* ===================================================================
     6. NEW JOURNAL / ANALYSIS
     =================================================================== */

  function getTimePeriod(date = new Date()) {
    const hour = date.getHours();
    if (hour >= 5 && hour < 12) return "Morning";
    if (hour >= 12 && hour < 17) return "Afternoon";
    if (hour >= 17 && hour < 21) return "Evening";
    return "Night";
  }

  function initializeEntryContext() {
    const period = document.getElementById("entryTimePeriod");
    if (period) period.value = getTimePeriod();
    const label = document.getElementById("autoTimeLabel");
    if (label) label.textContent = `Suggested: ${getTimePeriod()}`;
  }

  function updateCounter() {
    const text = document.getElementById("entry").value;
    document.getElementById("counter").textContent = text.length;
  }

  function quickMood(emotion) {
    const phrases = {
      Happy: "I am feeling happy and good about things today.",
      Calm: "I am feeling calm and at peace right now.",
      Stressed: "I am feeling stressed and under pressure today.",
      Sad: "I am feeling a little sad and low today.",
    };
    document.getElementById("entry").value = phrases[emotion] || `I am feeling ${emotion.toLowerCase()} today.`;
    updateCounter();
    analyzeEmotion();
  }

  async function analyzeEmotion() {
    const textarea = document.getElementById("entry");
    const text = textarea ? textarea.value.trim() : "";
    if (!text) {
      toast("Write something before analyzing.", "warn");
      textarea?.focus();
      return;
    }
    clearDraft();
    await analyzeAndSaveText(text, { clearJournal: true, sourceLabel: "New journal entry" });
  }


  function nextFutureISODate(day, month, year) {
    const today=new Date();
    let y=year?Number(year):today.getFullYear();
    let candidate=new Date(y,Number(month)-1,Number(day),12,0,0,0);
    if(candidate.getFullYear()!==y || candidate.getMonth()!==Number(month)-1 || candidate.getDate()!==Number(day)) return null;
    if(!year && candidate < new Date(today.getFullYear(),today.getMonth(),today.getDate(),12)) {
      y+=1; candidate=new Date(y,Number(month)-1,Number(day),12,0,0,0);
    }
    return `${candidate.getFullYear()}-${String(candidate.getMonth()+1).padStart(2,"0")}-${String(candidate.getDate()).padStart(2,"0")}`;
  }

  function detectJournalScheduleCandidates(text) {
    const sentences=String(text||"").match(/[^.!?]+[.!?]?/g)||[];
    const monthNames="January February March April May June July August September October November December".split(" ");
    const monthPattern="Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
    const results=[];
    sentences.forEach(sentence=>{
      const s=sentence.trim();
      if(!s) return;
      // Only suggest calendar items when the same sentence describes an actionable event.
      const actionMatch=/\b(book(?:ed|ing)?|flight|travel|trip|appointment|meeting|exam(?:ination)?|test|deadline|due|submit|submission|interview|event|birthday|wedding|concert|class|lecture|departure|arrival|reminder|scheduled?|plan(?:ned)?)\b/i.test(s);
      if(!actionMatch) return;
      const patterns=[
        new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(${monthPattern})(?:\\s*,?\\s*(20\\d{2}))?\\b`,"i"),
        new RegExp(`\\b(${monthPattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(20\\d{2}))?\\b`,"i"),
        /\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](20\d{2}))?\b/
      ];
      let match=null,day,month,year=null;
      for(let p=0;p<patterns.length;p++){
        match=s.match(patterns[p]); if(!match) continue;
        if(p===0){day=Number(match[1]);month=monthNames.findIndex(m=>m.toLowerCase().startsWith(match[2].slice(0,3).toLowerCase()))+1;year=match[3]||null;}
        else if(p===1){month=monthNames.findIndex(m=>m.toLowerCase().startsWith(match[1].slice(0,3).toLowerCase()))+1;day=Number(match[2]);year=match[3]||null;}
        else {day=Number(match[1]);month=Number(match[2]);year=match[3]||null;}
        break;
      }
      if(!match || !month || !day) return;
      const date=nextFutureISODate(day,month,year);
      if(!date) return;
      let title="Personal event",category="Personal";
      if(/\bflight|airline|airport|boarding|plane\b/i.test(s)){title="Flight / Travel";category="Travel";}
      else if(/\bexam|examination|paper\b/i.test(s)){title="Examination";category="Examination";}
      else if(/\bdeadline|due|submit|submission\b/i.test(s)){title="Deadline";category="Deadline";}
      else if(/\bmeeting|appointment|interview\b/i.test(s)){title="Appointment";category="Personal";}
      else if(/\bbirthday|wedding|concert|event\b/i.test(s)){title="Personal event";category="Personal";}
      else if(/\bclass|lecture\b/i.test(s)){title="Class / Lecture";category="Academic";}
      const inferred=!year;
      const candidate={id:uid("journal-event"),date,title,subjectCode:"",category,time:"",context:s,source:"Journal entry",selected:true,yearInferred:inferred};
      if(!results.some(x=>x.date===date&&x.title===title)) results.push(candidate);
    });
    return results;
  }

  function showJournalEventReview(candidates) {
    if(!candidates.length) return;
    let modal=document.getElementById("journalEventReviewModal");
    if(!modal){
      modal=document.createElement("div"); modal.id="journalEventReviewModal"; modal.className="journal-event-modal";
      modal.innerHTML='<div class="journal-event-dialog" role="dialog" aria-modal="true" aria-labelledby="journalEventReviewTitle"><button class="journal-event-close" type="button" onclick="MuseMind.dismissJournalEventReview()">×</button><p class="view-eyebrow">POSSIBLE CALENDAR EVENT</p><h2 id="journalEventReviewTitle">I noticed a date in your journal</h2><p class="muted-note">Would you like me to add this to your Calendar? Please review the details first. Nothing is added until you confirm.</p><div id="journalEventReviewItems"></div><div class="timetable-review-actions"><button class="command-btn primary" type="button" onclick="MuseMind.confirmJournalEvents()">Confirm &amp; Add to Calendar</button><button class="mini-btn" type="button" onclick="MuseMind.dismissJournalEventReview()">Not now</button></div></div>';
      document.body.appendChild(modal);
    }
    const box=modal.querySelector("#journalEventReviewItems");
    box.innerHTML=candidates.map((item,i)=>`<div class="journal-event-review-row">
      <label class="planner-check"><input type="checkbox" data-journal-event-check="${i}" ${item.selected?"checked":""}><span></span></label>
      <div class="planner-item-fields">
        <input class="planner-title-input" data-journal-event-title="${i}" value="${escapeHTML(item.title)}" aria-label="Event title">
        <div class="planner-review-meta">
          <input class="planner-date-input" type="date" data-journal-event-date="${i}" value="${item.date}" aria-label="Event date">
          <input class="planner-date-input" type="time" data-journal-event-time="${i}" value="" aria-label="Event time (optional)">
          <select class="planner-date-input" data-journal-event-category="${i}" aria-label="Event category">${["Travel","Examination","Academic","Assignment","Deadline","Personal","University Event","Reminder"].map(c=>`<option ${item.category===c?"selected":""}>${c}</option>`).join("")}</select>
        </div>
        <small>${escapeHTML(item.context)}${item.yearInferred?" · Year suggested from the next upcoming date; please verify.":""}</small>
      </div>
    </div>`).join("");
    modal.dataset.candidates=JSON.stringify(candidates);
    modal.classList.add("open");
  }

  function dismissJournalEventReview() {
    const modal=document.getElementById("journalEventReviewModal");
    if(modal) modal.classList.remove("open");
  }

  function confirmJournalEvents() {
    const modal=document.getElementById("journalEventReviewModal");
    if(!modal) return;
    let candidates=[]; try{candidates=JSON.parse(modal.dataset.candidates||"[]");}catch(_){}
    const items=getPlannerItems(); let added=0,duplicates=0;
    candidates.forEach((item,i)=>{
      if(!modal.querySelector(`[data-journal-event-check="${i}"]`)?.checked) return;
      const title=modal.querySelector(`[data-journal-event-title="${i}"]`)?.value.trim()||"";
      const date=modal.querySelector(`[data-journal-event-date="${i}"]`)?.value||"";
      const time=modal.querySelector(`[data-journal-event-time="${i}"]`)?.value||"";
      const category=modal.querySelector(`[data-journal-event-category="${i}"]`)?.value||item.category||"Personal";
      const parsed=new Date(date+"T12:00:00");
      if(!title||!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(parsed.getTime())||localDateKey(parsed)!==date) return;
      if(items.some(x=>x.date===date&&String(x.title||"").toLowerCase()===title.toLowerCase())){duplicates++;return;}
      items.push({...item,id:uid("plan"),title,date,time,category,done:false,createdAt:new Date().toISOString()}); added++;
    });
    savePlannerItems(items.sort((a,b)=>a.date.localeCompare(b.date)||(a.time||"").localeCompare(b.time||"")));
    dismissJournalEventReview();
    if(added){
      const first=items.filter(x=>x.source==="Journal entry").sort((a,b)=>a.date.localeCompare(b.date))[0];
      if(first){
        calendarCursor=new Date(first.date+"T12:00:00");
        calendarCursor=new Date(calendarCursor.getFullYear(),calendarCursor.getMonth(),1);
        selectedCalendarDate=first.date;
        goToSection("calendar");
        renderCalendar();
        showCalendarDay(first.date);
      }
      toast(`${added} event${added===1?"":"s"} added to Calendar${duplicates?`; ${duplicates} duplicate skipped`:""}.`,"success");
    } else toast(duplicates?"That event is already in your Calendar.":"No events were added. Review the selected details.","warn");
  }

  async function analyzeAndSaveText(text, options = {}) {
    const user = DataLayer.getCurrentUser();
    if (!user || !text) return null;

    const btn = document.getElementById("analyzeBtn");
    if (btn) { btn.classList.add("loading"); btn.disabled = true; }
    const status = document.getElementById("engineStatus");
    if (status) status.textContent = "Analyzing emotional signals…";

    try {
      const journalScheduleCandidates = options.sourceLabel === "New journal entry" && options.save !== false
        ? detectJournalScheduleCandidates(text) : [];
      const result = await analyzeText(text);
      const now = new Date();
      const recent = DataLayer.getUserEntries(user.id).slice(0, 10);
      const entry = {
        id: options.save === false ? uid("analysis") : uid("entry"), userId: user.id, text,
        date: localDateKey(now), time: fmtTime(now), timestamp: now.toISOString(),
        timePeriod: document.getElementById("entryTimePeriod")?.value || getTimePeriod(now),
        entryContext: document.getElementById("entryContext")?.value || "Personal",
        primaryEmotion: result.primary, secondaryEmotion: result.secondary,
        primaryPercentage: result.primaryPercent, secondaryPercentage: result.secondaryPercent,
        scores: result.scores, goEmotions: result.goEmotions || [], goEmotionScores: result.goEmotionScores || [],
        primaryGoLabel: result.primaryGoLabel || null, secondaryGoLabel: result.secondaryGoLabel || null,
        primaryGoConfidence: result.primaryGoConfidence || 0, secondaryGoConfidence: result.secondaryGoConfidence || 0,
        mixed: result.mixed, triggers: result.triggers, language: result.language,
        emojiDetected: result.emojiDetected, moodScore: result.moodScore,
        characterCount: text.length, wordCount: text.split(/\s+/).filter(Boolean).length,
        voiceTranscript: (document.getElementById("voiceTranscript")?.value || "").trim(),
        inputMode: (document.getElementById("voiceTranscript")?.value || "").trim() ? "voice-transcript" : "typed",
        voiceLanguage: document.getElementById("voiceLanguage")?.value || "en-IN",
        sentences: result.sentences || [], modelUsed: result.modelUsed,
        modelVersion: result.modelVersion, analysisSource: result.analysisSource,
        analysisSchemaVersion: 3, createdAt: now.toISOString(), updatedAt: now.toISOString(), reflection: ""
      };
      entry.reflection = generateReflection(entry, recent);
      if (options.save !== false) DataLayer.saveEntry(entry);
      showAnalysis(entry, recent);
      if (options.clearJournal) {
        const textarea = document.getElementById("entry");
        if (textarea) textarea.value = "";
        updateCounter();
        clearDraft();
        if (entry.voiceTranscript) clearVoiceTranscript();
      }
      goToSection("analysis");
      if (journalScheduleCandidates.length) showJournalEventReview(journalScheduleCandidates);
      const statusBox = document.getElementById("analysisSelectionStatus");
      if (statusBox) statusBox.textContent = `Analyzed ${entry.wordCount} words from ${options.sourceLabel || "selected text"}${options.save === false ? " · not added to history" : " · saved to history"}.`;
      toast(entry.analysisSource === "GoEmotions Model" ? "Emotion analysis complete." : "Analysis complete using fallback mode.", entry.analysisSource === "GoEmotions Model" ? "success" : "warn");
      if (options.save !== false) renderAll();
      return entry;
    } catch (error) {
      console.error(error);
      toast(error.message || "Analysis failed. Please try again.", "warn");
      return null;
    } finally {
      if (btn) { btn.classList.remove("loading"); btn.disabled = false; }
      if (status) status.textContent = "Analysis complete.";
    }
  }

  async function analyzeSelectedText() {
    const box = document.getElementById("analysisInput");
    const text = box ? box.value.trim() : "";
    if (!text) { toast("Enter or select some text first.", "warn"); return; }
    await analyzeAndSaveText(text, { clearJournal: false, save: false, sourceLabel: "selected text" });
  }

  function useJournalSelection() {
    const journal = document.getElementById("entry");
    const box = document.getElementById("analysisInput");
    if (!journal || !box) return;
    const start = journal.selectionStart;
    const end = journal.selectionEnd;
    const selected = start !== end ? journal.value.slice(start, end).trim() : journal.value.trim();
    if (!selected) { toast("Write something in your journal first.", "warn"); return; }
    box.value = selected;
    document.getElementById("analysisSelectionStatus").textContent = start !== end
      ? "Selected text copied from your journal. Ready to analyze."
      : "Your full journal text was copied. You can edit it before analysis.";
    box.focus();
  }

  async function analyzeHistoryEntry(id) {
    const entry = DataLayer.getAllEntries().find((e) => e.id === id);
    if (!entry) return;
    const user = DataLayer.getCurrentUser();
    if (!user || entry.userId !== user.id) return;
    const updated = await analyzeText(entry.text);
    const patch = {
      primaryEmotion: updated.primary, secondaryEmotion: updated.secondary,
      primaryPercentage: updated.primaryPercent, secondaryPercentage: updated.secondaryPercent,
      scores: updated.scores, goEmotions: updated.goEmotions || [], goEmotionScores: updated.goEmotionScores || [],
      primaryGoLabel: updated.primaryGoLabel || null, secondaryGoLabel: updated.secondaryGoLabel || null,
      primaryGoConfidence: updated.primaryGoConfidence || 0, secondaryGoConfidence: updated.secondaryGoConfidence || 0,
      mixed: updated.mixed, triggers: updated.triggers, language: updated.language,
      emojiDetected: updated.emojiDetected, moodScore: updated.moodScore, sentences: updated.sentences || [],
      modelUsed: updated.modelUsed, modelVersion: updated.modelVersion, analysisSource: updated.analysisSource,
      analysisSchemaVersion: 3, updatedAt: new Date().toISOString()
    };
    const saved = DataLayer.updateEntry(id, patch);
    const previous = DataLayer.getUserEntries(user.id).filter(e => e.id !== id).slice(0, 10);
    if (saved) { showAnalysis(saved, previous); goToSection("analysis"); toast("Saved entry re-analyzed with the current engine.", "success"); }
  }

  function showAnalysis(entry, previousEntries = []) {
    activeAnalysisEntryId = entry.id || null;
    const correctionSelect = document.getElementById("humanEmotionLabel");
    if (correctionSelect) correctionSelect.value = entry.humanEmotionLabel || "";
    const correctionStatus = document.getElementById("modelFeedbackStatus");
    if (correctionStatus) correctionStatus.textContent = entry.humanEmotionLabel ? `Your correction: ${entry.humanEmotionLabel}. Saved locally for future review.` : "If the prediction feels off, save a correction. It will not retrain the live model automatically.";
    const safePrimary = EMOTIONS[entry.primaryEmotion] ? entry.primaryEmotion : "Calm";
    const safeSecondary = EMOTIONS[entry.secondaryEmotion] ? entry.secondaryEmotion : safePrimary;
    const primaryPct = Number(entry.primaryPercentage) || 0;
    const secondaryPct = Number(entry.secondaryPercentage) || 0;
    const goScores = Array.isArray(entry.goEmotionScores) && entry.goEmotionScores.length
      ? entry.goEmotionScores
      : (entry.goEmotions || []);

    // Human-first reflection summary: keep model probabilities in the technical layer.
    const snapshotTitle = document.getElementById("snapshotTitle");
    const snapshotIntro = document.getElementById("snapshotIntro");
    const snapshotSignals = document.getElementById("snapshotSignals");
    const snapshotReflection = document.getElementById("snapshotReflection");
    if (snapshotTitle) snapshotTitle.textContent = "A few things may be present in this moment.";
    if (snapshotIntro) snapshotIntro.textContent = "Based on this entry, MuseMind noticed these possible emotional signals. They are prompts for reflection, not labels you have to accept.";
    if (snapshotSignals) {
      const labels = [safePrimary, safeSecondary].filter((v,i,a)=>v && a.indexOf(v)===i);
      snapshotSignals.innerHTML = labels.map((label,i)=>`<div class="snapshot-signal ${i===0?'primary-signal':'secondary-signal'}"><span>${EMOTIONS[label].emoji}</span><div><small>${i===0?'MOST NOTICEABLE SIGNAL':'ALSO PRESENT'}</small><b>${escapeHTML(label)}</b></div></div>`).join("");
    }
    if (snapshotReflection) snapshotReflection.textContent = entry.reflection || "What part of this moment would you like to remember?";

    const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    set("analysisModel", entry.modelUsed || "MuseMind Emotion Engine");
    set("analysisSource", entry.analysisSource || "Stored analysis");
    set("analysisLanguage", entry.language || "English");
    set("analysisTimestamp", `${fmtDate(new Date(entry.timestamp))} • ${entry.time || fmtTime(new Date(entry.timestamp))}`);
    set("analysisMeta", `${entry.wordCount || 0} words • ${entry.characterCount || entry.text.length} characters${entry.emojiDetected ? " • emoji detected" : ""}`);
    const analysisInput = document.getElementById("analysisInput");
    if (analysisInput) analysisInput.value = entry.text || "";

    const banner = document.getElementById("analysisEngineBanner");
    if (banner) banner.innerHTML = `<span class="analysis-engine-dot"></span><span>${entry.analysisSource === "GoEmotions Model" ? "GoEmotions model analysis completed — 28 emotion signals retained." : "Fallback analysis completed — transparent keyword rules used for this language."}</span>`;

    set("primaryEmoji", EMOTIONS[safePrimary].emoji);
    set("primaryEmotion", safePrimary);
    set("primaryPercent", `${primaryPct}%`);
    set("primaryPercentRadial", `${primaryPct}%`);
    set("primaryCategory", safePrimary);
    set("secondaryEmoji", EMOTIONS[safeSecondary].emoji);
    set("secondaryEmotion", safeSecondary);
    set("secondaryPercent", `${secondaryPct}%`);
    set("secondaryPercentRadial", `${secondaryPct}%`);
    set("secondaryCategoryLine", `MuseMind Category: ${safeSecondary}`);

    const progress = document.getElementById("primaryProgress");
    if (progress) progress.style.width = `${Math.min(100, primaryPct)}%`;
    ["primaryRadial", "secondaryRadial"].forEach((id, i) => {
      const el = document.getElementById(id);
      if (el) el.style.setProperty("--score", `${i === 0 ? primaryPct : secondaryPct}%`);
    });

    const triggerBox = document.getElementById("analysisTriggers");
    if (triggerBox) triggerBox.innerHTML = entry.triggers?.length
      ? entry.triggers.map(t => `<span class="chip">🔎 ${escapeHTML(t)}</span>`).join("")
      : `<span class="chip chip-muted">No clear trigger detected</span>`;

    const ranking = document.getElementById("emotionRanking");
    const top = goScores.slice().sort((a,b) => (b.confidence ?? b.score ?? 0) - (a.confidence ?? a.score ?? 0)).slice(0, 8);
    if (ranking) ranking.innerHTML = top.length ? top.map((x, i) => {
      const score = Math.round(((x.confidence ?? x.score ?? 0) * 100));
      const label = String(x.label || "neutral");
      return `<div class="emotion-rank-row"><span class="rank-number">${i + 1}</span><span class="rank-label">${escapeHTML(label)}</span><span class="rank-bar"><i style="width:${Math.max(2, score)}%"></i></span><strong>${score}%</strong></div>`;
    }).join("") : `<p class="muted-note">Detailed model labels are unavailable for this entry.</p>`;

    const mixed = document.getElementById("mixedEmotionContent");
    const strongSignals = top.filter(x => String(x.label) !== "neutral" && ((x.confidence ?? x.score ?? 0) >= 0.20));
    if (mixed) mixed.innerHTML = entry.mixed
      ? `<div class="mixed-result"><strong>Mixed emotion detected</strong><p>${strongSignals.slice(0,4).map(x => escapeHTML(x.label)).join(" · ")}</p><small>More than one meaningful emotional signal is present in the same text.</small></div>`
      : `<div class="mixed-result"><strong>Mostly one dominant signal</strong><p>${escapeHTML(top[0]?.label || safePrimary)}</p><small>No second signal crossed MuseMind's mixed-emotion threshold.</small></div>`;

    const mapping = document.getElementById("mappingContent");
    if (mapping) {
      const mapped = top.slice(0, 6).map(x => ({...x, category: GO_TO_MUSE[String(x.label)]})).filter(x => x.category);
      mapping.innerHTML = mapped.length ? mapped.map(x => `<div class="mapping-row"><span>${escapeHTML(x.label)}</span><b>→</b><strong>${escapeHTML(x.category)}</strong><small>${Math.round((x.confidence ?? x.score ?? 0)*100)}%</small></div>`).join("") : `<p class="muted-note">Mapping is not available for this entry.</p>`;
    }

    const sentBox = document.getElementById("sentenceBreakdown");
    const sentList = document.getElementById("sentenceList");
    const sentences = entry.sentences || [];
    if (sentBox && sentList) {
      sentBox.style.display = sentences.length ? "block" : "none";
      sentList.innerHTML = sentences.map((s, i) => `<div class="sentence-row"><span class="sentence-num">${i+1}</span><span class="sentence-text">${escapeHTML(s.text)}</span><span class="sentence-emotion">${EMOTIONS[s.emotion]?.emoji || "•"} ${escapeHTML(s.emotion || "Calm")}${s.goLabel ? ` <small>${escapeHTML(s.goLabel)} · ${Math.round((s.confidence || 0)*100)}%</small>` : ""}</span></div>`).join("");
    }

    const spectrum = Object.entries(entry.scores || {}).sort((a,b)=>b[1]-a[1]);
    const positive = ["Happy","Excited","Confident","Calm"].reduce((s,k)=>s+(entry.scores?.[k]||0),0);
    const negative = ["Sad","Angry","Anxious","Stressed"].reduce((s,k)=>s+(entry.scores?.[k]||0),0);
    const balance = Math.round((positive / Math.max(positive + negative, 1)) * 100);
    const marker = document.getElementById("spectrumMarker");
    if (marker) marker.style.left = `${Math.min(100, Math.max(0, balance))}%`;
    set("spectrumText", `Positive/settled signal ${balance}% · ${spectrum[0]?.[0] || safePrimary} is currently the strongest MuseMind category.`);

    const journey = document.getElementById("emotionJourney");
    if (journey) journey.innerHTML = sentences.length > 1
      ? sentences.map((s,i)=>`<div class="journey-step"><span>${i+1}</span><div><strong>${EMOTIONS[s.emotion]?.emoji || "•"} ${escapeHTML(s.emotion)}</strong><p>${escapeHTML(s.text)}</p></div></div>`).join("")
      : `<div class="journey-step"><span>1</span><div><strong>${EMOTIONS[safePrimary].emoji} ${safePrimary}</strong><p>The entry is short enough that MuseMind treats it as one emotional unit.</p></div></div>`;

    const evidence = document.getElementById("textEvidence");
    if (evidence) {
      const words = ["exam","assignment","presentation","deadline","project","nervous","proud","relieved","excited","frustrated","happy","sad","worried","prepared","selected"];
      const escaped = escapeHTML(entry.text);
      const re = new RegExp(`\\b(${words.join("|")})\\b`, "gi");
      evidence.innerHTML = escaped.replace(re, '<mark>$1</mark>');
    }

    const lang = document.getElementById("languageAnalysis");
    if (lang) lang.innerHTML = `<div><span>Detected language</span><strong>${escapeHTML(entry.language || "English")}</strong></div><div><span>Emoji</span><strong>${entry.emojiDetected ? "Detected" : "None"}</strong></div><div><span>Analysis source</span><strong>${escapeHTML(entry.analysisSource || "Fallback")}</strong></div>`;

    set("analysisMoodScore", Number(entry.moodScore) || 0);
    const contributions = document.getElementById("moodContributions");
    if (contributions) contributions.innerHTML = [safePrimary, safeSecondary].filter((v,i,a)=>a.indexOf(v)===i).map(e=>`<div><span>${EMOTIONS[e].emoji} ${e}</span><strong>${Math.round((entry.scores?.[e]||0)*100)}%</strong></div>`).join("");

    const previous = previousEntries?.[0];
    const deltaBox = document.getElementById("emotionDelta");
    if (deltaBox) deltaBox.innerHTML = previous ? `<strong>${entry.moodScore - previous.moodScore >= 0 ? "+" : ""}${entry.moodScore - previous.moodScore} points</strong><span>Compared with your previous journal entry.</span>` : `Add another journal entry to unlock a comparison.`;

    renderBaseline(entry, previousEntries || []);
    renderUnusual(entry, previousEntries || []);
    renderReflectionPrompts(entry);
    renderEmotionRadar(goScores);
    renderMoodMirror(entry, previous);
    renderThoughtDecoder(entry);
  }

  function renderEmotionRadar(goScores) {
    const canvas = document.getElementById("emotionRadarChart");
    if (!canvas || typeof Chart === "undefined") return;
    const scores = GO_EMOTIONS.map(label => {
      const item = goScores.find(x => String(x.label).toLowerCase() === label);
      return Math.round(((item?.confidence ?? item?.score ?? 0) * 100));
    });
    if (charts.emotionRadar) charts.emotionRadar.destroy();
    charts.emotionRadar = new Chart(canvas, {
      type: "radar",
      data: { labels: GO_EMOTIONS, datasets: [{ label: "Model signal %", data: scores, fill: true }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { r: { beginAtZero: true, max: 100, ticks: { stepSize: 20 } } }, plugins: { legend: { display: false } } }
    });
  }

  function renderBaseline(entry, entries) {
    const box = document.getElementById("personalBaseline");
    if (!box) return;
    const usable = entries.filter(e => e.id !== entry.id).slice(0, 7);
    if (!usable.length) { box.innerHTML = `<p class="muted-note">Your baseline will appear after a few journal entries.</p>`; return; }
    const avg = Math.round(usable.reduce((s,e)=>s+(e.moodScore||0),0)/usable.length);
    box.innerHTML = `<div class="baseline-stat"><strong>${avg}/100</strong><span>average mood across your last ${usable.length} entries</span></div><div class="baseline-mini">Current: <b>${entry.moodScore}/100</b> · Difference: <b>${entry.moodScore-avg >= 0 ? "+" : ""}${entry.moodScore-avg}</b></div>`;
  }

  function renderUnusual(entry, entries) {
    const box = document.getElementById("unusualForYou");
    if (!box) return;
    const usable = entries.filter(e=>e.id!==entry.id).slice(0,10);
    if (usable.length < 3) { box.textContent = "Not enough history yet. Add at least 3 earlier entries for a personal comparison."; return; }
    const counts = {}; usable.forEach(e => counts[e.primaryEmotion]=(counts[e.primaryEmotion]||0)+1);
    const seen = counts[entry.primaryEmotion] || 0;
    box.innerHTML = seen === 0 ? `<strong>${emotionMeta(entry.primaryEmotion).emoji} ${normalizeEmotionName(entry.primaryEmotion)}</strong><p>This primary category has not appeared in your last ${usable.length} entries.</p>` : `<strong>${seen}/${usable.length}</strong><p>Your recent entries show ${entry.primaryEmotion} ${seen} time${seen===1?"":"s"}.</p>`;
  }

  function renderReflectionPrompts(entry) {
    const box = document.getElementById("reflectionPrompts");
    if (!box) return;
    const prompts = entry.triggers?.length ? [`What about ${entry.triggers[0].toLowerCase()} affected you most?`, "What part of this situation was within your control?", "What would you like to remember from this moment?"] : ["What happened just before this feeling appeared?", "What helped or could have helped?", "What do you want to carry forward from this experience?"];
    box.innerHTML = prompts.map(p=>`<span class="reflection-chip">${escapeHTML(p)}</span>`).join("");
  }

  function showMappingLogic() {
    const box = document.getElementById("mappingContent");
    if (!box) return;
    box.innerHTML = Object.entries(GO_TO_MUSE).map(([go,muse])=>`<div class="mapping-row"><span>${go}</span><b>→</b><strong>${muse}</strong></div>`).join("");
  }

  function renderMoodMirror(current, previous) {
    const box = document.getElementById("moodMirror");
    if (!previous) {
      box.innerHTML = `<p class="muted-note">Add another journal entry to compare your emotional state over time.</p>`;
      return;
    }
    const delta = current.moodScore - previous.moodScore;
    const trendUp = TREND_SCORE_MAP[current.primaryEmotion] > TREND_SCORE_MAP[previous.primaryEmotion];
    const trendDown = TREND_SCORE_MAP[current.primaryEmotion] < TREND_SCORE_MAP[previous.primaryEmotion];
    const message = trendUp
      ? "Your current emotional state looks more positive than your previous entry."
      : trendDown
      ? "Your current mood looks lower than your previous entry. Be gentle with yourself."
      : "Your emotional state looks fairly stable compared to your last entry.";

    box.innerHTML = `
      <div class="mirror-row">
        <div class="mood-state"><span>PREVIOUS</span><strong>${emotionMeta(previous.primaryEmotion).emoji} ${normalizeEmotionName(previous.primaryEmotion)}</strong></div>
        <div class="mirror-arrow">→</div>
        <div class="mood-state"><span>CURRENT</span><strong>${emotionMeta(current.primaryEmotion).emoji} ${normalizeEmotionName(current.primaryEmotion)}</strong></div>
      </div>
      <div class="mirror-score-row">
        <span>Mood Score: ${previous.moodScore} → ${current.moodScore}</span>
        <strong class="${delta >= 0 ? "delta-up" : "delta-down"}">${delta >= 0 ? "+" : ""}${delta} pts</strong>
      </div>
      <p class="mirror-message">${message}</p>
    `;
  }

  /* ===================================================================
     7. OVERVIEW
     =================================================================== */

  function computeStreaks(entries) {
    if (!entries.length) return { current: 0, longest: 0 };
    const uniqueDays = [...new Set(entries.map((e) => e.date))].sort().reverse();
    let current = 0;
    let cursor = new Date();
    for (let i = 0; i < uniqueDays.length; i++) {
      const expected = new Date(cursor);
      expected.setDate(cursor.getDate() - i);
      if (uniqueDays.includes(expected.toISOString().slice(0, 10))) current++;
      else break;
    }
    let longest = 1, run = 1;
    const sortedAsc = [...uniqueDays].sort();
    for (let i = 1; i < sortedAsc.length; i++) {
      const prev = new Date(sortedAsc[i - 1]);
      const cur = new Date(sortedAsc[i]);
      const diffDays = Math.round((cur - prev) / 86400000);
      run = diffDays === 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    return { current, longest: Math.max(longest, current) };
  }

  function dominantEmotion(entries) {
    if (!entries.length) return null;
    const counts = {};
    entries.forEach((e) => (counts[e.primaryEmotion] = (counts[e.primaryEmotion] || 0) + 1));
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  function averageMoodScore(entries) {
    if (!entries.length) return null;
    return Math.round(entries.reduce((s, e) => s + e.moodScore, 0) / entries.length);
  }

  function renderOverview() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    const entries = DataLayer.getUserEntries(user.id);
    const streaks = computeStreaks(entries);
    const reflectionDays = new Set(entries.map(e => e.date || localDateKey(new Date(e.timestamp)))).size;
    const dom = dominantEmotion(entries);
    const avg = averageMoodScore(entries);

    document.getElementById("welcomeHeading").textContent = `Welcome back, ${user.name.split(" ")[0]} 👋`;
    document.getElementById("todayDate").textContent = fmtDate(new Date());

    animateCount(document.getElementById("statEntries"), entries.length);
    const voiceNotes = entries.filter(e => e.voiceTranscript || e.inputMode === "voice-transcript").length;
    const docs = DataLayer.getSetting(user.id, "knowledgeDocuments", []);
    document.getElementById("statDominant").textContent = String(voiceNotes);
    document.getElementById("statStreak").textContent = `${reflectionDays} day${reflectionDays === 1 ? "" : "s"}`;
    document.getElementById("statMood").textContent = String(docs.length);

    // recent entries preview (3 latest)
    const preview = document.getElementById("overviewRecent");
    if (!entries.length) {
      preview.innerHTML = emptyState("📖", "Your journal is waiting", "Write your first entry to see it here.");
    } else {
      preview.innerHTML = entries.slice(0, 3).map(entryCardHTML).join("");
    }

    // badges
    renderBadges(entries, streaks);
  }

  function emptyState(icon, title, body) {
    return `<div class="empty-state"><div class="empty-icon">${icon}</div><h3>${title}</h3><p>${body}</p></div>`;
  }

  const BADGE_DEFS = [
    { id: "first", icon: "🌱", label: "First Entry", test: (e, s) => e.length >= 1 },
    { id: "streak3", icon: "🔥", label: "3-Day Streak", test: (e, s) => s.longest >= 3 },
    { id: "streak7", icon: "💎", label: "7-Day Streak", test: (e, s) => s.longest >= 7 },
    { id: "streak30", icon: "🏆", label: "30-Day Streak", test: (e, s) => s.longest >= 30 },
    { id: "explorer", icon: "🧠", label: "Emotion Explorer", test: (e) => new Set(e.map((x) => x.primaryEmotion)).size >= 5 },
    { id: "fifty", icon: "📖", label: "50 Entries", test: (e) => e.length >= 50 },
  ];

  function renderBadges(entries, streaks) {
    const box = document.getElementById("badgeGrid");
    box.innerHTML = BADGE_DEFS.map((b) => {
      const earned = b.test(entries, streaks);
      return `<div class="badge ${earned ? "earned" : "locked"}" title="${b.label}">
        <span class="badge-icon">${b.icon}</span>
        <span class="badge-label">${b.label}</span>
      </div>`;
    }).join("");
  }

  function entryCardHTML(entry) {
    const d = new Date(entry.timestamp);
    const primary = normalizeEmotionName(entry.primaryEmotion);
    const secondary = normalizeEmotionName(entry.secondaryEmotion);
    const triggers = Array.isArray(entry.triggers) ? entry.triggers : [];
    return `<div class="entry-card" data-id="${entry.id}">
      <div class="entry-card-top">
        <span class="entry-emotion">${EMOTIONS[primary].emoji} ${primary} ${Number(entry.primaryPercentage) || 0}%</span>
        <span class="entry-date">${fmtDate(d)} • ${escapeHTML(entry.time || "Time not recorded")}</span>
      </div>
      
      <p class="entry-text">${escapeHTML(entry.text.length > 220 ? entry.text.slice(0, 220) + "…" : entry.text)}</p>
      ${entry.voiceTranscript ? '<span class="sample-entry-tag voice-entry-tag">VOICE TRANSCRIPT</span>' : ''}
      <div class="entry-card-bottom">
        <span class="entry-secondary">Secondary: ${EMOTIONS[secondary].emoji} ${secondary}</span>
        ${triggers.length ? `<span class="entry-triggers">Context: ${triggers.map(escapeHTML).join(", ")}</span>` : ""}
        <span class="entry-score">Mood ${Number(entry.moodScore) || 0}/100</span>
      </div>
      <div class="entry-card-actions">
        <button class="mini-btn" onclick="MuseMind.viewEntry('${entry.id}')">View</button>
        <button class="mini-btn" onclick="MuseMind.analyzeHistoryEntry('${entry.id}')">Analyze</button>
        <button class="mini-btn danger" onclick="MuseMind.confirmDelete('${entry.id}')">Delete</button>
      </div>
    </div>`;
  }

  /* ===================================================================
     8. EMOTION HISTORY (Journal Archive)
     =================================================================== */

  function renderHistory() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    let entries = DataLayer.getUserEntries(user.id);

    if (historyFilters.query.trim()) {
      const q = historyFilters.query.trim().toLowerCase();
      entries = entries.filter((e) => e.text.toLowerCase().includes(q));
    }
    if (historyFilters.emotion !== "all") {
      entries = entries.filter((e) => e.primaryEmotion === historyFilters.emotion);
    }
    entries = entries.slice();
    entries.sort((a, b) =>
      historyFilters.sort === "oldest"
        ? new Date(a.timestamp) - new Date(b.timestamp)
        : new Date(b.timestamp) - new Date(a.timestamp)
    );

    document.getElementById("historyCount").textContent = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;

    const box = document.getElementById("historyBox");
    box.innerHTML = entries.length
      ? entries.map(entryCardHTML).join("")
      : emptyState("🔍", "No entries match", "Try a different search term or filter.");
  }

  function setHistoryQuery(v) { historyFilters.query = v; renderHistory(); }
  function setHistoryEmotion(v) { historyFilters.emotion = v; renderHistory(); }
  function setHistorySort(v) { historyFilters.sort = v; renderHistory(); }

  function viewEntry(id) {
    const entry = DataLayer.getAllEntries().find((e) => e.id === id);
    if (!entry) return;
    const modal = document.getElementById("entryModal");
    document.getElementById("entryModalBody").innerHTML = `
      <div class="modal-meta">${fmtDate(new Date(entry.timestamp))} • ${entry.time}</div>
      <p class="modal-text">${escapeHTML(entry.text)}</p>
      ${entry.voiceTranscript ? `<div class="saved-transcript"><small>VOICE TRANSCRIPT · ${escapeHTML(entry.voiceLanguage || "Speech recognition")}</small><p>${escapeHTML(entry.voiceTranscript)}</p></div>` : ''}
      <div class="modal-tags">
        <span class="chip">${emotionMeta(entry.primaryEmotion).emoji} ${normalizeEmotionName(entry.primaryEmotion)} ${entry.primaryPercentage}%</span>
        <span class="chip">${emotionMeta(entry.secondaryEmotion).emoji} ${normalizeEmotionName(entry.secondaryEmotion)} ${entry.secondaryPercentage}%</span>
        ${(Array.isArray(entry.triggers) ? entry.triggers : []).map((t) => `<span class="chip chip-muted">🔎 ${escapeHTML(t)}</span>`).join("")}
      </div>
      <p class="modal-reflection">${escapeHTML(entry.reflection || "")}</p>
      <div class="modal-actions"><button class="command-btn primary" onclick="MuseMind.analyzeHistoryEntry('${entry.id}'); MuseMind.closeEntryModal();">Re-analyze this entry</button></div>
    `;
    modal.classList.add("open");
  }
  function closeEntryModal() {
    document.getElementById("entryModal").classList.remove("open");
  }

  function confirmDelete(id) {
    pendingDeleteId = id;
    document.getElementById("deleteModal").classList.add("open");
  }
  function cancelDelete() {
    pendingDeleteId = null;
    document.getElementById("deleteModal").classList.remove("open");
  }
  function performDelete() {
    if (pendingDeleteId) {
      DataLayer.deleteEntry(pendingDeleteId);
      toast("Entry deleted.", "success");
      pendingDeleteId = null;
      renderAll();
    }
    document.getElementById("deleteModal").classList.remove("open");
  }

  /* ===================================================================
     9. MOOD TIMELINE (Chart.js line chart)
     =================================================================== */

  let timelineRange = "7";
  function setTimelineRange(range) {
    timelineRange = range;
    document.querySelectorAll(".range-btn").forEach((b) => b.classList.toggle("active", b.dataset.range === range));
    renderTimelineChart();
  }

  function renderTimelineChart() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    let entries = DataLayer.getUserEntries(user.id).slice().reverse(); // oldest -> newest

    if (timelineRange !== "all") {
      const days = parseInt(timelineRange, 10);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      entries = entries.filter((e) => new Date(e.timestamp) >= cutoff);
    }

    let canvas = document.getElementById("timelineChart");
    const chartWrap = document.querySelector("#view-timeline .chart-wrap");
    if (!canvas && chartWrap) { chartWrap.innerHTML = '<canvas id="timelineChart"></canvas>'; canvas = document.getElementById("timelineChart"); }
    const list = document.getElementById("timelineList");

    if (!entries.length) {
      if (charts.timeline) { charts.timeline.destroy(); charts.timeline = null; }
      if (chartWrap) chartWrap.innerHTML = '<div class="empty-state"><div class="empty-icon">🌱</div><h3>No entries yet in this range</h3><p>Journal a little more to see your timeline.</p></div>';
      list.innerHTML = "";
      return;
    }

    list.innerHTML = entries
      .slice(-8)
      .reverse()
      .map((e) => `<div class="timeline-row">
        <span class="timeline-date">${new Date(e.timestamp).toLocaleDateString("en-IN", { month: "short", day: "numeric" })}</span>
        <span class="timeline-emotion">${emotionMeta(e.primaryEmotion).emoji} ${normalizeEmotionName(e.primaryEmotion)}</span>
        <span class="timeline-score">${e.moodScore}/100</span>
      </div>`)
      .join("");

    const labels = entries.map((e) => new Date(e.timestamp).toLocaleDateString("en-IN", { month: "short", day: "numeric" }));
    const scores = entries.map((e) => e.moodScore);

    if (charts.timeline) { charts.timeline.destroy(); charts.timeline = null; }
    if (typeof Chart !== "function") {
      const wrap = canvas.closest(".chart-wrap");
      const w = 900, h = 260, pad = 34;
      const pts = scores.map((v, i) => {
        const x = pad + (scores.length < 2 ? (w - 2 * pad) / 2 : i * (w - 2 * pad) / (scores.length - 1));
        const y = h - pad - (Math.max(0, Math.min(100, Number(v) || 0)) / 100) * (h - 2 * pad);
        return [x, y];
      });
      const line = pts.map(p => p.join(",")).join(" ");
      const area = `${pad},${h-pad} ${line} ${pts[pts.length-1][0]},${h-pad}`;
      wrap.innerHTML = `<svg class="timeline-fallback" viewBox="0 0 ${w} ${h}" role="img" aria-label="Mood score timeline"><defs><linearGradient id="moodFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#f0a06a" stop-opacity=".28"/><stop offset="1" stop-color="#f0a06a" stop-opacity="0"/></linearGradient></defs>${[0,25,50,75,100].map(v=>{const y=h-pad-(v/100)*(h-2*pad);return `<line x1="${pad}" x2="${w-pad}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,.10)"/><text x="4" y="${y+4}" fill="#8b93a7" font-size="12">${v}</text>`}).join("")}<polygon points="${area}" fill="url(#moodFill)"/><polyline points="${line}" fill="none" stroke="#f0a06a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${pts.map(([x,y],i)=>`<circle cx="${x}" cy="${y}" r="5" fill="#f0a06a"><title>${labels[i]}: ${scores[i]}/100</title></circle>`).join("")}</svg>`;
      return;
    }
    const wrap = canvas.closest(".chart-wrap");
    if (wrap && !wrap.contains(canvas)) wrap.innerHTML = '<canvas id="timelineChart"></canvas>';
    const chartCanvas = document.getElementById("timelineChart");
    charts.timeline = new Chart(chartCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Mood Score",
          data: scores,
          borderColor: "#f0a06a",
          backgroundColor: "rgba(240,160,106,0.12)",
          tension: 0.35,
          fill: true,
          pointBackgroundColor: "#f0a06a",
          pointRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { min: 0, max: 100, grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#8b93a7" } },
          x: { grid: { display: false }, ticks: { color: "#8b93a7" } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  /* ===================================================================
     10. EMOTION DISTRIBUTION CHART (Overview / Insights)
     =================================================================== */

  function renderDistributionChart(entries) {
    const canvas = document.getElementById("distributionChart");
    if (!canvas) return;
    const counts = {};
    Object.keys(EMOTIONS).forEach((e) => (counts[e] = 0));
    entries.forEach((e) => counts[normalizeEmotionName(e.primaryEmotion)]++);

    if (charts.distribution) { charts.distribution.destroy(); charts.distribution = null; }
    if (typeof Chart !== "function") {
      canvas.style.display = "none";
    } else {
      canvas.style.display = "block";
      charts.distribution = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: Object.keys(EMOTIONS),
        datasets: [{
          data: Object.values(counts),
          backgroundColor: ["#f0a06a", "#fb7185", "#fbbf24", "#5eead4", "#a78bfa", "#f87171", "#60a5fa", "#4ade80"],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "68%",
        plugins: { legend: { display: false } },
      },
      });
    }

    const list = document.getElementById("distributionList");
    if (list) {
      const total = entries.length || 1;
      list.innerHTML = Object.keys(EMOTIONS)
        .map((e) => {
          const pct = Math.round((counts[e] / total) * 100);
          return `<div class="emotion-row"><div class="emotion-row-label"><span>${EMOTIONS[e].emoji}</span><strong>${e}</strong></div><div class="insight-bar-track"><i class="insight-bar-fill" style="width:${pct}%"></i></div><small>${pct}%</small></div>`;
        })
        .join("");
    }
  }

  /* ===================================================================
     11. INSIGHTS — Emotion DNA + Trigger Analysis
     =================================================================== */


  function renderStandardEmotionAnalytics() {
    const user = DataLayer.getCurrentUser();
    const entries = user ? DataLayer.getUserEntries(user.id) : [];
    const counts = {};
    GO_EMOTIONS.forEach(e => counts[e] = 0);
    entries.forEach(entry => (entry.goEmotions || []).forEach(x => {
      if (counts[x.label] !== undefined) counts[x.label] += 1;
    }));
    const sorted = Object.entries(counts).filter(([,v]) => v > 0).sort((a,b)=>b[1]-a[1]).slice(0,8);
    const text = document.getElementById("insightsText");
    if (text) {
      // Replace the previous summary on every render instead of stacking duplicates.
      text.querySelectorAll(".standard-insight-strip").forEach(node => node.remove());
      if (sorted.length) {
        const total = entries.filter(e => (e.goEmotions || []).length).length || 1;
        const standardLine = `<div class="standard-insight-strip"><b>Standard NLP:</b> ${sorted.map(([k,v]) => `${escapeHTML(k)} (${Math.round(v/total*100)}%)`).join(" · ")}</div>`;
        text.insertAdjacentHTML("afterbegin", standardLine);
      }
    }
  }

  function renderTimeOfDayInsights() {
    const box = document.getElementById("timeOfDayInsights");
    const user = DataLayer.getCurrentUser();
    if (!box || !user) return;
    const entries = DataLayer.getUserEntries(user.id);
    const periods = ["Morning", "Afternoon", "Evening", "Night"];
    const counts = periods.map(period => entries.filter(e => (e.timePeriod || getTimePeriod(new Date(e.timestamp))) === period).length);
    const total = counts.reduce((a,b)=>a+b,0);
    if (!total) { box.innerHTML = '<p class="muted-note">New entries will help reveal your preferred reflection time.</p>'; return; }
    const max = Math.max(...counts, 1);
    const best = periods[counts.indexOf(max)];
    box.innerHTML = `<div class="time-pattern-summary"><strong>${best}</strong><span>Your most common check-in time · ${max} of ${total} entries</span></div><div class="time-period-bars">${periods.map((period,i)=>`<div class="time-period-row"><span>${({Morning:"☀️",Afternoon:"🌤",Evening:"🌆",Night:"🌙"})[period]} ${period}</span><div class="time-period-track"><i style="width:${Math.round(counts[i]/max*100)}%"></i></div><b>${counts[i]}</b></div>`).join("")}</div><p class="tiny-note">This describes your saved entries only. It is not a recommendation about when you should journal.</p>`;
  }

  function renderInsights() {
    renderTimeOfDayInsights();
    renderStandardEmotionAnalytics();
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    const entries = DataLayer.getUserEntries(user.id);
    const box = document.getElementById("insightsContent");

    if (entries.length < 2) {
      box.innerHTML = emptyState("🧬", "Not enough data yet", "Write a few more entries and MuseMind will map out your Emotion DNA and trigger patterns.");
      return;
    }

    renderDistributionChart(entries);

    // Emotion DNA
    const counts = {};
    Object.keys(EMOTIONS).forEach((e) => (counts[e] = 0));
    entries.forEach((e) => counts[normalizeEmotionName(e.primaryEmotion)]++);
    const total = entries.length;
    const dnaSorted = Object.entries(counts).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);

    const dnaHTML = dnaSorted
      .map(([emotion, c]) => {
        const pct = Math.round((c / total) * 100);
        return `<div class="dna-row">
          <span class="dna-label">${EMOTIONS[emotion].emoji} ${emotion}</span>
          <div class="dna-bar"><div class="dna-fill" style="width:${pct}%"></div></div>
          <span class="dna-pct">${pct}%</span>
        </div>`;
      })
      .join("");

    // positive / negative / mixed split
    let positive = 0, negative = 0, mixedCount = 0;
    entries.forEach((e) => {
      if (e.mixed) mixedCount++;
      else if (EMOTIONS[normalizeEmotionName(e.primaryEmotion)].tone === "positive") positive++;
      else negative++;
    });
    const posPct = Math.round((positive / total) * 100);
    const negPct = Math.round((negative / total) * 100);
    const mixPct = 100 - posPct - negPct;

    // narrative insights, generated only from real stored data
    const insights = [];
    if (posPct > negPct + 15) {
      insights.push(`Your journal leans positive overall — ${posPct}% of entries carry an upbeat primary emotion.`);
    } else if (negPct > posPct + 15) {
      insights.push(`Stressful or low-energy emotions show up more often than positive ones right now (${negPct}% vs ${posPct}%).`);
    } else {
      insights.push(`Your journal shows a fairly even balance between positive and stressful emotions.`);
    }

    const triggerCounts = {};
    entries.forEach((e) => (Array.isArray(e.triggers) ? e.triggers : []).forEach((t) => (triggerCounts[t] = (triggerCounts[t] || 0) + 1)));
    const topTrigger = Object.entries(triggerCounts).sort((a, b) => b[1] - a[1])[0];
    if (topTrigger) {
      const [triggerName] = topTrigger;
      const withTrigger = entries.filter((e) => e.triggers.includes(triggerName));
      const stressedShare = Math.round(
        (withTrigger.filter((e) => e.primaryEmotion === "Stressed" || e.primaryEmotion === "Anxious").length / withTrigger.length) * 100
      );
      if (stressedShare >= 40) {
        insights.push(`${triggerName} is mentioned alongside stress or anxiety in ${stressedShare}% of the ${withTrigger.length} related entries. This is an observed association, not proof of a cause.`);
      } else {
        insights.push(`${triggerName} is your most frequently mentioned context, appearing in ${withTrigger.length} entries. This describes what you wrote, not what caused an emotion.`);
      }
    }

    const recent = entries.slice(0, 5);
    if (recent.length >= 3) {
      const shiftsToPositive = recent.slice(0, -1).filter((e, i) => {
        const next = recent[i + 1];
        return EMOTIONS[normalizeEmotionName(next.primaryEmotion)].tone !== "positive" && EMOTIONS[normalizeEmotionName(e.primaryEmotion)].tone === "positive";
      }).length;
      if (shiftsToPositive >= 1) {
        insights.push(`Your recent entries often shift toward a more positive state after a difficult one — a good sign of resilience.`);
      }
    }

    document.getElementById("emotionDNA").innerHTML = dnaHTML;
    document.getElementById("toneSplit").innerHTML = `
      <div class="tone-bar">
        <div class="tone-seg tone-pos" style="width:${posPct}%"></div>
        <div class="tone-seg tone-mix" style="width:${mixPct}%"></div>
        <div class="tone-seg tone-neg" style="width:${negPct}%"></div>
      </div>
      <div class="tone-legend">
        <span><i class="dot pos"></i>Positive ${posPct}%</span>
        <span><i class="dot mix"></i>Mixed ${mixPct}%</span>
        <span><i class="dot neg"></i>Stressful ${negPct}%</span>
      </div>`;
    document.getElementById("insightsText").innerHTML = insights.map((t) => `<p>💡 ${t}</p>`).join("");

    // trigger -> emotion relationship table
    const triggerBox = document.getElementById("triggerAnalysis");
    const triggerNames = Object.keys(triggerCounts).sort((a, b) => triggerCounts[b] - triggerCounts[a]);
    if (!triggerNames.length) {
      triggerBox.innerHTML = `<p class="muted-note">No consistent triggers detected yet.</p>`;
    } else {
      triggerBox.innerHTML = triggerNames
        .slice(0, 5)
        .map((t) => {
          const withTrigger = entries.filter((e) => e.triggers.includes(t));
          const emoCounts = {};
          withTrigger.forEach((e) => (emoCounts[e.primaryEmotion] = (emoCounts[e.primaryEmotion] || 0) + 1));
          const breakdown = Object.entries(emoCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([emo, c]) => `${EMOTIONS[emo].emoji} ${emo} ${Math.round((c / withTrigger.length) * 100)}%`)
            .join(" · ");
          return `<div class="trigger-row"><strong>${t}</strong><span>${breakdown}</span></div>`;
        })
        .join("");
    }
  }


  /* Academic calendar and uploaded-file persistence */
  const ACADEMIC_CALENDAR_EVENTS = [{"date": "2026-07-09", "title": "Start of Make-up Examination", "category": "Academic"}, {"date": "2026-07-15", "title": "Last date for PhD SDC progress report submission", "category": "Academic"}, {"date": "2026-07-16", "title": "Last date for fee payment", "category": "Academic"}, {"date": "2026-07-18", "title": "Orientation Program for 1st Year", "category": "Academic"}, {"date": "2026-07-20", "title": "Commencement of Induction Program for 1st Year", "category": "Academic"}, {"date": "2026-07-23", "title": "Commencement of classes for Higher Semester", "category": "Academic"}, {"date": "2026-07-24", "title": "End of Make-up Examination", "category": "Academic"}, {"date": "2026-07-27", "title": "Commencement of classes for 1st Semester", "category": "Academic"}, {"date": "2026-07-28", "title": "Last date for Re-Registration", "category": "Deadline"}, {"date": "2026-08-15", "title": "Independence Day", "category": "Holiday"}, {"date": "2026-08-18", "title": "1st Class Committee Meeting", "category": "Academic"}, {"date": "2026-08-23", "title": "MUJ MUN", "category": "Event"}, {"date": "2026-08-28", "title": "Raksha Bandhan", "category": "Holiday"}, {"date": "2026-08-29", "title": "National Sports Day", "category": "Event"}, {"date": "2026-08-31", "title": "Club Unveiling and Membership Drive", "category": "Event"}, {"date": "2026-09-02", "title": "Club Unveiling and Membership Drive", "category": "Event"}, {"date": "2026-09-04", "title": "Janmashtami", "category": "Holiday"}, {"date": "2026-09-06", "title": "Club Unveiling and Membership Drive", "category": "Event"}, {"date": "2026-09-10", "title": "Friday Timetable", "category": "Academic"}, {"date": "2026-09-15", "title": "Engineers' Day", "category": "Event"}, {"date": "2026-09-16", "title": "Start of Academic Audit", "category": "Academic"}, {"date": "2026-09-17", "title": "Scholarship and Appreciation Day", "category": "Event"}, {"date": "2026-09-18", "title": "Start of MTE", "category": "Exam"}, {"date": "2026-09-25", "title": "End of MTE", "category": "Exam"}, {"date": "2026-09-27", "title": "Abhivarta", "category": "Event"}, {"date": "2026-09-30", "title": "Showing of MTE answer scripts / End of Academic Audit", "category": "Academic"}, {"date": "2026-10-02", "title": "Gandhi Jayanti", "category": "Holiday"}, {"date": "2026-10-05", "title": "End of Daan Utsav", "category": "Event"}, {"date": "2026-10-06", "title": "Re-sessional Examination", "category": "Exam"}, {"date": "2026-10-08", "title": "Blood Donation Camp", "category": "Event"}, {"date": "2026-10-10", "title": "TechIdeate and Qureka", "category": "Event"}, {"date": "2026-10-14", "title": "Friday Timetable", "category": "Academic"}, {"date": "2026-10-20", "title": "Dussehra", "category": "Holiday"}, {"date": "2026-10-29", "title": "2nd Class Committee Meeting", "category": "Academic"}, {"date": "2026-11-08", "title": "Diwali", "category": "Holiday"}, {"date": "2026-11-09", "title": "Govardhan Puja", "category": "Holiday"}, {"date": "2026-11-11", "title": "Bhai Dooj", "category": "Holiday"}, {"date": "2026-11-13", "title": "Last Instruction Day", "category": "Academic"}, {"date": "2026-11-18", "title": "Commencement of ETE", "category": "Exam"}, {"date": "2026-12-02", "title": "End of ETE", "category": "Exam"}, {"date": "2026-12-03", "title": "Start of Winter Break for students", "category": "Academic"}, {"date": "2026-12-04", "title": "PhD Entrance Test", "category": "Exam"}, {"date": "2026-12-07", "title": "Last date to show ETE answer scripts", "category": "Deadline"}, {"date": "2026-12-09", "title": "Result Declaration", "category": "Academic"}, {"date": "2026-12-15", "title": "Start of Odd Semester Make-up Examination", "category": "Exam"}, {"date": "2026-12-24", "title": "End of Odd Semester Make-up Examination", "category": "Exam"}, {"date": "2026-12-25", "title": "Christmas", "category": "Holiday"}, {"date": "2027-01-03", "title": "End of Winter Break for students", "category": "Academic"}, {"date": "2027-01-04", "title": "Commencement of Even Semester", "category": "Academic"}, {"date": "2027-01-06", "title": "Last date for Re-Registration", "category": "Deadline"}, {"date": "2027-01-14", "title": "Makar Sankranti", "category": "Holiday"}, {"date": "2027-01-21", "title": "Leadership Summit", "category": "Event"}, {"date": "2027-01-22", "title": "Leadership Summit", "category": "Event"}, {"date": "2027-01-23", "title": "TEDx", "category": "Event"}, {"date": "2027-01-26", "title": "Republic Day", "category": "Holiday"}, {"date": "2027-01-29", "title": "Blood Donation Camp", "category": "Event"}, {"date": "2027-02-11", "title": "1st Class Committee Meeting", "category": "Academic"}, {"date": "2027-02-12", "title": "1st Class Committee Meeting", "category": "Academic"}, {"date": "2027-02-20", "title": "Oneiros", "category": "Event"}, {"date": "2027-02-26", "title": "Commencement of MTE", "category": "Exam"}, {"date": "2027-03-05", "title": "End of MTE", "category": "Exam"}, {"date": "2027-03-09", "title": "Showing of MTE answer scripts", "category": "Academic"}, {"date": "2027-03-11", "title": "Re-sessional Examination", "category": "Exam"}, {"date": "2027-03-22", "title": "Holi", "category": "Holiday"}, {"date": "2027-04-06", "title": "2nd Class Committee Meeting", "category": "Academic"}, {"date": "2027-04-07", "title": "2nd Class Committee Meeting", "category": "Academic"}, {"date": "2027-04-20", "title": "Last Instruction Day", "category": "Academic"}, {"date": "2027-04-23", "title": "Commencement of ETE", "category": "Exam"}, {"date": "2027-04-30", "title": "Founders' Day", "category": "Event"}, {"date": "2027-05-05", "title": "End of ETE", "category": "Exam"}, {"date": "2027-05-06", "title": "Start of Summer Break for Students", "category": "Academic"}, {"date": "2027-05-10", "title": "Last date to show ETE answer scripts", "category": "Deadline"}, {"date": "2027-05-14", "title": "Result Declaration", "category": "Academic"}, {"date": "2027-05-25", "title": "Commencement of Even Semester Make-up Examination", "category": "Exam"}, {"date": "2027-06-04", "title": "Establishment Day", "category": "Event"}, {"date": "2027-06-05", "title": "End of Even Semester Make-up Examination", "category": "Exam"}, {"date": "2027-06-11", "title": "PhD Entrance Exam", "category": "Exam"}, {"date": "2027-06-21", "title": "International Yoga Day", "category": "Event"}, {"date": "2027-06-25", "title": "Last date of SDC progress report submission", "category": "Deadline"}];
  let pendingDocumentTarget = "planner";
  let selectedCalendarDate = null;

  function ensureAcademicCalendarSeed() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    const docs = DataLayer.getSetting(user.id, "knowledgeDocuments", []) || [];
    if (!docs.some(d => d.id === "muj_academic_calendar_2026_27")) {
      docs.unshift({id:"muj_academic_calendar_2026_27",name:"MUJ Academic Calendar 2026–2027.pdf",type:"PDF",category:"Academic Calendar",pages:1,summary:"Official university academic calendar covering July 2026 to July 2027.",tags:["MUJ","Academic calendar","2026–2027"],addedAt:"2026-11-15T00:00:00.000Z",filePath:"assets/MUJ_Academic_Calendar_2026-2027.pdf",source:"Manipal University Jaipur"});
      DataLayer.setSetting(user.id,"knowledgeDocuments",docs);
    }
    const existing = DataLayer.getSetting(user.id,"documentPlannerItems",[]) || [];
    if (!DataLayer.getSetting(user.id,"academicCalendarSeedV1",false)) {
      const seeded = ACADEMIC_CALENDAR_EVENTS.map((e,i)=>({id:"mujcal_"+i,date:e.date,title:e.title,category:e.category,source:"MUJ Academic Calendar 2026–2027.pdf",context:"Imported from the university academic calendar. Review the original PDF in My Library.",done:false,calendarSeed:true}));
      DataLayer.setSetting(user.id,"documentPlannerItems",[...existing,...seeded]);
      DataLayer.setSetting(user.id,"academicCalendarSeedV1",true);
    }
  }

  function openMuseMindFileDB() {
    return new Promise((resolve,reject)=>{
      if (!("indexedDB" in window)) return reject(new Error("This browser does not support local file storage."));
      const request = indexedDB.open("MuseMindLibraryFiles",1);
      request.onupgradeneeded = () => {
        const db=request.result;
        if(!db.objectStoreNames.contains("files")) db.createObjectStore("files",{keyPath:"id"});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error || new Error("Could not open local file storage."));
    });
  }
  async function storeLibraryBlob(file,id) {
    const db=await openMuseMindFileDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction("files","readwrite");
      tx.objectStore("files").put({id,name:file.name,type:file.type||"application/octet-stream",blob:file,updatedAt:new Date().toISOString()});
      tx.oncomplete=()=>{db.close();resolve(true);};
      tx.onerror=()=>{db.close();reject(tx.error || new Error("Could not save this file."));};
    });
  }
  async function openLibraryFile(id) {
    const user=DataLayer.getCurrentUser();
    const docs=user?(DataLayer.getSetting(user.id,"knowledgeDocuments",[])||[]):[];
    const doc=docs.find(d=>d.id===id);
    if(doc?.filePath){window.open(doc.filePath,"_blank","noopener");return;}
    const tab=window.open("about:blank","_blank");
    try {
      const db=await openMuseMindFileDB();
      const record=await new Promise((resolve,reject)=>{
        const tx=db.transaction("files","readonly");
        const req=tx.objectStore("files").get(id);
        req.onsuccess=()=>resolve(req.result);
        req.onerror=()=>reject(req.error);
      });
      db.close();
      if(!record?.blob) throw new Error("The saved file could not be found in this browser.");
      const url=URL.createObjectURL(record.blob);
      if(tab) tab.location.href=url; else { window.location.href=url; }
      setTimeout(()=>URL.revokeObjectURL(url),60000);
    } catch(err) { if(tab) tab.close(); toast(err.message || "Could not open this file.","warn"); }
  }

  function editLibraryDocument(id) {
    const user=DataLayer.getCurrentUser();
    if(!user) return;
    const docs=DataLayer.getSetting(user.id,"knowledgeDocuments",[])||[];
    const doc=docs.find(d=>d.id===id);
    if(!doc){toast("File not found in My Library.","warn");return;}
    const name=window.prompt("Edit file name:",doc.name||"");
    if(name===null) return;
    const cleanName=name.trim();
    if(!cleanName){toast("File name cannot be empty.","warn");return;}
    const category=window.prompt("Edit category:",doc.category||"Uploaded document");
    if(category===null) return;
    const summary=window.prompt("Edit description / notes:",doc.summary||"");
    if(summary===null) return;
    doc.name=cleanName;
    doc.category=category.trim()||"Uncategorised";
    doc.summary=summary.trim();
    docs[docs.indexOf(docs.find(d=>d.id===id))]=doc;
    DataLayer.setSetting(user.id,"knowledgeDocuments",docs);
    if(doc.fileId) updateLibraryBlobName(doc.fileId,cleanName).catch(err=>console.warn("Could not update stored file name",err));
    renderKnowledgeVault();
    toast("File details updated.","success");
  }

  async function updateLibraryBlobName(fileId,name) {
    const db=await openMuseMindFileDB();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction("files","readwrite");
      const store=tx.objectStore("files");
      const req=store.get(fileId);
      req.onsuccess=()=>{if(req.result){req.result.name=name;req.result.updatedAt=new Date().toISOString();store.put(req.result);}};
      tx.oncomplete=()=>{db.close();resolve(true);};
      tx.onerror=()=>{db.close();reject(tx.error||new Error("Could not update stored file metadata."));};
    });
  }

  async function deleteLibraryDocument(id) {
    const user=DataLayer.getCurrentUser();
    if(!user) return;
    const docs=DataLayer.getSetting(user.id,"knowledgeDocuments",[])||[];
    const doc=docs.find(d=>d.id===id);
    if(!doc){toast("File not found in My Library.","warn");return;}
    if(!window.confirm(`Delete "${doc.name}" from My Library? This removes the saved original file from this browser. Calendar events created from it will remain, but their source link will be cleared.`)) return;
    try {
      if(doc.fileId) {
        const db=await openMuseMindFileDB();
        await new Promise((resolve,reject)=>{
          const tx=db.transaction("files","readwrite");
          tx.objectStore("files").delete(doc.fileId);
          tx.oncomplete=resolve;
          tx.onerror=()=>reject(tx.error||new Error("Could not delete the saved file."));
        });
        db.close();
      }
      const remaining=docs.filter(d=>d.id!==id);
      DataLayer.setSetting(user.id,"knowledgeDocuments",remaining);
      const events=DataLayer.getSetting(user.id,"documentPlannerItems",[])||[];
      let detached=false;
      events.forEach(e=>{if(e.sourceDocumentId===id||e.sourceDocumentId===doc.fileId){delete e.sourceDocumentId;detached=true;}});
      if(detached) DataLayer.setSetting(user.id,"documentPlannerItems",events);
      renderKnowledgeVault();
      toast("File deleted from My Library.","success");
    } catch(err) {
      console.error(err);
      toast(err.message||"Could not delete this file.","warn");
    }
  }

  async function saveUploadedDocumentRecord(file, extractedText) {
    const user=DataLayer.getCurrentUser();
    if(!user) return;
    const docs=DataLayer.getSetting(user.id,"knowledgeDocuments",[])||[];
    let existing=docs.find(d=>d.name===file.name && d.size===file.size && !d.filePath);
    const id=existing?.fileId || uid("file");
    await storeLibraryBlob(file,id);
    const record={id:existing?.id || id,name:file.name,type:String(file.type||"").startsWith("image/")?"Image":"PDF",category:"Uploaded document",pages:1,size:file.size,summary:String(extractedText||"").replace(/\s+/g," ").slice(0,220)||"File saved. Text extraction may require review.",content:String(extractedText||"").slice(0,6000),text:String(extractedText||"").slice(0,6000),tags:["Uploaded","Document"],addedAt:existing?.addedAt || new Date().toISOString(),fileId:id};
    if(existing) docs[docs.indexOf(existing)]=record; else docs.unshift(record);
    DataLayer.setSetting(user.id,"knowledgeDocuments",docs);
    return record;
  }
  let pendingDocumentSourceId = null;
  async function uploadLibraryDocument(file) {
    if(!file) return;
    pendingDocumentTarget="library";
    const status=document.getElementById("libraryUploadStatus");
    if(status) status.textContent=`Saving ${file.name} to My Library…`;
    try { await saveUploadedDocumentRecord(file,""); }
    catch(err) { if(status) status.textContent=err.message || "Could not save the original file."; return; }
    await extractDocumentDates(file);
    renderKnowledgeVault();
  }
  function goToToday() {
    calendarCursor=new Date();
    selectedCalendarDate=localDateKey(new Date());
    renderCalendar();
    showCalendarDay(selectedCalendarDate);
  }

  /* ===================================================================
     12. MOOD CALENDAR
     =================================================================== */

  function shiftCalendar(delta) {
    calendarCursor.setDate(1);
    calendarCursor.setMonth(calendarCursor.getMonth() + delta);
    renderCalendar();
  }

  function renderCalendar() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    ensureAcademicCalendarSeed();
    const entries = DataLayer.getUserEntries(user.id);
    const items = getPlannerItems();
    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    document.getElementById("calendarLabel").textContent = calendarCursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

    const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;
    const monthItems = items.filter(item => String(item.date || "").startsWith(monthPrefix));
    const todayKey = localDateKey(new Date());
    if (!selectedCalendarDate && monthPrefix === todayKey.slice(0,7)) selectedCalendarDate = todayKey;
    const nextWeek = new Date(); nextWeek.setDate(nextWeek.getDate()+7);
    const upcoming = items.filter(item => !item.done && item.date >= todayKey && item.date <= localDateKey(nextWeek)).length;
    const summary = document.getElementById("calendarSummary");
    if (summary) summary.innerHTML = `
      <div class="calendar-summary-card"><strong>${monthItems.length}</strong><span>Events this month</span></div>
      <div class="calendar-summary-card"><strong>${upcoming}</strong><span>Upcoming in 7 days</span></div>
      <div class="calendar-summary-card"><strong>${entries.filter(e=>String(e.date||"").startsWith(monthPrefix)).length}</strong><span>Journal entries</span></div>`;

    const byDay = {};
    entries.forEach(e => { const key=e.date || localDateKey(new Date(e.timestamp)); (byDay[key] ||= {entries:[],items:[]}).entries.push(e); });
    items.forEach(item => { if(!item.date) return; (byDay[item.date] ||= {entries:[],items:[]}).items.push(item); });

    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let cells = "";
    for (let i = 0; i < startOffset; i++) cells += `<div class="cal-cell empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const data = byDay[dateStr] || {entries:[],items:[]};
      const dayItems = data.items || [];
      const dayEntries = data.entries || [];
      const isToday = dateStr === todayKey;
      const isSelected = dateStr === selectedCalendarDate;
      const types = [...new Set(dayItems.map(x => (x.category||"Academic").toLowerCase()))];
      const marks = types.map(t => `<i class="calendar-event-dot ${t.includes("personal")||t.includes("task")?"personal":t.includes("holiday")?"holiday":"academic"}"></i>`).join("");
      const journalMark = dayEntries.length ? `<i class="calendar-event-dot journal"></i>` : "";
      const firstTitles = dayItems.slice(0,2).map(x=>`<span class="calendar-cell-event">${escapeHTML(x.title)}</span>`).join("");
      cells += `<button type="button" class="cal-cell schedule-day ${dayItems.length?"has-schedule":""} ${dayEntries.length?"has-entry":""} ${isToday?"today":""} ${isSelected?"selected":""}" onclick="MuseMind.showCalendarDay('${dateStr}')" aria-label="${dateStr}, ${dayItems.length} events, ${dayEntries.length} journal entries">
        <span class="cal-day">${d}</span>
        <span class="calendar-cell-marks">${marks}${journalMark}</span>
        ${firstTitles}
        ${dayItems.length>2?`<span class="calendar-more">+${dayItems.length-2} more</span>`:""}
        ${dayEntries.length?`<span class="calendar-journal-count">${dayEntries.length} journal</span>`:""}
      </button>`;
    }
    document.getElementById("calendarGrid").innerHTML = cells;
    if (selectedCalendarDate && selectedCalendarDate.startsWith(monthPrefix)) showCalendarDay(selectedCalendarDate);
    else {
      const firstWithEvent = monthItems.length ? monthItems[0].date : Object.keys(byDay).filter(k=>k.startsWith(monthPrefix)).sort()[0];
      if (firstWithEvent) { selectedCalendarDate=firstWithEvent; renderCalendarSelectionOnly(); showCalendarDay(firstWithEvent); }
      else document.getElementById("calendarDayDetail").innerHTML = `<div class="calendar-empty-day"><strong>No saved dates in ${calendarCursor.toLocaleDateString("en-IN",{month:"long"})} yet</strong><p>Select a date to add a schedule item, or upload a timetable in My Library.</p></div>`;
    }
  }

  function renderCalendarSelectionOnly() {
    document.querySelectorAll(".schedule-day.selected").forEach(el=>el.classList.remove("selected"));
    const key=selectedCalendarDate;
    if(!key) return;
    const day=Number(key.slice(-2));
    const cell=[...document.querySelectorAll(".schedule-day")].find(el=>Number(el.querySelector(".cal-day")?.textContent)===day);
    if(cell) cell.classList.add("selected");
  }

  function showCalendarDay(dateStr) {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    selectedCalendarDate=dateStr;
    const entries = DataLayer.getUserEntries(user.id).filter(e => (e.date || localDateKey(new Date(e.timestamp))) === dateStr);
    const items = getPlannerItems().filter(item => item.date === dateStr).sort((a,b)=>(a.title||"").localeCompare(b.title||""));
    const d = new Date(dateStr + "T12:00:00");
    const eventHTML = items.length ? `<div class="calendar-detail-section"><div class="calendar-detail-section-title">On your schedule <span>${items.length}</span></div>${items.map(item=>`
      <div class="calendar-event-row ${item.done?"done":""}">
        <span class="calendar-event-type ${String(item.category||"Academic").toLowerCase().includes("deadline")?"deadline":String(item.category||"").toLowerCase().includes("holiday")?"holiday":String(item.category||"").toLowerCase().includes("personal")?"personal":"academic"}"></span>
        <label class="calendar-event-check"><input type="checkbox" ${item.done?"checked":""} onchange="MuseMind.togglePlanItem('${item.id}')"><span></span></label>
        <div class="calendar-event-copy"><strong>${item.subjectCode?`<span class="calendar-subject-code">${escapeHTML(item.subjectCode)}</span> – `:""}${escapeHTML(item.title)}</strong><small>${escapeHTML(item.category||"Academic")}${item.time?` · ${escapeHTML(item.time)}`:""} · ${escapeHTML(item.source||"Personal schedule")}</small>${item.context?`<p>${escapeHTML(item.context)}</p>`:""}${item.sourceDocumentId?`<button class="document-open-link" type="button" onclick="MuseMind.openLibraryFile('${item.sourceDocumentId}')">Open source document ↗</button>`:""}</div>
        <div class="calendar-event-actions"><button class="mini-btn" type="button" onclick="MuseMind.editPlanItem('${item.id}')">Edit</button><button class="mini-btn danger" type="button" onclick="MuseMind.deletePlanItem('${item.id}')">Delete</button></div>
      </div>`).join("")}</div>` : `<div class="calendar-detail-section"><div class="calendar-detail-section-title">On your schedule</div><p class="muted-note">No scheduled items for this date.</p></div>`;
    const journalHTML = entries.length ? `<div class="calendar-detail-section"><div class="calendar-detail-section-title">Journal moments <span>${entries.length}</span></div>${entries.map(entryCardHTML).join("")}</div>` : "";
    document.getElementById("calendarDayDetail").innerHTML = `
      <div class="cal-detail-head"><div><p class="view-eyebrow">SELECTED DATE</p><h3>${fmtDate(d)}</h3></div><span>${items.length} scheduled · ${entries.length} journal</span></div>
      ${eventHTML}${journalHTML}
      <div class="calendar-add-event">
        <div class="calendar-detail-section-title">Add something to this date</div>
        <div class="calendar-add-event-grid">
          <label class="calendar-add-field calendar-add-wide">Title <input id="calendarNewTitle" type="text" maxlength="140" placeholder="e.g. Revise Computer Networks" required></label>
          <label class="calendar-add-field">Category
            <select id="calendarNewCategory">
              <option>Personal</option><option>Examination</option><option>Academic</option><option>Assignment</option><option>Project</option><option>Deadline</option><option>University Event</option><option>Reminder</option>
            </select>
          </label>
          <label class="calendar-add-field">Date <input id="calendarNewDate" type="date" value="${dateStr}" required></label>
          <label class="calendar-add-field">Time (optional) <input id="calendarNewTime" type="time"></label>
          <label class="calendar-add-field">Subject code (optional) <input id="calendarNewCode" type="text" maxlength="24" placeholder="e.g. CSE3101"></label>
          <label class="calendar-add-field calendar-add-wide">Notes (optional) <textarea id="calendarNewNotes" rows="2" maxlength="500" placeholder="Add a reminder or preparation note"></textarea></label>
        </div>
        <div class="calendar-add-actions"><button class="command-btn primary" type="button" onclick="MuseMind.addCalendarEvent()">Add to Calendar</button><span class="tiny-note">Saved in this browser and kept after refresh.</span></div>
      </div>`;
    renderCalendarSelectionOnly();
  }

  function addCalendarEvent() {
    const user=DataLayer.getCurrentUser();
    if(!user) return;
    const title=document.getElementById("calendarNewTitle")?.value.trim()||"";
    const date=document.getElementById("calendarNewDate")?.value||selectedCalendarDate;
    const category=document.getElementById("calendarNewCategory")?.value||"Personal";
    const time=document.getElementById("calendarNewTime")?.value||"";
    const subjectCode=(document.getElementById("calendarNewCode")?.value||"").trim().toUpperCase();
    const context=(document.getElementById("calendarNewNotes")?.value||"").trim();
    const parsed=new Date(date+"T12:00:00");
    if(!title){toast("Add a title before saving.","warn");document.getElementById("calendarNewTitle")?.focus();return;}
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(parsed.getTime())||localDateKey(parsed)!==date){toast("Choose a valid calendar date.","warn");return;}
    const items=getPlannerItems();
    const duplicate=items.some(x=>x.date===date&&String(x.title||"").trim().toLowerCase()===title.toLowerCase()&&String(x.subjectCode||"").toLowerCase()===subjectCode.toLowerCase());
    if(duplicate){toast("This schedule item already exists on that date.","warn");return;}
    items.push({id:uid(category==="Examination"?"exam":"plan"),date,title,subjectCode,category,time,context,source:"Added in Calendar",done:false,createdAt:new Date().toISOString()});
    savePlannerItems(items.sort((a,b)=>a.date.localeCompare(b.date)||(a.time||"").localeCompare(b.time||"")));
    selectedCalendarDate=date;
    const targetMonth=new Date(date+"T12:00:00");
    calendarCursor=new Date(targetMonth.getFullYear(),targetMonth.getMonth(),1);
    renderCalendar();
    showCalendarDay(date);
    toast("Schedule item added to Calendar.","success");
  }

  /* ===================================================================
     13. PROFILE
     =================================================================== */

  function renderProfile() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    const entries = DataLayer.getUserEntries(user.id);
    const streaks = computeStreaks(entries);
    const reflectionDays = new Set(entries.map(e => e.date || localDateKey(new Date(e.timestamp)))).size;
    const dom = dominantEmotion(entries);
    const avg = averageMoodScore(entries);

    document.getElementById("profileName").value = user.name;
    document.getElementById("profileAge").value = user.age;
    document.getElementById("profileGender").value = user.gender;

    document.getElementById("profileEntries").textContent = entries.length;
    document.getElementById("profileStreak").textContent = `${reflectionDays} days`;
    document.getElementById("profileDominant").textContent = dom ? `${EMOTIONS[dom].emoji} ${dom}` : "—";
    document.getElementById("profileMood").textContent = avg !== null ? avg + "/100" : "—";
  }

  function saveProfile() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    user.name = document.getElementById("profileName").value.trim() || user.name;
    user.age = document.getElementById("profileAge").value.trim() || user.age;
    user.gender = document.getElementById("profileGender").value || user.gender;
    DataLayer.saveUser(user);
    document.getElementById("navUserName").textContent = user.name;
    document.getElementById("navUserMeta").textContent = [user.age ? `${user.age} yrs` : "", user.gender || ""].filter(Boolean).join(" • ") || "Your reflection space";
    toast("Profile updated.", "success");
  }

  function openClearDataModal() { document.getElementById("clearDataModal").classList.add("open"); }
  function closeClearDataModal() { document.getElementById("clearDataModal").classList.remove("open"); }
  function performClearData() {
    const user = DataLayer.getCurrentUser();
    if (user) {
      DataLayer.clearUserEntries(user.id);
      DataLayer.clearUserSettings(user.id);
    }
    document.getElementById("clearDataModal").classList.remove("open");
    toast("Your journal data has been cleared.", "success");
    renderAll();
    goToSection("overview");
  }

  /* ===================================================================
     14. EXPORT
     =================================================================== */

  function exportData(format) {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    const entries = DataLayer.getUserEntries(user.id);
    if (!entries.length) {
      toast("No entries to export yet.", "warn");
      return;
    }

    let content, mime, filename;
    if (format === "json") {
      content = JSON.stringify(entries, null, 2);
      mime = "application/json";
      filename = "musemind_journal.json";
    } else if (format === "csv") {
      const headers = ["Date", "Time", "TimePeriod", "EntryContext", "Text", "PrimaryEmotion", "SecondaryEmotion", "HumanCorrectedLabel", "PrimaryPct", "SecondaryPct", "Triggers", "MoodScore", "Reflection"];
      const rows = entries.map((e) => [
        e.date, e.time, e.timePeriod || "", e.entryContext || "", csvSafe(e.text), e.primaryEmotion, e.secondaryEmotion,
        e.humanEmotionLabel || "", e.primaryPercentage, e.secondaryPercentage, (e.triggers || []).join("|"), e.moodScore, csvSafe(e.reflection || ""),
      ]);
      content = [headers, ...rows].map((r) => r.join(",")).join("\n");
      mime = "text/csv";
      filename = "musemind_journal.csv";
    } else {
      content = entries
        .map((e) =>
          `${fmtDate(new Date(e.timestamp))} • ${e.time}\n` +
          `${emotionMeta(e.primaryEmotion).emoji} ${normalizeEmotionName(e.primaryEmotion)} ${e.primaryPercentage}% / ${emotionMeta(e.secondaryEmotion).emoji} ${normalizeEmotionName(e.secondaryEmotion)} ${e.secondaryPercentage}%\n` +
          `"${e.text}"\n` +
          `Triggers: ${e.triggers.join(", ") || "none"}\n` +
          `Mood Score: ${e.moodScore}/100\n` +
          `Reflection: ${e.reflection || ""}\n` +
          "-----------------------------------------\n"
        )
        .join("\n");
      mime = "text/plain";
      filename = "musemind_journal.txt";
    }

    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`Exported as ${format.toUpperCase()}.`, "success");
  }
  function csvSafe(text) {
    return '"' + String(text).replace(/"/g, '""').replace(/\n/g, " ") + '"';
  }

  function exportCurrentAnalysis() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    const entries = DataLayer.getUserEntries(user.id);
    if (!entries.length) { toast("No analyzed entries to export.", "warn"); return; }
    const e = entries[0];
    const report = {
      text: e.text, analyzedAt: `${fmtDate(new Date(e.timestamp))} ${e.time || ""}`, language: e.language,
      source: e.analysisSource, model: e.modelUsed, primaryEmotion: e.primaryEmotion,
      secondaryEmotion: e.secondaryEmotion, moodScore: e.moodScore, triggers: e.triggers,
      goEmotions: e.goEmotionScores || e.goEmotions || []
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], {type:"application/json"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "musemind-emotion-analysis.json";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    toast("Analysis exported.", "success");
  }

  /* ===================================================================
     15. DEMO MODE
     =================================================================== */

  const DEMO_TEXTS = [
    { text: "Presentation went really well today, I am so happy and proud of myself!", offset: 0 },
    { text: "Feeling a bit stressed about the upcoming exams, so much to study.", offset: 1 },
    { text: "Had a calm evening, just relaxed with some music. Sukoon mila.", offset: 2 },
    { text: "Missing my friends a lot today, feeling a little lonely.", offset: 3 },
    { text: "Nervous about tomorrow's viva but I think I have prepared well.", offset: 4 },
    { text: "Great day with family, felt loved and happy the whole time.", offset: 5 },
    { text: "Assignment deadline is tomorrow and I am so overwhelmed with the workload.", offset: 6 },
    { text: "Confident about the project demo, ready to present it tomorrow!", offset: 7 },
  ];

  function loadDemoData() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    DEMO_TEXTS.forEach((d) => {
      const date = new Date();
      date.setDate(date.getDate() - d.offset);
      const result = analyzeText(d.text);
      const entry = {
        id: uid("demo"),
        userId: user.id,
        text: d.text,
        date: localDateKey(date),
        time: fmtTime(date),
        timestamp: date.toISOString(),
        primaryEmotion: result.primary,
        secondaryEmotion: result.secondary,
        primaryPercentage: result.primaryPercent,
        secondaryPercentage: result.secondaryPercent,
        scores: result.scores,
        mixed: result.mixed,
        triggers: result.triggers,
        language: result.language,
        emojiDetected: result.emojiDetected,
        moodScore: result.moodScore,
        characterCount: d.text.length,
        wordCount: d.text.split(/\s+/).filter(Boolean).length,
        sentences: result.sentences,
        demo: true,
      };
      entry.reflection = generateReflection(entry, []);
      DataLayer.saveEntry(entry);
    });
    toast("Demo data loaded — labeled entries, not your real data.", "success");
    renderAll();
    goToSection("overview");
  }

  function clearDemoData() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    const entries = DataLayer.getAllEntries().filter((e) => !(e.userId === user.id && e.demo));
    DataLayer._write(KEYS.ENTRIES, entries);
    toast("Demo data cleared.", "success");
    renderAll();
  }

  /* ===================================================================
     16. RENDER ALL
     =================================================================== */


  /* ===================================================================
     17A. REFLECTION INTELLIGENCE — transparent, user-controlled tools
     These features use stored journal entries and existing analysis.
     They do not claim clinical insight or infer hidden causes.
     =================================================================== */

  let activeDecoderEntryId = null;
  let speechRecognition = null;

  function renderThoughtDecoder(entry) {
    const box = document.getElementById("thoughtDecoder");
    const feedback = document.getElementById("decoderFeedback");
    if (!box || !entry) return;
    activeDecoderEntryId = entry.id;
    const context = Array.isArray(entry.triggers) && entry.triggers.length
      ? entry.triggers.slice(0, 3)
      : [];
    const sentenceSignals = (entry.sentences || []).slice(0, 4);
    const questionByEmotion = {
      Stressed: "Which part feels most difficult right now: the amount to do, the uncertainty, or getting started?",
      Anxious: "What part of this situation feels least certain to you?",
      Sad: "Would it help to name what you miss or what has changed?",
      Angry: "What boundary, expectation or situation feels important here?",
      Happy: "What happened that you would like to remember about this moment?",
      Excited: "What are you looking forward to most?",
      Calm: "What seems to be helping you feel settled right now?",
      Confident: "What helped you feel capable in this situation?"
    };
    const firstSentence = sentenceSignals[0]?.text || String(entry.text || "").slice(0, 220);
    const signalLabel = `${entry.primaryEmotion || "Unclear"}${entry.secondaryEmotion && entry.secondaryEmotion !== entry.primaryEmotion ? ` · ${entry.secondaryEmotion}` : ""}`;
    const contextHtml = context.length
      ? context.map(t => `<span class="chip chip-muted">${escapeHTML(t)}</span>`).join("")
      : `<span class="muted-note">No clear context category was identified in this entry.</span>`;
    const sentenceHtml = sentenceSignals.length
      ? sentenceSignals.map(s => `<div class="decoder-sentence"><span>${escapeHTML(s.emotion || "Signal")}</span><p>${escapeHTML(s.text)}</p></div>`).join("")
      : `<p class="muted-note">Sentence-level signals are not available for this entry.</p>`;
    box.innerHTML = `
      <div class="decoder-item"><small>WHAT YOU SHARED</small><p>${escapeHTML(firstSentence)}</p></div>
      <div class="decoder-item"><small>POSSIBLE EMOTIONAL SIGNALS</small><strong>${escapeHTML(signalLabel)}</strong><p>These are model-generated signals, not a definitive description of how you feel.</p></div>
      <div class="decoder-item"><small>CONTEXT MENTIONED</small><div class="chip-row">${contextHtml}</div><p>These topics were detected in the text; they are not confirmed causes.</p></div>
      <div class="decoder-item"><small>SENTENCE VIEW</small>${sentenceHtml}</div>
      <div class="decoder-question"><small>A QUESTION TO EXPLORE</small><p>${escapeHTML(questionByEmotion[entry.primaryEmotion] || "Which part of this experience feels most important to understand?")}</p></div>`;
    if (feedback) feedback.hidden = false;
  }

  function saveEmotionCorrection() {
    const user = DataLayer.getCurrentUser();
    const label = document.getElementById("humanEmotionLabel")?.value;
    const status = document.getElementById("modelFeedbackStatus");
    if (!user || !activeAnalysisEntryId) { toast("Open a saved journal entry before adding a correction.", "warn"); return; }
    if (!label) { toast("Choose the emotion label that fits best.", "warn"); return; }
    const entry = DataLayer.getAllEntries().find(e => e.id === activeAnalysisEntryId && e.userId === user.id);
    if (!entry) { toast("This analysis is not a saved journal entry.", "warn"); return; }
    const updated = DataLayer.updateEntry(activeAnalysisEntryId, {
      humanEmotionLabel: label,
      humanEmotionLabelSource: "user-corrected",
      humanEmotionLabelAt: new Date().toISOString()
    });
    if (status) status.textContent = updated ? `Saved: ${label}. This correction is included in your JSON export for reviewed model-training experiments.` : "Could not save the correction.";
    toast(updated ? "Emotion correction saved." : "Correction could not be saved.", updated ? "success" : "warn");
  }

  function rateInterpretation(rating) {
    const user = DataLayer.getCurrentUser();
    if (!user || !activeDecoderEntryId) return;
    const updated = DataLayer.updateEntry(activeDecoderEntryId, {
      interpretationFeedback: rating,
      interpretationFeedbackAt: new Date().toISOString()
    });
    const feedback = document.getElementById("decoderFeedback");
    if (feedback) {
      feedback.innerHTML = `<span>${updated ? "Thanks. Your feedback is saved with this entry." : "Thanks for the feedback. This analysis was not saved in your journal, so the rating will not persist."}</span>`;
    }
    toast(updated ? "Feedback saved." : "Feedback received for this temporary analysis.", updated ? "success" : "info");
  }

  function tokenizeForMemory(value) {
    const stop = new Set(["what","was","were","is","are","the","a","an","me","my","i","to","of","in","on","at","and","or","it","this","that","before","after","when","why","how","have","had","do","did","about","with","from","for","would","could","should","been","being","feel","feeling","felt"]);
    return String(value || "").toLowerCase().match(/[a-z0-9\u0900-\u097f]+/g)?.filter(w => w.length > 2 && !stop.has(w)) || [];
  }

  function setMemoryQuery(value) {
    const input = document.getElementById("memoryQuery");
    if (input) input.value = value;
    searchMemories();
  }


  function renderKnowledgeVault() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    ensureAcademicCalendarSeed();
    const docs = DataLayer.getSetting(user.id, "knowledgeDocuments", []) || [];
    const tasks = DataLayer.getSetting(user.id, "documentPlannerItems", []) || [];
    const entries = DataLayer.getUserEntries(user.id);
    const stats = document.getElementById("knowledgeStats");
    if (stats) stats.innerHTML = `
      <div class="knowledge-stat"><strong>${docs.length}</strong><span>Knowledge sources</span></div>
      <div class="knowledge-stat"><strong>${entries.length}</strong><span>Journal records</span></div>
      <div class="knowledge-stat"><strong>${tasks.filter(t=>!t.done).length}</strong><span>Open actions</span></div>`;
    const docBox = document.getElementById("knowledgeDocuments");
    if (docBox) docBox.innerHTML = docs.length ? docs.slice().sort((a,b)=>(a.category||"").localeCompare(b.category||"") || a.name.localeCompare(b.name)).map(d=>`
      <div class="knowledge-doc">
        <div class="knowledge-doc-icon">${d.type==="Image"?"🖼️":"📄"}</div>
        <div class="knowledge-doc-main">
          <strong>${escapeHTML(d.name)}</strong>
          <small>${escapeHTML(d.category||"Uncategorised")} · ${d.pages||1} page${(d.pages||1)===1?"":"s"} · Added ${d.addedAt?fmtDate(new Date(d.addedAt)):"—"}</small>
          <small>${escapeHTML(d.summary||"File saved in your local library.")}</small>
          <span class="knowledge-chip">${(d.tags||[]).slice(0,3).map(escapeHTML).join(" · ")}</span>
          <div class="library-file-actions">
            ${d.filePath ? `<a class="document-open-link" href="${escapeHTML(d.filePath)}" target="_blank" rel="noopener">Open file ↗</a>` : d.fileId ? `<button class="document-open-link" type="button" onclick="MuseMind.openLibraryFile('${d.id}')">Open file ↗</button>` : d.demo ? `<a class="document-open-link" href="demo_documents/${encodeURIComponent(d.name)}" target="_blank" rel="noopener">Open sample file ↗</a>` : `<span class="tiny-note">File details saved</span>`}
            <button class="mini-btn" type="button" onclick="MuseMind.editLibraryDocument('${d.id}')">Edit details</button>
            <button class="mini-btn danger" type="button" onclick="MuseMind.deleteLibraryDocument('${d.id}')">Delete</button>
          </div>
        </div>
      </div>`).join("") : emptyState("📄","No documents saved","Upload a PDF or image above to add it to My Library.");
    renderKnowledgeTasks(tasks, "all");
  }

  function renderKnowledgeTasks(tasks, category) {
    const taskBox = document.getElementById("knowledgeTasks");
    if (!taskBox) return;
    const classify = t => /MuseMind|project|demo|source citation|rehears/i.test(t.title+" "+(t.source||"")) ? "Project" : /Personal|organise/i.test(t.title+" "+(t.source||"")) ? "Personal" : "Academic";
    const filtered = tasks.filter(t => category === "all" || classify(t) === category).sort((a,b)=>a.date.localeCompare(b.date));
    taskBox.innerHTML = filtered.length ? filtered.map(t=>`
      <div class="knowledge-task ${t.done?"done":""}">
        <input type="checkbox" ${t.done?"checked":""} aria-label="Mark ${escapeHTML(t.title)} complete" onchange="MuseMind.togglePlanItem('${t.id}')">
        <div class="knowledge-task-main"><div class="task-title-line"><strong>${escapeHTML(t.title)}</strong><span class="task-type ${classify(t).toLowerCase()}">${classify(t)}</span></div><small>${new Date(t.date+"T12:00:00").toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"})} · ${escapeHTML(t.source||"Personal task")}</small></div>
      </div>`).join("") : emptyState("🗓️","No tasks in this category","Choose another task type or add a task.");
  }

  function filterKnowledgeTasks(category) {
    const user = DataLayer.getCurrentUser();
    if (user) renderKnowledgeTasks(DataLayer.getSetting(user.id, "documentPlannerItems", []) || [], category);
  }

  function setKnowledgeQuery(value) {
    const input = document.getElementById("knowledgeQuery");
    if (input) input.value = value;
    searchKnowledge();
  }

  function searchKnowledge() {
    const user = DataLayer.getCurrentUser();
    const input = document.getElementById("knowledgeQuery");
    const out = document.getElementById("knowledgeAnswer");
    if (!user || !out) return;
    const query = (input?.value||"").trim().toLowerCase();
    if (!query) { out.innerHTML = ""; return; }
    const terms = tokenizeForMemory(query);
    const docs = DataLayer.getSetting(user.id,"knowledgeDocuments",[])||[];
    const tasks = DataLayer.getSetting(user.id,"documentPlannerItems",[])||[];
    const entries = DataLayer.getUserEntries(user.id);
    const sources = [
      ...docs.map(d=>({type:"Document",title:d.name,source:d.name,text:`${d.name} ${d.category} ${d.text} ${(d.tags||[]).join(" ")}`,detail:d.summary||"Saved document source"})),
      ...tasks.map(t=>({type:"Task",title:t.title,source:t.source||"Personal task",text:`${t.title} ${t.source||""} ${t.context||""} ${t.date}`,detail:`${t.date} · ${t.done?"Completed":"Pending"}`})),
      ...entries.map(e=>({type:"Journal",title:`${normalizeEmotionName(e.primaryEmotion)} reflection`,source:`Journal · ${fmtDate(new Date(e.timestamp))}`,text:`${e.text} ${e.entryContext||""} ${e.primaryEmotion||""}`,detail:`${e.timePeriod||"Journal"} · ${e.time||""}`,entryId:e.id}))
    ];
    const ranked = sources.map(s=>{
      const text=s.text.toLowerCase();
      const matched=terms.filter(t=>text.includes(t));
      const score=matched.reduce((n,t)=>n+(text.split(t).length-1),0);
      return {...s,matched,score};
    }).filter(s=>s.score>0).sort((a,b)=>b.score-a.score).slice(0,8);
    if (!ranked.length) {
      out.innerHTML = `<div class="knowledge-answer-card"><h3>No matching source found</h3><p>Try a course name, document title, deadline topic or phrase used in a journal entry. MuseMind only answers from information it can retrieve.</p></div>`;
      return;
    }
    const docHits=ranked.filter(x=>x.type==="Document").length;
    const taskHits=ranked.filter(x=>x.type==="Task").length;
    const journalHits=ranked.filter(x=>x.type==="Journal").length;
    out.innerHTML = `<div class="knowledge-answer-card"><h3>Found ${ranked.length} relevant records</h3><p>Matched ${docHits} document(s), ${taskHits} task(s) and ${journalHits} journal record(s). Results are ranked by matching words; open the original source to verify context.</p>
      ${ranked.map(r=>`<div class="knowledge-result"><strong>${escapeHTML(r.title)}</strong><small>${escapeHTML(r.type)} · ${escapeHTML(r.source)} · ${escapeHTML(r.detail)}</small><small>Matched: ${r.matched.map(escapeHTML).join(", ")}</small>${r.entryId?`<button class="mini-btn" type="button" onclick="MuseMind.viewEntry('${r.entryId}')">Open original entry</button>`:""}</div>`).join("")}
      </div>`;
  }

  function searchMemories() {
    const user = DataLayer.getCurrentUser();
    const input = document.getElementById("memoryQuery");
    const query = input?.value.trim() || "";
    const results = document.getElementById("memoryResults");
    const summary = document.getElementById("memorySummary");
    if (!user || !results) return;
    if (!query) {
      results.innerHTML = emptyState("🪞", "Start with a word or topic", "Search for a phrase, situation or topic from your past entries.");
      if (summary) summary.innerHTML = "";
      return;
    }
    const terms = tokenizeForMemory(query);
    if (!terms.length) {
      results.innerHTML = emptyState("🔎", "Try a more specific search", "Use a topic or a few words you remember from an entry.");
      if (summary) summary.innerHTML = "";
      return;
    }
    const entries = DataLayer.getUserEntries(user.id);
    const ranked = entries.map(entry => {
      const text = `${entry.text || ""} ${(entry.triggers || []).join(" ")} ${entry.primaryEmotion || ""} ${entry.secondaryEmotion || ""}`.toLowerCase();
      const matched = terms.filter(term => text.includes(term));
      const score = matched.reduce((sum, term) => sum + (text.split(term).length - 1), 0);
      return { entry, matched, score };
    }).filter(x => x.score > 0).sort((a,b) => b.score - a.score || new Date(b.entry.timestamp) - new Date(a.entry.timestamp)).slice(0, 8);
    if (summary) summary.innerHTML = `<div class="memory-summary-card"><strong>${ranked.length} matching ${ranked.length === 1 ? "reflection" : "reflections"}</strong><span>Matched words: ${terms.map(escapeHTML).join(", ")} · Sorted by text match and recency.</span></div>`;
    if (!ranked.length) {
      results.innerHTML = emptyState("🫧", "No matching entries found", "Try a broader word or a topic you may have used in your journal.");
      return;
    }
    results.innerHTML = ranked.map(({entry,matched}) => `
      <article class="memory-result card">
        <div class="memory-result-top"><span>${fmtDate(new Date(entry.timestamp))}</span><span class="entry-emotion">${EMOTIONS[entry.primaryEmotion]?.emoji || "•"} ${escapeHTML(entry.primaryEmotion || "Unanalysed")}</span></div>
        <p>${escapeHTML((entry.text || "").slice(0, 260))}${(entry.text || "").length > 260 ? "…" : ""}</p>
        <div class="memory-match">Matched: ${matched.map(escapeHTML).join(" · ")}</div>
        <button class="mini-btn" type="button" onclick="MuseMind.viewEntry('${String(entry.id).replace(/'/g,"")}')">Open reflection</button>
      </article>`).join("");
  }


  // Document-to-Plan: extract candidate dates, then let the user confirm them.
  let pendingDocumentItems = [];
  function getPlannerItems() {
    const user = DataLayer.getCurrentUser();
    if (!user) return [];
    const value = DataLayer.getSetting(user.id, "documentPlannerItems", []);
    return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || ""))) : [];
  }
  function savePlannerItems(items) {
    const user = DataLayer.getCurrentUser();
    if (user) DataLayer.setSetting(user.id, "documentPlannerItems", items);
  }
  function parseDocumentDates(text, filename) {
    const lines = String(text || "").split(/\n+/).map(x => x.replace(/\s+/g," ").trim()).filter(Boolean);
    const patterns = [
      /\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/g,
      /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g,
      /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/gi,
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/gi
    ];
    const found = [];
    const add = (date, line) => {
      if (!date || Number.isNaN(date.getTime())) return;
      date.setHours(12,0,0,0);
      const iso = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
      const context = line.replace(/\s+/g," ").slice(0,180);
      if (!found.some(x => x.date === iso && x.context === context)) found.push({ id: uid("plan"), title: inferPlanTitle(context, filename), date: iso, context, source: filename });
    };
    lines.forEach(line => {
      let m;
      patterns[0].lastIndex=0; while((m=patterns[0].exec(line))) add(new Date(Number(m[3]),Number(m[2])-1,Number(m[1])),line);
      patterns[1].lastIndex=0; while((m=patterns[1].exec(line))) add(new Date(Number(m[1]),Number(m[2])-1,Number(m[3])),line);
      patterns[2].lastIndex=0; while((m=patterns[2].exec(line))) add(new Date(`${m[1]} ${m[2]} ${m[3]}`),line);
      patterns[3].lastIndex=0; while((m=patterns[3].exec(line))) add(new Date(`${m[1]} ${m[2]} ${m[3]}`),line);
      if (/\b(today|tomorrow)\b/i.test(line)) {
        const d = new Date(); if (/tomorrow/i.test(line)) d.setDate(d.getDate()+1); add(d,line);
      }
    });
    return found.sort((a,b)=>a.date.localeCompare(b.date)).slice(0,40);
  }

  function isoDateFromTimetableMatch(match) {
    const day=Number(match[1]), month=Number(match[2]), year=Number(match[3]);
    const d=new Date(year,month-1,day,12,0,0,0);
    if(d.getFullYear()!==year || d.getMonth()!==month-1 || d.getDate()!==day) return null;
    return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  }
  function weekdayForISO(iso) {
    return new Date(iso+"T12:00:00").toLocaleDateString("en-IN",{weekday:"long"});
  }
  function parseExaminationTimetable(text, filename) {
    const source=String(text||"").replace(/\r/g,"\n").replace(/[–—]/g,"-");
    const dateRe=/\b(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(20\d{2})\b/g;
    const matches=[...source.matchAll(dateRe)];
    if(!matches.length) return [];
    const results=[];
    const codeRe=/\b([A-Z]{2,4}\s?\d{3,4})\b/g;
    matches.forEach((m,index)=>{
      const iso=isoDateFromTimetableMatch(m);
      if(!iso) return;
      const end=index+1<matches.length?matches[index+1].index:source.length;
      let chunk=source.slice(m.index+m[0].length,end);
      const weekdayMatch=chunk.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
      const detectedWeekday=weekdayMatch?weekdayMatch[1]:"";
      const calculatedWeekday=weekdayForISO(iso);
      // Remove weekday labels and common table noise while preserving subject names.
      chunk=chunk.replace(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi," ")
                 .replace(/\b(DATE|CSE|SUBJECT|EXAMINATION|TIME|VENUE)\b(?=\s{0,2}$)/gi," ")
                 .replace(/\s+/g," ").trim();
      if(!chunk || chunk.length<3) return; // Do not invent an event for a blank timetable row.
      const codes=[...chunk.matchAll(codeRe)];
      if(codes.length){
        codes.forEach((codeMatch,ci)=>{
          const code=codeMatch[1].replace(/\s+/g,"").toUpperCase();
          const titleStart=codeMatch.index+codeMatch[0].length;
          const titleEnd=ci+1<codes.length?codes[ci+1].index:chunk.length;
          let title=chunk.slice(titleStart,titleEnd)
            .replace(/^[\s/:|•,.-]+/,"")
            .replace(/[\s/:|•,.-]+$/,"")
            .replace(/\s+/g," ").trim();
          // Discard table headings and obvious OCR debris.
          title=title.replace(/\b(?:CSE|DATE|SUBJECT)\b/gi," ").replace(/\s+/g," ").trim();
          if(!title || title.length<2) return;
          results.push({
            id:uid("exam"), date:iso, weekday:calculatedWeekday, weekdayDetected:detectedWeekday,
            weekdayMismatch:!!detectedWeekday && detectedWeekday.toLowerCase()!==calculatedWeekday.toLowerCase(),
            subjectCode:code, title, category:"Examination",
            time:"", context:`Extracted from ${filename}. Verify the subject and date before adding.`,
            source:filename, selected:false, confidence:"Review required"
          });
        });
      } else {
        const title=inferPlanTitle(chunk,filename).trim();
        if(title && !/^(?:date|cse|subject|exam|examination|timetable|schedule)$/i.test(title) && title.length>4){
          results.push({id:uid("plan"),date:iso,weekday:calculatedWeekday,weekdayDetected:detectedWeekday,
            weekdayMismatch:!!detectedWeekday && detectedWeekday.toLowerCase()!==calculatedWeekday.toLowerCase(),title,subjectCode:"",
            category:"Academic",time:"",context:`Date detected in ${filename}. Review before adding.`,
            source:filename,selected:true,confidence:"Review required"});
        }
      }
    });
    return results.filter((item,i,arr)=>arr.findIndex(x=>x.date===item.date && x.subjectCode===item.subjectCode && x.title.toLowerCase()===item.title.toLowerCase())===i)
      .sort((a,b)=>a.date.localeCompare(b.date)||a.subjectCode.localeCompare(b.subjectCode));
  }


  function parseExaminationTimetableFromOCR(canvas, words, filename) {
    if(!canvas || !Array.isArray(words) || !words.length) return [];
    const ctx=canvas.getContext("2d",{willReadFrequently:true});
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const width=canvas.width, height=canvas.height;
    const lineRows=[];
    for(let y=0;y<height;y++){
      let dark=0;
      for(let x=0;x<width;x+=2){
        const p=(y*width+x)*4;
        if((pixels[p]+pixels[p+1]+pixels[p+2])/3<105) dark++;
      }
      if(dark>=(width/2)*0.55) lineRows.push(y);
    }
    const lineGroups=[];
    lineRows.forEach(y=>{
      const last=lineGroups[lineGroups.length-1];
      if(!last || y>last[last.length-1]+2) lineGroups.push([y]);
      else last.push(y);
    });
    const boundaries=lineGroups.map(g=>Math.round((g[0]+g[g.length-1])/2));
    if(boundaries.length<3) return [];
    let splitX=width*0.37, bestVertical=0;
    for(let x=0;x<width;x++){
      let dark=0;
      for(let y=0;y<height;y+=2){
        const p=(y*width+x)*4;
        if((pixels[p]+pixels[p+1]+pixels[p+2])/3<105) dark++;
      }
      if(dark>bestVertical && dark>height*0.22){bestVertical=dark;splitX=x;}
    }
    if(splitX<width*0.2 || splitX>width*0.65) splitX=width*0.37;
    const results=[];
    for(let r=0;r<boundaries.length-1;r++){
      const top=boundaries[r], bottom=boundaries[r+1];
      if(bottom-top<28) continue;
      const rowWords=words.filter(w=>{
        const b=w.bbox||{};
        const cy=((b.y0||0)+(b.y1||0))/2;
        return cy>=top && cy<bottom && String(w.text||"").trim() && (w.confidence==null || w.confidence>15);
      });
      const left=rowWords.filter(w=>(w.bbox?.x0||0)<splitX).sort((a,b)=>(a.bbox.y0-b.bbox.y0)||(a.bbox.x0-b.bbox.x0));
      const right=rowWords.filter(w=>(w.bbox?.x0||0)>=splitX).sort((a,b)=>(a.bbox.y0-b.bbox.y0)||(a.bbox.x0-b.bbox.x0));
      const leftText=left.map(w=>w.text).join(" ").replace(/\s+/g," ").trim();
      const dateMatch=leftText.match(/\b(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(20\d{2})\b/);
      if(!dateMatch) continue;
      const iso=isoDateFromTimetableMatch(dateMatch);
      if(!iso) continue;
      const weekdayMatch=leftText.match(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
      const detectedWeekday=weekdayMatch?weekdayMatch[1]:"";
      const calculatedWeekday=weekdayForISO(iso);
      const subjectText=right.map(w=>w.text).join(" ").replace(/[{}[\]]/g," ").replace(/\s+/g," ").trim();
      const codes=[...subjectText.matchAll(/\b([A-Z]{2,4}\s?\d{3,4})\b/g)];
      codes.forEach((m,i)=>{
        const subjectCode=m[1].replace(/\s+/g,"").toUpperCase();
        let title=subjectText.slice(m.index+m[0].length,i+1<codes.length?codes[i+1].index:subjectText.length)
          .replace(/^[\s/:|•,.-]+/,"").replace(/[\s/:|•,.-]+$/,"")
          .replace(/[{}[\]]/g," ").replace(/\s+/g," ").trim();
        if(!title || title.length<2) return;
        results.push({
          id:uid("exam"),date:iso,weekday:calculatedWeekday,weekdayDetected:detectedWeekday,
          weekdayMismatch:!!detectedWeekday && detectedWeekday.toLowerCase()!==calculatedWeekday.toLowerCase(),
          subjectCode,title,category:"Examination",time:"",
          context:`Read from timetable row in ${filename}. Verify before adding.`,
          source:filename,selected:false,confidence:"Review required"
        });
      });
    }
    return results.filter((item,i,arr)=>arr.findIndex(x=>x.date===item.date&&x.subjectCode===item.subjectCode&&x.title.toLowerCase()===item.title.toLowerCase())===i)
      .sort((a,b)=>a.date.localeCompare(b.date)||a.subjectCode.localeCompare(b.subjectCode));
  }

  function inferPlanTitle(line, filename) {
    const cleaned = line.replace(/\b(20\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]20\d{2}|\d{1,2}\s+[A-Za-z]+\s+20\d{2}|[A-Za-z]+\s+\d{1,2},?\s+20\d{2})\b/g, "").replace(/[:|•–—-]/g," ").trim();
    const useful = cleaned.length > 5 ? cleaned : (filename || "Document date").replace(/\.[^.]+$/," ");
    return useful.slice(0,70) || "Scheduled item";
  }
  function extractPdfItemsAsLines(items) {
    const rows=[];
    items.map(item=>({text:item.str||"",x:item.transform?.[4]||0,y:item.transform?.[5]||0}))
      .filter(item=>item.text.trim())
      .sort((a,b)=>b.y-a.y || a.x-b.x)
      .forEach(item=>{
        let row=rows.find(r=>Math.abs(r.y-item.y)<3);
        if(!row){row={y:item.y,parts:[]};rows.push(row);}
        row.parts.push(item);
      });
    return rows.sort((a,b)=>b.y-a.y).map(row=>row.parts.sort((a,b)=>a.x-b.x).map(x=>x.text).join(" ").replace(/\s+/g," ").trim()).filter(Boolean).join("\n");
  }

  let museMindOcrLoadPromise = null;
  async function createMuseMindOCRWorker() {
    if (window.Tesseract && typeof window.Tesseract.createWorker === "function") {
      return await window.Tesseract.createWorker("eng");
    }
    if (!museMindOcrLoadPromise) {
      museMindOcrLoadPromise = new Promise((resolve,reject)=>{
        const script=document.createElement("script");
        script.src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
        script.async=true; script.dataset.musemindTesseract="true";
        script.onload=resolve;
        script.onerror=()=>reject(new Error("OCR library could not be loaded. Check your internet connection."));
        document.head.appendChild(script);
      });
    }
    await museMindOcrLoadPromise;
    if (!window.Tesseract || typeof window.Tesseract.createWorker !== "function") {
      throw new Error("OCR library loaded, but its createWorker function is unavailable.");
    }
    return await window.Tesseract.createWorker("eng");
  }
  async function prepareImageForOCR(file) {
    if(!("createImageBitmap" in window)) return file;
    const bitmap=await createImageBitmap(file);
    const scale=Math.min(2.5, Math.max(1.5, 1800/Math.max(bitmap.width,bitmap.height)));
    const canvas=document.createElement("canvas");
    canvas.width=Math.round(bitmap.width*scale);
    canvas.height=Math.round(bitmap.height*scale);
    const ctx=canvas.getContext("2d",{willReadFrequently:true});
    ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    bitmap.close?.();
    const image=ctx.getImageData(0,0,canvas.width,canvas.height);
    for(let i=0;i<image.data.length;i+=4){
      const gray=Math.min(255,Math.max(0,(image.data[i]*.299+image.data[i+1]*.587+image.data[i+2]*.114-128)*1.18+128));
      image.data[i]=image.data[i+1]=image.data[i+2]=gray;
    }
    ctx.putImageData(image,0,0);
    return canvas;
  }

  async function extractDocumentDates(file) {
    if (!file) return;
    const status = document.getElementById(pendingDocumentTarget === "library" ? "libraryUploadStatus" : "plannerStatus");
    const output = document.getElementById(pendingDocumentTarget === "library" ? "libraryExtractedDates" : "plannerExtracted");
    pendingDocumentItems = [];
    if(output) output.innerHTML = "";
    if(status) status.textContent = `Reading ${file.name}…`;
    try {
      let text = "";
      let ocrTableCandidates = [];
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
        const pdf = await pdfjs.getDocument({data: await file.arrayBuffer()}).promise;
        const pages = [];
        for (let i=1;i<=Math.min(pdf.numPages,30);i++) {
          const page = await pdf.getPage(i); const content = await page.getTextContent();
          pages.push(extractPdfItemsAsLines(content.items));
        }
        text = pages.join("\n");
        if (!text.trim()) {
          if(status) status.textContent = "This looks like a scanned PDF. Running text recognition on its pages…";
          const worker = await createMuseMindOCRWorker();
          const ocrPages = [];
          try {
            for (let i=1;i<=Math.min(pdf.numPages,12);i++) {
              const page = await pdf.getPage(i); const viewport = page.getViewport({scale:2});
              const canvas = document.createElement("canvas"); canvas.width = viewport.width; canvas.height = viewport.height;
              await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
              await worker.setParameters?.({tessedit_pageseg_mode:"11"});
              const result = await worker.recognize(canvas);
              ocrPages.push(result.data.text || "");
              ocrTableCandidates.push(...parseExaminationTimetableFromOCR(canvas,result.data.words||[],file.name));
            }
          } finally { await worker.terminate(); }
          text = ocrPages.join("\n");
          if (!text.trim()) throw new Error("Could not read text from this scanned PDF. Try a sharper scan or image.");
        }
      } else if (file.type.startsWith("image/") || /\.(png|jpe?g)$/i.test(file.name)) {
        const worker = await createMuseMindOCRWorker();
        try {
          const preparedImage=await prepareImageForOCR(file);
          await worker.setParameters?.({tessedit_pageseg_mode:"11"});
          const result = await worker.recognize(preparedImage);
          text = result.data.text || "";
          ocrTableCandidates = parseExaminationTimetableFromOCR(preparedImage,result.data.words||[],file.name);
        } finally { await worker.terminate(); }
      } else {
        throw new Error("Please choose a PDF or image file.");
      }
      const savedDocument = await saveUploadedDocumentRecord(file,text);
      pendingDocumentSourceId = savedDocument?.id || null;
      const examItems = ocrTableCandidates.length ? ocrTableCandidates : parseExaminationTimetable(text, file.name);
      if (examItems.length) {
        pendingDocumentItems = examItems;
      } else if (/calend[ae]r/i.test(file.name) && /2026|2027/.test(text)) {
        pendingDocumentItems = ACADEMIC_CALENDAR_EVENTS.map((e,i)=>({id:uid("plan"),title:e.title,date:e.date,category:e.category,context:"Imported from the MUJ Academic Calendar 2026–2027. Review before saving.",source:file.name,selected:true}));
      } else pendingDocumentItems = parseDocumentDates(text, file.name);
      pendingDocumentItems = pendingDocumentItems.map(item=>({...item,sourceDocumentId:pendingDocumentSourceId}));
      if (!pendingDocumentItems.length) {
        if(status) status.textContent = "The original is saved in My Library, but no reliable dates were recognised. You can add schedule items manually in Growth Studio.";
        const targetBox = document.getElementById(pendingDocumentTarget === "library" ? "libraryExtractedDates" : "plannerExtracted");
        if (targetBox) targetBox.innerHTML = "";
      } else {
        if(status) status.textContent = `Found ${pendingDocumentItems.length} possible event${pendingDocumentItems.length===1?"":"s"}. Review and confirm only the items you want.`;
        renderPendingDocumentItems();
      }
    } catch (error) {
      console.error("Document extraction failed",error);
      if(status) status.textContent = error.message || "Could not read this file. The original remains saved in My Library; try a clearer image or a text-based PDF.";
      try { await saveUploadedDocumentRecord(file,""); renderKnowledgeVault(); } catch(_) {}
    }
  }
  function renderPendingDocumentItems() {
    const box = document.getElementById(pendingDocumentTarget === "library" ? "libraryExtractedDates" : "plannerExtracted");
    if (!box) return;
    if(!pendingDocumentItems.length){box.innerHTML="";return;}
    const examMode=pendingDocumentItems.some(x=>x.category==="Examination");
    const rows=pendingDocumentItems.map((item,i)=>{
      const weekday=weekdayForISO(item.date);
      const mismatch=item.weekday && item.weekday.toLowerCase()!==weekday.toLowerCase();
      return `<div class="planner-item timetable-review-item">
        <label class="planner-check"><input type="checkbox" ${item.selected?"checked":""} data-plan-index="${i}"><span></span></label>
        <div class="planner-item-fields">
          ${item.subjectCode?`<input class="planner-title-input" aria-label="Subject code" value="${escapeHTML(item.subjectCode)}" data-plan-code="${i}" placeholder="Subject code">`:""}
          <input class="planner-title-input" aria-label="Event title" value="${escapeHTML(item.title)}" data-plan-title="${i}" placeholder="Event / subject title">
          <div class="planner-review-meta">
            <input class="planner-date-input" aria-label="Event date" type="date" value="${item.date}" data-plan-date="${i}">
            <input class="planner-date-input" aria-label="Event time (optional)" type="time" value="${escapeHTML(item.time||"")}" data-plan-time="${i}">
            <select class="planner-date-input" aria-label="Event category" data-plan-category="${i}">
              ${["Examination","Assignment","Academic","Deadline","University Event","Holiday","Personal"].map(c=>`<option ${String(item.category||"Academic")===c?"selected":""}>${c}</option>`).join("")}
            </select>
          </div>
          <small>${escapeHTML(item.context||"Extracted from uploaded document")} · ${item.weekdayDetected?`Document weekday: ${escapeHTML(item.weekdayDetected)} · `:""}Date weekday: ${weekday}${mismatch||item.weekdayMismatch?" · CHECK WEEKDAY":""}</small>
        </div>
      </div>`;
    }).join("");
    box.innerHTML=`<div class="timetable-review-head"><strong>${examMode?"Review extracted examinations":"Review extracted dates"}</strong><span>${pendingDocumentItems.length} candidate event${pendingDocumentItems.length===1?"":"s"}</span></div>
      ${examMode?`<p class="muted-note">Multiple subjects on the same date are separate choices. Select only the examinations that apply to you.</p>`:""}
      ${rows}
      <div class="timetable-review-actions">
        <button class="command-btn primary planner-save-btn" type="button" onclick="MuseMind.saveExtractedPlanItems()">Confirm &amp; Add Selected Events</button>
        <button class="mini-btn" type="button" onclick="MuseMind.cancelExtractedPlanItems()">Cancel</button>
      </div>`;
  }
  function cancelExtractedPlanItems(){
    pendingDocumentItems=[];
    const box=document.getElementById(pendingDocumentTarget==="library"?"libraryExtractedDates":"plannerExtracted");
    if(box) box.innerHTML="";
    const status=document.getElementById(pendingDocumentTarget==="library"?"libraryUploadStatus":"plannerStatus");
    if(status) status.textContent="Import cancelled. Your original document remains in My Library.";
  }

  function saveExtractedPlanItems() {
    const box = document.getElementById(pendingDocumentTarget === "library" ? "libraryExtractedDates" : "plannerExtracted");
    if(!box) return;
    const selected = [...box.querySelectorAll("[data-plan-index]:checked")].map(el=>Number(el.dataset.planIndex));
    if (!selected.length) { toast("Select at least one event to add.","warn"); return; }
    const items = getPlannerItems();
    let added=0, duplicates=0;
    selected.forEach(i=>{
      const item = pendingDocumentItems[i];
      if(!item) return;
      const title = box.querySelector(`[data-plan-title="${i}"]`)?.value.trim() || item.title;
      const subjectCode=box.querySelector(`[data-plan-code="${i}"]`)?.value.trim().toUpperCase() || item.subjectCode || "";
      const date = box.querySelector(`[data-plan-date="${i}"]`)?.value || item.date;
      const time = box.querySelector(`[data-plan-time="${i}"]`)?.value || "";
      const category = box.querySelector(`[data-plan-category="${i}"]`)?.value || item.category || "Academic";
      if(!date || !title) return;
      const duplicate=items.some(existing=>existing.date===date &&
        String(existing.subjectCode||"").toLowerCase()===subjectCode.toLowerCase() &&
        String(existing.title||"").toLowerCase()===title.toLowerCase());
      if(duplicate){duplicates++;return;}
      items.push({...item,id:uid(category==="Examination"?"exam":"plan"),title,subjectCode,date,time,category,
        weekday:weekdayForISO(date),done:false,selected:undefined,createdAt:new Date().toISOString()});
      added++;
    });
    savePlannerItems(items.sort((a,b)=>a.date.localeCompare(b.date)||(a.time||"").localeCompare(b.time||"")));
    pendingDocumentItems = [];
    box.innerHTML = "";
    const statusId = pendingDocumentTarget === "library" ? "libraryUploadStatus" : "plannerStatus";
    const status = document.getElementById(statusId);
    if(status) status.textContent = `${added} event${added===1?"":"s"} added to Calendar${duplicates?`; ${duplicates} duplicate${duplicates===1?" was":"s were"} skipped`:""}.`;
    renderDocumentSchedule();
    renderCalendar();
    renderKnowledgeVault();
    toast(`${added} event${added===1?"":"s"} added to Calendar.${duplicates?` ${duplicates} duplicate(s) skipped.`:""}`,"success");
    pendingDocumentTarget="planner";
  }

  function renderDocumentSchedule() {
    const box = document.getElementById("plannerSchedule");
    if (!box) return;
    const items = getPlannerItems().sort((a,b)=>a.date.localeCompare(b.date));
    box.innerHTML = items.length ? items.map(item=>`<div class="planner-saved-item ${item.done?"done":""}"><label><input type="checkbox" ${item.done?"checked":""} onchange="MuseMind.togglePlanItem('${item.id}')"><span><strong>${escapeHTML(item.title)}</strong><small>${new Date(item.date+"T12:00:00").toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"})} · ${escapeHTML(item.source || "Manual")}</small></span></label><button class="mini-btn danger" type="button" onclick="MuseMind.deletePlanItem('${item.id}')">Remove</button></div>`).join("") : `<p class="muted-note">No dates saved yet. Upload a document to build your schedule.</p>`;
  }
  function editPlanItem(id) {
    const items=getPlannerItems();
    const item=items.find(x=>x.id===id);
    if(!item) return;
    const code=window.prompt("Subject code (leave blank if not applicable):",item.subjectCode||"");
    if(code===null) return;
    const title=window.prompt("Event / subject title:",item.title||"");
    if(title===null) return;
    const date=window.prompt("Date (YYYY-MM-DD):",item.date||"");
    if(date===null) return;
    const parsedDate=new Date(date+"T12:00:00");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || localDateKey(parsedDate)!==date) { toast("Enter a valid date as YYYY-MM-DD.","warn"); return; }
    const time=window.prompt("Time (optional, e.g. 10:00):",item.time||"");
    if(time===null) return;
    const updated=items.map(x=>x.id===id?{...x,subjectCode:code.trim().toUpperCase(),title:title.trim()||x.title,date,weekday:weekdayForISO(date),time:time.trim()}:x);
    savePlannerItems(updated); renderDocumentSchedule(); renderCalendar(); renderKnowledgeVault();
    toast("Calendar event updated.","success");
  }
  function togglePlanItem(id) { savePlannerItems(getPlannerItems().map(x=>x.id===id?{...x,done:!x.done}:x)); renderDocumentSchedule(); renderCalendar(); }
  function deletePlanItem(id) { savePlannerItems(getPlannerItems().filter(x=>x.id!==id)); renderDocumentSchedule(); renderCalendar(); }
  function exportPlannerCalendar() {
    const items = getPlannerItems().filter(x=>!x.done);
    if (!items.length) { toast("There are no upcoming schedule items to export.","warn"); return; }
    const stamp = d => d.replace(/[-:]/g,"");
    const events = items.map(item => {
      const start = stamp(item.date);
      const endDate = new Date(item.date+"T12:00:00"); endDate.setDate(endDate.getDate()+1);
      const end = `${endDate.getFullYear()}${String(endDate.getMonth()+1).padStart(2,"0")}${String(endDate.getDate()).padStart(2,"0")}`;
      const safe = String(item.title || "Scheduled item").replace(/\\/g,"\\\\").replace(/,/g,"\\,").replace(/;/g,"\\;").replace(/\n/g,"\n");
      return `BEGIN:VEVENT\r\nUID:${item.id}@musemind\r\nDTSTAMP:${new Date().toISOString().replace(/[-:]/g,"").replace(/\.\d{3}/,"")}Z\r\nDTSTART;VALUE=DATE:${start}\r\nDTEND;VALUE=DATE:${end}\r\nSUMMARY:${safe}\r\nDESCRIPTION:Imported from MuseMind document planner\r\nEND:VEVENT`;
    }).join("\r\n");
    const blob = new Blob([`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//MuseMind//Document Planner//EN\r\n${events}\r\nEND:VCALENDAR`],{type:"text/calendar"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="musemind-schedule.ics";document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(a.href);
    toast("Calendar file exported.","success");
  }

  function getGrowthActions() {
    const user = DataLayer.getCurrentUser();
    return user ? DataLayer.getSetting(user.id, "growthActions", []) : [];
  }

  function saveGrowthActions(actions) {
    const user = DataLayer.getCurrentUser();
    if (user) DataLayer.setSetting(user.id, "growthActions", actions);
  }

  function suggestionForEntry(entry) {
    if (!entry) return "Choose a recent journal entry to see an optional next step.";
    const suggestions = {
      Stressed: "Choose one part of the situation that is within your control. If it helps, write down the very first small step.",
      Anxious: "Separate what you know from what you are unsure about. You can revisit the uncertain part when you have more information.",
      Sad: "Give yourself a little space to name what feels difficult. You do not need to turn this into an action immediately.",
      Angry: "Pause before responding if the situation is still active. You could write what felt unfair or important to you.",
      Happy: "Capture one detail about what made this moment meaningful so you can revisit it later.",
      Excited: "Write down what you are looking forward to and one small way you want to enjoy or prepare for it.",
      Calm: "Notice what seems to be supporting this sense of calm. You may want to remember it for another day.",
      Confident: "Record what helped you feel capable so you can refer back to it when a future challenge feels difficult."
    };
    return suggestions[entry.primaryEmotion] || "Choose one part of this experience you would like to understand better.";
  }

  function renderGrowthStudio() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    const entries = DataLayer.getUserEntries(user.id);
    const latest = entries[0];
    const suggestion = document.getElementById("growthSuggestion");
    if (suggestion) {
      suggestion.innerHTML = latest
        ? `<p class="growth-source">Based on your latest reflection · ${fmtDate(new Date(latest.timestamp))}</p><p class="growth-suggestion-text">${escapeHTML(suggestionForEntry(latest))}</p><button class="mini-btn" type="button" onclick="MuseMind.addSuggestedAction()">Add this to my action list</button><p class="tiny-note">Optional suggestion. You can ignore or change it.</p>`
        : `<p class="muted-note">Write a reflection first. Suggestions are based on your own latest entry.</p>`;
    }
    const list = document.getElementById("growthActionList");
    const actions = getGrowthActions();
    if (list) list.innerHTML = actions.length
      ? actions.map(a => `<div class="growth-action ${a.done ? "done" : ""}"><label><input type="checkbox" ${a.done ? "checked" : ""} onchange="MuseMind.toggleGrowthAction('${a.id}')"><span>${escapeHTML(a.text)}</span></label><button class="mini-btn danger" type="button" onclick="MuseMind.deleteGrowthAction('${a.id}')">Remove</button></div>`).join("")
      : `<p class="muted-note">Your action list is empty. Add a small step only if it feels useful.</p>`;
    renderWeeklyReflection(entries);
    renderDocumentSchedule();
  }

  function addGrowthAction(text) {
    const input = document.getElementById("growthActionInput");
    const value = String(text || input?.value || "").trim();
    if (!value) { toast("Add a short action first.", "warn"); input?.focus(); return; }
    const actions = getGrowthActions();
    actions.unshift({ id: uid("action"), text: value, done: false, createdAt: new Date().toISOString() });
    saveGrowthActions(actions.slice(0, 30));
    if (input && !text) input.value = "";
    renderGrowthStudio();
    toast("Added to your personal action list.", "success");
  }

  function addSuggestedAction() {
    const user = DataLayer.getCurrentUser();
    const latest = user ? DataLayer.getUserEntries(user.id)[0] : null;
    if (latest) addGrowthAction(suggestionForEntry(latest));
  }

  function toggleGrowthAction(id) {
    const actions = getGrowthActions().map(a => a.id === id ? {...a, done: !a.done, completedAt: !a.done ? new Date().toISOString() : null} : a);
    saveGrowthActions(actions);
    renderGrowthStudio();
  }

  function deleteGrowthAction(id) {
    saveGrowthActions(getGrowthActions().filter(a => a.id !== id));
    renderGrowthStudio();
  }

  function renderWeeklyReflection(entries) {
    const box = document.getElementById("weeklyReflection");
    if (!box) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const week = entries.filter(e => new Date(e.timestamp).getTime() >= cutoff);
    if (week.length < 3) {
      box.innerHTML = `<p class="muted-note">Add at least three reflections in a seven-day period to see a useful weekly summary. You never need to journal daily.</p>`;
      return;
    }
    const counts = {};
    const contexts = {};
    week.forEach(e => {
      counts[e.primaryEmotion] = (counts[e.primaryEmotion] || 0) + 1;
      (e.triggers || []).forEach(t => contexts[t] = (contexts[t] || 0) + 1);
    });
    const topEmotion = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    const topContext = Object.entries(contexts).sort((a,b)=>b[1]-a[1])[0];
    box.innerHTML = `<div class="weekly-stats"><div><strong>${week.length}</strong><span>reflections this week</span></div><div><strong>${escapeHTML(topEmotion?.[0] || "—")}</strong><span>most frequent primary signal</span></div><div><strong>${escapeHTML(topContext?.[0] || "—")}</strong><span>most mentioned context</span></div></div><p class="tiny-note">This is a summary of what you recorded, not a clinical assessment or explanation of causes.</p>`;
  }

  let voiceFinalTranscript = "";

  function updateTranscriptCount() {
    const text = document.getElementById("voiceTranscript")?.value || "";
    const count = text.trim() ? text.trim().split(/\s+/).length : 0;
    const label = document.getElementById("transcriptCount");
    if (label) label.textContent = `${count} word${count === 1 ? "" : "s"}`;
  }

  function setVoiceStatus(label, active = false) {
    const status = document.getElementById("voiceStatus");
    const hint = document.getElementById("transcriptHint");
    const button = document.getElementById("voiceInputBtn");
    if (status) { status.classList.toggle("recording", active); status.innerHTML = `<i></i> ${escapeHTML(label)}`; }
    if (hint) hint.textContent = active ? "Listening — speak naturally" : "Your words will appear here";
    if (button) { button.classList.toggle("recording", active); button.innerHTML = active ? "■ Stop listening" : "<span>●</span> Start speaking"; }
  }

  function toggleVoiceInput() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast("Speech recognition is not available in this browser. Try Chrome or use your device's keyboard dictation.", "warn");
      setVoiceStatus("Not supported");
      return;
    }
    if (speechRecognition) { speechRecognition.stop(); return; }
    voiceFinalTranscript = document.getElementById("voiceTranscript")?.value || "";
    speechRecognition = new SpeechRecognition();
    speechRecognition.lang = document.getElementById("voiceLanguage")?.value || "en-IN";
    speechRecognition.interimResults = true;
    speechRecognition.continuous = true;
    speechRecognition.onstart = () => setVoiceStatus("Listening", true);
    speechRecognition.onresult = event => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const phrase = event.results[i][0].transcript;
        if (event.results[i].isFinal) voiceFinalTranscript += (voiceFinalTranscript.trim() ? " " : "") + phrase.trim();
        else interim += phrase;
      }
      const box = document.getElementById("voiceTranscript");
      if (box) box.value = [voiceFinalTranscript.trim(), interim.trim()].filter(Boolean).join(" ");
      updateTranscriptCount();
    };
    speechRecognition.onerror = event => {
      setVoiceStatus(event.error === "not-allowed" ? "Microphone permission denied" : "Could not hear speech");
      toast(event.error === "not-allowed" ? "Allow microphone access to use voice journaling." : "Voice capture stopped. You can edit the transcript and continue.", "warn");
    };
    speechRecognition.onend = () => {
      speechRecognition = null;
      const box = document.getElementById("voiceTranscript");
      if (box) { voiceFinalTranscript = box.value.trim(); updateTranscriptCount(); }
      setVoiceStatus("Transcript ready");
    };
    try { speechRecognition.start(); }
    catch (_) { speechRecognition = null; setVoiceStatus("Ready"); toast("Voice input could not start. Please try again.", "warn"); }
  }

  function appendVoiceTranscript() {
    const transcript = document.getElementById("voiceTranscript")?.value.trim();
    const journal = document.getElementById("entry");
    if (!transcript) { toast("Speak first or type into the transcript box.", "warn"); return; }
    if (journal) {
      journal.value = `${journal.value.trim()}${journal.value.trim() ? "\n\n" : ""}${transcript}`.slice(0, 3000);
      updateCounter();
      journal.dispatchEvent(new Event("input", { bubbles: true }));
      toast("Transcript added to your journal. You can edit it before analyzing.", "success");
    }
  }

  function clearVoiceTranscript() {
    const box = document.getElementById("voiceTranscript");
    if (box) box.value = "";
    voiceFinalTranscript = "";
    updateTranscriptCount();
    setVoiceStatus("Ready");
  }


  function renderAll() {
    if (activeSection === "overview") renderOverview();
    else renderOverview(); // keep stats fresh in the sidebar regardless of view
    if (activeSection === "history") renderHistory();
    if (activeSection === "timeline") renderTimelineChart();
    if (activeSection === "insights") renderInsights();
    if (activeSection === "calendar") renderCalendar();
    if (activeSection === "profile") renderProfile();
    if (activeSection === "memory") renderMemoryMirror();
    if (activeSection === "growth") renderGrowthStudio();
  }

  /* ===================================================================
     17. INIT
     =================================================================== */

  window.addEventListener("DOMContentLoaded", () => {
    // Browser Back/Forward restores the previous MuseMind section.
    window.addEventListener("popstate", (event) => {
      const target = event.state?.musemindSection || location.hash.replace(/^#/, "");
      if (target && document.getElementById("view-" + target)) {
        goToSection(target, { fromHistory: true });
      }
    });

    // Touch users can swipe between the five primary pages.
    const primarySections = ["overview", "journal", "history", "insights", "calendar", "knowledge"];
    const swipeSurface = document.querySelector(".main-area");
    let touchStartX = 0, touchStartY = 0;
    if (swipeSurface) {
      swipeSurface.addEventListener("touchstart", (event) => {
        if (event.touches.length !== 1) return;
        touchStartX = event.touches[0].clientX;
        touchStartY = event.touches[0].clientY;
      }, { passive: true });
      swipeSurface.addEventListener("touchend", (event) => {
        if (!touchStartX && !touchStartY) return;
        const dx = event.changedTouches[0].clientX - touchStartX;
        const dy = event.changedTouches[0].clientY - touchStartY;
        touchStartX = touchStartY = 0;
        if (Math.abs(dx) < 85 || Math.abs(dx) < Math.abs(dy) * 1.35) return;
        if (event.target.closest("input, textarea, select, button, a, [contenteditable='true']")) return;
        const current = primarySections.indexOf(activeSection);
        if (current < 0) return;
        const next = dx < 0 ? current + 1 : current - 1;
        if (next >= 0 && next < primarySections.length) goToSection(primarySections[next]);
      }, { passive: true });
    }

    // Bind navigation only to elements that actually exist.
    // This keeps the static GitHub Pages build from failing if an optional
    // mobile control is not present.
    document.querySelectorAll(".nav-link").forEach((btn) => {
      btn.addEventListener("click", () => goToSection(btn.dataset.section));
    });
    const dropZone = document.getElementById("documentDropZone");
    if (dropZone) {
      ["dragenter", "dragover"].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.add("drag-over"); }));
      ["dragleave", "drop"].forEach(type => dropZone.addEventListener(type, event => { event.preventDefault(); dropZone.classList.remove("drag-over"); }));
      dropZone.addEventListener("drop", event => { const file = event.dataTransfer?.files?.[0]; if (file) extractDocumentDates(file); });
    }
    const libraryDropZone = document.getElementById("libraryUploadZone");
    if (libraryDropZone) {
      ["dragenter","dragover"].forEach(type=>libraryDropZone.addEventListener(type,event=>{event.preventDefault();libraryDropZone.classList.add("drag-over");}));
      ["dragleave","drop"].forEach(type=>libraryDropZone.addEventListener(type,event=>{event.preventDefault();libraryDropZone.classList.remove("drag-over");}));
      libraryDropZone.addEventListener("drop",event=>{const file=event.dataTransfer?.files?.[0];if(file)uploadLibraryDocument(file);});
    }

    const hamburger = document.getElementById("hamburger");
    const mobileNav = document.getElementById("mobileNav");
    if (hamburger && mobileNav) {
      hamburger.addEventListener("click", () => mobileNav.classList.toggle("open"));
    }

    setupPremiumUX();
    const transcriptBox = document.getElementById("voiceTranscript");
    if (transcriptBox) transcriptBox.addEventListener("input", updateTranscriptCount);
    setupSelectionAnalyzer();

    // Always show the welcome screen on reload so the profile choice is visible.
    // The previous local session remains available through “I have a profile”.
    DataLayer.clearSession();
    initializeEntryContext();
    setLoginMode("create");
  });


  /* ================= MUSEMIND 2.0 PREMIUM UX ================= */
  function setupPremiumUX(){
    setupTheme();
    setupLiveClock();
    setupKeyboardShortcuts();
    setupAutosave();
    updateDashboardInsight();
  }

  function setupTheme(){
    const saved=DataLayer.getSetting("global","theme","dark");
    applyTheme(saved);

    // Use one delegated handler for both desktop and mobile theme buttons.
    // Inline onclick is also supported through the public MuseMind API.
    document.querySelectorAll(".theme-toggle").forEach((button) => {
      button.addEventListener("click", toggleTheme);
    });
  }
  function applyTheme(theme){
    const safeTheme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme=safeTheme;
    DataLayer.setSetting("global","theme",safeTheme);
    document.querySelectorAll(".theme-toggle").forEach(btn=>{
      const icon=btn.querySelector(".theme-icon") || btn.querySelector("span") || btn;
      if(icon && icon !== btn) icon.textContent=safeTheme==="dark"?"☾":"☀";
      btn.setAttribute("aria-label",safeTheme==="dark"?"Switch to light theme":"Switch to dark theme");
    });
  }
  function toggleTheme(){
    const current=document.documentElement.dataset.theme || "dark";
    const next=current==="light"?"dark":"light";
    applyTheme(next);
    toast(next==="light"?"Light theme enabled.":"Dark theme enabled.","success");
  }
  function setupLiveClock(){
    const tick=()=>{
      const now = new Date();
      const clock=document.getElementById("liveClock");
      const date=document.getElementById("todayDate");
      const time=document.getElementById("todayTime");
      if(clock) clock.textContent=fmtClock(now);
      if(date) date.textContent=fmtDate(now);
      if(time) time.textContent=now.toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    };
    tick();
    setInterval(tick,1000);
  }
  function setupKeyboardShortcuts(){
    document.addEventListener("keydown",e=>{
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){
        e.preventDefault(); goToSection("journal");
        setTimeout(()=>document.getElementById("entry")?.focus(),150);
      }
      if(e.key==="Escape"){closeEntryModal();cancelDelete();closeClearDataModal();}
    });
  }
  function setupAutosave(){
    const textarea=document.getElementById("entry");
    if(!textarea)return;
    const user=DataLayer.getCurrentUser();
    if(user){
      const draft=DataLayer.getSetting(user.id,"journalDraft","");
      if(draft){textarea.value=draft;updateCounter();}
    }
    let timer;
    textarea.addEventListener("input",()=>{
      clearTimeout(timer);
      const current=DataLayer.getCurrentUser(); if(!current)return;
      timer=setTimeout(()=>{
        DataLayer.setSetting(current.id,"journalDraft",textarea.value);
        const status=document.querySelector(".editor-bottom span:last-child");
        if(status)status.textContent=textarea.value.trim()?"✓ Draft saved locally":"Stored only in this browser.";
      },450);
    });
  }
  function clearDraft(){
    const user=DataLayer.getCurrentUser();
    if(user)DataLayer.setSetting(user.id,"journalDraft","");
  }
  function updateDashboardInsight(){
    const user=DataLayer.getCurrentUser(); if(!user)return;
    const entries=DataLayer.getUserEntries(user.id);
    const title=document.getElementById("dashboardHeadline");
    const sub=document.getElementById("dashboardSubline");
    const it=document.getElementById("overviewInsightTitle");
    const ix=document.getElementById("overviewInsightText");
    if(!title||!it)return;
    if(!entries.length){
      title.textContent="Your emotional space is ready.";
      sub.textContent="Write, speak or save something you want to remember. No pressure to do it every day.";
      it.textContent="Start with one honest sentence.";
      ix.textContent="Your first entry gives MuseMind the starting point for your emotional journey.";
      return;
    }
    const latest=entries[0], reflectionDays=new Set(entries.map(e=>e.date || localDateKey(new Date(e.timestamp)))).size;
    title.textContent=`You have written ${entries.length} ${entries.length===1?"entry":"entries"} so far.`;
    sub.textContent=`Your latest signal is ${emotionMeta(latest.primaryEmotion).emoji} ${normalizeEmotionName(latest.primaryEmotion)}. Keep noticing, not judging.`;
    it.textContent=`You have reflected on ${reflectionDays} ${reflectionDays===1?"day":"different days"}.`;
    ix.textContent=`Your latest recorded signal is ${emotionMeta(latest.primaryEmotion).emoji} ${normalizeEmotionName(latest.primaryEmotion)}. Reflection is optional — return whenever it is useful.`;

  }
  const _originalAnalyzeEmotion=analyzeEmotion;
  analyzeEmotion=function(){
    const textarea=document.getElementById("entry");
    if(!textarea||!textarea.value.trim()){toast("Write something before analyzing.","warn");textarea?.focus();return;}
    clearDraft(); _originalAnalyzeEmotion();
  };
  const _originalSaveProfile=saveProfile;
  saveProfile=function(){_originalSaveProfile();updateDashboardInsight();};
  const _originalRenderOverview=renderOverview;
  renderOverview=function(){_originalRenderOverview();updateDashboardInsight();};


  // Warm up the public model in the background after the app is visible.
  // This keeps the first journal analysis smoother while preserving fallback behavior.
  setTimeout(() => {
    EmotionEngine.loadModel().catch(() => {});
  }, 900);

  let selectedPageText = "";

  function analyzePageSelection() {
    const text = selectedPageText.trim();
    if (!text) { toast("Select some text first.", "warn"); return; }
    const box = document.getElementById("analysisInput");
    if (box) box.value = text;
    const status = document.getElementById("analysisSelectionStatus");
    if (status) status.textContent = "Selected text copied from the page. It will be analyzed without creating a duplicate history entry.";
    hideSelectionAnalyzer();
    analyzeAndSaveText(text, { save: false, sourceLabel: "page selection" });
  }

  function hideSelectionAnalyzer() {
    const bar = document.getElementById("selectionAnalyzer");
    if (bar) bar.classList.remove("show");
  }

  function setupSelectionAnalyzer() {
    document.addEventListener("selectionchange", () => {
      const selection = window.getSelection();
      const text = selection ? selection.toString().trim() : "";
      const anchor = selection?.anchorNode?.parentElement;
      if (!text || !anchor || !document.body.contains(anchor)) { hideSelectionAnalyzer(); return; }
      if (anchor.closest("textarea, input, button, select")) { hideSelectionAnalyzer(); return; }
      selectedPageText = text.length > 3000 ? text.slice(0, 3000) : text;
      const bar = document.getElementById("selectionAnalyzer");
      if (bar) bar.classList.add("show");
    });
  }

  /* ===================================================================
     18. PUBLIC API (bound to window for inline onclick handlers)
     =================================================================== */

  window.MuseMind = {
    login: handleLogin,
    setLoginMode,
    logout: handleLogout,
    goToSection,
    updateCounter,
    quickMood,
    analyzeEmotion,
    setHistoryQuery,
    setHistoryEmotion,
    setHistorySort,
    viewEntry,
    analyzeSelectedText,
    useJournalSelection,
    analyzeHistoryEntry,
    analyzePageSelection,
    showMappingLogic,
    exportCurrentAnalysis,
    closeEntryModal,
    confirmDelete,
    cancelDelete,
    performDelete,
    setTimelineRange,
    shiftCalendar,
    showCalendarDay,
    addCalendarEvent,
    saveProfile,
    openClearDataModal,
    closeClearDataModal,
    performClearData,
    exportData,
    loadDemoData,
    clearDemoData,
    toggleTheme,
    applyTheme,
    rateInterpretation,
    saveEmotionCorrection,
    searchMemories,
    setMemoryQuery,
    renderKnowledgeVault,
    filterKnowledgeTasks,
    searchKnowledge,
    setKnowledgeQuery,
    addGrowthAction,
    addSuggestedAction,
    toggleGrowthAction,
    deleteGrowthAction,
    toggleVoiceInput,
    appendVoiceTranscript,
    clearVoiceTranscript,
    extractDocumentDates, saveExtractedPlanItems, cancelExtractedPlanItems, togglePlanItem, editPlanItem, deletePlanItem, exportPlannerCalendar,
    uploadLibraryDocument, openLibraryFile, editLibraryDocument, deleteLibraryDocument, goToToday,
    confirmJournalEvents, dismissJournalEventReview,
  };
})();
