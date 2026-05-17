# LINE × Gemini 自動応答ボット

LINE 公式アカウントに届いたメッセージを Google Gemini で生成した日本語で自動返信する、サーバーレス Bot です。**1 ファイル・依存パッケージ 1 個・Vercel 無料枠で動作**するという、最小コストで顧客応答を自動化することを目的とした個人プロダクトです。

---

## なぜ作ったか

問い合わせ対応の一次受け（FAQ や定型問い合わせ）に LINE 公式アカウントを使う中小事業者は多い一方、

- ChatGPT/Gemini を組み込もうとすると Make や Dify などの SaaS に **月数千円〜の固定費**がかかる
- 自前で組もうとすると LINE SDK・Express・ホスティングと選定が膨らみがち
- 一方で「やりたいこと」は **「メッセージを受けて AI で返す」だけ**

という課題感がありました。本プロジェクトは「**SDK もフレームワークも使わず、関数 1 個で本当に必要なものだけ書く**」というコンセプトで、ランニングコストをほぼゼロに抑えつつ運用可能な構成を目指しました。

---

## アーキテクチャ

```
 ┌──────────┐        ┌──────────────────────┐        ┌──────────────┐
 │  LINE    │  POST  │  Vercel Edge Network │ HTTPS  │  Gemini API  │
 │  Platform│ ─────▶ │  api/webhook.js      │ ─────▶ │ 2.5 Flash    │
 │          │        │  (Serverless Fn)     │        │              │
 └──────────┘ ◀───── │                      │ ◀───── └──────────────┘
       ▲   reply API └──────────────────────┘
       │                       │
       │  Loading animation    │
       └───────────────────────┘
```

| レイヤ | 採用技術 | 採用理由 |
|---|---|---|
| ランタイム | Vercel Serverless Function (Node.js, ESM) | コールドスタートが軽く、無料枠で十分。デプロイが `vercel --prod` の 1 コマンド |
| AI | Gemini 2.5 Flash | レイテンシ・コスト・日本語品質のバランスが現時点で最良 |
| LINE 連携 | 素の `fetch` で REST 直叩き | `@line/bot-sdk` を入れる利点が薄い（呼び出すのは 2 エンドポイントのみ）。bundle size と依存リスクの削減 |
| 署名検証 | `node:crypto` の HMAC-SHA256 + `timingSafeEqual` | タイミング攻撃対策を含めて標準モジュールのみで完結 |

---

## 技術的こだわり

### 1. 署名検証は「正しく」やる

LINE Webhook の改ざんチェックは [api/webhook.js](api/webhook.js) で実装。よくある実装ミスを避けるため、以下を担保しています:

- **生バイト列で検証**: `bodyParser: false` を指定してフレームワークによる body 加工を防止（[api/webhook.js:15-17](api/webhook.js#L15-L17)）。JSON.parse 後の再シリアライズでは署名が一致しません
- **タイミング安全比較**: `crypto.timingSafeEqual` を使用し、`===` による文字列比較を避ける
- **長さ不一致を握りつぶさない**: `timingSafeEqual` が長さ違いで throw した場合は `false` を返す（[api/webhook.js:47-51](api/webhook.js#L47-L51)）

### 2. UX: Gemini の応答待ち時間を隠す

`gemini-2.5-flash` でも数秒のレイテンシは発生するため、LINE の [Chat Loading API](https://developers.line.biz/en/reference/messaging-api/#display-a-loading-indicator) を叩いて「入力中…」アニメーションを表示しています（[api/webhook.js:59-71](api/webhook.js#L59-L71)）。これがあるだけで体感の応答性が大きく変わります。

### 3. 関数のタイムアウトを意識した設計

- `vercel.json` で `maxDuration: 30` を明示。Vercel Hobby のデフォルト 10 秒では Gemini のレスポンス次第で打ち切られる可能性がある
- 複数イベントは `Promise.all` で並列処理し、関数の総実行時間を最短化（[api/webhook.js:106-124](api/webhook.js#L106-L124)）
- 個別イベントの失敗は try/catch で隔離し、1 件のエラーで他の応答が落ちないようにしている

### 4. シークレットは絶対にログに出さない

開発中はデバッグログを入れていましたが、**シークレット長や先頭文字すらログに残さない**よう本番化前にすべて削除しました。Vercel の Functions Logs は管理画面から見えるため、ここに痕跡を残さない方針です。

---

## ディレクトリ構成

```
.
├── api/
│   └── webhook.js      # Webhook ハンドラ（128 行・全機能をここに集約）
├── .env.example        # 環境変数テンプレート
├── package.json        # 依存は @google/generative-ai のみ
├── vercel.json         # 関数のタイムアウト設定
└── README.md
```

---

## セットアップ

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 環境変数

`.env.example` をコピーして埋めます。

```bash
cp .env.example .env
```

| 変数 | 取得元 |
|---|---|
| `LINE_CHANNEL_SECRET` | LINE Developers Console → Messaging API → Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers Console → Messaging API → Channel access token |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/) |

### 3. Vercel 側にも環境変数を登録

ローカルの `.env` は Vercel には反映されないため、Production 環境にも登録します。

```bash
vercel env add LINE_CHANNEL_SECRET production
vercel env add LINE_CHANNEL_ACCESS_TOKEN production
vercel env add GEMINI_API_KEY production
```

### 4. デプロイ

```bash
npm run deploy
```

### 5. LINE 側の Webhook 設定

LINE Developers Console で:

1. **Webhook URL** に `https://<your-project>.vercel.app/api/webhook` を設定
2. **Webhook の利用** を ON
3. **応答メッセージ**（自動応答）を OFF
4. **検証** ボタンで疎通確認

---

## 動作確認

| URL | 期待されるレスポンス | 意味 |
|---|---|---|
| `/` | 404 | UI を持たないため正常 |
| `/api/webhook` (GET) | 405 | POST のみ受付 |
| `/api/webhook` (POST, 無効署名) | 401 | 署名検証が機能している |

---

## 既知の制約と今後の改善

実運用に向けては以下が必要だと認識していますが、本プロダクトでは **MVP の検証を優先**してスコープ外としました。

- [ ] **会話履歴の保持**: 現状は完全ステートレスで、ユーザーごとの文脈を持たない。Vercel KV や Upstash Redis で `userId` ごとに直近 N 件を保持する設計を検討中
- [ ] **レート制限**: 同一 userId からの連続リクエスト制御。短時間の大量送信で Gemini の課金が膨らむリスク
- [ ] **テスト**: 署名検証ロジックは Vitest で単体テスト可能。Webhook 全体は LINE のテストペイロードを使った integration test を整備したい
- [ ] **画像・スタンプ対応**: 現状はテキスト以外を黙って無視している。Gemini はマルチモーダル対応なので画像受信→画像理解応答に拡張可能
- [ ] **観測性**: 現状は Vercel の標準ログのみ。Sentry / Better Stack で Gemini の応答時間やエラー率を可視化したい

---

## 開発を通じて意識したこと

- **依存は最小に**: 「使うかもしれないライブラリ」を入れず、必要になってから入れる。今のところ `@google/generative-ai` だけで完結している
- **コメントよりコード**: 自明な処理にコメントを書かず、関数名と型で意図を伝える
- **早すぎる抽象化を避ける**: 1 ファイルで読み切れる規模では、レイヤー分割やクラス化のメリットより、上から下に読める単純さを優先
