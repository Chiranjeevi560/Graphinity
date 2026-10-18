// Cloudflare Pages Function for /sitemap.xml: the logic is in apps/web/share.ts (tested there).
import { sitemap, type ShareEnv } from '../apps/web/share.ts';

export const onRequestGet = (context: { request: Request; env: ShareEnv }) => sitemap(context.request, context.env, fetch);
