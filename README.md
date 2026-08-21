# PartyBoard Web (ゲスト投稿ページ / 会場スクリーン)

ビルド工程なしの素の HTML/CSS/JS。このフォルダの中身をそのまま静的ホスティングに
置けば動く。

| ファイル | 役割 |
|---|---|
| `join.html` / `join.js` / `join.css` | ゲストの投稿ページ + アルバム閲覧 (スマホ縦持ち前提) |
| `screen.html` / `screen.js` / `board.css` | 会場スクリーン (コルクボード表示) |
| `board.js` | コルクボードの配置エンジン (screen.html から使う) |
| `api.js` | Edge Function `party-api` のクライアント |
| `upload.js` | 縮小・EXIF除去・アップロード・ダウンロード |
| `config.js` | Supabase URL / anon キー / 報告先。**設定を変えるのはここだけ** |

`config.js` に置いてあるのは公開情報のみ (Supabase の anon キーは公開してよいキー)。
service role キーは絶対に置かない。

## 使い方 (URL)

```
join.html?c=ABC123     ゲストが読むQRの行き先
screen.html?c=ABC123   会場のPCで開いて全画面にする
```

`c=` はイベントコード (6文字)。QRコードはアプリのイベント詳細画面が生成する。

## デプロイ (GitHub Pages)

`Toru-hub0/party-web` (public) に**このフォルダの中身**を置き、Pages を有効にする。

```bash
# 初回
cd C:\Users\toru_\Projects\party-board\web
git init
git remote add origin https://github.com/Toru-hub0/party-web.git
git add -A
git commit -m "PartyBoard web pages"
git branch -M main
git push -u origin main
# → GitHub の Settings → Pages → Source: Deploy from a branch (main / root)
```

公開URLが `https://toru-hub0.github.io/party-web` 以外になった場合は、
アプリ側の `app.json` の `extra.webBase` を合わせて直す (QRの行き先がここから作られる)。

> `web/` を別リポジトリに push する運用なので、`party-board` 本体のリポジトリにも
> 同じファイルが入っている。編集はこちら (`party-board/web/`) を正として、
> `party-web` へはコピーを push する。

## ローカルでの確認

Supabase / R2 の準備前でも、モックサーバーで動きを確認できる。

```bash
cd C:\Users\toru_\Projects\party-board
npm run mock -- --seed 14      # 写真14枚入りで起動、招待コードが表示される
```

表示された join / screen の URL をブラウザで開く。`?api=` はローカルのときだけ
有効な差し替え用パラメータ (`config.js` 参照)。

モックには Realtime が無いので、screen.html は「ポーリングのみ」で動く
(15秒ごとに新着を拾う)。即時反映の確認は本番のデプロイ後に行う。

## 会場での使い方

1. 会場のPCのブラウザで `screen.html?c=...` を開く
2. 右上の「全画面」を押す (マウスを動かすとボタンが出る)
3. ブラウザを閉じないでそのまま置いておく

- 画面が消えないよう Wake Lock を要求する。Safari など未対応のブラウザでは効かないので、
  OS 側の「スリープしない」設定を併せて確認する
- 通信が切れても、復帰時に自動で再購読 + 差分取得する
- 写真は直近30枚を表示し、古いものから静かに入れ替わる
- 新着が2分無いと、それまでの写真をゆっくり見せるスライドショーに移る。新着で即復帰する
