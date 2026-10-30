<div align="right">
  <a href="#english-version"><strong>English</strong></a> | <a href="#日本語版"><strong>日本語</strong></a>
</div>

---

<!-- 
================================================================
  English Version Section
================================================================
-->
<h1 id="english-version">Chatbot</h1>

<img width="1918" height="917" alt="ss" src="https://github.com/user-attachments/assets/1efce700-8e3b-4320-92f3-d4c716aac420" />

## Overview
This is a chatbot frontend for Gemini. I created it to have the features I wanted, and it is designed entirely for a desktop environment.
* Please be aware that it has not been sufficiently tested, so there is a high possibility of bugs. Any feedback on issues found would be greatly appreciated. Performance with a large chat history has also not been verified.
* It supports text and image generation (nano banana). Other models are listed by default but are not actually usable.
* With the exception of function calling, it should allow for operations roughly equivalent to Google AI Studio. It also includes features like response replacement and an "Auto Inserted Messages" function.
> The "Auto Inserted Messages" feature is similar to the "Dummy prompt" feature in the Gemini PWA. It adds User and Model role parts to the input prompt before sending the request. It also supports file attachments, allowing you to use it for tasks like attaching reference materials for style guidance that follow recent instructions.

## Environment
- Node.js
- pnpm (v11+)

## Setup Instructions
1. Unzip the latest zip file (`chatbot_v*.zip`) from the Releases page and navigate to the extracted directory.
2. Ensure that your environment variables, including the path to Node.js, are set up correctly.
3. The following configuration files are managed on the backend:
   - `.env`: Used to specify backend behavior such as the model list and system prompt policy.
   - `key`: A file to write your Gemini API key into.
   - `system_instruction.txt`: Contains the default system prompt.

## How to Launch

### Easy Launch (Recommended)
**Windows:**
Double-click `launch.bat`. This will automatically install dependencies, start the server, and open the application in your browser.

**Mac/Linux:**
Run the following command in your terminal:
```bash
./launch.sh
```

### Manual Launch
1. Install the required packages (only for the first time).
   ```bash
   pnpm install --frozen-lockfile --prod
   ```
2. Start the server within the extracted directory.
   ```bash
   node server.js
   ```
3. Open your browser and go to `http://localhost:15101/chatbot` to use the application.

## Browser-only Version (PWA)
The same app also runs without the server: the provider code runs in the browser and calls each API directly with your own keys. It is published to GitHub Pages and can be installed as an app.

- Open **Data Management → Configuration** to set API keys (stored only in this browser, never exported), the settings from `.env` (`DEFAULT_MODEL`, `GEMINI_MODEL_FILTER`, `CLAUDE_MODEL_FILTER`, `SYSTEM_INSTRUCTION_MODE`, `OPENROUTER_MODELS`, `OPENROUTER_APP_URL`, `OPENROUTER_APP_TITLE`), `system_instruction.txt` and `openai-endpoints.json`. Blank fields and unedited files follow the defaults shipped with each build; edited files are kept until you press **Reset to Default**, and a notice appears when the default has changed since.
- The page is served over HTTPS, so browsers block OpenAI-compatible servers on plain HTTP (except usually `http://localhost`). The server must also allow cross-origin requests.
- Data is stored per site, so chats from the server version do not carry over; move them with Export / Import.
- Build it locally with `pnpm run build:pwa` in `frontend` (output: `frontend/dist-pwa`, base path `/Chatbot/`, override with `PWA_BASE`). `.github/workflows/pages.yml` deploys it on pushes to `main`; enable it under Settings → Pages → Source: GitHub Actions.

## Note on Data Management
The application uses the browser's IndexedDB to store data. Please be aware that data may be deleted due to browser settings or storage cleanup operations.

## Gemini Generation Settings

In **Settings → Generation Parameters**, configure each text Gemini model,
including Gemini through OpenRouter:

- **Service Tier**: Standard (default) or Flex. Flex allows longer waits and
  uses only Flex endpoints on OpenRouter; unavailable Flex routes fail instead
  of switching to Standard. Stop cancels the pending client request.
- **Writing Function Call**: off by default. Requires writing through a function
  call, then displays and saves the completed text as a normal model message.
  Other tools are paused for that request, and writing appears when complete.
- Metadata adds only `Tier: Flex` (or `Unknown` when unreported) and
  `Writing FC: Used`, with failure labels when needed. Save and Reset use the
  existing model-specific settings.

