# CandyBlast サーバー — Python (Flask) 版

元々 Node.js / Express で書かれていたサーバー(`server.js`)を、
**機能・挙動・APIのURLやレスポンス形式を変えずに** Python (Flask) へ移植したものです。

フロントエンド(`frontend/index.html` / `styles.css` / `script.js`)は**一切変更していません**。

```
.
├── render.yaml          ← Renderに一括デプロイするための設定ファイル
├── backend/
│   ├── app.py           ← Flaskアプリ本体
│   ├── requirements.txt
│   ├── runtime.txt      ← Pythonのバージョン指定
│   └── .env.example
└── frontend/
    ├── index.html
    ├── styles.css
    └── script.js
```

---

## 1. GitHubに新しいリポジトリを作る

1. GitHubで新規リポジトリを作成(Public/Privateどちらでも可)
2. このフォルダの中身を丸ごとpush

```bash
cd candyblast-py
git init
git add .
git commit -m "Initial commit: Python移植版"
git branch -M main
git remote add origin https://github.com/【あなたのアカウント】/【リポジトリ名】.git
git push -u origin main
```

---

## 2. Renderにデプロイする

### 方法A: render.yaml を使って一括デプロイ(おすすめ)

1. Renderのダッシュボードで **New +** → **Blueprint** を選択
2. 今pushしたGitHubリポジトリを選ぶ
3. `render.yaml` が自動で読み込まれ、以下の2つのサービスがまとめて作成されます
   - `candyblast-server`(バックエンド / Flask)
   - `candyblast-frontend`(フロントエンド / 静的サイト)
4. `sync: false` になっている環境変数の入力を求められるので、以下を入力
   - `DATABASE_URL` … **今使っているPostgresの Internal Database URL**(既存のものをそのまま使えます。DBの中身・テーブル構造は同じにしてあるので移行作業は不要です)
   - `JWT_SECRET` … 今のNode版と**同じ値**を入れると、既存ユーザーが再ログインせずに済みます(サーバーのEnvironmentタブから今の値を確認してコピーしてください)
   - `DISCORD_WEBHOOK_AUTH` / `DISCORD_WEBHOOK_LOGIN` / `DISCORD_WEBHOOK_FEATURE_REQUEST` / `DISCORD_WEBHOOK_BUG_REPORT` … 今使っているWebhook URLをそれぞれコピー
5. **Apply** を押すとデプロイが始まります

### 方法B: サービスを手動で1つずつ作る

**バックエンド:**
1. **New +** → **Web Service**
2. リポジトリを選択
3. 設定:
   - **Root Directory**: `backend`
   - **Runtime**: Python 3
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn -w 1 -b 0.0.0.0:$PORT app:app`
4. Environmentタブで上記の環境変数をすべて設定

**フロントエンド:**
1. **New +** → **Static Site**
2. リポジトリを選択
3. 設定:
   - **Root Directory**: `frontend`
   - **Build Command**: (空欄でOK)
   - **Publish Directory**: `.`

---

## 3. フロントエンドが新しいバックエンドを向くようにする

`frontend/script.js` の先頭付近に、接続先のバックエンドURLが書かれています。

```js
const API_BASE_URL = 'https://candyblast-server.onrender.com';
```

- **今のNode版サービスと同じ名前(`candyblast-server`)で新しいPython版を作った場合**: URLが変わらないので、この行は変更不要です
- **別の名前で作った場合**(例: `candyblast-server-py`): この行を新しいURLに書き換えてから、フロントエンドを再デプロイしてください

---

## 4. 動作確認 → 切り替え

1. まずはPython版を使って、ログイン・スコア送信・ランキング・ガチャなどひと通り動作確認してください
2. 問題なければ、今まで使っていたNode版のRenderサービスは**停止または削除**してOKです

⚠️ **注意**: イベント配布・週替わりチャレンジの自動生成は「1分ごとの定期実行」で動いています。Node版とPython版を**同時に**同じデータベースに向けたまま動かし続けると、両方が「まだ配布していない」と判断して二重に処理される可能性があります。動作確認は短時間にとどめ、本番切り替え時はNode版を止めてからPython版に一本化してください。

---

## ローカルでの開発・動作確認

```bash
cd backend
python3 -m venv venv
source venv/bin/activate      # Windowsは venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env          # 値を編集
python app.py
```

## 何が変わったか(技術詳細)

- サーバーの実装言語: Node.js/Express → Python/Flask
- DBアクセス: `pg` → `psycopg2`
- 認証: `jsonwebtoken` → `PyJWT`, `bcrypt`(npm) → `bcrypt`(pip)
- 定期実行(イベント配布・週替わりチャレンジ生成): `setInterval` → `APScheduler`
- Discord通知(画像添付含む): `fetch` + `FormData`/`Blob` → `requests`

エンドポイントのパス・メソッド・リクエスト/レスポンスのJSON形式、DBのテーブル構造は
元のNode版と完全に同じになるようにしてあります。
