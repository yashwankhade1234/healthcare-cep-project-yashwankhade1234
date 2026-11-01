# HealthCare+

This is a mobile-friendly website prototype for the CEP problem statement: community medical camps, multilingual health information and rural women's health learning. It is not a native Android/iOS app. Run it through the included Node.js server so the language selector and optional AI routes can work.

## Start the website

1. Install Node.js 18 or later.
2. In Windows PowerShell, run `npm.cmd start`. On macOS/Linux, run `npm start`.
3. Open `http://127.0.0.1:4173` in a browser.

The site works without an API key. The language selector remembers English, Marathi or Hindi; common labels and the local assistant are available in all three languages. Without the optional AI setup, full-page translation and live assistant answers remain off and the assistant uses clearly marked local demo replies.

## Enable live AI and full-page translation

1. Copy `.env.example` to `.env`.
2. Create a new Groq key and add it to `GROQ_API_KEY` in `.env` (the example is set to Groq), or choose OpenAI and set `AI_PROVIDER=openai` with `OPENAI_API_KEY`.
3. Restart the server.

The key stays on the server and is never sent to browser code. Live assistant replies and full-page Marathi/Hindi translation use the configured API model. When live mode is enabled, the question you submit and page text selected for translation are sent to the configured AI service. Avoid sending sensitive health or personal details. API usage may incur charges; check the provider's current pricing before enabling it. Groq's Responses endpoint is documented as beta.

## Manage lesson information and videos

1. In `.env`, set `ADMIN_PASSWORD` to a long private password, then restart the website server.
2. Open `http://127.0.0.1:4173/admin.html` and sign in.
3. Choose a Learning Centre or Hygiene topic. Edit its title, introduction, related information, steps, trusted source and English/Marathi/Hindi YouTube links, then save.
4. Upload each language's video to YouTube as **Unlisted** or **Public**, then paste its HTTPS link. If a Marathi or Hindi video link is empty, the page keeps the English video and says so.

Saved lesson changes are written to `content.json` beside the server. The admin page is available only through the local server; this demo backend is not configured for public hosting. Keep `.env` private: it contains the API key and admin password, and should never be shared in the project ZIP.

## Voice controls

The assistant includes browser speech input and spoken replies. Browser speech recognition support varies, and some browsers use a remote recognition service; the microphone starts only when the user presses the voice button and grants permission. Text replies remain available if voice features are unsupported.

## Demo account forms

Login and signup pages are front-end demos. They do not authenticate users, send SMS, upload documents, or save account details. The demo OTP is `123456`. Connect a proper authentication and SMS service before using these pages for real accounts.

## Community health topics

The Medical Camps page contains demonstration listings only; confirm real camp dates and locations with local organisers. The Women & Child Health page includes sample learning topics on maternal health, child nutrition and menstrual hygiene. It does not claim that in-person sessions are scheduled or provided.

## Interactive demo features

- The Home page service finder routes people to a relevant topic.
- The Learning Centre has 14 searchable lessons with trusted video links, step-by-step guides, and progress saved only in this browser.
- Health Awareness has a searchable, filterable topic list.
- Hygiene has a daily checklist with progress saved in this browser for that day.
- Women & Child Health includes a short learning quiz; its score is saved only in this browser.
- Medical Camps can be filtered and saved locally for later. Saving does not register or book a camp.

These local features do not send user profile data to a server. Real camp bookings, accounts, cross-device progress and content management need a backend and verified community data.
