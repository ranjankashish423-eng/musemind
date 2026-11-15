# MuseMind — ETE Build

MuseMind is a browser-based personal journal and reflection prototype. This build adds a connected academic calendar and a persistent document library.

## Run the application

1. Extract the ZIP file.
2. Open a terminal in the `MuseMind_ETE_Updated` folder.
3. Run a local web server:

   ```bash
   python -m http.server 8000
   ```

4. Open `http://localhost:8000` in Chrome or Edge.

A local server is recommended because browser speech recognition, PDF.js modules and file storage may not work reliably from a `file://` URL.

## Main sections

- **Home** — dashboard, latest journal entries and quick navigation.
- **Write** — typed journaling, context selection, optional English voice transcription and emotion analysis.
- **My Moments** — saved journal history and entry review.
- **My Insights** — Emotion DNA, tone distribution, writing rhythm and descriptive patterns based on saved entries.
- **Calendar** — month view combining university events, saved deadlines/tasks and journal entries. Select a date to see its events and journal moments below the calendar.
- **My Library** — search personal records, view saved knowledge sources and upload PDF/image documents.

## Academic calendar included

`assets/MUJ_Academic_Calendar_2026-2027.pdf` is the uploaded Manipal University Jaipur Academic Calendar 2026–2027. The app preloads it in My Library and seeds the clearly legible university dates as editable calendar items. The source PDF remains available through **My Library → Open original file**.

The preloaded events are a curated transcription of the one-page university calendar. MUJ may revise dates; always check the original PDF and official university updates before relying on a date.

## Uploading documents

1. Open **My Library**.
2. Use the upload area to select or drop a PDF/image.
3. MuseMind stores the original file in browser IndexedDB.
4. It extracts selectable PDF text with PDF.js, or uses Tesseract.js OCR for scanned PDFs/images when required.
5. Review any detected dates and correct titles/dates.
6. Choose **Add selected dates to Calendar**. Nothing is scheduled until you approve it.

Uploaded files are stored locally in the current browser profile. Clearing browser site data can remove them. The prototype does not upload files to a cloud server.

## Calendar behaviour

- University dates from the supplied 2026–2027 PDF are preloaded.
- Dates detected from later uploads appear in a review list first.
- Approved dates are saved to the local schedule and marked on the corresponding calendar day.
- Selecting a day displays its schedule items and any journal entries for that date.
- Schedule items can be marked complete or removed.
- Calendar items can be exported as an `.ics` file from the Calendar section.

## Technical notes and limitations

- Emotion analysis is **English-only** and uses a pretrained GoEmotions-based RoBERTa checkpoint through Transformers.js. MuseMind has not trained a new model from scratch.
- Voice transcription is English-only and uses the browser Web Speech API where supported (English India / English US options). Chrome/Edge support and microphone permission are required; voice recognition may rely on browser/device services. Non-English journal text is rejected for emotion analysis in this approved build.
- Chart.js, PDF.js, Tesseract.js and the model are loaded from public CDNs, so an internet connection is needed for those features.
- Journal data and metadata use browser localStorage; uploaded binary files use IndexedDB. This is a local prototype, not secure password-based authentication or encrypted cloud storage.
- Date extraction is a helper, not a guaranteed OCR/calendar parser. Always review extracted items before saving them.
- No live microphone test can be guaranteed across every browser/device. Verify voice input on the device used for the project demonstration.

## Files

- `index.html` — application interface
- `style.css` — responsive visual styling
- `script.js` — navigation, journal, analysis, library, calendar and storage logic
- `assets/` — supplied university calendar PDF
- `demo_documents/` — sample documents used by the demonstration workspace
- `training/` — optional research/fine-tuning preparation scripts and correction template; not evidence of a newly trained model


## ETE examination timetable import

My Library accepts PDF, JPG, JPEG and PNG files. Digital PDFs are read with PDF.js; scanned PDFs and images use English OCR through the Tesseract.js browser build. The timetable parser recognises date rows and subject-code/title pairs (for example CSE3142 — Android App Development), and creates a separate review candidate for each subject on a shared date.

**Nothing from an uploaded timetable is added automatically.** Examination candidates start unselected. The user can edit subject code, title, date, time and category, select only their own subjects, and then choose **Confirm & Add Selected Events**. Blank timetable rows are ignored. The extracted weekday is compared with the weekday calculated from the date and mismatches are flagged for review. Imported events retain a link to the original Library document.

The sample file `demo_documents/CSE_ETE_Exam_Timetable_Nov_2026.jpg` is included for manual testing. `demo_documents/CSE_ETE_Exam_Timetable_expected.json` is a QA reference only; it is not loaded into a user's calendar.

The Calendar view is visible when selected; do not hide it with CSS. Calendar events can be edited, completed or deleted from the selected-day view. Local persistence uses the existing browser storage layer and IndexedDB for original uploaded file blobs.


## Add schedule items directly from Calendar

Select any date in the Calendar to open its day details. The **Add something to this date** form lets the user enter a title, category, date, optional time, subject code and notes, then save directly to the calendar. The event is stored in the same browser profile and remains after refresh. The event can later be edited, marked complete or deleted. Duplicate title/date/subject-code combinations are checked before saving.

The separate **Upcoming and completed tasks / Connected Actions** card has been removed from My Library. My Library now focuses on uploaded documents and saved knowledge sources; schedule management is done in Calendar.


## Journal text → Calendar suggestions

When a user analyzes a new journal entry, MuseMind checks the English text for dates that occur in the same sentence as an actionable event phrase (for example, booked flight, appointment, exam, meeting, deadline or submission). A possible event is presented in a confirmation dialog after the journal analysis. The user can edit its title, date, time and category, deselect it, or dismiss the suggestion. Nothing is added to Calendar until the user selects **Confirm & Add to Calendar**.

For dates without an explicit year, MuseMind suggests the next upcoming occurrence and clearly labels the year as suggested so the user can verify it. The source sentence is shown for context. The parser is intentionally a lightweight rule-based suggestion system, not a guarantee that every date or event in free-form text will be recognised.


## Manage uploaded files in My Library

Each uploaded file card includes **Open file**, **Edit details**, and **Delete** controls. Edit details allows the user to change the displayed file name, category and description/notes; the saved local file's display name is updated too. Delete asks for confirmation, removes the original file blob from this browser's IndexedDB and removes its Library record. Calendar events imported from that document are retained, but their source-document link is cleared so the events are not accidentally deleted.
