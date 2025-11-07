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
- npm

## Setup Instructions
1. Unzip the latest zip file (`chatbot_v*.zip`) from the Releases page and navigate to the extracted directory.
2. Ensure that your environment variables, including the path to Node.js, are set up correctly.
3. The following configuration files are managed on the backend:
   - `.env`: Currently used to specify the behavior of the model list.
   - `key`: A file to write your Gemini API key into.
   - `system_instruction.txt`: Contains the default system prompt. This content is only used when no system prompt is specified on the frontend.

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
   npm i
   ```
2. Start the server within the extracted directory.
   ```bash
   node server.js
   ```
3. Open your browser and go to `http://localhost:15101/chatbot` to use the application.

## Note on Data Management
The application uses the browser's IndexedDB to store data. Please be aware that data may be deleted due to browser settings or storage cleanup operations.

## Regarding Behavior
* The system prompt saved in the model settings on the frontend is applied as a chat-specific setting when a new chat is created. Within a chat, the chat-specific system prompt is always used.
* If a chat-specific system prompt is not set (is blank), the backend system prompt will be used.
* File attachments are handled using `inlineData` for files under 10MB and the `FileAPI` for files over 10MB.
* String replacement is executed once the response has been fully received. If the format is invalid, that specific replacement process will be skipped.
* **About the `key` file**:
  - Initially, an empty `key` file is provided.
  - When you set your API key and launch the application for the first time, the file is automatically renamed to `key_valid` for security purposes.

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
- npm

## セットアップ手順
1. Releaseにある最新のzipファイル（`chatbot_v*.zip`）を解凍し、展開されたディレクトリに移動します。
2. Node.js を含む環境変数が適切に設定されていることを確認します。
3. バックエンドで管理する設定ファイルは次の通りです。
   - `.env`現状ではモデル一覧の挙動を指定するものです。
   - `key`GeminiのAPIキーを記述するためのファイルです。
   - `system_instruction.txt`デフォルトのシステムプロンプトを記述します。この内容はフロントエンドでシステムプロンプトが指定されていない場合にのみ有効となります。

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
   npm i
   ```
2. 展開されたディレクトリ内でサーバーを起動します。
   ```bash
   node server.js
   ```
3. ブラウザで `http://localhost:15101/chatbot` にアクセスするとアプリケーションを利用できます。

## データ管理に関する注意
アプリケーションはブラウザの IndexedDB を利用してデータを保存します。ブラウザの設定やストレージのクリーンアップ操作によってデータが削除される可能性がある点に注意してください。

## 挙動について
* システムプロンプトは、フロントエンドのモデル設定で保存されたものが、新規チャット作成時にチャット固有の設定として反映されます。チャット内では常にチャット固有のシステムプロンプトが使用されます。
* チャット固有のシステムプロンプトが設定されていない（空白）の場合、バックエンド側のシステムプロンプトが使用されます。
* ファイル添付は、10MBを境にinlineDataとFileAPIに分岐します。
* 文字列置換はレスポンスの受け取りが完了した時点で実行されます。この際、書式が不正な場合その処理はスキップされます。
* **keyファイルについて**:
  - 初期状態では空の`key`ファイルが配布されます。
  - APIキーを設定して初回起動すると、セキュリティのため自動的に`key_valid`にリネームされます。