Run the frontend tests (Vitest) with `pnpm test` in the `frontend` directory.

## Regarding Behavior
* The system prompt saved in the model settings on the frontend is applied as a chat-specific setting when a new chat is created. Within a chat, the chat-specific system prompt is always used.
* The backend system prompt behavior is controlled by `SYSTEM_INSTRUCTION_MODE` in `.env`:
  - `frontend_first` (default): use the frontend prompt when present; otherwise use the backend default.
  - `default_first`: use the backend default when present, even if the frontend prompt is set.
  - `merge`: send the backend default followed by the frontend prompt.
* The frontend attachment size limit is baked in at build time from `VITE_MAX_UPLOAD_FILE_SIZE`. Whether a model uses inline data or the File API is determined by its backend capabilities.
* String replacement is executed once the response has been fully received. If the format is invalid, that specific replacement process will be skipped.
* **About the `key` file**:
  - Initially, a JSON template `key` file is provided.
  - Fill in the provider API key you want to use, such as `gemini`, `claude`, or `openrouter`.
  - When you set your API key and launch the application for the first time, the file is automatically renamed to `key_valid` for security purposes.
* **OpenAI-compatible endpoints (vLLM, etc.)**:
  - Set `OPENAI_COMPAT_CONFIG` in `.env` to the path of a JSON file describing the endpoint. Example:
    ```json
    {
      "label": "vLLM (Local)",
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "EMPTY",
      "models": ["Qwen/Qwen3-8B"],
      "request": {
        "chat_template_kwargs": { "reasoning_effort": "no_think" }
      }
    }
    ```
  - `request` is deep-merged into every chat completion body, so server-specific extensions such as vLLM's `chat_template_kwargs` pass through as-is (config values win over UI parameters).
  - `models` is optional; when omitted, every model reported by the endpoint's `/v1/models` is listed.
  - To register multiple endpoints, make the JSON file an array of such objects (each may set its own `id` and `label`).

<br>
<br>

---
<br>
<br>

<!-- 
================================================================
  日本語版セクション
================================================================
-->
<h1 id="日本語版">Chatbot</h1>

<img width="1918" height="917" alt="ss" src="https://github.com/user-attachments/assets/1efce700-8e3b-4320-92f3-d4c716aac420" />

## 概要
Gemini向けのチャットボットフロントエンドです。自分が欲しい機能を求めて作成しました。完全にデスクトップ環境向けの設計となっています。
* 十分なテストを実施できていません。バグの可能性は大いにあり得ますので、ご注意ください。問題が確認された場合は、フィードバックをいただければ幸いです。また、履歴が肥大化した際等のパフォーマンスについても未検証です。
* テキスト及び画像生成（nano banana）に対応しています。その他モデルもデフォルトではモデル一覧に表示されるようになっていますが、実際には利用不可能です。
* function callingを除けば、概ねGoogle AI Studioと同等の操作が可能になっていると思われます。その他、レスポンスの置換機能、自動parts挿入機能（Auto Inserted Messages）といったものも実装しています。
> 自動parts挿入機能は、Gemini PWAにおけるDummy prompt機能と同様のものです。入力プロンプトに対して、Userロール及びModelロールのpartsを追加してリクエストを行います。ファイル添付にも対応しているため、描写統制用の資料を直近の指示に追従させるといった使い方も可能です。

## 環境
- Node.js
- pnpm（v11以降）

## セットアップ手順
1. Releaseにある最新のzipファイル（`chatbot_v*.zip`）を解凍し、展開されたディレクトリに移動します。
2. Node.js を含む環境変数が適切に設定されていることを確認します。
3. バックエンドで管理する設定ファイルは次の通りです。
   - `.env`モデル一覧やシステムプロンプトの扱いなど、バックエンドの挙動を指定します。
   - `key`GeminiのAPIキーを記述するためのファイルです。
   - `system_instruction.txt`デフォルトのシステムプロンプトを記述します。

## 起動方法

### 簡単な起動（推奨）
**Windows:**
`launch.bat` をダブルクリックします。依存関係の自動インストール、サーバー起動、ブラウザの自動起動が行われます。

**Mac/Linux:**
ターミナルで以下を実行します：
```bash
./launch.sh
```

### 手動起動
1. 依存パッケージをインストールします（初回のみ）。
   ```bash
   pnpm install --frozen-lockfile --prod
   ```
