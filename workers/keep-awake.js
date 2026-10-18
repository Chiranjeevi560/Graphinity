// Cloudflare Worker, run by a Cron Trigger every 10 minutes. Render's free
// server sleeps after 15 minutes without requests, and Supabase pauses a
// free database after a week without activity; /health touches both.
// Set API_HEALTH_URL (e.g. https://graphinity-api.onrender.com/health) as a
// variable on the Worker. Paste this file into the Worker's editor.
export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(fetch(env.API_HEALTH_URL, { headers: { 'user-agent': 'graphinity-keep-awake' } }));
  },
};
