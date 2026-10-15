export const WRITING_FUNCTION_NAME = 'submit_writing'

export function writingFunctionDeclaration() {
  return {
    name: WRITING_FUNCTION_NAME,
    description:
      'Submit the completed writing requested by the user. Put the entire final text in content, preserving its language, formatting and line breaks. Do not put the writing in the normal response text.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The complete written text.' },
      },
      required: ['content'],
    },
  }
}

export function writingError(status, message) {
  const error = new Error(message)
  error.status = 502
  error.metadata = { writingFunctionCall: status }
  return error
}

// This is an output sink, not a tool runner. Only complete, validated arguments
// become ordinary assistant text; no function response or second API call follows.
export function finishWriting(calls, finishReason, successfulReasons) {
  if (!successfulReasons.includes(finishReason)) {
    throw writingError(
      'incomplete',
      'Writing Function Call did not complete. Please retry.'
    )
  }
  if (!calls.length) {
    throw writingError(
      'not_used',
      'The model did not use Writing Function Call. Please retry.'
    )
  }
  const texts = calls.map((call) => {
    let args = call.args
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        throw writingError(
          'invalid',
          'Writing Function Call returned invalid JSON. Please retry.'
        )
      }
    }
    if (
      call.name !== WRITING_FUNCTION_NAME ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      typeof args.content !== 'string' ||
      !args.content.trim()
    ) {
      throw writingError(
        'invalid',
        'Writing Function Call returned invalid content. Please retry.'
      )
    }
    return args.content
  })
  return {
    parts: [{ text: texts.join('\n\n') }],
    metadata: { writingFunctionCall: 'used' },
  }
}

export class OpenRouterWritingAccumulator {
  constructor() {
    this.calls = new Map()
  }

  add(deltas = []) {
    for (const delta of deltas) {
      if (!Number.isInteger(delta.index) || delta.index < 0) {
        throw writingError(
          'invalid',
          'Writing Function Call returned an invalid call index.'
        )
      }
      const call = this.calls.get(delta.index) || { name: '', args: '' }
      if (delta.function?.name) call.name += delta.function.name
      if (typeof delta.function?.arguments === 'string')
        call.args += delta.function.arguments
      this.calls.set(delta.index, call)
    }
  }

  finish(reason) {
    return finishWriting(
      [...this.calls].sort(([a], [b]) => a - b).map(([, call]) => call),
      reason,
      ['tool_calls', 'stop']
    )
  }
}
