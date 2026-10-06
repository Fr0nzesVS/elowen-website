# Kadr Shorts — Supabase setup

The site remains a static GitHub Pages site: keep the existing repository, Pages settings and URL. Supabase provides the shared database, public video files and visitor accounts; no web server or GitHub Action is needed.

## 1. Create a free Supabase project

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard). Pick a strong database password and keep it private.
2. In **Project Settings → API**, copy the **Project URL** and the **publishable key** (`sb_publishable_…`). On older projects the public key is called the **anon** key.
3. **Never** use or publish the `service_role` or secret key. The publishable/anon key is intended to be public in a website; the database rules below restrict what it can do.

## 2. Set up the database and video bucket

1. In your project, open **SQL Editor → New query**.
2. Copy all of [`supabase-schema.sql`](./supabase-schema.sql), run it and confirm it finishes successfully. It creates the profile, video, like and comment tables; the public MP4 bucket; and the access rules that limit each creator to their own uploads.
3. In **Authentication → Sign In / Providers** (the label can vary between dashboard versions), enable **Anonymous Sign-Ins**. This lets a visitor upload, like and comment without an email sign-up. Their account/session stays in that browser; an anonymous account is not a recoverable cross-device login.

## 3. Connect this website

1. Open [`supabase-config.js`](./supabase-config.js) and set the two public values you copied:

   ```js
   window.SHORTS_CONFIG = {
     url: "https://YOUR-PROJECT-REF.supabase.co",
     anonKey: "sb_publishable_YOUR-PUBLIC-KEY"
   };
   ```

   Use your actual Project URL and publishable (or older `anon`) key. Do not paste a `service_role` or secret key into this public file.
2. Save and push the change to the **same existing GitHub Pages repository**. GitHub Pages will redeploy the website at its current URL. Keep `index.html`, `shorts.js`, `supabase-config.js` and `supabase-schema.sql` together in the published folder.
3. Open that existing website URL. The app signs this browser into an anonymous Supabase account and loads the shared video feed. You can also use the gear button to connect/test a project in this browser without editing the config file; that local override is stored only in that browser.

## 4. Upload and check the app

Choose **Загрузить видео**, select a real `.mp4` file up to **50 MB**, enter a title and username, and publish. The browser uploads the file into the Supabase `shorts-videos` bucket and then inserts its feed entry. Published videos are public to watch, and remain available after reloads and on other devices. If publishing the feed entry fails after the file upload, the app attempts to delete the unused file and shows any cleanup error.

Try scrolling through uploaded clips, automatic playback/pause, tap-to-pause, sound, fullscreen, search, categories, likes, comments and sharing. Likes and comments are stored in Supabase as well.

## Security and free-tier notes

- GitHub Pages itself cannot accept or persist user uploads. Supabase stores the actual MP4 files and feed data; GitHub Pages continues serving the frontend at the same URL.
- Publishable/anon keys are public by design. The supplied SQL enables row-level security and makes uploads, likes and comments owner-authenticated; **never** put a Supabase secret or `service_role` key in this repository.
- Each anonymous account is tied to its browser. Clearing site storage or changing browsers/devices creates a different account; add a real sign-in provider if you later want recoverable accounts.
- The bucket rejects non-MP4 uploads and limits individual files to 50 MB. Free storage, bandwidth, project-pause and anonymous sign-in quotas are controlled by Supabase and can change; check your project's current usage and pricing before sharing the site widely. A public bucket and anonymous sign-up can be abused, so review uploaded content and set project-level rate limits before promoting a large public service.
- If the connection fails, the page displays the Supabase error. Confirm the SQL was run on the **same** project, anonymous sign-ins are enabled, the Project URL/key are correct, and the project's storage/database quotas have not been exceeded.
