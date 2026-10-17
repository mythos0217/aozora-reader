# 青空リーダー（Webアプリ版）

iPhoneのホーム画面から起動して使う、青空文庫の読書アプリです。Xcodeも開発者登録も要りません。

- 青空文庫の全作品（約17,000）を検索して、縦書き・ふりがな付きで読めます
- 一度開いた本文と作品目録は端末に保存されるので、通信がなくても読めます
- 本棚、気に入ったことばの保存、AIによる語句の意味・あらすじ・作品解説・論文の論点整理・おすすめ
- AIは自分のAPIキー（Anthropic / OpenAI / Google）で動きます

## 公開する（GitHub Pages・無料・Macのブラウザで10分）

1. https://github.com でアカウントを作ってログインします。
2. 右上の「＋」→「New repository」。名前を `aozora-reader` にし、**Public** を選んで「Create repository」。
3. 「uploading an existing file」をクリックし、このフォルダの中身をまとめてドラッグして「Commit changes」。
   `index.html` `app.js` `sw.js` `manifest.webmanifest` `gaiji.json` `README.md` と `icons` フォルダ（中身ごと）。
4. 作品目録を自動で作る設定を入れます（Macでは `.github` フォルダが見えないので、手で作ります）。
   リポジトリのトップで「Add file」→「Create new file」。
   ファイル名の欄に `.github/workflows/catalog.yml` と入力し（`/` を打つとフォルダになります）、
   本文に `catalog.yml` の中身をすべて貼り付けて「Commit changes」。
5. 上の「Actions」タブを開き、「目録を更新」に緑のチェックが付くまで1〜2分待ちます。
   リポジトリに `catalog.json` が増えていれば成功です。以後は毎週月曜の朝に自動で更新されます。
6. 「Settings」→ 左の「Pages」。「Branch」を `main`、フォルダを `/ (root)` にして「Save」。
7. 1〜2分待つと `https://（ユーザー名）.github.io/aozora-reader/` が表示されます。これがアプリのURLです。

## iPhoneに入れる

1. iPhoneの **Safari** で上のURLを開きます。
2. 共有ボタン（□に↑）→「ホーム画面に追加」→「追加」。
3. ホーム画面の「青空リーダー」アイコンから起動します。初回だけ、作品目録（数MB）をダウンロードします。

## AIを使う

アプリの「設定」でサービスを選び、APIキーを貼り付けて「保存して接続テスト」を押します。

- Anthropic: https://console.anthropic.com/settings/keys
- OpenAI: https://platform.openai.com/api-keys
- Google: https://aistudio.google.com/apikey

キーはそのiPhoneの中にだけ保存され、選んだサービスへ直接送られます。GitHubに置くファイルにキーは含まれないので、公開リポジトリでも漏れません。モデル名は設定で変えられます。

## 更新するとき

GitHubのリポジトリに新しいファイルを同じ名前でアップロードし直します。`sw.js` 先頭の `VERSION` を `v2` などに上げると、iPhone側でも確実に新しい版に切り替わります。

## データの出どころ

- 作品目録：青空文庫の「公開中 作家別作品一覧拡充版」を、このリポジトリの GitHub Actions が毎週 catalog.json に変換
- 本文：aozorahack が公開している青空文庫テキストのミラー（aozorahack/aozorabunko_text）
- 外字：JIS X 0213 の第3・第4水準をUnicodeに置き換える対応表（gaiji.json）
- 論文：J-STAGE WebAPI（CiNii ResearchはアプリIDを設定した場合）
- 作品解説の下地：Wikipedia日本語版

作品本文は青空文庫の公開データです。入力・校正に携わったボランティアの方々に感謝します。
