# IdeaForge

AI idea co-founder: capture ideas, validate them with AI (BYOK — your own API key),
get brutal critique with a solution for every weakness, and follow a stage-wise
billion-dollar execution roadmap (Idea → Validation → MVP → PMF → GTM → Revenue → Scale).

- **Web / PWA**: `npm install && npm run dev` (or serve `dist/` after `npm run build`)
- **Android APK**: built automatically by GitHub Actions on every push to `main`
  (`.github/workflows/build-apk.yml`). The latest debug APK is published to the
  `builds` branch: https://raw.githubusercontent.com/pranitdandewarofficial/idea/builds/ideaforge-debug.apk

The app is fully offline-first: ideas live in `localStorage`, AI calls go straight
from the device to the chosen provider. No backend, no keys in code.
