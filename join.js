import { api, codeFromUrl, errorMessage } from './api.js';
import { joinUrl, SUPPORT_URL } from './config.js';
import { downloadPhoto, MAX_FILES, uploadFiles } from './upload.js';

/**
 * ゲスト投稿ページ。
 *
 * 目標は「QRを読んでから3枚投稿するまで1分以内」なので、余計な画面遷移も
 * 説明も入れない。名前は localStorage に覚えて2回目以降は入力させない。
 */

const el = (id) => document.getElementById(id);

/** 会場スクリーンと同じテーマ (party_events.theme)。 */
const THEMES = ['cork', 'blackboard', 'night'];

const state = {
  code: null,
  event: null,
  /** 選択中のファイル (File の配列)。プレビューURLも一緒に持つ。 */
  picked: [],
  photos: [],
  uploading: false,
  /** ドックに出している進捗・エラー文 (出ている間はドックを閉じない)。 */
  status: '',
};

// ---------------------------------------------------------------------
// 初期化
// ---------------------------------------------------------------------

el('support').href = SUPPORT_URL;

async function init() {
  setupCodeForm();

  state.code = codeFromUrl();
  if (!state.code) {
    // 行き止まりにしない。QRが読めなくてもコードを打てば入れる。
    // ここでは案内をコードのカードに1つだけ置く (二重に書くと読まれない)。
    showCodeForm();
    return;
  }

  try {
    const { event, photo_count } = await api.getEvent(state.code);
    state.event = event;
    renderHeader(photo_count);
    el('main').hidden = false;
    applyStatus();
  } catch (e) {
    // コードが間違っている / イベントが消えている。打ち直せるようにする。
    fatal(errorMessage(e));
    showCodeForm();
  }
}

/**
 * イベントコードの手入力。
 *
 * 打ち終わったら `join.html?c=CODE` へ移動する。状態を持ち回すのではなく
 * URLを変えるのは、そのまま再読込・共有ができるようにするため。
 */
function setupCodeForm() {
  const input = el('code-input');
  const error = el('code-error');

  const submit = () => {
    // 見た目を合わせるための空白やハイフンは落とす (「ABC-123」でも通す)
    const code = input.value.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      error.textContent = 'コードは英数字6文字です。';
      error.hidden = false;
      input.focus();
      return;
    }
    error.hidden = true;
    window.location.href = joinUrl(code);
  };

  el('code-join').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  });
  // 打っている途中のエラー表示は邪魔なので消す
  input.addEventListener('input', () => {
    error.hidden = true;
  });
}

function showCodeForm() {
  genericHeader();
  el('code-form').hidden = false;
  el('code-input').focus();
}

function fatal(message) {
  genericHeader();
  el('fatal').hidden = false;
  el('fatal-message').textContent = message;
}

/**
 * イベントが分からないときの見出し。
 *
 * イベント名の場所を空のまま残すと、色の付いた枠と空のバッジだけが浮いて
 * 壊れて見える。かわりにサービス名を出して、日付・状態の行は畳む。
 */
function genericHeader() {
  el('title').textContent = 'PartyBoard';
  el('meta').hidden = true;
}

function renderHeader(photoCount) {
  const { title, event_date, accepting } = state.event;
  document.title = `${title} | PartyBoard`;
  el('title').textContent = title;
  el('date').textContent = event_date || '';
  const badge = el('status');
  badge.textContent = accepting ? '受付中' : '受付終了';
  badge.className = `badge ${accepting ? 'open' : 'closed'}`;
  if (typeof photoCount === 'number') {
    el('count').textContent = `${photoCount}枚`;
  }
  applyTheme(state.event.theme);
  updateSubmit();
}

/** イベントのテーマを反映する (会場スクリーンと同じ見た目にする)。 */
function applyTheme(theme) {
  const next = THEMES.includes(theme) ? theme : 'cork';
  for (const name of THEMES) {
    document.body.classList.toggle(`theme-${name}`, name === next);
  }
}

/**
 * 受付状態に応じて投稿UIを出し入れする。
 *
 * 締切 (closed) だけでなく、開催日から日が経ったイベントもサーバーが投稿を
 * 拒否する (誤投稿防止 §4.7-4)。理由が違うので文言を出し分ける。
 */
