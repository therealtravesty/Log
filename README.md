# Macro Tracker

AI-powered macro tracker with full history. Type a food, get macros automatically.

## Deploy to Netlify (one-time setup, ~10 minutes)

### Step 1 — Create a GitHub repo

1. Go to https://github.com/new
2. Name it `macro-tracker` (or anything you like)
3. Keep it **Private**
4. Click **Create repository**
5. On the next page, copy the repo URL (looks like `https://github.com/YOURNAME/macro-tracker.git`)

### Step 2 — Push these files to GitHub

Open your terminal and run these commands one by one:

```bash
cd /path/to/this/folder
git init
git add .
git commit -m "Initial macro tracker"
git branch -M main
git remote add origin https://github.com/YOURNAME/macro-tracker.git
git push -u origin main
```

Replace `/path/to/this/folder` with where you saved these files, and `YOURNAME` with your GitHub username.

### Step 3 — Connect to Netlify

1. Go to https://netlify.com and sign up / log in with GitHub
2. Click **Add new site → Import an existing project**
3. Choose **GitHub** and authorize Netlify
4. Select your `macro-tracker` repo
5. Build settings will auto-detect from `netlify.toml` — leave them as-is
6. Click **Deploy site**

### Step 4 — Add your Anthropic API key

1. In Netlify, go to **Site configuration → Environment variables**
2. Click **Add a variable**
3. Key: `ANTHROPIC_API_KEY`
4. Value: your Anthropic API key (get one at https://console.anthropic.com)
5. Click **Save**
6. Go to **Deploys** and click **Trigger deploy → Deploy site** to redeploy with the key

### Step 5 — Open your tracker

Netlify gives you a URL like `https://amazing-name-123.netlify.app` — bookmark it!

You can also set a custom domain in Netlify if you want something cleaner.

---

## How to use

- Type any food in the search box and hit **Look up**
- Review the macros and click **+ Add to log**
- Check the **History** tab to see all past days
- Export any day or your full history as CSV anytime

## Updating

Any time you push changes to GitHub, Netlify auto-redeploys within ~30 seconds.
