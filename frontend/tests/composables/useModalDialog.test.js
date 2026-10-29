// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useModalDialog } from '../../src/composables/useModalDialog'

const Dialog = defineComponent({
  props: { onClose: { type: Function, required: true } },
  setup(props) {
    const dialog = ref(null)
    useModalDialog(dialog, props.onClose)
    return () =>
      h('div', { ref: dialog, role: 'dialog', tabindex: -1 }, [
        h('div', { class: 'modal-header' }, [h('button', { id: 'close' })]),
        h('input', { id: 'first' }),
        h('button', { id: 'last' }),
      ])
  },
})

const key = (name, init = {}) =>
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: name, bubbles: true, ...init })
  )

describe('useModalDialog', () => {
  it('focuses the first field, closes on Escape and restores focus', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const wrapper = mount(Dialog, {
      props: { onClose },
      attachTo: document.body,
    })

    expect(document.activeElement.id).toBe('first')
    key('Escape')
    expect(onClose).toHaveBeenCalledOnce()

    wrapper.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('keeps Tab focus inside the dialog', () => {
    const wrapper = mount(Dialog, {
      props: { onClose: () => {} },
      attachTo: document.body,
    })
    document.getElementById('last').focus()
    key('Tab')
    expect(document.activeElement.id).toBe('close')
    key('Tab', { shiftKey: true })
    expect(document.activeElement.id).toBe('last')
    wrapper.unmount()
  })
})
