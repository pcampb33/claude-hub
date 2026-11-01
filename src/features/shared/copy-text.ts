import { toast } from './toast'

// Clipboard write with toast feedback. The one home of this flow (Workflows
// and Commands each grew a copy before it was hoisted here).
export async function copyText(text: string, messages: { success: string; failure: string }): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(messages.success)
  } catch {
    toast.error(messages.failure)
  }
}
