# フロントエンド データフロー・アーキテクチャ資料

## 概要

このドキュメントは、Gemini チャットボットフロントエンドアプリケーションのデータフローとアーキテクチャについて解説します。Vue 3 + Pinia ベースのSPAで、リアルタイムストリーミング機能を持つチャットアプリケーションとして設計されています。

---

## 1. アプリ上でのチャットデータの取り扱い

### 1.1 データ構造の概要

アプリケーションでは、以下の主要なデータエンティティを管理しています：

#### Chat エンティティ
```typescript
Chat {
  id: string,
  type: 'chat',
  title: string,
  createdAt: number,
  lastModified: number,
  isBookmarked?: boolean,
  messages?: Array<Message>,
}
```

#### Message エンティティ
```typescript
Message {
  id: string,
  type: 'message',
  chatId: string,
  sender: 'user' | 'model',
  sequence: number,             // 順序管理 (10, 20, 30, ...)
  status: 'pending' | 'streaming' | 'completed' | 'error' | 'cancelled',
  content: {
    text: string,
  },
  metadata: Record<string, any>,
  configSnapshot?: Record<string, any>,
  requestId?: string,
  createdAt: number,
  updatedAt: number,
  attachments?: Array<Attachment>,
  runtime: Runtime,            // リアルタイム状態管理
}
```

#### Attachment エンティティ
```typescript
Attachment {
  id: string,
  type: 'attachment',
  chatId: string,
  messageId: string,
  name: string,
  mimeType: string,
  size: number,
  source: 'user' | 'model',
  remoteUri?: string,
  blob?: Blob,
  order: number,
}
```

### 1.2 データ永続化レイヤー

#### IndexedDB による永続化
- **DB名**: `GeminiChatDB`
- **ストア**: 全エンティティは単一のObjectStore `app_store` に保存
- **インデックス**:
  - `byType`: エンティティタイプ別索引
  - `messageByChat`: チャット別メッセージ検索
  - `messageByChatSequence`: チャット内メッセージ順序検索
  - `attachmentByMessage`: メッセージ別添付ファイル検索

#### データクローニング機構
```javascript
// services/db.js:manualDeepClone
```
- `structuredClone` がサポートされていない環境への対応
- Blob/File オブジェクトの適切なクローニング処理
- `DataCloneError` の回避機構

### 1.3 状態管理：Pinia ストア

#### Chat Store (`stores/chat.js`)
```javascript
state: () => ({
  appState: {
    initialized: false,
    availableModels: [],
    defaultModel: null,
    modelSettingsVersion: 0,
  },
  chatState: {
    list: [],              // チャット一覧
    active: null,          // { meta, messages }
  },
  generationState: {
    status: GenerationStatus.IDLE | STREAMING | ERROR,
    stream: null,          // { messageId, requestId, providerId }
    lastError: null,
  },
  composerState: {
    prompt: '',
    model: null,
    streamingEnabled: true,
    tools: { useUrlContext, useGrounding, useCodeExecution },
    providerId: string,
    attachmentBucket: AttachmentBucket,
  },
  editingState: null,      // メッセージ編集状態
  uiSignals: {
    scrollToken: 0,        // UI更新信号
  },
})
```

#### ランタイム状態管理
各メッセージには以下のランタイム情報が付加されます：
```javascript
runtime: {
  system: {
    thoughts: {              // AI推論プロセス情報
      rawText: string,
      updatedAt: number,
      isStreaming: boolean,
    },
  },
  content: {
    isStreaming: boolean,
    hasText: boolean,
    hasAttachments: boolean,
    hasMetadata: boolean,
    isReady: boolean,
    updatedAt: number,
  },
}
```

### 1.4 メッセージライフサイクル

#### 1. ユーザーメッセージ送信
```javascript
// ChatStore:sendMessage
const userMessage = createUserMessage({
  sequence: userSequence,
  text: prompt,
  attachments,
  configSnapshot: requestConfig,
});
```

#### 2. モデルレスポンス初期化
```javascript
const modelMessage = createModelMessage({
  sequence: modelSequence,
  requestId,
  configSnapshot: requestConfig,
});
```

#### 3. ストリーミングハンドリング
```javascript
// ChatStore:handleStreamChunk
const parsed = apiAdapter.parseApiResponse(rawChunk, providerId);
message.content.text += parsed.deltaText;
```

#### 4. 完了処理
```javascript
// ChatStore:handleStreamEnd
message.status = 'completed';
await this._persistActiveMessage(message);
```

---

## 2. リクエスト及びレスポンスの抽象化

### 2.1 プロバイダー抽象化レイヤー

#### プロバイダーインターフェース
各プロバイダー（現在はGeminiのみ）は以下のインターフェースを実装：

```javascript
// services/providers/[provider].js
export const id = 'provider-id';
export const label = 'Provider Name';

export function createRequestPayload({ chatId, requestId, model, contents, streaming, requestConfig });
export function parseStreamChunk(rawChunk);
export function normalizeError(rawError, phase);
export function buildDisplayIndicators(message);
export function buildMetadataHtml(message);
export function uploadAttachment(file, options);
```

