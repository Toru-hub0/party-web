/**
 * ゲスト投稿ページ / 会場スクリーンページの設定。
 *
 * ここに書いてあるのは公開情報だけ (Supabase の anon キーは公開してよいキー)。
 * service role キーは絶対に置かない — サーバー側の secrets のみ。
 *
 * ビルド工程を持たないので、値を変えたらこのファイルを直して push するだけ。
 */
export const SUPABASE_URL = 'https://iokwgihtxwwiobzetpwa.supabase.co';

export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlva3dnaWh0eHd3aW9iemV0cHdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNjk0ODQsImV4cCI6MjA5Njg0NTQ4NH0.YiJERU0t2i-oio2_vu6BGRmbdb2JfPRauHED-WjeIR0';

/**
 * 開発用の API 差し替え。
 *
 * `?api=...` を見るのは **localhost で開いているときだけ**。本番のページでも
 * 効いてしまうと、細工したURLを配って別のサーバーへ写真を送らせられるため。
 * (scripts/mock-server.mjs での確認に使う)
 */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** localhost で開いているときだけ有効な `?api=` の値。本番では常に null。 */
function apiOverride() {
  if (!LOCAL_HOSTS.includes(window.location.hostname)) return null;
  return new URLSearchParams(window.location.search).get('api');
}

function resolveApiUrl() {
  return apiOverride() || `${SUPABASE_URL}/functions/v1/party-api`;
}

export const API_URL = resolveApiUrl();

/**
 * このページ自身が置かれている場所。会場スクリーンに出す「ゲスト投稿用QR」の
 * URL を組むのに使う。同じディレクトリに join.html がある前提なので、
 * ハードコードせず現在のURLから導く (GitHub Pages のパスが変わっても壊れない)。
 */
export function joinUrl(code) {
  const url = new URL('join.html', new URL('.', window.location.href));
  url.searchParams.set('c', code);
  // モックで確認しているあいだは差し替え先を引き継ぐ (でないと1画面進むたびに
  // 本番のサーバーを見に行ってしまう)。本番では apiOverride() が null なので付かない。
  const api = apiOverride();
  if (api) url.searchParams.set('api', api);
  return url.href;
}

/** 不適切な写真の報告先 (App Store ガイドライン 1.2 の通報導線)。 */
export const SUPPORT_URL = 'https://toru-hub0.github.io/app-legal/';
