import { api, codeFromUrl, errorMessage } from './api.js';
import { createBoard } from './board.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config.js';

/**
 * 会場スクリーン。写真の入手 (通信) と見せ方 (演出) の担当。
 * 貼る位置の計算とカードのDOMは board.js に分けてある。
 *
 * 設計の要点:
 *  - 落ちないことが最優先。一晩中つけっぱなしにされ、誰も操作できない場所で動く。
 *    → 新着通知 (Realtime) が切れてもポーリングで写真が増え続ける。
 *      Realtime は「速さ」のため、ポーリングは「確実さ」のため。片方が死んでも
 *      会場の体験は壊れない。
 *  - 外部CDN (QRライブラリ) が読めなくてもページは動く。QRだけ文字表示に落ちる。
 */

// --- 調整値 ----------------------------------------------------------
/**
 * 仮想グリッドのマス数の目安 = カード1枚の大きさを決める値。
 * 増やすと1枚が小さくなり、遠くの席から見えなくなる。
 */
const SLOT_COUNT = 30;

/**
 * ボードに残すカードの最大数 (指示書 §4.4)。これを超えたぶんは、完全に
 * 埋もれて見えなくなった古いカードだけを間引く (見た目は変わらない)。
 */
const MAX_CARDS = 250;

/** 初回に一気に貼る枚数。多すぎると開いた瞬間が重いので直近ぶんだけにする。 */
const INITIAL_CARDS = 60;

/** 新着が無いまま何ms経ったらスライドショーに入るか (指示書 §4.4: 2分)。 */
const IDLE_MS = 2 * 60 * 1000;

/** スライドショーで1枚を見せる時間。 */
const SLIDE_MS = 8000;

/** 差分ポーリングの間隔。Realtime が生きていても保険として回す。 */
const POLL_MS = 15000;

/** 全体を突き合わせる間隔 (削除された写真をボードから消すため)。 */
const FULL_SYNC_MS = 3 * 60 * 1000;

const el = (id) => document.getElementById(id);

const state = {
  code: null,
  eventId: null,
  event: null,
  /** サーバー上の全写真 (created_at 昇順)。スライドショーで使う。 */
  allPhotos: [],
  lastCreatedAt: null,
  lastArrivalAt: Date.now(),
  slideshow: { on: false, index: 0, timer: null },
};

const board = createBoard({
  container: el('board'),
  slotCount: SLOT_COUNT,
  maxCards: MAX_CARDS,
  // 予約は左上のイベント名だけ。盤面はできるだけ写真に使う
  reservedElements: [el('plate')],
});

// =====================================================================
// 初期化
// =====================================================================

async function init() {
  state.code = codeFromUrl();
  if (!state.code) {
    showNotice('URLが正しくありません (?c=コード が必要です)', true);
    return;
  }

  try {
    await fullSync({ initial: true });
  } catch (e) {
    showNotice(errorMessage(e), true);
    return;
  }

  connectRealtime();
  setInterval(pollNew, POLL_MS);
  setInterval(
    () => fullSync().catch((e) => console.warn('[screen] full sync failed', e)),
    FULL_SYNC_MS,
  );
  setInterval(checkIdle, 5000);

  keepScreenAwake();
  window.addEventListener('resize', debounce(() => board.relayout(), 250));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      keepScreenAwake();
      fullSync().catch((e) => console.warn('[screen] resume sync failed', e));
    }
  });
}

/** サーバーの状態をそのまま画面に反映する (追加・削除の両方を拾う)。 */
async function fullSync({ initial = false } = {}) {
  const { event, event_id, photos } = await api.listPhotos(state.code);
  state.event = event;
  state.eventId = event_id;
  state.allPhotos = photos;
  state.lastCreatedAt = photos.length ? photos[photos.length - 1].created_at : null;
  renderHeader();

  if (initial) {
    // 直近 INITIAL_CARDS 枚を、演出なしで一気に貼る
    for (const photo of photos.slice(-INITIAL_CARDS)) board.add(photo, { animate: false });
    return;
  }

  // 消された写真をボードから外す
  const alive = new Set(photos.map((p) => p.id));
  for (const id of board.ids()) {
    if (!alive.has(id)) board.remove(id, { animate: true });
  }
  // 取りこぼした新着を貼る
  for (const photo of photos.slice(-MAX_CARDS)) {
    if (!board.has(photo.id)) board.add(photo, { animate: false });
  }
}

/** 差分だけ取る軽いポーリング。 */
async function pollNew() {
  try {
    if (!state.lastCreatedAt) {
      // まだ1枚も無い場合は since が使えないので全体を見る
      await fullSync();
      return;
    }
    const { photos } = await api.listPhotos(state.code, state.lastCreatedAt);
    for (const photo of photos) onPhotoAdded(photo);
  } catch (e) {
    console.warn('[screen] poll failed', e);
  }
}

function renderHeader() {
  const { title, event_date } = state.event;
  document.title = `${title} — PartyBoard`;
  el('title').textContent = title;
  el('date').textContent = event_date || '';
  applyTheme(state.event.theme);
  // 幹事がアプリで配置を変えたら、開いたままのこの画面も並び直る
  board.setGrid({ cols: state.event.screen_cols, rows: state.event.screen_rows });
  board.setLook({ style: state.event.screen_style, labels: state.event.screen_labels });
}

/** イベントに設定されたテーマ (コルク / 黒板 / ナイト) を反映する。 */
const THEMES = ['cork', 'blackboard', 'night'];