#### プロバイダー管理
```javascript
// services/providers/index.js
const registry = {
  [gemini.id]: gemini,
};

export function getProviderById(providerId);
export function listProviders();
export function getDefaultProviderId();
```

### 2.2 リクエスト処理フロー

#### 1. リクエスト構築
```javascript
// services/apiAdapter.js:createApiRequest
const provider = getProviderById(providerId);
const payload = provider.createRequestPayload({
  chatId, requestId, model, contents, streaming, requestConfig
});
```

#### 2. メッセージ前処理
```javascript
// services/chatFlow.js:prepareRequestMessages
const requestMessages = prepareRequestMessages({
  historyMessages,
  autoMessages,
  anchorSequence: userSequence,
});
```

#### 3. 添付ファイル処理
```javascript
// services/apiAdapter.js:buildMessageParts
for (const att of message.attachments) {
  if (att.remoteUri) {
    parts.push({ fileData: { mimeType: att.mimeType, fileUri: att.remoteUri } });
  } else if (att.blob) {
    const base64Data = await blobToBase64(att.blob);
    parts.push({ inlineData: { mimeType: att.mimeType, data: base64Data } });
  }
}
```

### 2.3 リアルタイム通信レイヤー

#### Socket.IO を使用したストリーミング
```javascript
// services/socket.js
socket.on('chunk', (rawChunk) => {
  store.handleStreamChunk(rawChunk);
});

socket.on('end_generation', (result) => {
  store.handleStreamEnd(result);
});

socket.on('error', (rawError) => {
  store.handleStreamError(rawError);
});
```

#### ストリーミングデータフロー
1. フロントエンド → `startGeneration(payload)` → バックエンド
2. バックエンド → `chunk` イベント → フロントエンド
3. フロントエンド → `handleStreamChunk()` → UI更新
4. バックエンド → `end_generation` イベント → 完了処理

### 2.4 レスポンス正規化

#### プロバイダー固有パーシング
```javascript
// services/providers/gemini.js:parseStreamChunk
export function parseStreamChunk(rawChunk) {
  const result = {};
  let textContent = '';
  let thoughtContent = '';
  const attachments = [];

  if (Array.isArray(rawChunk.parts)) {
    for (const part of rawChunk.parts) {
      if (part.text) {
        if (part.thought) {
          thoughtContent += part.text;
        } else {
          textContent += part.text;
        }
      }
      if (part.executableCode) {
        const { language, code } = part.executableCode;
        textContent += `\n\n\`\`\`${language}\n${code}\n\`\`\`\n`;
      }
      // ... その他の処理
    }
  }

  return { deltaText: textContent, thoughtDelta: thoughtContent, newAttachments: attachments };
}
```

#### 共通レスポンス構造
全てのプロバイダーからの応答は以下の形式に正規化されます：
```javascript
{
  deltaText?: string,           // 追加テキスト
  thoughtDelta?: string,        // AI推論テキスト
  newAttachments?: Array,       // 新しい添付ファイル
  metadata?: {
    finishReason?: string,
    usage?: TokenUsage,
    grounding?: GroundingSources,
    provider: string,
  },
  finishReason?: string,
}
```

---

## 3. プロバイダー追加指南書

### 3.1 プロバイダー実装の基本構造

新しいプロバイダーを追加する際は、以下の手順に従ってください。

#### ステップ1: プロバイダーファイル作成
`frontend/src/services/providers/[provider-name].js` を作成：

```javascript
import { v4 as uuidv4 } from 'uuid'
import { uploadFile as apiUploadFile } from '../api'

export const id = 'your-provider-id'
export const label = 'Your Provider Name'

export function createRequestPayload({
  chatId,
  requestId,
  model,
  streaming,
  contents,
  requestConfig,
}) {
  // プロバイダー固有のリクエスト形式に変換
  return {
    provider: id,
    chatId,
    requestId,
    model,
    contents,
    config: transformToProviderConfig(requestConfig),
    streaming,
  }
}

export function parseStreamChunk(rawChunk) {
  // プロバイダー固有のストリーミングレスポンスをパース
  const result = {}

  // テキストコンテンツの抽出
  if (rawChunk.text) {
    result.deltaText = rawChunk.text
  }

  // メタデータの処理
  if (rawChunk.metadata) {
    result.metadata = {
      provider: id,
      ...normalizeMetadata(rawChunk.metadata)
    }
  }

  return result
}

export function normalizeError(rawError, phase) {
  // エラーレスポンスの正規化
  return {
    code: determineErrorCode(rawError.status),
    message: rawError.message || 'Unknown error',
    status: rawError.status,
    phase,
    retryable: rawError.status >= 500,
    provider: id,
  }
}

export function buildDisplayIndicators(message) {
  // UI表示用の設定インジケーター
  const indicators = []
  const config = message?.configSnapshot || {}

  if (config.model) {
    indicators.push({ icon: 'robot', text: config.model })
  }

  return indicators
}

