// Shared data shapes, as JSDoc typedefs checked by `pnpm typecheck`.
// Import them where needed with: /** @typedef {import('../types').Message} Message */
//
// Messages and attachments are persisted in IndexedDB (services/db.js), so
// these shapes are also the on-disk format: change them with care.

/**
 * @typedef {'user' | 'model' | 'system' | 'tool'} Sender
 * @typedef {'streaming' | 'completed' | 'cancelled' | 'pending'} MessageStatus
 */

/**
 * A file attached to a message. `blob` holds the bytes locally; `remoteUri`
 * is set when the provider stored an uploaded copy.
 * @typedef {object} Attachment
 * @property {string} id
 * @property {string} name
 * @property {string} mimeType
 * @property {number} [size]
 * @property {Blob} [blob]
 * @property {string} [remoteUri]
 * @property {string} [expirationTime]
 * @property {number} [uploadProgress]
 * @property {string} [error]
 * @property {Sender} [source]
 * @property {number} [order]
 */

/**
 * In-memory state derived while a message streams; not meaningful on disk.
 * @typedef {object} MessageRuntime
 * @property {{ thoughts: { rawText: string, updatedAt: number | null, isStreaming: boolean } }} system
 * @property {{ isStreaming: boolean, hasText: boolean, hasAttachments: boolean, hasMetadata: boolean, isReady: boolean, updatedAt: number | null }} content
 */

/**
 * Display-only flags, persisted with the message.
 * @typedef {object} MessageUiFlags
 * @property {boolean} [systemBubbleActive] Show the status/thoughts bubble.
 * @property {false} [thoughtsCollapsed] Present (false) only when expanded.
 */

/**
 * Provider-reported details. A failed generation is stored as
 * status 'completed' with finishReason 'error' and the reason in `error`.
 * @typedef {object} MessageMetadata
 * @property {string} [finishReason]
 * @property {string} [error]
 * @property {number} [duration] Milliseconds from request to completion.
 * @property {Record<string, number>} [usage]
 * @property {{ signature: string }[]} [thoughtSignatures]
 * @property {string} [serviceTier]
 * @property {'used' | 'not_used' | 'invalid' | 'incomplete' | 'pending'} [writingFunctionCall]
 * @property {boolean} [autoMessage] Inserted from chat settings, not typed.
 * @property {'pre' | 'post'} [location] Where an auto message goes.
 */

/**
 * A message configured in chat settings to be sent before or after each
 * prompt (see chatConfig store).
 * @typedef {object} AutoMessage
 * @property {string} [id]
 * @property {string} [role]
 * @property {string} [text]
 * @property {Attachment[]} [attachments]
 */

/**
 * @typedef {object} Message
 * @property {string} id
 * @property {Sender} sender
 * @property {number} sequence Ordering key; spaced by 10 (see chatFlow).
 * @property {MessageStatus} status
 * @property {{ text: string }} content
 * @property {MessageMetadata} [metadata]
 * @property {RequestConfig | null} [configSnapshot] Settings it was sent with.
 * @property {string | null} [requestId] Links a model message to its stream.
 * @property {number} createdAt
 * @property {number} [updatedAt]
 * @property {Attachment[]} [attachments]
 * @property {MessageUiFlags} [uiFlags]
 * @property {MessageRuntime} [runtime]
 */

/**
 * @typedef {object} ChatMeta
 * @property {string} id
 * @property {string} title
 * @property {number} [createdAt]
 * @property {number} [lastModified]
 * @property {boolean} [isBookmarked]
 */

/**
 * What a capability endpoint reports for one model/provider pair.
 * @typedef {object} ModelCapabilities
 * @property {Record<string, unknown>} [features]
 * @property {Record<string, unknown>} [parameters]
 * @property {Record<string, { enabled?: boolean }>} [tools]
 * @property {{ enabled?: boolean, allowRemoteUpload?: boolean, allowedMimes?: string[] | null, maxInlineFileSize?: number | null }} [attachments]
 * @property {Record<string, unknown>} [routing]
 */

/**
 * @typedef {object} ModelGroup
 * @property {string | null} provider
 * @property {string} label
 * @property {string[]} models
 */

/**
 * Everything one request is sent with (composer + model settings + chat).
 * @typedef {object} RequestConfig
 * @property {string | null} providerId
 * @property {string | null} model
 * @property {Record<string, boolean>} tools
 * @property {ModelCapabilities['attachments']} attachments
 * @property {Record<string, unknown>} parameters
 * @property {Record<string, unknown>} routing
 * @property {boolean} streaming
 * @property {string} [systemInstruction]
 */

/**
 * A streamed event from the backend, before parsing.
 * @typedef {object} StreamChunk
 * @property {string} chatId
 * @property {string} requestId
 * @property {string} [deltaText]
 * @property {string} [thoughtDelta]
 * @property {string} [finishReason]
 * @property {MessageMetadata} [metadata]
 * @property {{ data: string, mimeType: string, name?: string }[]} [attachments]
 */

/**
 * What to do for a send/resend, decided by planSend/planResend.
 * @typedef {object} GenerationPlan
 * @property {string[]} [pruneIds] Messages to delete first (resend only).
 * @property {Message[]} [historyMessages] History to send (resend only).
 * @property {number} [userSequence] Sequence of the new prompt (send only).
 * @property {number} anchorSequence Where auto messages are placed around.
 * @property {number} responseSequence Sequence of the new response.
 */

/**
 * A rendered piece of a message: prose HTML, or a code block.
 * @typedef {{ type: 'plaintext', htmlContent: string }
 *   | { type: 'code', content: string, lang: string }
 *   | { type: 'prompt', htmlContent: string }} Segment
 */

export {}