function applyTheme(theme) {
  const next = THEMES.includes(theme) ? theme : 'cork';
  for (const name of THEMES) {
    document.body.classList.toggle(`theme-${name}`, name === next);
  }
}

// =====================================================================
// 新着
// =====================================================================

function onPhotoAdded(photo) {
  if (!photo?.id || !photo.public_url) return;
  if (state.allPhotos.some((p) => p.id === photo.id)) return;

  state.allPhotos.push(photo);
  if (!state.lastCreatedAt || photo.created_at > state.lastCreatedAt) {
    state.lastCreatedAt = photo.created_at;
  }
  state.lastArrivalAt = Date.now();

  // 新着が来たらスライドショーは即座に抜ける (ボードに貼るところを見せたい)
  stopSlideshow();
  board.add(photo, { animate: true });
  renderHeader();
}

function onPhotoRemoved(payload) {
  const id = payload?.id;
  if (!id) return;
  state.allPhotos = state.allPhotos.filter((p) => p.id !== id);
  board.remove(id, { animate: true });
  renderHeader();
}

// =====================================================================
// Realtime (新着通知)
//
// DB の postgres_changes は使えない (RLSポリシーが無く anon から行が見えない)。
// Edge Function から broadcast されるチャンネルを購読する。
// event_id (UUID) を知っている者しか購読できないのがアクセス制御になっている。
// =====================================================================

async function connectRealtime() {
  let createClient;
  try {
    ({ createClient } = await import('https://esm.sh/@supabase/supabase-js@2.112.3'));
  } catch (e) {
    // 会場のネットワークが CDN を弾く場合。ポーリングだけで動き続ける。
    console.warn('[screen] realtime library unavailable, polling only', e);
    showNotice('新着の即時反映は使えません (数秒ごとに自動更新します)', false, 6000);
    return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

  let channel = null;
  let retryDelay = 1000;

  const subscribe = () => {
    if (channel) sb.removeChannel(channel);
    channel = sb
      .channel(`party:${state.eventId}`)
      .on('broadcast', { event: 'photo_added' }, ({ payload }) => onPhotoAdded(payload))
      .on('broadcast', { event: 'photo_removed' }, ({ payload }) => onPhotoRemoved(payload))
      .on('broadcast', { event: 'event_updated' }, () => {
        fullSync().catch((e) => console.warn('[screen] sync after event_updated failed', e));
      })
      .subscribe((status) => {
        console.log('[screen] realtime status', status);
        if (status === 'SUBSCRIBED') {
          retryDelay = 1000;
          hideNotice();
          // 切れている間に増えたぶんを取り込む
          fullSync().catch((e) => console.warn('[screen] sync after subscribe failed', e));
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          // 少しずつ間隔を伸ばして再購読する (最大30秒)
          setTimeout(subscribe, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 30000);
        }
      });
  };

  subscribe();
}

// =====================================================================
// アイドル時のスライドショー
//
// 新着が途切れても画面が「止まった」ように見えないように、既にある写真を
// ゆっくり大きく見せる。新着が来たら即座に抜ける。
// =====================================================================

function checkIdle() {
  const idle = Date.now() - state.lastArrivalAt > IDLE_MS;
  if (idle && !state.slideshow.on && state.allPhotos.length > 0) startSlideshow();
}

function startSlideshow() {
  state.slideshow.on = true;
  state.slideshow.index = 0;
  el('slideshow').classList.add('on');
  showSlide();
  state.slideshow.timer = setInterval(showSlide, SLIDE_MS);
}

function stopSlideshow() {
  if (!state.slideshow.on) return;
  state.slideshow.on = false;
  clearInterval(state.slideshow.timer);
  state.slideshow.timer = null;
  el('slideshow').classList.remove('on');
}

function showSlide() {
  const photos = state.allPhotos;
  if (photos.length === 0) {
    stopSlideshow();
    return;
  }
  // 新しいものから順に見せる
  const photo = photos[photos.length - 1 - (state.slideshow.index % photos.length)];
  state.slideshow.index++;

  const img = el('slide-image');
  img.src = photo.public_url;
  img.alt = photo.caption || '';
  // ズームのアニメーションを頭から再生させる
  img.style.animation = 'none';
  void img.offsetWidth;
  img.style.animation = '';

  const label = el('slide-label');
  label.replaceChildren();
  if (photo.caption) label.append(document.createTextNode(photo.caption));
  if (photo.nickname) {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${photo.nickname} さん`;
    label.append(who);
  }
}

// =====================================================================
// 画面を消させない / 全画面 / カーソル
// =====================================================================

let wakeLock = null;

async function keepScreenAwake() {
  if (!('wakeLock' in navigator)) return;
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => console.log('[screen] wake lock released'));
  } catch (e) {
    // Safari など未対応/拒否のブラウザ。OS側の設定で消灯を切ってもらう。
    console.warn('[screen] wake lock unavailable', e);
  }
}

el('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (e) {
    console.warn('[screen] fullscreen failed', e);
  }
});

let cursorTimer = null;
window.addEventListener('mousemove', () => {
  document.body.classList.add('show-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.remove('show-cursor'), 3000);
});

// =====================================================================
// 小物
// =====================================================================

let noticeTimer = null;

function showNotice(message, sticky = false, ms = 4000) {
  const node = el('notice');
  node.textContent = message;
  node.classList.add('on');
  clearTimeout(noticeTimer);
  if (!sticky) noticeTimer = setTimeout(hideNotice, ms);
}

function hideNotice() {
  el('notice').classList.remove('on');
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

init();