2. 展開されたディレクトリ内でサーバーを起動します。
   ```bash
   node server.js
   ```
3. ブラウザで `http://localhost:15101/chatbot` にアクセスするとアプリケーションを利用できます。

## ブラウザ版（PWA）
サーバーなしでも同じアプリを利用できます。プロバイダの処理はブラウザ内で動作し、各APIへ自分のキーで直接リクエストします。GitHub Pages で公開しており、アプリとしてインストールすることもできます。

- **Data Management → Configuration** で、APIキー（このブラウザにのみ保存され、エクスポートには含まれません）、`.env` 相当の設定（`DEFAULT_MODEL`、`GEMINI_MODEL_FILTER`、`CLAUDE_MODEL_FILTER`、`SYSTEM_INSTRUCTION_MODE`、`OPENROUTER_MODELS`、`OPENROUTER_APP_URL`、`OPENROUTER_APP_TITLE`）、`system_instruction.txt`、`openai-endpoints.json` を設定します。空欄の項目や編集していないファイルは、ビルドに含まれるデフォルトに従います。編集したファイルは **Reset to Default** を押すまで保持され、その後デフォルトが更新された場合は通知が表示されます。
- ページは HTTPS で配信されるため、HTTP の OpenAI 互換サーバーにはブラウザが接続を許可しません（`http://localhost` は通常許可されます）。また、サーバー側でクロスオリジンのリクエストを許可する必要があります。
- データはサイトごとに保存されるため、サーバー版のチャットは引き継がれません。エクスポート／インポートで移してください。
- ローカルでは `frontend` で `pnpm run build:pwa` を実行するとビルドできます（出力先: `frontend/dist-pwa`、ベースパス: `/Chatbot/`、`PWA_BASE` で変更可能）。`.github/workflows/pages.yml` が `main` への push 時にデプロイします。リポジトリの Settings → Pages → Source で「GitHub Actions」を選択して有効にしてください。

## データ管理に関する注意
アプリケーションはブラウザの IndexedDB を利用してデータを保存します。ブラウザの設定やストレージのクリーンアップ操作によってデータが削除される可能性がある点に注意してください。

## 挙動について
* システムプロンプトは、フロントエンドのモデル設定で保存されたものが、新規チャット作成時にチャット固有の設定として反映されます。チャット内では常にチャット固有のシステムプロンプトが使用されます。
* バックエンド側のシステムプロンプトの扱いは、`.env` の `SYSTEM_INSTRUCTION_MODE` で指定できます。
  - `frontend_first`（デフォルト）: フロント側の指定があればそれを使い、なければバックエンド側のデフォルトを使います。
  - `default_first`: フロント側の指定があっても、バックエンド側のデフォルトがあればそれを使います。
  - `merge`: バックエンド側のデフォルトの後にフロント側の指定を結合して送信します。
* フロントエンドの添付ファイルサイズ上限は、ビルド時の `VITE_MAX_UPLOAD_FILE_SIZE` で決まります。inlineData と File API の分岐は、バックエンドが返す capabilities に従います。
* 文字列置換はレスポンスの受け取りが完了した時点で実行されます。この際、書式が不正な場合その処理はスキップされます。
* **keyファイルについて**:
  - 初期状態ではJSONひな型の`key`ファイルが配布されます。
  - 利用するプロバイダーのAPIキーを、`gemini`・`claude`・`openrouter` などの項目に記入します。
  - APIキーを設定して初回起動すると、セキュリティのため自動的に`key_valid`にリネームされます。
* **OpenAI互換エンドポイント（vLLMなど）**:
  - `.env` の `OPENAI_COMPAT_CONFIG` に、エンドポイントを記述したJSONファイルのパスを指定します。例：
    ```json
    {
      "label": "vLLM (Local)",
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "EMPTY",
      "models": ["Qwen/Qwen3-8B"],
      "request": {
        "chat_template_kwargs": { "reasoning_effort": "no_think" }
      }
    }
    ```
  - `request` の内容は毎回のchat completionリクエストボディにディープマージされるため、vLLMの `chat_template_kwargs` のようなサーバー固有の拡張をそのまま渡せます（UIのパラメータより設定ファイル側が優先されます）。
  - `models` は省略可能です。省略時はエンドポイントの `/v1/models` が返すモデルをすべて一覧に表示します。
  - 複数エンドポイントを登録する場合は、JSONファイルを上記オブジェクトの配列にします（各エントリに `id`・`label` を指定可能）。
