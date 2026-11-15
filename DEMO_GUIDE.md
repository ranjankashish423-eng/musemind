# MuseMind ETE Demo Guide

## Recommended demo path

1. Start the app using `python -m http.server 8000` and open `http://localhost:8000`.
2. Create a local profile or reopen the existing profile.
3. Open **Home** and verify dashboard counts/latest entries.
4. Open **Write**:
   - type a short English journal entry;
   - optionally test voice transcription in Chrome/Edge after granting microphone permission;
   - analyze and save the entry.
5. Open **My Moments** and open the saved entry to inspect its details.
6. Open **My Insights** and check the emotion distribution, writing rhythm and pattern summaries. Insights need at least two saved entries.
7. Open **Calendar**:
   - move between months;
   - select dates with university events;
   - verify that event details appear below the month grid;
   - select a date with a journal entry to see both types of information.
8. Open **My Library**:
   - confirm `MUJ Academic Calendar 2026–2027.pdf` is listed;
   - open the original PDF;
   - upload a PDF/image, review detected dates, correct any title/date and save selected items;
   - open Calendar and confirm the saved dates are marked.
9. Test completion/removal of a schedule item and export the schedule as an `.ics` file from Calendar.

## Important test conditions

- Use Chrome or Edge for voice recognition.
- Allow microphone permission.
- Use a local HTTP server, not `file://`.
- Keep an internet connection for CDN-loaded libraries/model.
- Try a text-based PDF first; scanned PDFs/images use OCR and may take longer.
- Date extraction is not guaranteed. Review every detected date before saving.
- The app stores data in this browser only. Another browser/device will not automatically share it.


## Test the CSE examination timetable import

1. Start the app using a local web server (for example `python -m http.server 8000`) and open it in Chrome.
2. Open **My Library** and upload `demo_documents/CSE_ETE_Exam_Timetable_Nov_2026.jpg` (or your own PDF/screenshot).
3. Wait for OCR to finish. The original file should be retained in My Library.
4. Confirm the review list contains separate candidates for each subject. For the sample timetable, expected dates are 19, 21, 24, 26 and 28 November, and 1 December 2026; the blank 30 November row must not create an event.
5. Examination candidates are initially unchecked. Select only the subjects you personally take.
6. Edit any subject code, title, date, time or category if needed.
7. Click **Confirm & Add Selected Events**. Only selected events should be added.
8. Open **Calendar**, navigate to November/December 2026 and select a date. Each selected subject should appear as its own event card below the month grid.
9. Edit, complete or delete an event, refresh the page, and verify the change persists.
10. Use the event's **Open source document** link to reopen the original timetable from My Library.

OCR quality depends on image clarity and browser/network availability. If the file is unclear, manually correct the review fields before confirmation.


## Add an item directly from Calendar

1. Open Calendar and click the date you want.
2. In the selected-day details, use **Add something to this date**.
3. Enter a title and choose a category. Add an optional time, subject code and note.
4. If needed, change the date in the form before saving.
5. Click **Add to Calendar**. The event appears under that date and is saved locally.
6. Refresh the app; the event should still be present. Use Edit, the completion checkbox or Delete to manage it.

The My Library page no longer contains the separate Connected Actions / Upcoming and completed tasks panel.


## Test journal date detection

1. Open **Write** and enter: `I have booked my flight tickets for 4 December 2026, as my last examination is scheduled to end on 1 December. I am really looking forward to going home after the exams.`
2. Click **Analyze My Feelings**.
3. After analysis, a dialog should appear saying **I noticed a date in your journal**.
4. Check the suggested event `Flight / Travel` on 4 December 2026. Edit its title, date, category or time if needed.
5. Click **Confirm & Add to Calendar**. The event should now appear under 4 December in Calendar.
6. If you click **Not now**, no event is created.
7. Try writing a date with no year (for example `I booked a flight for 4 December.`). The suggested year is the next upcoming occurrence and is explicitly marked for review.

This is a rule-based suggestion feature. It only proposes dates that appear in the same sentence as an event-related phrase; it does not silently create events.
