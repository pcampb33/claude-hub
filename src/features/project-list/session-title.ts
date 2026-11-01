// readSessionTitle() (electron/sessions.ts) returns this sentinel when a
// transcript holds no user message at all. It is a null in a title slot, not a
// title: printing it verbatim asks the reader to interpret an internal
// placeholder. Say what is actually true instead.
export const NO_SESSION_TITLE = '(no message found)'

export function displaySessionTitle(title: string): string {
  return title === NO_SESSION_TITLE ? 'No user prompt in this session' : title
}
