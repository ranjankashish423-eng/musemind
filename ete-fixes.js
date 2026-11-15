
/* MuseMind ETE UI fixes — independent patch layer */
(function () {
  "use strict";
  var voiceState = { query: "", sort: "newest" };
  function readJSON(key, fallback) {
    try { var value = JSON.parse(localStorage.getItem(key) || "null"); return value == null ? fallback : value; }
    catch (_) { return fallback; }
  }
  function currentUserId() { return localStorage.getItem("musemind_current_user"); }
  function userEntries() {
    var id = currentUserId();
    return id ? readJSON("musemind_entries", []).filter(function (e) { return e && e.userId === id; }) : [];
  }
  function isVoice(e) {
    return !!(e && (String(e.voiceTranscript || "").trim() || e.inputMode === "voice-transcript"));
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }
  function dateKey(date) {
    return date.getFullYear() + "-" + String(date.getMonth()+1).padStart(2,"0") + "-" + String(date.getDate()).padStart(2,"0");
  }

  function installStyles() {
    if (document.getElementById("musemind-ete-fixes-style")) return;
    var style = document.createElement("style");
    style.id = "musemind-ete-fixes-style";
    style.textContent =
      "#view-voice .voice-notes-controls{display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:10px;margin-bottom:16px}" +
      "#view-voice .voice-notes-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}" +
      "#view-voice .voice-note-card{min-width:0;border:1px solid var(--border-soft);border-radius:16px;padding:16px;background:var(--surface)}" +
      "#view-voice .voice-note-card p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65}" +
      "#view-voice .voice-note-meta{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:11px}" +
      "#view-voice .voice-note-actions{display:flex;gap:8px;margin-top:12px}" +
      "#voiceTranscriptModal{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.65)}" +
      "#voiceTranscriptModal.open{display:flex}" +
      "#voiceTranscriptModal .voice-transcript-dialog{width:min(620px,100%);max-height:80vh;overflow:auto;border:1px solid var(--border);border-radius:18px;padding:22px;background:var(--surface);color:var(--text);box-shadow:0 24px 80px rgba(0,0,0,.35)}" +
      "#voiceTranscriptModal .voice-transcript-dialog p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.75}" +
      "#voiceTranscriptModal .voice-transcript-dialog header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}" +
      "#voiceTranscriptModal .voice-transcript-dialog h3{margin:0 0 6px}" +
      ".upcoming-summary-card{cursor:pointer;position:relative;transition:border-color .16s,background .16s}" +
      ".upcoming-summary-card:hover,.upcoming-summary-card[aria-expanded=true]{border-color:var(--coral);background:var(--surface-2)}" +
      ".upcoming-summary-card:focus-visible,.upcoming-event-row:focus-visible{outline:2px solid var(--coral);outline-offset:3px}" +
      ".upcoming-summary-card small{display:block;margin-top:6px;color:var(--coral);font-size:10px}" +
      "#upcomingEventsPanel{margin:0 0 16px;padding:19px 20px}" +
      "#upcomingEventsPanel[hidden]{display:none!important}" +
      "#upcomingEventsPanel .upcoming-events-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}" +
      "#upcomingEventsPanel .upcoming-events-head h3{font-family:var(--font-display);font-size:21px;margin:0}" +
      "#upcomingEventsPanel .upcoming-events-head p:last-child{font-size:11px;color:var(--muted);margin-top:5px}" +
      "#upcomingEventsPanel .upcoming-event-list{display:flex;flex-direction:column;gap:7px}" +
      "#upcomingEventsPanel .upcoming-event-row{display:grid;grid-template-columns:30px minmax(95px,130px) minmax(0,1fr) 18px;align-items:center;gap:12px;width:100%;padding:12px 13px;border:1px solid var(--border-soft);border-radius:12px;background:var(--surface);color:var(--text);text-align:left;cursor:pointer}" +
      "#upcomingEventsPanel .upcoming-event-row:hover{border-color:var(--coral);background:var(--surface-2)}" +
      "#upcomingEventsPanel .upcoming-event-sequence{display:grid;place-items:center;width:26px;height:26px;border-radius:9px;background:var(--surface-2);color:var(--coral);font-size:11px;font-weight:800}" +
      "#upcomingEventsPanel .upcoming-event-date strong,#upcomingEventsPanel .upcoming-event-details strong{display:block;font-size:12px}" +
      "#upcomingEventsPanel .upcoming-event-date small,#upcomingEventsPanel .upcoming-event-details small{display:block;margin-top:3px;color:var(--muted);font-size:10px}" +
      "#upcomingEventsPanel .upcoming-event-details{min-width:0}" +
      "#upcomingEventsPanel .upcoming-event-details strong{overflow-wrap:anywhere}" +
      "#upcomingEventsPanel .upcoming-event-details em{font-style:normal;color:var(--coral);font-weight:800}" +
      "#upcomingEventsPanel .upcoming-event-arrow{font-size:21px;color:var(--muted)}" +
      "@media(max-width:700px){#view-voice .voice-notes-grid{grid-template-columns:1fr}#view-voice .voice-notes-controls{grid-template-columns:1fr}#upcomingEventsPanel .upcoming-event-row{grid-template-columns:28px minmax(82px,105px) minmax(0,1fr) 14px;gap:8px;padding:10px}}";
    document.head.appendChild(style);
  }

  function ensureVoiceView() {
    var main = document.querySelector(".main-inner");
    if (!main) return;
    var view = document.getElementById("view-voice");
    if (!view) {
      view = document.createElement("div");
      view.className = "view";
      view.id = "view-voice";
      view.innerHTML =
        '<div class="view-header"><div><p class="view-eyebrow">YOUR SPOKEN REFLECTIONS</p><h1>Voice Notes</h1><p>Saved voice transcripts only — separate from your written journal.</p></div><span class="muted-note" id="voiceNotesCount">0 voice notes</span></div>' +
        '<div class="voice-notes-controls"><input id="voiceNotesSearch" type="search" placeholder="Search voice notes..." aria-label="Search voice notes"><select id="voiceNotesSort" aria-label="Sort voice notes"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div>' +
        '<div class="voice-notes-grid" id="voiceNotesBox"></div>';
      main.appendChild(view);
      view.querySelector("#voiceNotesSearch").addEventListener("input", function (e) {
        voiceState.query = e.target.value || ""; renderVoiceNotes();
      });
      view.querySelector("#voiceNotesSort").addEventListener("change", function (e) {
        voiceState.sort = e.target.value === "oldest" ? "oldest" : "newest"; renderVoiceNotes();
      });
    }
    var modal = document.getElementById("voiceTranscriptModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "voiceTranscriptModal";
      modal.innerHTML = '<div class="voice-transcript-dialog" role="dialog" aria-modal="true" aria-labelledby="voiceTranscriptTitle"><header><div><h3 id="voiceTranscriptTitle">Voice transcript</h3><small id="voiceTranscriptMeta"></small></div><button type="button" class="mini-btn" onclick="MuseMind.closeVoiceTranscript()">Close</button></header><p id="voiceTranscriptText"></p></div>';
      document.body.appendChild(modal);
      modal.addEventListener("click", function (e) { if (e.target === modal) window.MuseMind.closeVoiceTranscript(); });
    }
  }

  function renderVoiceNotes() {
    var box = document.getElementById("voiceNotesBox");
    if (!box) return;
    var entries = userEntries().filter(isVoice);
    var query = voiceState.query.trim().toLowerCase();
    if (query) entries = entries.filter(function (e) {
      return (String(e.voiceTranscript || e.text || "") + " " + String(e.entryContext || "") + " " + String(e.voiceLanguage || "")).toLowerCase().includes(query);
    });
    entries.sort(function (a,b) {
      return voiceState.sort === "oldest" ? new Date(a.timestamp)-new Date(b.timestamp) : new Date(b.timestamp)-new Date(a.timestamp);
    });
    var count = document.getElementById("voiceNotesCount");
    if (count) count.textContent = entries.length + " " + (entries.length === 1 ? "voice note" : "voice notes");
    box.innerHTML = entries.length ? entries.map(function (e) {
      var transcript = String(e.voiceTranscript || e.text || "");
      var d = new Date(e.timestamp);
      var date = Number.isNaN(d.getTime()) ? "Date not recorded" : d.toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"});
      return '<article class="voice-note-card" data-id="' + esc(e.id) + '">' +
        '<div class="voice-note-meta"><span>🎙 ' + esc(e.voiceLanguage || "Voice transcript") + '</span><span>' + esc(date) + ' · ' + esc(e.time || "") + '</span></div>' +
        '<p>' + esc(transcript.length > 260 ? transcript.slice(0,260)+"…" : transcript) + '</p>' +
        '<div class="voice-note-actions"><button class="mini-btn" type="button" onclick="MuseMind.openVoiceTranscript(\'' + esc(e.id) + '\')">Open transcript</button>' +
        '<button class="mini-btn danger" type="button" onclick="MuseMind.confirmDelete(\'' + esc(e.id) + '\')">Delete</button></div></article>';
    }).join("") : '<div class="empty-state"><div class="empty-icon">🎙️</div><h3>No voice notes found</h3><p>' + (query ? "Try another search term." : "Your saved speech transcripts will appear here, separately from typed journal entries.") + '</p></div>';
  }

  function openVoiceTranscript(id) {
    var entry = userEntries().find(function (e) { return String(e.id) === String(id) && isVoice(e); });
    if (!entry) return;
    var transcript = String(entry.voiceTranscript || entry.text || "");
    var modal = document.getElementById("voiceTranscriptModal");
    var d = new Date(entry.timestamp);
    document.getElementById("voiceTranscriptTitle").textContent = "Voice transcript";
    document.getElementById("voiceTranscriptMeta").textContent =
      (Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN",{day:"numeric",month:"long",year:"numeric"})) +
      " · " + (entry.time || "Time not recorded") + " · " + (entry.voiceLanguage || "Speech recognition");
    // Only the transcript is shown here; the journal body is not repeated.
    document.getElementById("voiceTranscriptText").textContent = transcript;
    modal.classList.add("open");
  }
  function closeVoiceTranscript() {
    document.getElementById("voiceTranscriptModal")?.classList.remove("open");
  }

  function syncDashboardCount() {
    var id = currentUserId();
    if (!id) return;
    var entries = userEntries();
    var total = entries.length;
    var stat = document.getElementById("statEntries");
    var headline = document.getElementById("dashboardHeadline");
    if (stat && stat.textContent.trim() !== String(total)) stat.textContent = String(total);
    if (headline) headline.textContent = "You have written " + total + " " + (total === 1 ? "entry" : "entries") + " so far.";
  }

  function plannerItems() {
    var id = currentUserId();
    var settings = readJSON("musemind_settings", {});
    var stored = id && settings[id] ? settings[id].documentPlannerItems : [];
    return Array.isArray(stored) ? stored.filter(function (x) { return x && /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || "")); }) : [];
  }
  function upcomingItems() {
    var today = new Date();
    var startKey = dateKey(today);
    var end = new Date(today); end.setDate(end.getDate()+7);
    var endKey = dateKey(end);
    return plannerItems().filter(function (x) { return !x.done && x.date >= startKey && x.date <= endKey; }).slice().sort(function (a,b) {
      var byDate = String(a.date).localeCompare(String(b.date));
      if (byDate) return byDate;
      var byTime = String(a.time || "99:99").localeCompare(String(b.time || "99:99"));
      return byTime || String(a.title || "").localeCompare(String(b.title || ""));
    });
  }
  function openCalendarEventDate(date) {
    var target = new Date(date + "T12:00:00");
    if (Number.isNaN(target.getTime())) return;
    var label = document.getElementById("calendarLabel")?.textContent || "";
    var current = new Date(label + " 1");
    if (!Number.isNaN(current.getTime())) {
      var delta = (target.getFullYear()-current.getFullYear())*12 + target.getMonth()-current.getMonth();
      if (delta && window.MuseMind.shiftCalendar) window.MuseMind.shiftCalendar(delta);
    }
    window.MuseMind.showCalendarDay(date);
  }
  function renderUpcomingPanel(panel) {
    var items = upcomingItems();
    var html = '<div class="upcoming-events-head"><div><p class="view-eyebrow">NEXT 7 DAYS</p><h3>Upcoming events in sequence</h3><p>Earliest date first, then time. Completed items are hidden.</p></div><button class="mini-btn" type="button" data-upcoming-close>Close</button></div>';
    if (items.length) {
      html += '<div class="upcoming-event-list">' + items.map(function (item,i) {
        var d = new Date(item.date + "T12:00:00");
        var label = d.toLocaleDateString("en-IN",{weekday:"short",day:"numeric",month:"short"});
        return '<button class="upcoming-event-row" type="button" data-event-date="' + esc(item.date) + '">' +
          '<span class="upcoming-event-sequence">' + (i+1) + '</span>' +
          '<span class="upcoming-event-date"><strong>' + esc(label) + '</strong><small>' + esc(item.time || "Time not set") + '</small></span>' +
          '<span class="upcoming-event-details"><strong>' + (item.subjectCode ? '<em>' + esc(item.subjectCode) + '</em> · ' : '') + esc(item.title || "Untitled event") + '</strong><small>' + esc(item.category || "Academic") + '</small></span>' +
          '<span class="upcoming-event-arrow">›</span></button>';
      }).join("") + '</div>';
    } else {
      html += '<div class="calendar-empty-day"><strong>No upcoming events</strong><p>There are no incomplete schedule items in the next seven days.</p></div>';
    }
    panel.innerHTML = html;
    panel.querySelector("[data-upcoming-close]")?.addEventListener("click", function () {
      panel.hidden = true; document.querySelector(".upcoming-summary-card")?.setAttribute("aria-expanded","false");
    });
    panel.querySelectorAll("[data-event-date]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var date = btn.getAttribute("data-event-date");
        panel.hidden = true; document.querySelector(".upcoming-summary-card")?.setAttribute("aria-expanded","false");
        openCalendarEventDate(date);
      });
    });
  }
  function setupUpcomingPanel() {
    var summary = document.getElementById("calendarSummary");
    if (!summary) return;
    var panel = document.getElementById("upcomingEventsPanel");
    if (!panel) {
      panel = document.createElement("div"); panel.id = "upcomingEventsPanel";
      panel.className = "card"; panel.hidden = true;
      summary.insertAdjacentElement("afterend",panel);
    } else if (panel.previousElementSibling !== summary) summary.insertAdjacentElement("afterend",panel);
    var cards = summary.querySelectorAll(".calendar-summary-card");
    var trigger = cards[1];
    if (trigger && !trigger.dataset.upcomingBound) {
      trigger.dataset.upcomingBound = "1"; trigger.classList.add("upcoming-summary-card");
      trigger.setAttribute("role","button"); trigger.setAttribute("tabindex","0");
      trigger.setAttribute("aria-controls","upcomingEventsPanel"); trigger.setAttribute("aria-expanded","false");
      var toggle = function () {
        var shouldOpen = panel.hidden;
        if (shouldOpen) renderUpcomingPanel(panel);
        panel.hidden = !shouldOpen; trigger.setAttribute("aria-expanded",String(shouldOpen));
        if (shouldOpen) panel.scrollIntoView({behavior:"smooth",block:"nearest"});
      };
      trigger.addEventListener("click",toggle);
      trigger.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();toggle();}});
    }
  }

  function install() {
    installStyles(); ensureVoiceView();
    var nav = document.querySelector(".nav-links");
    if (nav && !nav.querySelector('[data-section="voice"]')) {
      var item = document.createElement("button");
      item.type = "button"; item.className = "nav-link"; item.dataset.section = "voice";
      item.innerHTML = '<span class="nav-icon">🎙</span>Voice Notes';
      item.addEventListener("click",function(){window.MuseMind.goToSection("voice");});
      var after = nav.querySelector('[data-section="history"]');
      if (after) after.insertAdjacentElement("afterend",item); else nav.appendChild(item);
    }
    var voiceStat = document.getElementById("statDominant")?.closest("button");
    if (voiceStat) {
      voiceStat.setAttribute("aria-label","Open voice notes");
      voiceStat.onclick = function(){window.MuseMind.goToSection("voice");};
    }
    if (window.MuseMind) {
      var originalNavigate = window.MuseMind.goToSection.bind(window.MuseMind);
      window.MuseMind.goToSection = function(section,options) {
        var result = originalNavigate(section,options);
        if (section === "voice") renderVoiceNotes();
        if (section === "overview") setTimeout(syncDashboardCount,80);
        if (section === "calendar") setTimeout(setupUpcomingPanel,60);
        return result;
      };
      window.MuseMind.filterVoiceNotes = function(value){voiceState.query=String(value||"");renderVoiceNotes();};
      window.MuseMind.setVoiceNotesSort = function(value){voiceState.sort=value==="oldest"?"oldest":"newest";renderVoiceNotes();};
      window.MuseMind.renderVoiceNotes = renderVoiceNotes;
      window.MuseMind.openVoiceTranscript = openVoiceTranscript;
      window.MuseMind.closeVoiceTranscript = closeVoiceTranscript;
    }
    var stat = document.getElementById("statEntries");
    if (stat) new MutationObserver(syncDashboardCount).observe(stat,{childList:true,characterData:true,subtree:true});
    setTimeout(syncDashboardCount,150); setTimeout(syncDashboardCount,700);
    var summary = document.getElementById("calendarSummary");
    if (summary) new MutationObserver(setupUpcomingPanel).observe(summary,{childList:true,subtree:true});
    setupUpcomingPanel();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",install,{once:true});
  else install();
})();