export function buildMetadataHtml(message) {
  // メタデータのHTML表示
  const lines = []
  // メタデータから表示用HTML生成
  return lines.join('\n')
}

export async function uploadAttachment(file, { onProgress } = {}) {
  // ファイルアップロード処理（オプション）
  const progressHandler = typeof onProgress === 'function' ? onProgress : () => {}
  const uploaded = await apiUploadFile(file, progressHandler)
  return {
    uri: uploaded?.uri ?? null,
    expiresAt: uploaded?.expirationTime ?? null,
  }
}
```

#### ステップ2: プロバイダー登録
`frontend/src/services/providers/index.js` に追加：

```javascript
import * as gemini from './gemini'
import * as yourProvider from './your-provider'  // 追加

const registry = {
  [gemini.id]: gemini,
  [yourProvider.id]: yourProvider,              // 追加
}

const fallbackProviderId = gemini.id  // 必要に応じて変更
```

### 3.2 実装時の注意点

#### 3.2.1 リクエスト設定の変換
```javascript
function transformToProviderConfig(requestConfig) {
  const config = {}

  // ツール設定の変換
  if (requestConfig.tools) {
    config.tools = mapToolsToProviderFormat(requestConfig.tools)
  }

  // パラメーター変換
  const params = requestConfig.parameters || {}
  if (params.temperature !== undefined) config.temperature = params.temperature
  if (params.maxOutputTokens !== undefined) config.maxTokens = params.maxOutputTokens

  // システムプロンプト
  if (requestConfig.systemInstruction) {
    config.systemPrompt = requestConfig.systemInstruction
  }

  return config
}
```

#### 3.2.2 ストリーミングレスポンス処理
```javascript
export function parseStreamChunk(rawChunk) {
  const result = {}

  // 段階的テキスト更新
  if (rawChunk.delta?.content) {
    result.deltaText = rawChunk.delta.content
  }

  // 添付ファイル処理
  if (rawChunk.attachments) {
    result.newAttachments = rawChunk.attachments.map(att => ({
      id: uuidv4(),
      name: att.name || `generated_${Date.now()}`,
      mimeType: att.mimeType,
      size: att.size || 0,
      source: 'model',
      blob: convertToBlob(att.data, att.mimeType),
    }))
  }

  // 完了理由
  if (rawChunk.finishReason) {
    result.finishReason = rawChunk.finishReason
  }

  return result
}
```

#### 3.2.3 エラーハンドリング
```javascript
export function normalizeError(rawError, phase) {
  let code = 'E_UNKNOWN'
  const status = rawError?.status || 500

  // HTTPステータスコードに応じたエラー分類
  switch (true) {
    case status === 400: code = 'E_BAD_REQUEST'; break
    case status === 401: code = 'E_UNAUTHORIZED'; break
    case status === 403: code = 'E_FORBIDDEN'; break
    case status === 429: code = 'E_RATE_LIMIT'; break
    case status >= 500: code = 'E_BACKEND'; break
  }

  return {
    code,
    message: extractErrorMessage(rawError),
    status,
    phase,
    retryable: shouldRetry(status),
    provider: id,
  }
}
```

### 3.3 テスト・デバッグ

#### 3.3.1 デバッグリクエスト記録
開発モードでは、リクエストが自動的に記録されます：
```javascript
// stores/chat.js:recordDebugRequest
function recordDebugRequest(payload) {
  if (!import.meta.env.DEV) return
  const debugStore = useDebugStore()
  debugStore.recordRequest(payload)
}
```

#### 3.3.2 プロバイダー設定確認
ブラウザの開発者ツールで以下を確認：
```javascript
// コンソールでプロバイダー確認
import { listProviders } from './services/providers'
console.log(listProviders())
```

### 3.4 設定とカスタマイゼーション

#### 3.4.1 モデル設定
```javascript
// services/modelConfig.js で設定エントリ正規化
export function normalizeSettingsEntry(raw, { fallbackProviderId }) {
  return {
    providerId: raw?.providerId || fallbackProviderId,
    systemPrompt: raw?.systemPrompt || '',
    parameters: {
      temperature: raw?.parameters?.temperature,
      topP: raw?.parameters?.topP,
      maxOutputTokens: raw?.parameters?.maxOutputTokens,
      ...
    },
    options: {
      ...raw?.options
    }
  }
}
```

#### 3.4.2 UI統合
プロバイダー固有のUI表示要素：
```javascript
export function buildDisplayIndicators(message) {
  const indicators = []
  const config = message?.configSnapshot || {}

  // モデル表示
  if (config.model) {
    indicators.push({ icon: 'robot', text: config.model })
  }

  // カスタムパラメーター表示
  if (config.customParam) {
    indicators.push({
      icon: 'cog',
      text: `Custom: ${config.customParam}`
    })
  }

  return indicators
}
```

### 3.5 バックエンド連携

新しいプロバイダーを追加する際は、バックエンドサーバーでも対応する実装が必要です。フロントエンドから送信される `payload.provider` フィールドを参照して、適切なプロバイダー処理を実行してください。

