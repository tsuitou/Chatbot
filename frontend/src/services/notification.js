import { useToast } from 'vue-toastification'
import ToastWithCopy from '../components/ToastWithCopy.vue'

// Get the toast interface
const toast = useToast()

/**
 * Shows an error toast notification with a consistent style.
 * @param {string | Error} error - The error message string or an Error object.
 */
export function showErrorToast(error) {
  let message = 'An unexpected error occurred.'
  if (typeof error === 'string') {
    message = error
  } else if (error instanceof Error) {
    message = error.message
  }

  toast.error({
    component: ToastWithCopy,
    props: {
      message: message,
    },
  })
}

/**
 * Shows a success toast notification.
 * @param {string} message - The message to display.
 */
export function showSuccessToast(message) {
  toast.success(message)
}
