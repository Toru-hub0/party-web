/**
 * コルクボードの描画エンジン。
 *
 * 「写真を貼る / 外す / 貼り直す」だけを担当し、通信も Realtime も知らない。
 * 分けてあるのは、この配置ロジックがいちばん間違いやすく、ブラウザ無しでも
 * 試せるようにしておきたいため (scripts/test-board.mjs)。
 *
 * 配置の方針 (指示書 §4.4「埋め尽くし」):
 *   完全なランダム配置は、固まったり画面外に寄ったりする。そこで仮想グリッドの各マスに
 *   「積層カウント」を持たせ、常にカウントが最小のマスからランダムに選んで貼る。
 *   1周目は均等に埋まり、2周目以降は自然な重ね貼りになる。新しいものほど手前
 *   (z-index を増やしていく)。古い写真は消さない。
 *
 *   DOM のカード数が上限 (maxCards) を超えたら、**完全に下に埋もれて見えていない**
 *   最古のカードだけを間引く。見た目は変わらないので「消えた」と気づかれない。
 */

/** カードの傾きの範囲 (度)。 */
const MAX_TILT = 8;

/** マスの外周に空ける余白 (px)。木枠に食い込ませない。 */
const MARGIN = 34;

/**
 * 木枠の下にカードが潜らないようにする内側の余白。
 *
 * 枠は左右22px (上下も同じ幅の帯を ::before/::after で描いている)。カードは
 * ±8度 傾けているので、見た目の四隅は矩形より 20px ほど外へ出る。両方を足して
 * この値まで内側に収める。マスの計算 (MARGIN) と分けているのは、端のマスだけを
 * 押し込めば済み、格子そのものを変えなくてよいから。
 */
const EDGE = 44;

/**
 * 「埋もれている」判定に使う格子の細かさ。カードの矩形を GRID×GRID 点で
 * サンプリングし、全部が後から貼られたカードに覆われていれば埋もれたとみなす。
 * 厳密な多角形演算をせずに済み、テストでも同じ結果が出る。
 */
const BURIED_SAMPLES = 5;