function applyStatus() {
  const { accepting, status, moderation } = state.event;
  el('closed-notice').hidden = accepting;
  el('post-form').hidden = !accepting;
  if (!accepting) {
    const closedByHost = status === 'closed';
    el('closed-title').textContent = closedByHost
      ? '写真の受付は終了しました'
      : 'このパーティの受付は終了しています';
    el('closed-hint').textContent = closedByHost
      ? 'これまでに集まった写真は「アルバム」から見られます。'
      : '開催日から日が経っているため、新しい写真は受け付けていません。これまでの写真は「アルバム」から見られます。';
  }
  el('approval-note').hidden = moderation !== 'approval';
  updateDock();
}

// ---------------------------------------------------------------------
// タブ
// ---------------------------------------------------------------------

function selectTab(which) {
  const post = which === 'post';
  el('tab-post').setAttribute('aria-selected', String(post));
  el('tab-album').setAttribute('aria-selected', String(!post));
  el('panel-post').hidden = !post;
  el('panel-album').hidden = post;
  updateDock();
  if (!post) loadAlbum();
}

el('tab-post').addEventListener('click', () => selectTab('post'));
el('tab-album').addEventListener('click', () => selectTab('album'));

// ---------------------------------------------------------------------
// 写真の選択
// ---------------------------------------------------------------------

el('pick').addEventListener('click', () => el('file').click());

el('file').addEventListener('change', (event) => {
  const files = Array.from(event.target.files || []);
  // 同じファイルを再選択できるように input はクリアする
  event.target.value = '';
  addFiles(files);
});

function addFiles(files) {
  // HEIC/HEIF は端末によって type が空で来ることがあるので拡張子でも見る。
  // 実際の形式変換 (JPEG化) は upload.js が canvas で行うので、ここでは
  // 「画像かどうか」だけを判定する。
  const images = files.filter((f) => f.type.startsWith('image/') || /\.(hei[cf])$/i.test(f.name));
  const dropped = files.length - images.length;
  const room = MAX_FILES - state.picked.length;
  const accepted = images.slice(0, Math.max(0, room));

  for (const file of accepted) {
    state.picked.push({ file, url: URL.createObjectURL(file) });
  }
  renderPreviews();
  setStatus('');
  // 黙って捨てると「選んだのに増えない」と見える。理由を必ず出す。
  if (images.length > accepted.length) {
    setStatus(`一度に送れるのは${MAX_FILES}枚までです。`, true);
  } else if (dropped > 0) {
    setStatus('写真だけ送れます (動画やその他のファイルは送れません)。', true);
  }
}

function removeAt(index) {
  const [removed] = state.picked.splice(index, 1);
  if (removed) URL.revokeObjectURL(removed.url);
  renderPreviews();
}

function renderPreviews() {
  const list = el('previews');
  list.replaceChildren();
  state.picked.forEach((item, index) => {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = '';
    li.append(img);
    if (!state.uploading) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'この写真を外す');
      remove.addEventListener('click', () => removeAt(index));
      li.append(remove);
    }
    list.append(li);
  });
  updateSubmit();
}

function updateSubmit() {
  const n = state.picked.length;
  const submit = el('submit');
  submit.disabled = n === 0 || state.uploading;
  updateDock();
  if (state.uploading) return;
  /*
   * 「送る」と枚数だけ。以前はここにイベント名を入れていたが、名前が長いと
   * 2行になって、肝心の「送る」が読み取りにくかった。どのパーティに送るのかは
   * ページ上部の帯 (イベント名) で示している。
   */
  el('submit-label').textContent = n <= 1 ? 'ボードに送る' : `${n}枚をボードに送る`;
}

function setStatus(message, isError = false) {
  const node = el('post-status');
  node.textContent = message;
  node.className = `status${isError ? ' error' : ''}`;
  // 文が出ている間はドックを閉じない (ドックの中に出しているため)
  state.status = message;
  updateDock();
}

// ---------------------------------------------------------------------
// 送るドック (上にスワイプ、またはタップで投稿)
//
// 「写真を選ぶ → 上に払う → 会場のスクリーンに出る」を一続きの動作にしたい。
// ドックは position: fixed で touch-action: none なので、ページのスクロールと
// 取り合いにならない (スクロール領域の中で上スワイプを拾うと区別できない)。
// ---------------------------------------------------------------------

