// Cloudflare Pages Function for /q/*: the logic is in apps/web/share.ts (tested there).
import { questionPage, type ShareEnv } from '../../share.ts';

export const onRequestGet = (context: { request: Request; env: ShareEnv }) =>
  questionPage(context.request, context.env, fetch);
