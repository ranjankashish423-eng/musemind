# QA checks for this build

Automated/static checks completed:
- JavaScript syntax: passed (`node --check script.js`).
- HTML IDs: no duplicate IDs.
- Calendar visibility: removed the CSS rule that hid `#view-calendar`.
- Upload flow: My Library file input, IndexedDB blob persistence, OCR loader and review UI are present.
- Timetable parser: text-based parser test returned 15 separate subject candidates across 6 examination dates from the supplied timetable text; the blank 30 November row generated no event.
- OCR layout analysis: the supplied image was OCR-tested locally using row/column bounding boxes; the table layout yields 15 subject candidates across the same 6 dates. The browser OCR path uses Tesseract.js word bounding boxes and detected table rules to reconstruct the two columns.
- Confirmation: examination candidates default to unselected; only user-selected rows are saved.
- Duplicate protection: date + subject code + title matching is used before saving.
- Source document: uploaded document record is linked to imported events so it can be reopened from the calendar.

Not certified in this environment:
- Full interactive browser session was blocked by the execution environment.
- Live CDN download/runtime for Tesseract.js and PDF.js, real browser IndexedDB behaviour, and microphone/model features need testing in Chrome/Edge on the user's computer.

- Direct calendar event creation form added to the selected-day detail panel (title, category, date, optional time, subject code and notes).
- Manual calendar events are persisted in the same `documentPlannerItems` local storage setting and can be edited/completed/deleted.
- Removed the My Library Connected Actions / Upcoming and completed tasks card that was shown broken in the supplied screenshot.

- Journal-to-calendar event suggestion added for new saved journal entries only (not selected-text analysis or unsaved analysis).
- Test sentence containing a booked flight for 4 December 2026 produced one candidate: `Flight / Travel`, 2026-12-04, category `Travel`.
- The event is shown in an editable confirmation dialog; it is not added until the user confirms.
- Date year inference is flagged when the journal omits a year.

- Added per-file Open / Edit details / Delete controls to each My Library uploaded-file card.
- Edit details updates filename, category and description in the user's Library metadata and updates the IndexedDB file display name.
- Delete requires confirmation, removes the file blob from IndexedDB and its Library record; imported calendar events remain with their source-document reference detached.

## Final static recheck
- [x] JavaScript syntax check (`node --check script.js`).
- [x] HTML ID uniqueness check (150 IDs; no duplicates in this build).
- [x] Archive integrity check and required assets/demo-document presence.
- [x] Insights GoEmotions summary now replaces its previous instance on re-render.
- [x] Dataset language/fallback metadata aligned with the implemented English-only analysis behaviour.
- [ ] Live browser test of model download/inference, microphone permissions, PDF/OCR extraction and IndexedDB persistence on the presentation device.