export function createBoard({
  container,
  /**
   * 仮想グリッドのマス数の目安。カード1枚の大きさはこれで決まる
   * (枚数の上限ではない — 上限は maxCards)。
   */
  slotCount = 30,
  /**
   * DOM に置くカードの最大数。超えたら埋もれた最古のカードを間引く。
   * 250枚あたりから描画が重くなる端末があるため (指示書 §4.4)。
   */
  maxCards = 250,
  /** 左上のイベント名・右下のQRなど、カードを置きたくない領域の要素。 */
  reservedElements = [],
  /** 枚数が 0 ⇔ 1 以上 に変わったときに呼ばれる。 */
  onCountChange = null,
  /** テスト用の乱数 (既定は Math.random)。 */
  random = Math.random,
  /** テスト用のウィンドウ (既定は globalThis)。 */
  view = typeof window !== 'undefined' ? window : globalThis,
} = {}) {
  /** 貼ってあるカード。古い順。 */
  let cards = [];
  let slots = [];
  /** 手前・奥の順序。貼るたびに増やして z-index に使う (新しいほど手前)。 */
  let seq = 0;

  // -------------------------------------------------------------------
  // マスの計算
  // -------------------------------------------------------------------

  /**
   * 明示的に指定されたマス数。null なら画面の縦横比から自動で決める。
   * 幹事がアプリから変えられる (party_events.screen_cols / screen_rows)。
   */
  let grid = null;

  /** 実際に使っている格子 (自動で決めた場合も入る)。inspect() で覗ける。 */
  let gridInUse = null;

  /**
   * 貼り方。'scatter' = すこし傾けて重ねる (既定) / 'neat' = 傾けず重ねない。
   * 写真の下のひとことと名前を出すかも、幹事がアプリから変えられる。
   */
  let style = 'scatter';
  let showLabels = true;

  /** 見せ方を差し替える。変わったときだけ貼り直す。 */
  function setLook(next) {
    const nextStyle = next?.style === 'neat' ? 'neat' : 'scatter';
    // null / undefined は「出す」(既定)。false のときだけ隠す。
    const nextLabels = next?.labels !== false;
    if (nextStyle === style && nextLabels === showLabels) return;
    style = nextStyle;
    showLabels = nextLabels;
    container.classList.toggle('no-labels', !showLabels);
    // 傾きは貼ったときに決めているので、貼り方を変えたら振り直す
    relayout({ retilt: true });
  }

  /** 配置を差し替える。変わったときだけ貼り直す。 */
  function setGrid(next) {
    const cols = Number(next?.cols) || null;
    const rows = Number(next?.rows) || null;
    const same = grid ? grid.cols === cols && grid.rows === rows : cols === null && rows === null;
    grid = cols && rows ? { cols, rows } : null;
    if (!same) relayout();
  }

  function layoutSlots() {
    const boardW = Math.max(320, view.innerWidth - MARGIN * 2);
    const boardH = Math.max(240, view.innerHeight - MARGIN * 2);

    // 指定があればそれに従う。無ければ slotCount 枚が1周で入る格子を、
    // 画面の縦横比に合わせて決める。
    const aspect = boardW / boardH;
    const cols = grid ? grid.cols : Math.max(2, Math.round(Math.sqrt(slotCount * aspect)));
    const rows = grid ? grid.rows : Math.max(2, Math.ceil(slotCount / cols));
    gridInUse = { cols, rows };

    const slotW = boardW / cols;
    const slotH = boardH / rows;

    /*
     * カードの高さは 写真(4:3) + 下の文字 + 余白 でおおよそ幅の 0.95 倍 + 20px。
     * 文字を出さないときはその分だけ低い。
     *
     * scatter はマスより少し大きくして重なりを作る。neat はマスより小さくして
     * 重ならないようにする (「きちんと並べる」の見た目)。
     */
    const ratio = showLabels ? 0.95 : 0.8;
    const fill = style === 'neat' ? 0.92 : 1.08;
    const fillH = style === 'neat' ? 0.92 : 1.06;
    const byWidth = slotW * fill;
    const byHeight = (slotH * fillH - 20) / ratio;
    const cardW = Math.max(120, Math.min(byWidth, byHeight));
    const cardH = cardW * ratio + 20;
    container.style.setProperty('--card-w', `${Math.round(cardW)}px`);

    // 左上のイベント名と右下のQRに重なるマスは使わない
    const reserved = reservedElements
      .filter(Boolean)
      .map((node) => node.getBoundingClientRect())
      // jsdom や描画前は全部 0 になる。その場合は予約なしとして扱う。
      .filter((r) => r.width > 0 && r.height > 0);

    const next = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cx = MARGIN + slotW * (col + 0.5);
        const cy = MARGIN + slotH * (row + 0.5);
        const rect = {
          left: cx - cardW / 2,
          top: cy - cardH / 2,
          right: cx + cardW / 2,
          bottom: cy + cardH / 2,
        };
        if (reserved.some((r) => intersects(rect, r))) continue;
        // stack = このマスに何枚貼ったか。少ないマスから埋めていく。
        next.push({ cx, cy, slotW, slotH, cardW, cardH, stack: 0 });
      }
    }

    // 貼る順番をばらけさせる (左上から順に埋まると機械的に見える)
    slots = shuffle(next, random);
    return slots;
  }

  /**
   * 次に貼るマスを選ぶ。積んである枚数が最小のマスの中からランダムに選ぶので、
   * 1周目は均等に埋まり、2周目以降は満遍なく重なっていく。
   */
  function pickSlot() {
    if (!slots.length) return null;
    let min = Infinity;
    for (const slot of slots) if (slot.stack < min) min = slot.stack;
    const candidates = slots.filter((s) => s.stack === min);
    return candidates[Math.floor(random() * candidates.length)] ?? candidates[0];
  }

  function placeCard(card) {
    const slot = card.slot;
    // マス内でのずらし量。カードがマスより大きいぶんは、はみ出して重なる。
    // neat のときはずらさない (マスの中央にきちんと置く)。
    const spread = style === 'neat' ? 0 : 1;
    const jitterX = spread * (random() - 0.5) * Math.max(10, slot.slotW * 0.3);
    const jitterY = spread * (random() - 0.5) * Math.max(10, slot.slotH * 0.26);
    // 端のマスは、ずらした結果が枠の下に入らないところまで押し戻す。
    // floor しているのは、このあと Math.round で 1px 未満だけ外へ出るのを防ぐため
    // (カードの幅・高さは割り算の結果なので小数になる)。
    const maxLeft = Math.max(EDGE, Math.floor(view.innerWidth - EDGE - slot.cardW));
    const maxTop = Math.max(EDGE, Math.floor(view.innerHeight - EDGE - slot.cardH));
    const left = Math.round(clampTo(slot.cx - slot.cardW / 2 + jitterX, EDGE, maxLeft));
    const top = Math.round(clampTo(slot.cy - slot.cardH / 2 + jitterY, EDGE, maxTop));
    card.el.style.left = `${left}px`;
    card.el.style.top = `${top}px`;
    card.el.style.setProperty('--rot', `${card.rot}deg`);
    card.rect = { left, top, right: left + slot.cardW, bottom: top + slot.cardH };
  }

  // -------------------------------------------------------------------
  // カードのDOM
  // -------------------------------------------------------------------

  function buildCardElement(photo, index) {
    const doc = container.ownerDocument;
    const card = doc.createElement('div');
    // 画鋲とマスキングテープを交互に。全部同じだと壁紙のように見える。
    card.className = index % 2 === 1 ? 'card taped' : 'card';
    card.dataset.photoId = photo.id;

    const pin = doc.createElement('span');
    pin.className = 'pin';

    const img = doc.createElement('img');
    img.className = 'shot';
    img.src = photo.public_url;
    img.alt = photo.caption || '';
    img.decoding = 'async';
    // 読めなかった写真でカードだけ残ると不自然なので、その場で外す
    img.addEventListener('error', () => {
      console.warn('[board] image failed', photo.public_url);
      remove(photo.id, { animate: false });
    });

    const label = doc.createElement('div');
    label.className = 'label';
    if (photo.caption) {
      const caption = doc.createElement('span');
      caption.className = 'caption';
      caption.textContent = photo.caption;
      label.append(caption);
    }
    if (photo.nickname) {
      const who = doc.createElement('span');
      who.className = 'who';
      who.textContent = `${photo.nickname} さん`;
      label.append(who);
    }

    card.append(pin, img, label);
    return card;
  }

  // -------------------------------------------------------------------
  // 公開API
  // -------------------------------------------------------------------

  /**
   * 写真1枚が、後から貼られたカードだけで完全に隠れているか。
   * カードの矩形を格子状にサンプリングして、全点が覆われていれば埋もれている。
   */
  function isBuried(card) {
    if (!card.rect) return false;
    const later = cards.filter((c) => c.z > card.z && c.rect);
    if (!later.length) return false;
    const { left, top, right, bottom } = card.rect;
    for (let i = 0; i < BURIED_SAMPLES; i++) {
      for (let j = 0; j < BURIED_SAMPLES; j++) {
        const x = left + ((right - left) * (i + 0.5)) / BURIED_SAMPLES;
        const y = top + ((bottom - top) * (j + 0.5)) / BURIED_SAMPLES;
        const covered = later.some(
          (c) => x >= c.rect.left && x <= c.rect.right && y >= c.rect.top && y <= c.rect.bottom,
        );
        if (!covered) return false;
      }
    }
    return true;
  }

  /**
   * 上限を超えたぶんを間引く。外すのは「完全に埋もれた最古のカード」だけなので
   * 見た目は変わらない。埋もれたカードが見つからないときは何もしない
   * (見えているカードを消すより、DOM が少し増えるほうが害が小さい)。
   */
  function pruneBuried() {
    let guard = 0;
    while (cards.length > maxCards && guard++ < maxCards) {
      const victim = cards.find((c) => isBuried(c));
      if (!victim) return;
      removeCard(victim, { animate: false });
    }
  }

  /** 写真を1枚貼る。既に貼ってあれば何もしない。 */
  function add(photo, { animate = true } = {}) {
    if (!photo?.id || !photo.public_url) return null;
    if (cards.some((c) => c.photo.id === photo.id)) return null;
    if (!slots.length) layoutSlots();

    const slot = pickSlot();
    if (!slot) return null;

    const card = {
      photo,
      slot,
      z: ++seq,
      rot: style === 'neat' ? 0 : (random() * 2 - 1) * MAX_TILT,
      el: buildCardElement(photo, cards.length),
    };
    slot.stack++;
    // 新しいものほど手前。貼った順がそのまま重なりの順になる。
    card.el.style.zIndex = String(card.z);
    placeCard(card);
    if (animate) card.el.classList.add('arrive');
    container.append(card.el);
    cards.push(card);

    if (animate) {
      // 落ちてきた1枚が他のカードの下に潜らないように、演出中だけ手前に置く
      setTimeout(() => card.el.classList.remove('arrive'), 1000);
    }
    // 増えすぎたら、埋もれて見えていない古いカードだけを静かに外す
    pruneBuried();
    onCountChange?.(cards.length);
    return card;
  }

  function removeCard(card, { animate = true } = {}) {
    cards = cards.filter((c) => c !== card);
    // 外したぶんはマスの積みを減らす (また優先的に使われるようになる)
    if (card.slot && card.slot.stack > 0) card.slot.stack--;
    if (animate) {
      card.el.classList.add('leave');
      setTimeout(() => card.el.remove(), 800);
    } else {
      card.el.remove();
    }
    onCountChange?.(cards.length);
  }

  /** 写真IDで外す。 */
  function remove(photoId, options = {}) {
    const card = cards.find((c) => c.photo.id === photoId);
    if (card) removeCard(card, options);
    return !!card;
  }

  /** 画面サイズが変わったら全部貼り直す (演出なし。枚数は変えない)。 */
  function relayout({ retilt = false } = {}) {
    const existing = [...cards];
    layoutSlots();
    for (const card of existing) {
      if (retilt) card.rot = style === 'neat' ? 0 : (random() * 2 - 1) * MAX_TILT;
      const slot = pickSlot();
      if (!slot) {
        // マスが1つも作れない (画面が極端に小さい) ときだけ外す
        removeCard(card, { animate: false });
        continue;
      }
      card.slot = slot;
      slot.stack++;
      placeCard(card);
    }
  }

  return {
    add,
    remove,
    relayout,
    layoutSlots,
    setGrid,
    setLook,
    has: (photoId) => cards.some((c) => c.photo.id === photoId),
    ids: () => cards.map((c) => c.photo.id),
    get count() {
      return cards.length;
    },
    /** テスト・デバッグ用に配置結果を覗く。 */
    inspect: () => ({
      slots: slots.length,
      /** いま使っている格子。指定が無ければ自動で決めた値。 */
      grid: gridInUse,
      style,
      showLabels,
      stacks: slots.map((s) => s.stack),
      cards: cards.map((c) => ({ id: c.photo.id, rot: c.rot, z: c.z, rect: c.rect })),
    }),
  };
}

function clampTo(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function intersects(a, b) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function shuffle(items, random) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
