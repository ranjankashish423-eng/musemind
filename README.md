# MuseMind 3.0 — GoEmotions Edition

## What changed

MuseMind now uses a standard, publicly available GoEmotions-based transformer for English emotion inference in the browser.

### Primary dataset
- **GoEmotions**
- Provider: Google Research
- Approximately 58K Reddit comments
- 28 emotion labels
- Multi-label emotion classification

### Model
`MicahB/roberta-base-go_emotions`

This is a Transformers.js-compatible clone of the SamLowe GoEmotions RoBERTa model. It is a pretrained/fine-tuned model; MuseMind does **not** claim to train it from scratch.

### Browser inference
The app uses Hugging Face Transformers.js from a CDN. The model is downloaded and cached by the browser on first use. No private API key is required.

### Hybrid architecture
English -> GoEmotions transformer
Hindi/Hinglish -> existing MuseMind rule-based fallback
Model failure -> rule-based fallback

### Stored analysis
Each new entry stores:
- primary/secondary MuseMind emotion
- confidence percentages
- original GoEmotions labels and confidence
- MuseMind category mapping
- mixed emotion flag
- trigger categories
- language
- model name/version
- analysis source
- mood score and reflection

### Evaluation
The selected public model card reports, on its GoEmotions test split with a 0.5 threshold:
- Accuracy: 0.474
- Precision: 0.575
- Recall: 0.396
- F1: 0.450

These are **model-card results**, not a MuseMind retraining result.

### Important limitation
GoEmotions is English-focused. Hindi/Hinglish continues to use the existing rule-based engine rather than falsely claiming multilingual GoEmotions support.

## Run
Open the project through a web server or deploy it to GitHub Pages. Browser module/CDN/model loading is expected to work from HTTP(S) hosting.

## Official references
- GoEmotions dataset: https://github.com/google-research/google-research/tree/master/goemotions
- Model: https://huggingface.co/MicahB/roberta-base-go_emotions
- Transformers.js: https://huggingface.co/docs/transformers.js

## September 2026 analysis fixes
- Fixed login: `script.js` is a normal browser script again; Transformers.js is loaded dynamically only when emotion analysis is needed, so `MuseMind.login()` works with the existing inline button.
- Fixed zero-confidence history cards by using normalized GoEmotions labels and category scores.
- Stores all 28 real model outputs in `goEmotionScores` instead of only the display subset.
- Keeps original GoEmotions labels separately from MuseMind's 8 dashboard categories.
- Sentence-by-sentence analysis now uses the transformer when available, with transparent fallback per sentence.
- Added a re-analysis action for older saved entries so legacy/incorrect results can be recalculated with the current model.
- Added robust `LABEL_n` normalization for model outputs.
- Fixed demo-mode analysis to await the asynchronous model correctly.
- Added functional Emotion Intelligence rendering: ranking, 28-label radar, mixed emotions, mapping, spectrum, sentence journey, evidence, mood, baseline and export.