/** ここまで持ち上げたら送る (px)。 */
const SEND_THRESHOLD = 56;
/** 指で持ち上げられる高さの上限 (px)。 */
const MAX_LIFT = 110;
/** 勢いよく払った場合のしきい値 (px/ms)。 */
const SEND_VELOCITY = -0.5;
/**
 * 勢いで送るときにも必要な最小の移動量 (px)。
 * これが無いと、指がほんの少し滑っただけ (数px を一瞬で) でも
 * 「速く払った」と判定されて誤送信になる。
 */
const MIN_FLING = 24;
/** 飛んでいく演出の長さ。join.css の transition と揃える。 */
const FLY_MS = 240;

/** ドックに重ねて見せるサムネイルの枚数。 */
const DOCK_STACK = 3;

let flying = false;

function updateDock() {
  const dock = el('senddock');
  const onPostTab = el('tab-post').getAttribute('aria-selected') === 'true';
  // 受付が終わっている (締切 / 開催日超過) なら出さない
  const accepting = state.event ? state.event.accepting : false;
  const show =
    onPostTab && accepting && (state.picked.length > 0 || state.uploading || !!state.status);
  dock.hidden = !show;
  // 内容がドックの下に隠れないよう、出ている間だけ余白を足す
  document.body.classList.toggle('dock-open', show);
  // 写真を選んだあとは、送るボタン (ドック) が主役になる。
  // 「写真を選ぶ」を赤のまま残すと主ボタンが2つになって、どちらを押すのか迷う。
  const pick = el('pick');
  const picked = state.picked.length > 0;
  pick.classList.toggle('secondary', picked);
  pick.textContent = picked ? '写真を追加' : '写真を選ぶ';
  el('privacy-note').hidden = !picked;
  el('senddock-hint').hidden = state.uploading;
  renderDockStack();
}

function renderDockStack() {
  const stack = el('senddock-stack');
  stack.replaceChildren();
  state.picked.slice(0, DOCK_STACK).forEach((item, i) => {
    const li = document.createElement('li');
    li.style.left = `${i * 9}px`;
    li.style.zIndex = String(DOCK_STACK - i);
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = '';
    li.append(img);
    stack.append(li);
  });
}

/** 上に飛ばしてから送信を始める (送信中の表示は同じ場所に戻ってくる)。 */
function flyAndSubmit() {
  if (flying || state.uploading || state.picked.length === 0) return;
  flying = true;
  const dock = el('senddock');
  // ドラッグ中のインラインスタイルが残っていると .flying の transform が効かない
  dock.style.transform = '';
  dock.classList.add('flying');
  setTimeout(() => {
    dock.classList.remove('flying');
    flying = false;
    submit();
  }, FLY_MS);
}

(function enableDockSwipe() {
  const dock = el('senddock');
  let startY = 0;
  let dy = 0;
  let startedAt = 0;
  let active = false;

  const end = () => {
    if (!active) return;
    active = false;
    dock.classList.remove('dragging');
    const elapsed = Math.max(1, Date.now() - startedAt);
    const flung = dy <= -MIN_FLING && dy / elapsed < SEND_VELOCITY;
    if (dy <= -SEND_THRESHOLD || flung) {
      flyAndSubmit();
      return;
    }
    dock.style.transform = '';
  };

  dock.addEventListener(
    'touchstart',
    (e) => {
      if (flying || state.uploading || state.picked.length === 0) return;
      active = true;
      dy = 0;
      startY = e.touches[0].clientY;
      startedAt = Date.now();
      dock.classList.add('dragging');
    },
    { passive: true },
  );

  dock.addEventListener(
    'touchmove',
    (e) => {
      if (!active) return;
      // 上方向だけ追従させる (下に引っ張っても動かない)
      dy = Math.max(-MAX_LIFT, Math.min(0, e.touches[0].clientY - startY));
      dock.style.transform = `translateY(${dy}px)`;
    },
    { passive: true },
  );

  dock.addEventListener('touchend', end);
  dock.addEventListener('touchcancel', () => {
    active = false;
    dock.classList.remove('dragging');
    dock.style.transform = '';
  });
})();

// ---------------------------------------------------------------------
// 投稿
// ---------------------------------------------------------------------

el('submit').addEventListener('click', flyAndSubmit);

