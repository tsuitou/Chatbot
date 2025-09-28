# Chat.js キャンセル処理バグ修正計画

## 発見された問題点

### 1. 非同期処理の競合状態
**場所:** `prepareNewChat` (chat.js:467)
**問題:** `void this.cancelGeneration()` で待機せずに状態をクリア
**影響:** 生成中止処理とチャット初期化の競合でデータ破損

### 2. Null参照エラー
**場所:**
- `handleStreamChunk` (chat.js:600)
- `handleStreamEnd` (chat.js:688)
- `handleStreamError` (chat.js:730)
**問題:** `this.chatState.active.meta.id` で `.meta` のnullチェック不足
**影響:** チャット切り替え時のTypeError

### 3. Undefined参照エラー
**場所:** `cancelGeneration` (chat.js:765)
**問題:** `stream.messageId` で `stream` がnullの場合の未チェック
**影響:** キャンセル処理時のランタイムエラー

### 4. トランザクション整合性
**場所:** `resendMessage` (chat.js:1006-1012)
**問題:** DB削除失敗時でもUI削除が実行される
**影響:** 次回読み込み時の「ゴーストメッセージ」出現

## 修正計画

### Phase 1: 緊急修正 (Critical)

#### 1.1 非同期処理統一化
```javascript
// Before (prepareNewChat:467)
if (this.isGenerating) {
  void this.cancelGeneration()  // 問題: awaitなし
}

// After
if (this.isGenerating) {
  await this.cancelGeneration()  // 修正: await追加
}
```

#### 1.2 Null安全性向上
```javascript
// Before (handleStreamChunk:600)
if (rawChunk.chatId !== this.chatState.active.meta.id) return

// After
if (rawChunk.chatId !== this.chatState.active?.meta?.id) return
```

#### 1.3 Undefined参照対策
```javascript
// Before (cancelGeneration:765)
const message = this._findMessageById(stream.messageId)

// After
const message = stream?.messageId ? this._findMessageById(stream.messageId) : null
```

### Phase 2: 堅牢性向上 (High Priority)

#### 2.1 トランザクション完全性
```javascript
// resendMessage でのアトミック削除
const deletionResults = []
for (const candidate of pruneCandidates) {
  try {
    await db.deleteMessage(chatId, candidate.id)
    deletionResults.push({ id: candidate.id, success: true })
  } catch (error) {
    deletionResults.push({ id: candidate.id, success: false, error })
  }
}

// 全て成功した場合のみUI更新
if (deletionResults.every(r => r.success)) {
  deletionResults.forEach(r => this._removeMessage(r.id))
} else {
  // 部分失敗時の処理
  throw new Error('Message deletion failed')
}
```

#### 2.2 状態管理強化
```javascript
// 排他制御フラグ追加
state: () => ({
  // ...existing state
  operationLocks: {
    cancellation: false,
    chatSwitch: false
  }
})

// cancelGeneration の排他制御
async cancelGeneration() {
  if (this.operationLocks.cancellation) return
  this.operationLocks.cancellation = true
  try {
    // 既存のキャンセル処理
  } finally {
    this.operationLocks.cancellation = false
  }
}
```


## 実装順序

1. **緊急修正** - 即座に実装すべき致命的バグ修正
2. **堅牢性向上** - 1週間以内に実装
3. **品質向上** - 2週間以内に実装

## テスト計画

### 回帰テスト項目
- [ ] チャット切り替え中のメッセージ生成キャンセル
- [ ] 新規チャット作成中のメッセージ生成キャンセル
- [ ] 高頻度のストリーミングデータ受信テスト
- [ ] ネットワーク不安定時のエラーハンドリング
- [ ] 並行処理での状態競合テスト


