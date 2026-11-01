import type { WidgetDef } from '../../types'
import { NeedsWidget } from './Widget'
import { NeedsDetail } from './Detail'

export const widget: WidgetDef = {
  id: 'needs',
  title: 'Needs you',
  blurb: 'Everything waiting on a decision from you, ranked.',
  sizes: ['M', 'L', 'XL'],
  Widget: NeedsWidget,
  Detail: NeedsDetail,
}