async function submit() {
  if (state.picked.length === 0 || state.uploading) return;

  state.uploading = true;
  renderPreviews();
  setStatus(`送信中… 0/${state.picked.length}`);

  const files = state.picked.map((p) => p.file);
  const results = await uploadFiles(
    files,
    // 名前・ひとことは聞かない。写真を選んで送るだけにしてある
    // (入力欄があるぶんだけ手が止まり、送られない写真が増える)。
    { code: state.code, nickname: null, caption: null },
    (done, total) => setStatus(`送信中… ${done}/${total}`),
  );

  state.uploading = false;
  const failed = results.filter((r) => !r.ok);

  if (failed.length === 0) {
    for (const item of state.picked) URL.revokeObjectURL(item.url);
    state.picked = [];
    renderPreviews();
    setStatus('');
    showDone(results.length);
    return;
  }

  // 失敗したぶんだけ残す (押し直せばそのままリトライになる)
  const keep = new Set(failed.map((r) => r.file));
  for (const item of state.picked) {
    if (!keep.has(item.file)) URL.revokeObjectURL(item.url);
  }
  state.picked = state.picked.filter((item) => keep.has(item.file));
  renderPreviews();
  setStatus(`${failed.length}枚が送信できませんでした。${failed[0].error}`, true);
}

/** 「貼られた」感を出す短い演出。効果音は出さない (会場で鳴ると邪魔)。 */
function showDone(count) {
  // 承認モードでは、まだスクリーンに出ていないことを正しく伝える
  const waiting = state.event?.moderation === 'approval';
  const headline = waiting ? '幹事さんに送りました' : 'スクリーンに貼られました';
  const detail = waiting
    ? `${count}枚を送りました。<br />幹事さんの確認後にスクリーンへ貼られます。`
    : `${count}枚を送りました。<br />続けて投稿できます。`;

  const overlay = document.createElement('div');
  overlay.className = 'done';
  overlay.innerHTML = `
    <div class="done-card">
      <span class="mark">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2a5 5 0 0 1 5 5c0 2.2-1.4 4.1-3.3 4.8L13 22h-2l-.7-10.2A5 5 0 0 1 7 7a5 5 0 0 1 5-5z" />
        </svg>
      </span>
      <p><strong>${headline}</strong></p>
      <p>${detail}</p>
    </div>`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.append(overlay);
  setTimeout(() => overlay.remove(), 2600);

  // 枚数表示を更新しておく
  api
    .getEvent(state.code)
    .then(({ event, photo_count }) => {
      state.event = event;
      renderHeader(photo_count);
      applyStatus();
    })
    .catch((e) => console.warn('[join] refresh after upload failed', e));
}

// ---------------------------------------------------------------------
// アルバム
// ---------------------------------------------------------------------

async function loadAlbum() {
  const grid = el('grid');
  try {
    const { photos } = await api.listPhotos(state.code);
    state.photos = photos;
    el('album-empty').hidden = photos.length > 0;
    grid.replaceChildren();
    // 新しい写真が上に来たほうが探しやすい
    [...photos].reverse().forEach((photo) => {
      const button = document.createElement('button');
      button.type = 'button';
      const img = document.createElement('img');
      img.src = photo.public_url;
      img.alt = photo.caption || '';
      img.loading = 'lazy';
      // 100枚規模でも一気にデコードさせない
      img.decoding = 'async';
      button.append(img);
      button.addEventListener('click', () => openLightbox(photo));
      grid.append(button);
    });
  } catch (e) {
    el('album-empty').hidden = false;
    el('album-empty').textContent = errorMessage(e);
  }
}

el('reload').addEventListener('click', loadAlbum);

function openLightbox(photo) {
  const box = document.createElement('div');
  box.className = 'lightbox';

  const stage = document.createElement('div');
  stage.className = 'lightbox-image';
  const img = document.createElement('img');
  img.src = photo.public_url;
  img.alt = photo.caption || '';
  stage.append(img);

  const bar = document.createElement('div');
  bar.className = 'lightbox-bar';

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = [photo.caption, photo.nickname ? `${photo.nickname} さん` : '']
    .filter(Boolean)
    .join(' / ');

  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = '保存';
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = '保存中…';
    const ok = await downloadPhoto(photo, `partyboard-${photo.id.slice(0, 8)}.jpg`);
    save.textContent = ok ? '保存しました' : '別タブで開きました';
    setTimeout(() => {
      save.disabled = false;
      save.textContent = '保存';
    }, 2000);
  });

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '閉じる';
  close.addEventListener('click', () => box.remove());

  bar.append(who, save, close);
  box.append(stage, bar);
  document.body.append(box);
}

init();
