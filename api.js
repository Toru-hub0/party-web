import { API_URL, SUPABASE_ANON_KEY } from './config.js';

/**
 * Edge Function `party-api` のクライアント (ブラウザ用)。
 *
 * サーバーは日本語のエラーメッセージを返すので、それをそのまま画面に出す。
 * 到達しなかったときだけこちらの文言を使う。
 */

const TIMEOUT_MS = 20000;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function call(action, params = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Edge Function は verify_jwt が既定 (true) なので両方必要
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ action, ...params }),
      signal: controller.signal,
    });
  } catch (e) {
    console.warn(`[api] ${action} network error`, e);
    throw new ApiError('通信できませんでした。電波の良い場所でもう一度お試しください。', 0);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    console.error(`[api] ${action} non-JSON response`, res.status, text.slice(0, 300));
    throw new ApiError('問題が発生しました。時間をおいてお試しください。', res.status);
  }
  if (!res.ok) {
    // party-api が返すエラーには必ず `error` が入っている。
    // それが無い 404/401/403 は関数まで届いていない (未デプロイ・設定の誤り)。
    const appError = (body.error || '').trim();
    const unreachable = !appError && [401, 403, 404].includes(res.status);
    if (unreachable) {
      console.error(`[api] ${action}: party-api に到達できませんでした`, res.status, body);
      throw new ApiError(
        'ただいまサーバーに繋がりません。幹事さんにお知らせください。',
        res.status,
      );
    }
    const message = appError || '問題が発生しました。';
    console.warn(`[api] ${action} failed`, res.status, message);
    throw new ApiError(message, res.status);
  }
  return body;
}

export const api = {
  getEvent: (code) => call('get_event', { code }),
  listPhotos: (code, since = null) => call('list_photos', { code, since }),
  presignUpload: (code) => call('presign_upload', { code, content_type: 'image/jpeg' }),
  commitPhoto: (params) =>
    call('commit_photo', {
      code: params.code,
      photo_id: params.photoId,
      nickname: params.nickname ?? null,
      caption: params.caption ?? null,
      width: params.width ?? null,
      height: params.height ?? null,
      bytes: params.bytes ?? null,
    }),
};

/** URL の ?c= からイベントコードを取り出す。 */
export function codeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = (params.get('c') || params.get('code') || '').trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

export function errorMessage(e) {
  if (e instanceof ApiError) return e.message;
  console.error('[api] unexpected error', e);
  return '問題が発生しました。時間をおいてお試しください。';
}
