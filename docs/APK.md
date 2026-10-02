# IdeaForge — Building the Android APK

IdeaForge is a client-side-only app: all your ideas live in the phone's local storage,
and AI calls go directly from your phone to whichever AI provider key you paste in
Settings. **No server, no API URL, no backend setup is needed for the APK.** Just build,
install, and open.

## Build it on GitHub (free, ~5–8 minutes)

The APK is built in the cloud because the build machine is blocked from downloading
the Android build tools locally. GitHub Actions does it for free.

### 1. Create a GitHub repo

1. Go to https://github.com/new
2. Name it `ideaforge`, keep it **Private**, click **Create repository**.

### 2. Upload the project files

On your computer, open a terminal in the folder where you unzipped
`ideaforge-apk-cloudbuild.zip`, then run:

```
git init
git add .
git commit -m "IdeaForge v1.1"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/ideaforge.git
git push -u origin main
```

Replace `YOUR_GITHUB_USERNAME` with your actual GitHub username. When Git asks for
a password, paste a Personal Access Token (GitHub → Settings → Developer settings →
Personal access tokens → Generate new token), not your GitHub password.

### 3. Run the build

1. Open your repo on github.com, click the **Actions** tab.
2. Click **Build IdeaForge APK** in the left sidebar.
3. Click **Run workflow** → **Run workflow** (green button).
4. Wait ~5–8 minutes while the steps run (watch the progress live).

### 4. Download the APK

1. When the run turns green, click it.
2. Scroll to **Artifacts** → download **ideaforge-debug-apk**.
3. Unzip it — inside is `app-debug.apk`.

## Install on your phone

1. Send `app-debug.apk` to your phone (WhatsApp to yourself, Google Drive, USB, anything).
2. Open the file on the phone → allow **Install from unknown sources** when asked.
3. Install. The app icon is the gold-on-dark-ink IdeaForge mark.

Your data stays on the phone. Uninstalling the app deletes your ideas — use the
app's export feature before uninstalling if it matters.

## Notes

- This is a **debug-signed** APK. It installs and runs fine, but for a Play Store
  release build you will need your own keystore (signing key) later — that is a
  separate step and not required for personal use.
- No internet permission tricks, no server URL to configure. If the app asks for an
  AI API key, paste your own key in Settings (it never leaves your device).
