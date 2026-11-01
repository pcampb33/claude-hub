import type { WidgetDef } from '../../types'
import { InboxWidget } from './Widget'
import { InboxDetail } from './Detail'

export const widget: WidgetDef = {
  id: 'inbox',
  title: 'Inbox triage',
  blurb: 'Curated notes waiting for you to add to the vault or discard.',
  sizes: ['S', 'M', 'L'],
  relevance: 'Shows when notes are waiting',
  Widget: InboxWidget,
  Detail: InboxDetail,
}
