# NOVA Companion

Code-first personal AI companion using the existing Supabase project \`ghthfxkkdokmilyayxcl\` for auth/data and its Edge Functions for chat and user records.

## Deploy
Import the repository into Vercel: https://vercel.com/new/import?s=github&repo=28royalpapi%2Fnova-modal-deployment. Vercel hosts the static frontend and Node API in the same project. GitHub Pages cannot run the Chromium API.

## OpenAI
1. Create a key at https://platform.openai.com/api-keys.
2. In Supabase Project Settings → Edge Functions → Secrets for project \`ghthfxkkdokmilyayxcl\`, add \`OPENAI_API_KEY\`.
3. Do not commit the key, put it in \`config.js\`, or paste it in chat.
4. NOVA defaults to \`gpt-5-mini\`; open Settings and use **Test connection** after setting the secret.

OpenAI API billing is separate from ChatGPT. Set a budget/usage limit before high-volume use.

## Browser privacy/limitations
\`api/browser.js\` launches a fresh Playwright/Chromium context per request and discards it afterward. Public mode reads HTTPS pages. Authorized-login mode requires explicit consent and supports only a simple same-origin POST form; CAPTCHA/MFA, GET login forms, and cross-origin authentication flows are refused. Credentials are not sent to the model or saved in task results. Text/status are saved via the authenticated Supabase function; screenshot and PDF are returned to the signed-in user. This is a per-request browser, not a persistent Debian desktop or general shell.
