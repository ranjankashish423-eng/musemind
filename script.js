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

  let charts = { distribution: null, timeline: null };
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
          modelVersion: "Fallback",
          analysisSource: "Rule-Based Fallback",
          goEmotions: []
        });
      }

      try {
        const classifier = await this.loadModel();
        const output = await classifier(text, { top_k: null });
        const raw = Array.isArray(output) && Array.isArray(output[0]) ? output[0] : output;
        const goResults = raw
          .filter((x) => x && x.label)
          .map((x) => ({ label: String(x.label).toLowerCase(), confidence: Number(x.score) }))
          .sort((a,b) => b.confidence - a.confidence);

        const meaningful = goResults.filter((x) => x.label !== "neutral" && x.confidence >= 0.20);
        const selected = (meaningful.length ? meaningful : goResults).slice(0, 6);
        const categoryScores = this.mapScores(selected);
        const sortedCategories = Object.entries(categoryScores).sort((a,b) => b[1]-a[1]);
        const primary = sortedCategories[0][0];
        const secondary = sortedCategories.find(([name, score]) => name !== primary && score > 0.18)?.[0] || primary;
        const primaryPercent = Math.round((categoryScores[primary] || 0) * 100);
        const secondaryPercent = secondary === primary ? 0 : Math.round((categoryScores[secondary] || 0) * 100);
        const mixed = selected.filter((x) => x.label !== "neutral" && x.confidence >= 0.35).length >= 2;
        const lowerText = text.toLowerCase();
        const triggers = detectTriggers(lowerText);
        const emojiDetected = EMOJI_RANGE.test(text);
        const moodScore = Math.round(
          (MOOD_SCORE_MAP[primary] * Math.max(primaryPercent, 1) +
           MOOD_SCORE_MAP[secondary] * Math.max(secondaryPercent, 0)) /
          Math.max(primaryPercent + secondaryPercent, 1)
        );
        const sentences = splitSentences(text).map((s) => {
          const fallback = analyzeRuleBased(s);
          return { text: s, emotion: fallback.primary };
        });

        return {
          scores: categoryScores,
          primary, secondary,
          primaryPercent, secondaryPercent,
          mixed, triggers, language, emojiDetected, moodScore, sentences,
          goEmotions: selected,
          modelUsed: "MicahB/roberta-base-go_emotions",
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
          goEmotions: []
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
    document.getElementById("mobileNav").classList.remove("open");
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
    const originalText = textarea.value.trim();
    if (!originalText) {
      toast("Write something before analyzing.", "warn");
      return;
    }

    const btn = document.getElementById("analyzeBtn");
    btn.classList.add("loading");
    btn.disabled = true;
    const status = document.getElementById("engineStatus");
    if (status) status.textContent = "Analyzing with the standard emotion engine…";

    try {
      const user = DataLayer.getCurrentUser();
      const result = await analyzeText(originalText);
      const now = new Date();
      const recent = DataLayer.getUserEntries(user.id).slice(0, 10);

      const entry = {
        id: uid("entry"),
        userId: user.id,
        text: originalText,
        date: now.toISOString().slice(0, 10),
        time: fmtTime(now),
        timestamp: now.toISOString(),
        primaryEmotion: result.primary,
        secondaryEmotion: result.secondary,
        primaryPercentage: result.primaryPercent,
        secondaryPercentage: result.secondaryPercent,
        scores: result.scores,
        goEmotions: result.goEmotions || [],
        mixed: result.mixed,
        triggers: result.triggers,
        language: result.language,
        emojiDetected: result.emojiDetected,
        moodScore: result.moodScore,
        characterCount: originalText.length,
        wordCount: originalText.split(/\s+/).filter(Boolean).length,
        sentences: result.sentences,
        modelUsed: result.modelUsed,
        modelVersion: result.modelVersion,
        analysisSource: result.analysisSource,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        reflection: ""
      };

      entry.reflection = generateReflection(entry, recent);
      DataLayer.saveEntry(entry);

      showAnalysis(entry, recent);
      document.getElementById("entry").value = "";
      updateCounter();
      clearDraft();
      goToSection("analysis");
      toast(
        entry.analysisSource === "GoEmotions Model"
          ? "Entry analyzed with GoEmotions and saved."
          : "Model unavailable — fallback analysis saved.",
        entry.analysisSource === "GoEmotions Model" ? "success" : "warn"
      );
      renderAll();
    } catch (error) {
      console.error(error);
      toast("Analysis failed. Your text was not lost — please try again.", "warn");
    } finally {
      btn.classList.remove("loading");
      btn.disabled = false;
      if (status && !status.textContent.includes("ready")) {
        status.textContent = "Analysis complete.";
      }
    }
  }

  function showAnalysis(entry, previousEntries) {
    document.getElementById("primaryEmoji").textContent = EMOTIONS[entry.primaryEmotion].emoji;
    document.getElementById("primaryEmotion").textContent = entry.primaryEmotion;
    document.getElementById("primaryPercent").textContent = entry.primaryPercentage + "%";
    document.getElementById("primaryProgress").style.width = entry.primaryPercentage + "%";

    document.getElementById("secondaryEmoji").textContent = EMOTIONS[entry.secondaryEmotion].emoji;
    document.getElementById("secondaryEmotion").textContent = entry.secondaryEmotion;
    document.getElementById("secondaryPercent").textContent = entry.secondaryPercentage + "%";

    document.getElementById("mixedBanner").style.display = entry.mixed ? "flex" : "none";

    const triggerBox = document.getElementById("analysisTriggers");
    triggerBox.innerHTML = entry.triggers.length
      ? entry.triggers.map((t) => `<span class="chip">🔎 ${escapeHTML(t)}</span>`).join("")
      : `<span class="chip chip-muted">No clear trigger detected</span>`;

    document.getElementById("analysisMeta").textContent =
      `${entry.language} • ${entry.wordCount} words${entry.emojiDetected ? " • emoji detected" : ""} • ${entry.analysisSource || "Legacy analysis"}`;

    const standardBox = document.getElementById("standardEmotionList");
    if (standardBox) {
      const labels = (entry.goEmotions || []).slice(0, 6);
      standardBox.innerHTML = labels.length
        ? labels.map(x => `<div class="standard-emotion-item">
            <div class="label">${escapeHTML(x.label)}</div>
            <div class="score">${Math.round(x.confidence * 100)}%</div>
            <div class="bar"><i style="--w:${Math.max(2, Math.round(x.confidence * 100))}%"></i></div>
          </div>`).join("")
        : `<div class="muted-note">Standard model labels are unavailable for this entry; the fallback engine was used.</div>`;
    }
    const sourceBadge = document.getElementById("modelSourceBadge");
    if (sourceBadge) sourceBadge.textContent =
      `Source: ${entry.analysisSource || "Legacy"} · Model: ${entry.modelUsed || "Legacy rule engine"}`;

    document.getElementById("reflectionText").textContent = entry.reflection;

    // sentence-level breakdown
    const sentBox = document.getElementById("sentenceBreakdown");
    if (entry.sentences.length > 1) {
      sentBox.style.display = "block";
      sentBox.querySelector(".sentence-list").innerHTML = entry.sentences
        .map(
          (s, i) => `<div class="sentence-row">
            <span class="sentence-num">${i + 1}</span>
            <span class="sentence-text">${escapeHTML(s.text)}</span>
            <span class="sentence-emotion">${EMOTIONS[s.emotion].emoji} ${s.emotion}</span>
          </div>`
        )
        .join("");
    } else {
      sentBox.style.display = "none";
    }

    renderMoodMirror(entry, previousEntries[0]);
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
      const isToday = dateStr === new Date().toISOString().slice(0, 10);
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
        date: date.toISOString().slice(0, 10),
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
    const user = DataLayer.getCurrentUser();
    if (user) enterApp(user);

    document.querySelectorAll(".nav-link").forEach((btn) => {
      btn.addEventListener("click", () => goToSection(btn.dataset.section));
    });
    document.getElementById("hamburger").addEventListener("click", () => {
      document.getElementById("mobileNav").classList.toggle("open");
    });
    setupPremiumUX();
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
    ["themeToggle","themeToggleMobile"].forEach(id=>{
      const b=document.getElementById(id);
      if(b)b.addEventListener("click",toggleTheme);
    });
  }
  function applyTheme(theme){
    document.documentElement.dataset.theme=theme;
    DataLayer.setSetting("global","theme",theme);
    document.querySelectorAll(".theme-toggle").forEach(btn=>{
      const icon=btn.querySelector("span");
      if(icon)icon.textContent=theme==="dark"?"☾":"☀";
      btn.setAttribute("aria-label",theme==="dark"?"Switch to light theme":"Switch to dark theme");
    });
  }
  function toggleTheme(){
    const next=document.documentElement.dataset.theme==="light"?"dark":"light";
    applyTheme(next);
    toast(next==="light"?"Light theme enabled.":"Dark theme enabled.","success");
  }
  function setupLiveClock(){
    const tick=()=>{
      const el=document.getElementById("liveClock");
      if(!el)return;
      el.textContent=new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    };
    tick(); setInterval(tick,1000);
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
