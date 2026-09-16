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
    return EmotionEngine.analyze(originalText, language);
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

  function handleLogin() {
    const name = document.getElementById("name").value.trim();
    const age = document.getElementById("age").value.trim();
    const gender = document.getElementById("gender").value;

    if (!name || !age || !gender) {
      toast("Please complete your profile first.", "warn");
      return;
    }

    // Reuse an existing profile with the same name (simple local "login"),
    // otherwise create a new user id. This is what keeps User A and
    // User B's journal entries from mixing on a shared browser.
    const existing = DataLayer.getUsers().find(
      (u) => u.name.toLowerCase() === name.toLowerCase()
    );
    const user = existing || { id: uid("user"), name, age, gender, createdAt: new Date().toISOString() };
    user.age = age;
    user.gender = gender;
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

  function enterApp(user) {
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("app").style.display = "flex";
    document.getElementById("navUserName").textContent = user.name;
    document.getElementById("navUserMeta").textContent = `${user.age} • ${user.gender}`;
    document.getElementById("navAvatar").textContent = user.name.charAt(0).toUpperCase();
    goToSection("overview");
    renderAll();
  }

  /* ===================================================================
     5. NAVIGATION
     =================================================================== */

  function goToSection(section) {
    activeSection = section;
    document.querySelectorAll(".nav-link").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.section === section);
    });
    document.querySelectorAll(".view").forEach((view) => {
      view.classList.toggle("active", view.id === "view-" + section);
    });
    const mobileNav = document.getElementById("mobileNav");
    if (mobileNav) mobileNav.classList.remove("open");
    if (section === "timeline") renderTimelineChart();
    if (section === "calendar") renderCalendar();
    if (section === "insights") renderInsights();
    if (section === "history") renderHistory();
    if (section === "profile") renderProfile();
    if (section === "overview") renderOverview();
    if (section === "dataset") renderDatasetPage();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }


  function renderDatasetPage() {
    const box = document.getElementById("goEmotionLabels");
    if (box) box.innerHTML = GO_EMOTIONS.map(label => `<span>${escapeHTML(label)}</span>`).join("");
  }

  /* ===================================================================
     6. NEW JOURNAL / ANALYSIS
     =================================================================== */

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

  async function analyzeAndSaveText(text, options = {}) {
    const user = DataLayer.getCurrentUser();
    if (!user || !text) return null;

    const btn = document.getElementById("analyzeBtn");
    if (btn) { btn.classList.add("loading"); btn.disabled = true; }
    const status = document.getElementById("engineStatus");
    if (status) status.textContent = "Analyzing emotional signals…";

    try {
      const result = await analyzeText(text);
      const now = new Date();
      const recent = DataLayer.getUserEntries(user.id).slice(0, 10);
      const entry = {
        id: options.save === false ? uid("analysis") : uid("entry"), userId: user.id, text,
        date: localDateKey(now), time: fmtTime(now), timestamp: now.toISOString(),
        primaryEmotion: result.primary, secondaryEmotion: result.secondary,
        primaryPercentage: result.primaryPercent, secondaryPercentage: result.secondaryPercent,
        scores: result.scores, goEmotions: result.goEmotions || [], goEmotionScores: result.goEmotionScores || [],
        primaryGoLabel: result.primaryGoLabel || null, secondaryGoLabel: result.secondaryGoLabel || null,
        primaryGoConfidence: result.primaryGoConfidence || 0, secondaryGoConfidence: result.secondaryGoConfidence || 0,
        mixed: result.mixed, triggers: result.triggers, language: result.language,
        emojiDetected: result.emojiDetected, moodScore: result.moodScore,
        characterCount: text.length, wordCount: text.split(/\s+/).filter(Boolean).length,
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
      }
      goToSection("analysis");
      const statusBox = document.getElementById("analysisSelectionStatus");
      if (statusBox) statusBox.textContent = `Analyzed ${entry.wordCount} words from ${options.sourceLabel || "selected text"}${options.save === false ? " · not added to history" : " · saved to history"}.`;
      toast(entry.analysisSource === "GoEmotions Model" ? "Emotion analysis complete." : "Analysis complete using fallback mode.", entry.analysisSource === "GoEmotions Model" ? "success" : "warn");
      if (options.save !== false) renderAll();
      return entry;
    } catch (error) {
      console.error(error);
      toast("Analysis failed. Please try again.", "warn");
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
    const safePrimary = EMOTIONS[entry.primaryEmotion] ? entry.primaryEmotion : "Calm";
    const safeSecondary = EMOTIONS[entry.secondaryEmotion] ? entry.secondaryEmotion : safePrimary;
    const primaryPct = Number(entry.primaryPercentage) || 0;
    const secondaryPct = Number(entry.secondaryPercentage) || 0;
    const goScores = Array.isArray(entry.goEmotionScores) && entry.goEmotionScores.length
      ? entry.goEmotionScores
      : (entry.goEmotions || []);

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
    box.innerHTML = seen === 0 ? `<strong>${EMOTIONS[entry.primaryEmotion].emoji} ${entry.primaryEmotion}</strong><p>This primary category has not appeared in your last ${usable.length} entries.</p>` : `<strong>${seen}/${usable.length}</strong><p>Your recent entries show ${entry.primaryEmotion} ${seen} time${seen===1?"":"s"}.</p>`;
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
        <div class="mood-state"><span>PREVIOUS</span><strong>${EMOTIONS[previous.primaryEmotion].emoji} ${previous.primaryEmotion}</strong></div>
        <div class="mirror-arrow">→</div>
        <div class="mood-state"><span>CURRENT</span><strong>${EMOTIONS[current.primaryEmotion].emoji} ${current.primaryEmotion}</strong></div>
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
    const dom = dominantEmotion(entries);
    const avg = averageMoodScore(entries);

    document.getElementById("welcomeHeading").textContent = `Welcome back, ${user.name.split(" ")[0]} 👋`;
    document.getElementById("todayDate").textContent = fmtDate(new Date());

    animateCount(document.getElementById("statEntries"), entries.length);
    document.getElementById("statDominant").textContent = dom ? `${EMOTIONS[dom].emoji} ${dom}` : "—";
    document.getElementById("statStreak").textContent = `${streaks.current} day${streaks.current === 1 ? "" : "s"}`;
    document.getElementById("statMood").textContent = avg !== null ? avg + "/100" : "—";

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
    return `<div class="entry-card" data-id="${entry.id}">
      <div class="entry-card-top">
        <span class="entry-emotion">${EMOTIONS[entry.primaryEmotion].emoji} ${entry.primaryEmotion} ${entry.primaryPercentage}%</span>
        <span class="entry-date">${fmtDate(d)} • ${entry.time}</span>
      </div>
      <p class="entry-text">${escapeHTML(entry.text.length > 220 ? entry.text.slice(0, 220) + "…" : entry.text)}</p>
      <div class="entry-card-bottom">
        <span class="entry-secondary">Secondary: ${EMOTIONS[entry.secondaryEmotion].emoji} ${entry.secondaryEmotion}</span>
        ${entry.triggers.length ? `<span class="entry-triggers">Triggers: ${entry.triggers.join(", ")}</span>` : ""}
        <span class="entry-score">Mood ${entry.moodScore}/100</span>
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
      <div class="modal-tags">
        <span class="chip">${EMOTIONS[entry.primaryEmotion].emoji} ${entry.primaryEmotion} ${entry.primaryPercentage}%</span>
        <span class="chip">${EMOTIONS[entry.secondaryEmotion].emoji} ${entry.secondaryEmotion} ${entry.secondaryPercentage}%</span>
        ${entry.triggers.map((t) => `<span class="chip chip-muted">🔎 ${t}</span>`).join("")}
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

    const canvas = document.getElementById("timelineChart");
    const list = document.getElementById("timelineList");

    if (!entries.length) {
      if (charts.timeline) { charts.timeline.destroy(); charts.timeline = null; }
      list.innerHTML = emptyState("🌱", "No entries yet in this range", "Journal a little more to see your timeline.");
      return;
    }

    list.innerHTML = entries
      .slice(-8)
      .reverse()
      .map((e) => `<div class="timeline-row">
        <span class="timeline-date">${new Date(e.timestamp).toLocaleDateString("en-IN", { month: "short", day: "numeric" })}</span>
        <span class="timeline-emotion">${EMOTIONS[e.primaryEmotion].emoji} ${e.primaryEmotion}</span>
        <span class="timeline-score">${e.moodScore}/100</span>
      </div>`)
      .join("");

    const labels = entries.map((e) => new Date(e.timestamp).toLocaleDateString("en-IN", { month: "short", day: "numeric" }));
    const scores = entries.map((e) => e.moodScore);

    if (charts.timeline) charts.timeline.destroy();
    charts.timeline = new Chart(canvas, {
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
    entries.forEach((e) => counts[e.primaryEmotion]++);

    if (charts.distribution) charts.distribution.destroy();
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

    const list = document.getElementById("distributionList");
    if (list) {
      const total = entries.length || 1;
      list.innerHTML = Object.keys(EMOTIONS)
        .map((e) => {
          const pct = Math.round((counts[e] / total) * 100);
          return `<div class="emotion-row"><div><span>${EMOTIONS[e].emoji}</span><strong>${e}</strong></div><small>${pct}%</small></div>`;
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
    if (text && sorted.length) {
      const total = entries.filter(e => (e.goEmotions || []).length).length || 1;
      const standardLine = `<div class="standard-insight-strip"><b>Standard NLP:</b> ${sorted.map(([k,v]) => `${escapeHTML(k)} (${Math.round(v/total*100)}%)`).join(" · ")}</div>`;
      text.insertAdjacentHTML("afterbegin", standardLine);
    }
  }

  function renderInsights() {
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
    entries.forEach((e) => counts[e.primaryEmotion]++);
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
      else if (EMOTIONS[e.primaryEmotion].tone === "positive") positive++;
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
    entries.forEach((e) => e.triggers.forEach((t) => (triggerCounts[t] = (triggerCounts[t] || 0) + 1)));
    const topTrigger = Object.entries(triggerCounts).sort((a, b) => b[1] - a[1])[0];
    if (topTrigger) {
      const [triggerName] = topTrigger;
      const withTrigger = entries.filter((e) => e.triggers.includes(triggerName));
      const stressedShare = Math.round(
        (withTrigger.filter((e) => e.primaryEmotion === "Stressed" || e.primaryEmotion === "Anxious").length / withTrigger.length) * 100
      );
      if (stressedShare >= 40) {
        insights.push(`${triggerName} situations appear frequently in your stressful entries (${stressedShare}% of ${triggerName.toLowerCase()}-related entries).`);
      } else {
        insights.push(`${triggerName} is your most frequently mentioned context, appearing in ${withTrigger.length} entries.`);
      }
    }

    const recent = entries.slice(0, 5);
    if (recent.length >= 3) {
      const shiftsToPositive = recent.slice(0, -1).filter((e, i) => {
        const next = recent[i + 1];
        return EMOTIONS[next.primaryEmotion].tone !== "positive" && EMOTIONS[e.primaryEmotion].tone === "positive";
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

  /* ===================================================================
     12. MOOD CALENDAR
     =================================================================== */

  function shiftCalendar(delta) {
    calendarCursor.setMonth(calendarCursor.getMonth() + delta);
    renderCalendar();
  }

  function renderCalendar() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    const entries = DataLayer.getUserEntries(user.id);

    const year = calendarCursor.getFullYear();
    const month = calendarCursor.getMonth();
    document.getElementById("calendarLabel").textContent = calendarCursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

    const byDay = {};
    entries.forEach((e) => {
      byDay[e.date] = byDay[e.date] || [];
      byDay[e.date].push(e);
    });

    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay() + 6) % 7; // make Monday = 0
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    let cells = "";
    for (let i = 0; i < startOffset; i++) cells += `<div class="cal-cell empty"></div>`;

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dayEntries = byDay[dateStr];
      const isToday = dateStr === localDateKey(new Date());
      if (dayEntries && dayEntries.length) {
        const dom = dominantEmotion(dayEntries);
        cells += `<button class="cal-cell has-entry ${isToday ? "today" : ""}" onclick="MuseMind.showCalendarDay('${dateStr}')">
          <span class="cal-day">${d}</span>
          <span class="cal-emoji">${EMOTIONS[dom].emoji}</span>
          ${dayEntries.length > 1 ? `<span class="cal-count">${dayEntries.length}</span>` : ""}
        </button>`;
      } else {
        cells += `<div class="cal-cell ${isToday ? "today" : ""}"><span class="cal-day">${d}</span></div>`;
      }
    }

    document.getElementById("calendarGrid").innerHTML = cells;
    document.getElementById("calendarDayDetail").innerHTML = `<p class="muted-note">Select a highlighted date to see that day's entries.</p>`;
  }

  function showCalendarDay(dateStr) {
    const user = DataLayer.getCurrentUser();
    const entries = DataLayer.getUserEntries(user.id).filter((e) => e.date === dateStr);
    if (!entries.length) return;
    const dom = dominantEmotion(entries);
    const avg = averageMoodScore(entries);
    const d = new Date(dateStr + "T00:00:00");
    document.getElementById("calendarDayDetail").innerHTML = `
      <div class="cal-detail-head">
        <h4>${fmtDate(d)}</h4>
        <span>${entries.length} ${entries.length === 1 ? "entry" : "entries"} • Dominant ${EMOTIONS[dom].emoji} ${dom} • Avg mood ${avg}/100</span>
      </div>
      ${entries.map(entryCardHTML).join("")}
    `;
  }

  /* ===================================================================
     13. PROFILE
     =================================================================== */

  function renderProfile() {
    const user = DataLayer.getCurrentUser();
    if (!user) return;
    const entries = DataLayer.getUserEntries(user.id);
    const streaks = computeStreaks(entries);
    const dom = dominantEmotion(entries);
    const avg = averageMoodScore(entries);

    document.getElementById("profileName").value = user.name;
    document.getElementById("profileAge").value = user.age;
    document.getElementById("profileGender").value = user.gender;

    document.getElementById("profileEntries").textContent = entries.length;
    document.getElementById("profileStreak").textContent = `${streaks.current} days`;
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
    document.getElementById("navUserMeta").textContent = `${user.age} • ${user.gender}`;
    toast("Profile updated.", "success");
  }

  function openClearDataModal() { document.getElementById("clearDataModal").classList.add("open"); }
  function closeClearDataModal() { document.getElementById("clearDataModal").classList.remove("open"); }
  function performClearData() {
    const user = DataLayer.getCurrentUser();
    if (user) DataLayer.clearUserEntries(user.id);
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
      const headers = ["Date", "Time", "Text", "PrimaryEmotion", "SecondaryEmotion", "PrimaryPct", "SecondaryPct", "Triggers", "MoodScore", "Reflection"];
      const rows = entries.map((e) => [
        e.date, e.time, csvSafe(e.text), e.primaryEmotion, e.secondaryEmotion,
        e.primaryPercentage, e.secondaryPercentage, e.triggers.join("|"), e.moodScore, csvSafe(e.reflection || ""),
      ]);
      content = [headers, ...rows].map((r) => r.join(",")).join("\n");
      mime = "text/csv";
      filename = "musemind_journal.csv";
    } else {
      content = entries
        .map((e) =>
          `${fmtDate(new Date(e.timestamp))} • ${e.time}\n` +
          `${EMOTIONS[e.primaryEmotion].emoji} ${e.primaryEmotion} ${e.primaryPercentage}% / ${EMOTIONS[e.secondaryEmotion].emoji} ${e.secondaryEmotion} ${e.secondaryPercentage}%\n` +
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

  function renderAll() {
    if (activeSection === "overview") renderOverview();
    else renderOverview(); // keep stats fresh in the sidebar regardless of view
    if (activeSection === "history") renderHistory();
    if (activeSection === "timeline") renderTimelineChart();
    if (activeSection === "insights") renderInsights();
    if (activeSection === "calendar") renderCalendar();
    if (activeSection === "profile") renderProfile();
  }

  /* ===================================================================
     17. INIT
     =================================================================== */

  window.addEventListener("DOMContentLoaded", () => {
    // Bind navigation only to elements that actually exist.
    // This keeps the static GitHub Pages build from failing if an optional
    // mobile control is not present.
    document.querySelectorAll(".nav-link").forEach((btn) => {
      btn.addEventListener("click", () => goToSection(btn.dataset.section));
    });

    const hamburger = document.getElementById("hamburger");
    const mobileNav = document.getElementById("mobileNav");
    if (hamburger && mobileNav) {
      hamburger.addEventListener("click", () => mobileNav.classList.toggle("open"));
    }

    setupPremiumUX();
    setupSelectionAnalyzer();

    // Restore the current session after all core handlers are ready.
    const user = DataLayer.getCurrentUser();
    if (user) enterApp(user);
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
      sub.textContent="Write freely and let your journal become a map of your patterns.";
      it.textContent="Start with one honest sentence.";
      ix.textContent="Your first entry gives MuseMind the starting point for your emotional journey.";
      return;
    }
    const latest=entries[0], streak=computeStreaks(entries).current;
    title.textContent=`You have written ${entries.length} ${entries.length===1?"entry":"entries"} so far.`;
    sub.textContent=`Your latest signal is ${EMOTIONS[latest.primaryEmotion].emoji} ${latest.primaryEmotion}. Keep noticing, not judging.`;
    if(streak>=3){
      it.textContent=`${streak}-day journaling streak 🔥`;
      ix.textContent="Consistency is helping MuseMind build a clearer picture of your emotional patterns.";
    }else{
      it.textContent=`Latest signal: ${EMOTIONS[latest.primaryEmotion].emoji} ${latest.primaryEmotion}`;
      ix.textContent=`Mood score ${latest.moodScore}/100 · ${latest.language} · ${latest.wordCount} words.`;
    }
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
    saveProfile,
    openClearDataModal,
    closeClearDataModal,
    performClearData,
    exportData,
    loadDemoData,
    clearDemoData,
    toggleTheme,
    applyTheme,
  };
})();
