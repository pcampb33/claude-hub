import type { WidgetDef } from '../../types'
import { PaceWidget } from './Widget'
import { PaceDetail } from './Detail'

export const widget: WidgetDef = {
  id: 'pace',
  title: 'Rate-limit pace',
  blurb: 'Where the 5-hour and weekly windows will land at the current pace.',
  sizes: ['S', 'M'],
  relevance: 'Shows when a window is on course past 50%',
  Widget: PaceWidget,
  Detail: PaceDetail,
}
