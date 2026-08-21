import { api } from './api.js';

/**
 * ブラウザからの写真アップロード。
 *
 * ■ EXIF (GPS位置情報) の除去について — 重要
 *   canvas に描き直して toBlob('image/jpeg') で書き出すため、出来上がった JPEG は
 *   ピクセルデータだけを持つ新しいファイルになる。元ファイルの EXIF (GPS座標・
 *   撮影日時・端末情報) は一切引き継がれない。
 *
 *   「縮小が不要なサイズだから元ファイルをそのまま送る」という最適化を入れると
 *   位置情報がそのまま会場スクリーンに載るので、絶対にしないこと。
 *
 *   なお写真の向き (EXIF Orientation) は、ブラウザが <img> をデコードする時点で
 *   適用済みになる (naturalWidth/Height も回転後の値)。そのまま描けば正しい向きで
 *   保存され、向き情報を失っても見た目は崩れない。
 */

/** 長辺の上限。会場のスクリーンに映すのに十分。 */
const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.8;

/** 同時アップロード数。 */
const CONCURRENCY = 2;

/** 1回で選べる枚数の上限。 */
export const MAX_FILES = 20;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // iPhone は accept="image/*" の input 経由なら通常 JPEG に変換されるが、
      // 変換されず HEIC のまま来た場合など、ブラウザがデコードできないケース。
      reject(
        new Error(
          'この写真の形式に対応できませんでした (HEIC など)。別の写真でお試しください。',
        ),
      );
    };
    img.src = url;
  });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('写真の変換に失敗しました。'))),
      'image/jpeg',
      JPEG_QUALITY,
    );
  });
}

/**
 * 縮小 + JPEG化。返り値の blob には EXIF が含まれない (上のコメント参照)。
 */
export async function prepareJpeg(file) {
  const img = await loadImage(file);
  const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  // 白で塗ってから描く (透過PNGを選ばれた場合に黒くならないように)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const blob = await canvasToBlob(canvas);
  // iOS Safari は canvas を保持し続けるとメモリを食うので明示的に潰す
  canvas.width = 0;
  canvas.height = 0;
  return { blob, width, height };
}

async function uploadOne(file, params) {
  const { blob, width, height } = await prepareJpeg(file);
  const presigned = await api.presignUpload(params.code);

  // 写真の実体は R2 へ直接 PUT する (サーバーを経由させない = 転送量を使わない)。
  //
  // ここが**ブラウザ固有の失敗点**。R2 バケットに CORS が設定されていないと、
  // ブラウザはプリフライトの時点で止めてしまい、fetch は TypeError を投げる
  // (ネットワーク断と区別が付かない)。素のメッセージは "Failed to fetch" など
  // 英語なので、ゲストに見せる文言に置き換えて、原因の切り分け情報は console に出す。
  let put;
  try {
    put = await fetch(presigned.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    });
  } catch (e) {
    console.error(
      '[upload] R2 への PUT がブラウザから送れませんでした。' +
        'バケットの CORS 設定 (AllowedOrigins に このページのオリジン / AllowedMethods に PUT / ' +
        'AllowedHeaders に content-type) を確認してください。開発者は npm run check:cors で判定できます。',
      e,
    );
    // 「N枚が送信できませんでした。」に続けて出るので、ここは理由だけを書く
    throw new Error('通信状況を確認して、もう一度お試しください。');
  }
  if (!put.ok) {
    console.error('[upload] R2 PUT failed', put.status);
    throw new Error('写真の送信に失敗しました。もう一度お試しください。');
  }

  const { photo } = await api.commitPhoto({
    code: params.code,
    photoId: presigned.photo_id,
    nickname: params.nickname,
    caption: params.caption,
    width,
    height,
    bytes: blob.size,
  });
  return photo;
}

/**
 * 複数枚を CONCURRENCY 枚ずつ並列でアップロードする。
 * 1枚の失敗で全体を止めず、結果を枚数ぶん返す。
 */
export async function uploadFiles(files, params, onProgress) {
  const results = new Array(files.length);
  let done = 0;
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      try {
        results[index] = { ok: true, photo: await uploadOne(files[index], params) };
      } catch (e) {
        console.warn('[upload] failed', files[index]?.name, e);
        results[index] = {
          ok: false,
          error: e?.message || '送信できませんでした。',
          file: files[index],
        };
      }
      done++;
      onProgress?.(done, files.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()),
  );
  return results;
}

/**
 * 写真を端末に保存する。
 *
 * R2 は別オリジンなので <a download> は効かない (ブラウザが download 属性を無視して
 * 遷移してしまう)。CORS 済みの GET で blob にしてから保存する。それも失敗したら
 * 新しいタブで開き、長押しで保存してもらう。
 */
export async function downloadPhoto(photo, filename) {
  try {
    const res = await fetch(photo.public_url, { mode: 'cors' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  } catch (e) {
    console.warn('[download] blob download failed, opening in new tab', e);
    window.open(photo.public_url, '_blank', 'noopener');
    return false;
  }
}
