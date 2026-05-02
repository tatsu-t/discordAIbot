# Discord AI Bot

URLをDiscordに貼ると自動でスクレイピング・AI要約してスレッドに投稿するBotです。スレッド内でそのページについて質問することもできます。

## 機能

- 指定チャンネルのURLを検知 -> スクレイピング -> AIが日本語で要約 -> スレッド作成して投稿
- GitHubリポジトリの場合はREADMEも自動取得して要約に含める
- スレッド内での質問に対し、質問の難易度に応じてモデルを自動選択して回答
- AIが必要と判断した場合、関連URLを追加取得（[FETCH:] ツールループ）
- X.com (Twitter) はステルスブラウザで取得、それ以外は軽量HTTPクライアント
- ボット検知によるブロック時はステルスモードで自動再試行

## アーキテクチャ

```
Discord
  |
  v
bot/main.js          (Discord.js, Node 20)
  |  URLを検知してスクレイパーAPIに送信
  |  AIモデルを呼び出して要約・回答生成
  v
scraper/app.py       (FastAPI + Scrapling, Python 3.12)
  |  ページ取得・テキスト/画像/リンク抽出
  v
Sakura AI API        (https://api.ai.sakura.ad.jp/v1/chat/completions)
```

## AIモデル構成

| 用途 | モデル |
|------|--------|
| 要約（テキストのみ） | `Qwen3-Coder-30B-A3B-Instruct` |
| 要約（画像あり） | `preview/Phi-4-multimodal-instruct` |
| 関連段落抽出 | `preview/Phi-4-mini-instruct-cpu` |
| 質問難易度判定 | `preview/Qwen3-0.6B-cpu` |
| スレッド回答（基本） | `Qwen3-Coder-30B-A3B-Instruct` |
| スレッド回答（高度） | `Qwen3-Coder-480B-A35B-Instruct-FP8` |

## チャンネル動作

| チャンネル | トリガー |
|-----------|---------|
| `CHANNEL_ANY_URL` | メッセージ内の任意のURL |
| `CHANNEL_MENTION_ONLY` | Botへのメンション + URL（またはURLを含むメッセージへのメンション返信） |

## セットアップ

### 必要なもの

- Docker / Docker Compose
- Discord Bot Token（Discord Developer Portal）
- Sakura AI APIキー

### 手順

1. リポジトリをクローン

```bash
git clone https://github.com/yourname/discordAIbot.git
cd discordAIbot
```

2. 環境変数ファイルを作成

`bot/.env` を以下の内容で作成してください：

```env
DISCORD_TOKEN=your_discord_bot_token
SAKURA_API_KEY=your_sakura_api_key
CHANNEL_ANY_URL=your_channel_id_here
CHANNEL_MENTION_ONLY=your_channel_id_here
```

3. 起動

```bash
docker compose up --build -d
docker logs discord-bot -f
```

`Logged in as BotName#0000` が表示されれば起動成功。

## Botの権限設定

Discord Developer Portal で以下を有効にしてください：

- Privileged Gateway Intents: `MESSAGE CONTENT INTENT`
- Bot Permissions: `Send Messages`, `Create Public Threads`, `Send Messages in Threads`, `Read Message History`

## ディレクトリ構成

```
discordAIbot/
├── bot/
│   ├── main.js          # Discord Bot本体
│   ├── Dockerfile
│   └── package.json
├── scraper/
│   ├── app.py           # スクレイピングAPI
│   └── Dockerfile
└── docker-compose.yml
```

## 環境変数

| 変数名 | 説明 |
|--------|------|
| `DISCORD_TOKEN` | Discord BotのAPIトークン |
| `SAKURA_API_KEY` | Sakura AI APIキー |
| `SCRAPER_API_URL` | スクレイパーAPIのURL（docker-composeで自動設定） |
| `CHANNEL_ANY_URL` | URL検知用チャンネルID |
| `CHANNEL_MENTION_ONLY` | メンション時のみ反応するチャンネルID |

## 使用ライブラリ・謝辞

スクレイピング部分には Scrapling を使用しています。
ボット検知回避・高速なページ取得・XPathによるコンテンツ抽出など、このプロジェクトの核心機能を支えています。
